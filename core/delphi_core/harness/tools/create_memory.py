"""Stage a new concept page, once no page that exists already explains its idea."""

from pydantic import Field

from ...memory_maintenance.admit import create_gate, stage_create
from ..page_arguments import Calculation, Citation, stored
from ..tool import BudgetClass, Tool, ToolArguments, ToolContext, ToolResult, TraceProjection

NAME = "create_memory"


class Arguments(ToolArguments):
    title: str = Field(description="The idea's name, as a reader would look it up.")
    aliases: list[str] = Field(description="Other names for the same idea, such as an abbreviation, or an empty list.")
    domain: str = Field(description="The domain the page belongs to, as page paths spell it.")
    summary: str = Field(description="A sentence or two on what the page explains.")
    body: str = Field(
        description="The page in Markdown. Evidence is cited as [N1], [N2], …, each defined in `citations`."
    )
    citations: list[Citation] = Field(description="The evidence the body cites, each defined once.")
    calculations: list[Calculation] = Field(description="Numbers you derived, or an empty list.")
    note: str = Field(description="One line on why this page is being created, for the page's history.")
    distinctFrom: list[str] = Field(
        description=(
            "Empty on a first call. If a call was refused because pages may already explain "
            "this idea and it is a different one, the slugs of every page that refusal named."
        )
    )
    distinctReason: str = Field(
        description="With `distinctFrom`: one sentence on how this idea differs from those pages. Otherwise empty."
    )


def tool() -> Tool:
    return Tool(
        name=NAME,
        arguments=Arguments,
        description=(
            "Create a concept page in Memory for an idea no page explains yet. The call is "
            "refused if a page already has the title or an alias, and if existing pages may "
            "explain the same idea it names them: open those and edit one, or call again with "
            "`distinctFrom` and `distinctReason`. The page is checked and staged, not stored: "
            "the result says it is staged, or says what to fix. A second call with the same "
            "title replaces the first."
        ),
        guidance=(
            "`create_memory(title, …)` writes a new concept page, and only for an idea no page "
            "explains: look first with `grep_memory` and `memory_links`, and put what belongs "
            "in an existing page into that page with `edit_memory`. If it names pages that may "
            "explain the idea, open them before deciding."
        ),
        budget=BudgetClass.WRITE,
        label="Writing a new Memory page",
        trace=TraceProjection(keep=(("title", "title"), ("note", "note"))),
        run=_run,
        needs=("draft", "memory_pages", "same_idea"),
        writes=True,
    )


async def _run(args: Arguments, ctx: ToolContext) -> ToolResult:
    draft = ctx.draft
    pages = await ctx.in_thread(ctx.memory_pages)
    # The cheap refusals come before the model is asked anything.
    slug, refusal = create_gate(draft, pages, title=args.title, aliases=args.aliases)
    if refusal:
        return ToolResult(refusal)
    if slug not in draft.same_idea:
        draft.same_idea[slug] = tuple(await ctx.same_idea(args.title, args.aliases, args.summary))
    return ToolResult(
        stage_create(
            draft,
            pages,
            title=args.title,
            aliases=args.aliases,
            domain=args.domain,
            summary=args.summary,
            body=args.body,
            citations=stored(args.citations),
            calculations=stored(args.calculations),
            note=args.note,
            same_idea=draft.same_idea[slug],
            distinct_from=args.distinctFrom,
            distinct_reason=args.distinctReason,
        )
    )
