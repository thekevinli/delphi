"""
Gather for a `reconcile` job: pages the Memory check found to disagree.

The check (`memory.lint_memory`) reads pages and writes none. Where two
or three of them say incompatible things it queues a job that names them, says
what is in dispute and quotes each. This builds that job's closed evidence
set: the documents those pages already cite, by the locators they cite them
at, and nothing else. A disagreement is settled from what the pages rest on,
so a run can correct a page against its own sources and cannot bring in a new
one. A document or session run is given the same kind of evidence about the
pages near where it starts, narrower still (`neighbourhood`): only the
locators those pages cite, since that run reads one document and not these.

The job is about the pages as the check read them. A page that is gone, that
is no longer a concept or domain page, or that has been written again since
(the job's fingerprint is the revisions the check saw) leaves nothing to
reconcile: the set comes back `skipped` and the job ends `nothing`. The check
queues the pages again if it still finds them at odds.

Blocking, like the stores. No model.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import replace
from typing import Any

from fastapi import HTTPException

from ..config import Settings
from ..storage import ObjectStore, Storage
from . import brief as tags
from .gather import MissingEvidence, Passages, document_source, external_sources
from .jobs import RECONCILE, reconcile_fingerprint
from .run import EvidenceSet
from .staging import Evidence

#: The kinds of page a run may edit, and so the kinds a disagreement is between.
RECONCILED_KINDS = ("concept", "domain")
#: How much of the check's statement, and of each quote, the brief carries.
CLAIM_CHARS = 300
DETAIL_CHARS = 600
QUOTE_CHARS = 400


def cited_documents(
    storage: Storage, objects: ObjectStore, username: str, pages: list[Mapping[str, Any]], passages: Passages
) -> list[Evidence]:
    """Each document the pages cite that is still in the library, with the reader's notes they cite on it."""
    cited: dict[str, set[str]] = {}
    for page in pages:
        for citation in page.get("citations") or ():
            if citation.get("paperId") and not citation.get("evidenceId"):
                cited.setdefault(str(citation["paperId"]), set()).update(
                    [str(citation["noteId"])] if citation.get("noteId") else []
                )
    held = {
        paper["id"]: project["id"]
        for project in storage.list_projects_with_papers(username)
        for paper in project.get("papers") or ()
    }
    sources = []
    for paper_id, note_ids in cited.items():
        project_id = held.get(paper_id)
        if project_id is None:
            continue
        try:
            paper = storage.get_paper(username, project_id, paper_id)
            notes = [note for note in storage.list_notes(username, project_id, paper_id) if note["id"] in note_ids]
            sources.append(document_source(objects, username, project_id, paper, notes, passages))
        except (HTTPException, MissingEvidence):
            # A document that is gone or cannot be read is one a claim cannot
            # be checked against. It is left out, and a citation of it is
            # then refused.
            continue
        passages.add_notes(notes)
    return sources


def _reconcile_brief(pages: list[Mapping[str, Any]], sources: list[Evidence], payload: Mapping[str, Any]) -> str:
    named = "; ".join(
        f"[[{page['slug']}]] {json.dumps(tags.clip(str(page.get('title') or page['slug']), 200), ensure_ascii=False)}"
        for page in pages
    )
    slugs = {page["slug"] for page in pages}
    said = [
        f"In dispute: {tags.clip(str(payload.get('claim') or ''), CLAIM_CHARS)}",
        tags.clip(str(payload.get("detail") or ""), DETAIL_CHARS),
        *(
            f"[[{quote['page']}]] says: {json.dumps(tags.clip(str(quote.get('quote') or ''), QUOTE_CHARS), ensure_ascii=False)}"
            for quote in payload.get("quotes") or ()
            if isinstance(quote, Mapping) and quote.get("page") in slugs
        ),
    ]
    parts = [
        f"A check of the reader's Memory found that these pages disagree: {tags.defuse(named)}.",
        "What this event may be cited from, and nothing else:\n"
        + ("\n".join(tags.describe_source(source) for source in sources) or "- nothing: the pages cite no document that can still be read"),
        "These are the documents the pages already cite. The check read the pages and no document, so what it "
        "said is about the pages and is not evidence of what a document says:",
        tags.fence(tags.PAGE_DISAGREEMENT, "\n".join(line for line in said if line.strip())),
    ]
    return f"<{tags.EVENT} kind=\"{RECONCILE}\">\n" + "\n\n".join(parts) + f"\n</{tags.EVENT}>"


def gather_reconcile(
    storage: Storage, objects: ObjectStore, username: str, settings: Settings, job: Mapping[str, Any]
) -> EvidenceSet:
    """
    The evidence set of a `reconcile` job: the pages it names and the documents they cite.

    `start_slugs` are the pages, which is where the run starts. The set's
    fingerprint is the one the job was queued with, also when it is `skipped`,
    so a job whose pages moved on is completed and not kept for another try.
    """
    payload = job.get("payload") or {}
    marker = str(job.get("marker") or "")
    fingerprint = str(payload.get("fingerprint") or "")
    slugs = [str(slug) for slug in payload.get("slugs") or ()]

    def skipped(reason: str) -> EvidenceSet:
        return EvidenceSet(kind=RECONCILE, marker=marker, start_slugs=tuple(slugs), fingerprint=fingerprint, skipped=reason)

    if len(slugs) < 2:
        return skipped("The job names fewer than two pages, so there is nothing to reconcile.")
    pages: list[Mapping[str, Any]] = []
    for slug in slugs:
        try:
            page = storage.get_memory_page(username, slug)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
            return skipped(f"The page {slug} is no longer in Memory.")
        if page.get("kind") not in RECONCILED_KINDS:
            return skipped(f"The page {slug} is no longer a concept or domain page.")
        pages.append(page)
    if reconcile_fingerprint({page["slug"]: page.get("revision") or 0 for page in pages}) != fingerprint:
        return skipped("A page was written again after the check found the disagreement.")

    passages = Passages(objects, username)
    sources = cited_documents(storage, objects, username, pages, passages)
    if settings.memory_web_evidence:
        captured = (
            str(citation["evidenceId"])
            for page in pages for citation in page.get("citations") or () if citation.get("evidenceId")
        )
        sources += [source for source, _ in external_sources(storage, objects, username, captured, passages)]
    return EvidenceSet(
        kind=RECONCILE,
        marker=marker,
        title="A disagreement between " + " and ".join(str(page.get("title") or page["slug"]) for page in pages),
        start_slugs=tuple(page["slug"] for page in pages),
        sources=tuple(sources),
        brief=_reconcile_brief(pages, sources, payload),
        fingerprint=fingerprint,
        passage=passages,
    )


#: The most documents a run may reach through Memory. The nearest pages' are taken first.
NEIGHBOUR_DOCUMENTS_MAX = 12


def neighbourhood(
    storage: Storage, objects: ObjectStore, username: str, settings: Settings, graph: Any, evidence: EvidenceSet,
    slugs: Iterable[str],
) -> EvidenceSet:
    """
    The evidence set with the documents that pages near the run's start already cite.

    A concept page is written in light of the pages around it, and a sentence on
    how this document connects to another needs that other document to cite.
    "Near" is what it is everywhere else in Delphi: the pages the run starts
    from and what is within `memory_related_hops` links of them, never
    through a domain's page (`memory_links`, the rail). A document reached this
    way is not read by the run, which reads one document; it may be cited only
    where those pages cite it (`Evidence.via`), and the check reads that one
    passage. A captured outside source joins only while web evidence is on.

    Blocking, like the stores. No model. A set whose passages cannot be read
    by locator is returned as it was.
    """
    if not isinstance(evidence.passage, Passages):
        return evidence
    passages = evidence.passage
    distance: dict[str, int] = {}
    for start in dict.fromkeys(graph.resolve_slug(slug) for slug in slugs):
        if start not in graph.pages_by_slug or graph.is_domain_page(start):
            # A domain's page links to every member: walking from it is the whole domain, not a neighbourhood.
            continue
        distance[start] = 0
        for slug, (hops, _) in graph.walk(start, settings.memory_related_hops).items():
            if slug in graph.pages_by_slug:
                distance[slug] = min(distance.get(slug, hops), hops)
    held = {source.id for source in evidence.sources}
    cited: dict[str, dict[str, Any]] = {}
    for slug in sorted(distance, key=lambda slug: (distance[slug], slug)):
        if graph.is_domain_page(slug):
            # Every member links to its domain's page, so its citations are the whole domain's: never a neighbour.
            continue
        try:
            page = storage.get_memory_page(username, slug)
        except Exception:
            continue
        for citation in page.get("citations") or ():
            outside = citation.get("claimType") == "external"
            source = str(citation.get("evidenceId") if outside else citation.get("paperId") or "")
            if not source or source in held or citation.get("claimType") not in ("author-claim", "external"):
                continue
            if outside and not settings.memory_web_evidence:
                continue
            entry = cited.setdefault(source, {"outside": outside, "via": [], "pages": set(), "sections": set()})
            if slug not in entry["via"]:
                entry["via"].append(slug)
            if isinstance(citation.get("page"), int):
                entry["pages"].add(citation["page"])
            if citation.get("section"):
                entry["sections"].add(str(citation["section"]).lstrip("#").lower())
    if not cited:
        return evidence
    papers = {
        paper["id"]: (project["id"], paper)
        for project in storage.list_projects_with_papers(username)
        for paper in project.get("papers") or ()
    }
    added: list[Evidence] = []
    # Nearest first, and only what can be read counts towards the cap.
    for source, entry in cited.items():
        if len(added) >= NEIGHBOUR_DOCUMENTS_MAX:
            break
        via = tuple(entry["via"])
        if entry["outside"]:
            found = external_sources(storage, objects, username, [source], passages)
            sections = tuple(anchor for anchor in found[0][0].sections or () if anchor.lower() in entry["sections"]) if found else ()
            if sections:
                added.append(replace(found[0][0], sections=sections, via=via))
            continue
        if source not in papers:
            continue
        project_id, paper = papers[source]
        try:
            whole = document_source(objects, username, project_id, paper, (), passages)
        except MissingEvidence:
            continue
        if whole.sections is not None:
            sections = tuple(anchor for anchor in whole.sections if anchor.lower() in entry["sections"])
            if sections:
                added.append(replace(whole, sections=sections, via=via))
        elif pages := frozenset(page for page in entry["pages"] if 1 <= page <= whole.pages):
            added.append(replace(whole, via=via, only_pages=pages))
    return replace(evidence, sources=(*evidence.sources, *added)) if added else evidence
