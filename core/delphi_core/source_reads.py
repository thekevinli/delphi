"""
What `read_url` reads: a bounded, turn-local snapshot of one public source.

HTML and plain text are extracted statically; the page's scripts never run. A
PDF is read by page in the isolated PDF worker, and only up to the library's
own page ceiling (`max_pages_per_paper`): a longer one is refused before any
text is extracted, so no single paper can cost more than any other source. The
PDF itself never reaches the model provider. The model gets the pages it asks
for, as text, under the turn's exact-document budget, and the figures on them
by id (`source_figures`).
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from .config import Settings
from .document_index import strip_control_characters
from .source_figures import SourceFigure, SourceFigures
from .web_extract import extract, flat_markdown, is_interstitial
from .web_fetch import FetchedResource

#: Text an HTML or plain-text snapshot keeps.
SNAPSHOT_CHARS = 96_000
#: Pages one read may return, as `read_paper` does.
PAGES_PER_READ = 4
#: Figures one read lists; the rest of a figure-heavy page waits for a narrower read.
FIGURES_PER_READ = 8
#: How long the worker may take to read a PDF's text.
PDF_TEXT_SECONDS = 90.0
#: A caption opens its line or follows a sentence's end, where two side-by-side
#: captions share one extracted line; its text runs to the next caption.
_FIGURE_CAPTION = re.compile(r"(?:^\s*|(?<=[.:)])\s+)((?:Figure|Fig\.)\s*(\d+[A-Za-z]?)\s*([.:|]))\s+(?=\S)", re.IGNORECASE)
_WEB_IMAGE = re.compile(r"!\[([^\]\n]{3,300})\]\((https?://[^\s)]+)\)")


def text_snapshot(resource: FetchedResource) -> dict[str, Any]:
    """An HTML or plain-text source as one bounded, hashed text."""
    html = resource.body.decode(resource.encoding, errors="replace")
    if resource.content_type == "text/plain":
        text, title, truncated = html, resource.url, len(html) > SNAPSHOT_CHARS
    else:
        if is_interstitial(html):
            raise ValueError("The source returned an access challenge, not readable text.")
        document = extract(html, resource.url, SNAPSHOT_CHARS)
        if not any(section["markdown"].strip() for section in document["sections"]):
            raise ValueError("The source has no readable static text; scripts are not executed.")
        text, title = flat_markdown(document), document["title"]
        truncated = document["truncated"] or len(text) > SNAPSHOT_CHARS
    if not text.strip():
        raise ValueError("The source returned no readable text.")
    text = text[:SNAPSHOT_CHARS]
    return {"kind": "text", "url": resource.url, "title": title[:240], "text": text,
            "truncated": truncated, "sha256": hashlib.sha256(text.encode()).hexdigest()}


def pdf_snapshot(resource: FetchedResource, settings: Settings, figures: SourceFigures) -> dict[str, Any]:
    """A PDF's page text, or a refusal the model can act on. Blocking: run it off the loop."""
    from .pdf_figures import run_isolated

    path = figures.keep_pdf(resource.url, resource.body)
    read = run_isolated(
        "source_pdf",
        {"path": str(path), "maxPages": settings.max_pages_per_paper, "maxChars": settings.web_max_extract_chars},
        timeout=PDF_TEXT_SECONDS,
    )
    if not read or read.get("pages") is None:
        figures.drop_pdf(resource.url)
        if read:
            raise ValueError(
                f"This PDF has {read['pageCount']} pages; Delphi reads PDFs of up to "
                f"{settings.max_pages_per_paper} pages. Find a shorter version or the relevant "
                "section as HTML, or ask the reader to attach the part they need."
            )
        raise ValueError("This PDF could not be read. Find an HTML version or state the limitation.")
    pages = [None if page is None else strip_control_characters(page) for page in read["pages"]]
    if not any(page and page.strip() for page in pages):
        figures.drop_pdf(resource.url)
        raise ValueError("This PDF has no extractable text; it may be scanned. Find an HTML version or state the limitation.")
    title = strip_control_characters(read.get("title") or "") or resource.url.rsplit("/", 1)[-1] or resource.url
    return {"kind": "pdf", "url": resource.url, "title": title[:240], "pages": pages, "truncated": bool(read.get("truncated")),
            "sha256": hashlib.sha256(resource.body).hexdigest()}


def pdf_excerpt(snapshot: dict[str, Any], pages: list[int], limit: int) -> tuple[str, list[int], bool]:
    """
    Whole pages in the order asked, within `limit` characters.

    No pages asked means from the first. A page that alone exceeds the limit
    is cut, and the caller says so; otherwise a page that does not fit is left
    for the next read rather than split across two.
    """
    count = len(snapshot["pages"])
    wanted = list(dict.fromkeys(pages)) or list(range(1, min(count, PAGES_PER_READ) + 1))
    text, shown, cut = "", [], False
    for number in wanted[:PAGES_PER_READ]:
        page = snapshot["pages"][number - 1]
        body = "[Not extracted: this PDF's text cap was reached before this page.]" if page is None else (
            page.strip() or "[No extractable text on this page.]"
        )
        block = f"--- Page {number} ---\n{body}\n\n"
        if len(text) + len(block) > limit:
            if not shown:
                text, shown, cut = block[:limit], [number], True
            break
        text += block
        shown.append(number)
    return text, shown, cut


def pdf_figures(snapshot: dict[str, Any], pages: list[int], figures: SourceFigures) -> list[SourceFigure]:
    """
    The captioned figures on these pages. Body text can open a line with
    "Figure 1." too: a caption with a colon is taken as the one, and without
    one each candidate is listed, since the crop is found from its own words.
    """
    found = []
    for number in pages:
        captions: dict[str, list[tuple[str, str, str, str]]] = {}
        for line in (snapshot["pages"][number - 1] or "").splitlines():
            matches = list(_FIGURE_CAPTION.finditer(line))
            for match, after in zip(matches, [*matches[1:], None]):
                words = " ".join(line[match.end():after.start() if after else None].split())[:300]
                if len(words) >= 4:
                    captions.setdefault(match[2].lower(), []).append((match[1], match[2], match[3], words))
        for found_here in captions.values():
            colon = [caption for caption in found_here if caption[2] == ":"]
            for label, figure_number, _, words in colon[:1] or found_here:
                figure = figures.add(
                    f"Figure {figure_number}: {words}", f"{snapshot['title']}, p. {number}",
                    snapshot["url"], page=number, label=" ".join(label.split()),
                )
                if figure is not None and figure not in found:
                    found.append(figure)
    return found


def web_figures(excerpt: str, snapshot: dict[str, Any], figures: SourceFigures) -> list[SourceFigure]:
    """The described raster images an excerpt shows. An image without a description is decoration."""
    found = []
    for caption, address in _WEB_IMAGE.findall(excerpt):
        if address.lower().split("?", 1)[0].endswith(".svg"):
            continue
        figure = figures.add(" ".join(caption.split()), snapshot["title"], snapshot["url"], image_url=address)
        if figure is not None and figure not in found:
            found.append(figure)
    return found


def figure_lines(found: list[SourceFigure], tools: list[str]) -> str:
    """The figures a read returned, named only to the tools this request can call."""
    if not found or not tools:
        return ""
    lines = [f"- {figure.id}" + (f" · p. {figure.page}" if figure.page else "") + f" · {figure.caption[:160]}" for figure in found[:FIGURES_PER_READ]]
    return f"\nFigures here ({' or '.join(tools)} takes the id):\n" + "\n".join(lines) + "\n"
