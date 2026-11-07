"""
Gather: the closed evidence set of one event, built before any model is asked.

What a job may be filed from is decided here, by reading the stores, and
nowhere later: the agent and the checker can cite only what the set holds, so
what is left out of it cannot reach a page.

For a **document** event (`gather_document`) the set is the document itself,
by page or by section, and, only when `Settings.memory_web_evidence` is on,
the captured outside sources its digest cites. The reader's notes are not in
it: a note is filed by its document's `session` job, in a run of its own
(`gather_session`), so that what such a run writes can be held to the notes
it rests on (`reader_notes.py`). This module is the one place that setting is read.
While it is off the digest is handed on without the paragraphs that cite an
outside source, so an outside claim cannot be refiled as Delphi's own
inference.

The set carries the event as text (`brief`, in the tags of `brief.py`) and a
reader for the exact words a citation's locator names (`Passages`). The parts
are separate functions over one document, its notes and its captures, and a
session's gather is built from the same parts (`gather_session.py`).

Blocking, like the stores. No model.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable, Mapping
from typing import Any

from ..config import Settings
from ..document_index import PAGE_MARKER
from ..harness.evidence import load_sections
from ..memory import source_page_slug
from ..research_digest import load_digest
from ..storage import ObjectStore, Storage, is_web, paper_key
from . import brief as tags
from . import gather_crossref as crossref
from .blocks import split_blocks
from .jobs import DOCUMENT, document_family, document_fingerprint, read_marker
from .run import EvidenceSet, Readable
from .staging import Evidence

#: The most of one passage the reader hands back: about two of the densest
#: PDF pages seen (8,338 characters). At 6,000 it cut the Chimera paper's
#: page 29 before the sentence a citation of it rested on, and the check, shown
#: the rest, refused a true claim. What one check request may hold is the
#: check's to bound (`verify.PASSAGES_TOTAL_CHARS`).
PASSAGE_MAX_CHARS = 16_000
PASSAGE_CUT = "\n[the passage continues; it was cut here]"

_MARKER = re.compile(r"\[E(\d+)\]")
_LIST_ITEM = re.compile(r"^(?:[-*+]|\d+[.)])\s")


class MissingEvidence(LookupError):
    """What a job is about cannot be read: the document, its text or its digest. The job fails."""


def _anchors(sections: Iterable[Mapping[str, Any]]) -> tuple[str, ...]:
    return tuple(str(section["anchor"]) for section in sections if section.get("anchor"))


def _section_text(sections: Iterable[Mapping[str, Any]], citation: Mapping[str, Any]) -> str | None:
    """The section a citation names, matched the way `cite.check_citations` settles a spelling."""
    sections = list(sections)
    wanted = str(citation.get("section") or "").lstrip("#§").casefold()
    names = [wanted] if wanted else []
    if citation.get("page"):
        # A linked PDF is read by section, and its sections are its pages.
        names.append(f"page-{citation['page']}")
    for name in names:
        for section in sections:
            if str(section.get("anchor") or "").casefold() == name:
                title = str(section.get("title") or "").strip()
                return (f"{title}\n\n" if title else "") + str(section.get("markdown") or "")
    return None


class Passages:
    """
    The exact text a citation's locator names, for the sources of one evidence set.

    A PDF's page, a saved page's section, a captured source's section, a note
    the reader wrote. Only what was added can be read: the set is closed. A PDF's
    text is fetched the first time a page of it is asked for. Anything that
    cannot be found is None and nothing raises, because a checker that is not
    shown a passage reports the claim, and a reader that raised would fail the
    job for a citation the agent got wrong.
    """

    def __init__(self, objects: ObjectStore, username: str) -> None:
        self._objects = objects
        self._username = username
        self._pdfs: dict[str, str] = {}
        self._pages: dict[str, dict[int, str]] = {}
        self._sections: dict[str, list[Mapping[str, Any]]] = {}
        self._notes: dict[str, str] = {}

    def add_pdf(self, project_id: str, paper_id: str) -> None:
        self._pdfs[paper_id] = paper_key(self._username, project_id, paper_id, "txt")

    def add_sections(self, source_id: str, sections: Iterable[Mapping[str, Any]]) -> None:
        """A saved page's sections by its paper id, or a capture's by its evidence id."""
        self._sections[source_id] = list(sections)

    def sections(self, source_id: str) -> tuple[Mapping[str, Any], ...]:
        """The sections added for a source, as they were added."""
        return tuple(self._sections.get(source_id) or ())

    def add_notes(self, notes: Iterable[Mapping[str, Any]]) -> None:
        for note in notes:
            self._notes[note["id"]] = (
                f"Passage the reader marked: {note.get('quotedText') or ''}\n\nWhat the reader wrote: {note.get('body') or ''}"
            )

    def _page(self, paper_id: str, page: Any) -> str | None:
        if paper_id not in self._pages:
            raw = self._objects.get_text(self._pdfs[paper_id])
            self._pages[paper_id] = {
                int(match.group("page")): match.group("text").strip() for match in PAGE_MARKER.finditer(raw)
            }
        return self._pages[paper_id].get(page) if isinstance(page, int) else None

    def _find(self, citation: Mapping[str, Any]) -> str | None:
        if citation.get("noteId"):
            return self._notes.get(citation["noteId"])
        source_id = citation.get("evidenceId") or citation.get("paperId")
        if source_id in self._sections:
            return _section_text(self._sections[source_id], citation)
        if source_id in self._pdfs and not citation.get("evidenceId"):
            return self._page(source_id, citation.get("page"))
        return None

    def texts(self, source: Evidence, limit: int | None = None) -> dict[Any, str]:
        """The first `limit` passages of one document added here, by page or section, in document order; what cannot be read is left out."""
        where = [{"page": number} for number in range(1, source.pages + 1)] if source.pages else [
            {"section": anchor} for anchor in source.sections or ()
        ]
        where = where[:limit] if limit is not None else where
        found = {}
        for locator in where:
            if text := self({"claimType": "author-claim", "paperId": source.id, **locator}):
                found[locator.get("page") or locator.get("section")] = text
        return found

    def __call__(self, citation: Mapping[str, Any]) -> str | None:
        try:
            text = self._find(citation)
        except Exception:
            return None
        if not text or not text.strip():
            return None
        if len(text) > PASSAGE_MAX_CHARS:
            return text[: PASSAGE_MAX_CHARS - len(PASSAGE_CUT)] + PASSAGE_CUT
        return text


def document_source(
    objects: ObjectStore, username: str, project_id: str, paper: Mapping[str, Any], notes: Iterable[Mapping[str, Any]],
    passages: Passages,
) -> Evidence:
    """One document of the library as a source: what a locator into it may name, and its text for the reader."""
    note_ids = frozenset(note["id"] for note in notes)
    title = str(paper.get("title") or "")
    if not is_web(paper):
        passages.add_pdf(project_id, paper["id"])
        return Evidence(paper["id"], title=title, pages=int(paper.get("pages") or 0), notes=note_ids)
    try:
        document = json.loads(objects.get_text(paper_key(username, project_id, paper["id"], "web")))
    except Exception as exc:
        raise MissingEvidence(f"The saved page of document {paper['id']} could not be read: {exc}") from exc
    sections = document.get("sections") or []
    passages.add_sections(paper["id"], sections)
    return Evidence(paper["id"], title=title, sections=_anchors(sections), notes=note_ids)


def unfiled_notes(storage: Storage, username: str, project_id: str, paper_id: str, passages: Passages) -> list[dict[str, Any]]:
    """The notes on a document that no pass has read yet, oldest first, with their text for the reader."""
    notes = sorted(
        storage.list_unfiled_notes(username, project_id, paper_id),
        key=lambda note: (note.get("createdAt") or "", note["id"]),
    )
    passages.add_notes(notes)
    return notes


def external_sources(
    storage: Storage, objects: ObjectStore, username: str, evidence_ids: Iterable[str], passages: Passages
) -> list[tuple[Evidence, dict[str, Any]]]:
    """
    Captured outside sources as sources, each with its stored record.

    A capture that can no longer be read is left out, and what cited it is then
    treated as if web evidence were off: there is nothing to check a claim against.
    """
    found = []
    for evidence_id in dict.fromkeys(evidence_ids):
        try:
            record = storage.get_external_evidence(username, evidence_id)
            sections = load_sections(objects, record)
        except Exception:
            continue
        passages.add_sections(record["id"], sections)
        found.append((Evidence(record["id"], kind="external", title=str(record.get("title") or ""), sections=_anchors(sections)), record))
    return found


def without_blocks(markdown: str, carries: Callable[[str], bool]) -> str:
    """
    Text without the paragraphs `carries` is true of.

    A paragraph, a table or a figure goes whole. A list loses only the items
    it is true of, so one outside claim does not take a list of the
    document's own with it.
    """
    kept: list[str] = []
    for block in split_blocks(markdown):
        if not carries(block.text):
            kept.append(block.text)
            continue
        lines = block.text.splitlines(keepends=True)
        if not _LIST_ITEM.match(lines[0]):
            continue
        items: list[str] = []
        for line in lines:
            if _LIST_ITEM.match(line) or not items:
                items.append(line)
            else:
                items[-1] += line
        left = [item for item in items if not carries(item)]
        if left:
            kept.append("".join(left).rstrip("\n") + "\n\n")
    return "".join(kept).strip()


def without_citations(markdown: str, dropped: set[int]) -> str:
    """A digest's text without the paragraphs that carry any of these `[E#]` markers (`without_blocks`)."""
    if not dropped:
        return markdown
    return without_blocks(markdown, lambda text: any(int(number) in dropped for number in _MARKER.findall(text)))


def library_cross_references(
    storage: Storage, username: str, settings: Settings, texts: Mapping[str, Mapping[Any, str]], *, among: Iterable[str] | None = None,
) -> str:
    """
    The brief's part on what these documents report of other documents of the library (`gather_crossref`).

    `texts` is each document's passages by paper id; `among` limits the documents named.
    """
    papers = [paper for project in storage.list_projects_with_papers(username) for paper in project.get("papers") or ()]
    references = crossref.cross_references(texts, crossref.names(papers), among=among)
    if not references:
        return ""
    source_pages = {
        str(page["sourcePaperId"]): page["slug"]
        for page in storage.list_memory_pages(username, limit=max(1, settings.memory_max_pages))
        if page.get("kind") == "source" and page.get("sourcePaperId")
    }
    return crossref.brief_part(references, {str(paper["id"]): str(paper.get("title") or "") for paper in papers}, source_pages)


def earlier_checks(storage: Storage, username: str, paper_id: str) -> list[Mapping[str, Any]]:
    """
    The pages the last run of this document could not write because the check objected, each with its quote and reason.

    Read from the newest event of the document's markers, the one its card
    lists and Retry answers. Without it a retry starts blind and stages the
    same misreading again: the Chimera ablation's cumulative 4.1x was credited
    to its last component twice running, and the page was dropped both times.
    A page dropped for want of room carries no quote and is not repeated.
    """
    events = storage.latest_marker_events(username, list(document_family(paper_id)))
    last = max(events.values(), key=lambda event: str(event.get("createdAt") or ""), default={})
    return [item for item in last.get("dropped") or () if item.get("quote") and item.get("reason")]


def _earlier_part(checks: Iterable[Mapping[str, Any]]) -> str:
    fenced = [
        tags.fence(
            tags.EARLIER_CHECK,
            f"Objected to: {tags.clip(str(item['quote']), tags.EARLIER_QUOTE_CHARS)}\n"
            f"Why: {tags.clip(str(item['reason']), tags.EARLIER_REASON_CHARS)}",
            page=item.get("slug"), title=tags.clip(str(item.get("title") or ""), 200),
        )
        for item in checks
    ]
    if not fenced:
        return ""
    return (
        "An earlier run of this document staged the pages below, and the Memory check would not let them through. "
        "Each names the sentence the check objected to and why. Before you state that claim again, read the "
        "passage it rests on: write what the passage supports, or leave the claim out. The check can be wrong "
        "too; where the passage bears the sentence out, cite the passage that does.\n" + "\n".join(fenced)
    )


def _document_brief(
    paper: Mapping[str, Any], source_slug: str, sources: Iterable[Evidence], markdown: str,
    citations: Iterable[Mapping[str, Any]], captures: Iterable[Mapping[str, Any]], references: str = "",
    earlier: str = "",
) -> str:
    parts = [
        "A document was added to the reader's library, or its research digest was rewritten.",
        "What this event's own documents offer to cite (`<citable_sources>` in the task lists everything that may "
        "be cited, documents reached through Memory included):\n"
        + "\n".join(tags.describe_source(source) for source in sources),
        f"The document's own page in Memory is [[{source_slug}]]. Delphi writes that page from the digest below.",
        "The document's research digest. Its `[E#]` markers name lines of the evidence index after it:",
        tags.fence(tags.DOCUMENT_DIGEST, markdown, paper_id=paper["id"]),
        tags.fence(tags.DIGEST_EVIDENCE, tags.evidence_index(citations), paper_id=paper["id"]),
    ]
    for record in captures:
        parts.append(tags.fence(
            tags.OUTSIDE_SOURCE, "The digest cites this captured page for:\n" + tags.finding_lines(record.get("findings") or ()),
            evidence_id=record["id"], title=tags.clip(str(record.get("title") or ""), 200),
        ))
    if references:
        parts.append(references)
    if earlier:
        parts.append(earlier)
    return f"<{tags.EVENT} kind=\"{DOCUMENT}\">\n" + "\n\n".join(parts) + f"\n</{tags.EVENT}>"


def gather_document(
    storage: Storage, objects: ObjectStore, username: str, settings: Settings, job: Mapping[str, Any]
) -> EvidenceSet:
    """
    The evidence set of a `document` job: the document and its digest.

    Raises `MissingEvidence` when the document or its digest is gone, which
    fails the job. A digest with nothing in it is not an error: the set comes
    back `skipped` and the job ends `nothing`.
    """
    payload = job.get("payload") or {}
    named = read_marker(str(job.get("marker") or ""))
    project_id = str(payload.get("projectId") or "")
    paper_id = str(payload.get("paperId") or (named.paper_id if named else ""))
    try:
        paper = storage.get_paper(username, project_id, paper_id)
    except Exception as exc:
        raise MissingEvidence(f"Document {paper_id!r} of project {project_id!r} could not be read: {exc}") from exc
    try:
        digest = load_digest(objects, username, project_id, paper_id)
    except Exception as exc:
        raise MissingEvidence(f"Document {paper_id!r} has no research digest to file from: {exc}") from exc

    passages = Passages(objects, username)
    document = document_source(objects, username, project_id, paper, (), passages)
    citations = [item for item in digest.get("citations") or () if isinstance(item, Mapping)]
    outside = [item for item in citations if item.get("claimType") == "external"]
    captures = (
        external_sources(storage, objects, username, (str(item.get("evidenceId") or "") for item in outside), passages)
        if settings.memory_web_evidence
        else []
    )
    held = {source.id for source, _ in captures}
    # An outside claim whose capture is not in the set is cut, text and index
    # line both: with web evidence off that is every one of them.
    dropped = {int(item["id"]) for item in outside if item.get("evidenceId") not in held}
    markdown = without_citations(str(digest.get("contentMarkdown") or ""), dropped)
    sources = (document, *(source for source, _ in captures))
    source_slug = source_page_slug(storage, username, dict(paper), settings)
    references = library_cross_references(
        storage, username, settings, {paper_id: passages.texts(document, crossref.MAX_PASSAGES)}
    )
    return EvidenceSet(
        kind=DOCUMENT,
        marker=str(job.get("marker") or ""),
        project_id=project_id,
        paper_id=paper_id,
        title=document.title,
        author=str(paper.get("title") or ""),
        start_slugs=(source_slug,),
        sources=sources,
        brief=_document_brief(
            paper, source_slug, sources, markdown,
            [item for item in citations if int(item.get("id") or 0) not in dropped],
            [record for _, record in captures], references, _earlier_part(earlier_checks(storage, username, paper_id)),
        ),
        fingerprint=document_fingerprint(digest),
        skipped="" if markdown.strip() else "The document's digest has nothing in it to file.",
        passage=passages,
        readable=Readable(
            paper_id, project_id, document.title, "web" if is_web(paper) else "pdf",
            pages=document.pages, url=str(paper.get("url") or ""), sections=passages.sections(paper_id),
        ),
    )

