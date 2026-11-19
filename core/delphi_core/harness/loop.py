"""
The agentic loop: one answer, pausing to serve whatever the model asks for.

With no tools a turn is one request. With them the model holds outlines,
digests and chosen Memory pages rather than every text, so it will usually ask
for a section or a page before answering. Each round trip appends everything
the model produced (`replay`) and the output of each call, and asks again.
`store: False` means nothing is remembered server-side, so the growing request
*is* the memory, which is why the round count and every read are bounded
(`budget`).

The loop knows no tool by name and no task by name. What may be called comes
from the `Toolset`, what may be spent from the `TurnBudget`, and what a tool
may reach from the `ToolContext`; a caller that wants the reader to see the
work consumes the events, and a caller that does not ignores them and takes
the last one.

How a turn ends is said, never inferred. The last event is `turn_end`,
carrying a `TurnResult`: the turn completed, or it was cut off and why. A
response that failed, or a stream that closed before the provider said it was
finished, raises `ProviderError` instead — there is no answer to speak of.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass, field
from typing import Any

from ..answer_trace import AnswerTrace
from ..artifacts.delivery import Delivery
from .budget import TurnBudget, TurnDeadline
from .provider import ProviderError, ProviderResult, ResponsesClient, Terminal, cited_sources
from .registry import Toolset, hosted_outcome, hosted_tool, status_label, trace_arguments
from .replay import replay_item, replay_items
from .tool import BudgetClass, ToolContext

#: The tools that draft an inline visual.
VISUAL_TOOLS = frozenset({"draw_display", "embed_figure"})
#: Said once the last round that may call a tool has been served.
LAST_ROUND_NOTE = (
    "This turn's tool allowance is finished. Answer now with what you have, "
    "use only already published visualization references, and say which parts you could not check."
)
#: Said before the last ordinary round while a visual is offered and none was tried:
#: reading to the end leaves no round in which to draw.
DRAW_ROUND_NOTE = (
    "This is the last round for reading. If a display would show what the reader asked, draw it now "
    "from what you have read. Drawing opens further rounds: a draft, even one the schema refuses, "
    "keeps the turn going so you can repair it, inspect it and publish it. "
    "Reading instead leaves no round to draw."
)
#: Why a turn was cut off when it was the clock, not the provider, that cut it.
DEADLINE = "deadline"


@dataclass(frozen=True)
class TurnResult:
    """How a turn ended: completed, or cut off (`INCOMPLETE`) and why."""

    terminal: Terminal
    #: For a cut-off turn: the provider's reason, or `DEADLINE`.
    reason: str | None = None
    #: The web pages the answer cites, in order, each once: `{url, title}`.
    sources: list[dict[str, str]] = field(default_factory=list)


def _has_images(conversation: list[Any]) -> bool:
    return any(
        isinstance(item.get("content"), list)
        and any(block.get("type") == "input_image" for block in item["content"])
        for item in conversation
        if isinstance(item, dict)
    )


def _call_key(item: dict[str, Any]) -> str:
    """What names one function call across the events that describe it."""
    return item.get("id") or item.get("call_id") or ""


def _unfinished(result: ProviderResult) -> ProviderError:
    if result.terminal is Terminal.FAILED:
        return ProviderError(
            result.reason or "The model provider's response failed.",
            result.terminal, result.reason,
        )
    return ProviderError(
        "The model provider's response ended before it was finished.",
        result.terminal, result.reason,
    )


async def run_turn(
    client: ResponsesClient,
    request: dict[str, Any],
    toolset: Toolset,
    budget: TurnBudget,
    context: ToolContext,
    recorder: AnswerTrace | None = None,
    conversation: list[Any] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """
    Stream one answer.

    Yields `delta` (answer text), `reasoning` and `reasoning_break` (the
    model's summary of its thinking), `status` (what is running now),
    `progress` (a document read began), `trace` events, and last of all one
    `turn_end`.

    What the model says before reading is part of the answer and is streamed
    as it arrives. Each later message starts a new paragraph, so the stored
    answer reads as it was written rather than as one run-on line.

    `recorder`, when given, is told everything as it happens — each line of
    the reasoning summary, each call as it starts and as it returns, each
    piece of answer text — and the `trace` events it answers with are yielded
    in place, so the stream carries the record as it is built
    (`answer_trace`). The calls are what Delphi did and are exact; the
    thoughts are the model's own words, kept beside them.

    `conversation`, when given, is the list the turn keeps its growing input
    in: it is filled from the request's `input` and extended in place, so the
    caller is left holding the conversation as the turn ended, the last
    response included. A caller that resumes the same run with one more
    message (a maintenance repair) sends it back as the next request's
    `input`. A turn the deadline cut off may leave a call in it that was never
    answered; what to do with that is the caller's.
    """
    if conversation is None:
        conversation = []
    conversation[:] = request["input"]
    # A caller with no use for the record still runs the same code path.
    record = recorder or AnswerTrace()
    delivery = Delivery(context.artifacts) if context.artifacts is not None else None

    def visible(text: str):
        for chunk in delivery.push(text) if delivery else (text,):
            for change in record.answered(chunk):
                yield change
            yield {"type": "delta", "text": chunk}

    def finish_delivery(completed: bool):
        for chunk in delivery.finish(completed=completed) if delivery else ():
            for change in record.answered(chunk):
                yield change
            yield {"type": "delta", "text": chunk}
    # Whether a message has already been written to the reader in this answer.
    said = False
    # What the answer cites from the web, across every round of the turn.
    sources: list[dict[str, str]] = []
    # Offering visualization tools does not enlarge ordinary chat's allowance.
    # Only a dispatched render attempt earns room to inspect and repair it.
    max_rounds = 1 if _has_images(conversation) else budget.rounds
    # The closing round keeps the same instructions and the same tools and may
    # call none of them, so the model cannot spend the last request asking for
    # something it will never be given and leave the reader with no answer.
    closing = max_rounds <= 0
    drawable = bool(toolset.names & VISUAL_TOOLS) and context.artifacts is not None and context.artifacts.enabled

    try:
        while True:
            if (drawable and not closing and max_rounds > 1 and budget.rounds_run == max_rounds - 1
                    and not context.artifacts.attempted and not budget.spent(BudgetClass.ARTIFACT_RENDER)):
                conversation.append({"role": "user", "content": DRAW_ROUND_NOTE})
            if context.artifacts is not None:
                context.artifacts.round += 1
            round_request = {
                **request,
                "input": conversation,
                **toolset.round_fields(budget, closing),
            }
            output: list[dict[str, Any]] = []
            # Hosted calls under way, by the provider's id for each: a call is
            # shown where it happened, while it happens, not after the round.
            hosted: dict[str, int | None] = {}
            # Function calls the model began this round, by item: each is shown
            # as soon as it begins, and dispatch continues the same entry.
            begun: dict[str, tuple[int, int] | None] = {}
            result: ProviderResult | None = None
            # Closed with the turn, at once and on every path. An abandoned
            # async generator is finalised whenever the collector reaches it,
            # and the provider bills a streamed response until the socket goes
            # away: a reader's Stop has to hang up, not merely stop listening.
            async with aclosing(client.stream(round_request)) as events:
                while (event := await budget.within(anext(events, None))) is not None:
                    kind = event["type"]
                    if kind == "terminal":
                        result = event["result"]
                        budget.count(result)
                    elif kind == "item_done":
                        item = event["item"]
                        output.append(item)
                        said = said or (
                            item.get("type") == "message" and replay_item(item) is not None
                        )
                        if item.get("type") == "function_call":
                            yield {"type": "status", "text": ""}
                            for change in record.call_written(
                                begun.get(_call_key(item)),
                                trace_arguments(item.get("name") or "", item.get("arguments") or "{}"),
                            ):
                                yield change
                        elif tool := hosted_tool(item):
                            args, consulted, ran = hosted_outcome(tool, item)
                            if ran:
                                budget.charge(BudgetClass.WEB)
                                if context.artifacts is not None:
                                    context.artifacts.read_round = context.artifacts.round
                            handle = hosted.pop(item.get("id") or "", None)
                            if handle is None:
                                handle, opened = record.tool_started(tool.name, args)
                                for change in opened:
                                    yield change
                            for change in record.tool_finished(
                                handle, ok=ran, error=None if ran else "Limit reached",
                                results=consulted, args=args,
                            ):
                                yield change
                        elif item.get("type") == "message":
                            sources = cited_sources([item], sources)
                    elif kind == "text_delta":
                        if said:
                            said = False
                            for change in visible("\n\n"):
                                yield change
                        for change in visible(event["text"]):
                            yield change
                    elif kind == "reasoning_delta":
                        for change in record.thought(event["text"]):
                            yield change
                        yield {"type": "reasoning", "text": event["text"]}
                    elif kind == "reasoning_break":
                        record.thought_break()
                        yield {"type": "reasoning_break"}
                    elif kind == "item_added":
                        item = event["item"]
                        item_type = item.get("type") or ""
                        if item_type.endswith("_call"):
                            yield {
                                "type": "status",
                                "text": status_label(item_type, item.get("name") or ""),
                            }
                        if (tool := hosted_tool(item)) and item.get("id"):
                            hosted[item["id"]], opened = record.tool_started(tool.name)
                            for change in opened:
                                yield change
                        elif item_type == "function_call" and _call_key(item):
                            # Its arguments stream after this, and a draft's
                            # whole source is one: shown now, not once written.
                            begun[_call_key(item)], opened = record.call_begun(item.get("name") or "")
                            for change in opened:
                                yield change
                    elif kind == "call_completed":
                        yield {"type": "status", "text": ""}

            if result is None or result.terminal in {Terminal.FAILED, Terminal.ENDED}:
                raise _unfinished(result or ProviderResult(Terminal.ENDED))
            if result.terminal is Terminal.INCOMPLETE:
                for change in finish_delivery(False):
                    yield change
                yield {
                    "type": "turn_end",
                    "result": TurnResult(Terminal.INCOMPLETE, result.reason, sources),
                }
                return

            calls = [item for item in output if item.get("type") == "function_call"]
            if not calls or closing:
                # Nothing is sent after this; it is kept for a caller that resumes.
                conversation.extend(replay_items(output))
                for change in finish_delivery(True):
                    yield change
                yield {"type": "turn_end", "result": TurnResult(Terminal.COMPLETED, sources=sources)}
                return

            conversation.extend(replay_items(output))
            for call in calls:
                async with aclosing(
                    toolset.dispatch(
                        call, context, budget, record, conversation, begun=begun.get(_call_key(call))
                    )
                ) as served:
                    async for event in served:
                        yield event

            if (context.artifacts is not None and context.artifacts.enabled
                    and (budget.artifact_renders_made or budget.artifact_refusals)):
                # Schema refusals also need a repair round. Use a fixed ceiling,
                # not a fresh extension per attempt, including for image turns.
                max_rounds = budget.rounds + budget.artifact_render_calls + budget.artifact_publish_calls
            closing = budget.rounds_run >= max_rounds or budget.output_spent
            if closing:
                conversation.append({"role": "user", "content": LAST_ROUND_NOTE})
    except ProviderError:
        for change in finish_delivery(False):
            yield change
        raise
    except TurnDeadline:
        for change in finish_delivery(False):
            yield change
        yield {"type": "turn_end", "result": TurnResult(Terminal.INCOMPLETE, DEADLINE, sources)}
