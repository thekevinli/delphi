"""Validation and normalization for temporary chat image attachments."""

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError

ACCEPTED_FORMATS = {"PNG": "png", "JPEG": "jpeg", "WEBP": "webp"}
ACCEPTED_MIMES = {
    "PNG": {"image/png"},
    "JPEG": {"image/jpeg", "image/jpg"},
    "WEBP": {"image/webp"},
}
ACCEPTED_EXTENSIONS = {
    "PNG": {".png"},
    "JPEG": {".jpg", ".jpeg"},
    "WEBP": {".webp"},
}


@dataclass
class NormalizedChatImage:
    image_path: Path
    thumbnail_path: Path
    width: int
    height: int
    source_bytes: int
    normalized_bytes: int
    source_format: str

    def cleanup(self) -> None:
        self.image_path.unlink(missing_ok=True)
        self.thumbnail_path.unlink(missing_ok=True)


def _scratch(suffix: str) -> Path:
    handle, name = tempfile.mkstemp(suffix=suffix)
    os.close(handle)
    return Path(name)


def normalize_chat_image(
    upload: UploadFile,
    *,
    max_source_bytes: int,
    max_pixels: int,
    max_side: int,
    thumbnail_side: int,
) -> NormalizedChatImage:
    """Bound the upload before decoding, then emit metadata-free static WebP files."""
    source = _scratch(".upload")
    image_path = _scratch(".webp")
    thumbnail_path = _scratch(".webp")
    size = 0
    try:
        with source.open("wb") as target:
            while chunk := upload.file.read(1024 * 1024):
                size += len(chunk)
                if size > max_source_bytes:
                    raise HTTPException(413, "Image source exceeds the upload limit")
                target.write(chunk)
        if not size:
            raise HTTPException(415, "The uploaded file is not a supported image")

        try:
            with Image.open(source) as probe:
                detected = probe.format or ""
                width, height = probe.size
                if detected not in ACCEPTED_FORMATS:
                    raise HTTPException(415, "Only PNG, JPEG, and static WebP images are supported")
                if upload.content_type not in ACCEPTED_MIMES[detected]:
                    raise HTTPException(415, "The image type does not match its contents")
                extension = Path(upload.filename or "").suffix.lower()
                if extension and extension not in ACCEPTED_EXTENSIONS[detected]:
                    raise HTTPException(415, "The image filename does not match its contents")
                if width <= 0 or height <= 0 or width * height > max_pixels:
                    raise HTTPException(413, "Image dimensions exceed the pixel limit")
                if getattr(probe, "n_frames", 1) != 1 or getattr(probe, "is_animated", False):
                    raise HTTPException(415, "Animated images are not supported")
                probe.verify()

            with Image.open(source) as decoded:
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
                normalized.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
                normalized.save(image_path, "WEBP", lossless=True, method=6)
                thumbnail = normalized.copy()
                thumbnail.thumbnail((thumbnail_side, thumbnail_side), Image.Resampling.LANCZOS)
                thumbnail.save(thumbnail_path, "WEBP", lossless=True, method=6)
                width, height = normalized.size
        except HTTPException:
            raise
        except (Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise HTTPException(415, "The image is unsafe to decode") from None
        except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
            # `SyntaxError` is what the PNG reader raises for a chunk whose
            # checksum is wrong: a damaged file, not a fault of ours.
            raise HTTPException(415, "The uploaded file is malformed or unsupported") from None

        return NormalizedChatImage(
            image_path=image_path,
            thumbnail_path=thumbnail_path,
            width=width,
            height=height,
            source_bytes=size,
            normalized_bytes=image_path.stat().st_size,
            source_format=ACCEPTED_FORMATS[detected],
        )
    except Exception:
        image_path.unlink(missing_ok=True)
        thumbnail_path.unlink(missing_ok=True)
        raise
    finally:
        source.unlink(missing_ok=True)
