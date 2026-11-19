"""
The research pass: what outside sources bear on one piece of material.

One bounded call with hosted web search, run through the same turn loop as
chat (`loop.run_turn`) so it shares the budgets, the terminal contract and the
replay policy. It is handed the focal material and returns findings: a claim,
the page it is on, and the words on that page that say it. Zero findings is a
valid answer, and the usual one for a document that stands on its own.

What the pass looks for is its caller's (`Task`): the paragraph that says
what to look for, the one that says when nothing is the answer, and the
vocabulary a finding's `bearsOn` is drawn from. A digest asks what bears on
one document (`DIGEST`); Memory maintenance asks its own two questions
(`memory_maintenance/gather_outside.py`). The findings schema, the budgets,
the rule that a finding is quoted, and capture are the same for every caller.

A finding is a lead, not evidence. `evidence.capture` reads each cited page
and keeps only the findings whose quote is really there; nothing a search
snippet said reaches a writer on the model's word alone.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..config import Settings
from . import profiles
from .budget import TurnBudget
from .loop import run_turn
from .prompts import UNTRUSTED_TEXT_RULE
from .provider import ProviderError, ResponsesClient, Terminal
from .tool import ToolContext

#: Hosted calls one pass may make, and findings it may return.
MAX_SEARCHES = 8
MAX_FINDINGS = 12

#: The rules every task shares: a finding is what an opened page says, quoted.
QUOTE_RULE = """
Report only what a page you opened says. For each finding give the claim in
your own words, the page's address and title, and a quote: a span copied
character for character from that page, long enough to be found there again
(one or two sentences), that supports the claim by itself. A claim you cannot
quote is not a finding. Prefer the primary source (the paper, the official
documentation, the repository) to commentary about it.
""".strip()


@dataclass(frozen=True)
class Task:
    """
    What one kind of caller asks a pass to do.

    `looks_for` comes first in the instructions and `when_empty` after the
    shared quote rule; the untrusted-text rule ends them. `bears_on` is the
    closed vocabulary of a finding's `bearsOn`, the first being what a finding
    that names none is filed under. `ask` is the closing turn, with
    `{subject}` where the caller's subject goes.
    """

    looks_for: str
    when_empty: str
    bears_on: tuple[str, ...]
    ask: str = "Find what outside sources bear on {subject}."

    @property
    def instructions(self) -> str:
        return f"{self.looks_for}\n\n{QUOTE_RULE}\n\n{self.when_empty}\n\n{UNTRUSTED_TEXT_RULE}"

    @property
    def format(self) -> dict[str, Any]:
        """The findings schema, with `bearsOn` closed to this task's vocabulary."""
        schema = _strict(Findings.model_json_schema())
        schema["properties"]["findings"]["items"]["properties"]["bearsOn"] = {"enum": list(self.bears_on), "type": "string"}
        return {"type": "json_schema", "name": "research_findings", "strict": True, "schema": schema}


DIGEST = Task(
    looks_for="""
You look outside one document for what a careful reader of it would want to
know and the document itself cannot tell them. You are given the document.
Search the web for:

- lineage: the work its central method or result directly builds on;
- baseline: the strongest prior result it compares itself with, as that work
  reports it;
- correction: later work that corrects, supersedes, fails to reproduce or
  qualifies a central result;
- definition: a term or method it relies on and does not define.
""".strip(),
    when_empty="""
Return no findings when nothing outside bears on the document: most documents
need few, and an empty list is a correct answer. List under `unresolved` what
you looked for and could not find. A few well-aimed searches are better than
many broad ones.
""".strip(),
    bears_on=("lineage", "baseline", "correction", "definition"),
)

RESEARCH_INSTRUCTIONS = DIGEST.instructions


class Finding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    claim: str = Field(max_length=600)
    url: str = Field(max_length=2_048)
    title: str = Field(max_length=300)
    quote: str = Field(max_length=1_200)
    #: Closed to the caller's vocabulary in the schema it is asked in (`Task.format`).
    bearsOn: str


class Findings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    findings: list[Finding] = Field(max_length=MAX_FINDINGS)
    unresolved: list[str] = Field(max_length=12)


def _strict(schema: dict[str, Any]) -> dict[str, Any]:
    """The schema as the provider's strict mode wants it: closed objects, no bounds it cannot enforce."""
    definitions = schema.pop("$defs", {})

    def resolve(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                return resolve(dict(definitions[node["$ref"].rsplit("/", 1)[-1]]))
            return {
                key: resolve(value)
                for key, value in node.items()
                # A schema's own `title` is a string; a property called title is not.
                if key not in {"maxLength", "maxItems"} and not (key == "title" and isinstance(value, str))
            }
        if isinstance(node, list):
            return [resolve(item) for item in node]
        return node

    return resolve(schema)


FINDINGS_FORMAT = DIGEST.format


@dataclass
class Research:
    """What one pass found, before any of it has been checked against a page."""

    findings: list[dict[str, Any]] = field(default_factory=list)
    unresolved: list[str] = field(default_factory=list)
    #: Hosted calls the pass made.
    searches: int = 0


async def gather(
    client: httpx.AsyncClient,
    settings: Settings,
    focal: list[dict[str, Any]],
    subject: str,
    *,
    task: Task = DIGEST,
    hosted_calls: int = MAX_SEARCHES,
) -> Research:
    """
    Look outside `focal` for what bears on it, as `task` asks.

    `focal` is the input the writer of the artifact is handed too, so the two
    calls share a cached prefix; `subject` says what the material is. With web
    search switched off, or no hosted call left to make (`hosted_calls`, at
    most `MAX_SEARCHES`), there is nothing to look with, and the answer is the
    empty one without a call.
    """
    hosted_calls = min(hosted_calls, MAX_SEARCHES)
    toolset = profiles.RESEARCH.toolset(profiles.Turn(settings, web=settings.web_search_enabled))
    if not toolset.tools or hosted_calls <= 0:
        return Research()
    budget = TurnBudget(
        rounds=1, document_calls=0, document_chars=0, memory_calls=0, figure_views=0,
        hosted_calls=hosted_calls, output_tokens=settings.research_max_output_tokens,
        deadline_seconds=settings.turn_deadline_seconds,
    )
    request = {
        "model": settings.research_model,
        "instructions": task.instructions,
        "input": [*focal, {"role": "user", "content": task.ask.format(subject=subject)}],
        "tools": toolset.specs(),
        "include": toolset.include(),
        "reasoning": {"effort": settings.research_reasoning_effort},
        "text": {"format": task.format},
        "max_output_tokens": settings.research_max_output_tokens,
        "store": False,
        "stream": True,
    }
    written, ended = "", None
    async for event in run_turn(ResponsesClient(client, settings), request, toolset, budget, ToolContext(settings=settings)):
        if event["type"] == "delta":
            written += event["text"]
        elif event["type"] == "turn_end":
            ended = event["result"]
    if ended is None or ended.terminal is not Terminal.COMPLETED:
        raise ProviderError(
            "The research pass was cut off before it finished", Terminal.INCOMPLETE,
            ended.reason if ended else None,
        )
    try:
        parsed = Findings.model_validate(json.loads(written))
    except (json.JSONDecodeError, ValidationError) as error:
        raise ProviderError(f"The research pass returned findings that cannot be read: {error}", Terminal.FAILED) from error
    return Research(
        findings=[
            {**finding.model_dump(), "bearsOn": finding.bearsOn if finding.bearsOn in task.bears_on else task.bears_on[0]}
            for finding in parsed.findings
        ],
        unresolved=list(parsed.unresolved),
        searches=budget.hosted_calls_made,
    )
