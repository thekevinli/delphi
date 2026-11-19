"""Turn-local drafts: rendering is evidence; publication names those exact bytes.

No draft writes Memory or a shared store. The existing chat writer persists only
the source released through Delivery, so failed attempts and screenshot data do
not enter saved conversations or their traces.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from . import display
from .types import SOURCE_MAX, RenderReport

Renderer = Callable[[Any, str, str, list[dict[str, str]]], Awaitable[RenderReport]]


def _fields(value: dict[str, Any], names: tuple[str, ...]) -> dict[str, Any]:
    return {name: item[:400] if isinstance(item, str) else item
            for name in names if isinstance(item := value.get(name), (str, int, float, bool)) and item != ""}


def _review(need: str, artifact_id: str, left: int) -> str:
    """After a passing display: judge it against the need it was drawn for; clean checks alone do not end the loop."""
    named = f" ({' '.join(need.split())})" if need.strip() else ""
    check = (f"The checks passed; now judge the views against the need you named{named}, facts and completeness before looks. "
             "Would a reader get the answer from the figure alone? Every part and stage the need and the source name is drawn, with what passes between them; "
             "an order the need names is steps; a setting the need names is a control; nothing drawn contradicts the evidence.")
    if left <= 0:
        return check + " This was the last attempt: publish it with publish_artifact in a later round if it shows the need, and say in prose what it leaves out; otherwise explain the idea in prose."
    return (check + f" If any of that is missing or wrong, call draw_display with artifact_id {artifact_id} and the complete corrected spec ({left} attempt{'s' if left > 1 else ''} left). "
            "Only when it shows the need, publish this exact revision with publish_artifact in a later round with a concise review. Do not rerender for restyling alone.")


def _feedback(report: RenderReport) -> dict[str, Any]:
    """Keep valid structured feedback without duplicating the DOM in model input."""
    views = []
    for view in report.views[:4]:
        document = view.get("document") or {}
        views.append({
            **_fields(view, ("width",)),
            "geometry": _fields(document, ("width", "height", "scrollWidth", "scrollHeight", "visualCount")),
            "header": _fields((view.get("host") or {}).get("geometry") or {}, ("progressFits", "headerContained", "headerVisible", "headerOccludesBody", "overflow")),
            "labels": [_fields(label, ("text", "size")) for label in document.get("text", [])[:8]],
        })
    return {
        "passed": report.passed,
        "diagnostics": [_fields(row, ("code", "severity", "message", "width", "target")) for row in report.diagnostics[:12]],
        "views": views,
        "interactions": [{**_fields(row, ("action", "target", "expect_target", "expect_text", "passed", "error", "probe", "nextChanged")),
                          **({"stateText": row["stateText"][:500]} if isinstance(row.get("stateText"), str) else {})}
                         for row in report.interactions[:6]],
        "elapsed_ms": report.elapsed_ms, "renderer_version": report.renderer_version[:128],
    }


# What the trace says a failed draft needs, from its first error.
_REASONS = {
    "dead_control": "control did nothing", "dead_header_control": "control did nothing",
    "wrong_value": "wrong value", "back_state": "Back broke a step", "reset_state": "Reset broke a step",
    "horizontal_overflow": "too wide", "host_overflow": "too wide", "clipped_content": "content clipped",
    "svg_label_clipped": "labels clipped", "small_text": "text too small", "blank_artifact": "nothing drawn",
    "runtime_error": "script error", "console_error": "script error", "boundary_error": "script error",
    "sticky_header": "header lost", "header_layout": "header cramped", "header_occludes_body": "header covers diagram",
    "network_blocked": "request blocked", "csp_violation": "request blocked", "nested_frame": "nested frame",
    "overlap": "parts overlap", "math_error": "math not typeset", "dead_step": "a step changes nothing",
    "title_clipped": "title cut off",
}


def _reason(report: RenderReport) -> str:
    codes = [row.get("code") for row in report.diagnostics if row.get("severity") == "error"]
    if any(code in _REASONS for code in codes):
        return f" ({next(_REASONS[code] for code in codes if code in _REASONS)})"
    return " (check failed)" if any(row.get("passed") is False for row in report.interactions) else ""


@dataclass
class Draft:
    title: str
    source: str
    revision: int
    rendered_round: int
    report: RenderReport
    published: bool = False
    delivered: bool = False

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.source.encode()).hexdigest()


class ArtifactSession:
    """One chat turn's drafts and inspection boundary; never shared across users."""

    def __init__(self, settings: Any, renderer: Renderer | None = None, *, enabled: bool = True) -> None:
        self.settings = settings
        self.renderer = renderer
        self.permitted = enabled
        self.round = 0
        #: The last round that read a source. A draft rendered then or before it
        #: was drawn without that evidence.
        self.read_round = -1
        self.drafts: dict[str, Draft] = {}
        self.attempted = False

    @property
    def enabled(self) -> bool:
        return self.permitted and bool(self.settings.artifact_renderer_path)

    async def render(self, title: str, source: str, artifact_id: str, checks: list[dict[str, str]], *, library: bool = False, need: str = "") -> tuple[str, dict[str, Any] | None]:
        self.attempted = True
        if not self.enabled:
            return "Error: artifact rendering is unavailable. Explain the concept in prose.", None
        if not library and display.is_display(source):
            # The reader draws this as a display; only draw_display checks it as one.
            return "Error: this is a display spec; draw it with draw_display, which checks every step before rendering.", None
        if not title.strip() or len(title) > 160 or re.search(r"[\r\n`\x00-\x1f\x7f]", title):
            return "Error: use a short plain-text title, without newlines or backticks.", None
        old = self.drafts.get(artifact_id)
        # The same draft sent again under its id is a recheck of the stored one, free after a source read.
        if old is not None and source == old.source and title == old.title:
            source = ""
        if artifact_id and old is None:
            return "Error: unknown artifact_id; use an empty id for a new diagram.", None
        if old and old.delivered:
            return "Error: this visualization was already delivered. Create a new artifact for a revision.", None
        # An empty source reuses this turn's named draft. A recheck still goes
        # through the renderer and invalidates any prior publication below;
        # rechecking a passed draft against a source read since costs no attempt.
        recheck = source == "" and old is not None and old.report.passed and old.rendered_round <= self.read_round
        if source == "" and old is not None:
            source = old.source
        if not source.strip() or len(source) > SOURCE_MAX:
            return f"Error: the draft is empty or longer than {SOURCE_MAX} characters.", None
        maximum = min(2, self.settings.artifact_max_artifacts)
        if old is None and len(self.drafts) >= maximum:
            return "Error: this turn already has its allowed visualizations. Repair an existing draft instead.", None
        revision = old.revision + (0 if recheck else 1) if old else 1
        if revision > min(3, self.settings.artifact_max_attempts):
            return "Error: this artifact has exhausted its draft attempts. Explain what could not be completed.", None
        if not artifact_id:
            artifact_id = "a_" + uuid.uuid4().hex[:16]
        # Invalidate an earlier pass before awaiting the new render. A failure
        # cannot accidentally publish the previous draft as this revision.
        draft = Draft(title, source, revision, self.round, RenderReport(False))
        self.drafts[artifact_id] = draft
        renderer = self.renderer
        if renderer is None:
            from .render import render_artifact
            renderer = render_artifact
        try:
            report = await asyncio.wait_for(
                renderer(self.settings, title, source, checks),
                timeout=max(0.001, self.settings.artifact_render_timeout_seconds),
            )
        except TimeoutError:
            report = RenderReport(False, [{"message": "Rendering exceeded its time allowance. Simplify the draft and try again."}])
        except Exception:
            # Worker errors may contain source or local paths. Only the
            # renderer's structured diagnostics cross back to the model.
            report = RenderReport(False, [{"message": "The renderer could not complete this draft. Simplify it and try again."}])
        if report.passed and report.image is None:
            report = RenderReport(False, [{"message": "No screenshot was returned; visual inspection is required before publication."}])
        draft.report = report
        details = {
            "artifact_id": artifact_id, "revision": revision, "sha256": draft.digest,
            **_feedback(report),
        }
        # Keep JSON whole. Renderer text and nested DOM summaries are bounded
        # above; unusually verbose diagnostics lose labels, never identifiers.
        if len(json.dumps(details, ensure_ascii=False)) > 16_000:
            details["views"] = [{key: value for key, value in view.items() if key != "labels"} for view in details["views"]]
            details["diagnostics"] = details["diagnostics"][:8]
        feedback = json.dumps(details, ensure_ascii=False)
        if report.passed and display.is_display(source):
            instruction = _review(need, artifact_id, min(3, self.settings.artifact_max_attempts) - revision)
        elif report.passed:
            instruction = "Inspect the attached rendered view and interaction results. If there is no concrete correctness, readability, layout or control defect, call publish_artifact with this exact revision and a concise visual review now. Do not rerender for optional cosmetic changes."
        elif display.is_display(source):
            instruction = "This display cannot be published. Read the diagnostics (each names the width, step and part) and the screenshot, then call draw_display with this artifact_id and the corrected complete spec. Make room for what is cut off without dropping a fact (move detail into a tip, give a row fewer parts, change the layout), separate what overlaps, and make every step change what it describes."
        else:
            instruction = "This card cannot be published. Inspect the diagnostics and screenshot; call embed_figure again with this artifact_id and a shorter title, or describe the figure in prose."
        return ("" if report.passed else f"Error: artifact validation failed{_reason(report)}.\n") + feedback + "\n" + instruction, report.image

    async def draw(self, spec: str, artifact_id: str, need: str = "") -> tuple[str, dict[str, Any] | None, bool]:
        """A library display: a spec the schema refuses costs no attempt and replaces no draft."""
        try:
            raw, source = display.validate(spec)
        except display.DisplayError as error:
            self.attempted = True
            return ("Error: the display spec was refused before rendering, so no attempt was spent. Fix every point and call draw_display again"
                    + (" with the same artifact_id" if artifact_id else "") + ":\n- " + "\n- ".join(error.reasons)), None, True
        text, image = await self.render(display.plain_title(raw["title"]), source, artifact_id, [], library=True, need=need)
        return text, image, False

    def publish(self, artifact_id: str, revision: int, review: str) -> str:
        draft = self.drafts.get(artifact_id)
        if draft is None or revision != draft.revision:
            return "Error: unknown or stale artifact revision. Publish only the latest rendered revision."
        if not draft.report.passed or draft.report.image is None:
            return "Error: this draft has not passed rendering and visual feedback. Repair and render it first."
        if self.round <= draft.rendered_round:
            return "Error: inspect the render result in your next model round before publishing; a render and publish in the same batch is not inspection."
        if draft.rendered_round <= self.read_round:
            again = "draw_display with the same spec and artifact_id" if display.is_display(draft.source) else "embed_figure with the same figure, title and artifact_id"
            return f"Error: a source was read in or after the round that rendered this draft. Check the draft against it, then render again before publishing; {again} rechecks it unchanged without spending an attempt."
        if not review.strip():
            return "Error: describe what you checked in the rendered view before publishing."
        draft.published = True
        return (f"Published {artifact_id} revision {revision} (sha256 {draft.digest}). "
                f"Place this exact reference in its own paragraph, separated by blank lines, outside lists, quotes and code examples: [[delphi-artifact:{artifact_id}:{revision}]]. "
                "Do not repeat or rewrite it. The server inserts the inspected source.")

    def release(self, artifact_id: str, revision: int) -> str | None:
        draft = self.drafts.get(artifact_id)
        if draft is None or revision != draft.revision or not draft.published or draft.delivered:
            return None
        draft.delivered = True
        # A backtick run inside JS or prose must not close the outer fence.
        width = max([2, *(len(match[0]) for match in re.finditer(r"`+", draft.source))]) + 1
        marker = "`" * width
        return f"{marker}delphi-artifact {draft.title}\n{draft.source}\n{marker}\n"
