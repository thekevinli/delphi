"""
Figure capture has to return what a viewer shows, not what the largest Image
XObject happens to be. These tests pin the three failure modes that shipped in
Memory's first version: soft-mask transparency flattened to black, a Form's colour
panel winning over the composed diagram, and a near-solid fill counting as a
figure by area alone.
"""

from __future__ import annotations

import os

import pikepdf
import pytest
from PIL import Image

from delphi_core.pdf_figures import (
    _composite_soft_mask,
    figure_pages_or_empty,
    _is_complex_enough,
    encode_figure,
    figure_pages,
    page_figures,
)


def _solid(width: int, height: int, color: tuple[int, int, int]) -> Image.Image:
    return Image.new("RGB", (width, height), color)


def test_a_soft_mask_is_composited_onto_white_not_left_black():
    """
    Seedance's failure mode: transparent pixels were black in the colour
    stream, and dropping /SMask kept them black.
    """
    # Colour stream is entirely black; the soft mask reveals a disc in the
    # middle. Without the mask the decode is a black rectangle; with it, the
    # outside must be paper-white.
    color = _solid(200, 200, (0, 0, 0))
    mask = Image.new("L", (200, 200), 0)
    for x in range(200):
        for y in range(200):
            if (x - 100) ** 2 + (y - 100) ** 2 <= 40**2:
                mask.putpixel((x, y), 255)

    pdf = pikepdf.new()
    stream = pikepdf.Stream(pdf, color.tobytes())
    stream.Type = pikepdf.Name("/XObject")
    stream.Subtype = pikepdf.Name("/Image")
    stream.Width, stream.Height = color.size
    stream.ColorSpace = pikepdf.Name("/DeviceRGB")
    stream.BitsPerComponent = 8
    mask_stream = pikepdf.Stream(pdf, mask.tobytes())
    mask_stream.Type = pikepdf.Name("/XObject")
    mask_stream.Subtype = pikepdf.Name("/Image")
    mask_stream.Width, mask_stream.Height = mask.size
    mask_stream.ColorSpace = pikepdf.Name("/DeviceGray")
    mask_stream.BitsPerComponent = 8
    stream.SMask = pdf.make_indirect(mask_stream)

    pil = _composite_soft_mask(pikepdf, Image, stream, color)
    assert pil.getpixel((10, 10)) == (255, 255, 255)
    assert pil.getpixel((100, 100)) == (0, 0, 0)


def test_a_near_solid_fill_is_not_a_figure():
    fill = _solid(400, 400, (40, 60, 90))
    assert not _is_complex_enough(fill)

    # Noise clears the bar — a photo or a plot has far more than a fill.
    noise = Image.frombytes("RGB", (400, 400), os.urandom(400 * 400 * 3))
    assert _is_complex_enough(noise)


def _composed_form_pdf(path):
    """A page whose visible figure is a Form: a soft panel plus vector strokes.

    UNITE's shape. The XObject walk would return the panel alone; the render
    path must return the composed Form. Shared by the render test and the
    process-isolation test so the two cannot drift onto different fixtures.
    """
    panel = _solid(400, 600, (30, 45, 70))

    pdf = pikepdf.new()
    image_stream = pikepdf.Stream(pdf, panel.tobytes())
    image_stream.Type = pikepdf.Name("/XObject")
    image_stream.Subtype = pikepdf.Name("/Image")
    image_stream.Width, image_stream.Height = panel.size
    image_stream.ColorSpace = pikepdf.Name("/DeviceRGB")
    image_stream.BitsPerComponent = 8

    # Form: paint the panel, then a contrasting diagonal the panel alone lacks.
    form_content = (
        b"q 200 0 0 300 20 20 cm /ImPanel Do Q "
        b"q 3 w 1 0 0 RG 20 20 m 220 320 l S Q "
        b"q 3 w 0 0.5 1 RG 20 320 m 220 20 l S Q"
    )
    form = pikepdf.Stream(pdf, form_content)
    form.Type = pikepdf.Name("/XObject")
    form.Subtype = pikepdf.Name("/Form")
    form.BBox = pikepdf.Array([0, 0, 240, 340])
    form.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(ImPanel=image_stream)
    )

    page = pdf.add_blank_page(page_size=(612, 792))
    page.Resources = pdf.make_indirect(
        pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fig=form))
    )
    page.Contents = pdf.make_indirect(
        pikepdf.Stream(pdf, b"q 1 0 0 1 100 200 cm /Fig Do Q")
    )
    pdf.save(path)
    return path


def test_page_figures_prefers_a_rendered_form_over_its_largest_panel(tmp_path):
    """
    UNITE's failure mode: the Form draws vectors and text around soft-masked
    colour panels; the largest nested Image is one panel alone.
    """
    pytest.importorskip("pypdfium2")

    path = _composed_form_pdf(tmp_path / "form.pdf")

    figures = page_figures(path, 1, min_side=50, limit=4)
    assert figures, "composed Form should be capturable"
    pil = figures[0]["image"]
    # The crop must cover the Form's placed size, not just the nested panel,
    # and must contain ink from the vector strokes (non-panel blue/cyan).
    assert pil.width > 150 and pil.height > 150
    pixels = list(pil.getdata())
    assert any(pixel != (30, 45, 70) and pixel != (255, 255, 255) for pixel in pixels)

    assert 1 in figure_pages(path)


def test_encode_figure_bounds_the_long_side():
    big = _solid(2000, 1000, (10, 20, 30))
    for x in range(0, 2000, 7):
        for y in range(0, 1000, 11):
            big.putpixel((x, y), ((x + y) % 256, x % 256, y % 256))
    payload, width, height = encode_figure(big, max_side=512)
    assert max(width, height) == 512
    assert payload[:4] == b"RIFF"


def test_an_unreadable_pdf_reports_unknown_rather_than_no_figures(tmp_path):
    """
    `[]` is the claim "this PDF holds no pictures", and a caller that trusts
    it refuses every figure page on the strength of it. Made about a file
    nobody could open, it is the invariant 36b incident with a different
    cause: the model is told the document has no figures, correctly declines
    to name one, and the document captures nothing for as long as it exists.
    A scan that could not run says so.
    """
    corrupt = tmp_path / "corrupt.pdf"
    corrupt.write_bytes(b"%PDF-1.7\nnot actually a pdf\n%%EOF\n")

    assert figure_pages(corrupt) is None
    # And a caller that only wants pages to loop over still gets a list, but
    # has to ask for that flattening by name.
    assert figure_pages_or_empty(corrupt) == []


def test_a_pdfium_failure_still_falls_back_to_the_xobject_walk(tmp_path, monkeypatch):
    """
    The XObject walk exists for the case where PDFium cannot read the file.
    Returning `[]` from the failure path is what stopped it ever running
    there, because `figure_pages` reads any list as authoritative and returns
    it -- so the one scanner that might still have found the figure was
    skipped precisely when it was needed.
    """
    picture = _solid(400, 300, (12, 34, 56))
    path = tmp_path / "one-figure.pdf"

    pdf = pikepdf.new()
    image_stream = pikepdf.Stream(pdf, picture.tobytes())
    image_stream.Type = pikepdf.Name("/XObject")
    image_stream.Subtype = pikepdf.Name("/Image")
    image_stream.Width, image_stream.Height = picture.size
    image_stream.ColorSpace = pikepdf.Name("/DeviceRGB")
    image_stream.BitsPerComponent = 8
    page = pdf.add_blank_page(page_size=(612, 792))
    page.Resources = pdf.make_indirect(
        pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fig=image_stream))
    )
    page.Contents = pdf.make_indirect(
        pikepdf.Stream(pdf, b"q 400 0 0 300 100 200 cm /Fig Do Q")
    )
    pdf.save(path)

    import delphi_core.pdf_figures as pdf_figures

    monkeypatch.setattr(pdf_figures, "_render_figure_pages", lambda *a, **k: None)
    assert figure_pages(path, min_side=100) == [1]


def test_a_pdfium_pass_runs_in_a_child_and_a_crash_is_not_ours(tmp_path):
    """PDFium can abort the interpreter, and no `except` can catch that.

    A PDF whose Type 1 font needs substituting sends PDFium scanning the system
    font folders, and it corrupted its own heap doing it — `CPDF_Type1Font::Load
    → CFX_FontMapper::FindSubstFont → CFX_FolderFontInfo::ScanPath →
    ___BUG_IN_CLIENT_OF_LIBMALLOC…`, then `abort()`. Both callers run on a live
    request, so on Cloud Run that took the container and every request in flight
    on it. The child cannot be made not to abort; it can be made the only thing
    that dies, and `None` is what every caller upstream already treats as "no
    figures here".
    """
    from delphi_core import pdf_figures

    # A child that exits non-zero is the shape a crash arrives in.
    assert pdf_figures.run_isolated("no-such-operation", {}) is None

    # A child that outlives its deadline is killed and reported the same way.
    # A budget below the interpreter's own start-up guarantees the overrun
    # without needing a PDF that genuinely hangs.
    path = _composed_form_pdf(tmp_path / "slow.pdf")
    assert (
        pdf_figures.run_isolated(
            "source_inventory",
            {"path": str(path), "extractedText": ""},
            timeout=0.001,
        )
        is None
    )

    # An absent file is not a crash — it is the ordinary "no figures here" the
    # in-process guards already answered with, and it must stay distinguishable
    # from one, or a real capture failure would look like an empty document.
    assert (
        pdf_figures.run_isolated(
            "source_inventory",
            {"path": str(tmp_path / "absent.pdf"), "extractedText": ""},
        )
        == []
    )


def test_the_isolated_capture_returns_exactly_what_the_in_process_one_did(tmp_path):
    """A process boundary that changes the bytes is a new bug, not a fix."""
    pytest.importorskip("pypdfium2")
    from delphi_core import pdf_figures

    path = _composed_form_pdf(tmp_path / "figure.pdf")
    candidates = pdf_figures.inventory_candidates(path, min_side=50)
    if not candidates:
        pytest.skip("this fixture produced no capturable candidate")
    identifier = candidates[0]["id"]
    direct = pdf_figures.capture_candidate(path, identifier, max_side=256)
    isolated = pdf_figures.run_isolated(
        "capture_candidate",
        {"path": str(path), "identifier": identifier, "maxSide": 256},
    )
    assert direct is not None and isolated is not None
    assert direct[0] == isolated[0]
    assert [direct[1], direct[2]] == list(isolated[1:])
