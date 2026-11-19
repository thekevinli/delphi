"""The display library's contract: what a spec may say, every state it reaches, and what a refusal costs."""

import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from delphi_core.artifacts import display
from delphi_core.artifacts.instructions import DISPLAYS, visual_instructions
from delphi_core.artifacts.session import ArtifactSession
from delphi_core.artifacts.types import RenderReport
from delphi_core.config import Settings
from delphi_core.harness.budget import TurnBudget
from delphi_core.harness.loop import run_turn
from delphi_core.harness.profiles import CHAT_DOCUMENT, CHAT_GENERAL, Turn
from delphi_core.harness.prompts import compose_instructions
from delphi_core.harness.provider import ProviderResult, Terminal
from delphi_core.harness.registry import DEFAULTS, Toolset
from delphi_core.harness.tool import ToolContext

DISPLAYS_DIR = Path(__file__).resolve().parent / "data" / "displays"
EXAMPLES = sorted(path.stem for path in DISPLAYS_DIR.glob("*.json"))
IMAGE = {"type": "input_image", "image_url": "data:image/png;base64,cGl4ZWxz", "detail": "high"}


def example(name: str) -> dict:
    return json.loads((DISPLAYS_DIR / f"{name}.json").read_text())


def reasons(spec) -> list[str]:
    with pytest.raises(display.DisplayError) as refused:
        display.validate(spec)
    return refused.value.reasons


def test_the_mood_board_examples_are_valid_displays():
    assert EXAMPLES == ["correction", "handbook", "isoflop", "moe", "omni"]
    for name in EXAMPLES:
        raw, source = display.validate((DISPLAYS_DIR / f"{name}.json").read_text())
        # The canonical source opens with its version, which is how the reader knows it from HTML.
        assert source.startswith('{"display":1,') and display.is_display(source)
        assert json.loads(source) == raw


def test_every_step_under_every_option_is_reached():
    reached = display.states(example("correction"))
    assert [(option, step) for option, step, _ in reached] == [(option, step) for option in ("k0", "k2") for step in range(7)]
    figures = {(option, step): drawn for option, step, drawn in reached}
    sampling = lambda option, step: figures[(option, step)][0]["lanes"][1]
    corrector = lambda option, step: sampling(option, step)["rows"][0]["items"][3]
    # Steps accumulate; a control's own patch holds from the first step on.
    assert sampling("k2", 0)["faded"] is True and sampling("k2", 2)["faded"] is False
    assert corrector("k0", 3)["repeat"] == {"count": "×0", "off": True}
    assert corrector("k2", 3)["repeat"] == {"count": "×2", "run": True}
    assert corrector("k2", 4)["repeat"] == {"count": "×2"}
    assert figures[("k2", 6)][1]["hidden"] is False and figures[("k2", 5)][1]["hidden"] is True


def test_the_instructions_example_is_a_valid_display_far_from_every_benchmark():
    spec = DISPLAYS.split("Example, three steps of a cache lookup:")[1].split("The result shows")[0].strip()
    raw, _ = display.validate(spec)
    assert [step["set"] for step in raw["steps"]] == [
        {"app": {"glow": True}},
        {"cache": {"glow": True}, "db": {"glow": True}, "app": {"glow": False}},
        {"cache": {"note": "now holds k", "glow": True}, "db": {"glow": False}},
    ]
    # The prompt teaches the grammar, never one of the cases it is tuned against.
    assert not any(word in DISPLAYS.lower() for word in ("denois", "corrector", "thinker", "talker", "isoflop", "expert"))


@pytest.mark.parametrize("change, expected", [
    (lambda s: s["figures"][0]["lanes"][0]["rows"][0]["items"][1].update(colour="red"), "items.1.colour: Extra inputs are not permitted"),
    (lambda s: s["steps"][2]["set"].update(zz={"on": True}), "steps.2.set changes 'zz', but no part has that id"),
    (lambda s: s["steps"][1].update(set={}), "step 2 with k0 changes nothing in the figures"),
    (lambda s: s["steps"][0].update(note="costs $5 a run"), "steps.0.note: an unmatched $"),
    (lambda s: s["steps"][3]["set"].update(x0={"blur": 20}), "after the patches of step 4 with k0, figures.0.lanes.1.rows.0.items.2.blur"),
    (lambda s: s["control"].update(default="k9"), "control.default 'k9' is not one of the options"),
    (lambda s: s["steps"][3]["note"].pop("k0"), "steps.3.note must give every option"),
    (lambda s: s["steps"][3]["variants"].update(k5={"den": {"glow": False}}), "steps.3.variants names ['k5']"),
    (lambda s: s["figures"][0]["lanes"][1]["rows"][0]["items"][1].update(id="zt"), "id 'zt' is used 2 times"),
    (lambda s: s["figures"][0].update(kind="table"), "does not match any of the expected tags"),
    # The reader reads raw JSON: a string is not a bool or a number there.
    (lambda s: s["figures"][1].update(hidden="false"), "figures.1.hidden: Input should be a valid boolean"),
    (lambda s: s["steps"][2]["set"].update(samp={"id": "other"}), "steps.2.set.samp changes ['id'], which a step cannot change"),
    # Setting a field to what it already reads as draws nothing new.
    (lambda s: s["steps"][1].update(set={"den": {"glow": False}}), "step 2 with k0 changes nothing in the figures"),
    (lambda s: s["control"]["options"][1].update(label="K = 0"), "control.options repeat a label"),
])
def test_a_broken_spec_names_its_fault(change, expected):
    spec = example("correction")
    change(spec)
    assert any(expected in reason for reason in reasons(spec)), reasons(spec)


def test_a_broken_patch_is_named_once_at_the_first_state_it_breaks():
    spec = example("correction")
    spec["steps"][3]["set"]["x0"] = {"blur": 20}
    assert len([reason for reason in reasons(spec) if ".blur" in reason]) == 1


def test_a_control_must_change_the_picture():
    spec = example("moe")
    spec["variants"]["k1"] = spec["variants"]["k2"]
    spec["steps"][1]["variants"]["k1"] = spec["steps"][1]["variants"]["k2"]
    assert any("draw the same thing at every step" in reason for reason in reasons(spec))


@pytest.mark.parametrize("figure, expected", [
    ({"kind": "matrix", "cols": ["a", "b"], "rows": [{"label": "A", "cells": [{"value": "1"}]}]}, "row 'A' has 1 cells for 2 columns"),
    ({"kind": "grid", "columns": 2, "items": [{"type": "node", "label": "One", "col": 1, "row": 1}, {"type": "node", "label": "Two", "col": 1, "row": 1}]}, "both sit at col 1, row 1"),
    ({"kind": "grid", "columns": 2, "items": [{"type": "node", "label": "Wide", "col": 2, "row": 1, "cols": 2}]}, "passes the grid's 2 columns"),
    ({"kind": "chart", "x": {"scale": "log"}, "y": {}, "series": [{"points": [{"x": 0, "y": 1}, {"x": 1, "y": 2}]}]}, "x is a log axis"),
    ({"kind": "chart", "x": {"min": 0, "max": 10, "ticks": [{"at": 12, "label": "12"}]}, "y": {}, "series": [{"points": [{"x": 1, "y": 1}, {"x": 2, "y": 2}]}]}, "tick at 12 lies outside"),
    ({"kind": "timeline", "max": 10, "series": [{"id": "a", "label": "A", "tone": "blue"}], "panels": [{"title": "P", "lanes": [{"label": "L", "bars": [{"series": "b", "start": 1, "end": 2}]}]}]}, "names series 'b'"),
    ({"kind": "timeline", "max": 10, "series": [{"id": "a", "label": "A", "tone": "blue"}], "panels": [{"title": "P", "lanes": [{"label": "L", "bars": [{"series": "a", "start": 4, "end": 12}]}]}]}, "must end after it starts and by max 10"),
    ({"kind": "flow", "lanes": [{"label": "L", "rows": [{"items": [{"type": "tile", "label": "x"}]}]}]}, "a chain flow holds nodes only"),
    ({"kind": "grid", "columns": ["node", "link", "node"], "items": [{"type": "arrow", "dir": "right", "col": 2, "row": 1, "pill": {"type": "node", "label": "P"}}]}, "rides a right arrow in a link lane"),
    ({"kind": "grid", "columns": 2, "items": [{"type": "node", "label": "A", "col": 0, "row": 1}]}, "col: Input should be greater than or equal to 1 (grid places count from 1)"),
    ({"kind": "chart", "x": {}, "y": {}, "series": [{"label": "costs $5", "points": [{"x": 0, "y": 1}, {"x": 1, "y": 2}]}]}, "series.0.label: an unmatched $"),
    ({"kind": "compare", "tiles": [{"type": "tile", "label": "a"}], "text": "$x"}, "figures.0.text: an unmatched $"),
])
def test_figures_are_checked_for_what_they_can_draw(figure, expected):
    assert any(expected in reason for reason in reasons({"display": 1, "title": "T", "figures": [figure]})), reasons({"display": 1, "title": "T", "figures": [figure]})


def test_nulls_are_absent_and_numbers_finite_so_the_reader_parses_what_core_accepts():
    spec = example("moe")
    spec["footnote"], spec["badge"] = None, None
    raw, source = display.validate({**spec, "steps": spec["steps"]})
    assert "null" not in source and "footnote" not in raw
    assert display.validate({"display": 1, "title": "T", "steps": None, "control": None, "figures": [{"kind": "flow", "lanes": [{"label": "L", "rows": [{"items": [{"type": "node", "label": "A"}]}]}]}]})[1] == '{"display":1,"title":"T","figures":[{"kind":"flow","lanes":[{"label":"L","rows":[{"items":[{"type":"node","label":"A"}]}]}]}]}'
    chart = '{"display":1,"title":"T","figures":[{"kind":"chart","x":{},"y":{},"series":[{"points":[{"x":0,"y":NaN},{"x":1,"y":2}]}]}]}'
    assert "numbers must be finite" in reasons(chart)[0]
    assert "numbers must be finite" in reasons(chart.replace("NaN", "1e400"))[0]
    assert "not valid text" in reasons({"display": 1, "title": "\ud800", "figures": []})[0]


def test_a_step_to_zero_or_empty_text_is_a_change_and_a_null_in_a_patch_is_refused():
    chart = {"kind": "chart", "id": "ch", "x": {}, "y": {}, "series": [{"points": [{"x": 0, "y": 1}, {"x": 1, "y": 2}]}]}
    spec = {"display": 1, "title": "T", "figures": [chart], "steps": [{"name": "Auto", "note": "a"}, {"name": "From zero", "note": "b", "set": {"ch": {"y": {"min": 0}}}}]}
    display.validate(spec)
    spec["steps"][1]["set"] = {"ch": {"hidden": None}}
    assert any("steps.1.set.ch.hidden is null; a patch cannot remove a field" in reason for reason in reasons(spec)), reasons(spec)
    spec["steps"][1]["set"] = {"ch": None}
    assert any("steps.1.set.ch is null" in reason for reason in reasons(spec)), reasons(spec)


def test_a_title_must_survive_as_plain_text():
    flow = {"kind": "flow", "lanes": [{"label": "L", "rows": [{"items": [{"type": "node", "label": "A"}]}]}]}
    assert "title: write a short plain-text title" in reasons({"display": 1, "title": "``\n", "figures": [flow]})[0]
    assert display.plain_title("A\nB `c`") == "A B  c"


def test_only_a_json_object_that_opens_with_its_version_is_a_display():
    assert "starts with {\"display\": 1" in reasons("<div>diagram</div>")[0]
    assert reasons('{"display":1, nope}')[0].startswith("not valid JSON")
    assert "first field" in reasons({"display": 2, "title": "T", "figures": []})[0]
    assert not display.is_display('{"title":"T","display":1}')
    # A dollar written as \$ is text, not math.
    display.validate({"display": 1, "title": "Costs \\$5", "figures": [{"kind": "flow", "lanes": [{"label": "L", "rows": [{"items": [{"type": "node", "label": "A"}]}]}]}]})


def _settings():
    return SimpleNamespace(artifact_renderer_path="/test/renderer", artifact_max_artifacts=2, artifact_max_attempts=3, artifact_render_timeout_seconds=45)


@pytest.mark.asyncio
async def test_a_refused_spec_costs_no_attempt_and_a_valid_one_renders_its_canonical_source():
    rendered = []

    async def renderer(settings, title, source, checks):
        rendered.append((title, source, checks))
        return RenderReport(True, image=IMAGE, views=[{"width": 270}], renderer_version="fixture")

    session = ArtifactSession(_settings(), renderer)
    session.round = 1
    broken = example("moe")
    broken["steps"][2]["set"] = {}
    text, image, refused = await session.draw(json.dumps(broken), "")
    assert refused and text.startswith("Error: the display spec was refused before rendering, so no attempt was spent")
    assert "step 3 with k1 changes nothing" in text and image is None and session.drafts == {} and rendered == []
    # Three refusals in a row still leave every attempt.
    for _ in range(3):
        await session.draw(json.dumps(broken), "")
    spec = example("moe")
    text, image, refused = await session.draw(json.dumps(spec, indent=2), "")
    assert not refused
    artifact_id = next(iter(session.drafts))
    assert image == IMAGE and '"revision": 1' in text and session.drafts[artifact_id].revision == 1
    assert rendered == [("MoE forward pass", display.validate(spec)[1], [])]
    session.round = 2
    assert "Published" in session.publish(artifact_id, 1, "Every state reads cleanly.")
    released = session.release(artifact_id, 1)
    assert released.startswith("```delphi-artifact MoE forward pass\n{\"display\":1,") and released.endswith("\n```\n")


@pytest.mark.asyncio
async def test_a_failed_display_is_repaired_with_draw_display():
    async def renderer(settings, title, source, checks):
        return RenderReport(False, [{"code": "clipped_content", "severity": "error", "message": "At 270px, from step 1: “0.1234567890” is cut off."}], image=IMAGE)

    session = ArtifactSession(_settings(), renderer)
    text, _, _ = await session.draw(json.dumps(example("handbook")), "")
    assert text.startswith("Error: artifact validation failed (content clipped).")
    assert "call draw_display with this artifact_id and the corrected complete spec" in text and "html=" not in text


def test_chat_draws_displays_and_no_longer_authors_html():
    assert "draw_display" in DEFAULTS and "render_artifact" not in DEFAULTS
    for profile in (CHAT_DOCUMENT, CHAT_GENERAL):
        names = [offer.tool.name for offer in profile.offers]
        assert names.index("draw_display") < names.index("publish_artifact") and "render_artifact" not in names


def test_chat_instructions_teach_the_library_only_where_draw_display_is_offered():
    enabled = Settings(artifact_renderer_path="/test/renderer", memory_enabled=False)
    for profile, scope in ((CHAT_DOCUMENT, "document"), (CHAT_GENERAL, "general")):
        offered = profile.toolset(Turn(enabled))
        assert "draw_display" in offered.names
        assert DISPLAYS.strip() in compose_instructions(scope, offered)
        assert "draw_display" not in profile.toolset(Turn(Settings())).names



def test_the_presentation_rules_name_embed_figure_only_where_it_is_offered():
    assert "embed_figure" not in visual_instructions({"draw_display"})
    both = visual_instructions({"draw_display", "embed_figure"})
    # A result plot is drawn as a chart to explore, and linked; a card of the paper's own figure is for a reader who asks to see it.
    assert "figure with embed_figure when the reader asks to see that figure. Otherwise\ncite the figure" in both and "a result plot becomes a chart" in both
    alone = visual_instructions({"embed_figure"})
    assert "figure with embed_figure when the reader asks to see that figure." in alone and "display" not in alone.split("# Displays")[0].split("figure with embed_figure")[1][:60]
    assert "{figures}" not in alone and visual_instructions({"read_url"}) == ""
    assert "draw one display unless the reader asked for text\nonly" in both


class Provider:
    def __init__(self, responses):
        self.responses, self.requests = responses, []

    async def stream(self, request):
        self.requests.append(json.loads(json.dumps(request)))
        for item in self.responses(len(self.requests)):
            if isinstance(item, str):
                yield {"type": "text_delta", "text": item}
                yield {"type": "item_done", "item": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": item}]}}
            else:
                yield {"type": "item_done", "item": item}
        yield {"type": "terminal", "result": ProviderResult(Terminal.COMPLETED)}


def _call(name, args, call_id):
    return {"type": "function_call", "name": name, "arguments": json.dumps(args), "call_id": call_id}


def _outputs(request):
    return [row["output"] for row in request["input"] if row.get("type") == "function_call_output"]


@pytest.mark.asyncio
async def test_a_chat_turn_draws_is_refused_repairs_and_delivers_the_display_the_reader_parses():
    config = Settings(artifact_renderer_path="/test/renderer")
    rendered = []

    async def renderer(settings, title, source, checks):
        rendered.append(source)
        return RenderReport(True, image=IMAGE, views=[{"width": 270}, {"width": 460}, {"width": 800}], renderer_version="fixture",
                            interactions=[{"probe": "display_states", "passed": True, "stateText": "14 states checked at 460px"}])

    session = ArtifactSession(config, renderer)
    broken = example("correction")
    broken["steps"][1]["set"] = {"nowhere": {"on": True}}
    spec = example("correction")

    def responses(round_):
        if round_ == 1:
            return [_call("draw_display", {"need": "how the image flows through both networks", "spec": json.dumps(broken), "artifact_id": ""}, "draw-1")]
        if round_ == 2:
            assert "no part has that id" in _outputs(provider.requests[-1])[-1] and session.drafts == {}
            return [_call("draw_display", {"need": "how the image flows through both networks", "spec": json.dumps(spec), "artifact_id": ""}, "draw-2")]
        artifact_id = next(iter(session.drafts))
        if round_ == 3:
            assert any(block == IMAGE for output in _outputs(provider.requests[-1]) if isinstance(output, list) for block in output)
            return [_call("publish_artifact", {"artifact_id": artifact_id, "revision": 1, "review": "Every step and both K read cleanly."}, "publish")]
        return [f"Training first, then sampling.\n[[delphi-artifact:{artifact_id}:1]]\n"]

    provider = Provider(responses)
    request = {"input": [{"role": "user", "content": [{"type": "input_text", "text": "How does correction training work?"}]}], "instructions": "Answer."}
    events = [event async for event in run_turn(provider, request, Toolset([DEFAULTS["draw_display"], DEFAULTS["publish_artifact"]]),
              TurnBudget.for_chat(config), ToolContext(config, artifacts=session))]
    answer = "".join(event["text"] for event in events if event["type"] == "delta")
    # One render, of the corrected spec; the refusal never reached the renderer.
    assert rendered == [display.validate(spec)[1]] and len(provider.requests) == 4
    fence = answer.split("```delphi-artifact Correction training: train, then sample\n")[1].split("\n```")[0]
    assert fence == display.validate(spec)[1] and display.is_display(fence)
    assert events[-1]["result"].terminal is Terminal.COMPLETED


@pytest.mark.asyncio
async def test_only_draw_display_checks_a_display_and_a_redraw_after_reading_is_a_free_recheck():
    rendered = []

    async def renderer(settings, title, source, checks):
        rendered.append(source)
        return RenderReport(True, image=IMAGE, views=[{"width": 270}], renderer_version="fixture")

    session = ArtifactSession(_settings(), renderer)
    text, image = await session.render("MoE", json.dumps(example("moe")), "", [])
    assert text.startswith("Error: this is a display spec; draw it with draw_display") and rendered == [] and session.drafts == {}
    session.round = 1
    await session.draw(json.dumps(example("moe")), "")
    artifact_id = next(iter(session.drafts))
    session.read_round, session.round = 1, 2
    assert "draw_display with the same spec and artifact_id rechecks it" in session.publish(artifact_id, 1, "Checked.")
    text, _, _ = await session.draw(json.dumps(example("moe"), indent=1), artifact_id)
    assert '"revision": 1' in text and len(rendered) == 2
    session.round = 3
    assert "Published" in session.publish(artifact_id, 1, "Checked against the source.")


@pytest.mark.asyncio
async def test_a_few_refusals_a_turn_give_their_visualization_call_back():
    config = Settings(artifact_renderer_path="/test/renderer")

    async def renderer(settings, title, source, checks):
        return RenderReport(True, image=IMAGE, views=[{"width": 270}], renderer_version="fixture")

    session = ArtifactSession(config, renderer)
    broken = json.dumps({"display": 1, "title": "T", "figures": []})
    calls = [_call("draw_display", {"need": "a flow", "spec": broken, "artifact_id": ""}, f"refused-{at}") for at in range(5)]
    provider = Provider(lambda round_: [calls[round_ - 1]] if round_ <= len(calls) else ["Done."])
    budget = TurnBudget.for_chat(config)
    [event async for event in run_turn(provider, {"input": [], "instructions": "Answer."}, Toolset([DEFAULTS["draw_display"]]), budget, ToolContext(config, artifacts=session))]
    # Four refusals are given back; the fifth counts, leaving five calls for real drafts.
    assert budget.artifact_refusals == 4 and budget.artifact_renders_made == 1


def flow(*nodes, **display_fields) -> dict:
    return {"display": 1, "title": "T", **display_fields, "figures": [{"kind": "flow", "lanes": [{"label": "L", "rows": [{"items": [
        {"type": "node", "id": name, "label": name.title()} for name in nodes]}]}]}]}


def test_focus_lights_the_named_nodes_and_lets_the_last_focus_go_out():
    spec = flow("a", "b", "c", steps=[
        {"name": "1", "note": "A.", "focus": ["a"]},
        {"name": "2", "note": "B and C.", "focus": ["b", "c"], "set": {"c": {"glow": False, "note": "set wins"}}},
        {"name": "3", "note": "Back to A.", "focus": ["a"]},
    ])
    raw, source = display.validate(spec)
    assert [step["set"] for step in raw["steps"]] == [
        {"a": {"glow": True}},
        {"c": {"glow": False, "note": "set wins"}, "b": {"glow": True}, "a": {"glow": False}},
        {"a": {"glow": True}, "b": {"glow": False}, "c": {"glow": False}},
    ]
    # The reader gets plain patches; the shorthand never reaches it.
    assert '"focus"' not in source
    # A tile lights the same way; a link is no part a step can be about.
    stretch = {"display": 1, "title": "T", "figures": [{"kind": "flow", "style": "stretch", "lanes": [{"label": "L", "rows": [{"items": [
        {"type": "tile", "id": "x"}, {"type": "node", "id": "n", "label": "N"}]}]}]}],
        "steps": [{"name": "1", "note": "x", "focus": ["n"]}, {"name": "2", "note": "y", "focus": ["x"]}]}
    assert [step["set"] for step in display.validate(stretch)[0]["steps"]] == [{"n": {"glow": True}}, {"x": {"glow": True}, "n": {"glow": False}}]
    grid = {"display": 1, "title": "T", "figures": [{"kind": "grid", "columns": 1, "items": [{"type": "text", "id": "t", "text": "x", "col": 1, "row": 1}]}],
            "steps": [{"name": "1", "note": "x", "focus": ["t"]}]}
    assert "steps.0.focus names 't', which is neither a node nor a tile" in reasons(grid)[0]
    assert "steps.0.focus names 'zz', but no part has that id" in reasons(flow("a", steps=[{"name": "1", "note": "x", "focus": ["zz"]}]))[0]


def test_reveal_keeps_a_grid_node_hidden_until_the_first_step_that_focuses_it():
    spec = {"display": 1, "title": "T", "reveal": True, "figures": [{"kind": "grid", "columns": 3, "items": [
        {"type": "node", "id": name, "label": name.title(), "col": at + 1, "row": 1} for at, name in enumerate("abc")]}],
        "steps": [{"name": "1", "note": "A.", "focus": ["a"]}, {"name": "2", "note": "B.", "focus": ["b"]}, {"name": "3", "note": "C.", "focus": ["c"]}]}
    raw, source = display.validate(spec)
    hidden = [[item.get("hidden", False) for item in figures[0]["items"]] for _, _, figures in display.states(raw)]
    assert hidden == [[False, True, True], [False, False, True], [False, False, False]]
    assert '"reveal"' not in source
    # A flow row closes up around a hidden node, so revealing one would move its neighbours.
    assert "reveal works in grids" in reasons(flow("a", "b", reveal=True, steps=[{"name": "1", "note": "x", "focus": ["a"]}, {"name": "2", "note": "y", "focus": ["b"]}]))[0]
    assert "give the steps a focus" in reasons(flow("a", "b", reveal=True, steps=[{"name": "1", "note": "x", "set": {"a": {"glow": True}}}]))[0]


def test_an_options_off_turns_parts_off_under_that_option():
    spec = flow("a", "b", control={"label": "Cache", "default": "on", "options": [{"value": "on", "label": "On"}, {"value": "off", "label": "Off", "off": ["b"]}]})
    raw, source = display.validate(spec)
    assert raw["variants"] == {"off": {"b": {"tone": "off"}}} and '"off":["b"]' not in source
    # A variant the model wrote itself wins.
    spec["variants"] = {"off": {"b": {"tone": "muted"}}}
    assert display.validate(spec)[0]["variants"] == {"off": {"b": {"tone": "muted"}}}
    spec = flow("a", control={"label": "C", "default": "x", "options": [{"value": "x", "label": "X", "off": ["zz"]}, {"value": "y", "label": "Y"}]})
    assert "control.options.0.off names 'zz', but no part has that id" in reasons(spec)[0]
    grid = {"display": 1, "title": "T", "control": {"label": "C", "default": "x", "options": [{"value": "x", "label": "X", "off": ["arr"]}, {"value": "y", "label": "Y"}]},
            "figures": [{"kind": "grid", "columns": 1, "items": [{"type": "arrow", "id": "arr", "dir": "down", "col": 1, "row": 1, "rows": 2}]}]}
    assert "which cannot be turned off; name nodes, tiles, lanes or matrix cells" in reasons(grid)[0]


def chart(*series, scale="linear") -> dict:
    return {"display": 1, "title": "Loss against size", "badge": "Schematic", "figures": [
        {"kind": "chart", "x": {"scale": scale}, "y": {}, "minimum": True, "series": list(series)}]}


def test_a_sketched_shape_becomes_points_and_badges_the_display_illustrative():
    valley = {"label": "6e18 FLOPs", "shape": {"kind": "valley", "start": {"x": 1e8, "y": 3.2}, "at": {"x": 1e9, "y": 2.4}, "end": {"x": 3e10, "y": 3.0}}}
    raw, source = display.validate(chart(valley, scale="log"))
    points = raw["figures"][0]["series"][0]["points"]
    assert raw["badge"] == "Illustrative" and '"shape"' not in source and raw["figures"][0]["series"][0]["sketch"] is True
    # Only the library marks a line as sketched; measured points stay readings.
    assert "sketch is set by the library" in reasons(chart({"sketch": True, "points": [{"x": 1, "y": 1}, {"x": 2, "y": 2}]}))[0]
    assert min(points, key=lambda p: p["y"]) == {"x": 1e9, "y": 2.4}
    assert points[0] == {"x": 1e8, "y": 3.2} and points[-1] == {"x": 3e10, "y": 3.0}
    # Evenly spaced as a log axis draws them.
    gaps = {round(math.log10(b["x"]) - math.log10(a["x"]), 3) for a, b in zip(points, points[1:]) if 1e9 not in (a["x"], b["x"])}
    assert len(gaps) == 1
    power = {"shape": {"kind": "power", "start": {"x": 1, "y": 10}, "end": {"x": 100, "y": 1}}}
    ys = [p["y"] for p in display.validate(chart(power))[0]["figures"][0]["series"][0]["points"]]
    assert ys[0] == 10 and ys[-1] == 1 and all(a > b for a, b in zip(ys, ys[1:]))
    plateau = {"shape": {"kind": "plateau", "start": {"x": 0, "y": 0}, "at": {"x": 2, "y": 0.8}, "end": {"x": 10, "y": 1}}}
    points = display.validate(chart(plateau))[0]["figures"][0]["series"][0]["points"]
    ys = [p["y"] for p in points]
    # It passes through the point named as where it levels off.
    assert ys[0] == 0 and {"x": 2, "y": 0.8} in points and all(a <= b for a, b in zip(ys, ys[1:])) and 0.99 < ys[-1] <= 1


@pytest.mark.parametrize("series, expected", [
    ({"shape": {"kind": "valley", "start": {"x": 1, "y": 1}, "at": {"x": 2, "y": 3}, "end": {"x": 3, "y": 2}}}, "must lie below both start and end"),
    ({"shape": {"kind": "valley", "start": {"x": 1, "y": 3}, "end": {"x": 3, "y": 2}}}, "a valley needs 'at'"),
    ({"shape": {"kind": "line", "start": {"x": 3, "y": 1}, "end": {"x": 1, "y": 2}}}, "end.x must be greater than start.x"),
    ({"shape": {"kind": "power", "start": {"x": 1, "y": -1}, "end": {"x": 2, "y": 2}}}, "same sign"),
    ({"shape": {"kind": "plateau", "start": {"x": 0, "y": 0}, "at": {"x": 1, "y": 2}, "end": {"x": 3, "y": 1}}}, "between its start and end levels"),
    ({"points": [{"x": 1, "y": 1}, {"x": 2, "y": 2}], "shape": {"kind": "line", "start": {"x": 1, "y": 1}, "end": {"x": 2, "y": 2}}}, "either points (measured values) or a shape"),
])
def test_a_shape_is_refused_when_it_cannot_be_drawn_honestly(series, expected):
    assert any(expected in reason for reason in reasons(chart(series))), reasons(chart(series))


def test_a_node_holds_a_phrase_and_sentences_go_to_its_tip():
    spec = flow("a", "b")
    spec["figures"][0]["lanes"][0]["rows"][0]["items"][0]["note"] = "Stage 0 · AR engine\nPrefill + text-token decoding"
    assert "node 'A': its note has a line break" in reasons(spec)[0]
    spec["figures"][0]["lanes"][0]["rows"][0]["items"][0]["note"] = "x" * 49
    assert "its note is 49 characters; a note holds a few words (about 48 here), so put the rest in its tip" in reasons(spec)[0]
    # A step cannot slip one in either.
    spec = flow("a", "b", steps=[{"name": "1", "note": "x"}, {"name": "2", "note": "y", "set": {"a": {"note": "y" * 60}}}])
    assert "its note is 60 characters" in reasons(spec)[0]
    # A patch of the wrong type is refused by the schema, never crashes the check.
    spec = flow("a", "b", steps=[{"name": "1", "note": "x"}, {"name": "2", "note": "y", "set": {"a": {"note": 5}}}])
    assert "Input should be a valid string" in reasons(spec)[0]
    # A node that spans the grid holds a longer note.
    wide = {"display": 1, "title": "T", "figures": [{"kind": "grid", "columns": 3, "items": [
        {"type": "node", "label": "Orchestrator", "note": "n" * 140, "col": 1, "row": 1, "cols": 3}]}]}
    display.validate(wide)


def test_a_right_arrow_in_a_node_column_carries_what_passes():
    spec = {"display": 1, "title": "T", "figures": [{"kind": "grid", "columns": 3, "items": [
        {"type": "node", "label": "Thinker", "col": 1, "row": 1},
        {"type": "arrow", "dir": "right", "col": 2, "row": 1, "pill": {"type": "node", "label": "hidden states"}},
        {"type": "node", "label": "Talker", "col": 3, "row": 1}]}]}
    display.validate(spec)


@pytest.mark.asyncio
async def test_a_passing_display_is_judged_against_its_need_before_it_is_published():
    async def renderer(settings, title, source, checks):
        return RenderReport(True, image=IMAGE, views=[{"width": 270}], renderer_version="fixture")

    session = ArtifactSession(_settings(), renderer)
    session.round = 1
    text, _, _ = await session.draw(json.dumps(example("moe")), "", "how top-k routing picks experts for each token")
    artifact_id = next(iter(session.drafts))
    assert "judge the views against the need you named (how top-k routing picks experts for each token), facts and completeness before looks" in text
    assert "a setting the need names is a control" in text and f"call draw_display with artifact_id {artifact_id}" in text
    assert "2 attempts left" in text and "optional cosmetic" not in text
    spec = example("moe")
    for attempts in ("1 attempt left", "This was the last attempt"):
        spec["title"] += "."
        text, _, _ = await session.draw(json.dumps(spec), artifact_id, "the routing")
        assert attempts in text


@pytest.mark.asyncio
async def test_a_mistyped_argument_gives_its_visualization_call_back_like_a_refused_spec():
    config = Settings(artifact_renderer_path="/test/renderer")
    session = ArtifactSession(config, None)
    calls = [_call("draw_display", {"need": "n" * 500, "spec": "{}", "artifact_id": ""}, f"long-{at}") for at in range(2)]
    provider = Provider(lambda round_: [calls[round_ - 1]] if round_ <= len(calls) else ["Done."])
    budget = TurnBudget.for_chat(config)
    [event async for event in run_turn(provider, {"input": [], "instructions": "Answer."}, Toolset([DEFAULTS["draw_display"]]), budget, ToolContext(config, artifacts=session))]
    assert "`need`: String should have at most 400 characters" in _outputs(provider.requests[1])[-1]
    assert budget.artifact_refusals == 2 and budget.artifact_renders_made == 0


def test_reveal_shows_a_grid_arrow_with_the_node_it_points_to():
    spec = {"display": 1, "title": "T", "reveal": True, "figures": [{"kind": "grid", "columns": 3, "items": [
        {"type": "node", "id": "a", "label": "A", "col": 1, "row": 1},
        {"type": "arrow", "dir": "right", "col": 2, "row": 1, "pill": {"type": "node", "label": "x"}},
        {"type": "node", "id": "b", "label": "B", "col": 3, "row": 1},
        {"type": "arrow", "id": "down", "dir": "down", "col": 3, "row": 2},
        {"type": "node", "id": "c", "label": "C", "col": 3, "row": 3}]}],
        "steps": [{"name": "1", "note": "A.", "focus": ["a"]}, {"name": "2", "note": "B.", "focus": ["b"]}, {"name": "3", "note": "C.", "focus": ["c"]}]}
    raw, _ = display.validate(spec)
    shown = [[item["type"][0] + str(item.get("hidden", False))[0] for item in figures[0]["items"]] for _, _, figures in display.states(raw)]
    assert shown == [["nF", "aT", "nT", "aT", "nT"], ["nF", "aF", "nF", "aT", "nT"], ["nF", "aF", "nF", "aF", "nF"]]
    assert raw["figures"][0]["items"][1]["id"] == "arrow1"
    # An arrow waits for both of its ends.
    spec["steps"] = [{"name": "1", "note": "B.", "focus": ["b"]}, {"name": "2", "note": "A.", "focus": ["a"]}, {"name": "3", "note": "C.", "focus": ["c"]}]
    raw, _ = display.validate(spec)
    assert [item.get("hidden", False) for item in display.states(raw)[0][2][0]["items"]] == [True, True, False, True, True]


def test_a_sketched_curve_carries_marks_the_reader_can_hover():
    rung = lambda x, n, d: {"x": x, "read": [{"label": "N", "value": n}, {"label": "D = C/6N", "value": d}]}
    budget = {"label": "$10^{19}$", "shape": {"kind": "valley", "start": {"x": 1e7, "y": 3.7}, "at": {"x": 3e8, "y": 3.1}, "end": {"x": 1e10, "y": 3.6},
              "marks": [rung(1e8, "100M", "17B"), rung(3e8, "300M", "5.6B"), rung(1e9, "1B", "1.7B")]}}
    raw, _ = display.validate(chart(budget, scale="log"))
    points = raw["figures"][0]["series"][0]["points"]
    marked = [point for point in points if "read" in point]
    assert [point["x"] for point in marked] == [1e8, 3e8, 1e9] and marked[1]["y"] == 3.1
    assert marked[0]["read"][1] == {"label": "D = C/6N", "value": "17B"}
    off = {"shape": {**budget["shape"], "marks": [rung(1e11, "100B", "x")]}}
    assert "lies off the curve" in reasons(chart(off, scale="log"))[0]
    bare = {"shape": {**budget["shape"], "marks": [{"x": 1e8}]}}
    assert "a mark gives the reader something to read" in reasons(chart(bare, scale="log"))[0]
    twice = {"shape": {**budget["shape"], "marks": [rung(1e8, "a", "b"), rung(1e8, "c", "d")]}}
    assert "two marks share an x" in reasons(chart(twice, scale="log"))[0]
    # A mark a rounding error from a sample is one point, not two at the same printed x.
    for x in (0.325, 0.45, 0.55, 0.65):
        line = {"shape": {"kind": "line", "start": {"x": 0.1, "y": 2}, "end": {"x": 0.7, "y": 1}, "marks": [{"x": x, "tip": {"title": "here"}}]}}
        xs = [point["x"] for point in display.validate(chart(line))[0]["figures"][0]["series"][0]["points"]]
        assert len(xs) == len(set(xs)) and xs.count(x) == 1


def test_an_empty_off_changes_nothing_and_off_fades_a_matrix_cell():
    # A probe lost its only display to `off: []` on the option that keeps everything on.
    spec = flow("a", "b", control={"label": "Cache", "default": "on", "options": [{"value": "on", "label": "On", "off": []}, {"value": "off", "label": "Off", "off": ["b"]}]})
    assert display.validate(spec)[0]["variants"] == {"off": {"b": {"tone": "off"}}}
    matrix = {"display": 1, "title": "Scores", "figures": [{"kind": "matrix", "cols": ["E1", "E2"], "rows": [
        {"label": "t1", "cells": [{"id": "c1", "value": "0.6", "state": "pick"}, {"id": "c2", "value": "0.4", "state": "pick"}]}]}],
        "control": {"label": "k", "default": "two", "options": [{"value": "two", "label": "Top-2"}, {"value": "one", "label": "Top-1", "off": ["c2"]}]}}
    assert display.validate(matrix)[0]["variants"] == {"one": {"c2": {"state": "faint"}}}


def test_a_chart_takes_a_log_y_axis_and_series_of_dots():
    optima = {"label": "Minima", "dots": True, "points": [{"x": 6e18, "y": 2.2e8, "tip": {"title": "6e18"}}, {"x": 3e21, "y": 4.7e9, "tip": {"title": "3e21"}}]}
    fit = {"label": "Fit", "shape": {"kind": "power", "start": {"x": 1e18, "y": 1e8}, "end": {"x": 1e24, "y": 1e11}}}
    raw, _ = display.validate({**chart(optima, fit, scale="log"), "figures": [{**chart(optima, fit, scale="log")["figures"][0], "y": {"scale": "log"}}]})
    assert raw["figures"][0]["series"][0]["dots"] and raw["figures"][0]["y"]["scale"] == "log"
    one = {"points": [{"x": 1, "y": 1, "tip": {"title": "only"}}]}
    assert "a series of single points sets dots:true" in reasons(chart(one))[0]
    assert display.validate(chart({**one, "dots": True}, {"points": [{"x": 0, "y": 0}, {"x": 2, "y": 2}]}))
    negative = {"display": 1, "title": "T", "figures": [{"kind": "chart", "x": {}, "y": {"scale": "log"}, "series": [{"points": [{"x": 0, "y": 0}, {"x": 1, "y": 1}]}]}]}
    assert "y is a log axis" in reasons(negative)[0]


def test_a_parallel_row_is_kept():
    spec = flow("a", "b")
    spec["figures"][0]["lanes"][0]["rows"][0]["parallel"] = True
    assert display.validate(spec)[0]["figures"][0]["lanes"][0]["rows"][0]["parallel"] is True


def test_a_sketch_keeps_its_shape_on_a_log_y_axis_and_never_draws_as_dots():
    line = {"label": "L", "shape": {"kind": "line", "start": {"x": 1, "y": 1e8}, "end": {"x": 10, "y": 1e11}}}
    spec = chart(line)
    spec["figures"][0]["y"] = {"scale": "log"}
    points = display.validate(spec)[0]["figures"][0]["series"][0]["points"]
    middle = points[len(points) // 2]
    # Straight in decades: halfway along x is halfway between 8 and 11 decades.
    assert abs(math.log10(middle["y"]) - 9.5) < 0.01 and points[0]["y"] == 1e8 and points[-1]["y"] == 1e11
    assert "dots are for points the source reports" in reasons(chart({**line, "dots": True}))[0]
    stretch = {"display": 1, "title": "T", "figures": [{"kind": "flow", "style": "stretch", "lanes": [{"label": "L", "rows": [{"parallel": True, "items": [{"type": "node", "label": "A"}]}]}]}]}
    assert "parallel belongs to a chain row" in reasons(stretch)[0]


def test_a_box_refuses_what_its_figure_never_draws():
    # Each would vanish from the reader's view while the model believed it was shown.
    def node_in(style, **fields):
        return {"display": 1, "title": "T", "figures": [{"kind": "flow", "style": style, "lanes": [{"label": "L", "rows": [{"items": [{"type": "node", "label": "A", **fields}]}]}]}]}
    assert "a chain node does not draw math" in reasons(node_in("chain", math="f(x)"))[0]
    assert "a stretch node does not draw note" in reasons(node_in("stretch", note="hidden words"))[0]
    assert "a chain node has no tone 'sand'" in reasons(node_in("chain", tone="sand"))[0]
    grid = {"display": 1, "title": "T", "figures": [{"kind": "grid", "columns": 1, "items": [{"type": "node", "col": 1, "row": 1, "label": "A", "tone": "dashed"}]}]}
    assert "a grid node has no tone 'dashed'" in reasons(grid)[0]
    grid["figures"][0]["items"][0] = {"type": "node", "col": 1, "row": 1, "label": "A", "short": "a"}
    assert "a grid node does not draw short without a note" in reasons(grid)[0]
    grid["figures"][0]["items"][0] = {"type": "arrow", "col": 1, "row": 1, "dir": "down", "pill": {"type": "node", "label": "x", "math": "y"}}
    assert "a pill node does not draw math" in reasons(grid)[0]
    chain = node_in("chain")
    chain["figures"][0]["lanes"][0]["progress"] = {"label": "p", "value": 0.5}
    assert "a chain lane draws no loop or progress" in reasons(chain)[0]
    stretch = node_in("stretch")
    stretch["figures"][0]["lanes"][0]["back"] = "loops"
    assert "a stretch lane draws no back" in reasons(stretch)[0]


def test_no_patch_may_unmark_a_sketch_and_deep_nesting_is_refused():
    spec = chart({"id": "s1", "label": "L", "shape": {"kind": "line", "start": {"x": 0, "y": 0}, "end": {"x": 1, "y": 1}}})
    spec["steps"] = [{"name": "1", "note": "A."}, {"name": "2", "note": "B.", "set": {"s1": {"sketch": False, "dots": True}}}]
    assert "a patch sets sketch on 's1'" in reasons(spec)[0]
    spec["figures"][0]["id"] = "c"
    spec["steps"][1]["set"] = {"c": {"series": [{"label": "a", "sketch": True, "points": [{"x": 0, "y": 0}, {"x": 1, "y": 1}]}]}}
    assert "a patch sets sketch on 'c'" in reasons(spec)[0]
    deep: dict = {}
    for _ in range(3000):
        deep = {"a": deep}
    nested = flow("a", steps=[{"name": "1", "note": "A.", "set": {"a": {"note": deep}}}])
    assert "nested too deeply" in reasons(nested)[0]
