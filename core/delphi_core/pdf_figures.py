"""
Read the figures back out of a stored PDF.

`pdf_compress.py` already walks `/XObject` → `/Subtype /Image` and decodes with
`pikepdf.PdfImage` + PIL, in order to *rewrite* them. This module used to reuse
that walk read-only and take the largest decoded image on a page. That works for
a paper whose figure *is* one JPEG — Chimera's plots — and fails for the three
shapes that dominate modern arXiv PDFs:

1. A soft-masked image whose transparent pixels sit on black in the colour
   stream. Dropping `/SMask` and converting to RGB paints those pixels black,
   which is how Seedance's architecture diagram arrived with a black canvas
   and invisible black connectors.
2. A figure that is a Form XObject: soft-masked colour panels, vector arrows,
   and text labels drawn together. The largest nested Image is then a solid
   rounded rectangle — UNITE's "Generative Encoder" card with none of the
   diagram around it.
3. A figure drawn mostly as vectors and shadings, with Image XObjects only as
   soft-masked fill layers. Taking those layers alone produces DeepSeek's
   blue triangle "glitch".

The fix is to *render* the page (via PDFium) and crop to the largest Form or
Image page object. That is what a PDF viewer shows, softmasks and vectors
included. The XObject walk remains as a fallback for pages PDFium cannot
describe, and when it runs it composites `/SMask` onto white so transparency
survives.

Nothing here writes to the document — the file is opened, read, and closed —
so a capture failure can never damage a paper.
"""

from __future__ import annotations

import logging
import hashlib
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Below this, on either side, an image is a rule, a bullet, a logo or a piece of
# a stitched background — never a figure worth remembering. Applied both to
# decoded XObject pixels and to rendered page-object bounds (in points for the
# latter, after multiplying by the render scale for pixels).
MIN_FIGURE_SIDE = 120
# A page-filling scan of a text page is not a figure either. Anything whose
# aspect ratio is this extreme is a banner or a divider.
MAX_ASPECT = 12.0
# Render scale for page crops. 2.5× gives ~180 dpi on a letter page — enough
# for labels in an architecture diagram without blowing the WebP budget.
RENDER_SCALE = 2.5
# A whole-page render never exceeds this many pixels, whatever size the page
# claims to be: a crafted 200-inch page at 2.5x would otherwise take gigabytes.
MAX_RENDER_PIXELS = 16_000_000
# A rendered Form/Image whose page-space short side is below this (in points)
# is a logo or an icon, not a figure. Kept below MIN_FIGURE_SIDE because the
# render scale multiplies it into pixels afterwards.
MIN_PAGE_OBJECT_SIDE = 72
# After soft-mask compositing, a near-solid fill still has few distinct colours
# — UNITE's encoder card is ~200. Real plots and photos sit far above this.
MIN_DISTINCT_COLORS = 512
_CAPTIONED_ELEMENT = re.compile(
    r"^\s*(?P<kind>Table|Algorithm|Alg\.?)\s*(?P<number>[A-Za-z0-9.-]+)"
    r"\s*[.:)|]?\s+(?P<caption>.{4,300})",
    re.IGNORECASE,
)


def page_figures(
    path: Path,
    page_number: int,
    *,
    min_side: int = MIN_FIGURE_SIDE,
    limit: int = 8,
) -> list[dict[str, Any]]:
    """
    Decode the figures on one 1-based page, largest first.

    Prefers a PDFium render cropped to the largest Form or Image page object —
    that is the composed figure a reader sees. Falls back to the XObject walk
    with soft-mask compositing when the page has no such object (or PDFium is
    unavailable), filtering out near-solid fills so a decorative panel cannot
    outrank a real plot by area alone.

    Returns an empty list rather than raising for every failure below the
    caller's control: a missing library, an unreadable page, an image in a
    colour space PIL cannot open. A figure that cannot be decoded downgrades the
    page to text, which is the state every Memory page was in before this
    module existed.
    """
    rendered = _render_page_figures(path, page_number, min_side=min_side, limit=limit)
    if rendered:
        return rendered
    return _xobject_figures(path, page_number, min_side=min_side, limit=limit)


def candidate_id(page_number: int, index: int, image) -> str:
    """A stable address for one rendered candidate, independent of object names."""
    sample = image.convert("L")
    if max(sample.size) > 256:
        sample = sample.copy()
        sample.thumbnail((256, 256))
    fingerprint = hashlib.sha256(sample.tobytes()).hexdigest()[:12]
    return f"pdf-p{page_number}-c{index}-{fingerprint}"


def inventory_candidates(
    path: Path,
    *,
    pages: list[int] | None = None,
    min_side: int = MIN_FIGURE_SIDE,
    max_pages: int = 40,
    per_page: int = 8,
) -> list[dict[str, Any]]:
    """Build the bounded visual inventory used by every model-facing selector.

    The ID is computed from the crop Delphi will later store. Selection and
    capture therefore cannot drift onto a different XObject merely because it
    happens to be larger on the same page.
    """
    selected_pages = (
        pages if pages is not None else figure_pages_or_empty(path, limit=max_pages)
    )[:max_pages]
    found: list[dict[str, Any]] = []
    duplicate_of: dict[str, str] = {}
    for page_number in selected_pages:
        for index, figure in enumerate(
            page_figures(path, page_number, min_side=min_side, limit=per_page)
        ):
            image = figure["image"]
            identifier = candidate_id(page_number, index, image)
            digest = hashlib.sha256(image.convert("RGB").tobytes()).hexdigest()
            item = {
                "id": identifier,
                "kind": "figure",
                "page": page_number,
                "candidateIndex": index,
                "name": figure.get("name", ""),
                "width": int(figure.get("width") or image.width),
                "height": int(figure.get("height") or image.height),
                "bbox": figure.get("bbox"),
                "sha256": digest,
                "duplicateOf": duplicate_of.get(digest),
                "isQrOrBarcode": detect_qr_or_barcode(image),
            }
            duplicate_of.setdefault(digest, identifier)
            found.append(item)
    return found


def select_candidate(path: Path, identifier: str) -> dict[str, Any] | None:
    """Resolve an inventory ID back to the exact crop it named."""
    if identifier.startswith("pdf-caption-"):
        return next(
            (
                candidate
                for candidate in captioned_element_candidates(path)
                if candidate["id"] == identifier
            ),
            None,
        )
    match = re.fullmatch(
        r"pdf-p([1-9][0-9]*)-c([0-9]+)-[0-9a-f]{12}", identifier
    )
    if match is None:
        return None
    page_number, wanted = int(match.group(1)), int(match.group(2))
    figures = page_figures(path, page_number, limit=max(8, wanted + 1))
    if wanted >= len(figures):
        return None
    figure = figures[wanted]
    return figure if candidate_id(page_number, wanted, figure["image"]) == identifier else None


def captioned_element_candidates(
    path: Path, *, max_pages: int = 40, limit: int = 32
) -> list[dict[str, Any]]:
    """Inventory deterministic table/algorithm crops around printed captions."""
    try:
        from pypdf import PdfReader
    except ImportError:
        return []
    found: list[dict[str, Any]] = []
    try:
        reader = PdfReader(str(path))
        for page_number, page in enumerate(reader.pages[:max_pages], 1):
            width = float(page.mediabox.width)
            height = float(page.mediabox.height)
            fragments: list[tuple[str, float, float, float]] = []

            def visitor(text, _cm, tm, _font, font_size):
                cleaned = " ".join(str(text or "").split())
                if cleaned:
                    fragments.append((cleaned, float(tm[4]), float(tm[5]), float(font_size)))

            page.extract_text(visitor_text=visitor)
            for text, _x, y, font_size in fragments:
                match = _CAPTIONED_ELEMENT.match(text)
                if match is None:
                    continue
                kind = (
                    "table"
                    if match.group("kind").casefold().startswith("table")
                    else "algorithm"
                )
                caption = " ".join(match.group("caption").split())[:300]
                # Scientific table and algorithm captions conventionally sit
                # immediately above the element. The crop is a bounded portion
                # of that exact page, and its coordinates are part of the ID.
                bbox = [
                    width * 0.04,
                    max(0.0, y - height * 0.42),
                    width * 0.96,
                    min(height, y + max(18.0, font_size * 2.0)),
                ]
                image = _render_bbox(path, page_number, bbox)
                if image is None or min(image.size) < MIN_FIGURE_SIDE:
                    continue
                raw = "\0".join(
                    [
                        str(page_number),
                        kind,
                        match.group("number"),
                        caption,
                        *(f"{value:.2f}" for value in bbox),
                    ]
                )
                identifier = "pdf-caption-" + hashlib.sha256(
                    raw.encode("utf-8")
                ).hexdigest()[:16]
                digest = hashlib.sha256(image.convert("RGB").tobytes()).hexdigest()
                found.append(
                    {
                        "id": identifier,
                        "kind": kind,
                        "page": page_number,
                        "caption": caption,
                        "bbox": bbox,
                        "width": image.width,
                        "height": image.height,
                        "sha256": digest,
                        "duplicateOf": None,
                        "isQrOrBarcode": False,
                        "capturable": True,
                        "image": image,
                    }
                )
                if len(found) >= limit:
                    return found
    except Exception:
        logger.warning("could not inventory captioned PDF elements", exc_info=True)
    return found


def _render_scale(page_width: float, page_height: float) -> float:
    return min(RENDER_SCALE, (MAX_RENDER_PIXELS / max(1.0, page_width * page_height)) ** 0.5)


def _render_bbox(path: Path, page_number: int, bbox: list[float]):
    try:
        import pypdfium2 as pdfium
    except ImportError:
        return None
    document = None
    try:
        document = pdfium.PdfDocument(str(path))
        page = document[page_number - 1]
        page_width, page_height = page.get_size()
        scale = _render_scale(page_width, page_height)
        rendered = page.render(scale=scale).to_pil().convert("RGB")
        left, bottom, right, top = bbox
        return rendered.crop(
            (
                max(0, int(left * scale)),
                max(0, int((page_height - top) * scale)),
                min(rendered.width, int(right * scale)),
                min(rendered.height, int((page_height - bottom) * scale)),
            )
        )
    except Exception:
        return None
    finally:
        if document is not None:
            document.close()


def detect_qr_or_barcode(image) -> bool:
    """Detect QR finder patterns and dense one-dimensional barcodes.

    This intentionally has no optional native dependency. QR finder patterns
    contain the scale-invariant dark/light run ratio 1:1:3:1:1 in both axes;
    requiring several cross-checked hits keeps ordinary plots and text from
    being classified as decoys. A separate transition-density check catches
    common linear barcodes without treating a ruled table as one.
    """
    from PIL import ImageOps

    gray = ImageOps.grayscale(image)
    if max(gray.size) > 640:
        gray.thumbnail((640, 640))
    # A midpoint threshold is deliberately deterministic. Finder patterns are
    # high contrast by design and do not need an adaptive computer-vision stack.
    pixels = gray.load()
    width, height = gray.size
    if width < 21 or height < 21:
        return False

    def line_runs(values: list[bool]) -> list[tuple[int, int, int]]:
        runs: list[tuple[bool, int, int]] = []
        start = 0
        current = values[0]
        for position, value in enumerate(values[1:], 1):
            if value == current:
                continue
            runs.append((current, start, position - start))
            current, start = value, position
        runs.append((current, start, len(values) - start))
        hits: list[tuple[int, int, int]] = []
        for index in range(2, len(runs) - 2):
            if not runs[index][0]:
                continue
            lengths = [runs[index + offset][2] for offset in (-2, -1, 0, 1, 2)]
            unit = sum(lengths) / 7.0
            tolerance = max(1.0, unit * 0.7)
            expected = (unit, unit, 3 * unit, unit, unit)
            if all(abs(actual - target) <= tolerance for actual, target in zip(lengths, expected)):
                centre = runs[index][1] + runs[index][2] // 2
                hits.append((centre, max(1, round(unit)), sum(lengths)))
        return hits

    horizontal: list[tuple[int, int, int]] = []
    row_step = max(1, height // 120)
    for y in range(0, height, row_step):
        for x, unit, span in line_runs([pixels[x, y] < 128 for x in range(width)]):
            horizontal.append((x, y, max(unit, span // 7)))
    cross_checked: list[tuple[int, int, int]] = []
    for x, y, unit in horizontal:
        column = line_runs([pixels[x, yy] < 128 for yy in range(height)])
        if any(abs(cy - y) <= max(3, unit * 2) for cy, _, _ in column):
            cross_checked.append((x, y, unit))

    # A diagram can accidentally contain three isolated 1:1:3:1:1 runs (box
    # borders and labelled arrows are especially good at this). A QR code has
    # a much stronger spatial signature: repeated hits cluster around three
    # finder squares whose centres form an L. Require that arrangement instead
    # of accepting any three cross-checked rows anywhere in the crop. This is
    # what keeps PixelDiT's architecture overview and sample grids available
    # while still rejecting the LM-loss payment QR regression.
    clusters: list[list[tuple[int, int, int]]] = []
    for point in cross_checked:
        x, y, unit = point
        for cluster in clusters:
            cx = sum(item[0] for item in cluster) / len(cluster)
            cy = sum(item[1] for item in cluster) / len(cluster)
            scale = max(unit, *(item[2] for item in cluster))
            if abs(x - cx) <= max(8, scale * 5) and abs(y - cy) <= max(8, scale * 5):
                cluster.append(point)
                break
        else:
            clusters.append([point])
    finders = [
        (
            sum(item[0] for item in cluster) / len(cluster),
            sum(item[1] for item in cluster) / len(cluster),
            max(item[2] for item in cluster),
        )
        for cluster in clusters
        if len(cluster) >= 2
    ]
    for ax, ay, au in finders:
        for bx, by, bu in finders:
            if (ax, ay) == (bx, by):
                continue
            horizontal_pair = (
                abs(ay - by) <= max(10, au * 6, bu * 6)
                and abs(ax - bx) >= max(24, au * 8, bu * 8)
            )
            if not horizontal_pair:
                continue
            for cx, cy, cu in finders:
                if (cx, cy) in {(ax, ay), (bx, by)}:
                    continue
                vertical_pair = (
                    abs(ax - cx) <= max(10, au * 6, cu * 6)
                    and abs(ay - cy) >= max(24, au * 8, cu * 8)
                )
                if vertical_pair:
                    return True

    # Linear barcode: many alternating narrow runs across several nearby rows,
    # with far fewer vertical transitions. Dense plots fail the anisotropy test.
    dense_rows = 0
    for y in range(0, height, max(1, height // 24)):
        values = [pixels[x, y] < 96 for x in range(width)]
        transitions = sum(a != b for a, b in zip(values, values[1:]))
        if transitions >= max(24, width // 8):
            dense_rows += 1
    dense_columns = 0
    for x in range(0, width, max(1, width // 24)):
        values = [pixels[x, y] < 96 for y in range(height)]
        transitions = sum(a != b for a, b in zip(values, values[1:]))
        if transitions >= max(24, height // 8):
            dense_columns += 1
    return dense_rows >= 4 and dense_rows >= dense_columns * 2 + 2


def figure_pages(
    path: Path,
    *,
    min_side: int = MIN_FIGURE_SIDE,
    limit: int = 40,
) -> list[int] | None:
    """
    Which 1-based pages hold at least one image that could be a figure, or
    `None` where neither scanner could read the file at all.

    That `None` is load-bearing and is not the same as `[]`. `[]` is the claim
    "this PDF holds no pictures", and a caller that trusts it refuses any
    figure page a model names; make it on a PDF nobody could open
    and the document captures nothing, for ever, exactly as in the incident
    below. Callers that cannot represent "unknown" should prefer it to a false
    empty.

    Prefers PDFium's page-object bounds (Form and Image) so a vector-drawn
    figure with no useful Image XObject still advertises itself — without this,
    the ingest prompt never learns the page exists and correctly declines to
    name a figure. Falls back to the XObject metadata walk (`/Width`,
    `/Height`, `/BitsPerComponent`, no decode) when PDFium is unavailable.

    This exists because of what happened without a scan at all. The ingest was
    told a PDF had "pages 1–20" and nothing about where its pictures were,
    while the same prompt forbids inventing a locator — so the model correctly
    declined to name any figure, and every ingest across a real twelve-document
    library captured zero. A model cannot cite evidence it was never shown.
    """
    pages = _render_figure_pages(path, limit=limit)
    if pages is not None:
        return pages
    return _xobject_figure_pages(path, min_side=min_side, limit=limit)


def figure_pages_or_empty(path: Path, **kwargs: Any) -> list[int]:
    """`figure_pages` for callers that only need pages to iterate over.

    Kept separate so that flattening "unknown" to "none" is a decision a
    caller makes out loud, rather than the default every caller inherits.
    """
    return figure_pages(path, **kwargs) or []


#: How long one PDFium pass may run in its child before it is killed. A
#: ceiling, not a wait — the child exits the moment it is done, so a generous
#: value costs a healthy PDF nothing and buys a 400-page one the seconds it
#: actually needs. Only a genuinely stuck pass pays it.
ISOLATION_TIMEOUT_SECONDS = 180.0

#: The tail of a crashed child's stderr kept in the log line. Enough for
#: PDFium's own abort message, which is the whole reason stderr is captured.
_STDERR_TAIL = 2000


def run_isolated(
    operation: str, payload: dict[str, Any], *, timeout: float | None = None
) -> Any | None:
    """
    Run one PDFium pass in a throwaway process, returning None if it dies.

    Every function in this module guards PDFium with `except Exception`, and
    every one of those guards is unable to catch the failure that actually
    happens. A PDF whose Type 1 font needs substituting sends PDFium scanning
    the system font folders, and it corrupts its own heap doing it:
    `CPDF_Type1Font::Load → CFX_FontMapper::FindSubstFont →
    CFX_FolderFontInfo::ScanPath → ___BUG_IN_CLIENT_OF_LIBMALLOC…`, then
    `abort()`. That is a native SIGABRT, so no Python handler runs and the
    whole interpreter goes. Both uses of this module, the source inventory and
    the capture of one figure, run on a live request, so on Cloud Run one bad
    upload took down the container and every request in flight on it.

    A child cannot be made not to abort; it can be made to be the only thing
    that dies. Returning None then means what it already meant everywhere
    upstream — "no figures here" — so no caller learns a boundary exists.

    `subprocess` rather than `multiprocessing`, following `browser_render`: it
    is the one place in this server that already knows how to spawn a child
    safely, and `spawn_clean` is why. `multiprocessing` offers no way to give
    the child that setup, and `ProcessPoolExecutor` additionally poisons
    itself permanently the first time a worker aborts, which is precisely the
    case this exists for.

    stderr is kept and logged, never `DEVNULL`. The first deploy that kept
    Chromium's stderr named its cause immediately after a day of guessing;
    the same argument applies to a library that prints why it aborted.
    """
    import json
    import os
    import signal
    import subprocess
    import sys
    import tempfile
    import time

    from .browser_render import kill_group, spawn_clean

    budget = ISOLATION_TIMEOUT_SECONDS if timeout is None else timeout
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="delphi-pdf-") as scratch:
        request = Path(scratch) / "request.json"
        response = Path(scratch) / "response.json"
        request.write_text(
            json.dumps({"operation": operation, "payload": payload}),
            encoding="utf-8",
        )
        errors = tempfile.TemporaryFile()
        process = spawn_clean(
            [sys.executable, "-m", "delphi_core.pdf_worker", str(request), str(response)],
            stdout=subprocess.DEVNULL,
            stderr=errors,
            cwd=str(Path(__file__).resolve().parent.parent),
        )
        try:
            code = process.wait(timeout=budget)
        except subprocess.TimeoutExpired:
            code = None
        finally:
            if process.poll() is None:
                kill_group(process, signal.SIGTERM)
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    kill_group(process, signal.SIGKILL)
                    process.wait(timeout=1)

        def _stderr_tail() -> str:
            try:
                errors.seek(0)
                return errors.read().decode("utf-8", "replace")[-_STDERR_TAIL:].strip()
            except Exception:
                return ""
            finally:
                errors.close()

        elapsed = round(time.monotonic() - started, 1)
        if code is None:
            logger.warning(
                "pdf %s: killed after %ss (limit %ss) — %s",
                operation,
                elapsed,
                budget,
                _stderr_tail() or "no stderr",
            )
            return None
        if code != 0 or not response.is_file():
            # A negative code is a signal, which is the abort this exists for.
            logger.warning(
                "pdf %s: child exited %s after %ss — %s",
                operation,
                code,
                elapsed,
                _stderr_tail() or "no stderr",
            )
            return None
        errors.close()
        try:
            body = json.loads(response.read_text(encoding="utf-8"))
        except ValueError:
            logger.warning("pdf %s: child wrote an unreadable response", operation)
            return None
        if body.get("error"):
            # The child raised a normal Python exception. That is a real
            # answer — "this PDF has no figures" — and the in-process code
            # would have logged and returned empty for it too.
            logger.warning("pdf %s: %s", operation, body["error"])
            return None
        return _decode_result(body.get("result"))


def _decode_result(value: Any) -> Any:
    """Turn the worker's JSON back into what the caller expects.

    Only bytes need help; `{"__bytes__": "<base64>"}` is the one wrapper, and
    tuples come back as lists, which every caller here unpacks positionally.
    """
    import base64

    if isinstance(value, dict):
        if set(value) == {"__bytes__"}:
            return base64.b64decode(value["__bytes__"])
        return {key: _decode_result(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_decode_result(item) for item in value]
    return value


def capture_candidate(
    path: Path, identifier: str, *, max_side: int
) -> tuple[bytes, int, int] | None:
    """Select one inventory candidate and encode it, in one call.

    Fused because the two halves used to be two `run_in_threadpool` hops with a
    live `PIL.Image` between them, and a live image cannot cross a process
    boundary. Selecting and encoding together means the only thing that leaves
    PDFium's company is WebP bytes — which is what lets `run_isolated` put the
    whole of it in a child. Both callers wanted exactly this pair anyway.
    """
    selected = select_candidate(path, identifier)
    if selected is None:
        return None
    return encode_figure(selected["image"], max_side)


def capture_page_figure(
    path: Path, page_number: int, label: str, opening: str = "", *, max_side: int
) -> tuple[bytes, int, int, bool] | None:
    """
    The figure a printed caption names, by its label ("Figure 2:") and its
    first words, and whether the crop is exact.

    Captions sit below their figures, so the figure is the nearest picture
    above that the caption's line overlaps, with no other caption between,
    and the unclaimed panels beside and above it: a grid comes back whole, and
    a picture another caption sits under never does. A figure drawn as vector art has no picture
    object; then the page region above the caption, up to the next caption, is
    returned, marked inexact, for the model to check. None when the caption is
    not found.
    """
    located = _caption_lines(path, page_number, label, opening)
    if located is None:
        return None
    caption, others, (page_width, page_height) = located
    left, right, top = caption

    def overlaps(box_left: float, box_right: float, line: tuple[float, float, float]) -> bool:
        return box_left < line[1] and box_right > line[0]

    def claimed(bbox: list[float], reached: bool) -> bool:
        # Another caption under the picture claims it: one between this caption
        # and a picture this line reaches, or any, for one it does not reach
        # (the next column's figure).
        return any(
            (top < other[2] or not reached) and other[2] <= bbox[1] + 6 and overlaps(bbox[0], bbox[2], other)
            for other in others
        )

    above = [figure for figure in page_figures(path, page_number, limit=16) if figure.get("bbox") and figure["bbox"][1] >= top - 6]
    reached = [figure for figure in above if overlaps(figure["bbox"][0], figure["bbox"][2], caption)]
    nearest = min((figure for figure in reached if not claimed(figure["bbox"], True)), key=lambda figure: figure["bbox"][1], default=None)
    if nearest is not None:
        # Panels: the unclaimed pictures beside and above the nearest one, up to a gap.
        panels = sorted(
            (figure for figure in above if figure is not nearest and not claimed(figure["bbox"], figure in reached)),
            key=lambda figure: figure["bbox"][1],
        )
        chosen, (box_left, box_bottom, box_right, box_top) = [nearest], nearest["bbox"]
        for figure in panels:
            if figure["bbox"][1] > box_top + 24:
                break
            chosen.append(figure)
            box_left, box_right = min(box_left, figure["bbox"][0]), max(box_right, figure["bbox"][2])
            box_top = max(box_top, figure["bbox"][3])
        if len(chosen) == 1:
            return (*encode_figure(chosen[0]["image"], max_side), True)
        panels = _render_bbox(path, page_number, [box_left - 2, box_bottom - 2, box_right + 2, box_top + 2])
        if panels is not None:
            return (*encode_figure(panels, max_side), True)
    start = page_width * (0.5 if left > page_width * 0.45 else 0.04)
    ceiling = min((other[2] for other in others if other[2] > top + 1 and overlaps(start, page_width * 0.96, other)), default=page_height)
    region = _render_bbox(path, page_number, [start, top + 2, page_width * 0.96, min(ceiling - 14, page_height * 0.96)])
    if region is None or min(region.size) < MIN_FIGURE_SIDE:
        return None
    return (*encode_figure(region, max_side), False)


_CAPTION_START = re.compile(r"(?:Figure|Fig\.)\s*\d+[A-Za-z]?\s*[.:|]", re.IGNORECASE)


def _caption_lines(path: Path, page_number: int, label: str, opening: str):
    """
    The caption `label` as (left, right, top) of its first line, the same for
    every other figure caption on the page, and the page's size. A caption
    starts a line or follows a sentence's end; a mention in a sentence does not.
    """
    try:
        import pypdfium2 as pdfium
    except ImportError:
        return None
    document = None
    try:
        document = pdfium.PdfDocument(str(path))
        if not 1 <= page_number <= len(document):
            return None
        page = document[page_number - 1]
        text = page.get_textpage()

        def starts(index: int) -> bool:
            before = text.get_text_range(max(0, index - 3), min(index, 3))
            return not before or before[-1] in "\r\n" or (before[-1] in " \t" and before.rstrip()[-1:] in ".:)")

        def line(index: int) -> tuple[float, float, float]:
            # The caption's own first line: the runs on its baseline that
            # continue it, never a neighbouring column's text on the same line.
            ahead = text.get_text_range(index, 400)
            stop = min((ahead.find(mark) for mark in "\r\n" if mark in ahead), default=len(ahead))
            rects = [text.get_rect(n) for n in range(text.count_rects(index, max(1, stop)))]
            left, _, right, top = rects[0]
            for rect in rects[1:]:
                if abs(rect[3] - top) > 4 or rect[0] - right > 18:
                    break
                right = max(right, rect[2])
            return left, right, top

        def found(term: str) -> list[int]:
            searcher, hits = text.search(term), []
            while (hit := searcher.get_next()) is not None:
                hits.append(hit[0])
            return hits

        hits = (opening and found(f"{label} {opening}")) or found(label)
        if not hits:
            return None
        index = next((hit for hit in hits if starts(hit)), hits[0])
        others = [
            line(hit) for hit in found("Fig")
            if hit != index and starts(hit) and _CAPTION_START.match(text.get_text_range(hit, 24))
        ]
        return line(index), others, page.get_size()
    except Exception:
        logger.warning("could not find a caption in %s page %s", path.name, page_number, exc_info=True)
        return None
    finally:
        if document is not None:
            document.close()


def _render_page_figures(
    path: Path,
    page_number: int,
    *,
    min_side: int,
    limit: int,
) -> list[dict[str, Any]]:
    """Crop the rendered page to each large Form/Image page object."""
    try:
        import pypdfium2 as pdfium
        from pypdfium2 import raw as pdfium_c
    except ImportError:
        logger.warning("pypdfium2 unavailable; falling back to XObject figures")
        return []

    try:
        from PIL import Image
    except ImportError:
        return []

    Image.MAX_IMAGE_PIXELS = None
    found: list[dict[str, Any]] = []
    try:
        document = pdfium.PdfDocument(str(path))
    except Exception:
        logger.warning("could not open %s with PDFium", path.name, exc_info=True)
        return []

    try:
        if not 1 <= page_number <= len(document):
            return []
        page = document[page_number - 1]
        page_width, page_height = page.get_size()
        candidates = _page_figure_bounds(page, pdfium_c)
        if not candidates:
            return []
        # One render shared by every crop on the page — the expensive step.
        scale = _render_scale(page_width, page_height)
        rendered = page.render(scale=scale).to_pil().convert("RGB")
        pad = max(2, int(4 * scale))
        for index, (area, left, bottom, right, top) in enumerate(candidates):
            if len(found) >= limit:
                break
            box = (
                max(0, int(left * scale) - pad),
                max(0, int((page_height - top) * scale) - pad),
                min(rendered.width, int(right * scale) + pad),
                min(rendered.height, int((page_height - bottom) * scale) + pad),
            )
            if box[2] - box[0] < min_side or box[3] - box[1] < min_side:
                continue
            crop = rendered.crop(box)
            # No complexity filter here: a Form the designer placed is already
            # a figure, even when it is mostly flat colour plus a few vectors.
            # The fill-vs-plot check belongs only on the XObject fallback, where
            # a soft-masked panel can outrank the diagram by pixel area.
            found.append(
                {
                    "name": f"/Render{index}",
                    "image": crop,
                    "width": crop.width,
                    "height": crop.height,
                    "area": area,
                    "bbox": [left, bottom, right, top],
                }
            )
    except Exception:
        logger.warning(
            "could not render figures from %s page %s",
            path.name,
            page_number,
            exc_info=True,
        )
        return []
    finally:
        document.close()

    found.sort(key=lambda figure: figure["area"], reverse=True)
    return [
        {"name": figure["name"], "image": figure["image"], "width": figure["width"], "height": figure["height"], "bbox": figure.get("bbox")}
        for figure in found[:limit]
    ]


def _render_figure_pages(path: Path, *, limit: int) -> list[int] | None:
    """Pages with a large Form/Image page object, or None if PDFium is missing."""
    try:
        import pypdfium2 as pdfium
        from pypdfium2 import raw as pdfium_c
    except ImportError:
        return None

    pages: list[int] = []
    try:
        document = pdfium.PdfDocument(str(path))
    except Exception:
        # `None`, not `[]`: a scan that *crashed* is a scan that did not
        # happen. Returning a list here told `figure_pages` the answer was
        # authoritative, so the XObject fallback below -- the one written for
        # the case where PDFium cannot read the file -- was skipped precisely
        # when it was needed, and the empty list went on to be read as "this
        # PDF holds no pictures" (invariant 36b).
        logger.warning("could not scan %s with PDFium", path.name, exc_info=True)
        return None

    try:
        for number in range(1, len(document) + 1):
            if len(pages) >= limit:
                break
            page = document[number - 1]
            if _page_figure_bounds(page, pdfium_c):
                pages.append(number)
    except Exception:
        logger.warning("could not scan %s for figures", path.name, exc_info=True)
        return None
    finally:
        document.close()
    return pages


def _page_figure_bounds(page, pdfium_c) -> list[tuple[float, float, float, float, float]]:
    """
    (area, left, bottom, right, top) for every large Form/Image on the page.

    Sorted largest-first. Depth 1 only: nested images inside a Form are part of
    that Form's bounds, and listing them separately would double-count the same
    figure as both the composition and its fragments.
    """
    import ctypes

    candidates: list[tuple[float, float, float, float, float]] = []
    for obj in page.get_objects(max_depth=1):
        if obj.type not in (
            pdfium_c.FPDF_PAGEOBJ_FORM,
            pdfium_c.FPDF_PAGEOBJ_IMAGE,
        ):
            continue
        left = ctypes.c_float()
        bottom = ctypes.c_float()
        right = ctypes.c_float()
        top = ctypes.c_float()
        if not pdfium_c.FPDFPageObj_GetBounds(
            obj.raw, left, bottom, right, top
        ):
            continue
        width = right.value - left.value
        height = top.value - bottom.value
        if width < MIN_PAGE_OBJECT_SIDE or height < MIN_PAGE_OBJECT_SIDE:
            continue
        longest, shortest = max(width, height), min(width, height)
        if shortest and longest / shortest > MAX_ASPECT:
            continue
        candidates.append(
            (width * height, left.value, bottom.value, right.value, top.value)
        )
    candidates.sort(reverse=True)
    return candidates


def _xobject_figures(
    path: Path,
    page_number: int,
    *,
    min_side: int,
    limit: int,
) -> list[dict[str, Any]]:
    """Fallback: decode Image XObjects with soft-mask compositing."""
    try:
        import pikepdf
        from PIL import Image
    except ImportError:
        logger.warning("pikepdf/Pillow unavailable; no figures can be captured")
        return []

    Image.MAX_IMAGE_PIXELS = None
    found: list[dict[str, Any]] = []
    try:
        with pikepdf.open(path) as pdf:
            if not 1 <= page_number <= len(pdf.pages):
                return []
            page = pdf.pages[page_number - 1]
            for name, obj in _image_xobjects(pikepdf, page):
                decoded = _decode(pikepdf, Image, obj, min_side)
                if decoded is not None:
                    found.append({"name": str(name), **decoded})
    except Exception:
        logger.warning(
            "could not read figures from %s page %s", path.name, page_number, exc_info=True
        )
        return []
    found.sort(key=lambda figure: figure["width"] * figure["height"], reverse=True)
    return found[:limit]


def _xobject_figure_pages(
    path: Path,
    *,
    min_side: int,
    limit: int,
) -> list[int] | None:
    """Fallback figure-page scan: Image XObject dimensions only.

    `None` where this could not look at all, for the same reason
    `_render_figure_pages` returns it.
    """
    try:
        import pikepdf
    except ImportError:
        logger.warning("pikepdf unavailable; no figures can be captured")
        return None

    pages: list[int] = []
    try:
        with pikepdf.open(path) as pdf:
            for number, page in enumerate(pdf.pages, start=1):
                if len(pages) >= limit:
                    break
                if any(
                    _looks_like_figure(obj, min_side)
                    for _, obj in _image_xobjects(pikepdf, page)
                ):
                    pages.append(number)
    except Exception:
        logger.warning("could not scan %s for figures", path.name, exc_info=True)
        return None
    return pages


def _looks_like_figure(obj, min_side: int) -> bool:
    """The dimension checks from `_decode`, without paying to decode."""
    try:
        width, height = int(obj.Width), int(obj.Height)
        bits = int(obj.get("/BitsPerComponent", 8))
    except Exception:
        return False
    if width < min_side or height < min_side or bits == 1:
        return False
    longest, shortest = max(width, height), min(width, height)
    return bool(shortest) and longest / shortest <= MAX_ASPECT


def _image_xobjects(pikepdf, page, depth: int = 0):
    """
    Every image reachable from one page, including through form XObjects.

    A figure produced by a vector-drawing tool is routinely wrapped in a form
    XObject rather than placed directly, so walking only the page's own
    resources finds the decorations and misses the diagram. The recursion is
    depth-bounded because a malformed document can make the graph cyclic.
    """
    resources = page.get("/Resources")
    xobjects = resources.get("/XObject") if resources is not None else None
    if xobjects is None:
        return
    for name, obj in xobjects.items():
        if not isinstance(obj, pikepdf.Stream):
            continue
        subtype = obj.get("/Subtype")
        if subtype == pikepdf.Name("/Image"):
            yield name, obj
        elif subtype == pikepdf.Name("/Form") and depth < 3:
            yield from _image_xobjects(pikepdf, obj, depth + 1)


def _decode(pikepdf, Image, obj, min_side: int) -> dict[str, Any] | None:
    """One image as RGB pixels, or None when it is not a figure worth keeping."""
    try:
        width, height = int(obj.Width), int(obj.Height)
    except Exception:
        return None
    if width < min_side or height < min_side:
        return None
    longest, shortest = max(width, height), min(width, height)
    if shortest and longest / shortest > MAX_ASPECT:
        return None
    try:
        image = pikepdf.PdfImage(obj)
        # A bitonal image is a scan of text, not a figure: keeping one would
        # store a picture of a paragraph the model can already read.
        if image.bits_per_component == 1:
            return None
        pil = image.as_pil_image()
    except Exception:
        return None
    try:
        pil = _composite_soft_mask(pikepdf, Image, obj, pil)
    except Exception:
        return None
    if not _is_complex_enough(pil):
        return None
    return {"image": pil, "width": pil.width, "height": pil.height}


def _composite_soft_mask(pikepdf, Image, obj, pil):
    """
    Flatten a PDF image onto white, honouring `/SMask`.

    PDF expresses transparency as a separate greyscale soft mask, not as a PIL
    alpha channel — `as_pil_image()` returns the colour stream alone. Papers
    that draw diagrams on a transparent canvas routinely leave those pixels
    black (or some other flat key) in the colour stream; converting straight
    to RGB then keeps the key colour as a solid background and erases every
    black stroke that shared it. Compositing the soft mask onto white is what
    a viewer does, and what leaves Seedance's connectors visible.
    """
    smask = obj.get("/SMask")
    if isinstance(smask, pikepdf.Stream):
        rgba = pil.convert("RGBA")
        mask = pikepdf.PdfImage(smask).as_pil_image().convert("L")
        if mask.size != rgba.size:
            mask = mask.resize(rgba.size, Image.Resampling.BILINEAR)
        red, green, blue, _alpha = rgba.split()
        rgba = Image.merge("RGBA", (red, green, blue, mask))
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.split()[3])
        return background
    # No soft mask: still go through RGB so Indexed / CMYK sources match what
    # we store. A PIL-native alpha channel is rare for PDF images and, when
    # present, is flattened onto white for the same reason as above.
    if pil.mode == "RGBA":
        background = Image.new("RGB", pil.size, (255, 255, 255))
        background.paste(pil, mask=pil.split()[3])
        return background
    return pil.convert("RGB")


def _is_complex_enough(pil) -> bool:
    """
    Reject near-solid fills that win on area but are not a figure.

    UNITE's Form wraps three page-sized soft-masked colour panels that are the
    encoder/decoder cards; ordered by area they beat every photo in the same
    Form. A few hundred distinct colours after compositing is a fill; a plot
    or a photo is orders of magnitude above.
    """
    # Bound the work: a downscaled copy is enough to tell a fill from a plot,
    # and getcolors on a multi-megapixel image is the cost we are avoiding.
    sample = pil
    if max(sample.size) > 400:
        sample = sample.copy()
        sample.thumbnail((400, 400))
    colors = sample.convert("RGB").getcolors(maxcolors=MIN_DISTINCT_COLORS)
    # getcolors returns None once the unique-colour count exceeds maxcolors —
    # that is exactly "complex enough".
    return colors is None or len(colors) >= MIN_DISTINCT_COLORS


#: A library card's box; a thumbnail is fitted inside it, never cropped to it.
THUMBNAIL_BOX = (360, 460)


def encode_thumbnail(pil) -> bytes:
    """A card's WebP. Shared by the PDF worker and the web capture so the two agree."""
    import io

    from PIL import Image

    pil.thumbnail(THUMBNAIL_BOX, Image.Resampling.LANCZOS)
    output = io.BytesIO()
    pil.convert("RGB").save(output, "WEBP", quality=82, method=6)
    return output.getvalue()


def encode_figure(pil, max_side: int) -> tuple[bytes, int, int]:
    """
    Bound and re-encode one decoded figure as metadata-free static WebP.

    The same treatment `viewport.py` gives an image off the open web, for the
    same reason: whatever the source, what Delphi stores and serves is something
    it encoded itself.
    """
    from PIL import Image

    if max(pil.size) > max_side:
        pil.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    from io import BytesIO

    output = BytesIO()
    pil.save(output, "WEBP", quality=82, method=6)
    return output.getvalue(), pil.width, pil.height
