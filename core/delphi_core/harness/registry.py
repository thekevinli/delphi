"""
The catalogue of tools, the set one request offers, and how a call is served.

`CATALOGUE` is every tool there is. It is an explicit tuple of modules rather
than a scan of the package: it can be searched for, it has no import-order
surprises, and the structure test keeps it equal to the directory. Its order is
the order to reach for them (invariant 43): the open document, the project's
other documents, a search of the project, Memory, then the web. The two tools
that write Memory follow the ones that read it. Being in the catalogue offers a tool to no one:
only a maintenance profile offers those, and a structure guard holds that no
chat profile does.

A `Toolset` is what one request offers, built by a profile (`profiles`). It is
the only source of a request's `tools`, and `dispatch` is the only place a
call is served, so a tool cannot be offered from one list and charged from
another.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Iterable
from typing import Any
from urllib.parse import urlsplit

from pydantic import ValidationError

from ..answer_trace import AnswerTrace, call_arguments, call_outcome
from ..document_reads import asked_document
from ..memory_harness import page_results
from .budget import TurnBudget, TurnDeadline
from .tool import BudgetClass, Tool, ToolContext, ToolResult
from .tools import (
    create_memory,
    draw_display,
    edit_memory,
    embed_figure,
    grep_memory,
    memory_links,
    open_memory,
    publish_artifact,
    read_paper,
    read_url,
    read_webpage,
    search_library,
    view_figure,
    web_search,
)

CATALOGUE = (
    read_webpage,
    read_paper,
    search_library,
    open_memory,
    grep_memory,
    memory_links,
    view_figure,
    edit_memory,
    create_memory,
    draw_display,
    embed_figure,
    publish_artifact,
    read_url,
    web_search,
)

#: Each tool as it is when a profile varies nothing about it.
DEFAULTS: dict[str, Tool] = {module.NAME: module.tool() for module in CATALOGUE}
_HOSTED: dict[str, Tool] = {tool.item_type: tool for tool in DEFAULTS.values() if tool.hosted}

logger = logging.getLogger("uvicorn.error")


def status_label(item_type: str, name: str = "") -> str:
    """The status line for a call: by function name, or by a hosted item's type."""
    if name in DEFAULTS and not DEFAULTS[name].hosted:
        return DEFAULTS[name].label
    if item_type in _HOSTED:
        return _HOSTED[item_type].label
    # "some_new_call" reads as "Using some new" — vague, but better than silence
    # when the provider adds a hosted tool we do not know about yet.
    return f"Using {item_type.removesuffix('_call').replace('_', ' ')}"


def hosted_tool(item: dict[str, Any]) -> Tool | None:
    """The hosted tool an output item is a call of, if it is one."""
    return _HOSTED.get(item.get("type") or "")


def _site(url: str) -> str:
    """The site an address is on, as a reader would say it."""
    return (urlsplit(url).hostname or url).removeprefix("www.")


def hosted_outcome(
    tool: Tool, item: dict[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
    """
    A finished hosted call as the trace records it: what it did, the pages it
    consulted, and whether it ran.

    The provider ran this one itself; all Delphi knows is what it reports. A
    search says its query and the addresses it read; opening a page or finding
    text within one says which page. A call past the turn's allowance still
    arrives as an item, but never as a completed one.
    """
    action = item.get("action") or {}
    kind = action.get("type") or "search"
    asked = {
        "query": action.get("query") or "",
        "url": action.get("url") or "",
        "pattern": action.get("pattern") or "",
        # A search is the unmarked case, as it was before the others existed.
        "action": "" if kind == "search" else kind,
    }
    results = [
        {"url": source["url"], "title": _site(source["url"]), "kind": "web"}
        for source in action.get("sources") or ()
        if isinstance(source, dict)
        and isinstance(source.get("url"), str)
        and urlsplit(source["url"]).scheme in {"http", "https"}
    ]
    return call_arguments(tool.trace.keep, asked), results, item.get("status") == "completed"


def _unusable(tool: Tool, refused: ValidationError) -> str:
    """Arguments the tool's schema refuses, said so the model can correct them."""
    first = refused.errors()[0]
    if first["type"] == "json_invalid":
        return "Error: arguments were not valid JSON."
    field = ".".join(str(part) for part in first["loc"]) or "arguments"
    return (
        f"Error: {tool.name} cannot use these arguments. `{field}`: {first['msg']}. "
        f"It takes: {', '.join(tool.arguments.model_fields)}."
    )


def trace_arguments(name: str, arguments: str | dict[str, Any]) -> dict[str, Any]:
    """The arguments of one call worth keeping, as its tool's projection says."""
    tool = DEFAULTS.get(name)
    return call_arguments(tool.trace.keep if tool else (), arguments)


class Toolset:
    """The tools one request offers, in the order it offers them."""

    def __init__(self, tools: Iterable[Tool] = ()) -> None:
        self.tools = tuple(tools)
        self._by_name = {tool.name: tool for tool in self.tools}

    @property
    def names(self) -> frozenset[str]:
        return frozenset(self._by_name)

    def specs(self) -> list[dict[str, Any]]:
        """The request's `tools` array. Empty means the key is omitted (invariant 12)."""
        return [tool.spec for tool in self.tools]

    def include(self) -> list[str]:
        """What the request must ask the provider to include for the tools it offers."""
        return [value for tool in self.tools for value in tool.include]

    def round_fields(self, budget: TurnBudget, closing: bool) -> dict[str, Any]:
        """
        What one round's request says about calling tools.

        The `tools` array never changes within a turn: it is part of the
        cached prefix, and instructions that describe tools the request no
        longer carries are a contradiction the model has to resolve. What
        changes is which of them may be called. The closing round may call
        none; a class with nothing left is withheld; and the provider is told
        how many hosted calls remain, because it runs those itself and nothing
        here could refuse one.
        """
        if not self.tools:
            return {}
        if closing:
            return {"tool_choice": "none"}
        open_ = [tool for tool in self.tools if not budget.spent(tool.budget)]
        fields: dict[str, Any] = {}
        if any(tool.hosted for tool in open_):
            fields["max_tool_calls"] = budget.hosted_left
        if not open_:
            fields["tool_choice"] = "none"
        elif len(open_) < len(self.tools):
            fields["tool_choice"] = {
                "type": "allowed_tools",
                "mode": "auto",
                # A reference names a tool by the keys its own entry uses.
                "tools": [
                    {key: tool.spec[key] for key in ("type", "name") if key in tool.spec}
                    for tool in open_
                ],
            }
        return fields

    def not_offered(self, name: Any) -> str:
        """What a call to anything outside this request's tools is answered with."""
        callable_ = ", ".join(tool.name for tool in self.tools if not tool.hosted)
        return (
            f"Error: {name!r} is not a tool this conversation offers."
            + (f" The tools you can call are: {callable_}." if callable_ else "")
        )

    def _refusal(self, tool: Tool, ctx: ToolContext, budget: TurnBudget) -> str | None:
        """Why this call will not run, or None. A refused call is still counted."""
        missing = any(getattr(ctx, need) is None for need in tool.needs)
        if tool.budget in (BudgetClass.DOCUMENT, BudgetClass.WRITE, BudgetClass.ARTIFACT_RENDER, BudgetClass.ARTIFACT_PUBLISH):
            # A write stages into the run's draft and reads no store itself.
            return budget.charge(tool.budget) or (
                self.not_offered(tool.name) if missing else None
            )
        if ctx.storage is None:
            return self.not_offered(tool.name)
        # A figure is a Memory read first, and then a figure.
        spent = budget.charge(BudgetClass.MEMORY)
        if spent:
            return spent
        if missing:
            return self.not_offered(tool.name)
        if tool.budget is BudgetClass.MEMORY:
            return None
        return budget.charge(BudgetClass.FIGURE)

    async def _serve(
        self, tool: Tool | None, name: Any, arguments: str, ctx: ToolContext, budget: TurnBudget
    ) -> ToolResult:
        """One call's result. Everything but the turn's deadline comes back as prose."""
        # The offered set is the allowlist. A name outside it never reaches a
        # runner, whatever the catalogue holds and whatever text asked for it.
        if tool is None or tool.run is None:
            return ToolResult(self.not_offered(name))
        if tool.budget is BudgetClass.ARTIFACT_RENDER and ctx.artifacts is not None:
            # Schema and budget refusals are still attempted visualizations;
            # the terminal delivery fallback must not claim they disappeared.
            ctx.artifacts.attempted = True
        if refusal := self._refusal(tool, ctx, budget):
            return ToolResult(refusal)
        try:
            parsed = tool.arguments.model_validate_json(arguments)
        except ValidationError as refused:
            if tool.budget is BudgetClass.ARTIFACT_RENDER:
                # Like a refused spec: a mistyped argument must not cost a visualization.
                budget.refund_refusal()
            return ToolResult(_unusable(tool, refused))
        ctx.document_chars_left = budget.document_chars_left
        try:
            result = await budget.within(tool.run(parsed, ctx))
            if result.refused and tool.budget is BudgetClass.ARTIFACT_RENDER:
                budget.refund_refusal()
            return result
        except TurnDeadline:
            raise
        except Exception:
            # A tool is a side road. Its failure is something the model can
            # route around; raising would take the whole answer down with it.
            logger.exception("tool %s raised", tool.name)
            return ToolResult(
                f"Error: {tool.name} could not be run just now. Continue with what you have."
            )

    async def dispatch(
        self,
        call: dict[str, Any],
        ctx: ToolContext,
        budget: TurnBudget,
        record: AnswerTrace,
        conversation: list[dict[str, Any]],
        *,
        begun: tuple[int, int] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """
        Serve one function call and hand its result back.

        Yields the stream events the call produces — a progress line for a
        document read, and the trace entry as it opens and closes — and appends
        to `conversation` what the model's next round is handed: the call's
        output, including any image returned by that tool. `begun` is the
        entry the trace opened when the model began writing this call.
        """
        name = call.get("name")
        arguments = call.get("arguments") or "{}"
        tool = self._by_name.get(name)
        if tool is not None and tool.budget is BudgetClass.DOCUMENT:
            yield {
                "type": "progress",
                "stage": "document_read",
                "message": status_label("function_call", name or ""),
                "paperId": asked_document(arguments) or None,
                "elapsedMs": 0,
            }
        handle, changes = record.tool_started(name or "", trace_arguments(name or "", arguments), begun=begun)
        for change in changes:
            yield change
        result = await self._serve(tool, name, arguments, ctx, budget)
        output = budget.bound(tool.budget, result.text) if tool else result.text
        ok, error = call_outcome(output)
        if ok and ctx.artifacts is not None and tool and tool.budget in (BudgetClass.DOCUMENT, BudgetClass.FIGURE):
            ctx.artifacts.read_round = ctx.artifacts.round
        # What the call returned besides its prose: the pages a lookup found or
        # opened, or the document a read was served from. Taken from what was
        # executed, never parsed back out of our own output.
        if result.pages and ctx.storage is not None:
            results = await ctx.in_thread(
                page_results, ctx.storage, ctx.username, ctx.settings, list(result.pages)
            )
        else:
            results = result.document if ok else []
        for change in record.tool_finished(
            handle, ok=ok, error=error, results=results,
            found=len(result.pages) if result.pages else None,
        ):
            yield change
        # Pixels belong to the call that produced them. Inspection feedback
        # must not create a synthetic reader turn in the replayed conversation.
        conversation.append({
            "type": "function_call_output", "call_id": call.get("call_id"),
            "output": output if result.image is None else [
                {"type": "input_text", "text": output}, result.image,
            ],
        })
