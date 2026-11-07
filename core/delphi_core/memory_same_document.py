"""
Whether a document just added is one the reader deleted, whose source page was kept.

Deleting a document may keep its source page (41), and a copy added back has a
new id, so it would be filed with a second page beside the first. Delphi never
takes the kept page on its own: two documents can print one title. So when a
document with no page of its own has its digest, and some deleted document
left a source page behind, its job asks first. The same printed title is a
match with no model call; otherwise one low-effort call reads the new digest's
opening against each kept page. A match parks the document's job under
`SAME_AS` until the reader answers in its Related Memory card; the answer
writes the document's page either way and lets the job go. No match, or no
page left behind: it files as usual.

A parked job is a question, not owed work: nothing counts it as filing, in
line or stoppable (`waits_for_reader`). The card dates the kept page by the
event its document left when it was deleted (`note_deleted`).

Nothing here writes a page, and a failed call is no match, never an error.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Iterable

import httpx

from .config import Settings
from .harness.prompts import UNTRUSTED_TEXT_RULE
from .harness.provider import ResponsesClient, require_completed
from .memory_maintenance.brief import DOCUMENT_DIGEST, clip, fence
from .model_tasks import service_tier_field
from .storage import Storage, utc_now
from .storage.base import memory_slug

logger = logging.getLogger("uvicorn.error")

#: The job payload key naming the kept page the reader is asked about.
SAME_AS = "sameAs"
#: Not claimable before the reader answers (`job_is_due`); the answer releases it.
WAITS_FOR_READER = "9999-12-31T00:00:00+00:00"
#: Each digest's opening, as the call reads it.
OPENING_CHARS = 1_500
#: The most kept pages one call reads.
KEPT_PAGES_MAX = 20

INSTRUCTIONS = f"""
A reader added a document. Each other digest below is the page Delphi kept
from a document the reader deleted, named by its slug. Say whether the added
document is the same work as one of them: the same paper in another version
or venue counts, a different paper on the same subject does not. Answer the
slug, or null when none is clearly the same work.

{UNTRUSTED_TEXT_RULE}
""".strip()

FORMAT = {
    "type": "json_schema",
    "name": "same_document",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["slug"],
        "properties": {"slug": {"type": ["string", "null"]}},
    },
}


def kept_pages(storage: Storage, username: str, paper_id: str, settings: Settings) -> list[dict[str, Any]]:
    """
    The source pages a document may be asked about: each one whose document
    has left the library. None for a document that has a page of its own.
    """
    pages = storage.list_memory_pages(username, kinds=["source"], limit=settings.memory_max_pages)
    if any(page.get("sourcePaperId") == paper_id for page in pages):
        return []
    library = {str(paper["id"]) for project in storage.list_projects_with_papers(username) for paper in project.get("papers") or ()}
    return [page for page in pages if str(page.get("sourcePaperId") or "") not in library]


def deleted_marker(paper_id: str) -> str:
    """The marker of the event a deleted document leaves while its source page stays."""
    return f"deleted:{paper_id}"


def note_deleted(storage: Storage, username: str, paper_ids: Iterable[str], settings: Settings) -> None:
    """
    Log each of these deleted documents whose source page stays. Nothing else
    records when a document went, and a copy added back is asked about its
    page with that date (`deleted_at`).
    """
    gone = set(paper_ids)
    if not settings.memory_enabled or not gone:
        return
    for page in storage.list_memory_pages(username, kinds=["source"], limit=settings.memory_max_pages):
        paper_id = page.get("sourcePaperId")
        if paper_id in gone:
            storage.append_memory_event(username, {
                "kind": "document-delete",
                "marker": deleted_marker(paper_id),
                "createdAt": utc_now(),
                "paperId": paper_id,
                "summary": f"Deleted the document {page['title']}.",
                "pages": [],
                "edits": [],
            })


def deleted_at(storage: Storage, username: str, page: dict[str, Any]) -> str | None:
    """When a kept page's document was deleted; None for one deleted before Delphi noted it."""
    marker = deleted_marker(str(page.get("sourcePaperId") or ""))
    return (storage.latest_marker_events(username, [marker]).get(marker) or {}).get("createdAt")


def waits_for_reader(job: dict[str, Any]) -> bool:
    """Whether a job is parked on its question, which only the reader's answer lets go."""
    return job.get("retryAt") == WAITS_FOR_READER and SAME_AS in (job.get("payload") or {})


def wait_for_reader(storage: Storage, username: str, job: dict[str, Any], slug: str, settings: Settings) -> None:
    """
    Park a document's job on the question about `slug`.

    The check ran with the job held, and two things may have happened
    meanwhile. An enqueue writes a row that has gone, so a job the reader
    stopped, or whose document was deleted, would come back with no document
    in it: that row is cleared. And an answer that took the page released
    nothing parked yet, so the job is let go at once.
    """
    row = storage.enqueue_memory_job(
        username, kind="document", marker=job["marker"], payload={SAME_AS: slug}, not_before=WAITS_FOR_READER,
    )
    if "paperId" not in (row.get("payload") or {}):
        storage.clear_memory_job(username, job["marker"])
    elif slug not in {page["slug"] for page in kept_pages(storage, username, row["payload"]["paperId"], settings)}:
        storage.release_memory_jobs(username, marker=job["marker"])


def release_asked_about(storage: Storage, username: str, slug: str) -> None:
    """
    Let go every job waiting on a question about this page. Once the page is
    taken or deleted the question no longer stands, and its job, run again,
    files as usual.
    """
    for job in storage.list_memory_jobs(username):
        if waits_for_reader(job) and job["payload"][SAME_AS] == slug:
            storage.release_memory_jobs(username, marker=job["marker"])


async def same_document(
    http: httpx.AsyncClient,
    paper: dict[str, Any],
    digest: dict[str, Any],
    kept: list[dict[str, Any]],
    settings: Settings,
    *,
    use_standard_tier: bool,
) -> str | None:
    """Which of `kept` this document may be, to ask the reader about; or None."""
    if not kept:
        return None
    title = memory_slug(str(paper.get("title") or ""))
    exact = next((page for page in kept if title and memory_slug(str(page.get("title") or "")) == title), None)
    if exact is not None:
        return str(exact["slug"])
    if not settings.api_key:
        return None
    candidates = kept[:KEPT_PAGES_MAX]
    payload = {
        "model": settings.memory_same_document_model,
        "instructions": INSTRUCTIONS,
        "input": [{"role": "user", "content": "\n\n".join([
            fence(DOCUMENT_DIGEST, clip(str(digest.get("contentMarkdown") or ""), OPENING_CHARS), title=paper.get("title"), added="true"),
            *(
                fence(DOCUMENT_DIGEST, str(page.get("summary") or ""), title=page.get("title"), slug=page["slug"])
                for page in candidates
            ),
        ])}],
        "reasoning": {"effort": settings.memory_same_document_reasoning_effort},
        "text": {"format": FORMAT},
        "max_output_tokens": settings.memory_same_document_max_output_tokens,
        "store": False,
        **service_tier_field(settings, use_standard_tier),
    }
    try:
        result = require_completed(
            await asyncio.wait_for(ResponsesClient(http, settings).complete(payload), settings.memory_select_timeout_seconds),
            "The same-document check",
        )
        slug = json.loads("".join(result.texts())).get("slug")
    except Exception as exc:
        # Asking costs the reader a press; a failed check costs a second page, which is today's behaviour.
        logger.warning("memory_same_document_failed paper=%s %s: %s", paper.get("id"), type(exc).__name__, exc)
        return None
    return slug if slug in {page["slug"] for page in candidates} else None
