"""An artifact is delivered only after the model receives and inspects its render."""

import asyncio
import copy
import json
import re
from types import SimpleNamespace

import pytest

from delphi_core.answer_trace import AnswerTrace, utf16_length
from delphi_core.artifacts import delivery as artifact_delivery
from delphi_core.artifacts.delivery import Delivery, FALLBACK, DELIVERY_FALLBACK, REFERENCE_FALLBACK
from delphi_core.artifacts.session import ArtifactSession
from delphi_core.artifacts.types import RenderReport
from delphi_core.config import Settings
from delphi_core.harness.budget import ARTIFACT_CALLS_SPENT, TurnBudget
from delphi_core.harness.loop import run_turn
from delphi_core.harness.profiles import CHAT_DOCUMENT, CHAT_GENERAL, Turn
from delphi_core.harness.prompts import compose_instructions
from delphi_core.harness.provider import ProviderResult, Terminal
from delphi_core.harness.registry import DEFAULTS, Toolset
from delphi_core.harness.tool import BudgetClass, ToolContext

IMAGE = {"type": "input_image", "image_url": "data:image/png;base64,cGl4ZWxz", "detail": "high"}
HTML = '<div class="artifact-node">A → B</div>\n<script>const example = "```";</script>\n'
# What draw_display renders and delivers: the canonical source of a small display.
SOURCE = '{"display":1,"title":"Pipeline","figures":[{"kind":"flow","lanes":[{"label":"Path","rows":[{"items":[{"type":"node","label":"A"},{"type":"node","label":"B"}]}]}]}]}'


def draw(artifact_id="", spec=SOURCE):
    return {"need": "how A leads to B", "spec": spec, "artifact_id": artifact_id}


def settings(**changes):
    return SimpleNamespace(artifact_renderer_path="/test/renderer", artifact_max_artifacts=2,
                           artifact_max_attempts=3, artifact_render_timeout_seconds=changes.get("timeout", 45))


async def passing(*args):
    return RenderReport(True, image=IMAGE, views=[{"width": 340}, {"width": 620}], renderer_version="fixture")


def identity(session):
    return next(iter(session.drafts))


@pytest.mark.asyncio
async def test_render_requires_a_later_inspection_round_and_releases_exact_source():
    session = ArtifactSession(settings(), passing)
    session.round = 1
    feedback, image = await session.render("Pipeline", HTML, "", [])
    artifact_id = identity(session)
    assert image == IMAGE and '"passed": true' in feedback
    assert "same batch" in session.publish(artifact_id, 1, "Labels are readable.")
    assert session.release(artifact_id, 1) is None
    session.round = 2
    assert "Published" in session.publish(artifact_id, 1, "Both views and primary controls are readable.")
    released = session.release(artifact_id, 1)
    assert released == f"````delphi-artifact Pipeline\n{HTML}\n````\n"
    assert session.release(artifact_id, 1) is None
    assert "already delivered" in (await session.render("Pipeline", HTML, artifact_id, []))[0]


@pytest.mark.asyncio
async def test_repair_invalidates_old_pass_and_stale_references():
    reports = iter([RenderReport(True, image=IMAGE), RenderReport(False, [{"message": "Overlap"}], IMAGE), RenderReport(True, image=IMAGE)])

    async def renderer(*args):
        return next(reports)

    session = ArtifactSession(settings(), renderer)
    session.round = 1
    await session.render("Graph", "<svg>A</svg>", "", [])
    artifact_id = identity(session)
    session.round = 2
    session.publish(artifact_id, 1, "Inspected.")
    feedback, _ = await session.render("Graph", "<svg>B</svg>", artifact_id, [])
    assert feedback.startswith("Error:") and "Overlap" in feedback
    assert session.release(artifact_id, 1) is None
    session.round = 3
    assert "not passed" in session.publish(artifact_id, 2, "Inspected.")
    await session.render("Graph", "<svg>C</svg>", artifact_id, [])
    session.round = 4
    assert "stale" in session.publish(artifact_id, 2, "Inspected.")
    assert "Published" in session.publish(artifact_id, 3, "Now clear.")
    assert "<svg>C</svg>" in session.release(artifact_id, 3)


@pytest.mark.asyncio
async def test_a_draft_rendered_before_a_source_was_read_is_not_published():
    async def renderer(*args):
        return RenderReport(True, image=IMAGE)

    session = ArtifactSession(settings(), renderer)
    session.round = 1
    await session.render("Graph", "<svg>A</svg>", "", [])
    artifact_id = identity(session)
    session.read_round = 1
    session.round = 2
    assert "source was read" in session.publish(artifact_id, 1, "Inspected.")
    await session.render("Graph", "", artifact_id, [])
    session.round = 3
    assert "Published" in session.publish(artifact_id, 1, "Checked against the source.")
    # A draft on its last attempt is not stranded by a later read.
    await session.render("Graph", "<svg>B</svg>", artifact_id, [])
    await session.render("Graph", "<svg>C</svg>", artifact_id, [])
    session.read_round, session.round = 3, 4
    assert "source was read" in session.publish(artifact_id, 3, "Inspected.")
    feedback, _ = await session.render("Graph", "", artifact_id, [])
    assert '"revision": 3' in feedback
    session.round = 5
    assert "Published" in session.publish(artifact_id, 3, "Checked against the source.")


@pytest.mark.asyncio
async def test_a_failed_draft_names_its_first_error_for_the_trace():
    async def renderer(*args):
        return RenderReport(False, [{"code": "resource_usage", "severity": "info", "message": "m"}, {"code": "dead_control", "severity": "error", "message": "m"}], IMAGE)

    session = ArtifactSession(settings(), renderer)
    feedback, _ = await session.render("Graph", "<svg>A</svg>", "", [])
    assert feedback.startswith("Error: artifact validation failed (control did nothing).\n")


@pytest.mark.asyncio
async def test_check_only_retries_reuse_exact_source_without_bypassing_validation_or_attempts():
    renders = []

    async def renderer(config, title, source, checks):
        renders.append((source, checks))
        return RenderReport(len(renders) != 2, image=IMAGE)

    session = ArtifactSession(settings(), renderer)
    session.round = 1
    await session.render("Graph", HTML, "", [])
    artifact_id = identity(session)
    original_hash = session.drafts[artifact_id].digest
    session.round = 2
    assert "Published" in session.publish(artifact_id, 1, "Inspected.")
    checks = [{"action": "click", "target": "#advance", "value": ""}]
    feedback, _ = await session.render("Graph", "", artifact_id, checks)
    assert feedback.startswith("Error:")
    assert session.drafts[artifact_id].digest == original_hash
    assert session.release(artifact_id, 1) is None
    session.round = 3
    assert "not passed" in session.publish(artifact_id, 2, "Inspected.")
    corrected_checks = [{"action": "click", "target": "#next", "value": ""}]
    await session.render("Graph", "", artifact_id, corrected_checks)
    assert "same batch" in session.publish(artifact_id, 3, "Inspected.")
    assert "exhausted" in (await session.render("Graph", "", artifact_id, []))[0]
    session.round = 4
    assert "Published" in session.publish(artifact_id, 3, "Inspected corrected sequence.")
    assert HTML in session.release(artifact_id, 3)
    assert "already delivered" in (await session.render("Graph", "", artifact_id, []))[0]
    assert renders == [(HTML, []), (HTML, checks), (HTML, corrected_checks)]


@pytest.mark.asyncio
async def test_empty_html_cannot_create_or_find_another_turns_draft():
    session = ArtifactSession(settings(), passing)
    assert "draft is empty" in (await session.render("Graph", "", "", []))[0]
    assert not session.drafts
    await session.render("Graph", HTML, "", [])
    artifact_id = identity(session)
    other = ArtifactSession(settings(), passing)
    assert "unknown artifact_id" in (await other.render("Graph", "", artifact_id, []))[0]
    assert not other.drafts
    assert "draft is empty" in (await session.render("Graph", "  ", artifact_id, []))[0]
    assert session.drafts[artifact_id].revision == 1


@pytest.mark.asyncio
async def test_limits_and_missing_screenshot_are_real_refusals():
    session = ArtifactSession(settings(), passing)
    for _ in range(2):
        await session.render("Graph", HTML, "", [])
    assert "allowed visualizations" in (await session.render("Third", HTML, "", []))[0]
    artifact_id = identity(session)
    for _ in range(2):
        await session.render("Graph", HTML, artifact_id, [])
    assert "exhausted" in (await session.render("Fourth draft", HTML, artifact_id, []))[0]

    async def no_pixels(*args):
        return RenderReport(True)

    missing = ArtifactSession(settings(), no_pixels)
    feedback, _ = await missing.render("Graph", HTML, "", [])
    missing.round = 2
    assert "No screenshot" in feedback
    assert "not passed" in missing.publish(identity(missing), 1, "Guessed.")


@pytest.mark.asyncio
async def test_render_timeout_cancels_work_and_is_returned_as_repairable_prose():
    cancelled = []

    async def slow(*args):
        try:
            await asyncio.sleep(10)
        finally:
            cancelled.append(True)

    session = ArtifactSession(settings(timeout=0.01), slow)
    feedback, image = await session.render("Graph", HTML, "", [])
    assert cancelled == [True] and image is None
    assert feedback.startswith("Error:") and "time allowance" in feedback
    assert session.release(identity(session), 1) is None


@pytest.mark.asyncio
async def test_verbose_feedback_stays_bounded_valid_json():
    async def verbose(*args):
        return RenderReport(True, [{"code": "layout", "severity": "info", "message": "x" * 2000}] * 12,
                            IMAGE, [{"width": 340, "document": {"text": [{"text": "label" * 500, "size": 14}] * 50}}] * 4)

    session = ArtifactSession(settings(), verbose)
    feedback, _ = await session.render("Graph", HTML, "", [])
    report, offset = json.JSONDecoder().raw_decode(feedback)
    assert report["artifact_id"] == identity(session) and report["revision"] == 1
    assert offset < 16_000 and "Inspect the attached" in feedback[offset:]


@pytest.mark.parametrize("raw", [
    "```delphi-artifact Bad\n<script>bad()</script>\n```\n",
    "> ```delphi-artifact Bad\n> <script>bad()</script>\n> ```\n",
    "  - ~~~delphi-artifact Bad\n<script>bad()</script>\n~~~\n",
    "```delphi&#45;artifact Bad\n<script>bad()</script>\n```\n",
    "```delphi\\-artifact Bad\n<script>bad()</script>\n```\n",
    "````text\n```delphi-artifact Bad\n<script>bad()</script>\n```\n````\n",
    "[[delphi-artifact:a_0123456789abcdef:1]]\n",
])
@pytest.mark.parametrize("newline", ["\n", "\r", "\r\n"])
def test_raw_encoded_quoted_and_nested_fences_never_reach_the_reader(raw, newline):
    source = ("Before.\n" + raw + "After.\n").replace("\n", newline)
    for split in range(-1, len(source) + 1):
        gate = Delivery(ArtifactSession(settings(), passing))
        visible = []
        chunks = list(source) if split == -1 else [source[:split], source[split:]]
        for chunk in chunks:
            visible += gate.push(chunk)
        visible += gate.finish(completed=True)
        text = "".join(visible)
        assert "delphi-artifact" not in text and "delphi&#45;artifact" not in text
        assert "Before." in text and FALLBACK in text


def test_plain_paragraphs_stream_progressively_and_unfinished_candidates_do_not_escape():
    gate = Delivery(ArtifactSession(settings(), passing))
    assert gate.push("First sentence.\nAnother") == ["First sentence.\n", "Another"]
    assert gate.push(" sentence.") == [" sentence."]
    assert gate.finish(completed=True) == []
    cut = Delivery(ArtifactSession(settings(), passing))
    assert cut.push("```delphi-art") == []
    assert cut.finish(completed=False) == []
    partial = Delivery(ArtifactSession(settings(), passing))
    assert partial.push("A partial answer") == ["A partial answer"]
    assert partial.finish(completed=False) == []


@pytest.mark.parametrize("newline", ["\n", "\r", "\r\n"])
def test_every_split_streams_plain_text_and_normalizes_only_model_line_endings(newline):
    source = f"A paragraph without a pause.{newline}Another line with an ordinary dog."
    expected = source.replace("\r\n", "\n").replace("\r", "\n")
    for split in range(len(source) + 1):
        gate = Delivery(ArtifactSession(settings(), passing))
        visible = gate.push(source[:split]) + gate.push("") + gate.push(source[split:])
        visible += gate.finish(completed=True)
        assert "".join(visible) == expected


@pytest.mark.parametrize("marker", ["delphi-artifact", "DELPHI-ARTIFACT", "delphi\\-artifact",
                                    "delphi&#45;artifact", "&#100;elphi-artifact", "delphi&amp;#45;artifact"])
def test_every_split_withholds_late_inline_reserved_marker_and_preserves_line_boundary(marker):
    source = f"Ordinary explanation {marker} forbidden tail\nNext paragraph.\n"
    for split in range(len(source) + 1):
        gate = Delivery(ArtifactSession(settings(), passing))
        visible = gate.push(source[:split]) + gate.push(source[split:]) + gate.finish(completed=True)
        text = "".join(visible)
        assert marker not in text and "forbidden tail" not in text
        assert "delphi-artifact" not in artifact_delivery._decoded(text)
        assert "Next paragraph.\n" in text and FALLBACK in text
        before = text.split("Next paragraph.", 1)[0]
        assert not before or before.endswith("\n")


@pytest.mark.parametrize("prefix", ["    Indented", "```text", "[[reference", "&amp; prose", "\\Escaped", "- ", "1. ", "> ```"])
def test_uncertain_markdown_prefixes_stay_buffered(prefix):
    gate = Delivery(ArtifactSession(settings(), passing))
    assert gate.push(prefix) == []


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("source", [
    "**Short answer:** this arrives progressively.", "# A heading with context.",
    "- A list item with useful explanation.", "1. A numbered item with context.",
    "> A quoted paragraph with context.", "Équation et explication.", "这是逐步显示的解释。",
    r"A formula \alpha + \beta keeps flowing.", "A &amp; B keep flowing.",
    r"A \(x + y\) formula keeps flowing.", "A &#x3b1; and &amp;amp; keep flowing.",
])
def test_markdown_and_math_stream_without_waiting_for_line_end(enabled, source):
    for chunks in ([source], list(source)):
        config = settings()
        config.artifact_renderer_path = "/test/renderer" if enabled else ""
        gate = Delivery(ArtifactSession(config, passing))
        visible = [part for chunk in chunks for part in gate.push(chunk)]
        # No newline, finish, or provider terminal is needed for ordinary text.
        assert "".join(visible) == source
        assert gate.finish(completed=True) == []


@pytest.mark.parametrize("prefix", ["**Answer:** ", "- Item ", "1. Item ", "# Heading ", "> Quoted ", "中文 "])
@pytest.mark.parametrize("marker", ["delphi-artifact", r"delphi\-artifact", "&#100;elphi-artifact",
                                     "delphi&#x2d;artifact", "delphi&amp;amp;#45;artifact"])
def test_progressive_markdown_still_blocks_encoded_marker_at_every_split(prefix, marker):
    source = prefix + marker + " forbidden tail\nNext paragraph.\n"
    for split in range(-1, len(source) + 1):
        gate = Delivery(ArtifactSession(settings(), passing))
        chunks = list(source) if split == -1 else [source[:split], source[split:]]
        text = "".join([part for chunk in chunks for part in gate.push(chunk)] + gate.finish(completed=True))
        assert "delphi-artifact" not in artifact_delivery._decoded(text)
        assert "forbidden tail" not in text and "Next paragraph." in text and FALLBACK in text


@pytest.mark.parametrize("tail", ["delphi-art", "&amp;#100;elphi-artifact", "delphi\\-artifact"])
def test_interruption_never_flushes_an_ambiguous_reserved_tail(tail):
    gate = Delivery(ArtifactSession(settings(), passing))
    assert gate.push("Harmless prose ") == ["Harmless prose "]
    assert gate.push(tail) == []
    text = "".join(gate.finish(completed=False))
    assert tail not in text and "delphi-artifact" not in artifact_delivery._decoded(text)


@pytest.mark.asyncio
async def test_only_a_standalone_published_reference_is_expanded_once():
    session = ArtifactSession(settings(), passing)
    session.round = 1
    await session.render("Pipeline", HTML, "", [])
    session.round = 2
    artifact_id = identity(session)
    session.publish(artifact_id, 1, "Clear in both widths.")
    reference = f"[[delphi-artifact:{artifact_id}:1]]"
    gate = Delivery(session)
    pieces = gate.push(f"Lead.\n{reference}\n{reference}\nEnd.") + gate.finish(completed=True)
    text = "".join(pieces)
    assert text.count("delphi-artifact Pipeline") == 1
    assert HTML in text and reference not in text
    assert "Lead." in text and "End." in text
    assert REFERENCE_FALLBACK in text and FALLBACK not in text and DELIVERY_FALLBACK not in text


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["", " ", "  ", "   "])
async def test_commonmark_standalone_indentation_delivers_at_every_split(prefix):
    template = ArtifactSession(settings(), passing)
    template.round = 1
    await template.render("Pipeline", HTML, "", [])
    template.round = 2
    artifact_id = identity(template)
    template.publish(artifact_id, 1, "Inspected.")
    source = f"Lead.\n\n{prefix}[[delphi-artifact:{artifact_id}:1]]\n"
    for split in range(-1, len(source) + 1):
        session = copy.deepcopy(template)
        gate = Delivery(session)
        chunks = list(source) if split == -1 else [source[:split], source[split:]]
        text = "".join([part for chunk in chunks for part in gate.push(chunk)] + gate.finish(completed=True))
        assert HTML in text and session.drafts[artifact_id].delivered
        assert FALLBACK not in text and DELIVERY_FALLBACK not in text


@pytest.mark.asyncio
@pytest.mark.parametrize("placement", ["Here is {ref} inline.", "- {ref}", "    {ref}", "No diagram included."])
async def test_published_but_withheld_artifact_reports_delivery_not_validation_failure(placement):
    session = ArtifactSession(settings(), passing)
    session.round = 1
    await session.render("Pipeline", HTML, "", [])
    session.round = 2
    artifact_id = identity(session)
    session.publish(artifact_id, 1, "Inspected.")
    source = placement.format(ref=f"[[delphi-artifact:{artifact_id}:1]]")
    gate = Delivery(session)
    text = "".join([part for char in source for part in gate.push(char)] + gate.finish(completed=True))
    assert DELIVERY_FALLBACK in text and FALLBACK not in text
    assert HTML not in text and not session.drafts[artifact_id].delivered


@pytest.mark.asyncio
@pytest.mark.parametrize("count", [1, 2])
@pytest.mark.parametrize("ending", ["", " \t", "\n"])
async def test_completed_reference_at_eof_does_not_append_a_failure_notice(count, ending):
    template = ArtifactSession(settings(), passing)
    template.round = 1
    for index in range(count):
        await template.render(f"Diagram {index}", HTML, "", [])
    template.round = 2
    for artifact_id in template.drafts:
        template.publish(artifact_id, 1, "Both widths and controls are readable.")
    source = "Lead.\n" + "\n\n".join(f"[[delphi-artifact:{artifact_id}:1]]" for artifact_id in template.drafts) + ending
    for split in range(-1, len(source) + 1):
        session = copy.deepcopy(template)
        gate = Delivery(session)
        chunks = list(source) if split == -1 else [source[:split], source[split:]]
        pieces = [piece for chunk in chunks for piece in gate.push(chunk)]
        text = "".join(pieces + gate.finish(completed=True))
        assert text.count("delphi-artifact Diagram") == count
        assert all(draft.delivered for draft in session.drafts.values())
        assert FALLBACK not in text and not gate.blocked


@pytest.mark.asyncio
@pytest.mark.parametrize("completed,revision", [(False, 1), (True, 2)])
async def test_unfinished_or_stale_eof_reference_still_falls_back(completed, revision):
    session = ArtifactSession(settings(), passing)
    session.round = 1
    await session.render("Pipeline", HTML, "", [])
    session.round = 2
    artifact_id = identity(session)
    session.publish(artifact_id, 1, "Inspected.")
    gate = Delivery(session)
    text = "".join(gate.push(f"Lead.\n[[delphi-artifact:{artifact_id}:{revision}]]") + gate.finish(completed=completed))
    assert DELIVERY_FALLBACK in text and FALLBACK not in text and HTML not in text
    assert not session.drafts[artifact_id].delivered


@pytest.mark.asyncio
@pytest.mark.parametrize("newline", ["\n", "\r", "\r\n"])
async def test_progressive_prose_keeps_references_standalone_and_released_html_exact(newline):
    session = ArtifactSession(settings(), passing)
    session.round = 1
    exact_source = HTML.replace("\n", "\r") + "<p>Windows\r\nline</p>"
    await session.render("First", exact_source, "", [])
    await session.render("Second", HTML, "", [])
    first, second = session.drafts
    session.round = 2
    for artifact_id in (first, second):
        session.publish(artifact_id, 1, "Inspected.")
    reference = f"[[delphi-artifact:{first}:1]]"
    gate = Delivery(session)
    visible = gate.push("Harmless prose ")
    assert visible == ["Harmless prose "]
    # The pending suffix is not a new line, even if it looks like a complete
    # valid reference. It must not spend the published revision.
    for character in reference + newline:
        visible += gate.push(character)
    assert not session.drafts[first].delivered
    for character in reference + newline + f"[[delphi-artifact:{second}:1]]" + newline:
        visible += gate.push(character)
    visible += gate.finish(completed=True)
    text = "".join(visible)
    assert text.startswith("Harmless prose ")
    assert text.split("````delphi-artifact First", 1)[0].endswith("\n\n")
    assert exact_source in text and HTML in text
    assert all(draft.delivered for draft in session.drafts.values())
    assert "[[delphi-artifact:" not in text


@pytest.mark.asyncio
@pytest.mark.parametrize("lead,allowed", [
    ("```text\rbody\r```\r", True),
    ("```text\rbody\r", False),
    ("> Quoted\r", False),
    ("- List\r", False),
    ("> ```text\r> body\r> ```\r\r", True),
])
async def test_cr_boundaries_keep_commonmark_reference_context(lead, allowed):
    session = ArtifactSession(settings(), passing)
    session.round = 1
    await session.render("Pipeline", HTML, "", [])
    artifact_id = identity(session)
    session.round = 2
    session.publish(artifact_id, 1, "Inspected.")
    gate = Delivery(session)
    text = "".join(gate.push(lead + f"[[delphi-artifact:{artifact_id}:1]]\r") + gate.finish(completed=True))
    assert session.drafts[artifact_id].delivered is allowed
    assert (HTML in text) is allowed


@pytest.mark.asyncio
@pytest.mark.parametrize("lead", [
    'Use ```` to quote a code example.\n',
    '```js\nconst example = "```";\n```\n',
    '````text\n``` is not a closing line\n````\n',
    '\\``` is escaped prose.\n',
    '&#96;&#96;&#96; is encoded prose.\n',
    '> ```text\n> example\n\n',
    '- ```text\n  example\n\n',
    '> ```text\n> example\n> ```\n\n',
    '- ```text\n  example\n  ```\n\n',
    '- Item\n\n  ```text\n  example\n  ```\n\n',
    '1. Example:\n\n   ```js\n   const example = "```";\n   ```\n\n',
    '> - ```text\n>   example\n>   ```\n\n',
    '- Item\n  - ```text\n    nested\n    ```\n\n',
    '    Indented code\n\n',
    '\tIndented code\n\n',
])
async def test_inline_backticks_do_not_hide_a_published_reference(lead):
    session = ArtifactSession(settings(), passing)
    session.round = 1
    await session.render("Pipeline", HTML, "", [])
    session.round = 2
    artifact_id = identity(session)
    session.publish(artifact_id, 1, "Clear in both widths.")
    gate = Delivery(session)
    text = "".join(gate.push(lead + f"[[delphi-artifact:{artifact_id}:1]]\n") + gate.finish(completed=True))
    assert text.startswith(lead) and HTML in text and FALLBACK not in text


@pytest.mark.asyncio
@pytest.mark.parametrize("lead,prefix", [
    ('```text\n', ''),
    ('````text\n```\n', ''),
    ('~~~text\n', ''),
    ('> Quoted paragraph\n', ''),
    ('- List paragraph\n', ''),
    ('<div>\n', ''),
    ('', '> '),
    ('- Item\n', '  '),
    ('', '\t'),
    ('', '    '),
])
async def test_published_references_inside_examples_do_not_become_executable(lead, prefix):
    session = ArtifactSession(settings(), passing)
    session.round = 1
    await session.render("Pipeline", HTML, "", [])
    session.round = 2
    artifact_id = identity(session)
    session.publish(artifact_id, 1, "Clear in both widths.")
    gate = Delivery(session)
    text = "".join(gate.push(lead + prefix + f"[[delphi-artifact:{artifact_id}:1]]\n") + gate.finish(completed=True))
    assert "delphi-artifact" not in text and HTML not in text
    assert not session.drafts[artifact_id].delivered
    assert DELIVERY_FALLBACK in text and FALLBACK not in text


@pytest.mark.asyncio
async def test_reference_context_parsing_is_bounded_and_only_for_eligible_drafts(monkeypatch):
    session = ArtifactSession(settings(), passing)
    session.round = 1
    await session.render("Pipeline", HTML, "", [])
    session.round = 2
    artifact_id = identity(session)
    session.publish(artifact_id, 1, "Clear in both widths.")
    calls = []
    parse = artifact_delivery._MARKDOWN.parse

    def counted(source):
        calls.append(len(source))
        return parse(source)

    monkeypatch.setattr(artifact_delivery._MARKDOWN, "parse", counted)
    gate = Delivery(session)
    gate.push("[[delphi-artifact:a_0000000000000000:1]]\n" * 100)
    gate.push(f"[[delphi-artifact:{artifact_id}:2]]\n")
    assert not calls
    gate.push("```text\n" + f"[[delphi-artifact:{artifact_id}:1]]\n" * 100)
    assert len(calls) == artifact_delivery.REFERENCE_CHECKS_MAX
    assert not session.drafts[artifact_id].delivered

    limited = Delivery(session)
    # The prefix limit bounds retained prose, not the text delivered to readers.
    prose = "Plain explanation.\n" * (artifact_delivery.PREFIX_MAX // 19 + 1)
    assert "".join(limited.push(prose)) == prose
    assert limited.prefix_overflow and limited.emitted == []
    before = len(calls)
    text = "".join(limited.push(f"[[delphi-artifact:{artifact_id}:1]]\n") + limited.finish(completed=True))
    assert len(calls) == before and HTML not in text and DELIVERY_FALLBACK in text


class Provider:
    def __init__(self, responses):
        self.responses = responses
        self.requests = []

    async def stream(self, request):
        self.requests.append(copy.deepcopy(request))
        for item in self.responses(len(self.requests)):
            if isinstance(item, str):
                yield {"type": "text_delta", "text": item}
                yield {"type": "item_done", "item": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": item}]}}
            else:
                yield {"type": "item_done", "item": item}
        yield {"type": "terminal", "result": ProviderResult(Terminal.COMPLETED)}


def call(name, args, call_id):
    return {"type": "function_call", "name": name, "arguments": json.dumps(args), "call_id": call_id}


@pytest.mark.asyncio
@pytest.mark.parametrize("repair", [False, True])
@pytest.mark.parametrize("ending", ["", "\n"])
async def test_real_loop_inspects_pixels_repairs_and_delivers_exact_source(repair, ending):
    config = Settings(artifact_renderer_path="/test/renderer")
    renders = []

    async def render(config, title, source, checks):
        renders.append(source)
        return RenderReport(not (repair and len(renders) == 1), [{"message": "Overlap"}] if repair and len(renders) == 1 else [], IMAGE)

    session = ArtifactSession(config, render)
    tools = Toolset([DEFAULTS["draw_display"], DEFAULTS["publish_artifact"]])

    def responses(round_):
        if round_ == 1 or (repair and round_ == 2):
            return [{"type": "reasoning", "summary": [], "encrypted_content": "sealed-source-context"},
                    call("draw_display", draw(identity(session) if round_ > 1 else "", SOURCE.replace('"B"', '"C"') if repair and round_ == 1 else SOURCE), f"render-{round_}")]
        if round_ == (3 if repair else 2):
            history = provider.requests[-1]["input"]
            assert [row for row in history if row.get("role") == "user"] == request["input"]
            assert any(row.get("encrypted_content") == "sealed-source-context" for row in history)
            assert any(block == IMAGE for row in history
                       if row.get("type") == "function_call_output" and isinstance(row.get("output"), list)
                       for block in row["output"])
            return [call("publish_artifact", {"artifact_id": identity(session), "revision": len(renders), "review": "Inspected layout and readable arrows at both widths."}, "publish")]
        return [f"The flow is A to B.\n[[delphi-artifact:{identity(session)}:{len(renders)}]]" + ending]

    provider = Provider(responses)
    record = AnswerTrace()
    request = {"input": [{"role": "user", "content": [{"type": "input_text", "text": "Explain this pipeline"}, IMAGE]}], "instructions": "Make a checked diagram."}
    events = [event async for event in run_turn(provider, request, tools, TurnBudget.for_chat(config),
              ToolContext(config, artifacts=session), recorder=record)]
    answer = "".join(event["text"] for event in events if event["type"] == "delta")
    assert SOURCE in answer and "[[delphi-artifact:" not in answer
    assert answer.count("delphi-artifact Pipeline") == 1 and FALLBACK not in answer
    assert len(provider.requests) == (4 if repair else 3)
    assert request["input"][0]["content"][0]["text"] == "Explain this pipeline"
    assert events[-1]["result"].terminal is Terminal.COMPLETED
    assert all(stretch["offset"] <= utf16_length(answer) for stretch in record.stored())
    assert SOURCE.replace('"B"', '"C"') not in json.dumps(record.stored())


@pytest.mark.asyncio
async def test_gate_runs_before_trace_and_raw_draft_is_not_a_successful_delivery():
    config = Settings()
    record = AnswerTrace()
    provider = Provider(lambda _: ["Hello 👋.\n```delphi-artifact Unchecked\n<script>bad()</script>\n```\n"])
    events = [event async for event in run_turn(provider, {"input": [], "instructions": "Answer"}, Toolset(),
              TurnBudget.for_chat(config), ToolContext(config, artifacts=ArtifactSession(config)), recorder=record)]
    answer = "".join(event["text"] for event in events if event["type"] == "delta")
    assert "bad()" not in answer and "delphi-artifact" not in answer and FALLBACK in answer
    assert all(stretch["offset"] <= utf16_length(answer) for stretch in record.stored())


@pytest.mark.asyncio
async def test_prose_delta_reaches_trace_and_reader_before_provider_completion():
    config = Settings()
    record = AnswerTrace()
    completed = False

    class StreamingProvider:
        async def stream(self, request):
            nonlocal completed
            yield {"type": "text_delta", "text": "Hello 👋, an explanation "}
            yield {"type": "text_delta", "text": "continues.\r```delphi-artifact Unchecked\r<script>bad()</script>\r```\r"}
            completed = True
            yield {"type": "terminal", "result": ProviderResult(Terminal.COMPLETED)}

    chunks = []
    async for event in run_turn(StreamingProvider(), {"input": [], "instructions": "Answer"}, Toolset(),
                                TurnBudget.for_chat(config), ToolContext(config, artifacts=ArtifactSession(config)), recorder=record):
        if event["type"] == "delta":
            if not chunks:
                assert not completed and event["text"] == "Hello 👋, an explanation "
            chunks.append(event["text"])
    answer = "".join(chunks)
    assert "bad()" not in answer and "delphi-artifact" not in answer and FALLBACK in answer
    assert all(stretch["offset"] <= utf16_length(answer) for stretch in record.stored())


def test_artifact_budgets_are_independent_and_profiles_own_capability():
    enabled = Settings(artifact_renderer_path="/test/renderer", memory_enabled=False)
    budget = TurnBudget.for_chat(enabled)
    for _ in range(6):
        assert budget.charge(BudgetClass.ARTIFACT_RENDER) is None
    assert budget.spent(BudgetClass.ARTIFACT_RENDER)
    assert budget.charge(BudgetClass.ARTIFACT_RENDER) == ARTIFACT_CALLS_SPENT
    assert budget.memory_calls_made == budget.document_calls_made == budget.figure_views_made == 0
    for _ in range(2):
        assert budget.charge(BudgetClass.ARTIFACT_PUBLISH) is None
    assert budget.spent(BudgetClass.ARTIFACT_PUBLISH)
    for profile in (CHAT_DOCUMENT, CHAT_GENERAL):
        offered = profile.toolset(Turn(enabled))
        assert {"draw_display", "publish_artifact"} <= offered.names and "render_artifact" not in offered.names
        instruction = " ".join(compose_instructions("general", offered).split())
        assert "Inspect every returned screenshot" in instruction and "Respect text-only" in instruction
        assert "Decide before you draw" in instruction and "need argument" in instruction
        # Chat no longer authors HTML: none of its kit or workflow is taught.
        assert "render_artifact" not in instruction and "HTML/SVG" not in instruction and "--artifact-" not in instruction
        assert "draw_display" not in profile.toolset(Turn(enabled, artifacts=False)).names
        assert "draw_display" not in profile.toolset(Turn(Settings())).names


def test_draw_arguments_are_bounded_and_name_the_need_before_the_spec():
    arguments = DEFAULTS["draw_display"].arguments
    assert arguments.model_validate(draw()).spec == SOURCE
    assert list(arguments.parameters()["properties"])[:2] == ["need", "spec"]
    for broken in ({**draw(), "need": ""}, {**draw(), "spec": "x" * 128_001}, {**draw(), "html": HTML}):
        with pytest.raises(ValueError):
            arguments.model_validate(broken)
    assert re.fullmatch(r"[a-z_]+", DEFAULTS["publish_artifact"].name)


@pytest.mark.asyncio
async def test_cancellation_stops_the_render_without_releasing_its_draft():
    started = asyncio.Event()
    stopped = []

    async def rendering(*args):
        started.set()
        try:
            await asyncio.sleep(10)
        finally:
            stopped.append(True)

    config = Settings(artifact_renderer_path="/test/renderer")
    session = ArtifactSession(config, rendering)
    tools = Toolset([DEFAULTS["draw_display"], DEFAULTS["publish_artifact"]])
    provider = Provider(lambda _: [call("draw_display", draw(), "render")])
    events = []

    async def consume():
        async for event in run_turn(provider, {"input": []}, tools, TurnBudget.for_chat(config), ToolContext(config, artifacts=session)):
            events.append(event)

    task = asyncio.create_task(consume())
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stopped == [True]
    assert session.release(identity(session), 1) is None
    assert not any(event["type"] == "delta" for event in events)


@pytest.mark.asyncio
async def test_turn_deadline_withholds_draft_and_gives_an_honest_fallback():
    async def slow(*args):
        await asyncio.sleep(10)

    config = Settings(artifact_renderer_path="/test/renderer")
    session = ArtifactSession(config, slow)
    tools = Toolset([DEFAULTS["draw_display"], DEFAULTS["publish_artifact"]])
    provider = Provider(lambda _: [call("draw_display", draw(), "render")])
    budget = TurnBudget.for_chat(config)
    budget.deadline_seconds = 0.01
    events = [event async for event in run_turn(provider, {"input": []}, tools, budget, ToolContext(config, artifacts=session))]
    answer = "".join(event["text"] for event in events if event["type"] == "delta")
    assert FALLBACK in answer and SOURCE not in answer
    assert events[-1]["result"].terminal is Terminal.INCOMPLETE
    assert session.release(identity(session), 1) is None


def test_chat_stores_exact_released_source_and_keeps_the_user_question_clean(tmp_path, monkeypatch):
    import httpx
    from fastapi.testclient import TestClient

    from delphi_core.app import Stores, create_app
    from delphi_core.routers import chat as chat_router
    from tests.chat_keys import conversation_params

    config = Settings(data_dir=tmp_path, session_secret="artifact-route", openai_api_key="test-key",
                      artifact_renderer_path="/test/renderer")
    requests = []

    def frame(event):
        return "data: " + json.dumps(event) + "\n\n"

    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        outputs = [item for item in payload["input"] if item.get("type") == "function_call_output"]
        if not outputs:
            item = call("draw_display", draw(), "render")
            events = [{"type": "response.output_item.done", "item": item}]
        elif len(outputs) == 1:
            feedback, pixels = outputs[0]["output"]
            assert pixels == IMAGE
            assert [row for row in payload["input"] if row.get("role") == "user"] == [
                row for row in requests[0]["input"] if row.get("role") == "user"
            ]
            report, _ = json.JSONDecoder().raw_decode(feedback["text"])
            assert report["passed"]
            item = call("publish_artifact", {"artifact_id": report["artifact_id"], "revision": report["revision"],
                       "review": "Inspected both rendered views."}, "publish")
            events = [{"type": "response.output_item.done", "item": item}]
        else:
            reference = re.search(r"\[\[delphi-artifact:[^\]]+\]\]", outputs[-1]["output"])[0]
            answer = f"The pipeline connects A to B.\n{reference}\n"
            events = [{"type": "response.output_text.delta", "delta": answer},
                      {"type": "response.output_item.done", "item": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": answer}]}}]
        events.append({"type": "response.completed", "response": {"status": "completed"}})
        return httpx.Response(200, content="".join(frame(event) for event in events))

    real_client = httpx.AsyncClient
    monkeypatch.setattr(chat_router.httpx, "AsyncClient", lambda *args, **kwargs: real_client(
        *args, **{**kwargs, "transport": httpx.MockTransport(handler)}))
    monkeypatch.setattr(chat_router, "ArtifactSession", lambda settings, **kwargs: ArtifactSession(settings, passing, **kwargs))
    app = create_app(config, stores=Stores.local())
    with TestClient(app) as client:
        client.post("/api/auth/register", json={"username": "reader", "password": "password-test"})
        conversation = conversation_params(client, "general")
        response = client.post("/api/chat/stream", json={**conversation, "prompt": "Explain the pipeline", "request_id": "artifact_route_1"})
        assert response.status_code == 200, response.text
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        assert events[-1]["type"] == "done" and not events[-1].get("incomplete")
        delivered = "".join(event["text"] for event in events if event["type"] == "delta").strip()
        messages = client.get("/api/chat", params=conversation).json()["messages"]
        assert messages[0]["content"] == "Explain the pipeline"
        assert messages[-1]["content"] == delivered and SOURCE in delivered
        assert "[[delphi-artifact:" not in delivered
        assert SOURCE not in json.dumps(messages[-1].get("trace"))
        assert "# Inline visual explanations" in requests[0]["instructions"]
        assert "# Inline visual explanations" not in json.dumps(requests[0]["input"])


@pytest.mark.parametrize("valid_plan", [False, True])
def test_plan_clarifications_cannot_bypass_artifact_validation(tmp_path, monkeypatch, valid_plan):
    from fastapi.testclient import TestClient
    from delphi_core.app import Stores, create_app, get_current_user
    from delphi_core.routers import chat
    from delphi_core.storage import LocalObjectStore, LocalStorage
    from delphi_core_testkit.conformance.plans import answer as plan_answer, request as plan_request

    config = Settings(_env_file=None, data_dir=tmp_path, openai_api_key="test",
                      artifact_renderer_path="/test/renderer")
    storage = LocalStorage(config)
    storage.create_account("reader", None, "salt", "hash")
    objects = LocalObjectStore(tmp_path)
    body = plan_request(storage)

    async def respond(client, payload, toolset, budget, context, **kwargs):
        assert context.artifacts is None
        assert "draw_display" not in toolset.names and "publish_artifact" not in toolset.names
        body._plan = {"token": re.search(r"Plan fence label for this turn: delphi_plan_([^\]]+)", json.dumps(payload["input"]))[1]}
        text = plan_answer(body) if valid_plan else "Which baseline?\n```delphi-artifact Unchecked\n<script>bad()</script>\n```\n"
        for event in kwargs["recorder"].answered(text):
            yield event
        yield {"type": "delta", "text": text}

    monkeypatch.setattr(chat, "run_turn", respond)
    app = create_app(config, stores=Stores(storage=lambda _: storage, objects=lambda _: objects))
    app.dependency_overrides[get_current_user] = lambda: "reader"
    try:
        with TestClient(app) as client:
            response = client.post("/api/chat/stream", json=body.model_dump())
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
            assert events[-1]["type"] == "done", response.text
            stored = storage.get_conversation("reader", body.conversation_id)["messages"][-1]
            delivered = "".join(event["text"] for event in events if event["type"] == "delta").strip()
            assert stored["content"] == delivered
            assert "delphi-artifact" not in delivered and "bad()" not in delivered
            if valid_plan:
                assert stored["plan"]["id"] and delivered.startswith("Saved [")
                assert FALLBACK.strip() not in delivered
            else:
                assert "Which baseline?" in delivered and FALLBACK.strip() in delivered
                assert "plan" not in stored
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_schema_rejected_artifact_attempt_still_gets_terminal_fallback():
    config = Settings(artifact_renderer_path="/test/renderer")
    session = ArtifactSession(config, passing)
    provider = Provider(lambda round_: [call("draw_display", draw(spec="x" * 128_001), "invalid")] if round_ == 1 else ["The explanation is A to B."])
    events = [event async for event in run_turn(provider, {"input": []}, Toolset([DEFAULTS["draw_display"]]),
               TurnBudget.for_chat(config), ToolContext(config, artifacts=session))]
    answer = "".join(event["text"] for event in events if event["type"] == "delta")
    assert session.attempted and not session.drafts
    assert "The explanation is A to B." in answer and FALLBACK in answer
    assert "Error:" in next(item["output"] for item in provider.requests[1]["input"] if item.get("type") == "function_call_output")


@pytest.mark.asyncio
async def test_legacy_plan_opt_out_disables_artifacts_but_keeps_the_delivery_gate():
    from delphi_core.routers.chat import toolset_for_scope
    from delphi_core.schemas import ChatRequest
    config = Settings(artifact_renderer_path="/test/renderer")
    body = ChatRequest(scope="general", prompt="Plan an experiment", disable_artifacts=True)
    offered = toolset_for_scope(config, body)
    assert "draw_display" not in offered.names and "publish_artifact" not in offered.names
    assert body.mode == "chat"
    session = ArtifactSession(config, passing, enabled=False)
    assert not session.enabled
    provider = Provider(lambda _: ["Clarification.\n```delphi-artifact Forbidden\n<script>bad()</script>\n```\n"])
    events = [event async for event in run_turn(provider, {"input": []}, offered, TurnBudget.for_chat(config),
              ToolContext(config, artifacts=session))]
    answer = "".join(event["text"] for event in events if event["type"] == "delta")
    assert "Clarification." in answer and FALLBACK in answer and "bad()" not in answer


@pytest.mark.asyncio
async def test_feedback_preserves_bounded_observed_control_state_and_header_overlap():
    async def observed(*args):
        return RenderReport(True, image=IMAGE, views=[{"host": {"geometry": {"headerOccludesBody": False}}}],
                            interactions=[{"action": "set", "target": "#weight", "passed": True, "stateText": "value " * 200}] * 8)
    session = ArtifactSession(settings(), observed)
    result, _ = await session.render("Controls", HTML, "", [])
    feedback, _ = json.JSONDecoder().raw_decode(result)
    assert len(feedback["interactions"]) == 6
    assert len(feedback["interactions"][0]["stateText"]) == 500
    assert feedback["views"][0]["header"]["headerOccludesBody"] is False
