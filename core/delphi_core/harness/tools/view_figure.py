"""Show the model one figure, as an image: one a Memory page keeps, or one a source read this turn listed."""

from pydantic import Field

from ...memory_harness import image_block, memory_figure_block
from ..tool import BudgetClass, Tool, ToolArguments, ToolContext, ToolResult, TraceProjection

NAME = "view_figure"


class Arguments(ToolArguments):
    figure_id: str = Field(description="The id printed beside a figure by open_memory or read_url.")


def tool() -> Tool:
    return Tool(
        name=NAME,
        arguments=Arguments,
        description=(
            "Attach one figure as an image so you can actually look at it: a stored "
            "Memory figure, or one read_url listed this turn. Expensive relative to "
            "text, and bounded per answer: use it when the picture is the evidence, "
            "not to confirm a caption you already have."
        ),
        guidance=(
            "`view_figure(figure_id)` shows a figure a Memory page or a source read "
            "lists. Use it when the picture is the evidence, or when a figure "
            "the reader has already seen would show what you are about to describe."
        ),
        budget=BudgetClass.FIGURE,
        label="Looking at a figure",
        trace=TraceProjection(keep=(("figure_id", "figureId"),)),
        run=_run,
        needs=("storage", "objects"),
    )


async def _run(args: Arguments, ctx: ToolContext) -> ToolResult:
    source = ctx.figures.get(args.figure_id)
    if source is None and not ctx.settings.memory_enabled:
        return ToolResult(f"Error: no figure with id {args.figure_id!r} in this turn. Use an id a source read listed.")
    if source is None:
        text, image = await ctx.in_thread(
            memory_figure_block, args.figure_id, ctx.storage, ctx.objects, ctx.username
        )
        return ToolResult(text, image=image)
    try:
        payload, note = await ctx.figures.image(source, ctx.settings)
    except ValueError as reason:
        return ToolResult(str(reason))
    return ToolResult(
        f"Figure {source.id} ({source.credit}) is attached below. Caption: {source.caption}{note}",
        image=image_block(payload),
    )
