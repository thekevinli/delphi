"""Finishing the web pages an add read at their first window.

A windowed page draws only what is in its window (Notion's public pages, any
long list that unmounts what scrolls away). Reading one whole means growing the
window until all of it is drawn (`browser_render._uncover_windowed`), then
parsing a copy ten times the size: on a long Notion page, a quarter of a
minute the reader would spend watching the add. So the add reads it at the
window it was built in (`render_dom(whole=False)`), returns at once, and
marks the record `capture: "partial"` (the reader waits on the rest, or reads
what is there if it asks); `add_paper` queues a `capture` job in
the same write (invariant 50). This is that job: the page is read whole and
its text and page copy republished through the one writer of each
(`publish_snapshot`, under `annotation_revision_lock`, invariant 52), so the
highlights, which are anchored to quotes, are found again in the whole copy.

It is durable foreground work like Memory's, in the same queue: a renewed
lease, a claim handed back unspent when the window goes or the process stops
(invariant 50a), so an app quit or paused mid-capture finds the job due again
at its next launch. A worker that lost its lease mid-read publishes anyway and
completes nothing; its successor's publish then conflicts and is retried, a
read wasted rather than a page harmed. A document's filing waits for the
capture (`waits_for_capture`), so its digest is built once, from the whole
page. One that gives up keeps the first window, and owes nothing more
(`give_up`). No model is called: neither Memory nor a provider key is required.
"""

import asyncio
import logging
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from ..config import Settings, get_settings
from ..deps import get_current_user, get_object_store, get_storage
from ..memory import renewing_lease
from ..memory_failure import attempt_diagnostics
from ..sse import event_stream, sse
from ..storage import ObjectStore, Storage
from ..storage.base import CAPTURE_JOB_KINDS, capture_is_owed
from ..web_revision import read_revision
# Memory's registry of the claims this process holds, which a shutdown hands back.
from .memory import _HELD_CLAIMS, MEMORY_RETRY_DELAYS, retry_time
from .projects import framed_saved_copy, index_paper_sections_safely, snapshot_fields, snapshot_page

router = APIRouter(prefix="/api/captures", tags=["captures"])
logger = logging.getLogger("uvicorn.error")

#: When a capture a site turned away for asking too often (`describe_failure`'s
#: `throttled`) is tried again: past notion.site's throttle, which held for
#: five to thirty minutes, rather than at Memory's minute, which would spend
#: every attempt inside it and leave the page at its first window for good.
THROTTLED_RETRY_DELAYS = (600, 1800)


def _throttled(exc: Exception) -> bool:
    return isinstance(exc, HTTPException) and isinstance(exc.detail, dict) and exc.detail.get("code") == "throttled"


def captures_owed(storage: Storage, username: str) -> int:
    """How many captures will still run: what the window keeps asking for."""
    return sum(capture_is_owed(job) for job in storage.list_memory_jobs(username))


def give_up(storage: Storage, username: str, job: dict[str, Any]) -> dict[str, Any] | None:
    """Settle a capture that will not run again; the paper as it now stands.

    It failed its last attempt here, or was abandoned that many times and
    failed on the way past by a claim. The first window stays the document's
    copy and the record stops saying a whole one is coming, so the reader is
    not told so for good; the row goes, since no reader can retry it.
    """
    payload = job.get("payload") or {}
    storage.clear_memory_job(username, job["marker"])
    try:
        return storage.update_paper_snapshot(username, payload.get("projectId"), payload.get("paperId"), {"capture": None})
    except HTTPException:
        return None  # the paper went first


async def capture_whole(
    storage: Storage,
    objects: ObjectStore,
    settings: Settings,
    username: str,
    project_id: str,
    paper_id: str,
) -> dict[str, Any] | None:
    """Read a partial page whole and republish it; the paper as it now stands.

    None when the paper is gone. A paper that is not partial (read whole by an
    earlier claim that died before it completed) is answered as it is. The
    page copy is replaced only while it is still the first window the add
    stored (`publish_snapshot`).
    """
    try:
        paper = await run_in_threadpool(storage.get_paper, username, project_id, paper_id)
    except HTTPException as exc:
        if exc.status_code == 404:
            return None
        raise
    if paper.get("capture") != "partial":
        return paper
    # The whole page is frozen only to replace the add's first window; a copy
    # the reader's frame stored since is theirs (`publish_snapshot`).
    first_window = (await run_in_threadpool(read_revision, objects, username, project_id, paper_id)).get("savedPagePartial")
    document = await snapshot_page(
        paper["url"],
        objects,
        settings,
        username,
        project_id,
        paper_id,
        storage=storage,
        with_page_copy=bool(first_window),
    )
    # The whole page's words: the digest the filing builds next is built from these, once.
    captured = await run_in_threadpool(
        storage.update_paper_snapshot, username, project_id, paper_id,
        {**snapshot_fields(document, document.pop("_markdown")), "capture": None},
    )
    # Replaced, not added to: the first window's sections are a prefix of these.
    index_paper_sections_safely(storage, objects, username, project_id, captured)
    # Framed now, while nobody waits, so the reader's swap to the whole copy
    # is served from the cache rather than parsed while they look at it.
    try:
        saved = await run_in_threadpool(read_revision, objects, username, project_id, paper_id)
        if saved.get("savedDom"):
            await run_in_threadpool(framed_saved_copy, saved, paper["url"])
    except Exception:
        logger.warning("could not frame the whole copy of %s ahead of the reader", paper_id, exc_info=True)
    return captured


@router.post("/drain")
def drain_captures(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """Claim and run one due capture while a foreground request stays open.

    It answers one frame: `done` (`claimed`, the paper as republished, and how
    many captures are still owed) or an `error` saying when it is tried again,
    with the paper as it stands when it never will be. The stream's heartbeat
    keeps it open meanwhile (`sse.keep_alive`).
    """
    for abandoned in storage.list_memory_jobs(username):
        if abandoned["kind"] in CAPTURE_JOB_KINDS and not capture_is_owed(abandoned):
            give_up(storage, username, abandoned)
    now = datetime.now(UTC)
    job = storage.claim_memory_job(
        username,
        now=now.isoformat(),
        lease_expires_at=(now + timedelta(seconds=max(60.0, settings.memory_job_lease_seconds))).isoformat(),
        max_attempts=settings.memory_job_max_attempts,
        kinds=CAPTURE_JOB_KINDS,
    )

    async def stream() -> AsyncIterator[str]:
        if job is None:
            yield sse({"type": "done", "claimed": False, "remaining": captures_owed(storage, username)})
            return
        payload = job.get("payload") or {}
        project_id, paper_id = payload.get("projectId"), payload.get("paperId")
        frame = {"projectId": project_id, "paperId": paper_id}
        claim_key = f"{username}:{job['id']}"
        lease = None
        try:
            async with renewing_lease(storage, username, job, settings) as lease:
                _HELD_CLAIMS[claim_key] = lambda: storage.release_memory_job(
                    username, job["id"], expected_lease_expires_at=lease.expiry
                )
                paper = await capture_whole(storage, objects, settings, username, project_id, paper_id)
                # A claim another drain took over is that drain's to complete.
                if not lease.lost:
                    storage.complete_memory_job(username, job["id"], expected_lease_expires_at=lease.expiry)
            yield sse({**frame, "type": "done", "claimed": True, "paper": paper,
                       "remaining": captures_owed(storage, username)})
        except (asyncio.CancelledError, GeneratorExit):
            # The window went away: nothing failed, so the claim goes back
            # unspent (invariant 50a), and the next drain takes it.
            storage.release_memory_job(
                username, job["id"], expected_lease_expires_at=lease.expiry if lease else job.get("leaseExpiresAt")
            )
            raise
        except Exception as exc:
            retry_at = retry_time(int(job.get("attempts") or 1), settings,
                                  delays=THROTTLED_RETRY_DELAYS if _throttled(exc) else MEMORY_RETRY_DELAYS)
            detail = exc.detail if isinstance(exc, HTTPException) else None
            message = detail if isinstance(detail, str) else (
                str(detail.get("message")) if isinstance(detail, dict) and detail.get("message") else str(exc))
            logger.warning("capture of %s failed: %s", paper_id, message)
            paper = None
            if retry_at is None:
                # The filing it held goes ahead on the first window.
                paper = give_up(storage, username, job)
            else:
                try:
                    storage.fail_memory_job(
                        username, job["id"], error=message, retry_at=retry_at,
                        diagnostics=attempt_diagnostics(exc),
                        expected_lease_expires_at=lease.expiry if lease else job.get("leaseExpiresAt"),
                    )
                except HTTPException:
                    pass  # the paper, and with it the job, went while it ran
            yield sse({**frame, "type": "error", "message": message, "retryAt": retry_at, "terminal": retry_at is None,
                       "paper": paper, "remaining": captures_owed(storage, username)})
        finally:
            _HELD_CLAIMS.pop(claim_key, None)

    return event_stream(stream())
