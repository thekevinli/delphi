"""Installing a renderer does not spend extra model rounds on ordinary chat."""

import copy
import json

import pytest

from delphi_core.artifacts.session import ArtifactSession
from delphi_core.artifacts.types import RenderReport
from delphi_core.config import Settings
from delphi_core.harness.budget import TurnBudget
from delphi_core.harness.loop import DRAW_ROUND_NOTE, LAST_ROUND_NOTE, run_turn
from delphi_core.harness.provider import ProviderResult, Terminal, Usage
from delphi_core.harness.registry import DEFAULTS, Toolset
from delphi_core.harness.tool import BudgetClass, Tool, ToolArguments, ToolContext, ToolResult, TraceProjection


IMAGE = {"type": "input_image", "image_url": "data:image/png;base64,cGl4ZWxz", "detail": "high"}
SPEC = json.dumps({"display": 1, "title": "Flow", "figures": [{"kind": "flow", "lanes": [{"label": "Path", "rows": [{"items": [{"type": "node", "label": "A"}, {"type": "node", "label": "B"}]}]}]}]})
RENDER_ARGS = {"need": "how A leads to B", "spec": SPEC, "artifact_id": ""}


class NoArguments(ToolArguments):
    pass


async def read(_args, _context):
    return ToolResult("A short source passage.")


READ = Tool(name="read", arguments=NoArguments, description="Read a source.", guidance="Read when needed.",
            budget=BudgetClass.DOCUMENT, label="Reading", trace=TraceProjection(), run=read)


def call(name, arguments=None):
    return {"type": "function_call", "name": name, "arguments": json.dumps(arguments or {}), "call_id": name}


class Provider:
    def __init__(self, response, output_tokens=0):
        self.response = response
        self.output_tokens = output_tokens
        self.requests = []

    async def stream(self, request):
        self.requests.append(copy.deepcopy(request))
        yield {"type": "item_done", "item": self.response(len(self.requests), request)}
        yield {"type": "terminal", "result": ProviderResult(Terminal.COMPLETED, usage=Usage(output_tokens=self.output_tokens))}


async def run(provider, *, images=False, enabled=True, tools=None, output_tokens=0):
    config = Settings(artifact_renderer_path="/test/renderer" if enabled else "", model_tool_max_rounds=3,
                      document_tool_max_calls=100, turn_max_output_tokens=output_tokens)
    rendered = []

    async def renderer(_settings, _title, source, _checks):
        rendered.append(source)
        return RenderReport(True, image=IMAGE)

    session = ArtifactSession(config, renderer)
    spending = TurnBudget.for_chat(config)
    tools = Toolset([READ, DEFAULTS["draw_display"], DEFAULTS["publish_artifact"]] if tools is None else tools)
    request = {"input": [{"role": "user", "content": [{"type": "input_text", "text": "Explain."}, IMAGE] if images else "Explain."}],
               "tools": tools.specs()}
    events = [event async for event in run_turn(provider, request, tools, spending, ToolContext(config, artifacts=session))]
    assert events[-1]["result"].terminal is Terminal.COMPLETED
    assert provider.requests[-1]["tool_choice"] == "none"
    assert provider.requests[-1]["input"][-1] == {"role": "user", "content": LAST_ROUND_NOTE}
    assert all(request["tools"] == provider.requests[0]["tools"] for request in provider.requests)
    return spending, session, rendered


@pytest.mark.asyncio
@pytest.mark.parametrize("images", [False, True])
@pytest.mark.parametrize("enabled", [False, True])
async def test_nonartifact_turns_keep_their_original_limit_with_or_without_a_renderer(images, enabled):
    provider = Provider(lambda *_: call("read"))
    spending, session, rendered = await run(provider, images=images, enabled=enabled)
    ordinary_limit = 1 if images else spending.rounds
    assert len(provider.requests) == ordinary_limit + 1
    assert spending.document_calls_made == ordinary_limit
    assert not session.attempted and not rendered


@pytest.mark.asyncio
@pytest.mark.parametrize("images", [False, True])
@pytest.mark.parametrize("invalid_schema", [False, True])
async def test_an_actual_render_attempt_at_the_ordinary_limit_gets_one_fixed_extension(images, invalid_schema):
    ordinary_limit = 1 if images else 3
    arguments = {} if invalid_schema else RENDER_ARGS
    provider = Provider(lambda round_, _: call("draw_display", arguments)
                        if round_ in (ordinary_limit, ordinary_limit + 1) else call("read"))
    spending, session, rendered = await run(provider, images=images)
    artifact_limit = spending.rounds + spending.artifact_render_calls + spending.artifact_publish_calls
    assert len(provider.requests) == artifact_limit + 1
    # Arguments the tool cannot use give their call back, like a refused spec, and still open the extension.
    assert (spending.artifact_renders_made, spending.artifact_refusals) == ((0, 2) if invalid_schema else (2, 0)) and session.attempted
    assert len(rendered) == (0 if invalid_schema else 2)
    assert all(request.get("tool_choice") != "none" for request in provider.requests[:-1])


@pytest.mark.asyncio
async def test_a_display_the_schema_refuses_on_the_last_ordinary_round_still_gets_its_repair_round():
    # The refusal gives the call back, so no render is counted; the refusal itself must still open the extension.
    refused = {"need": "how data flows", "spec": '{"display":1,"title":"Flow","figures":[]}', "artifact_id": ""}
    provider = Provider(lambda round_, _: call("draw_display", refused) if round_ == 1 else call("read"))
    spending, session, rendered = await run(provider, images=True, tools=[READ, DEFAULTS["draw_display"], DEFAULTS["publish_artifact"]])
    assert spending.artifact_refusals == 1 and spending.artifact_renders_made == 0
    assert session.attempted and not rendered
    assert len(provider.requests) == spending.rounds + spending.artifact_render_calls + spending.artifact_publish_calls + 1


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["unoffered_render", "publish_only", "disabled_renderer"])
async def test_no_extension_without_an_enabled_dispatched_render(kind):
    name = "publish_artifact" if kind == "publish_only" else "draw_display"
    tools = [READ, DEFAULTS["publish_artifact"]] if kind == "unoffered_render" else None
    provider = Provider(lambda *_: call(name))
    spending, _session, rendered = await run(provider, images=True, enabled=kind != "disabled_renderer", tools=tools)
    assert len(provider.requests) == 2
    assert spending.artifact_renders_made == (1 if kind == "disabled_renderer" else 0)
    assert not rendered


@pytest.mark.asyncio
async def test_a_closing_round_render_cannot_reopen_an_image_turn():
    provider = Provider(lambda round_, _: call("read") if round_ == 1 else call("draw_display", RENDER_ARGS))
    spending, session, rendered = await run(provider, images=True)
    assert len(provider.requests) == 2
    assert spending.artifact_renders_made == 0 and not session.attempted and not rendered


@pytest.mark.asyncio
async def test_an_artifact_attempt_cannot_override_the_output_token_ceiling():
    provider = Provider(lambda *_: call("draw_display", RENDER_ARGS), output_tokens=10)
    spending, session, rendered = await run(provider, images=True, output_tokens=10)
    assert len(provider.requests) == 2
    assert spending.artifact_renders_made == 1 and session.attempted and len(rendered) == 1


@pytest.mark.asyncio
async def test_a_draft_rendered_alongside_a_read_must_be_rendered_again_before_publishing():
    class Batch(Provider):
        async def stream(self, request):
            self.requests.append(copy.deepcopy(request))
            for item in self.response(len(self.requests), request):
                yield {"type": "item_done", "item": item}
            yield {"type": "terminal", "result": ProviderResult(Terminal.COMPLETED)}

    def respond(round_, request):
        artifact = next(iter(session.drafts), "")
        if round_ == 1:
            return [call("draw_display", RENDER_ARGS), call("read")]
        if round_ == 2:
            return [call("publish_artifact", {"artifact_id": artifact, "revision": 1, "review": "Looked."})]
        if round_ == 3:
            return [call("draw_display", {**RENDER_ARGS, "artifact_id": artifact})]
        return [call("publish_artifact", {"artifact_id": artifact, "revision": 1, "review": "Checked against the passage."})]

    config = Settings(artifact_renderer_path="/test/renderer", model_tool_max_rounds=5, document_tool_max_calls=100)

    async def renderer(*_):
        return RenderReport(True, image=IMAGE)

    session = ArtifactSession(config, renderer)
    provider = Batch(respond)
    tools = Toolset([READ, DEFAULTS["draw_display"], DEFAULTS["publish_artifact"]])
    request = {"input": [{"role": "user", "content": "Explain."}], "tools": tools.specs()}
    [event async for event in run_turn(provider, request, tools, TurnBudget.for_chat(config), ToolContext(config, artifacts=session))]
    outputs = [row["output"] for row in provider.requests[-1]["input"] if row.get("type") == "function_call_output" and row["call_id"] == "publish_artifact"]
    assert "source was read" in outputs[0] and outputs[1].startswith("Published")


def _notes(request):
    return [row.get("content") for row in request["input"] if row.get("role") == "user" and row.get("content") == DRAW_ROUND_NOTE]


@pytest.mark.asyncio
async def test_a_turn_that_only_reads_is_told_before_its_last_round_that_drawing_needs_that_round():
    # A probe spent every round reading and could no longer draw what the question asked for.
    provider = Provider(lambda round_, request: call("draw_display", RENDER_ARGS) if _notes(request) and round_ == 3 else call("read"))
    spending, session, rendered = await run(provider)
    # Said once, before the last round that may call a tool, and that round's draft earns its extension.
    assert [len(_notes(request)) for request in provider.requests[:4]] == [0, 0, 1, 1]
    assert session.attempted and len(rendered) == 1
    assert len(provider.requests) == spending.rounds + spending.artifact_render_calls + spending.artifact_publish_calls + 1


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["drew_early", "image_turn", "no_visuals"])
async def test_no_drawing_note_once_a_visual_was_tried_on_an_image_turn_or_without_visual_tools(kind):
    first = call("draw_display", RENDER_ARGS) if kind == "drew_early" else call("read")
    provider = Provider(lambda round_, _: first if round_ == 1 else call("read"))
    await run(provider, images=kind == "image_turn", tools=[READ] if kind == "no_visuals" else None)
    assert not any(_notes(request) for request in provider.requests)
