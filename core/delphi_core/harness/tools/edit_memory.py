"""Stage an edit to a concept page, as operations on the blocks it was shown with."""

from pydantic import Field

from ...memory_maintenance.admit import stage_edit
from ..page_arguments import Calculation, Citation, Operation, stored
from ..tool import BudgetClass, Tool, ToolArguments, ToolContext, ToolResult, TraceProjection

NAME = "edit_memory"


class Arguments(ToolArguments):
    slug: str = Field(description="The page to edit. It must have been opened with open_memory in this run.")
    operations: list[Operation] = Field(
        description=(
            "Every operation addresses the page as open_memory showed it, never the result of "
            "another operation, and no two may change the same block."
        )
    )
    citations: list[Citation] = Field(description="The new evidence the new text cites, each defined once.")
    calculations: list[Calculation] = Field(description="Numbers you derived, or an empty list.")
    summary: str = Field(description="A new summary for the page, or an empty string to keep the one it has.")
    aliases: list[str] = Field(description="Other names for the idea to add to the page's aliases, or an empty list.")
    note: str = Field(description="One line on what this edit does to the page, for the page's history.")


def tool() -> Tool:
    return Tool(
        name=NAME,
        arguments=Arguments,
        description=(
            "Edit a concept page in Memory by naming the blocks to change, as open_memory "
            "labelled them. A block no operation names is kept exactly as it is. The edit is "
            "checked and staged, not stored: the result says it is staged, or says what to fix. "
            "Text in the new Markdown cites a citation the page has as [E3] and new evidence as "
            "[N1], defined in `citations`. A second call for the same page replaces the first, "
            "and addresses the same blocks."
        ),
        guidance=(
            "`edit_memory(slug, operations, …)` changes a concept page you have opened, block by "
            "block. Add what the evidence supports where it belongs; replace or delete only what "
            "the evidence supersedes, contradicts or repeats, and say which. If the result names "
            "problems, fix them and call again."
        ),
        budget=BudgetClass.WRITE,
        label="Editing a Memory page",
        trace=TraceProjection(keep=(("slug", "slug"), ("note", "note"))),
        run=_run,
        needs=("draft", "memory_pages"),
        writes=True,
    )


async def _run(args: Arguments, ctx: ToolContext) -> ToolResult:
    pages = await ctx.in_thread(ctx.memory_pages)
    return ToolResult(
        stage_edit(
            ctx.draft,
            pages,
            slug=args.slug,
            operations=[operation.stored() for operation in args.operations],
            citations=stored(args.citations),
            calculations=stored(args.calculations),
            summary=args.summary,
            aliases=args.aliases,
            note=args.note,
        )
    )
