"""Normalize an image the reader is looking at into model-safe input."""

from io import BytesIO

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

from .config import Settings

VIEWPORT_IMAGE_FORMATS = {"PNG", "JPEG", "WEBP"}


def normalize_viewport_image(payload: bytes, settings: Settings) -> tuple[bytes, int, int]:
    """
    Decode once and emit a static, metadata-free image safe for model and reader.

    Two callers, one treatment: an image the reader navigated to in the frame,
    and the same image sent to Document Chat as context. Both arrive as bytes from
    a site Delphi does not control, so both are re-encoded rather than passed
    through — animation, EXIF orientation, and decompression bombs all stop here.
    """
    try:
        with Image.open(BytesIO(payload)) as probe:
            if probe.format not in VIEWPORT_IMAGE_FORMATS:
                raise HTTPException(415, "Only PNG, JPEG, and static WebP are supported")
            width, height = probe.size
            if width <= 0 or height <= 0 or width * height > settings.web_image_max_pixels:
                raise HTTPException(413, "That image's dimensions exceed the limit")
            if getattr(probe, "n_frames", 1) != 1 or getattr(probe, "is_animated", False):
                raise HTTPException(415, "Animated images are not supported")
            probe.verify()
        with Image.open(BytesIO(payload)) as decoded:
            decoded.load()
            oriented = ImageOps.exif_transpose(decoded)
            if oriented.mode in {"RGBA", "LA"} or (
                oriented.mode == "P" and "transparency" in oriented.info
            ):
                rgba = oriented.convert("RGBA")
                flattened = Image.new("RGB", rgba.size, "white")
                flattened.paste(rgba, mask=rgba.getchannel("A"))
                normalized = flattened
            else:
                normalized = oriented.convert("RGB")
            normalized.thumbnail(
                (settings.web_image_max_side, settings.web_image_max_side),
                Image.Resampling.LANCZOS,
            )
            output = BytesIO()
            normalized.save(output, "WEBP", lossless=True, method=6)
            return output.getvalue(), *normalized.size
    except HTTPException:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(415, "That image is unsafe to decode") from None
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(415, "That image is malformed") from None
