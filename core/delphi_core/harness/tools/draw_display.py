"""Draft a display from Delphi's library: a JSON spec the reader draws, checked like any diagram."""

from pydantic import Field

from ..tool import BudgetClass, Tool, ToolArguments, ToolContext, ToolResult, TraceProjection

NAME = "draw_display"


class Arguments(ToolArguments):
    # First, so the model names the need before it writes the figure.
    need: str = Field(min_length=3, max_length=400, description="What the reader needs to see, in one line (e.g. 'how a read moves through app, cache and database, and what a miss adds'), and which figure shows it.")
    spec: str = Field(min_length=2, max_length=128_000, description='The display as JSON text, starting {"display":1,"title":...}: figures, and optionally steps, a control and variants.')
    artifact_id: str = Field(max_length=80, description="Empty for a new display; the returned id when repairing one.")


def tool() -> Tool:
    return Tool(
        name=NAME, arguments=Arguments, budget=BudgetClass.ARTIFACT_RENDER,
        label="Drawing a visualization", needs=("artifacts",),
        description="Draft an inline display from Delphi's library from a JSON spec. A spec that breaks the schema comes back with every reason, spends none of the draft's attempts and, the first few times a turn, none of the turn's visualization calls; a valid one is rendered at chat widths, stepped through every state, and returned with diagnostics and a screenshot. Publish the passing revision with publish_artifact in a later round. Shares the answer's two visualizations and three attempts each.",
        guidance="`draw_display` drafts a display from the library (flows, charts, matrices, grids, timelines, stand-in images) from a JSON spec; inspect its screenshot, then publish it with `publish_artifact` in a later round.",
        trace=TraceProjection(keep=(("artifact_id", "artifactId"),)),
        run=_run,
    )


async def _run(args: Arguments, ctx: ToolContext) -> ToolResult:
    text, image, refused = await ctx.artifacts.draw(args.spec, args.artifact_id, args.need)
    return ToolResult(text, image=image, refused=refused)
