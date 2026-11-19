"""Draft a card that shows a source's own figure, for the same inspection and publication as a diagram."""

import re

from pydantic import Field

from ...artifacts.figure_card import card_image, figure_card
from ...memory_harness import memory_figure
from ..tool import BudgetClass, Tool, ToolArguments, ToolContext, ToolResult, TraceProjection

NAME = "embed_figure"


class Arguments(ToolArguments):
    figure_id: str = Field(min_length=1, max_length=80, description="An id read_url or open_memory listed beside the figure.")
    title: str = Field(min_length=1, max_length=160, description="Short plain-text card title, e.g. 'Figure 2 · Correction training'.")
    artifact_id: str = Field(default="", max_length=80, description="Empty for a new card; the returned id to retitle that card or, unchanged, check it again.")


def tool() -> Tool:
    return Tool(
        name=NAME, arguments=Arguments, budget=BudgetClass.ARTIFACT_RENDER,
        label="Placing the source's figure", needs=("artifacts",),
        description="Draft an inline card showing a source's own figure with its caption and source line, from an id read_url or open_memory listed. Returns the same render result as draw_display; inspect it and publish with publish_artifact in a later round. Counts as one of the answer's two visualizations.",
        guidance="When the reader asks to see a source's own figure, `embed_figure(figure_id, title)` drafts a card of it. Check in the screenshot that the image matches its caption, then publish it like any artifact.",
        trace=TraceProjection(keep=(("figure_id", "figureId"), ("title", "title"), ("artifact_id", "artifactId"))),
        run=_run,
    )


async def _run(args: Arguments, ctx: ToolContext) -> ToolResult:
    source, note = ctx.figures.get(args.figure_id), ""
    redraw = " or draw the idea with draw_display" if "draw_display" in ctx.offered else ""
    try:
        if source is not None:
            payload, note = await ctx.figures.image(source, ctx.settings)
            caption, credit = source.caption, f"{source.credit} ({source.url})"
        elif ctx.settings.memory_enabled and ctx.storage is not None and ctx.objects is not None:
            record, payload = await ctx.in_thread(memory_figure, args.figure_id, ctx.storage, ctx.objects, ctx.username)
            if record.get("mimeType", "image/webp") != "image/webp":
                return ToolResult(f"Error: figure {args.figure_id} is a drawing kept as markup and cannot be embedded. Describe it{redraw}.")
            caption, credit = record.get("caption") or "", "your Memory"
        else:
            return ToolResult(f"Error: no figure with id {args.figure_id!r} in this turn. Use an id a source read listed.")
    except ValueError as reason:
        return ToolResult(str(reason) if str(reason).startswith("Error:") else f"Error: {reason}")
    image = await ctx.in_thread(card_image, payload)
    if image is None:
        return ToolResult(f"Error: figure {args.figure_id} is too detailed to embed. Describe it{redraw}.")
    title = " ".join(re.sub(r"[`\x00-\x1f]", " ", args.title).split())
    text, screenshot = await ctx.artifacts.render(title, figure_card(image, caption, credit), args.artifact_id, [])
    return ToolResult(text + note, image=screenshot)
