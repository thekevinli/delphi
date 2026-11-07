"""Open Memory pages in full, with the first lines of the pages they link to."""

from dataclasses import dataclass
from typing import Literal

from pydantic import Field

from ...memory_harness import OPEN_MAX_PAGES, open_chosen_memory, open_memory_for_editing
from ...memory_maintenance.staging import ShownPage
from ..tool import BudgetClass, Tool, ToolArguments, ToolContext, ToolResult, TraceProjection

NAME = "open_memory"


class Arguments(ToolArguments):
    slugs: list[str] = Field(
        min_length=1,
        description=f"Up to {OPEN_MAX_PAGES} pages, each by the last segment of its path.",
    )


@dataclass(frozen=True)
class Options:
    #: A question beside a document arrives with pages already chosen and
    #: open; Memory chat arrives with the index and opens its own. A
    #: maintenance run opens a page to edit it: it is shown the page whole,
    #: with its blocks labelled, and what it was shown is recorded in its draft.
    #: The option changes what comes back and never what may be asked.
    scope: Literal["document", "general", "maintenance"] = "document"


_GIVEN = " Pages in `<reader_memory>` are already open; do not open them again."


_EDITING_DESCRIPTION = (
    "Open Memory pages by slug, several at once. Returns each page whole: its "
    "kind, revision and summary, its body with every top-level block under a "
    "label (b1, b2, …), and its citations as [E#] with what each points at. "
    "The labels are how edit_memory names what to change, and they are only "
    "valid for the page as this call showed it."
)
_EDITING_GUIDANCE = (
    "`open_memory(slugs)` opens Memory pages whole, with each block labelled. "
    "Open a page before you decide what belongs in it, and always before you "
    "edit it: an edit names the blocks this shows."
)


def tool(options: Options = Options()) -> Tool:
    editing = options.scope == "maintenance"
    return Tool(
        name=NAME,
        arguments=Arguments,
        description=_EDITING_DESCRIPTION if editing else (
            "Open Memory pages by slug, several at once. Returns each page in "
            "full — with the documents it rests on, which of them the reader "
            "finished, and the figures it keeps — then the opening lines of every "
            "page one link away from them. Choose by what the question means: a "
            "document's source page is its research digest, so opening it is how "
            "to read what a document says."
        ),
        guidance=_EDITING_GUIDANCE if editing else (
            "`open_memory(slugs)` opens Memory pages in full, several at once, "
            "with the first lines of the pages they link to. Memory is the "
            "reader's own wiki, written from everything they have read and asked "
            "in every project. Each page starts with its `Reader:` line."
            + (_GIVEN if options.scope == "document" else "")
            + " Open a page before you build an answer on it or state how it "
            "relates to something else."
        ),
        budget=BudgetClass.MEMORY,
        label="Opening the pages that matter",
        trace=TraceProjection(),
        run=_run_for_editing if editing else _run,
        needs=("storage", "draft") if editing else ("storage",),
    )


async def _run(args: Arguments, ctx: ToolContext) -> ToolResult:
    text, opened, shown = await ctx.in_thread(
        open_chosen_memory, args.slugs, ctx.storage, ctx.username, ctx.settings
    )
    return ToolResult(text, pages=list(opened or shown))


async def _run_for_editing(args: Arguments, ctx: ToolContext) -> ToolResult:
    text, records = await ctx.in_thread(
        open_memory_for_editing, args.slugs, ctx.storage, ctx.username, ctx.settings
    )
    for record in records:
        ctx.draft.show(
            ShownPage(
                slug=record["slug"],
                kind=record.get("kind") or "",
                revision=record.get("revision") or 0,
                title=record.get("title") or record["slug"],
                domain=record.get("domain") or "",
                summary=record.get("summary") or "",
                body=record.get("body") or "",
                aliases=tuple(record.get("aliases") or ()),
                citations=tuple(dict(citation) for citation in record.get("citations") or ()),
                figures=tuple(dict(figure) for figure in record.get("figures") or ()),
            )
        )
    staged = [record["slug"] for record in records if ctx.draft.staged_page(record["slug"])]
    if staged:
        text += (
            "\n\nAn edit is already staged for " + ", ".join(staged) + ". What is shown is the page as "
            "stored, which is what another edit_memory call addresses and would replace that edit on."
        )
    return ToolResult(text, pages=[record["slug"] for record in records])
