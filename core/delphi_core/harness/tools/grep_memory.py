"""Find exact wording across Memory pages without opening them."""

from pydantic import Field

from ...memory_harness import grep_memory
from ..tool import BudgetClass, Tool, ToolArguments, ToolContext, ToolResult, TraceProjection

NAME = "grep_memory"


class Arguments(ToolArguments):
    pattern: str = Field(
        max_length=300,
        description="A case-insensitive regular expression, e.g. 'kv.?cache|key-value cache'.",
    )
    glob: str = Field(
        description=(
            "Restrict to paths matching this glob over "
            "domain/kind/slug, or an empty string for all of Memory."
        )
    )


def tool() -> Tool:
    # With `open_memory`, how every scope reaches Memory. None of them ranks:
    # the pages that matter are chosen by a model that read the index, and
    # these let it *look* from there — find an exact wording, follow the links.
    # A page's path is `domain/kind/slug`, and its slug is what `open_memory` takes.
    return Tool(
        name=NAME,
        arguments=Arguments,
        description=(
            "Find exact wording across Memory pages without opening them. Returns "
            "the matching lines, grouped by page, most matches first. Use it to "
            "locate where a term, method, number or name is written; then call "
            "open_memory on the page worth citing. The match is literal, not "
            "semantic, so put the variants a writer might have used into one "
            "pattern rather than calling again."
        ),
        guidance=(
            "`grep_memory(pattern)` finds where an exact term, method name or "
            "number is written anywhere in Memory. It matches text, not meaning."
        ),
        budget=BudgetClass.MEMORY,
        label="Searching your notes for the wording",
        trace=TraceProjection(keep=(("pattern", "pattern"), ("glob", "within"))),
        run=_run,
        needs=("storage",),
    )


async def _run(args: Arguments, ctx: ToolContext) -> ToolResult:
    text, shown = await ctx.in_thread(
        grep_memory, args.pattern, args.glob, ctx.storage, ctx.username, ctx.settings
    )
    return ToolResult(text, pages=list(shown))
