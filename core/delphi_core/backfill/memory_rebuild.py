"""Build and atomically promote an offline Memory candidate.

The candidate lives in an isolated filesystem store, not in the serving
database, so staging needs no schema migration and is invisible to the app:

    python -m delphi_core.backfill.memory_rebuild --user ada --dry-run
    python -m delphi_core.backfill.memory_rebuild --user ada --stage [--key KEY ...] [--web-frozen DIR]
    python -m delphi_core.backfill.memory_rebuild --user ada --resume [--refile]
    python -m delphi_core.backfill.memory_rebuild --user ada --report [--key KEY ...] [--html FILE]
    python -m delphi_core.backfill.memory_rebuild --user ada --promote <candidate>
    python -m delphi_core.backfill.memory_rebuild --user ada --rollback

Staging clones the library and its captured outside evidence into the
candidate and files it through the pipeline the product runs: one `document`
job per document, drained here (`backfill.memory.drain_account`). The
report counts what those jobs did from the events they left: documents
`filed`, `nothing` and `failed`, pages created and edited, every dropped
target with its reason, the objections that did not block, and tokens for each
stage. With `--key`, a reviewed answer key, it carries a quality section too,
scored by `backfill.memory_eval`. **Staging spends real money.**

With web evidence on, from the settings or `--web-frozen DIR`, the candidate
is the `new+web` arm: maintenance may look outside, the report's `web`
section counts what it looked up, and the quality section is scored under
that name. With `--web-frozen` each research pass is kept in DIR the first
time and replayed after, so a second staging files from the same captures.

The chats beside each document are cloned too and filed as sessions, from
their first turn, once the documents are (`_enqueue_work`). That is the one
place a conversation's history is filed again, and it happens in the
candidate: the reader's own conversations and their watermarks are not
touched. A Memory chat is not cloned. Its answers rest on the Memory that is
being replaced.

Promotion rechecks the source fingerprint (the documents, notes and
reader-made domains the candidate was built from, never the pages, which this
replaces wholesale), uploads the candidate's figures and captured evidence,
saves the current pages as a local rollback snapshot, and replaces only Memory
rows in one storage transaction. Documents, conversations, notes, personas and
account settings never move. Where a reader added something during a staging
run that takes hours, `--promote <candidate> --accept-drift` names exactly
what the candidate was built without and promotes it anyway.
"""

from __future__ import annotations

import argparse
import asyncio
from collections import defaultdict
import base64
import hashlib
import html
import json
import mimetypes
from pathlib import Path
import shutil
import sys
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

from ..config import Settings
from ..memory import MEMORY_VERSION, document_filing_status
from ..memory_maintenance.jobs import (
    DOCUMENT, FROM_THE_START, SESSION, answered, document_family, document_marker, session_change, session_marker,
)
from ..storage.conversations import selector
from ..research_digest import RESEARCH_DIGEST_VERSION, digest_asset_key
from ..memory_graph_index import MemoryGraphIndex
from ..security import hash_password
from ..storage import (
    LocalObjectStore,
    LocalStorage,
    ObjectStore,
    Storage,
    external_evidence_key,
    is_web,
    paper_key,
    safe_id,
    utc_now,
)
from . import accounts, footer, memory_eval, open_stores
from .memory import drain_account, filing_summary, web_summary


#: The fixed-name objects a paper owns. A digest's *assets* are deliberately
#: absent: their keys carry an id minted per figure, so they cannot be named
#: from a suffix and are copied by reading the digest instead (`_copy_digest`).
SOURCE_OBJECT_SUFFIXES = ("pdf", "txt", "web", "digest")
MANIFEST = "manifest.json"
ROLLBACK = "rollback.json"


def _stable_fingerprint(value: Any) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _source_pages(pages: list[dict[str, Any]]) -> dict[str, list[str]]:
    """The source pages each document has, by paper id. A document has exactly one."""
    held: dict[str, list[str]] = defaultdict(list)
    for page in pages:
        if page.get("kind") == "source" and page.get("sourcePaperId"):
            held[str(page["sourcePaperId"])].append(page["slug"])
    return {paper_id: sorted(slugs) for paper_id, slugs in sorted(held.items())}


def _duplicate_source_pages(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"paperId": paper_id, "slugs": slugs}
        for paper_id, slugs in _source_pages(pages).items()
        if len(slugs) > 1
    ]


def build_inventory(
    storage: Storage, username: str, settings: Settings
) -> dict[str, Any]:
    """
    One read-only account inventory for a rebuild, with the fingerprint of what a candidate is built from.

    `sourceFingerprint` covers the documents, the reader's notes and the
    domains the reader made. How each document is filed today is reported
    beside it and is not part of it: the pages are what a rebuild replaces.
    """
    project_rows = storage.list_projects_with_papers(username)
    documents: list[dict[str, Any]] = []
    for project in project_rows:
        for paper in project.get("papers") or []:
            documents.append(
                {
                    "id": paper["id"],
                    "projectId": project["id"],
                    "title": paper.get("title") or paper.get("filename") or paper["id"],
                    "createdAt": paper.get("createdAt") or "",
                }
            )
    documents.sort(key=lambda item: (item["createdAt"], item["projectId"], item["id"]))
    versions = storage.memory_event_versions(
        username, [document_marker(paper["id"]) for paper in documents]
    )
    events = storage.latest_marker_events(
        username, [marker for paper in documents for marker in document_family(paper["id"])]
    )

    states = {"current": 0, "stale": 0, "unfiled": 0, "dropped": 0}
    source_plan: list[dict[str, Any]] = []
    for paper in documents:
        status = document_filing_status(versions, paper, events)
        states[
            "unfiled" if not status["filed"] else "stale" if status["stale"] else "current"
        ] += 1
        states["dropped"] += bool(status["dropped"])
        source_plan.append({**paper, "filing": status})

    pages = storage.list_memory_pages(username, limit=settings.memory_max_pages)
    domains = storage.memory_domains(username)
    links = storage.list_memory_links(username)
    index = MemoryGraphIndex.build(
        revision=storage.memory_graph_revision(username),
        pages=pages,
        domains=domains,
        links=links,
    )

    note_rows: list[dict[str, Any]] = []
    for paper in documents:
        for note in storage.list_notes(username, paper["projectId"], paper["id"]):
            note_rows.append(
                {
                    "id": note["id"],
                    "paperId": paper["id"],
                    "updatedAt": note.get("updatedAt") or note.get("createdAt") or "",
                }
            )
    note_rows.sort(key=lambda item: (item["updatedAt"], item["paperId"], item["id"]))

    terminal_failures = [
        {
            "id": job["id"],
            "kind": job.get("kind"),
            "marker": job.get("marker"),
            "attempts": job.get("attempts", 0),
            "lastError": job.get("lastError"),
        }
        for job in storage.list_memory_jobs(username)
        if job.get("status") == "failed" and not job.get("retryAt")
    ]

    authority = {
        "documents": documents,
        "notes": note_rows,
        "domains": [
            {
                "slug": domain["slug"],
                "title": domain.get("title"),
                "origin": domain.get("origin"),
                "position": domain.get("position"),
            }
            for domain in domains
            if domain.get("origin") == "reader"
        ],
    }
    return {
        "user": username,
        "memoryVersion": MEMORY_VERSION,
        "activeRevision": index.revision,
        "sourceFingerprint": _stable_fingerprint(authority),
        "documents": {"total": len(documents), **states},
        "sourcePlan": source_plan,
        "readerNotes": {"total": len(note_rows)},
        "graph": index.statistics,
        "duplicates": _duplicate_source_pages(pages),
        "terminalSourceFailures": terminal_failures,
        "estimatedModelWork": {
            "documentJobs": len(documents),
            "note": (
                "Each job is a selection, the agent's loop and a check, with one repair "
                "where the check blocks a page, and first a digest where the document "
                "has none that is current. A job may queue up to three follow-ups."
            ),
        },
        "readiness": {"readyToStage": True, "blockers": []},
    }


def export_snapshot(
    storage: Storage, username: str, settings: Settings
) -> dict[str, Any]:
    summaries = storage.list_memory_pages(username, limit=settings.memory_max_pages)
    return {
        "domains": storage.memory_domains(username),
        "pages": [storage.get_memory_page(username, page["slug"]) for page in summaries],
        "figures": storage.list_memory_figures(username),
        "events": storage.list_memory_events(username, limit=100_000),
    }


def _candidate_root(settings: Settings, username: str) -> Path:
    return settings.data_dir / "memory-rebuilds" / safe_id(username)


def _candidate_path(settings: Settings, username: str, candidate: str) -> Path:
    return _candidate_root(settings, username) / safe_id(candidate)


def _manifest_path(path: Path) -> Path:
    return path / MANIFEST


def _read_manifest(path: Path) -> dict[str, Any]:
    try:
        return json.loads(_manifest_path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Candidate manifest is unavailable: {path.name}") from error


def _write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    target = _manifest_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)


def _latest_candidate(settings: Settings, username: str) -> tuple[Path, dict[str, Any]]:
    root = _candidate_root(settings, username)
    candidates = [path for path in root.iterdir() if path.is_dir()] if root.exists() else []
    if not candidates:
        raise ValueError("No staged candidate exists")
    rows = [(path, _read_manifest(path)) for path in candidates]
    rows.sort(key=lambda item: item[1].get("createdAt") or "", reverse=True)
    return rows[0]


def _candidate_stores(settings: Settings, path: Path) -> tuple[Settings, LocalStorage, LocalObjectStore]:
    candidate_settings = settings.model_copy(update={"data_dir": path})
    return (
        candidate_settings,
        LocalStorage(candidate_settings),
        LocalObjectStore(path, candidate_settings.chat_image_retention_days),
    )


def _copy_digest_assets(
    source_objects: ObjectStore,
    candidate_objects: ObjectStore,
    *,
    username: str,
    project_id: str,
    staged_project_id: str,
    paper_id: str,
) -> int:
    """Carry a digest's figure bytes into the candidate beside the digest.

    A document's `source` page *is* its research digest (§36f), and the digest's
    assets become that page's `memory_figures` rows -- so a candidate holding
    the digest envelope without its bytes files 47 source pages with no pictures
    at all. That is what happened, and the way it hid is worth keeping: an
    account whose digests are stale has them *regenerated* inside the candidate,
    which mints the assets locally, so the bug is invisible on exactly the
    accounts a rebuild is usually run for. It only appears when every digest is
    current and therefore merely copied -- which is the good case.

    The ids are read out of the digest rather than guessed, the way `move_paper`
    already reads them: an asset key carries an id minted
    per figure, so nothing can enumerate them from the paper alone.
    """
    # Imported here rather than at module scope: `routers.projects` pulls in the
    # FastAPI app's dependency graph, and this module is also a CLI entry point.
    from ..routers.projects import _digest_asset_ids

    copied = 0
    for asset_id, mime_type in _digest_asset_ids(
        source_objects, username, project_id, paper_id
    ):
        if _copy_object(
            source_objects,
            candidate_objects,
            digest_asset_key(username, project_id, paper_id, asset_id, mime_type),
            digest_asset_key(
                username, staged_project_id, paper_id, asset_id, mime_type
            ),
        ):
            copied += 1
    return copied


def _copy_object(
    source: ObjectStore, target: ObjectStore, source_key: str, target_key: str
) -> bool:
    if not source.exists(source_key):
        return False
    materialized = source.fetch_to_tempfile(source_key)
    try:
        content_type = mimetypes.guess_type(source_key)[0] or "application/octet-stream"
        target.put_file(target_key, materialized, content_type)
    finally:
        materialized.unlink(missing_ok=True)
    return True


def copy_evidence(
    source: Storage,
    source_objects: ObjectStore,
    target: Storage,
    target_objects: ObjectStore,
    *,
    source_user: str,
    target_user: str,
) -> int:
    """
    Carry the captured outside sources an account cites into another store or account.

    A digest and a page cite a capture by id (`evidenceId`), and a job that
    cannot open one has no passage to cite or to check against. Every capture
    something of the source account cites is copied (`external_evidence_references`),
    bytes before the record. A capture the target already holds is left as it
    is: a capture is written once. Returns how many were copied.
    """
    copied = 0
    for evidence_id in sorted(source.external_evidence_references(source_user)):
        try:
            record = source.get_external_evidence(source_user, evidence_id)
        except HTTPException:
            # Cited and never captured, or reaped. The job that cites it says so.
            continue
        try:
            target.get_external_evidence(target_user, evidence_id)
            continue
        except HTTPException:
            pass
        _copy_object(
            source_objects,
            target_objects,
            record.get("objectKey") or external_evidence_key(source_user, evidence_id),
            external_evidence_key(target_user, evidence_id),
        )
        target.put_external_evidence(target_user, record)
        copied += 1
    return copied


def _enqueue_work(
    candidate: LocalStorage, username: str, plan: list[dict[str, Any]], project_map: dict[str, str]
) -> None:
    """
    The one place a candidate's work is queued: one `document` job for each
    document, and one `session` job for each document with a chat beside it
    or a note on it.

    Every cloned conversation is put back to its first turn, so its whole
    history is filed: this is the explicit refiling of old conversations, and
    it is the candidate's watermark that is reset, never the reader's. A
    session's job is due at once, with no wait: nobody is in a candidate's
    session. The claim takes documents first, so a session is filed into the
    pages its document already has. A document's notes are filed by its
    session's job, after its chats (`gather_session`): a document's job reads
    none.

    The documents are filed in the plan's order, which is `createdAt`: a later
    paper that corrects or extends an earlier one then meets the earlier one's
    pages, as it did in the reader's library. `add_paper` has already queued
    each document's job, in the order the clone walked the projects, and the
    queue claims the oldest row first, so each row is removed and queued
    again here, in the plan's order.
    """
    for item in plan:
        candidate.clear_memory_job(username, document_marker(item["id"]))
    for item in plan:
        project_id = project_map[item["projectId"]]
        candidate.enqueue_memory_job(
            username,
            kind=DOCUMENT,
            marker=document_marker(item["id"]),
            payload={"projectId": project_id, "paperId": item["id"]},
            target_version=MEMORY_VERSION,
        )
        marker = session_marker(paper_id=item["id"])
        candidate.clear_memory_job(username, marker)
        asked: list[str] = []
        for chat in candidate.list_scope_conversations(username, "document", project_id, item["id"])["items"]:
            messages = candidate.get_conversation(username, chat["id"]).get("messages") or []
            if any(answered(message) for message in messages):
                candidate.set_memory_filed_through(username, chat["id"], FROM_THE_START)
                asked.append(chat["id"])
        noted = bool(candidate.list_notes(username, project_id, item["id"]))
        if asked or noted:
            candidate.enqueue_memory_job(
                username,
                kind=SESSION,
                marker=marker,
                payload={
                    "projectId": project_id, "paperId": item["id"],
                    "fingerprint": session_change(note_id="rebuild", stamp=",".join(asked)),
                },
                target_version=MEMORY_VERSION,
            )


def _clone_conversations(
    source: Storage, candidate: LocalStorage, username: str, project_id: str, staged_project_id: str, paper_id: str
) -> None:
    """Replay the chats beside one document into the candidate, each as a conversation of its own."""
    for chat in source.list_scope_conversations(username, "document", project_id, paper_id)["items"]:
        messages = source.get_conversation(username, chat["id"]).get("messages") or []
        if not messages:
            continue
        created = candidate.create_conversation(username, "document", staged_project_id, paper_id, f"rebuild_{chat['id']}"[:64])
        key = selector(created["id"], created["generation"])
        for message in messages:
            candidate.append_message(username, staged_project_id, key, dict(message))


def _clone_authority(
    source: Storage,
    source_objects: ObjectStore,
    candidate: LocalStorage,
    candidate_objects: LocalObjectStore,
    username: str,
    inventory: dict[str, Any],
    *,
    reextract: bool = False,
    reextracted: list[str] | None = None,
) -> dict[str, str]:
    """
    Copy what a candidate is built from into its own store, and queue its work.

    The documents with their bytes, digests and digest figures, the reader's
    highlights and notes, the chats beside each document, the domains the
    reader made, and the captured outside sources the digests cite. Paper ids are kept; each project gets a new id,
    returned as `{source project id: staged project id}`. With `reextract`, a
    PDF whose text this runtime extracts again comes with that text and
    without its digest, which its job writes again (`_extracted`); the ids of
    those are appended to `reextracted`.
    """
    account = source.get_account(username) or {}
    salt, password_hash = hash_password(hashlib.sha256(inventory["sourceFingerprint"].encode()).hexdigest())
    candidate.create_account(username, None, salt, password_hash)
    candidate.update_account_preferences(
        username, use_standard_tier=bool(account.get("useStandardTier", True))
    )

    project_map: dict[str, str] = {}
    projects = source.list_projects_with_papers(username)
    for project in projects:
        staged_project = candidate.create_project(username, project.get("name") or "Rebuild")
        project_map[project["id"]] = staged_project["id"]
        for paper in project.get("papers") or []:
            # A digest is current by its metadata alone (`digest_is_current`), so
            # one copied beside text extracted again would never be written again.
            text = (
                _extracted(source_objects, paper_key(username, project["id"], paper["id"], "pdf"))
                if reextract and not is_web(paper) else None
            )
            # Text that comes out as it was stored keeps its digest: nothing about it changed.
            fresh = text is not None and text != _stored_text(source_objects, paper_key(username, project["id"], paper["id"], "txt"))
            dropped = {"slug", "routeSlug", "routeTitle", "lastEngagedAt"} | ({"digest", "digestClaim"} if fresh else set())
            clean = {key: value for key, value in paper.items() if key not in dropped}
            candidate.add_paper(username, staged_project["id"], clean)
            if fresh:
                candidate_objects.put_text(paper_key(username, staged_project["id"], paper["id"], "txt"), text)
                if reextracted is not None:
                    reextracted.append(paper["id"])
            for suffix in SOURCE_OBJECT_SUFFIXES:
                if fresh and suffix in ("digest", "txt"):
                    continue
                _copy_object(
                    source_objects,
                    candidate_objects,
                    paper_key(username, project["id"], paper["id"], suffix),
                    paper_key(username, staged_project["id"], paper["id"], suffix),
                )
            if not fresh:
                _copy_digest_assets(
                    source_objects,
                    candidate_objects,
                    username=username,
                    project_id=project["id"],
                    staged_project_id=staged_project["id"],
                    paper_id=paper["id"],
                )

            highlight_ids: dict[str, str] = {}
            for highlight in source.list_highlights(username, project["id"], paper["id"]):
                written = candidate.add_highlight(
                    username,
                    staged_project["id"],
                    paper["id"],
                    {key: value for key, value in highlight.items() if key not in {"id", "createdAt"}},
                )
                highlight_ids[highlight["id"]] = written["id"]
            for note in source.list_notes(username, project["id"], paper["id"]):
                highlight_id = highlight_ids.get(note.get("highlightId") or "")
                if not highlight_id:
                    raise ValueError(f"Reader note {note['id']} has no surviving highlight")
                candidate.add_note(
                    username,
                    staged_project["id"],
                    paper["id"],
                    {
                        "highlightId": highlight_id,
                        "page": note.get("page"),
                        "anchorY": note.get("anchorY"),
                        "quotedText": note.get("quotedText"),
                        "body": note["body"],
                    },
                )
            _clone_conversations(source, candidate, username, project["id"], staged_project["id"], paper["id"])

    for domain in source.memory_domains(username):
        if domain.get("origin") == "reader":
            candidate.upsert_memory_domain(username, domain)
    copy_evidence(
        source, source_objects, candidate, candidate_objects, source_user=username, target_user=username
    )
    _enqueue_work(candidate, username, inventory["sourcePlan"], project_map)
    return project_map


def _remove_empty_model_domains(storage: LocalStorage, username: str) -> None:
    pages = storage.list_memory_pages(username, limit=100_000)
    substantive = {
        page["domain"]
        for page in pages
        if not (page.get("kind") == "domain" and page.get("slug") == page.get("domain"))
    }
    for domain in storage.memory_domains(username):
        if domain.get("origin") == "model" and domain["slug"] not in substantive:
            storage.delete_memory_domain(username, domain["slug"])


def summarize_pages(
    storage: Storage, username: str, settings: Settings
) -> dict[str, Any]:
    """What Memory is made of, in the shape an operator reads before promoting.

    Counts alone do not build confidence — "184 pages" is the same sentence
    whether they teach anything or not — so this carries a bounded sample of
    real bodies beside the census. Bounded because the point is to be read.
    """
    pages = storage.list_memory_pages(username, limit=settings.memory_max_pages)
    titles = {domain["slug"]: domain.get("title") or domain["slug"]
              for domain in storage.memory_domains(username)}

    kinds: dict[str, int] = {}
    by_domain: dict[str, dict[str, Any]] = {}
    for page in pages:
        kind = page.get("kind") or "unknown"
        kinds[kind] = kinds.get(kind, 0) + 1
        domain = page.get("domain") or "general"
        held = by_domain.setdefault(
            domain, {"slug": domain, "title": titles.get(domain, domain), "pages": 0, "kinds": {}}
        )
        held["pages"] += 1
        held["kinds"][kind] = held["kinds"].get(kind, 0) + 1

    def sample(kind: str, limit: int) -> list[dict[str, Any]]:
        # The best-connected pages of each kind: the ones a reader meets first
        # in the graph, and the ones a bad pass fails on most visibly.
        chosen = sorted(
            (page for page in pages if page.get("kind") == kind),
            key=lambda page: (-int(page.get("linkDegree") or 0), page["slug"]),
        )[:limit]
        rows = []
        for page in chosen:
            # The listing carries no citations, so they are counted on the page itself, as the body is.
            whole = storage.get_memory_page(username, page["slug"])
            body = whole.get("body") or ""
            rows.append(
                {
                    "slug": page["slug"],
                    "title": page.get("title"),
                    "domain": titles.get(page.get("domain"), page.get("domain")),
                    "summary": (page.get("summary") or "")[:400],
                    "linkDegree": page.get("linkDegree", 0),
                    "citations": len(whole.get("citations") or []),
                    "bodyCharacters": len(body),
                    "excerpt": body[:900],
                }
            )
        return rows

    return {
        "kinds": kinds,
        "domains": sorted(by_domain.values(), key=lambda row: -row["pages"]),
        "samples": {kind: sample(kind, 4) for kind in ("concept", "source", "domain")},
        "slugs": sorted(page["slug"] for page in pages),
    }


def summarize_figures(
    storage: Storage,
    objects: ObjectStore,
    username: str,
    *,
    limit: int = 24,
) -> dict[str, Any]:
    """The captured figures, with the bytes, so they can actually be looked at.

    A count cannot answer "are these useful?" — the failure this guards against
    is a QR code, an advertisement or a contact block captured because it was
    the largest image on the page, and only the picture itself says which it
    is. Bounded and inlined as data URIs so the report stays one portable file.
    """
    figures = storage.list_memory_figures(username)
    pages = {
        page["slug"]: page
        for page in storage.list_memory_pages(username, limit=100_000)
    }
    by_id = {page["id"]: page for page in pages.values()}
    rows: list[dict[str, Any]] = []
    for figure in figures[:limit]:
        provenance = figure.get("provenance") or figure.get("origin") or {}
        page = by_id.get(figure.get("pageId") or "")
        data_uri = None
        key = figure.get("objectKey")
        if key and objects.exists(key):
            blob = objects.fetch_to_tempfile(key)
            try:
                if blob.stat().st_size <= 400_000:
                    data_uri = (
                        f"data:{figure.get('mimeType') or 'image/webp'};base64,"
                        + base64.b64encode(blob.read_bytes()).decode("ascii")
                    )
            finally:
                blob.unlink(missing_ok=True)
        rows.append(
            {
                "id": figure.get("id"),
                "caption": figure.get("caption"),
                "alt": figure.get("alt"),
                "kind": figure.get("kind"),
                "onPage": (page or {}).get("title") or figure.get("pageId"),
                "sourcePage": provenance.get("page"),
                "width": figure.get("width"),
                "height": figure.get("height"),
                "bytes": figure.get("byteSize") or figure.get("bytes"),
                "dataUri": data_uri,
            }
        )
    return {
        "total": len(figures),
        "pages": len(pages),
        "perPage": round(len(figures) / max(len(pages), 1), 3),
        "shown": rows,
    }


def _digest_census(
    storage: Storage, username: str, manifest: dict[str, Any] | None = None
) -> dict[str, Any]:
    """What digests an account holds, and what they carry.

    Counted rather than described, because the expensive artifact of a rebuild
    has to be visible in the report that decides whether to promote it — a
    candidate whose digests are already current is one whose largest cost is
    already paid, and that is not something an operator should have to infer.
    """
    versions: dict[str, int] = {}
    tables = figures = characters = ready = 0
    rows: list[dict[str, Any]] = []
    staged = (manifest or {}).get("projectMap") or {}
    projects = (
        list(staged.values())
        if staged
        else [project["id"] for project in storage.list_projects_with_papers(username)]
    )
    for project_id in projects:
        try:
            papers = storage.get_project(username, project_id).get("papers") or []
        except HTTPException:
            continue
        for paper in papers:
            digest = paper.get("digest") or {}
            label = f"{digest.get('version') or 'none'} · {digest.get('status') or 'absent'}"
            versions[label] = versions.get(label, 0) + 1
            if digest.get("status") != "ready":
                continue
            ready += 1
            rows.append(
                {
                    "paperId": paper["id"],
                    "title": paper.get("title") or paper.get("filename") or paper["id"],
                    "version": digest.get("version"),
                }
            )
    return {
        "versions": versions,
        "ready": ready,
        "current": RESEARCH_DIGEST_VERSION,
        "papers": sorted(rows, key=lambda row: row["title"].lower()),
    }


def _web_arm(settings: Settings, manifest: dict[str, Any], frozen: Path | None) -> dict[str, Any]:
    """
    Whether the candidate is filed with web evidence, and from what.

    `--web-frozen DIR` turns it on with each research pass kept in DIR the
    first time it runs and replayed after (`Settings.memory_web_frozen_dir`):
    the `new+web` arm, filed again from the same captures. A resumed candidate
    keeps the arm it was staged as. Otherwise the settings decide, so
    `MEMORY_WEB_EVIDENCE=true` stages a live `new+web` run.
    """
    if frozen is not None:
        return {"evidence": True, "frozen": str(frozen.expanduser().resolve())}
    if isinstance(manifest.get("web"), dict):
        return dict(manifest["web"])
    return {"evidence": bool(settings.memory_web_evidence), "frozen": settings.memory_web_frozen_dir}


def _arm(manifest: dict[str, Any]) -> str:
    arm = "new+web" if (manifest.get("web") or {}).get("evidence") else "new"
    return f"{arm}+reextract" if manifest.get("reextracted") else arm


def _quality(path: Path, username: str, keys: list[str] | None, arm: str = "new") -> dict[str, Any] | None:
    """
    The report's quality section: the candidate's pages against a reviewed key.

    `memory_eval.score_candidate` computes it, reading the candidate from disk
    as that rig does. The metrics that need a judge model are named in it, as
    `memory_judge`'s to measure. None when no key was given.
    """
    if not keys:
        return None
    key, problems = memory_eval.load_keys(list(keys))
    if problems:
        raise ValueError("The keys are malformed:\n  " + "\n  ".join(problems))
    return memory_eval.score_candidate(memory_eval.load_candidate(path, username), key, arm=arm)


def _candidate_report(
    storage: Storage,
    username: str,
    settings: Settings,
    manifest: dict[str, Any],
    objects: ObjectStore | None = None,
    *,
    path: Path | None = None,
    keys: list[str] | None = None,
) -> dict[str, Any]:
    inventory = build_inventory(storage, username, settings)
    expected = {item["id"] for item in manifest.get("sourcePlan") or []}
    source_pages = _source_pages(
        storage.list_memory_pages(username, limit=settings.memory_max_pages)
    )
    missing = sorted(expected - set(source_pages))
    jobs = storage.list_memory_jobs(username)
    pending_jobs = [
        {
            "marker": job.get("marker"),
            "kind": job.get("kind"),
            "status": job.get("status"),
            "attempts": job.get("attempts", 0),
            "lastError": job.get("lastError"),
            "retryAt": job.get("retryAt"),
        }
        for job in jobs
    ]
    blockers = [
        *([f"{len(jobs)} maintenance jobs remain"] if jobs else []),
        *([f"{len(missing)} documents have no source page"] if missing else []),
        *(
            [f"{len(inventory['duplicates'])} documents have duplicate source pages"]
            if inventory["duplicates"]
            else []
        ),
    ]
    quality = _quality(path, username, keys, _arm(manifest)) if path is not None else None
    events = storage.list_memory_events(username, limit=100_000)
    return {
        **inventory,
        "candidate": manifest["candidate"],
        "status": manifest.get("status"),
        "arm": _arm(manifest),
        "filing": filing_summary(events),
        "web": {**(manifest.get("web") or {"evidence": False, "frozen": ""}), **web_summary(events)},
        **({"quality": quality} if quality is not None else {}),
        "composition": summarize_pages(storage, username, settings),
        "digests": _digest_census(storage, username, manifest),
        "figures": (
            summarize_figures(storage, objects, username)
            if objects is not None
            else {"total": 0, "pages": 0, "perPage": 0, "shown": []}
        ),
        "sourceCoverage": {
            "expected": len(expected),
            "covered": len(expected) - len(missing),
            "missing": missing,
            "duplicates": inventory["duplicates"],
        },
        "remainingJobs": pending_jobs,
        "readiness": {"readyToPromote": not blockers, "blockers": blockers},
    }


def _write_dashboard(path: Path, report: dict[str, Any]) -> None:
    """Write a portable operator report with all data embedded.

    One file, no network: it is read before a decision that replaces an
    account's whole wiki, and it has to be readable from anywhere, including
    from a copy somebody was sent.
    """
    encoded = json.dumps(report, ensure_ascii=False).replace("</", "<\\/")
    title = html.escape(str((report.get("active") or report).get("user") or "Memory"))
    document = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__ · Memory rebuild report</title>
<style>
:root{--paper:#f7f0e5;--card:#fffaf2;--ink:#34261e;--muted:#8d7b6d;--line:#dfd2c3;--green:#4f6840;--red:#a74734;--accent:#c0703a}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:1180px;margin:auto;padding:42px 28px 80px}h1{font:700 34px/1.08 Georgia,serif;margin:0 0 8px}
h2{font-size:16px;margin:0 0 14px;letter-spacing:.01em}h3{font-size:14px;margin:0 0 4px}p{margin:0}.muted{color:var(--muted)}
.hero,.card{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:0 8px 28px #5b38200d}
.hero{padding:26px;margin:24px 0}.card{padding:20px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.metric{font:700 30px/1 Georgia,serif;margin-bottom:6px}
.delta{font-size:12px;font-weight:650}.down{color:var(--green)}.up{color:var(--accent)}
.label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.section{margin-top:26px}.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.pill{display:inline-block;padding:5px 11px;border-radius:999px;font-weight:650;font-size:12px}
.good{background:#e3ecd9;color:var(--green)}.warn{background:#fae8d5;color:#9a4d18}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;background:#efe6d8;color:var(--muted);font-size:11px;font-weight:650;margin-right:6px}
details{border-top:1px solid var(--line);padding:11px 0}details:first-of-type{border-top:0}
summary{cursor:pointer;font-weight:650}code,pre{font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
pre{white-space:pre-wrap;background:#f3ebdd;border-radius:10px;padding:12px;margin:10px 0 0;max-height:280px;overflow:auto}
.err{color:var(--red);white-space:pre-wrap}
ul{padding-left:20px;margin:6px 0}.empty{padding:16px;color:var(--muted)}
.cols{columns:3;font-size:12px;color:var(--muted)}
@media(max-width:820px){.grid{grid-template-columns:1fr 1fr}.two{grid-template-columns:1fr}.cols{columns:1}}
</style></head><body><main>
<p class="label">Delphi operator report</p><h1>Memory rebuild</h1>
<p class="muted" id="stamp"></p><div id="app"></div>
<script>const R=__DATA__;
const active=R.active||R, candidate=R.candidate||null, change=R.change||null;
const n=v=>Number(v||0).toLocaleString();
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const g=x=>(x&&x.graph)||{}, comp=x=>(x&&x.composition)||{}, filing=x=>(x&&x.filing)||{};
const ready=!!(candidate&&candidate.readiness&&candidate.readiness.readyToPromote);
document.querySelector("#stamp").textContent =
  `${active.user||"account"} · ${active.memoryVersion||""} · source fingerprint ${String(active.sourceFingerprint||"").slice(0,12)}`;

function metric(now, was, label){
  const d = (was===null||was===undefined) ? "" :
    `<div class="delta ${now<was?"down":now>was?"up":"muted"}">${now===was?"unchanged":(now>was?"+":"")+n(now-was)+" vs today"}</div>`;
  return `<div class="card"><div class="metric">${n(now)}</div><div class="label">${label}</div>${d}</div>`;
}
function kindTable(c){
  const k=comp(c).kinds||{};
  const rows=Object.keys(k).sort((a,b)=>k[b]-k[a]);
  return rows.length?`<table><tr><th>Kind</th><th class="n">Pages</th></tr>${
    rows.map(x=>`<tr><td>${esc(x)}</td><td class="n">${n(k[x])}</td></tr>`).join("")}</table>`
    :'<p class="empty">Nothing staged yet.</p>';
}
function domainTable(c){
  const d=comp(c).domains||[];
  return d.length?`<table><tr><th>Domain</th><th class="n">Pages</th><th>Made of</th></tr>${
    d.map(x=>`<tr><td><strong>${esc(x.title)}</strong><br><span class="muted">${esc(x.slug)}</span></td><td class="n">${n(x.pages)}</td><td class="muted">${
      Object.keys(x.kinds).sort().map(k=>`${esc(k)} ${n(x.kinds[k])}`).join(" · ")}</td></tr>`).join("")}</table>`
    :'<p class="empty">Nothing staged yet.</p>';
}
function digestTable(x){
  const d=(x&&x.digests)||{}; const v=d.versions||{};
  const rows=Object.keys(v).sort();
  return rows.length?`<table><tr><th>Version &amp; state</th><th class="n">Documents</th></tr>${
    rows.map(k=>`<tr><td>${esc(k)}${k.startsWith(String(d.current))?' <span class="tag">current</span>':""}</td><td class="n">${n(v[k])}</td></tr>`).join("")}</table>`
    :'<p class="empty">No digests.</p>';
}
function progress(c){
  const jobs=(c&&c.remainingJobs)||[]; const cov=(c&&c.sourceCoverage)||{};
  const total=Number(cov.expected||0), done=Number(cov.covered||0);
  const pct=total?Math.round(done/total*100):0;
  const byKind={}; jobs.forEach(j=>{byKind[j.kind||"?"]=(byKind[j.kind||"?"]||0)+1;});
  const kinds=Object.keys(byKind).sort().map(k=>`<span class="tag">${esc(k)} ${n(byKind[k])}</span>`).join("");
  return `<section class="section card"><h2>Progress</h2>
    <div style="height:9px;border-radius:6px;background:#eadfcd;overflow:hidden;margin:4px 0 12px">
      <div style="height:100%;width:${pct}%;background:var(--green)"></div></div>
    <p class="muted">${n(done)} of ${n(total)} documents filed (${pct}%) · ${n(jobs.length)} jobs still queued ${kinds}</p></section>`;
}
function filingSection(c){
  const f=filing(c); if(!f.jobs) return "";
  const d=f.documents||{}, t=f.telemetry||{}, dropped=f.dropped||[];
  const tok=s=>{const u=t[s]||{};return `<tr><td>${esc(s)}</td><td class="n">${n(u.jobs)}</td><td class="n">${n(u.inputTokens)}</td><td class="n">${n(u.cacheReadTokens)}</td><td class="n">${n(u.outputTokens)}</td><td class="n">${n(u.reasoningTokens)}</td></tr>`;};
  return `<section class="section two">
  <div class="card"><h2>What the jobs did</h2><table>
    <tr><th>Documents filed</th><td>${n(d.filed)}</td></tr>
    <tr><th>Documents with nothing to file</th><td>${n(d.nothing)}</td></tr>
    <tr><th>Documents whose last job failed</th><td>${n(d.failed)}</td></tr>
    <tr><th>Documents left with a source page only</th><td>${n(d.sourcePageOnly)}</td></tr>
    <tr><th>Pages created / edited</th><td>${n((f.pages||{}).created)} / ${n((f.pages||{}).edited)}</td></tr>
    <tr><th>Jobs filed / nothing / failed</th><td>${n(f.jobs.filed)} / ${n(f.jobs.nothing)} / ${n(f.jobs.failed)}</td></tr>
    <tr><th>Advisory objections</th><td>${n((f.advisory||{}).count)} ${Object.entries((f.advisory||{}).byFinding||{}).map(([k,v])=>`<span class="tag">${esc(k)} ${n(v)}</span>`).join("")}</td></tr>
    <tr><th>Agent rounds</th><td>${n(t.rounds)} ${Object.entries(t.ended||{}).map(([k,v])=>`<span class="tag">${esc(k)} ${n(v)}</span>`).join("")}</td></tr>
  </table></div>
  <div class="card"><h2>Tokens by stage</h2><table>
    <tr><th>Stage</th><th class="n">Jobs</th><th class="n">Input</th><th class="n">Cached</th><th class="n">Output</th><th class="n">Reasoning</th></tr>
    ${["select","maintain","verify"].map(tok).join("")}</table></div>
  </section>
  <section class="section card"><h2>Dropped targets</h2>${dropped.length
    ? `<table><tr><th>Page</th><th>Action</th><th>Job</th><th>Reason</th></tr>${dropped.map(x=>`<tr><td>${esc(x.title||x.slug)}</td><td>${esc(x.action)}</td><td><code>${esc(x.marker)}</code>${x.outstanding?"":' <span class="tag">settled by a later job</span>'}</td><td>${esc(x.reason)}</td></tr>`).join("")}</table>`
    : '<p class="empty">No job dropped a page it staged.</p>'}</section>`;
}
function qualitySection(c){
  const q=c&&c.quality; if(!q) return "";
  return `<section class="section card"><h2>Quality against the key</h2>
    ${q.keysReviewed===false?'<p class="muted" style="margin-bottom:10px">Draft keys: no person has reviewed them, so the gates resting on them decide nothing.</p>':""}
    <table><tr><th>Gate</th><th>Status</th><th>Detail</th></tr>${(q.gates||[]).map(x=>`<tr><td>${esc(x.label)}</td><td><span class="pill ${x.status==="pass"?"good":"warn"}">${esc(x.status)}</span></td><td>${esc(x.detail)}</td></tr>`).join("")}</table>
    <p class="muted" style="margin-top:10px">Measured by memory_judge, not in this report: ${(q.needsJudge||[]).map(x=>esc(x.metric)).join(", ")}.</p></section>`;
}
function figureGallery(c,a){
  const f=(c&&c.figures)||{}, af=(a&&a.figures)||{};
  const shown=f.shown||[];
  const head=`<p class="muted" style="margin-bottom:14px">
    <strong>${n(f.total)}</strong> figures over <strong>${n(f.pages)}</strong> pages —
    <strong>${(f.perPage||0).toFixed(3)} per page</strong>, against
    ${(af.perPage||0).toFixed(3)} in the live wiki. Look for what should not be
    here: a QR code, an advertisement, a contact block, a logo, or a picture
    whose caption does not describe it.</p>`;
  if(!shown.length) return `<section class="section card"><h2>Captured figures</h2>${head}<p class="empty">None captured yet.</p></section>`;
  return `<section class="section card"><h2>Captured figures</h2>${head}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px">${
      shown.map(r=>`<figure style="margin:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff">
        ${r.dataUri?`<img src="${r.dataUri}" alt="${esc(r.alt||"")}" style="display:block;width:100%;height:auto">`
                   :'<div class="empty" style="text-align:center">bytes not captured</div>'}
        <figcaption style="padding:10px 12px;font-size:12px">
          <div>${esc(r.caption||"")}</div>
          <div class="muted" style="margin-top:6px">
            <span class="tag">${esc(r.kind||"")}</span>
            ${r.sourcePage?`<span class="tag">src p.${n(r.sourcePage)}</span>`:""}
            <span class="tag">${n(r.width)}×${n(r.height)}</span>
          </div>
          <div class="muted" style="margin-top:6px">on <strong>${esc(r.onPage||"")}</strong></div>
        </figcaption></figure>`).join("")}</div>
    ${f.total>shown.length?`<p class="muted" style="margin-top:12px">Showing ${n(shown.length)} of ${n(f.total)}.</p>`:""}
  </section>`;
}
function samples(c,kind,heading,blurb){
  const rows=((comp(c).samples||{})[kind])||[];
  if(!rows.length) return `<section class="section card"><h2>${heading}</h2><p class="empty">None staged yet.</p></section>`;
  return `<section class="section card"><h2>${heading}</h2><p class="muted" style="margin-bottom:12px">${blurb}</p>${
    rows.map(r=>`<details><summary>${esc(r.title)}</summary>
      <p class="muted" style="margin:8px 0 6px">
        <span class="tag">${esc(r.domain||"")}</span>
        <span class="tag">${n(r.linkDegree)} links</span>
        <span class="tag">${n(r.citations)} citations</span>
        <span class="tag">${n(r.bodyCharacters)} chars</span>
      </p>
      <p>${esc(r.summary)}</p><pre>${esc(r.excerpt)}${r.bodyCharacters>r.excerpt.length?" …":""}</pre>
    </details>`).join("")}</section>`;
}

const failures=((candidate&&candidate.remainingJobs)||active.terminalSourceFailures||[])
  .filter(j=>j.status==="failed"||j.lastError);
const blockers=(candidate&&candidate.readiness&&candidate.readiness.blockers)||["Candidate staging has not completed."];

document.querySelector("#app").innerHTML=`
<section class="hero">
  <span class="pill ${ready?"good":"warn"}">${ready?"Ready to promote":"Not accepted yet"}</span>
  <h2 style="margin-top:14px">${ready
    ? "Every document has exactly one source page and no work is outstanding."
    : "Live Memory is unchanged and stays unchanged until every blocker clears."}</h2>
  <p class="muted">Candidate ${esc((candidate&&candidate.candidate)||"— not staged")} · status ${esc((candidate&&candidate.status)||"not reported")}</p>
</section>

<p class="label">What the wiki becomes</p>
<section class="grid" style="margin:10px 0 6px">
  ${metric(g(candidate).pages, g(active).pages, "Pages")}
  ${metric(g(candidate).links, g(active).links, "Links")}
  ${metric(g(candidate).domains, g(active).domains, "Domains")}
  ${metric(((filing(candidate).dropped)||[]).filter(d=>d.outstanding).length, null, "Dropped targets")}
</section>
<section class="grid" style="margin:14px 0 6px">
  ${metric(((candidate||{}).digests||{}).ready, ((active||{}).digests||{}).ready, "Digests ready")}
  ${metric(comp(candidate).kinds&&comp(candidate).kinds.concept, comp(active).kinds&&comp(active).kinds.concept, "Concept pages")}
  ${metric(comp(candidate).kinds&&comp(candidate).kinds.source, comp(active).kinds&&comp(active).kinds.source, "Source pages")}
  <div class="card"><div class="metric">${(((candidate||{}).figures||{}).perPage||0).toFixed(2)}</div><div class="label">Figures per page</div><div class="delta muted">${(((active||{}).figures||{}).perPage||0).toFixed(2)} today</div></div>
</section>

${progress(candidate)}

${filingSection(candidate)}

${qualitySection(candidate)}

<section class="section two">
  <div class="card"><h2>Digests — today, live</h2>${digestTable(active)}
    <p class="muted" style="margin-top:10px">A digest is the most expensive artifact in a rebuild and is keyed on the document, not on the authoring pass. Promotion carries these across, so they are never paid for twice.</p></div>
  <div class="card"><h2>Digests — candidate</h2>${digestTable(candidate)}
    <p class="muted" style="margin-top:10px">${n(((candidate||{}).digests||{}).ready)} ready to promote at ${esc(((candidate||{}).digests||{}).current||"")}.</p></div>
</section>

<section class="section two">
  <div class="card"><h2>Today, live</h2><table>
    <tr><th>Documents</th><td>${n(active.documents&&active.documents.total)} — ${n(active.documents&&active.documents.stale)} stale, ${n(active.documents&&active.documents.unfiled)} unfiled</td></tr>
    <tr><th>Duplicate source pages</th><td>${n((active.duplicates||[]).length)}</td></tr>
    <tr><th>Jobs that gave up</th><td>${n((active.terminalSourceFailures||[]).length)}</td></tr>
    <tr><th>Reader notes</th><td>${n(active.readerNotes&&active.readerNotes.total)}</td></tr>
  </table></div>
  <div class="card"><h2>Candidate acceptance</h2><table>
    <tr><th>Documents with a source page</th><td>${n(candidate&&candidate.sourceCoverage&&candidate.sourceCoverage.covered)} / ${n(candidate&&candidate.sourceCoverage&&candidate.sourceCoverage.expected)}</td></tr>
    <tr><th>Missing a source page</th><td>${n(((candidate||{}).sourceCoverage||{}).missing?candidate.sourceCoverage.missing.length:0)}</td></tr>
    <tr><th>Duplicate source pages</th><td>${n(((candidate||{}).sourceCoverage||{}).duplicates?candidate.sourceCoverage.duplicates.length:0)}</td></tr>
    <tr><th>Work outstanding</th><td>${n(((candidate||{}).remainingJobs||[]).length)} jobs</td></tr>
  </table></div>
</section>

<section class="section two">
  <div class="card"><h2>Candidate — pages by kind</h2>${kindTable(candidate)}</div>
  <div class="card"><h2>Today — pages by kind</h2>${kindTable(active)}</div>
</section>

<section class="section card"><h2>Candidate — domains</h2>${domainTable(candidate)}</section>

${figureGallery(candidate,active)}

${samples(candidate,"concept","Example concept pages",
  "The best-connected concepts the rebuild wrote. These are the pages you are promoting. Read two or three before deciding.")}
${samples(candidate,"source","Example source pages","One per document: its digest.")}
${samples(candidate,"domain","Example domain pages","One per domain: how its concepts and sources relate.")}

<section class="section card"><h2>What changes, by name</h2>${change
  ? `<p class="muted" style="margin-bottom:10px">${n(change.kept.length)} slugs survive, ${n(change.added.length)} are new, ${n(change.removed.length)} are retired. A retired slug's page is gone after promotion; the rollback snapshot can put it back.</p>
     <details><summary>Retired (${n(change.removed.length)})</summary><div class="cols">${change.removed.map(x=>esc(x)).join("<br>")}</div></details>
     <details><summary>New (${n(change.added.length)})</summary><div class="cols">${change.added.map(x=>esc(x)).join("<br>")}</div></details>
     <details><summary>Kept (${n(change.kept.length)})</summary><div class="cols">${change.kept.map(x=>esc(x)).join("<br>")}</div></details>`
  : '<p class="empty">Run --report once staging has finished to see the named diff.</p>'}</section>

<section class="section card"><h2>Promotion blockers</h2>${blockers.length
  ? `<ul>${blockers.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`
  : '<p class="empty">None. The source fingerprint is still rechecked at promotion.</p>'}</section>

<section class="section card"><h2>Not accepted / still running</h2>${failures.length
  ? failures.map(j=>`<details><summary>${esc(j.marker)} · ${esc(j.status||"failed")} · ${n(j.attempts)} attempts</summary><p class="err">${esc(j.lastError||"Awaiting retry")}</p></details>`).join("")
  : '<p class="empty">No failed candidate jobs.</p>'}</section>

<section class="section card"><h2>Duplicate source pages today</h2>${(active.duplicates||[]).length
  ? `<ul>${active.duplicates.map(d=>`<li><code>${esc(d.paperId)}</code>: ${d.slugs.map(esc).join(" &nbsp;↔&nbsp; ")}</li>`).join("")}</ul>`
  : '<p class="empty">None.</p>'}</section>`;
</script></main></body></html>"""
    document = document.replace("__TITLE__", title).replace("__DATA__", encoded)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(document, encoding="utf-8")


def _refile_candidate(
    candidate: LocalStorage,
    settings: Settings,
    username: str,
    manifest: dict[str, Any],
) -> None:
    """Throw away a candidate's pages and queue its documents again.

    The expensive half of staging is not the pages. It is the cloned bytes and
    the digests, which are minutes of model time each and are keyed on the
    document, not on the pass that files it. When the pass changes, those are
    still good and only the pages are stale. `--resume` would keep the pages;
    `--discard` would throw away the digests with them.

    The events go with the pages, so every document is unfiled again and its
    new job is a new operation. Domains the reader made survive; the ones the
    pipeline made are derived again, as in a fresh stage. Each document's
    source page is derived again from its digest when its job runs.
    """
    reader_domains = [
        domain
        for domain in candidate.memory_domains(username)
        if domain.get("origin") == "reader"
    ]
    candidate.replace_memory_snapshot(
        username,
        {"domains": reader_domains, "pages": [], "figures": [], "events": []},
        max_pages=settings.memory_max_pages,
    )
    _enqueue_work(candidate, username, manifest.get("sourcePlan") or [], manifest.get("projectMap") or {})


#: The extraction a re-extracted candidate is measured with: pypdf reads TeX's
#: math fonts as their symbols from this version, and only with fontTools.
EXTRACTION_PYPDF_MIN = (6, 17)


def _extraction_runtime() -> dict[str, str]:
    """
    The pypdf and fontTools a `--reextract` run extracts with. Refused when
    they cannot read a CFF font's own encoding: pypdf then falls back to the
    old extraction without a word, and the run would measure re-written
    digests, not a change to extraction.
    """
    import importlib.metadata

    try:
        import fontTools  # noqa: F401
    except ImportError as error:
        raise ValueError("--reextract needs fontTools in this runtime") from error
    version = importlib.metadata.version("pypdf")
    if tuple(int(part) for part in version.split(".")[:2]) < EXTRACTION_PYPDF_MIN:
        raise ValueError(f"--reextract needs pypdf {'.'.join(map(str, EXTRACTION_PYPDF_MIN))} or later; this runtime has {version}")
    return {"pypdf": version, "fonttools": importlib.metadata.version("fonttools")}


def _extracted(objects: ObjectStore, key: str) -> str | None:
    """
    A stored PDF's text, extracted again with this runtime (`--reextract`), or
    None when there are no bytes or they cannot be read: the document then
    keeps the text it was imported with, and its digest.

    A candidate otherwise files from the text extracted when the reader
    imported each document, so a change to extraction (0.6.5's fontTools,
    which reads TeX's math fonts as their symbols) would never reach it.
    """
    from ..routers.projects import join_pages, read_pdf_pages

    try:
        path = objects.fetch_to_tempfile(key)
    except Exception:
        return None
    try:
        _, page_text, _ = read_pdf_pages(path, 10_000)
    except Exception as error:
        print(f"could not extract {key} again ({error}); it keeps its imported text", file=sys.stderr)
        return None
    finally:
        path.unlink(missing_ok=True)
    return join_pages(page_text)


def _stored_text(objects: ObjectStore, key: str) -> str | None:
    try:
        return objects.get_text(key)
    except Exception:
        return None


def _reindex(candidate: LocalStorage, candidate_objects: ObjectStore, username: str, project_map: dict[str, str], ids: list[str]) -> None:
    """Index again the sections of the documents whose text was extracted again, before anything is filed."""
    from ..routers.projects import index_paper_sections_safely

    for project_id in project_map.values():
        for paper in candidate.get_project(username, project_id).get("papers") or []:
            if paper["id"] in ids:
                index_paper_sections_safely(candidate, candidate_objects, username, project_id, paper)


async def _stage_or_resume(
    source: Storage,
    source_objects: ObjectStore,
    settings: Settings,
    username: str,
    *,
    resume: bool,
    verbose: bool,
    refile: bool = False,
    keys: list[str] | None = None,
    web_frozen: Path | None = None,
    reextract: bool = False,
) -> dict[str, Any]:
    if reextract:
        manifest_runtime = _extraction_runtime()
    if resume:
        path, manifest = _latest_candidate(settings, username)
        candidate_settings, candidate, candidate_objects = _candidate_stores(settings, path)
        if reextract and "reextracted" not in manifest:
            raise ValueError("--reextract applies when a candidate is staged, not to one being resumed")
        # A run that died before indexing them: indexing again is harmless.
        _reindex(candidate, candidate_objects, username, manifest.get("projectMap") or {}, manifest.get("reextracted") or [])
        if refile:
            _refile_candidate(candidate, candidate_settings, username, manifest)
        for job in candidate.list_memory_jobs(username):
            if job.get("status") == "failed":
                candidate.retry_memory_job(username, job["id"])
    else:
        inventory = build_inventory(source, username, settings)
        candidate_id = f"candidate-{inventory['sourceFingerprint'][:12]}"
        path = _candidate_path(settings, username, candidate_id)
        if path.exists():
            raise ValueError(f"Candidate {candidate_id} already exists; use --resume or --discard")
        candidate_settings, candidate, candidate_objects = _candidate_stores(settings, path)
        manifest = {
            "candidate": candidate_id,
            "user": username,
            "status": "staging",
            "createdAt": utc_now(),
            "sourceFingerprint": inventory["sourceFingerprint"],
            "sourceRevision": inventory["activeRevision"],
            "sourcePlan": inventory["sourcePlan"],
        }
        _write_manifest(path, manifest)
        reextracted: list[str] = []
        manifest["projectMap"] = _clone_authority(
            source, source_objects, candidate, candidate_objects, username, inventory,
            reextract=reextract, reextracted=reextracted,
        )
        if reextract:
            manifest["reextracted"], manifest["extraction"] = reextracted, manifest_runtime
        _write_manifest(path, manifest)
        _reindex(candidate, candidate_objects, username, manifest["projectMap"], reextracted)

    manifest["web"] = _web_arm(settings, manifest, web_frozen)
    _write_manifest(path, manifest)
    candidate_settings = candidate_settings.model_copy(update={
        "memory_web_evidence": manifest["web"]["evidence"], "memory_web_frozen_dir": manifest["web"]["frozen"],
    })
    runs = await drain_account(
        candidate,
        candidate_objects,
        candidate_settings,
        username,
        verbose=verbose,
        total=len(candidate.list_memory_jobs(username)),
    )
    # How this run's jobs ended and how long each stage of each took. The
    # report's own counts are summed from the candidate's events, so they
    # cover every run of a candidate that was resumed.
    manifest["lastDrain"] = [
        {key: run[key] for key in ("marker", "kind", "outcome", "attempts", "seconds", "stages", "error")}
        for run in runs
    ]
    if not candidate.list_memory_jobs(username):
        _remove_empty_model_domains(candidate, username)
    report = _candidate_report(
        candidate, username, candidate_settings, manifest, candidate_objects, path=path, keys=keys
    )
    manifest["status"] = "ready" if report["readiness"]["readyToPromote"] else "blocked"
    manifest["report"] = report
    manifest["updatedAt"] = utc_now()
    _write_manifest(path, manifest)
    return {**report, "status": manifest["status"]}


def _copy_candidate_figures(
    candidate_objects: LocalObjectStore,
    target_objects: ObjectStore,
    snapshot: dict[str, Any],
) -> None:
    for figure in snapshot.get("figures") or []:
        key = figure.get("objectKey")
        if key and not _copy_object(candidate_objects, target_objects, key, key):
            raise ValueError(f"Candidate figure object is missing: {key}")


def describe_source_drift(
    current: dict[str, Any], manifest: dict[str, Any]
) -> list[str]:
    """What a reader gained since staging that the candidate cannot hold.

    Named per document, not as one hash: "the fingerprint moved" tells an
    operator nothing about whether promoting loses a paper they added this
    morning or a title they corrected.
    """
    staged = {item["id"]: item for item in manifest.get("sourcePlan") or []}
    live = {item["id"]: item for item in current.get("sourcePlan") or []}
    drift = [
        f"document added since staging: {live[paper]['title']}"
        for paper in sorted(set(live) - set(staged))
    ]
    drift += [
        f"document deleted since staging: {staged[paper]['title']}"
        for paper in sorted(set(staged) - set(live))
    ]
    drift += [
        f"document renamed or moved since staging: {live[paper]['title']}"
        for paper in sorted(set(live) & set(staged))
        if any(live[paper].get(name) != staged[paper].get(name) for name in ("title", "projectId"))
    ]
    if not drift:
        # Notes and domains are inside the fingerprint and carry no label
        # worth printing one by one.
        drift.append(
            "a reader note or a domain the reader made changed since staging; "
            "the candidate was built without it"
        )
    return drift


def candidate_digests(
    candidate: LocalStorage, username: str, manifest: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    """Every current, ready digest the candidate rebuilt, by paper id.

    A digest is keyed on the document and its own version, not on the pass that
    reads it, which is why `--refile` keeps them. It is also the most expensive
    artifact in a rebuild — minutes of model time each — so promoting the pages
    without them would throw away the larger half of what a staging run bought
    and leave production serving digests the new pages were not written from.
    """
    staged = manifest.get("projectMap") or {}
    held: dict[str, dict[str, Any]] = {}
    for original, project_id in staged.items():
        for paper in candidate.get_project(username, project_id).get("papers") or []:
            digest = paper.get("digest") or {}
            if (
                digest.get("status") == "ready"
                and digest.get("version") == RESEARCH_DIGEST_VERSION
            ):
                held[paper["id"]] = {
                    "paperId": paper["id"],
                    "projectId": original,
                    "stagedProjectId": project_id,
                    "metadata": digest,
                }
    return held


def _promote_digests(
    storage: Storage,
    objects: ObjectStore,
    candidate: LocalStorage,
    candidate_objects: LocalObjectStore,
    username: str,
    manifest: dict[str, Any],
) -> list[str]:
    """Publish the rebuilt digests through the shipped claim, bytes-first.

    `claim_digest`/`complete_digest` rather than a second copy of their skip
    test, so a concurrent live build loses the race honestly instead of being
    overwritten, and `force` is what lets a current digest replace an older
    ready one. Bytes before the record (invariant 7): a paper pointing at a
    digest object that was never written is a broken digest, while an
    unreferenced object is invisible and reapable.
    """
    promoted: list[str] = []
    for row in candidate_digests(candidate, username, manifest).values():
        source_key = paper_key(
            username, row["stagedProjectId"], row["paperId"], "digest"
        )
        if not candidate_objects.exists(source_key):
            continue
        claim = uuid4().hex[:24]
        state = storage.claim_digest(
            username,
            row["projectId"],
            row["paperId"],
            claim_id=claim,
            expires_at=utc_now(),
            metadata={**row["metadata"], "status": "pending"},
            force=True,
        )
        if state != "claimed":
            continue
        target_key = paper_key(username, row["projectId"], row["paperId"], "digest")
        _copy_object(candidate_objects, objects, source_key, target_key)
        storage.complete_digest(
            username, row["projectId"], row["paperId"], claim, row["metadata"]
        )
        promoted.append(row["paperId"])
    return promoted


def _promote(
    storage: Storage,
    objects: ObjectStore,
    settings: Settings,
    username: str,
    candidate_id: str,
    *,
    accept_drift: bool = False,
) -> dict[str, Any]:
    path = _candidate_path(settings, username, candidate_id)
    manifest = _read_manifest(path)
    if manifest.get("status") != "ready":
        raise ValueError("Only a ready candidate may be promoted")
    if manifest.get("reextracted"):
        # Its pages cite text, and its digests hash text, that the account does not hold.
        raise ValueError("A candidate staged with --reextract measures a change and is never promoted")
    current = build_inventory(storage, username, settings)
    # Only the *source* is guarded. `activeRevision` used to be checked too and
    # it guarded the wrong thing: it moves on any Memory write, the
    # maintenance pump drains on focus and every five minutes in any open tab,
    # and the wiki changing underneath a run that replaces the wiki wholesale
    # is not a hazard. Over a staging window measured in hours that check was
    # never going to pass. It is recorded on the manifest as provenance.
    drift: list[str] = []
    if current["sourceFingerprint"] != manifest.get("sourceFingerprint"):
        drift = describe_source_drift(current, manifest)
        if not accept_drift:
            raise ValueError(
                "Source authority changed after staging:\n  "
                + "\n  ".join(drift)
                + "\nRe-stage to include it, or pass --accept-drift to promote "
                "the candidate without it."
            )
    candidate_settings, candidate, candidate_objects = _candidate_stores(settings, path)
    report = _candidate_report(
        candidate, username, candidate_settings, manifest, candidate_objects
    )
    if not report["readiness"]["readyToPromote"]:
        raise ValueError("Candidate is no longer ready to promote")

    rollback = export_snapshot(storage, username, settings)
    rollback_path = path / ROLLBACK
    rollback_path.write_text(json.dumps(rollback, ensure_ascii=False), encoding="utf-8")
    snapshot = export_snapshot(candidate, username, candidate_settings)
    _copy_candidate_figures(candidate_objects, objects, snapshot)
    # Before the pages that cite them: a page whose citation opens nothing is
    # broken, and a capture nothing cites yet is invisible.
    evidence = copy_evidence(
        candidate, candidate_objects, storage, objects, source_user=username, target_user=username
    )
    storage.replace_memory_snapshot(username, snapshot, max_pages=settings.memory_max_pages)
    # After the wiki, not before: a digest is what the pages were written from,
    # so a crash between the two leaves production with new pages over older
    # digests — readable, and repaired by promoting again — where the reverse
    # order would leave digests nothing cites.
    digests = _promote_digests(
        storage, objects, candidate, candidate_objects, username, manifest
    )
    manifest.update(
        {
            "status": "promoted",
            "promotedAt": utc_now(),
            "promotedRevision": storage.memory_graph_revision(username),
            "revisionAtPromotion": current["activeRevision"],
            "promotedDigests": digests,
            "promotedEvidence": evidence,
            "acceptedDrift": drift,
            "rollbackSnapshot": ROLLBACK,
        }
    )
    _write_manifest(path, manifest)
    return build_inventory(storage, username, settings)


def _rollback(storage: Storage, settings: Settings, username: str) -> dict[str, Any]:
    path, manifest = _latest_candidate(settings, username)
    if manifest.get("status") != "promoted":
        raise ValueError("The latest candidate has not been promoted")
    if storage.memory_graph_revision(username) != manifest.get("promotedRevision"):
        raise ValueError("Memory changed after promotion; guarded rollback is no longer safe")
    rollback_path = path / str(manifest.get("rollbackSnapshot") or ROLLBACK)
    snapshot = json.loads(rollback_path.read_text(encoding="utf-8"))
    storage.replace_memory_snapshot(username, snapshot, max_pages=settings.memory_max_pages)
    manifest.update({"status": "rolled-back", "rolledBackAt": utc_now()})
    _write_manifest(path, manifest)
    return build_inventory(storage, username, settings)


def _discard(settings: Settings, username: str, candidate_id: str) -> None:
    path = _candidate_path(settings, username, candidate_id)
    manifest = _read_manifest(path)
    if manifest.get("status") == "promoted":
        raise ValueError("A promoted candidate must be rolled back before it can be discarded")
    root = _candidate_root(settings, username).resolve()
    resolved = path.resolve()
    if resolved.parent != root:
        raise ValueError("Candidate path escaped its rebuild root")
    shutil.rmtree(resolved)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user", action="append", dest="users", required=True)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--dry-run", action="store_true")
    actions.add_argument("--report", action="store_true")
    actions.add_argument("--stage", action="store_true")
    actions.add_argument("--resume", action="store_true")
    actions.add_argument("--promote", metavar="CANDIDATE")
    actions.add_argument("--discard", metavar="CANDIDATE")
    actions.add_argument("--rollback", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument(
        "--refile",
        action="store_true",
        help=(
            "with --resume, discard the candidate's pages and re-file every "
            "document, keeping the cloned sources and their digests"
        ),
    )
    parser.add_argument(
        "--key",
        action="append",
        dest="keys",
        metavar="KEY",
        help=(
            "with --stage, --resume or --report, a reviewed answer key (see "
            "`python -m delphi_core.backfill.memory_eval formats`); repeat for more. The "
            "report then carries a quality section scored against it"
        ),
    )
    parser.add_argument(
        "--web-frozen",
        type=Path,
        metavar="DIR",
        help=(
            "with --stage or --resume, file the candidate with web evidence on (the "
            "new+web arm), keeping each research pass in DIR the first time it runs "
            "and replaying it after, with no search and no fetch"
        ),
    )
    parser.add_argument(
        "--reextract",
        action="store_true",
        help=(
            "with --stage, extract each PDF's text again with this runtime before filing, "
            "so the candidate measures a change to extraction; its digests are written again"
        ),
    )
    parser.add_argument(
        "--accept-drift",
        action="store_true",
        help="with --promote, proceed although the source changed since staging",
    )
    parser.add_argument(
        "--html",
        type=Path,
        help="with --report, write a self-contained HTML operator dashboard",
    )
    return parser


async def run(args: argparse.Namespace) -> int:
    settings, storage, objects = open_stores()
    if (args.promote or args.discard or args.rollback or args.stage or args.resume) and len(args.users) != 1:
        print("Mutating rebuild commands require exactly one --user.", file=sys.stderr)
        return 2
    try:
        reports: list[dict[str, Any]] = []
        for username in accounts(storage, args):
            if args.stage or args.resume:
                reports.append(
                    await _stage_or_resume(
                        storage,
                        objects,
                        settings,
                        username,
                        resume=args.resume,
                        verbose=not args.quiet,
                        refile=args.refile,
                        keys=args.keys,
                        web_frozen=args.web_frozen,
                        reextract=args.reextract,
                    )
                )
            elif args.promote:
                reports.append(
                    _promote(
                        storage,
                        objects,
                        settings,
                        username,
                        args.promote,
                        accept_drift=args.accept_drift,
                    )
                )
            elif args.rollback:
                reports.append(_rollback(storage, settings, username))
            elif args.discard:
                _discard(settings, username, args.discard)
                reports.append({"user": username, "discarded": args.discard})
            elif args.report:
                active = build_inventory(storage, username, settings)
                active_composition = summarize_pages(storage, username, settings)
                try:
                    path, manifest = _latest_candidate(settings, username)
                except ValueError:
                    staged = None
                else:
                    candidate_settings, candidate, candidate_objects = _candidate_stores(
                        settings, path
                    )
                    staged = _candidate_report(
                        candidate,
                        username,
                        candidate_settings,
                        manifest,
                        candidate_objects,
                        path=path,
                        keys=args.keys,
                    )
                active["composition"] = active_composition
                active["digests"] = _digest_census(storage, username)
                active["figures"] = summarize_figures(storage, objects, username)
                change = None
                if staged is not None:
                    # Named, not counted: "62 pages fewer" is a number an
                    # operator has to take on trust, and the slugs are the only
                    # thing that says which pages are being retired.
                    before = set(active_composition["slugs"])
                    after = set(staged["composition"]["slugs"])
                    change = {
                        "removed": sorted(before - after),
                        "added": sorted(after - before),
                        "kept": sorted(before & after),
                    }
                reports.append(
                    {"active": active, "candidate": staged, "change": change}
                )
            else:
                reports.append(build_inventory(storage, username, settings))
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 2

    print(json.dumps(reports[0] if len(reports) == 1 else reports, indent=2, sort_keys=True))
    if args.html:
        if not args.report or len(reports) != 1:
            print("--html requires --report and exactly one --user", file=sys.stderr)
            return 2
        _write_dashboard(args.html, reports[0])
        print(f"dashboard {args.html}")
    return footer(storage, f"processed {len(reports)} account{'s' if len(reports) != 1 else ''}")


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(run(build_parser().parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
