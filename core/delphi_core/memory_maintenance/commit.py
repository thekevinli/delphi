"""
The one atomic write that ends a maintenance job.

`commit` is handed the staged pages that passed the check, possibly none, and
what the earlier stages returned. It writes the pages, their version rows and
the job's event through `storage.commit_memory_update`, in one transaction,
under the job's lease. Nothing else in the pipeline stores a page.

- **Every page is written against the revision it was read at**
  (`expectedRevision`, 0 for a new page). A page that changed since the agent
  read it refuses the whole commit, and that is `StaleRevision` here: the
  store answers 409 for that and for a full account alike, so the revisions
  are read again to tell which it was. Nothing was written; the pipeline tries
  the job again against the fresh page.
- **Links are repaired once more**, against the pages that exist now and the
  pages this commit creates. A page may have been deleted since the agent
  staged, and a link with no page behind it is stored as its words.
- **An edit keeps what it did not touch**: the page's provenance (the store
  keeps it when a write names none), its tags and its figures, which the
  store would otherwise drop with the body they belonged to.
- **The event is written whatever the outcome** (`event.py`). A job that
  staged pages and had every one dropped ends `failed`: no page is written,
  and its event lists what was dropped without settling the job's marker.
- **Notes are stamped filed after the commit**, and only those that still
  have the update time the job read them at. The store has no conditional
  stamp, so the comparison is made here; a note edited while the job ran
  stays unfiled for the next one.

- **A session is settled after the commit**, and a note the reader deleted
  leaves no citation on any page (`commit_session.py`).

A commit enqueues no `document` or `session` job. The store itself queues a
`domain` job for a domain a written page joined or left, or whose member's
summary the write changed (`storage/domains.py`), and for nothing else.

A domain's own page comes through here like any staged page: its kind is the
staged page's (`StagedPage.kind`), and its trigger is `domain`.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import replace
from typing import Any

from fastapi import HTTPException

from ..config import Settings
from ..memory import MEMORY_VERSION, clean_memory_summary
from ..storage import Storage
from ..storage.base import memory_slug
from .commit_session import settle, stamp_notes, without_gone_notes
from .event import build_event, outcome_of, trigger_of
from .jobs import UNSORTED_DOMAIN
from .run import Authored, Dropped, EvidenceSet, Selection, StaleRevision, Verdicts
from .staging import StagedPage
from .validate import repair_links

logger = logging.getLogger(__name__)
_SLUG_LIKE = re.compile(r"[a-z0-9]+(?:[-_][a-z0-9]+)+")


def _stored(storage: Storage, username: str, slug: str) -> dict[str, Any] | None:
    try:
        return storage.get_memory_page(username, slug)
    except HTTPException as error:
        if error.status_code != 404:
            raise
        return None


def _stale(storage: Storage, username: str, pages: Sequence[StagedPage]) -> list[str]:
    return [
        page.slug for page in pages
        if ((_stored(storage, username, page.slug) or {}).get("revision") or 0) != page.revision
    ]


def _records(
    storage: Storage, username: str, settings: Settings, evidence: EvidenceSet, kind: str, pages: Sequence[StagedPage]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[StagedPage]]:
    """Each page as the store takes it, the figures to carry over, and the pages as written."""
    existing = {page["slug"] for page in storage.list_memory_pages(username, limit=settings.memory_max_pages)}
    resolves = existing | {page.slug for page in pages}
    records: list[dict[str, Any]] = []
    figures: list[dict[str, Any]] = []
    written: list[StagedPage] = []
    for page in pages:
        stored = _stored(storage, username, page.slug) if page.action == "edit" else None
        known = set(resolves)
        if stored is not None:
            # A link the stored page already had with no page behind it is in a
            # block this edit did not name, and is not this edit's to rewrite.
            known |= set(repair_links(stored.get("body") or "", resolves)[1])
        body, repaired = repair_links(page.body, known)
        record: dict[str, Any] = {
            "slug": page.slug,
            "kind": page.kind,
            "domain": page.domain,
            "title": page.title,
            "summary": clean_memory_summary(page.summary, settings.memory_summary_max_chars),
            "body": body,
            "aliases": list(page.aliases),
            "citations": [dict(citation) for citation in page.citations],
            "expectedRevision": page.revision,
            "_eventNote": page.note,
        }
        if page.action == "create":
            if kind == "document" and evidence.paper_id and page.kind == "concept":
                record["sourcePaperId"] = evidence.paper_id
        else:
            record["tags"] = list((stored or {}).get("tags") or ())
            # The figures the page has now, where it can be read: the revision
            # check holds the body to what was shown, and a figure is added
            # without a revision.
            held = (stored or {}).get("figures") if stored is not None else page.figures
            figures += [{**figure, "pageSlug": page.slug} for figure in held or ()]
        records.append(record)
        written.append(page if body == page.body else _with_body(page, body, repaired))
    return records, figures, written


def _with_body(page: StagedPage, body: str, repaired: Sequence[str]) -> StagedPage:
    return replace(page, body=body, repaired=tuple(dict.fromkeys([*page.repaired, *repaired])))


def _domains_named(storage: Storage, username: str) -> set[str] | None:
    """The domains Memory has before this write, or None when they cannot be read."""
    try:
        return {str(domain["slug"]) for domain in storage.memory_domains(username)}
    except Exception:
        logger.warning("could not read the domains of %s", username, exc_info=True)
        return None


def _name_new_domains(storage: Storage, username: str, pages: Sequence[StagedPage], before: set[str] | None) -> None:
    """
    Give a domain this write brought into being the name its author wrote.

    Otherwise it is named from its slug, and "LLM serving" reads "Llm serving".
    A domain that existed keeps its name, which may be the reader's. Never
    raises: a domain named from its slug is the worse name, not a failure.
    """
    if before is None:
        return
    for page in pages:
        title = page.domain_title
        if page.action != "create" or not title or page.domain in before or page.domain == UNSORTED_DOMAIN:
            continue
        if memory_slug(title) != page.domain:
            continue
        try:
            storage.upsert_memory_domain(username, {"slug": page.domain, "title": domain_title(title, page)})
            before.add(page.domain)
        except Exception:
            logger.warning("could not name the domain %s", page.domain, exc_info=True)


def domain_title(written: str, page: StagedPage) -> str:
    """
    The name a new domain is given from what its author wrote. A slug written
    as a name ("scaling-laws", "llm-architectures", round 5b) is read as words,
    and a word the page itself writes in capitals keeps them: "LLM architectures".
    """
    if " " in written.strip() or not _SLUG_LIKE.fullmatch(written.strip()):
        return written[:1].upper() + written[1:]
    text = f"{page.title} {page.summary} {page.body}"
    words = []
    for word in re.split(r"[-_]+", written.strip()):
        upper = word.upper()
        words.append(upper if len(word) > 1 and re.search(rf"\b{re.escape(upper)}s?\b", text) else word)
    named = " ".join(words)
    return named[:1].upper() + named[1:]


def _join_its_concepts(storage: Storage, username: str, evidence: EvidenceSet, pages: Sequence[StagedPage]) -> str | None:
    """
    Move a document's source page out of the unsorted domain, into the domain of the page written from it.

    A source page is derived when the digest is published, before anything
    says what field the document belongs to. The first job that writes a
    concept from it settles that. A source page already in a domain stays
    there: the reader or an earlier job put it there. Never raises: the pages
    are committed, and a page left unsorted is found again by the next job.
    """
    domain = next((page.domain for page in pages if page.domain and page.domain != UNSORTED_DOMAIN), None)
    if not domain or not evidence.paper_id:
        return None
    try:
        unsorted = [
            slug for slug in evidence.start_slugs
            if (stored := _stored(storage, username, slug)) is not None
            and stored.get("kind") == "source" and (stored.get("domain") or UNSORTED_DOMAIN) == UNSORTED_DOMAIN
        ]
        if unsorted:
            storage.move_memory_pages(username, unsorted, domain)
            return domain
    except Exception:
        logger.warning("could not move the source page of %s into %s", evidence.marker, domain, exc_info=True)
    return None


def commit(
    storage: Storage,
    username: str,
    settings: Settings,
    *,
    job: Mapping[str, Any],
    evidence: EvidenceSet,
    selection: Selection | None,
    pages: Sequence[StagedPage],
    dropped: Sequence[Dropped],
    verdicts: Verdicts | None,
    authored: Authored | None,
) -> dict[str, Any]:
    """
    Write the pages that passed and the job's event, atomically. Blocking.

    Returns what `commit_memory_update` returned (`pages`, `figures`,
    `event`, `supersededObjectKeys` without the figures carried over), with
    `outcome` (`filed`, `nothing` or `failed`), `notesFiled` and
    `conversationsSettled`. Raises
    `StaleRevision` when a page moved on, `MemoryJobGone` when the job's
    lease is no longer held, and the store's own error for anything else. In
    each of those cases nothing was written.
    """
    pages = [*pages, *without_gone_notes(storage, username, evidence, pages)]
    outcome = outcome_of(pages, dropped)
    named = _domains_named(storage, username)
    records, figures, written = _records(storage, username, settings, evidence, str(job["kind"]), pages)
    event = build_event(
        job=job, version=MEMORY_VERSION, evidence=evidence, selection=selection, pages=written,
        dropped=dropped, verdicts=verdicts, authored=authored,
    )
    try:
        committed = storage.commit_memory_update(
            username,
            pages=records,
            figures=figures,
            event=event,
            max_pages=settings.memory_max_pages,
            max_figures_per_page=settings.memory_figure_max_per_page,
            fence_job=(job["id"], job["attempts"]),
            require_revision=True,
            trigger=trigger_of(str(job["kind"]), evidence),
        )
    except HTTPException as error:
        if error.status_code == 409 and (stale := _stale(storage, username, pages)):
            raise StaleRevision(stale) from error
        raise
    carried = {figure.get("objectKey") for figure in figures}
    if str(job["kind"]) == "document":
        _join_its_concepts(storage, username, evidence, written)
    _name_new_domains(storage, username, written, named)
    return {
        **committed,
        "supersededObjectKeys": [key for key in committed.get("supersededObjectKeys") or () if key not in carried],
        "outcome": outcome,
        # A failed job is tried again, and its retry must find the notes
        # unfiled and the exchanges behind no watermark.
        "notesFiled": (stamp_notes(storage, username, evidence) or []) if outcome != "failed" else [],
        "conversationsSettled": settle(storage, username, evidence) if outcome != "failed" else [],
    }
