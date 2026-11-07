"""
What one turn may spend.

`store: False` makes the growing request the model's only memory, so every
limit here is a bound on how large that request can get, or on how long the
turn can run: how many rounds may call a tool, how many reads each class of
tool may make, how many characters of a document may be handed back in all,
how many hosted web calls and how many output tokens the turn may use, and how
long it may take.

A class is charged as a whole. Consulting Memory is counted apart from reading
documents on purpose: what the reader knows must never cost the model a page
it needed to answer with. Figures have a count of their own because they are
the only read that costs image tokens, and one is a Memory read as well.
Writes are counted apart for the same reason: a maintenance run that has a
write refused and tries again must not pay for it with a page it had yet to
read. A chat turn has no writes to spend.

The budget is also the turn's ledger. Each response is counted into it
(`count`), so what the turn used is summed across rounds here and nowhere
else, and a caller that built the budget can read it whether the turn finished
or raised.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable
from typing import Any
from dataclasses import dataclass, field

from ..config import Settings
from .provider import ProviderResult, Usage
from .tool import BudgetClass

#: What a spent class answers. Prose, because the model reads it (invariant 15).
DOCUMENT_CALLS_SPENT = (
    "Error: the exact-document read budget is exhausted. Answer "
    "with the evidence already retrieved and identify uncertainty."
)
DOCUMENT_CHARS_SPENT = (
    "Error: the total exact-document character budget is exhausted. "
    "Answer with the evidence already retrieved."
)
MEMORY_CALLS_SPENT = (
    "The per-answer budget for consulting the knowledge "
    "base is spent. Answer with what you have."
)
FIGURE_VIEWS_SPENT = (
    "The per-answer limit on looking at stored figures "
    "is reached; the captions you already have are all "
    "that is available. Continue answering."
)
WRITE_CALLS_SPENT = (
    "Error: this run's allowance of write calls is spent. What is staged "
    "stays staged; finish, and say what is left to do."
)
ARTIFACT_REFUSALS = 4
ARTIFACT_CALLS_SPENT = "Error: this turn's visualization allowance is spent. Deliver only already published revisions; otherwise explain the limitation in prose."
#: A maintenance run's bounds, where its caller gives none. It reads more than
#: a chat turn does (it walks from a source page to every page that should
#: change) and has no reader waiting on it.
MAINTAIN_ROUNDS = 12
MAINTAIN_MEMORY_CALLS = 16
#: Each staged page may be refused and corrected a few times.
MAINTAIN_WRITE_CALLS_PER_PAGE = 4
MAINTAIN_STAGED_PAGES = 2


class TurnDeadline(Exception):
    """The turn ran out of time. Raised at an await, never across a yield."""


#: An error is kept short however little of the budget is left, so a spent
#: allowance cannot erase the diagnostic and make a refused read look served.
ERROR_MAX_CHARS = 512


@dataclass
class TurnBudget:
    """One turn's limits, and how much of each is gone."""

    #: Rounds that may call tools. One more follows, in which none may.
    rounds: int
    document_calls: int
    document_chars: int
    memory_calls: int
    figure_views: int
    #: Hosted web calls across the turn. The provider counts a search, a page
    #: opened and a find within a page as one each.
    hosted_calls: int = 0
    #: Output tokens across the turn, reasoning included. Zero is no ceiling.
    output_tokens: int = 0
    #: Seconds the turn may take. Zero is no deadline.
    deadline_seconds: float = 0
    #: Calls that stage a write to Memory, refused ones included. Zero for chat.
    write_calls: int = 0
    #: Pages a maintenance run may stage. The run's `MemoryDraft` is built with
    #: this and is what enforces it; it is here so a run's bounds are one object.
    staged_pages: int = 0
    artifact_render_calls: int = 0
    artifact_publish_calls: int = 0
    artifact_renders_made: int = 0
    artifact_publishes_made: int = 0
    #: Display specs refused before rendering; up to ARTIFACT_REFUSALS give their call back.
    artifact_refusals: int = 0
    write_calls_made: int = 0
    document_calls_made: int = 0
    document_chars_returned: int = 0
    memory_calls_made: int = 0
    figure_views_made: int = 0
    hosted_calls_made: int = 0
    #: Responses the turn has received.
    rounds_run: int = 0
    #: Summed across every response of the turn.
    usage: Usage = field(default_factory=Usage)
    #: The first response alone: what the turn cost before any tool ran.
    first_usage: Usage | None = None
    started: float = field(default_factory=time.monotonic)

    @classmethod
    def for_chat(cls, settings: Settings, *, memory_calls: int | None = None) -> "TurnBudget":
        return cls(
            rounds=settings.model_tool_max_rounds,
            document_calls=settings.document_tool_max_calls,
            document_chars=settings.document_tool_max_chars,
            memory_calls=memory_calls or settings.memory_tool_max_calls,
            figure_views=settings.memory_figure_max_views,
            hosted_calls=settings.web_search_max_calls,
            output_tokens=settings.turn_max_output_tokens,
            deadline_seconds=settings.turn_deadline_seconds,
            artifact_render_calls=6 if settings.artifact_renderer_path else 0,
            artifact_publish_calls=2 if settings.artifact_renderer_path else 0,
        )

    @classmethod
    def for_maintenance(
        cls,
        settings: Settings,
        *,
        rounds: int = MAINTAIN_ROUNDS,
        memory_calls: int = MAINTAIN_MEMORY_CALLS,
        staged_pages: int = MAINTAIN_STAGED_PAGES,
        deadline_seconds: float | None = None,
        document_calls: int = 0,
        document_chars: int = 0,
    ) -> "TurnBudget":
        """
        A maintenance run's bounds: rounds, Memory reads, document reads and pages staged.

        Document reads are the event's own document, and only a run that has
        one to read is given any. It looks at no figure, and its profile
        offers no web search, so those classes have nothing to spend.
        """
        return cls(
            rounds=rounds,
            document_calls=document_calls,
            document_chars=document_chars,
            memory_calls=memory_calls,
            figure_views=0,
            output_tokens=settings.turn_max_output_tokens,
            deadline_seconds=settings.turn_deadline_seconds if deadline_seconds is None else deadline_seconds,
            write_calls=staged_pages * MAINTAIN_WRITE_CALLS_PER_PAGE,
            staged_pages=staged_pages,
        )

    @property
    def document_chars_left(self) -> int:
        return self.document_chars - self.document_chars_returned

    @property
    def hosted_left(self) -> int:
        return max(0, self.hosted_calls - self.hosted_calls_made)

    @property
    def output_spent(self) -> bool:
        return bool(self.output_tokens) and self.usage.output_tokens >= self.output_tokens

    @property
    def seconds_left(self) -> float | None:
        """Time before the deadline, or None when the turn has none."""
        if not self.deadline_seconds:
            return None
        return self.deadline_seconds - (time.monotonic() - self.started)

    async def within(self, awaitable: Awaitable[Any]) -> Any:
        """
        Await something no longer than the turn has left.

        The deadline is enforced here, at each await the loop makes, rather
        than by a timeout wrapped around the whole loop: the loop is an async
        generator, and a timeout that spans a `yield` cancels whatever the
        consumer happens to be doing when it fires.
        """
        left = self.seconds_left
        if left is None:
            return await awaitable
        if left <= 0:
            close = getattr(awaitable, "close", None)
            if close is not None:
                close()
            raise TurnDeadline()
        try:
            return await asyncio.wait_for(awaitable, left)
        except TimeoutError:
            # A timeout of the awaited thing's own is not the turn's deadline.
            if (self.seconds_left or 0) > 0:
                raise
            raise TurnDeadline() from None

    def count(self, result: ProviderResult) -> None:
        """One response arrived: add what it cost to the turn."""
        self.rounds_run += 1
        self.usage = self.usage + result.usage
        if self.first_usage is None:
            self.first_usage = result.usage

    def spent(self, budget: BudgetClass) -> bool:
        """Whether a class has nothing left, so its tools are withheld next round."""
        if budget is BudgetClass.DOCUMENT:
            return (
                self.document_calls_made >= self.document_calls
                or self.document_chars_left <= 0
            )
        if budget is BudgetClass.MEMORY:
            return self.memory_calls_made >= self.memory_calls
        if budget is BudgetClass.FIGURE:
            return self.figure_views_made >= self.figure_views or self.spent(BudgetClass.MEMORY)
        if budget is BudgetClass.WRITE:
            return self.write_calls_made >= self.write_calls
        if budget is BudgetClass.ARTIFACT_RENDER:
            return self.artifact_renders_made >= self.artifact_render_calls
        if budget is BudgetClass.ARTIFACT_PUBLISH:
            return self.artifact_publishes_made >= self.artifact_publish_calls
        return self.hosted_left <= 0

    def charge(self, budget: BudgetClass) -> str | None:
        """Count one call against its class. Returns what to answer when it is spent."""
        if budget is BudgetClass.DOCUMENT:
            self.document_calls_made += 1
            if self.document_calls_made > self.document_calls:
                return DOCUMENT_CALLS_SPENT
            if self.document_chars_returned >= self.document_chars:
                return DOCUMENT_CHARS_SPENT
        elif budget is BudgetClass.MEMORY:
            self.memory_calls_made += 1
            if self.memory_calls_made > self.memory_calls:
                return MEMORY_CALLS_SPENT
        elif budget is BudgetClass.FIGURE:
            self.figure_views_made += 1
            if self.figure_views_made > self.figure_views:
                return FIGURE_VIEWS_SPENT
        elif budget is BudgetClass.WRITE:
            self.write_calls_made += 1
            if self.write_calls_made > self.write_calls:
                return WRITE_CALLS_SPENT
        elif budget is BudgetClass.WEB:
            # The provider ran it; this only counts what came back completed.
            self.hosted_calls_made += 1
        elif budget is BudgetClass.ARTIFACT_RENDER:
            self.artifact_renders_made += 1
            if self.artifact_renders_made > self.artifact_render_calls:
                return ARTIFACT_CALLS_SPENT
        elif budget is BudgetClass.ARTIFACT_PUBLISH:
            self.artifact_publishes_made += 1
            if self.artifact_publishes_made > self.artifact_publish_calls:
                return ARTIFACT_CALLS_SPENT
        return None

    def refund_refusal(self) -> bool:
        """Give back the render call of a spec refused before rendering, a few times a turn."""
        if self.artifact_refusals >= ARTIFACT_REFUSALS or self.artifact_renders_made == 0:
            return False
        self.artifact_refusals += 1
        self.artifact_renders_made -= 1
        return True

    def bound(self, budget: BudgetClass, text: str) -> str:
        """Cut a result to what its class has left, and count it."""
        if budget is not BudgetClass.DOCUMENT:
            return text
        if text.startswith("Error:"):
            return text[:ERROR_MAX_CHARS]
        text = text[: max(0, self.document_chars_left)]
        self.document_chars_returned += len(text)
        return text
