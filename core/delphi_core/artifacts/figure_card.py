"""A source's own figure as an artifact draft: Delphi's template, never authored HTML.

The image is Delphi's own WebP, embedded as a data URL because the frame
allows nothing else, and shrunk until the whole card fits the source limit
every draft keeps. The card then takes the ordinary render, inspection and
publication path, so a figure reaches chat exactly as a drawn diagram does.
"""

import base64
import html
import io

from .types import SOURCE_MAX

#: Room the card's markup keeps around the image.
_MARKUP_CHARS = 4_000
#: Sizes tried, largest first, until the encoded image fits.
_SIDES = (1200, 1000, 800, 640, 480)
_QUALITIES = (82, 68, 55)


def card_image(payload: bytes) -> str | None:
    """The figure as a data URL within the source limit, or None when it cannot fit."""
    from PIL import Image

    budget = SOURCE_MAX - _MARKUP_CHARS
    with Image.open(io.BytesIO(payload)) as opened:
        image = opened.convert("RGB")
    for side in _SIDES:
        fitted = image.copy()
        fitted.thumbnail((side, side), Image.Resampling.LANCZOS)
        for quality in _QUALITIES:
            output = io.BytesIO()
            fitted.save(output, "WEBP", quality=quality, method=4)
            encoded = base64.b64encode(output.getvalue()).decode("ascii")
            if len(encoded) + 23 <= budget:
                return f"data:image/webp;base64,{encoded}"
    return None


def figure_card(image_url: str, caption: str, credit: str) -> str:
    """The card's source: the figure, its caption and where it is from, in the host's styles."""
    caption, credit = html.escape(caption, quote=True), html.escape(credit, quote=True)
    return (
        '<figure style="margin:0;display:grid;gap:10px">'
        f'<img src="{image_url}" alt="{caption}" style="display:block;max-width:100%;width:auto;height:auto;margin:0 auto;'
        'max-height:520px;object-fit:contain;background:#fff;border-radius:var(--artifact-radius)">'
        f'<figcaption style="margin:0;font-size:13px;line-height:1.5;color:var(--artifact-ink)">{caption}</figcaption>'
        f'<p class="artifact-note" style="margin:0">From {credit}</p>'
        "</figure>"
    )
