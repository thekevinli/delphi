"""Walk the links around one Memory page, one or two hops out."""

from dataclasses import dataclass
from functools import partial
from typing import Literal

from pydantic import Field

from ...memory_harness import memory_links
from ..tool import BudgetClass, Tool, ToolArguments, ToolContext, ToolResult, TraceProjection

NAME = "memory_links"


@dataclass(frozen=True)
class Options:
    #: A chat walks through a domain page, whose text says how its pages
    #: relate. Maintenance keeps the walk's rule (`MemoryGraphIndex.walk`):
    #: two hops through a domain page is the whole domain.
    through_domains: bool = False


class Arguments(ToolArguments):
    slug: str = Field(description="The page to start from: the last segment of its path.")
    hops: Literal[1, 2] = Field(
        description="1 for the page's own links, 2 to include what they lead to."
    )


def tool(options: Options = Options()) -> Tool:
    return Tool(
        name=NAME,
        arguments=Arguments,
        description=(
            "Walk the links around one Memory page. One hop lists the pages it "
            "links to and the pages that link to it. Two hops adds what those lead "
            "to, which is how to find related documents: a document's source page "
            "links to its concepts, and they link to the other documents "
            "that share them."
        ),
        guidance=(
            "`memory_links(slug)` shows what a page links to and what links to "
            "it, two steps out. Use it to find what an idea builds on, or what "
            "builds on it, when the pages you have do not say."
        ),
        budget=BudgetClass.MEMORY,
        label="Following links between your notes",
        trace=TraceProjection(keep=(("slug", "slug"), ("hops", "hops"))),
        run=partial(_run, options),
        needs=("storage",),
    )


async def _run(options: Options, args: Arguments, ctx: ToolContext) -> ToolResult:
    text, shown = await ctx.in_thread(
        partial(memory_links, through_domains=options.through_domains),
        args.slug, args.hops, ctx.storage, ctx.username, ctx.settings,
    )
    return ToolResult(text, pages=list(shown))
