"""
What one maintenance job carries from stage to stage.

A job runs gather, select, maintain, verify and commit, in that order
(`pipeline.py`). A stage imports no other stage, so what one hands the next is
defined here: the closed evidence set, the selection, what the agent authored,
the checker's objections, and how the job ended.

Nothing here reads storage, calls a model or knows a tool. `staging.py` is the
same kind of module for what one agent run shares between its tool calls.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from .staging import Evidence, MemoryDraft

#: The job kinds an evidence set is gathered for.
JobKind = Literal["document", "session", "reconcile", "domain"]

#: How a job ended. `nothing` is a valid run that found nothing worth filing:
#: no page is written and the event still is, so the marker is settled.
Outcome = Literal["filed", "nothing", "failed"]

#: The four findings the checker may report (§5.7 of the plan).
Finding = Literal["unsupported", "differs", "removed", "overwritten"]

#: The exact text a citation's locator names, or None when there is none to
#: show: a page of a PDF, a section of a saved page or a captured source, a
#: note the reader wrote. Blocking, like the stores it reads.
PassageReader = Callable[[Mapping[str, Any]], str | None]


def _no_passage(citation: Mapping[str, Any]) -> str | None:
    return None


@dataclass(frozen=True)
class Readable:
    """
    The one document a maintenance run may read through a tool: the one its event is about.

    A digest is another model's summary, and its locators and wording can be
    wrong; a run that can read the page it cites can write what the page says.
    One document and no other, because a document runs to tens of pages and a
    run that could read the library would cost what reading the library costs.
    """

    paper_id: str
    project_id: str
    title: str
    kind: Literal["pdf", "web"]
    #: A PDF's page count, or a saved page's address and sections, as the reading tools serve them.
    pages: int = 0
    url: str = ""
    sections: tuple[Mapping[str, Any], ...] = ()


@dataclass(frozen=True)
class EvidenceSet:
    """
    Everything one event may be filed from, built before any model is asked.

    The agent may cite only `sources`. `brief` is the event as text: a
    document's digest with its evidence index, a session's exchanges and
    note changes, what two pages were found to disagree about, or a domain
    with its members. Text in it that came from a document, a web page, a
    page of Memory or the reader's chat is fenced as untrusted by whoever
    built it.
    """

    kind: JobKind
    marker: str
    #: The project and the document the event is about. A Memory chat has neither.
    project_id: str = ""
    paper_id: str = ""
    title: str = ""
    #: What the reader calls whoever wrote this event: the document's title,
    #: or the Memory chat's. The event keeps it, so a page's Written by can
    #: still name an author the reader has since deleted. Empty for upkeep.
    author: str = ""
    #: The Memory chat's generation. Deleting a context's only chat resets it
    #: under the same id for the next question, so the event names which one
    #: wrote. None for a document.
    chat_generation: int | None = None
    #: Where the agent starts: the document's source page, for a Memory chat
    #: the page open beside it and the pages its answers opened, or the pages
    #: found to disagree.
    start_slugs: tuple[str, ...] = ()
    sources: tuple[Evidence, ...] = ()
    brief: str = ""
    #: What the job read, as one hash. A job completes only if the record
    #: still has this fingerprint (`complete_memory_job`).
    fingerprint: str = ""
    #: The chat requests this event covers, oldest first.
    request_ids: tuple[str, ...] = ()
    #: Each note read, by id, with the update time it was read at. A note is
    #: stamped filed only if it still has that time.
    notes: Mapping[str, str] = field(default_factory=dict)
    #: For each conversation the event read, by id, the last request it read
    #: there. The conversation's watermark moves to it once the job is settled.
    filed_through: Mapping[str, str] = field(default_factory=dict)
    #: Notes the reader deleted that pages still cite: note id to those pages.
    #: A staged page may not cite one, and the commit takes the citation off
    #: any page the agent left it on.
    gone_notes: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    #: Notes the reader edited since pages came to cite them: note id to those
    #: pages, which the agent is given whatever the selection says.
    refiled_notes: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    #: Edited notes this job read and will not stamp as filed: the agent was
    #: turned away from a page that cites one (`pipeline._withheld`).
    withheld: tuple[str, ...] = ()
    #: The session has more than this part reads: exchanges past what one
    #: event carries, or notes that wait for a run of their own. The job is
    #: queued again for the rest once this part is settled.
    more: bool = False
    #: Why there is nothing to consider, when gather can tell without a model:
    #: every exchange rested on Memory alone, say. The job then ends `nothing`.
    skipped: str = ""
    #: With `skipped`: the job has nothing to do and nothing to record. It ends
    #: `nothing` with no event and no model call, as a domain does whose
    #: members are as its page was last composed from.
    settled: bool = False
    #: What the job's event keeps of what was read, for the next job of the
    #: same marker: a domain's members, each at the revision read.
    record: Mapping[str, Any] = field(default_factory=dict)
    passage: PassageReader = _no_passage
    #: Only while web evidence is on: the sentences of a session's answers that
    #: link a web page, by address (`gather_session.web_cited`). What the
    #: research pass is asked to re-ground before the selection.
    web_cited: tuple[Mapping[str, Any], ...] = ()
    #: Outside sources captured for this job and not stored yet, each with its
    #: sections. They are in `sources` too. Kept when a page that cites one is
    #: committed, and only then.
    captured: tuple[Mapping[str, Any], ...] = ()
    #: What the job's research passes did, for its event: hosted calls made,
    #: what was captured, what was dropped and why (`gather_outside.py`).
    outside: Mapping[str, Any] = field(default_factory=dict)
    #: The document the run may read page by page, or None: only a document's
    #: own event has one (`gather.gather_document`).
    readable: Readable | None = None


@dataclass(frozen=True)
class Selection:
    """What the cheap call over the index answered for one event."""

    nothing_to_file: bool
    reason: str = ""
    #: Pages the event bears on, by slug, most relevant first. Existing pages only.
    pages: tuple[str, ...] = ()
    #: A question a published source outside the library could settle. The
    #: research pass is asked it only while web evidence is on.
    needs_outside: str | None = None
    usage: Mapping[str, int] = field(default_factory=dict)


@dataclass
class Authored:
    """What the agent's loop left: the draft, and enough to resume it for a repair."""

    draft: MemoryDraft
    #: The request the loop ran, with the conversation as it stood at the end,
    #: so a repair resumes the same run and never starts a second author.
    request: dict[str, Any] = field(default_factory=dict)
    #: What the agent said when it finished, for the event's summary.
    closing: str = ""
    #: `completed`, or why the loop was cut off (`deadline`, the provider's reason).
    ended: str = "completed"
    rounds: int = 0
    usage: Mapping[str, int] = field(default_factory=dict)
    #: Each tool call the run made, as the answer trace records one.
    trace: list[dict[str, Any]] = field(default_factory=list)
    #: Pages the agent staged that the stage itself took back, with the reason:
    #: a page created when the account had no room for another.
    dropped: list["Dropped"] = field(default_factory=list)
    #: The document the run could read, so a repair resumes it with the same tools.
    readable: Readable | None = None


@dataclass(frozen=True)
class Objection:
    """One thing the checker reported about one page."""

    slug: str
    finding: Finding
    #: The text of the page the objection is about, as the checker quoted it.
    quote: str
    explanation: str
    #: For an unsupported claim: the evidence the claim cites and is not in.
    evidence_id: str | None = None
    #: Decided by Delphi's rule, never by the checker (`verify.py`).
    blocking: bool = False


@dataclass(frozen=True)
class Verdicts:
    """The checker's objections for the pages of one job."""

    objections: tuple[Objection, ...] = ()
    usage: Mapping[str, int] = field(default_factory=dict)
    #: Claims Delphi gave the passages of their document that hold them, before
    #: any repair (`verify_recite.py`): slug, quote, source, cited, added, how.
    recited: tuple[Mapping[str, Any], ...] = ()
    #: Every objection that blocked a page, in each check, and whether it was
    #: re-cited: what a person labels objections from.
    blocked: tuple[Mapping[str, Any], ...] = ()
    #: What each page has passed so far, by unit (`verify_again.unit_key`):
    #: what a later check of the page is not shown again.
    passed: Mapping[str, frozenset[str]] = field(default_factory=dict)
    #: Every claim each page has passed, by its words, with the locators it
    #: passed on (`verify_claims.claims`): what a later check may object to
    #: only as advice.
    claims: Mapping[str, Mapping[str, frozenset[str]]] = field(default_factory=dict)

    def blocking(self, slug: str) -> tuple[Objection, ...]:
        return tuple(item for item in self.objections if item.blocking and item.slug == slug)

    @property
    def advisory(self) -> tuple[Objection, ...]:
        return tuple(item for item in self.objections if not item.blocking)


@dataclass(frozen=True)
class Dropped:
    """A staged page that was not committed, as the job's event reports it."""

    slug: str
    title: str
    action: Literal["edit", "create"]
    reason: str
    quote: str = ""
    #: For a page the check dropped: why the sentences objected to were not
    #: struck instead, so a page lost over one sentence can be told from a
    #: strike that did its work (`verify_again.Refused`).
    unstruck: str = ""
    #: The page as it was staged when it was dropped: what that question is
    #: answered from, since nothing else keeps a page that was never written.
    body: str = ""
    summary: str = ""


class JobDeadline(Exception):
    """The job ran out of its one deadline. It ends `failed` with the reason `deadline`."""


class StaleRevision(Exception):
    """
    Memory moved on under a job: nothing was written, and the job is due again at once.

    `slugs` are the pages concerned: an edit of a page whose stored revision is
    no longer the one staged against, or that was deleted; a new page whose
    slug or name another job took meanwhile (`commit._stale`,
    `verify_round.taken`).
    """

    def __init__(self, slugs: Sequence[str]) -> None:
        super().__init__("Memory changed while the job ran: " + ", ".join(slugs))
        self.slugs = tuple(slugs)


class NothingToFile(Exception):
    """A stage found there is nothing to file. Carries the reason for the event."""
