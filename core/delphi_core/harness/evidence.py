"""
External evidence: an outside page, captured, with the passage a claim rests on.

A search result is discovery. A claim Delphi writes down and keeps — in a
digest, in a Memory page — needs more than a model's word that a page said
something: it needs the page. `capture` fetches each page a finding cites
through the guarded fetcher, extracts it into the same anchored sections a
stored web document has, and looks for the finding's quote in that text. A
finding whose quote is there is kept with the section it was found in. One
whose quote is not there is dropped and reported, and never reaches the model
that writes: an unverified claim is not weaker evidence, it is no evidence.

What is kept is immutable. A capture is what a page said on the day it was
read, so a digest citing it goes on citing the same words after the page
changes or disappears.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import tempfile
import unicodedata
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import uuid4

import anyio

from ..config import Settings
from ..storage import ObjectStore, Storage, external_evidence_key
from ..web_fetch import FetchedResource, fetch_resource

logger = logging.getLogger("uvicorn.error")

#: How many distinct pages one packet may capture, and how much text of them
#: it may keep in all. A packet rides in the request of the call that writes
#: from it, so both are bounds on that request.
MAX_SOURCES = 8
MAX_CHARS = 120_000
#: A quote shorter than this could be found on almost any page.
MIN_QUOTE_CHARS = 20
BEARS_ON = ("lineage", "baseline", "correction", "definition")

Fetch = Callable[..., Awaitable[FetchedResource]]

_MARKUP = re.compile(r"\[([^\]]*)\]\([^)]*\)|[*_`#>|]")
_QUOTES = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'", "–": "-", "—": "-", "‐": "-", "‑": "-"})


def normalise(text: str) -> str:
    """
    Text as a quote is compared: what was said, without how it was set.

    A model quotes what it read through a search tool; the capture holds the
    same page as markdown. Between the two, spacing, ligatures, curly quotes,
    dashes, emphasis marks and link syntax differ while the words do not.
    """
    text = unicodedata.normalize("NFKC", text or "")
    text = _MARKUP.sub(lambda match: match.group(1) or " ", text)
    return " ".join(text.translate(_QUOTES).split()).casefold()


def locate(quote: str, sections: list[dict[str, Any]]) -> str | None:
    """
    The anchor of the section a quote is in, or None when the page does not say it.

    A quote that runs across a heading is found in the page as a whole and
    belongs to the section it starts in.
    """
    wanted = normalise(quote)
    if len(wanted) < MIN_QUOTE_CHARS:
        return None
    texts = [normalise(section.get("markdown") or "") for section in sections]
    for section, text in zip(sections, texts):
        if wanted in text:
            return section["anchor"]
    whole, starts = "", []
    for text in texts:
        starts.append(len(whole))
        whole += text + " "
    at = whole.find(wanted)
    if at < 0:
        return None
    return next(
        section["anchor"]
        for section, start in reversed(list(zip(sections, starts)))
        if start <= at
    )


@dataclass
class Packet:
    """What one research pass left once its sources were read."""

    #: One per captured page: the storage record (`id`, `url`, `finalUrl`,
    #: `title`, `contentHash`, `findings`) with its `sections`.
    sources: list[dict[str, Any]] = field(default_factory=list)
    #: Findings that were not kept, each with why.
    unverified: list[dict[str, str]] = field(default_factory=list)

    @property
    def evidence_ids(self) -> list[str]:
        return [source["id"] for source in self.sources]


def _pdf_sections(body: bytes) -> list[dict[str, Any]]:
    """A PDF as one section per page, anchored the way a reader would cite it."""
    from ..pdf_compress import fingerprint

    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / "evidence.pdf"
        path.write_bytes(body)
        _, pages = fingerprint(path)
    return [
        {"anchor": f"page-{number}", "title": f"Page {number}", "level": 1,
         "markdown": text.strip(), "words": len(text.split())}
        for number, text in enumerate(pages, start=1)
        if text.strip()
    ]


async def _read(resource: FetchedResource, max_chars: int) -> dict[str, Any]:
    """One fetched page as a title and anchored sections, within a budget."""
    if "pdf" in resource.content_type.lower():
        sections = await anyio.to_thread.run_sync(_pdf_sections, resource.body)
        title = ""
    else:
        from ..web_fetch import extract_with_render_fallback

        document = await extract_with_render_fallback(resource, max_chars)
        sections, title = document.get("sections") or [], document.get("title") or ""
    kept, left = [], max_chars
    for section in sections:
        if left <= 0:
            break
        text = (section.get("markdown") or "")[:left]
        left -= len(text)
        kept.append({**section, "markdown": text, "words": len(text.split())})
    return {"title": title, "sections": kept}


async def capture(
    findings: list[dict[str, Any]], settings: Settings, *, fetch: Fetch | None = None,
    bears_on: tuple[str, ...] = BEARS_ON, max_sources: int = MAX_SOURCES,
) -> Packet:
    """
    Read every page the findings cite and keep the findings the pages bear out.

    Nothing is stored here: the packet is what a writer is handed, and `store`
    keeps it once something that cites it is about to be written. `bears_on`
    is the vocabulary of the pass that found them (`research.Task`), and
    `max_sources` may only lower the bound a packet has, for a caller whose
    writer is handed a packet already.
    """
    max_sources = min(max_sources, MAX_SOURCES)
    fetch = fetch or fetch_resource
    packet = Packet()
    by_url: dict[str, list[dict[str, Any]]] = {}
    for finding in findings:
        by_url.setdefault(str(finding.get("url") or ""), []).append(finding)

    def drop(finding: dict[str, Any], why: str) -> None:
        packet.unverified.append(
            {"claim": str(finding.get("claim") or ""), "url": str(finding.get("url") or ""), "reason": why}
        )

    left = MAX_CHARS
    for index, (url, cited) in enumerate(by_url.items()):
        if index >= max_sources or left <= 0:
            for finding in cited:
                drop(finding, "over the limit of sources one packet may capture")
            continue
        try:
            # The guarded fetcher: every hop is checked against private hosts.
            resource = await fetch(url, settings, include_pdf=True, allow_render=True)
            read = await _read(resource, min(left, MAX_CHARS // 2))
        except Exception as error:
            logger.info("evidence_capture_failed url=%s error=%s", url, type(error).__name__)
            for finding in cited:
                drop(finding, "the page could not be read")
            continue
        kept = []
        for finding in cited:
            anchor = locate(str(finding.get("quote") or ""), read["sections"])
            if anchor is None:
                drop(finding, "the quote is not on the page")
                continue
            bears = finding.get("bearsOn")
            kept.append({
                "claim": str(finding.get("claim") or ""),
                "quote": str(finding.get("quote") or ""),
                "anchor": anchor,
                "bearsOn": bears if bears in bears_on else bears_on[0],
            })
        if not kept:
            continue
        text = "\n\n".join(section["markdown"] for section in read["sections"])
        left -= len(text)
        packet.sources.append({
            "id": uuid4().hex[:24],
            "url": url,
            "finalUrl": resource.url,
            "title": read["title"] or str(cited[0].get("title") or "") or url,
            "contentHash": hashlib.sha256(text.encode()).hexdigest(),
            "capturedAt": resource.fetched_at,
            "findings": kept,
            "sections": read["sections"],
        })
    return packet


def store(packet: Packet, storage: Storage, objects: ObjectStore, username: str) -> None:
    """Keep a packet's captures: the bytes, then the record (invariant 7)."""
    for source in packet.sources:
        objects.put_text(
            external_evidence_key(username, source["id"]),
            json.dumps({"sections": source["sections"]}, ensure_ascii=False),
        )
        storage.put_external_evidence(
            username, {key: value for key, value in source.items() if key != "sections"}
        )


def reap(storage: Storage, objects: ObjectStore, username: str, settings: Settings) -> int:
    """
    Remove this account's captures that nothing cites any more: the record,
    then its bytes. Called where a citing artifact can go away. A capture
    younger than the grace period is spared, because the digest it was made
    for may not have been stored yet.
    """
    keys = storage.delete_unreferenced_external_evidence(
        username, older_than_seconds=settings.external_evidence_reap_grace_seconds
    )
    for key in keys:
        objects.delete(key)
    if keys:
        # A capture cannot be fetched again, so each removal leaves a trace.
        logger.info("evidence_reaped user=%s count=%d keys=%s", username, len(keys), ",".join(keys[:20]))
    return len(keys)


def load_sections(objects: ObjectStore, record: dict[str, Any]) -> list[dict[str, Any]]:
    """The captured sections of one stored record."""
    return json.loads(objects.get_text(record["objectKey"]))["sections"]


def as_markdown(record: dict[str, Any], sections: list[dict[str, Any]]) -> str:
    """A capture as a plain file a reader can keep: where it came from, what was cited, what it said."""
    lines = [
        f"# {record['title'] or record['url']}",
        "",
        f"Captured {record['capturedAt'][:10]} from {record['finalUrl']}",
        "",
        "## Cited from this page",
        "",
        *(f"- §{finding['anchor']}: {finding['claim']}\n  > {finding['quote']}" for finding in record["findings"]),
        "",
        "## The page as captured",
    ]
    for section in sections:
        lines += ["", f"### {section.get('title') or section['anchor']} (§{section['anchor']})", "", section.get("markdown") or ""]
    return "\n".join(lines) + "\n"


def captured_document(
    storage: Storage | None, objects: ObjectStore | None, username: str, doc_id: str
) -> dict[str, Any] | None:
    """
    A captured source in the shape a stored web document has, or None.

    A capture has the same anchored sections a web document has, so the tool
    that reads one reads the other, by the evidence id a citation carries.
    Anything that is not this reader's capture is None, whatever the reason.
    """
    if storage is None or objects is None:
        return None
    try:
        record = storage.get_external_evidence(username, doc_id)
        return {"title": record["title"], "url": record["finalUrl"], "sections": load_sections(objects, record)}
    except Exception:
        return None
