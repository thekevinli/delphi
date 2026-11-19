"""
Shrink a PDF by recompressing its raster images.

Papers are dominated by embedded figures and scans, not by text: a 36 MB paper
in the live corpus carries 32 images and only a few hundred KB of glyphs. Those
images are routinely stored far above the resolution a screen can show, so
capping their long side and re-encoding as JPEG removes detail that was never
visible while leaving the text layer, vectors, and page geometry untouched.

Nothing here rewrites content streams, so extracted text and page count are
identical before and after -- the contract the reader and the model both rely on.
`compress_pdf` will also prove that, page by page, when handed the fingerprint
of the original: a rewrite that fails the check is thrown away and the original
kept, so no caller can end up storing bytes that disagree with the text it
already extracted.
"""

import io
import logging
from pathlib import Path

from pypdf import PdfReader

logger = logging.getLogger(__name__)

# Images below this compressed size are left alone: re-encoding them costs CPU
# and risks quality for savings that round to nothing.
MIN_IMAGE_BYTES = 48 * 1024

# A re-encode must beat the original by this much to be worth taking. JPEG is
# lossy on every pass, so accepting a 1% win would mean a file run through
# twice loses quality for nothing -- and would make this operation
# non-idempotent, which matters because the backfill script can be re-run.
MIN_SAVING = 0.10

# Re-encoding something that is already JPEG costs a generation of quality, so
# it has to be worth much more. This is also what makes the operation settle:
# re-encoding our own q80 output saves only a few percent, far under this bar,
# so a second pass leaves the file alone.
MIN_SAVING_ALREADY_JPEG = 0.25


def fingerprint(path: Path) -> tuple[int, list[str]]:
    """
    Page count and per-page text: what every other feature reads out of a PDF.

    Two of these being equal is the whole safety argument for rewriting a
    paper's bytes -- the reader renders pages, the model reads text, and
    nothing downstream cares about anything else that changed.
    """
    reader = PdfReader(str(path))
    return len(reader.pages), [page.extract_text() or "" for page in reader.pages]


def compress_pdf(
    path: Path,
    quality: int,
    max_side: int,
    expected: tuple[int, list[str]] | None = None,
) -> bool:
    """Recompress `path` in place. Returns True if the file got smaller.

    The original is left untouched unless the rewrite both succeeds and
    actually saves bytes, so a PDF this cannot improve is never made worse.

    `expected` is a `fingerprint` of the original, from a caller that has
    already read it. Given one, the rewrite is verified against it and
    discarded unless it matches exactly.
    """
    # Imported lazily, and a missing library downgrades to "store the original"
    # rather than failing the upload: compression is an optimisation, never a
    # precondition for accepting a paper.
    try:
        import pikepdf
        from PIL import Image
    except ImportError:
        logger.warning("pikepdf/Pillow unavailable; storing %s uncompressed", path.name)
        return False

    # Some papers embed very large scans; the decompression-bomb guard is aimed
    # at hostile input, and these files are already size-capped at ingress.
    Image.MAX_IMAGE_PIXELS = None

    before = path.stat().st_size
    target = path.with_suffix(".compressed.pdf")
    try:
        with pikepdf.open(path) as pdf:
            # Soft masks are images too, but they carry alpha rather than
            # colour: re-encoding one as RGB would corrupt the transparency it
            # describes, so they are collected first and then skipped.
            masks = set()
            for obj in pdf.objects:
                if isinstance(obj, pikepdf.Stream):
                    for key in ("/SMask", "/Mask"):
                        mask = obj.get(key)
                        if isinstance(mask, pikepdf.Stream):
                            masks.add(mask.objgen)

            touched = 0
            for obj in pdf.objects:
                # Walking every object rather than `page.images` also reaches
                # figures nested inside form XObjects.
                if not isinstance(obj, pikepdf.Stream):
                    continue
                if obj.get("/Subtype") != pikepdf.Name("/Image"):
                    continue
                if obj.objgen in masks:
                    continue
                if _recompress(pikepdf, Image, obj, quality, max_side):
                    touched += 1

            pdf.save(
                target,
                compress_streams=True,
                object_stream_mode=pikepdf.ObjectStreamMode.generate,
            )
    except Exception:
        logger.warning("PDF compression failed for %s; keeping original", path.name, exc_info=True)
        target.unlink(missing_ok=True)
        return False

    after = target.stat().st_size
    if after >= before:
        target.unlink(missing_ok=True)
        return False

    # Checked on the rewrite rather than after installing it, so a failure needs
    # no rollback: the original was never touched.
    if expected is not None and not _matches(target, expected):
        target.unlink(missing_ok=True)
        return False

    target.replace(path)
    logger.info(
        "Compressed %s: %.1f MB -> %.1f MB (%d images)",
        path.name,
        before / 1e6,
        after / 1e6,
        touched,
    )
    return True


def _matches(path: Path, expected: tuple[int, list[str]]) -> bool:
    """Whether the rewrite still reads as the paper the caller extracted."""
    try:
        actual = fingerprint(path)
    except Exception:
        logger.warning("Compressed %s could not be re-read", path.name, exc_info=True)
        return False
    if actual == expected:
        return True
    logger.warning(
        "Compressed %s failed verification (%d pages -> %d); keeping original",
        path.name,
        expected[0],
        actual[0],
    )
    return False


def _is_jpeg(pikepdf, obj) -> bool:
    filters = obj.get("/Filter")
    if filters is None:
        return False
    names = filters if isinstance(filters, pikepdf.Array) else [filters]
    return any(name == pikepdf.Name("/DCTDecode") for name in names)


def _long_side(obj) -> int:
    try:
        return max(int(obj.Width), int(obj.Height))
    except Exception:
        return 0


def _recompress(pikepdf, Image, obj, quality: int, max_side: int) -> bool:
    try:
        image = pikepdf.PdfImage(obj)
    except Exception:
        return False

    # Bitonal scans belong in CCITT/JBIG2. JPEG would both enlarge them and ring
    # around every glyph edge, which is exactly the artefact to avoid.
    try:
        if image.bits_per_component == 1:
            return False
    except Exception:
        return False

    try:
        original = len(obj.read_raw_bytes())
    except Exception:
        return False
    if original < MIN_IMAGE_BYTES:
        return False

    # Dropping resolution is the main lever, so an oversized image is always
    # worth attempting. Otherwise the bar depends on what re-encoding costs.
    if _long_side(obj) > max_side:
        min_saving = MIN_SAVING
    elif _is_jpeg(pikepdf, obj):
        min_saving = MIN_SAVING_ALREADY_JPEG
    else:
        min_saving = MIN_SAVING

    try:
        pil = image.as_pil_image()
    except Exception:
        return False

    # JPEG carries greyscale or RGB; everything else converts, which also drops
    # a PIL alpha channel that the PDF expresses through /SMask anyway.
    if pil.mode != "L":
        try:
            pil = pil.convert("RGB")
        except Exception:
            return False

    longest = max(pil.size)
    if longest > max_side:
        scale = max_side / longest
        pil = pil.resize(
            (max(1, round(pil.width * scale)), max(1, round(pil.height * scale))),
            Image.LANCZOS,
        )

    buffer = io.BytesIO()
    try:
        pil.save(buffer, format="JPEG", quality=quality, optimize=True)
    except Exception:
        return False
    data = buffer.getvalue()
    if len(data) > original * (1 - min_saving):
        return False

    obj.write(data, filter=pikepdf.Name("/DCTDecode"))
    obj.ColorSpace = pikepdf.Name("/DeviceGray" if pil.mode == "L" else "/DeviceRGB")
    obj.BitsPerComponent = 8
    obj.Width, obj.Height = pil.size
    # Stale hints from the previous encoding would now describe the wrong data.
    # /SMask is deliberately preserved: it is scaled to the image by the viewer,
    # so a resized base image keeps its transparency.
    for key in ("/Decode", "/DecodeParms", "/Interpolate"):
        if key in obj:
            del obj[key]
    return True
