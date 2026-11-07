"""
The types every tool is written against.

A tool is defined once, in its own module under `tools/`, and is the same tool
for every task that offers it. What it carries is everything the rest of the
harness needs to know about it: what the model may say to it, the line that
says when to reach for it, the budget its calls are charged to, what its call
keeps in the answer's trace, and the function that runs it.

Nothing here knows a tool by name.
"""

from __future__ import annotations

import enum
import functools
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict
from starlette.concurrency import run_in_threadpool

from ..config import Settings
from ..artifacts.session import ArtifactSession
from ..memory_maintenance.staging import ExistingPage, MemoryDraft
from ..source_figures import SourceFigures
from ..storage import ObjectStore, Storage


class BudgetClass(enum.Enum):
    """What a call is charged to. A class is spent as a whole (`budget.TurnBudget`)."""

    #: Exact text from the reader's documents: reads, and the search that finds them.
    DOCUMENT = "document"
    #: Consulting Memory. Separate so that it never costs a page the answer needed.
    MEMORY = "memory"
    #: Looking at a stored figure: the one read that costs image tokens.
    FIGURE = "figure"
    #: A hosted web search, run by the provider and counted from what it returns.
    WEB = "web"
    #: Staging a write to Memory. Only a maintenance run has any of these to
    #: spend, and they are counted apart so that a refused write never costs
    #: the run a page it still had to read.
    WRITE = "write"
    #: Private visualization renders and publications have their own allowance.
    ARTIFACT_RENDER = "artifact_render"
    ARTIFACT_PUBLISH = "artifact_publish"


#: The schema keywords a tool's arguments may use, in the order they are
#: written. The provider's strict mode accepts a subset of JSON Schema; these
#: are the ones Delphi's tools have always sent. Anything else an `Arguments`
#: class declares (a maximum length, say) is still enforced when the call is
#: parsed, where the model gets the reason in prose.
_SCHEMA_KEYS = ("type", "description", "enum", "items", "minItems", "maxItems", "minimum", "maximum")


def _strict(schema: dict[str, Any], defs: dict[str, Any]) -> dict[str, Any]:
    """
    One property's schema, reduced to what the provider's strict mode takes.

    A list of objects is a list of another `ToolArguments`-shaped model, which
    the generated schema names by reference: it is written out in place, under
    the same rules as the arguments themselves (every property required, none
    besides).
    """
    if "$ref" in schema:
        schema = {**defs[schema["$ref"].rsplit("/", 1)[-1]], **schema}
    kept = {key: schema[key] for key in _SCHEMA_KEYS if key in schema}
    if isinstance(kept.get("items"), dict):
        kept["items"] = _strict(kept["items"], defs)
    if "properties" in schema:
        kept.update(_object(schema, defs))
    return kept


def _object(schema: dict[str, Any], defs: dict[str, Any]) -> dict[str, Any]:
    """An object's properties as strict mode takes them: all required, no others."""
    properties = {name: _strict(item, defs) for name, item in schema["properties"].items()}
    return {
        "additionalProperties": False,
        # Strict mode has no optional argument: every one is required.
        "required": list(properties),
        "properties": properties,
    }


class ToolArguments(BaseModel):
    """
    What the model may say to a tool.

    A tool's `Arguments` subclass is the one statement of its arguments: the
    schema a request carries is generated from it, and a call's arguments are
    parsed by it. Nobody writes a schema by hand or parses `arguments` by hand.
    """

    model_config = ConfigDict(extra="forbid")

    @classmethod
    def parameters(cls) -> dict[str, Any]:
        """These arguments as the strict JSON schema a function tool declares."""
        schema = cls.model_json_schema()
        return {"type": "object", **_object(schema, schema.get("$defs") or {})}


@functools.cache
def _function_entry(name: str, description: str, arguments: type[ToolArguments]) -> dict[str, Any]:
    """A function tool's entry in a request's `tools`. The one place one is generated."""
    return {
        "type": "function",
        "name": name,
        "description": description,
        "parameters": arguments.parameters(),
        "strict": True,
    }


@dataclass(frozen=True)
class TraceProjection:
    """
    What a call keeps in the stored trace.

    `keep` is the arguments worth keeping and the name each is stored under.
    The whole argument blob is never stored: for a read it would be a copy of
    the request, and a row only ever shows one thing a call was pointed at.
    """

    keep: tuple[tuple[str, str], ...] = ()


@dataclass
class ToolResult:
    """What one call came to."""

    #: The prose handed back to the model. A failure is prose too (invariant 15).
    text: str
    #: Memory pages the call opened or listed, by slug, for the trace's result rows.
    pages: list[str] = field(default_factory=list)
    #: The document a read was served from, as the trace lists it.
    document: list[dict[str, Any]] = field(default_factory=list)
    #: An image the model asked to see. It travels inside the call's result,
    #: alongside the prose rather than as a new reader message.
    image: dict[str, Any] | None = None
    #: Refused before any work was done; its budget class may give the call back.
    refused: bool = False


@dataclass
class ToolContext:
    """
    What a tool may reach: the account, its stores, and what this turn loaded.

    A tool module takes its dependencies from here and imports no router and no
    task, which is what lets one definition serve every caller.
    """

    settings: Settings
    username: str = ""
    #: Empty in the account-wide scope, which reads across every project.
    project_id: str = ""
    storage: Storage | None = None
    objects: ObjectStore | None = None
    #: Web snapshots this turn loaded, by document id, and what each is called.
    web_documents: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: Bounded, turn-local URL text snapshots; never persisted or imported.
    url_documents: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: The figures those sources hold, by turn-local id (`source_figures`).
    figures: SourceFigures = field(default_factory=SourceFigures)
    titles: dict[str, str] = field(default_factory=dict)
    #: PDFs this turn may read by page, by document id.
    paper_documents: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: PDFs the request carries whole: there is nothing to open for these.
    attached_pdf_ids: frozenset[str] = frozenset()
    #: The names this request offers. A tool that prints "open it with …" may
    #: only name a call the model can make.
    offered: frozenset[str] = frozenset()
    #: Characters the document budget still has, set by the dispatcher per call.
    document_chars_left: int = 0
    #: What a maintenance run has been shown and has staged. A chat turn has
    #: none, which is one of the two reasons a chat turn can write nothing.
    draft: MemoryDraft | None = None
    #: The stored pages a write is checked against: their names, kinds and
    #: revisions. Blocking, like the stores; call it through `in_thread`.
    memory_pages: Callable[[], Sequence[ExistingPage]] | None = None
    #: Which existing pages already explain an idea, by slug, judged by
    #: meaning from a title, its aliases and a summary. A model call the
    #: maintenance stage supplies; the harness only knows that it can be asked.
    same_idea: Callable[[str, list[str], str], Awaitable[list[str]]] | None = None
    #: Turn-local drafts; a render never changes Memory or account storage.
    artifacts: ArtifactSession | None = None

    @staticmethod
    async def in_thread(function: Callable[..., Any], *args: Any) -> Any:
        """Run blocking store or parse work off the event loop."""
        return await run_in_threadpool(function, *args)


#: A tool's runner: the call's parsed arguments and the turn's context.
Runner = Callable[[Any, ToolContext], Awaitable[ToolResult]]


@dataclass(frozen=True)
class Tool:
    """One tool, as a request offers it and as the loop serves it."""

    name: str
    budget: BudgetClass
    #: The status line shown while a call runs.
    label: str
    #: When to reach for it: one line of the generated working method.
    guidance: str
    trace: TraceProjection
    #: What the model may say to it. None for a hosted tool.
    arguments: type[ToolArguments] | None = None
    #: What the tool is, in the words the model reads beside its schema.
    description: str = ""
    #: None for a hosted tool, which the provider runs itself.
    run: Runner | None = None
    #: What the tool cannot run without, as `ToolContext` field names.
    needs: tuple[str, ...] = ()
    #: A hosted tool's entry in a request's `tools`, which is the provider's to define.
    hosted_spec: dict[str, Any] | None = None
    #: For a hosted tool, the type of the output item its calls arrive as.
    item_type: str = ""
    #: What the request must ask the provider to `include` for this tool.
    include: tuple[str, ...] = ()
    #: The tool changes Memory. No chat profile may offer one: with the web in
    #: reach, text a page had planted could ask for the call.
    writes: bool = False

    @property
    def hosted(self) -> bool:
        return self.run is None

    @property
    def spec(self) -> dict[str, Any]:
        """The entry in the request's `tools` array, exactly as it is sent."""
        if self.arguments is None:
            return dict(self.hosted_spec or {})
        return _function_entry(self.name, self.description, self.arguments)
