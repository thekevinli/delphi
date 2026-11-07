"""
The figures one chat turn's external sources hold, by short turn-local ids.

`read_url` registers what it found beside the text it returned: a PDF figure by
its page and its caption's order there, a web image by its address. Nothing is
rendered or fetched until `view_figure` or `embed_figure` asks for the pixels,
and then only through paths Delphi already trusts: the isolated PDF worker
(`pdf_figures.run_isolated`), or the guarded fetcher with the re-encoding a
viewport image gets. What leaves here is always WebP Delphi encoded itself.

Memory figures keep their own ids and store. This holds only what the turn
read, and its scratch files go with it.
"""

from __future__ import annotations

import asyncio
import tempfile
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from .config import Settings

#: Figures one turn may name. Past it a source's figures go unlisted.
MAX_FIGURES = 24
PREFIX = "source-fig-"


@dataclass(frozen=True)
class SourceFigure:
    id: str
    caption: str
    #: The source's title and, for a PDF, the page: the card's credit line.
    credit: str
    #: The source's final address, which the answer cites.
    url: str
    page: int = 0
    #: The caption's printed label, e.g. "Figure 2:", which the crop is found from.
    label: str = ""
    #: A web figure's own address; empty for a PDF crop.
    image_url: str = ""


class SourceFigures:
    """One turn's source figures and the PDFs they are cut from."""

    def __init__(self) -> None:
        self._figures: dict[str, SourceFigure] = {}
        self._pdfs: dict[str, Path] = {}
        self._scratch: tempfile.TemporaryDirectory | None = None

    def keep_pdf(self, url: str, body: bytes) -> Path:
        """Hold a fetched PDF for this turn, so a figure can be cut from it later."""
        if self._scratch is None:
            self._scratch = tempfile.TemporaryDirectory(prefix="delphi-source-")
        path = Path(self._scratch.name) / f"{len(self._pdfs)}.pdf"
        path.write_bytes(body)
        self._pdfs[url] = path
        return path

    def has_pdf(self, url: str) -> bool:
        return url in self._pdfs

    def drop_pdf(self, url: str) -> None:
        path = self._pdfs.pop(url, None)
        if path is not None:
            path.unlink(missing_ok=True)

    def add(self, caption: str, credit: str, url: str, *, page: int = 0, label: str = "", image_url: str = "") -> SourceFigure | None:
        """Register one figure, or find it again. None once the turn's list is full."""
        for figure in self._figures.values():
            if (figure.url, figure.page, figure.label, figure.caption, figure.image_url) == (url, page, label, caption[:300], image_url):
                return figure
        if len(self._figures) >= MAX_FIGURES:
            return None
        figure = SourceFigure(f"{PREFIX}{len(self._figures) + 1}", caption[:300], credit[:200], url, page, label, image_url)
        self._figures[figure.id] = figure
        return figure

    def get(self, figure_id: str) -> SourceFigure | None:
        return self._figures.get(figure_id.strip())

    async def image(self, figure: SourceFigure, settings: Settings) -> tuple[bytes, str]:
        """
        The figure's pixels, captured now, and a note when the crop is only the
        region above its caption. A reason the model can read is a `ValueError`.
        """
        side = settings.memory_figure_max_side
        if figure.image_url:
            try:
                async with asyncio.timeout(settings.web_fetch_timeout_seconds):
                    return (await _web_image(figure.image_url, settings))[0], ""
            except TimeoutError:
                raise ValueError("Error: the figure took too long to fetch. Describe it from its caption.") from None
        path = self._pdfs.get(figure.url)
        if path is None or not path.is_file():
            raise ValueError(f"Error: {figure.id} is no longer available. Read the source again with read_url.")
        from .pdf_figures import run_isolated

        captured = await run_in_threadpool(
            run_isolated, "page_figure", {"path": str(path), "page": figure.page, "label": figure.label,
             "opening": " ".join(figure.caption.split(": ", 1)[-1].split()[:3]), "maxSide": side}
        )
        if not captured:
            raise ValueError(f"Error: {figure.id} could not be cut from page {figure.page}. Describe it from its caption instead.")
        payload, _, _, exact = captured
        note = "" if exact else (
            " No picture sits above this caption, so this is the page region above it: "
            "check that it shows the figure, not surrounding text."
        )
        return payload, note


async def _web_image(url: str, settings: Settings) -> tuple[bytes, int, int]:
    from .viewport import normalize_viewport_image
    from .web_fetch import IMAGE_TYPES, fetch_resource

    try:
        resource = await fetch_resource(url, settings, include_images=True)
        if resource.content_type not in IMAGE_TYPES:
            raise ValueError("Error: that figure is not a raster image, so it cannot be shown. Describe it from its caption.")
        bounded = settings.model_copy(update={"web_image_max_side": settings.memory_figure_max_side})
        return await run_in_threadpool(normalize_viewport_image, resource.body, bounded)
    except HTTPException as exc:
        detail = exc.detail.get("message", "") if isinstance(exc.detail, dict) else exc.detail
        raise ValueError(f"Error: the figure could not be fetched: {str(detail)[:300]}") from None
