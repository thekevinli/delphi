"""
What the stages that run a model in a tool loop share: the run, and how it is read.

The maintenance agent (`maintain.py`) and the domain composer (`domain.py`)
are each one conversation on the harness's loop, and each may be resumed once
with what a checker objected to. A stage imports no other stage, so what both
need is here: the event as the request's cached first input, the loop run to
its end with the conversation it left, what the model said last, the closed
evidence set as a citation may name it, and a checker's objections as the
author is told them.

Built on the harness, which the stages are and the other shared modules are
not. It imports no stage and owns no contract.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from ..answer_trace import AnswerTrace, tool_entries
from ..config import Settings
from ..harness.budget import TurnBudget
from ..harness.loop import run_turn
from ..harness.provider import ResponsesClient, Terminal
from ..harness.registry import Toolset
from ..harness.tool import ToolContext
from ..harness.tools import open_memory
from ..memory_harness import OPEN_MAX_PAGES
from .run import Objection
from .staging import Evidence, ExistingPage, StagedPage

#: Sections or notes of one source the input lists before it says how many more.
LISTED_MAX = 60
#: The least time a loop is given. Zero would mean no deadline (`TurnBudget`).
NO_TIME_LEFT = 0.001
FINDINGS = {
    "unsupported": "a claim the passage it cites does not support",
    "differs": "a number, unit or equation that differs from the source",
    "removed": "supported content removed without a stated reason",
    "overwritten": "an outside source used to overwrite what a document says",
}



def _listed(names: Sequence[str]) -> str:
    more = f", and {len(names) - LISTED_MAX} more" if len(names) > LISTED_MAX else ""
    return ", ".join(names[:LISTED_MAX]) + more


def citable(sources: Sequence[Evidence]) -> str:
    """The closed evidence set as the write tools hold a citation to it (`cite.py`)."""
    lines = []
    for source in sources:
        title = f" — {source.title}" if source.title else ""
        if source.kind == "external":
            lines.append(f"- evidenceId `{source.id}`{title}: an outside source. Sections: {_listed(source.sections or ())}.")
            continue
        if source.via:
            # Reached through Memory, and cited only where the pages near this one cite it.
            where = (
                f"sections {_listed(source.sections or ())}" if source.sections is not None
                else f"pages {_listed([str(page) for page in sorted(source.only_pages)])}"
            )
            lines.append(
                f"- paperId `{source.id}`{title}: a document of the library this run cannot read, cited by "
                f"{', '.join(f'[[{slug}]]' for slug in source.via)}. Only at {where}, for what that page says it says there."
            )
            continue
        where = (
            f"read by section: {_listed(source.sections)}" if source.sections is not None
            else f"a PDF, pages 1 to {source.pages}"
        )
        notes = f" The reader's notes on it, by noteId: {_listed(sorted(source.notes))}." if source.notes else ""
        lines.append(f"- paperId `{source.id}`{title}: a document, {where}.{notes}")
    listed = "\n".join(lines) or "Nothing. No claim can be cited in this run, so nothing can be filed."
    return f"<citable_sources>\n{listed}\n</citable_sources>"


def stored_pages(storage: Any, username: str, settings: Settings) -> list[ExistingPage]:
    """Every stored page, as much of it as a write is checked against. Blocking."""
    return [
        ExistingPage(
            page["slug"], page.get("title") or page["slug"], page.get("kind") or "",
            tuple(page.get("aliases") or ()), page.get("revision") or 0,
        )
        for page in storage.list_memory_pages(username, limit=max(1, settings.memory_max_pages))
    ]


async def open_pages(toolset: Toolset, context: ToolContext, slugs: Sequence[str]) -> tuple[str, list[str]]:
    """
    Open pages as the run's own `open_memory` would, before the loop starts.

    It is that tool's runner that is called, so what the agent holds and what
    the draft records as shown are exactly what a call would have given, and
    no call is charged for them.
    """
    tool = next(tool for tool in toolset.tools if tool.name == open_memory.NAME)
    texts: list[str] = []
    opened: list[str] = []
    for at in range(0, len(slugs), OPEN_MAX_PAGES):
        result = await tool.run(tool.arguments(slugs=list(slugs[at : at + OPEN_MAX_PAGES])), context)
        if result.pages:
            texts.append(result.text)
            opened += result.pages
    return "\n\n".join(texts), opened


def event_turn(brief: str, cached: bool) -> dict[str, Any]:
    """The event as the request's first input: the prefix a repair and a retry share."""
    block: dict[str, Any] = {"type": "input_text", "text": brief}
    if cached:
        block["prompt_cache_breakpoint"] = {"mode": "explicit"}
    return {"role": "user", "content": [block]}


def settled(conversation: Sequence[Any]) -> list[Any]:
    """The conversation without a call that was never answered: a deadline can leave one."""
    answered = {item.get("call_id") for item in conversation if item.get("type") == "function_call_output"}
    return [item for item in conversation if item.get("type") != "function_call" or item.get("call_id") in answered]


def closing(conversation: Sequence[Any]) -> str:
    """What the agent said after its last tool result, which is how it ended."""
    said: list[str] = []
    for item in reversed(conversation):
        if item.get("type") == "message" and item.get("role") == "assistant":
            said.insert(0, "".join(part.get("text") or "" for part in item.get("content") or ()))
        elif item.get("type") != "reasoning":
            break
    return "\n\n".join(text.strip() for text in said if text.strip())


def added(usage: Mapping[str, int], more: Mapping[str, int]) -> dict[str, int]:
    return {name: usage.get(name, 0) + more.get(name, 0) for name in dict.fromkeys((*usage, *more))}


async def run_loop(
    client: ResponsesClient, request: dict[str, Any], toolset: Toolset, budget: TurnBudget, context: ToolContext
) -> tuple[list[Any], str, list[dict[str, Any]]]:
    """Run the loop to its end. Returns the conversation as it stood, how it ended, and the calls made."""
    conversation: list[Any] = []
    recorder = AnswerTrace()
    ended = "ended"
    async for event in run_turn(client, request, toolset, budget, context, recorder, conversation):
        if event["type"] == "turn_end":
            result = event["result"]
            ended = "completed" if result.terminal is Terminal.COMPLETED else (result.reason or "incomplete")
    # A call the run ended on is recorded as interrupted, never as running.
    recorder.finish()
    return settled(conversation), ended, tool_entries(recorder.stored())


def objection_lines(page: StagedPage, objections: Sequence[Objection]) -> str:
    what = "a new page" if page.action == "create" else "an edit"
    lines = [f"[[{page.slug}]] ({page.title}), staged as {what}:"]
    for number, item in enumerate(objections, start=1):
        cited = f" Evidence: {item.evidence_id}." if item.evidence_id else ""
        lines.append(
            f"{number}. {FINDINGS.get(item.finding, item.finding).capitalize()}. The page says: "
            f"\"{item.quote}\" The checker's explanation: {item.explanation}{cited}"
        )
    return "\n".join(lines)
