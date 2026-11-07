"""
The compressor's contract: it may shrink a PDF, but it must never change what
the reader or the model sees. Page count and extracted text are the two things
every other feature depends on, so they are asserted on every path.
"""

import io
import os

import pikepdf
import pytest
from PIL import Image
from pypdf import PdfReader

from delphi_core.pdf_compress import compress_pdf, fingerprint


def photo(width: int, height: int) -> Image.Image:
    """Noise, so the image cannot be trivially compressed to nothing."""
    return Image.frombytes("RGB", (width, height), os.urandom(width * height * 3))


def pdf_with_image(path, image: Image.Image, text: str = "Hello paper") -> None:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")

    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    stream = pikepdf.Stream(pdf, buffer.getvalue())
    stream.Type = pikepdf.Name("/XObject")
    stream.Subtype = pikepdf.Name("/Image")
    stream.Width, stream.Height = image.size
    stream.ColorSpace = pikepdf.Name("/DeviceRGB")
    stream.BitsPerComponent = 8
    stream.Filter = pikepdf.Name("/FlateDecode")
    # The PNG container is not a PDF filter; store the raw samples instead.
    stream.write(image.tobytes())
    page.Resources = pdf.make_indirect(
        pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=stream))
    )
    page.Contents = pdf.make_indirect(
        pikepdf.Stream(pdf, b"q 612 0 0 792 0 0 cm /Im0 Do Q")
    )
    pdf.save(path)


def test_a_large_image_is_downsampled_and_the_file_shrinks(tmp_path):
    path = tmp_path / "paper.pdf"
    pdf_with_image(path, photo(3000, 2000))
    before = path.stat().st_size

    assert compress_pdf(path, quality=80, max_side=1800) is True
    assert path.stat().st_size < before

    with pikepdf.open(path) as pdf:
        image = pdf.pages[0].images["/Im0"]
        assert max(int(image.Width), int(image.Height)) == 1800
        assert image.Filter == pikepdf.Name("/DCTDecode")


def test_page_count_and_extracted_text_are_preserved(tmp_path):
    path = tmp_path / "paper.pdf"
    pdf_with_image(path, photo(2400, 1600))
    before = PdfReader(str(path))
    before_pages = len(before.pages)
    before_text = [page.extract_text() or "" for page in before.pages]

    compress_pdf(path, quality=80, max_side=1800)

    after = PdfReader(str(path))
    assert len(after.pages) == before_pages
    assert [page.extract_text() or "" for page in after.pages] == before_text


def test_a_file_it_cannot_improve_is_left_byte_identical(tmp_path):
    """A tiny PDF has nothing to gain, and must not come back larger."""
    path = tmp_path / "small.pdf"
    pdf_with_image(path, photo(40, 40))
    original = path.read_bytes()

    assert compress_pdf(path, quality=80, max_side=1800) is False
    assert path.read_bytes() == original


def test_soft_masks_survive_so_transparency_is_not_lost(tmp_path):
    path = tmp_path / "masked.pdf"
    pdf_with_image(path, photo(2400, 1600))

    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        image = pdf.pages[0].images["/Im0"]
        mask = pikepdf.Stream(pdf, photo(2400, 1600).convert("L").tobytes())
        mask.Type = pikepdf.Name("/XObject")
        mask.Subtype = pikepdf.Name("/Image")
        mask.Width, mask.Height = 2400, 1600
        mask.ColorSpace = pikepdf.Name("/DeviceGray")
        mask.BitsPerComponent = 8
        image.SMask = pdf.make_indirect(mask)
        pdf.save(path)

    compress_pdf(path, quality=80, max_side=1800)

    with pikepdf.open(path) as pdf:
        image = pdf.pages[0].images["/Im0"]
        assert "/SMask" in image, "transparency was dropped"
        # The mask is a greyscale image, not colour: recompressing it as RGB
        # would corrupt the alpha it describes.
        assert image.SMask.ColorSpace == pikepdf.Name("/DeviceGray")


def test_a_corrupt_pdf_is_left_alone_rather_than_destroyed(tmp_path):
    path = tmp_path / "broken.pdf"
    path.write_bytes(b"%PDF-1.4\nthis is not a real pdf\n%%EOF\n")
    original = path.read_bytes()

    assert compress_pdf(path, quality=80, max_side=1800) is False
    assert path.read_bytes() == original


@pytest.mark.parametrize("side", [900, 1800, 2400])
def test_max_side_is_respected(tmp_path, side):
    path = tmp_path / "paper.pdf"
    pdf_with_image(path, photo(3000, 1500))

    compress_pdf(path, quality=80, max_side=side)

    with pikepdf.open(path) as pdf:
        image = pdf.pages[0].images["/Im0"]
        assert max(int(image.Width), int(image.Height)) == side


def test_running_twice_changes_nothing_the_second_time(tmp_path):
    """JPEG is lossy on every pass, so a second run must not re-encode: the
    backfill script is re-runnable and would otherwise erode quality."""
    path = tmp_path / "paper.pdf"
    pdf_with_image(path, photo(3000, 2000))

    assert compress_pdf(path, quality=80, max_side=1800) is True
    once = path.read_bytes()

    assert compress_pdf(path, quality=80, max_side=1800) is False
    assert path.read_bytes() == once


def test_a_rewrite_is_kept_when_it_still_reads_as_the_same_paper(tmp_path):
    path = tmp_path / "paper.pdf"
    pdf_with_image(path, photo(3000, 2000))
    expected = fingerprint(path)

    assert compress_pdf(path, quality=80, max_side=1800, expected=expected) is True
    assert fingerprint(path) == expected


def test_a_rewrite_that_reads_differently_is_thrown_away(tmp_path):
    """The verification is what lets a caller store the compressed bytes beside
    text extracted from the original, so a mismatch has to cost the rewrite."""
    path = tmp_path / "paper.pdf"
    pdf_with_image(path, photo(3000, 2000))
    before = path.read_bytes()

    wrong = (99, ["not this paper"])
    assert compress_pdf(path, quality=80, max_side=1800, expected=wrong) is False
    assert path.read_bytes() == before
