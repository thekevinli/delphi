"""Bounded, stable evidence and visual inventories for durable artifacts.

The inventory is the address space shared by digest selection, Memory-page
planning, validation, and capture. A model never selects "page 7" and leaves
Delphi to guess which object it meant; it selects one exact candidate ID.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from .document_index import PAGE_MARKER
from .pdf_figures import captioned_element_candidates, inventory_candidates
from .storage import ObjectStore, paper_key

SOURCE_INVENTORY_VERSION = "source-elements-v1"
MAX_SOURCE_ELEMENTS = 96
MAX_INVENTORY_PDF_PAGES = 40
MAX_WEB_MARKUP_BYTES = 500_000

_CAPTION = re.compile(
    r"^\s*(?P<kind>Figure|Fig\.?|Table|Algorithm|Alg\.?)\s*"
    r"(?P<number>[A-Za-z0-9.-]+)\s*[.:)|]?\s+(?P<caption>.{4,300})",
    re.IGNORECASE,
)
_WEB_IMAGE = re.compile(
    r"!\[(?P<caption>[^\]]*)\]\("
    r"(?P<locator>https?://[^\s)]+|inline-html:\d+)\)"
)


def _stable_id(prefix: str, *parts: object) -> str:
    raw = "\0".join(str(part) for part in parts)
    return f"{prefix}-{hashlib.sha256(raw.encode('utf-8')).hexdigest()[:16]}"


def _pdf_captions(text: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for page_match in PAGE_MARKER.finditer(text):
        page = int(page_match.group("page"))
        for line in page_match.group("text").splitlines():
            match = _CAPTION.match(line)
            if match is None:
                continue
            raw_kind = match.group("kind").casefold()
            kind = (
                "table"
                if raw_kind.startswith("table")
                else "algorithm"
                if raw_kind.startswith("alg")
                else "figure"
            )
            caption = " ".join(match.group("caption").split())[:300]
            items.append(
                {
                    "id": _stable_id(
                        f"pdf-p{page}-{kind}", match.group("number"), caption
                    ),
                    "kind": kind,
                    "page": page,
                    "caption": caption,
                    "capturable": False,
                }
            )
    return items


def pdf_source_inventory(path, extracted_text: str) -> list[dict[str, Any]]:
    captions = _pdf_captions(extracted_text)
    captions_by_page: dict[int, list[dict[str, Any]]] = {}
    for item in captions:
        captions_by_page.setdefault(item["page"], []).append(item)
    candidates = inventory_candidates(path, max_pages=MAX_INVENTORY_PDF_PAGES)
    candidate_counts: dict[int, int] = {}
    for candidate in candidates:
        candidate_counts[candidate["page"]] = candidate_counts.get(candidate["page"], 0) + 1
        matching = [
            item
            for item in captions_by_page.get(candidate["page"], ())
            if item["kind"] == "figure"
        ]
        index = candidate_counts[candidate["page"]] - 1
        caption = matching[index]["caption"] if index < len(matching) else ""
        candidate.update(
            caption=caption,
            capturable=True,
            mimeType="image/webp",
        )
    captioned = captioned_element_candidates(
        path, max_pages=MAX_INVENTORY_PDF_PAGES
    )
    captured_caption_keys = {
        (item["kind"], item["page"], item.get("caption", ""))
        for item in captioned
    }
    # Keep a textual inventory entry only when coordinate recovery could not
    # produce a safe crop. It remains usable as evidence for native Markdown or
    # pseudocode, but cannot be selected as a source snapshot.
    uncaptured = [
        item
        for item in captions
        if item["kind"] in {"table", "algorithm"}
        and (item["kind"], item["page"], item.get("caption", ""))
        not in captured_caption_keys
    ]
    combined = [
        *candidates,
        *({key: value for key, value in item.items() if key != "image"} for item in captioned),
        *uncaptured,
    ][:MAX_SOURCE_ELEMENTS]
    first_by_hash: dict[str, str] = {}
    for item in combined:
        digest = item.get("sha256")
        if not digest:
            continue
        item["duplicateOf"] = first_by_hash.get(digest)
        first_by_hash.setdefault(digest, item["id"])
    return combined


def web_source_inventory(document: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen: dict[str, str] = {}
    inline = {
        str(item.get("id") or ""): item for item in document.get("svgFigures") or ()
    }
    for section in document.get("sections") or ():
        anchor = str(section.get("anchor") or "")
        for match in _WEB_IMAGE.finditer(str(section.get("markdown") or "")):
            locator = match.group("locator")
            if locator in seen:
                continue
            caption = " ".join(match.group("caption").split())[:300]
            markup = inline.get(locator) or {}
            raw_markup = str(markup.get("html") or "")
            if len(raw_markup.encode("utf-8")) > MAX_WEB_MARKUP_BYTES:
                raw_markup = ""
            identifier = _stable_id("web-asset", anchor, locator, caption)
            seen[locator] = identifier
            items.append(
                {
                    "id": identifier,
                    "kind": "figure",
                    "section": anchor,
                    "locator": locator,
                    "caption": caption or str(markup.get("caption") or "")[:300],
                    "width": int(markup.get("width") or 0),
                    "height": int(markup.get("height") or 0),
                    "bbox": None,
                    "sha256": (
                        hashlib.sha256(raw_markup.encode("utf-8")).hexdigest()
                        if raw_markup
                        else None
                    ),
                    "duplicateOf": None,
                    "isQrOrBarcode": False,
                    "capturable": True,
                }
            )
    # Some inline figures are recorded in `svgFigures` without a section
    # markdown locator. Keep them addressable without duplicating the rest.
    for locator, markup in inline.items():
        if not locator or locator in seen:
            continue
        caption = " ".join(str(markup.get("caption") or "").split())[:300]
        items.append(
            {
                "id": _stable_id("web-asset", locator, caption),
                "kind": "figure",
                "section": None,
                "locator": locator,
                "caption": caption,
                "width": int(markup.get("width") or 0),
                "height": int(markup.get("height") or 0),
                "bbox": None,
                "sha256": hashlib.sha256(
                    str(markup.get("html") or "").encode("utf-8")
                ).hexdigest(),
                "duplicateOf": None,
                "isQrOrBarcode": False,
                "capturable": True,
            }
        )
    bounded = items[:MAX_SOURCE_ELEMENTS]
    first_by_hash: dict[str, str] = {}
    for item in bounded:
        digest = item.get("sha256")
        if not digest:
            continue
        item["duplicateOf"] = first_by_hash.get(digest)
        first_by_hash.setdefault(digest, item["id"])
    return bounded


def build_source_inventory(
    objects: ObjectStore,
    username: str,
    project_id: str,
    paper: dict[str, Any],
    extracted_text: str,
) -> list[dict[str, Any]]:
    if paper.get("kind") == "web":
        document = json.loads(
            objects.get_text(paper_key(username, project_id, paper["id"], "web"))
        )
        return web_source_inventory(document)
    path = objects.fetch_to_tempfile(
        paper_key(username, project_id, paper["id"], "pdf")
    )
    try:
        # In a child process, because this is the pass that walks every page of
        # a PDF with PDFium and PDFium can abort the interpreter outright — see
        # `pdf_figures.run_isolated`. `None` is the same answer the in-process
        # guards already gave for a PDF it could not read: no inventory, and
        # the filing carries on without source snapshots.
        from .pdf_figures import run_isolated

        return run_isolated(
            "source_inventory",
            {"path": str(path), "extractedText": extracted_text},
        ) or []
    finally:
        path.unlink(missing_ok=True)


def public_inventory(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The bounded metadata a model may select; never source bytes or markup."""
    allowed = {
        "id",
        "kind",
        "page",
        "section",
        "locator",
        "caption",
        "width",
        "height",
        "bbox",
        "sha256",
        "duplicateOf",
        "isQrOrBarcode",
        "capturable",
    }
    return [{key: value for key, value in item.items() if key in allowed} for item in items]


def inventory_by_id(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(item["id"]): item for item in items}
