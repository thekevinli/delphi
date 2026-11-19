"""
What a domain's commit does that a document's does not.

**A domain's page cites only what its members cite.** A document the page
cites and no member does any more (`EvidenceSet.gone_documents`, found by
`gather_domain`) is not evidence for it: the pages that cited it left the
domain or were deleted, and with them the reason to say it here. The composer
cannot cite it again, but the page it edits in place keeps every block the
operations do not name, so the commit takes the document off without a model
(`reader_notes.without_notes`), as a deleted note is taken off: a statement
that cited only that document and Delphi's inference goes, and the
document's citation comes off what stays. Run on the page the composer
staged, and on the stored page when it staged none.

A page that would be left with no statement keeps its words, uncited, and a
warning is logged, as for a deleted note.

**A domain a commit brings into being holds two pages.** Filing is told to
name a new domain only for a field of at least two (`contracts/maintain.md`),
and a document's own page follows the first page written from it. A new
domain left holding one page all the same is folded after the commit, as a
page's delete folds one (`fold_lone_domain`): that page joins the domain it
sits closest to, and the move is recorded. A second run of the author to
choose again would rewrite the page whole for one field of it.
"""

from __future__ import annotations

import dataclasses
import logging
from collections.abc import Collection, Mapping, Sequence
from typing import Any

from ..config import Settings
from ..memory import fold_lone_domain
from ..storage import Storage, utc_now
from .blocks import statements
from .reader_notes import without_notes, withdrawn
from .run import EvidenceSet
from .staging import StagedPage

logger = logging.getLogger(__name__)

UNCITED_DOCUMENTS = "Took out the citations of documents no page in this domain cites any more."
WITHDRAWN_DOCUMENTS = (
    "Took out what rested only on documents no page in this domain cites any more, and their citations."
)


def _cites(citations: Sequence[Mapping[str, Any]], documents: Collection[str]) -> bool:
    return any(item.get("claimType") != "derived" and item.get("paperId") in documents for item in citations)


def _without(slug: str, body: str, citations: Sequence[Mapping[str, Any]], documents: Collection[str]) -> tuple[str, list[dict[str, Any]], str]:
    """The body and citations without these documents, and the note the page's history keeps for it."""
    after, kept = without_notes(body, citations, (), documents=documents)
    note = WITHDRAWN_DOCUMENTS if withdrawn(body, citations, (), documents) else UNCITED_DOCUMENTS
    if not statements(after):
        logger.warning("withdrawing documents no member cites would leave %s with no statement; its words stay", slug)
        after, kept = without_notes(body, citations, (), withdraw=False, documents=documents)
        note = UNCITED_DOCUMENTS
    return after, kept, note


def without_gone_documents(
    storage: Storage, username: str, evidence: EvidenceSet, pages: Sequence[StagedPage]
) -> list[StagedPage]:
    """
    `pages`, each without the documents the job found gone, and an edit of each
    stored page that cites one and is not among them.
    """
    gone = evidence.gone_documents
    if not gone:
        return list(pages)
    result: list[StagedPage] = []
    for page in pages:
        if _cites(page.citations, gone):
            body, kept, _ = _without(page.slug, page.body, page.citations, gone)
            page = dataclasses.replace(page, body=body, citations=tuple(kept))
        result.append(page)
    written = {page.slug for page in result}
    for slug in dict.fromkeys(slug for slugs in gone.values() for slug in slugs):
        if slug in written:
            continue
        try:
            stored: dict[str, Any] = storage.get_memory_page(username, slug)
        except Exception:
            continue
        citations = list(stored.get("citations") or ())
        if not _cites(citations, gone):
            continue
        body, kept, note = _without(slug, stored.get("body") or "", citations, gone)
        result.append(StagedPage(
            slug=slug, action="edit", revision=int(stored.get("revision") or 0), title=stored.get("title") or slug,
            aliases=tuple(stored.get("aliases") or ()), domain=stored.get("domain") or "",
            summary=stored.get("summary") or "", body=body, citations=tuple(kept),
            figures=tuple(stored.get("figures") or ()), kind=stored.get("kind") or "domain", note=note,
        ))
    return result


def fold_lone_new_domains(
    storage: Storage, username: str, settings: Settings, pages: Sequence[StagedPage], before: Collection[str] | None,
) -> list[dict[str, Any]]:
    """
    Fold each domain this commit's new pages brought into being that holds one
    page (`fold_lone_domain`), recording the move; the folds. `before` are the
    domains Memory had before the commit, None when they could not be read.
    Never raises: the pages are committed, and a domain left as it was is the
    worse filing, not a failure.
    """
    if before is None:
        return []
    folds = []
    for domain in dict.fromkeys(page.domain for page in pages if page.action == "create" and page.domain not in before):
        try:
            folded = fold_lone_domain(storage, username, domain, max_pages=settings.memory_max_pages)
            if folded is None:
                continue
            storage.append_memory_event(username, {
                "kind": "refile",
                "createdAt": utc_now(),
                "summary": f"Moved {folded['page']['title']} into {folded['domain']}: its new domain held no other page.",
                "pages": [folded["page"]["slug"]],
            })
            folds.append(folded)
        except Exception:
            logger.warning("could not fold the new domain %s", domain, exc_info=True)
    return folds
