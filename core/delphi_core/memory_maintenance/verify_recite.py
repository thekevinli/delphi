"""
Re-citing a true claim whose citation names the wrong passage of its document, before any repair.

The checker reads only the passage a citation names, and is right to: a
claim that passage does not hold is unsupported there. But the digests a job
files from often cite the page where a passage continues, or the page of
another fact in the same sentence; a domain page cites the section beside the
one that says it. A repair told "unsupported" takes a true claim out. So a
blocking `unsupported` or `differs` objection against a document's page or
section is first looked for in the rest of the same document:

- by its words, without a model (`verify_locate.locate`): the one passage
  that holds it, or, for a claim of several facts, the passage of each;
- what words cannot place is asked of a model, in at most two bounded calls
  (`verify_find`), which must copy from each passage it names a sentence the
  passage holds;
- a reference list, or a section listing other pages, is never searched
  (`is_bibliography`, `is_link_list`).

Each passage found is *added* to the citations of the run of markers that
closes the claim's sentence. The old locator stays, because in a sentence of
two facts it may hold the other one. The page then goes to the second check
like any repaired page, so a wrong guess here is caught there, never stored.
An objection that finds no passage is answered by the author's repair, as
before; the passages found are given again to the page the repair wrote
(`reapply`).
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Callable, Hashable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any

from ..config import Settings
from ..harness.provider import ResponsesClient
from .blocks import split_blocks
from .run import EvidenceSet, Objection
from .staging import Evidence, MemoryDraft, StagedPage
from .verify_find import CANDIDATES, Ask, find
from .verify_locate import MARKER, candidates, locate, plain

#: The findings a passage elsewhere in the document can answer.
RECITABLE = ("unsupported", "differs")
#: The most pages of one document read: a longer one is searched only near its cited pages.
DOCUMENT_MAX_PAGES = 400
NEAR_PAGES = 2

#: How many blocks after a claim's own its closing run of markers may be found in.
RUN_BLOCKS_AHEAD = 2

_RUN = re.compile(r"(?:\[[EN]\d+\])+")
_HEADING = re.compile(r" {0,3}#{1,6}[ \t]")
_BIBLIOGRAPHY_NAME = re.compile(r"(?i)(?:\d+\.?\s*)?(?:references?|bibliography|works cited|citations?|参考文献|参考资料)")
# What a reference list's entries carry: an arXiv number, a DOI, a venue.
_ENTRY = re.compile(r"(?i)arxiv(?: preprint)?[: ]|doi[:.]|\bproceedings of\b|\bconference on\b|\bpreprint\b")
#: Entries that make a PDF page a reference list.
BIBLIOGRAPHY_ENTRIES = 8
# A list item that is nothing but a link: `- [Another post](https://… "Another post")`.
_LINK_ITEM = re.compile(r"\s*(?:[-*+]|\d+[.)])\s+\[.*\]\([^\s)]+(?:\s+\"[^\"]*\")?\)\s*")
#: Such items a section must open with to be a list of other pages.
LINK_LIST_ITEMS = 5


@dataclass(frozen=True)
class Recited:
    """One claim given the passages of its document that hold it."""

    slug: str
    quote: str
    source: str
    cited: tuple[Hashable, ...]
    added: tuple[Hashable, ...]
    #: `words` when matching found it, `model` when the finder did.
    how: str = "words"

    def record(self) -> dict[str, Any]:
        return {"slug": self.slug, "quote": self.quote, "source": self.source, "cited": list(self.cited),
                "page": self.added[0], "added": list(self.added), "how": self.how}


def is_bibliography(locator: Hashable, text: str) -> bool:
    """
    A reference list, which states nothing a claim could rest on: a section
    named for one, or a passage most of whose lines are entries of one. Round
    5 re-cited a true claim onto Jordan's `references` section.
    """
    if isinstance(locator, str):
        first = text.strip().splitlines()[0] if text.strip() else ""
        return bool(_BIBLIOGRAPHY_NAME.fullmatch(locator) or _BIBLIOGRAPHY_NAME.fullmatch(first.strip("#*: ").strip()))
    # A page of a PDF: its lines run together, so entries are counted, not lines.
    return len(_ENTRY.findall(text)) >= BIBLIOGRAPHY_ENTRIES


def is_link_list(text: str) -> bool:
    """
    A section of a saved page that opens with a list of links to other pages:
    related reading, and whatever follows it under the same heading, such as
    the readers' comments. It is not what the document says. Each of Su's
    essays ends in one, ten of his other posts and then the comment thread;
    round 5c re-cited a claim of his RoPE essay onto a reader's comment there.
    """
    lines = [line for line in text.splitlines() if line.strip()]
    # The passage reader puts the section's title first.
    if lines and not _LINK_ITEM.fullmatch(lines[0]):
        lines = lines[1:]
    opening = 0
    for line in lines[:LINK_LIST_ITEMS]:
        if not _LINK_ITEM.fullmatch(line):
            break
        opening += 1
    return opening >= LINK_LIST_ITEMS


def _locator(citation: Mapping[str, Any]) -> Hashable | None:
    page, section = citation.get("page"), citation.get("section")
    return page if isinstance(page, int) else section if isinstance(section, str) and section else None


def _ids(run: str, refs: Mapping[str, int]) -> list[int]:
    """The citation ids a run of markers names: `[E3]` is 3, `[N1]` is what the edit gave N1."""
    named = []
    for name in MARKER.findall(run):
        number = refs.get(name) if name.startswith("N") else int(name[1:])
        if number:
            named.append(number)
    return named


def _run_after(text: str, quote: str, cites: Callable[[int], bool], refs: Mapping[str, int]) -> re.Match[str] | None:
    """The run of markers that closes the sentence a quote is from, if it cites the source."""
    words = re.findall(r"\w+", plain(quote))
    runs = [run for run in _RUN.finditer(text) if any(cites(number) for number in _ids(run.group(0), refs))]
    if not words or not runs:
        return None
    tail = re.compile(r"\W+".join(re.escape(word) for word in words[-6:]), re.IGNORECASE)
    if ended := tail.search(text):
        return next((run for run in runs if run.start() >= ended.start()), None)
    # The words are set differently on the page than in the quote: only a single run is unambiguous.
    return runs[0] if len(runs) == 1 and plain(quote) in plain(text) else None


class _Claim:
    """Where one objected claim stands on its staged page: its block, its run of markers, what it cites."""

    def __init__(self, page: StagedPage, quote: str, source: str) -> None:
        self.page, self.quote, self.source = page, quote, source
        self.by_id = {int(citation["id"]): citation for citation in page.citations}
        wanted = plain(quote)
        blocks = split_blocks(page.body)
        at = next((index for index, block in enumerate(blocks) if wanted and wanted in plain(block.content)), None)
        self.block = blocks[at] if at is not None else None
        self.run = _run_after(self.block.content, quote, self.cites, page.refs) if self.block else None
        if self.block is not None and self.run is None:
            # A paragraph that runs into display mathematics closes with the run after it.
            for block in blocks[at + 1: at + 1 + RUN_BLOCKS_AHEAD]:
                if _HEADING.match(block.content):
                    break
                runs = [run for run in _RUN.finditer(block.content) if any(self.cites(n) for n in _ids(run.group(0), page.refs))]
                if runs:
                    self.block, self.run = block, runs[0]
                    break
        named = _ids(self.run.group(0), page.refs) if self.run else []
        self.cited = tuple(dict.fromkeys(_locator(self.by_id[number]) for number in named if self.cites(number)))
        self.template = next((self.by_id[number] for number in named if self.cites(number)), None)

    def cites(self, number: int) -> bool:
        citation = self.by_id.get(number) or {}
        return citation.get("paperId") == self.source and not citation.get("evidenceId") and not citation.get(
            "noteId"
        ) and _locator(citation) is not None

    def placed(self, added: Sequence[Hashable]) -> StagedPage | None:
        """The page with each passage added to the claim's run, or None when the claim cannot be found."""
        if self.run is None or self.template is None or self.block is None:
            return None
        citations, markers = list(self.page.citations), ""
        for locator in added:
            same = next((number for number, citation in self.by_id.items() if self.cites(number) and _locator(citation) == locator), None)
            number = same or max([int(citation["id"]) for citation in citations] or [0]) + 1
            if same is None:
                where = {"page": locator, "section": None} if isinstance(locator, int) else {"page": None, "section": locator}
                citations.append({**self.template, "id": number, **where})
            if f"[E{number}]" not in self.run.group(0):
                markers += f"[E{number}]"
        if not markers:
            # An earlier claim of the same run was given these passages: this one has them too.
            return self.page if set(added) <= set(self.cited) else None
        def marked(text: str, run: re.Match[str]) -> str:
            return text[: run.end()] + markers + text[run.end():]

        body = self.page.body.replace(self.block.content, marked(self.block.content, self.run), 1)
        changes = self.page.changes
        if self.page.action == "edit":
            # The checker reads an edit's changes, not its body: the marker must be in the change that says it.
            changes, done = [], False
            for change in self.page.changes:
                run = _run_after(change.after, self.quote, self.cites, self.page.refs) if plain(self.quote) in plain(change.after) else None
                done |= run is not None
                changes.append(replace(change, after=marked(change.after, run)) if run else change)
            if not done:
                return None
            changes = tuple(changes)
        return replace(self.page, body=body, citations=tuple(citations), changes=changes)


class _Library:
    """The passages of the evidence set's documents, read once each."""

    def __init__(self, evidence: EvidenceSet) -> None:
        self.evidence = evidence
        self.sources: dict[str, Evidence] = {
            source.id: source for source in evidence.sources if source.kind == "document" and (source.pages or source.sections)
        }
        self._read: dict[tuple[str, Hashable], str | None] = {}

    def texts(self, source: str, cited: Sequence[Hashable]) -> dict[Hashable, str]:
        found = self.sources[source]
        if found.via and found.pages:
            # Reached through Memory: only where the pages near the run cite it.
            wanted: list[Hashable] = sorted(found.only_pages)
        elif found.pages:
            near = {number for page in cited if isinstance(page, int) for number in range(page - NEAR_PAGES, page + NEAR_PAGES + 1)}
            wanted: list[Hashable] = [
                number for number in range(1, found.pages + 1) if found.pages <= DOCUMENT_MAX_PAGES or number in near
            ]
        else:
            wanted = list(found.sections or ())
        return {
            locator: text for locator in wanted
            if (text := self._passage(source, locator)) and not is_bibliography(locator, text)
            and not (isinstance(locator, str) and is_link_list(text))
        }

    def _passage(self, source: str, locator: Hashable) -> str | None:
        if (source, locator) not in self._read:
            where = {"page": locator} if isinstance(locator, int) else {"section": locator}
            try:
                self._read[source, locator] = self.evidence.passage({"claimType": "author-claim", "paperId": source, **where})
            except Exception:
                self._read[source, locator] = None
        return self._read[source, locator]


def _place_by_words(
    draft: MemoryDraft, library: _Library, objections: Sequence[Objection]
) -> tuple[list[Recited], list[tuple[Objection, _Claim, dict[Hashable, str]]]]:
    """Stage what words place; hand back the rest that a model may be asked about. Blocking: it reads the documents."""
    recited, asks = [], []
    for objection in objections:
        page = draft.staged_page(objection.slug)
        source = objection.evidence_id or ""
        if page is None or objection.finding not in RECITABLE or source not in library.sources:
            continue
        claim = _Claim(page, objection.quote, source)
        if claim.run is None or not claim.cited:
            continue
        texts = library.texts(source, claim.cited)
        added = locate(objection.quote, texts, claim.cited)
        staged = claim.placed(added) if added else None
        if staged is not None:
            draft.stage(staged)
            recited.append(Recited(page.slug, objection.quote, source, claim.cited, added))
        elif texts:
            asks.append((objection, claim, texts))
    return recited, asks


async def recite(
    client: ResponsesClient, settings: Settings, draft: MemoryDraft, evidence: EvidenceSet,
    objections: Sequence[Objection], *, timeout: float, use_standard_tier: bool,
) -> tuple[list[Objection], list[Recited], dict[str, int]]:
    """
    Re-cite what the document holds in another passage, staging each page changed.

    Returns the objections still standing, what was re-cited (see the module
    docstring) and what the finder's calls used, made side by side within
    `timeout` seconds (`verify_find`).
    """
    library = _Library(evidence)
    recited, open_ = await asyncio.to_thread(_place_by_words, draft, library, objections)
    asks = [
        Ask(
            claim=objection.quote, context=claim.block.content if claim.block else "", explanation=objection.explanation,
            title=library.sources[claim.source].title, cited=claim.cited,
            passages={locator: texts[locator] for locator in candidates(objection.quote, texts, claim.cited, CANDIDATES)},
        )
        for objection, claim, texts in open_
    ]
    found, usage = await find(client, settings, asks, timeout=timeout, use_standard_tier=use_standard_tier) if asks else ({}, {})
    for index, added in sorted(found.items()):
        objection, claim, _ = open_[index]
        # An earlier placement on the same page staged a new version of it: place on that one.
        current = _Claim(draft.staged_page(objection.slug) or claim.page, objection.quote, claim.source)
        staged = current.placed(added)
        if staged is not None:
            draft.stage(staged)
            recited.append(Recited(objection.slug, objection.quote, claim.source, current.cited, added, "model"))
    answered = {(item.slug, item.quote) for item in recited}
    return [item for item in objections if (item.slug, item.quote) not in answered], recited, usage


def reapply(draft: MemoryDraft, recited: Sequence[Recited]) -> None:
    """Give the claims their passages again on the pages a repair wrote, where the claim still stands."""
    for item in recited:
        page = draft.staged_page(item.slug)
        staged = _Claim(page, item.quote, item.source).placed(item.added) if page is not None else None
        if staged is not None:
            draft.stage(staged)
