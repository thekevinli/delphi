"""Approve an inspected revision for server-owned inline delivery."""

from pydantic import Field

from ..tool import BudgetClass, Tool, ToolArguments, ToolContext, ToolResult, TraceProjection

NAME = "publish_artifact"


class Arguments(ToolArguments):
    artifact_id: str = Field(min_length=1, max_length=80, description="The id draw_display or embed_figure returned.")
    revision: int = Field(ge=1, le=3, description="The latest rendered revision you inspected.")
    review: str = Field(min_length=1, max_length=2000, description="What the screenshots of every state show: readable labels, connections, layout, and steps that each show their change. Name any remaining limitation.")


def tool() -> Tool:
    return Tool(
        name=NAME, arguments=Arguments, budget=BudgetClass.ARTIFACT_PUBLISH,
        label="Publishing a checked visualization", needs=("artifacts",),
        description="Publish a passing rendered draft after inspecting its screenshot in a previous model round. Returns an exact reference for the final answer; the server inserts the inspected source. Stale, failed and same-round drafts are refused.",
        guidance="`publish_artifact` approves only a passing revision whose rendered pixels you have inspected. Use its returned reference on its own line beside the explanation; never write the visual yourself or call it in the same batch as drawing.",
        trace=TraceProjection(keep=(("artifact_id", "artifactId"), ("revision", "revision"))),
        run=_run,
    )


async def _run(args: Arguments, ctx: ToolContext) -> ToolResult:
    return ToolResult(ctx.artifacts.publish(args.artifact_id, args.revision, args.review))
