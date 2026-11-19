"""
Where one run of a document's filing stands: how many runs its length gives
it, what of its digest Memory has filed, and what the runs before it wrote and
handed on.

A document is filed in runs of at most `jobs.PAGES_PER_RUN` pages, as many as
`jobs.FilingBudget` gives its length, and each run goes on to the next only
when it hands on what it had no room for (`leave_for_later`). The next run
reads that from the event the run before left, so it continues rather than
starting again:

- **The budget** is the factor the document's digest was written to
  (`research_digest.stored_digest_budget`), not the document's length. The
  agent files from the digest, and runs follow what it shows: in the eval,
  every long document whose digest was written to its length used every run,
  and every one whose digest was written before digests scaled (a standard
  digest, 8,000 characters for a 120,000-character paper) stopped after one
  or two, having filed most of what that digest names. A digest rewritten to
  its length raises the budget with it, and publishing one files the document
  again.
- **What is filed** is read from the stored pages, per line of the digest's
  evidence index (`staging.DigestLine`): a line is filed when a concept page
  cites the place it locates. A run that has a later run is shown the lines
  that are not, and names those it hands on. Without the list a run handed on
  refinements of the page it had just written: Why Larger Models stopped
  after one of two runs with its main experiments (pp. 7–10) on no page, and
  every run that stopped early left 12–50% of its digest's lines uncited.
  The pages read are the concept pages written from the document and those
  its filings' events name; a page another document's filing wrote that
  cites this one is not read.
- **The filing** is the document's newest run 0 and the runs after it that
  are no older. A later run of an earlier filing, before the document was
  filed again, is not this one's.
- **What is handed on** is the run just before's `left`, and only while that
  run is this filing's. The pages it names that exist are opened for the
  agent; the rest are ideas to create.

The brief's parts are fenced as `<earlier_run>` and `<unfiled_evidence>`: a
run's notes, its list and the digest's names for its lines are an author's
words about the document's words.

Blocking, like the stores. No model.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any

from ..config import Settings
from ..research_digest import digest_evidence_labels, stored_digest_budget
from ..storage import Storage
from . import brief as tags
from .jobs import FilingBudget, document_family, document_marker
from .staging import DigestLine, LeftItem


@dataclass(frozen=True)
class Filing:
    """One run's place in its document's filing."""

    part: int
    budget: FilingBudget
    #: What the run before handed on.
    left: tuple[LeftItem, ...] = ()
    #: The pages it names that exist, for the agent to start from.
    open: tuple[str, ...] = ()
    #: The digest's evidence lines, each marked filed or not.
    digest: tuple[DigestLine, ...] = ()
    #: The brief's part on what the earlier runs did and what is unfiled; empty for a run with neither.
    brief: str = ""

    @property
    def continues(self) -> bool:
        return self.part + 1 < self.budget.runs


def filing_budget(paper: Mapping[str, Any]) -> FilingBudget:
    """The runs a document's filing may take: as many as its digest was written for (see the module docstring)."""
    return FilingBudget(stored_digest_budget(dict(paper)).factor)


def earlier_runs(storage: Storage, username: str, paper_id: str, part: int) -> list[Mapping[str, Any]]:
    """The events of this filing's runs before `part`, in order (see the module docstring)."""
    if part <= 0:
        return []
    family = document_family(paper_id)[:part]
    events = storage.latest_marker_events(username, list(family))
    first = events.get(family[0])
    if first is None:
        return []
    since = str(first.get("createdAt") or "")
    return [events[marker] for marker in family if marker in events and str(events[marker].get("createdAt") or "") >= since]


def _written(event: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [dict(edit) for edit in event.get("edits") or ()] or [{"slug": slug} for slug in event.get("pages") or ()]


def filed_citations(storage: Storage, username: str, settings: Settings, paper_id: str) -> list[Mapping[str, Any]]:
    """The citations of this document on the concept pages written from it (see the module docstring)."""
    slugs = {
        str(page["slug"])
        for page in storage.list_memory_pages(username, kinds=["concept"], limit=max(1, settings.memory_max_pages))
        if page.get("sourcePaperId") == paper_id
    }
    for event in storage.latest_marker_events(username, list(document_family(paper_id))).values():
        slugs.update(str(edit["slug"]) for edit in _written(event) if edit.get("slug"))
    found: list[Mapping[str, Any]] = []
    for slug in sorted(slugs):
        try:
            page = storage.get_memory_page(username, slug)
        except Exception:
            continue
        if page.get("kind") == "concept":
            found += [item for item in page.get("citations") or () if isinstance(item, Mapping)]
    return found


def digest_lines(
    paper_id: str, citations: Iterable[Mapping[str, Any]], markdown: str, filed: Sequence[Mapping[str, Any]],
) -> tuple[DigestLine, ...]:
    """The document's own evidence lines of its digest, each marked filed when a page in `filed` cites its place."""
    labels = digest_evidence_labels(markdown)
    lines = []
    for item in citations:
        if item.get("claimType") == "external" or not (item.get("page") or item.get("section")):
            continue
        line = DigestLine(
            int(item["id"]), tags.clip(" ".join(labels.get(int(item["id"]), "").split()), tags.EVIDENCE_LABEL_CHARS),
            page=item.get("page") if isinstance(item.get("page"), int) else None,
            section=str(item["section"]) if item.get("section") and not item.get("page") else None,
        )
        lines.append(replace(line, filed=any(line.located_by(paper_id, citation) for citation in filed)))
    return tuple(lines)


def brief_part(
    before: Sequence[Mapping[str, Any]], left: Sequence[LeftItem], existing: set[str], digest: Sequence[DigestLine] = (),
) -> str:
    """What the earlier runs of this filing wrote, and what the run before this one handed on."""
    if not before:
        return ""
    by_id = {line.id: line for line in digest}
    wrote = [
        f"- [[{edit['slug']}]] ({edit.get('action') or 'written'})"
        + (f": {tags.clip(' '.join(str(edit['note']).split()), tags.EARLIER_NOTE_CHARS)}" if edit.get("note") else "")
        for event in before for edit in _written(event) if edit.get("slug")
    ]
    handed = [
        (f"- [[{item.target}]]" if item.target in existing else f"- A page to create, “{item.target}”")
        + (f": {tags.clip(item.what, tags.EARLIER_LEFT_CHARS)}" if item.what else ": the run had no room to write it")
        + (f" (evidence: {'; '.join(by_id[number].shown() for number in item.evidence if number in by_id)})"
           if any(number in by_id for number in item.evidence) else "")
        for item in left
    ]
    text = "\n".join([
        "Written by the earlier runs of this filing:" if wrote else "The earlier runs of this filing wrote no page.",
        *wrote, "", "Handed on to this run by the run before it:", *handed,
    ])
    return (
        "This filing of the document is in runs, and earlier runs have done part of it. Start from what was "
        "handed on to this run. Do not write again what an earlier run wrote: open such a page only to add "
        "something it does not yet say.\n" + tags.fence(tags.EARLIER_RUN, text, runs=len(before))
    )


def unfiled_part(digest: Sequence[DigestLine], later: int) -> str:
    """The digest's lines no page cites yet, for a run with `later` runs after it."""
    unfiled = [line for line in digest if not line.filed]
    if not unfiled or later <= 0:
        return ""
    return (
        f"No Memory page cites these lines of the digest's evidence yet. This filing has {later} "
        f"run{'s' if later != 1 else ''} after this one. Of these, what this run does not file and is worth a "
        "page, hand on with `leave_for_later`, naming its lines: a line no run files or hands on is not filed.\n"
        + tags.fence(tags.UNFILED_EVIDENCE, "\n".join(line.shown() for line in unfiled), lines=len(unfiled))
    )


def of_filing(
    storage: Storage, username: str, settings: Settings, paper: Mapping[str, Any], part: int,
    citations: Iterable[Mapping[str, Any]] = (), markdown: str = "",
) -> Filing:
    """Where run `part` of a document's filing stands, given its digest's evidence index and text."""
    paper_id = str(paper["id"])
    budget = filing_budget(paper)
    before = earlier_runs(storage, username, paper_id, part)
    # Only the run just before hands on to this one: a run queued by another
    # filing of the document, whose run before is not in this one, is handed nothing.
    previous = before[-1] if before and before[-1].get("marker") == document_marker(paper_id, part - 1) else {}
    left = tuple(item for item in map(LeftItem.read, previous.get("left") or ()) if item is not None)
    later = budget.runs - part - 1
    existing = {
        page["slug"] for page in storage.list_memory_pages(username, limit=max(1, settings.memory_max_pages))
    } if left else set()
    filed = filed_citations(storage, username, settings, paper_id) if later > 0 else []
    digest = digest_lines(paper_id, citations, markdown, filed)
    return Filing(
        part=part, budget=budget, left=left,
        open=tuple(dict.fromkeys(item.target for item in left if item.target in existing)),
        digest=digest,
        brief="\n\n".join(piece for piece in (brief_part(before, left, existing, digest), unfiled_part(digest, later)) if piece),
    )
