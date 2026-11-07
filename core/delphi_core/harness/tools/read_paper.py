"""Read exact pages of a stored PDF. It reads only what the turn was handed."""

from typing import Annotated

from pydantic import Field

from ...document_reads import document_result, read_paper, resolve_account_paper
from ..tool import BudgetClass, Tool, ToolArguments, ToolContext, ToolResult, TraceProjection

NAME = "read_paper"
#: How many per-call caps one page may run to: the longest page in a reader's library was 8,338 characters.
_SINGLE_PAGE_CAPS = 4


class Arguments(ToolArguments):
    paper_id: str = Field(description="The paper_id printed on its research digest card.")
    pages: list[Annotated[int, Field(ge=1)]] = Field(min_length=1, max_length=4)


def tool() -> Tool:
    return Tool(
        name=NAME,
        arguments=Arguments,
        description=(
            "Read one to four exact pages from a project PDF's authoritative "
            "page-marked text. Use this before precise numerical, causal, equation-level, "
            "or close cross-paper claims."
        ),
        guidance=(
            "A PDF in the library that is not attached is here only as its "
            "digest. `read_paper(paper_id, pages)` returns its exact pages."
        ),
        budget=BudgetClass.DOCUMENT,
        label="Reading exact paper pages",
        trace=TraceProjection(keep=(("paper_id", "paperId"), ("pages", "pages"))),
        run=_run,
        needs=("objects",),
    )


async def _run(args: Arguments, ctx: ToolContext) -> ToolResult:
    # Without a project — the account-wide chat — the paper has to be located
    # before it can be read. `search_library` reaches every project there, so
    # a hit the model could not then open would break the ladder at its last rung.
    project_id, documents = (
        (ctx.project_id, ctx.paper_documents)
        if ctx.project_id
        else await ctx.in_thread(resolve_account_paper, ctx.storage, ctx.username, args.paper_id)
    )
    # The per-call cap keeps a request for several pages small. "Ask for
    # fewer pages" cannot reach the end of one page longer than the cap, so a
    # single page may run to a few times it, within the budget left.
    cap = ctx.settings.paper_tool_max_chars * (_SINGLE_PAGE_CAPS if len(set(args.pages)) == 1 else 1)
    text = await ctx.in_thread(
        read_paper, args.paper_id, args.pages, ctx.objects, ctx.username, project_id, documents,
        ctx.settings.paper_tool_max_pages, min(cap, ctx.document_chars_left),
    )
    return ToolResult(text, document=document_result(documents.get(args.paper_id), args.paper_id))
