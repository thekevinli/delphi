"""
What one maintenance run has written and not yet stored.

A write tool validates and stages; nothing reaches storage while the agent's
loop runs. A `MemoryDraft` is where a staged page waits, and it is everything
one run shares between its tool calls:

- **What the run may cite** (`evidence`): the closed evidence set, by id. An
  `Evidence` says enough about a source to check a locator against it: how
  many pages a PDF has, which sections a saved page has, which notes the
  reader wrote on it.
- **What the run has been shown** (`shown`): each page `open_memory` opened,
  by slug, with the body and revision as shown. An edit addresses a page as it
  was shown, so only an opened page can be edited, and a later edit of the
  same page addresses the same showing, never the result of the edit before.
- **What the run has staged** (`staged`): at most `max_pages` pages, each a
  whole resulting page with what led to it. A second write for a slug replaces
  the first.
- **What the run leaves for the next run of its document** (`left`): each
  page to change or idea to explain that had no room here, with what it
  should get and the digest lines it rests on. The pipeline queues that
  run, and hands it this list.
- **What of the document's digest is still unfiled** (`unaccounted`): its
  evidence lines that no stored page, no staged page and no handed-on item
  accounts for.

The draft holds and counts. What a write must pass before it is staged is
`admit.py`; the stage that runs the loop reads `staged` when the loop ends,
has each page checked, and commits what passed.

Nothing here reads storage, calls a model or knows a tool.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

#: Where a document's page waits until its document is filed. It is no domain:
#: no page is staged or moved into it, and it never has a page of its own.
UNSORTED_DOMAIN = "general"

#: Pages one run may stage, where the caller does not say (§4.4 of the plan).
MAX_PAGES = 2


@dataclass(frozen=True)
class Evidence:
    """One source the run may cite, and what a locator into it may name."""

    id: str
    #: A document of the library (`paperId`), or a captured outside source (`evidenceId`).
    kind: Literal["document", "external"] = "document"
    title: str = ""
    #: A PDF's page count. Zero for a source read by section.
    pages: int = 0
    #: The anchors of a source read by section; None for one read by page.
    sections: tuple[str, ...] | None = None
    #: The ids of the reader's notes on a document.
    notes: frozenset[str] = frozenset()
    #: A source the run reaches only through Memory: the pages near its start
    #: that cite it (`gather.neighbourhood`). It may be cited only where they
    #: cite it: at these pages of a PDF, or at the sections left in `sections`.
    via: tuple[str, ...] = ()
    only_pages: frozenset[int] = frozenset()


@dataclass(frozen=True)
class ExistingPage:
    """A stored page, as much of it as a write is checked against."""

    slug: str
    title: str
    kind: str
    aliases: tuple[str, ...] = ()
    revision: int = 0


@dataclass(frozen=True)
class ShownPage:
    """A page as `open_memory` showed it to the run."""

    slug: str
    kind: str
    revision: int
    title: str
    domain: str
    summary: str
    body: str
    aliases: tuple[str, ...] = ()
    #: In the stored shape (`id`, `claimType` and the locator fields).
    citations: tuple[dict[str, Any], ...] = ()
    figures: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True)
class StagedPage:
    """One page a run means to write: the whole result, and what led to it."""

    slug: str
    action: Literal["edit", "create"]
    #: The revision the page was read at, which the commit expects. 0 for a create.
    revision: int
    title: str
    aliases: tuple[str, ...]
    domain: str
    summary: str
    body: str
    citations: tuple[dict[str, Any], ...]
    figures: tuple[dict[str, Any], ...] = ()
    #: The domain as the author wrote it ("LLM serving"), for a create: the
    #: name a domain this page brings into being is given.
    domain_title: str = ""
    #: `concept` from the write tools; `domain` from the domain composer.
    kind: str = "concept"
    #: One line on what this write did to the page, for the page's history.
    note: str = ""
    #: An edit's operations as `ops.apply_operations` recorded them.
    changes: tuple[Any, ...] = ()
    #: The id each new reference was given: `{"N1": 4}`.
    refs: Mapping[str, int] = field(default_factory=dict)
    #: Every citation an operation named as its evidence, by the name it was
    #: given (`N2`, `E3`), as a locator. A delete's evidence is cited by no
    #: marker, so it is on no page: it is kept here for the event.
    evidence: Mapping[str, dict[str, Any]] = field(default_factory=dict)
    #: The derived numbers the write stated, as given and recomputed.
    calculations: tuple[dict[str, Any], ...] = ()
    #: Links that had no page behind them and were written as their words.
    repaired: tuple[str, ...] = ()
    #: For a create: the pages said to explain the same idea, and the author's
    #: sentence on why this one is a different idea.
    distinct_from: tuple[str, ...] = ()
    distinct_reason: str = ""


#: What one run may hand on: more than the next runs could write is a list of
#: everything, not a choice.
LEFT_MAX_ITEMS = 10


@dataclass(frozen=True)
class DigestLine:
    """
    One line of a document's digest evidence index (`[E#]`), as a run of its
    filing is shown it and a handoff names it.

    `filed` is read from the stored pages: some concept page already cites the
    place it locates, so Memory has filed it, by this filing or an earlier one.
    """

    id: int
    #: What the digest's prose calls it (`research_digest.digest_evidence_labels`).
    label: str = ""
    page: int | None = None
    section: str | None = None
    filed: bool = False

    @property
    def name(self) -> str:
        return f"E{self.id}"

    def where(self) -> str:
        return f"p. {self.page}" if self.page else f"§{self.section}" if self.section else ""

    def shown(self) -> str:
        """The line as a brief and the handoff's answer show it: `E7 · p. 8 · OLMo pretraining`."""
        return " · ".join(part for part in (self.name, self.where(), self.label) if part)

    def located_by(self, paper_id: str, citation: Mapping[str, Any]) -> bool:
        """A citation of this document names the place this line locates."""
        if citation.get("paperId") != paper_id or citation.get("evidenceId") or citation.get("noteId"):
            return False
        if self.page:
            return citation.get("page") == self.page
        wanted = str(self.section or "").lstrip("#§").casefold()
        return bool(wanted) and str(citation.get("section") or "").lstrip("#§").casefold() == wanted


@dataclass(frozen=True)
class LeftItem:
    """
    One thing a run had no room for: a page's slug or a new idea's name, what
    it should get, and the digest lines (`DigestLine.id`) its evidence is.

    A handoff names its evidence (`leave_for_later` refuses one that does
    not); a write turned away for room is handed on without any.
    """

    target: str
    what: str = ""
    evidence: tuple[int, ...] = ()

    def stored(self) -> dict[str, Any]:
        return {"target": self.target, "what": self.what, "evidence": list(self.evidence)}

    @classmethod
    def read(cls, stored: Any) -> LeftItem | None:
        """An item as an event keeps it, or None for what is not one."""
        if not isinstance(stored, Mapping) or not str(stored.get("target") or "").strip():
            return None
        evidence = stored.get("evidence") or ()
        return cls(
            str(stored["target"]), str(stored.get("what") or ""),
            tuple(dict.fromkeys(int(item) for item in evidence if isinstance(item, int) and not isinstance(item, bool)))
            if isinstance(evidence, (list, tuple)) else (),
        )


class DraftFull(ValueError):
    """A run tried to stage more pages than it may. The message is for the agent."""


class MemoryDraft:
    """One run's evidence, the pages it was shown, and the pages it has staged."""

    def __init__(
        self, evidence: Iterable[Evidence] = (), *, max_pages: int = MAX_PAGES, gone_notes: Iterable[str] = (),
        notes: Iterable[str] = (), document: str = "", digest: Iterable[DigestLine] = (),
    ) -> None:
        self.max_pages = max_pages
        #: A document run's document, and its digest's evidence lines.
        self.document = document
        self.digest: tuple[DigestLine, ...] = tuple(digest)
        self.evidence: dict[str, Evidence] = {item.id: item for item in evidence}
        #: Notes the reader deleted. A page staged in this run may not cite one,
        #: nor keep the words of what rested only on one (`reader_notes`).
        self.gone_notes: frozenset[str] = frozenset(gone_notes)
        #: The reader's notes this run files. A run that files notes files
        #: nothing else, so what it writes cites one of them unless a
        #: document's page says it (`reader_notes.unrested`).
        self.notes: frozenset[str] = frozenset(notes)
        self.shown: dict[str, ShownPage] = {}
        #: What the same-idea check answered for a page being created, by its
        #: slug. Asked once in a run: a second answer that named a different
        #: page would refuse an author who had just answered the first.
        self.same_idea: dict[str, tuple[str, ...]] = {}
        #: Slugs a write was refused for because the run had staged its pages.
        self.turned_away: list[str] = []
        #: What the run handed on (`leave_for_later`); a second call replaces it.
        self.handed_on: tuple[LeftItem, ...] = ()
        self._staged: dict[str, StagedPage] = {}

    @property
    def left(self) -> tuple[LeftItem, ...]:
        """
        What the next run of the document is handed: what this run handed on,
        then each write it was turned away from that it did not name.
        """
        named = {item.target for item in self.handed_on}
        return (*self.handed_on, *(LeftItem(slug) for slug in self.turned_away if slug not in named))[:LEFT_MAX_ITEMS]

    def unaccounted(self) -> tuple[DigestLine, ...]:
        """The digest lines no page cites, none staged here cites, and nothing handed on names."""
        named = {number for item in self.handed_on for number in item.evidence}
        cited = [citation for page in self._staged.values() for citation in page.citations]
        return tuple(
            line for line in self.digest
            if not line.filed and line.id not in named
            and not any(line.located_by(self.document, citation) for citation in cited)
        )

    def show(self, page: ShownPage) -> None:
        """Record a page as the run was just shown it. A later showing replaces an earlier."""
        self.shown[page.slug] = page

    @property
    def staged(self) -> tuple[StagedPage, ...]:
        """The staged pages, in the order each slug was first staged."""
        return tuple(self._staged.values())

    def staged_page(self, slug: str) -> StagedPage | None:
        return self._staged.get(slug)

    @property
    def created(self) -> frozenset[str]:
        """Slugs of the pages this run creates: a link to one resolves in the same commit."""
        return frozenset(slug for slug, page in self._staged.items() if page.action == "create")

    def full_problem(self, slug: str) -> str | None:
        """Why a write for this slug cannot be staged for want of room, or None."""
        if slug in self._staged or len(self._staged) < self.max_pages:
            return None
        if slug not in self.turned_away:
            self.turned_away.append(slug)
        held = ", ".join(f"`{name}`" for name in self._staged)
        return (
            f"This run has staged {held}, and {self.max_pages} "
            f"{'page is' if self.max_pages == 1 else 'pages are'} the most one run may write. "
            f"Change one of those, or leave `{slug}` for a later run."
        )

    def stage(self, page: StagedPage) -> StagedPage | None:
        """Stage a page, replacing what was staged for its slug. Returns what it replaced."""
        if problem := self.full_problem(page.slug):
            raise DraftFull(problem)
        replaced = self._staged.get(page.slug)
        self._staged[page.slug] = page
        return replaced

    def discard(self, slug: str) -> StagedPage | None:
        """Drop a staged page: the checker blocked it, or the commit lost its revision."""
        return self._staged.pop(slug, None)
