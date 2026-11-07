"""
Memory over HTTP.

Everything here is scoped to the account and nothing else. A project id appears
only where one is genuinely needed, as where a job has to find its document,
and never as a container: filing a paper somewhere else, or deleting it, must
leave the Memory pages it produced exactly where it was.
"""

import asyncio
import hashlib
import json
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import aclosing, suppress
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from ..config import Settings, get_settings
from ..deps import get_current_user, get_object_store, get_storage
from ..memory import (
    MEMORY_VERSION,
    LeaseHolder,
    renewing_lease,
    document_filing_status,
    ensure_source_page,
    lint_memory,
    propose_reorganization,
    refresh_source_page,
    sync_domain_page,
)
from ..memory_authorship import written_by
from ..memory_same_document import (
    SAME_AS, deleted_at, kept_pages, release_asked_about, same_document, wait_for_reader, waits_for_reader,
)
from ..memory_health import build_memory_health
from ..memory_failure import attempt_diagnostics, job_failure, recorded_cause
from ..memory_maintenance.jobs import STALE_RELEASES
from ..memory_maintenance.run import StaleRevision
from ..memory_maintenance.jobs import DOMAIN, RECONCILE, SESSION, document_family, document_marker, session_marker
from ..memory_maintenance.pipeline import run_job
from ..storage.domains import domain_job
from ..memory_graph_index import (
    get_memory_graph_index,
    prime_memory_graph_index,
)
from ..research_digest import (
    digest_evidence_labels,
    digest_metadata_is_current,
    generate_digest,
    load_digest,
)
from ..sse import event_stream, sse
from ..schemas import (
    MemoryBackfillRequest,
    MemoryDomainWrite,
    MemoryPageMove,
    MemoryPageRewriteRequest,
    MemoryUpdateProgress,
    SameDocumentAnswer,
    SessionRelease,
)
from ..harness.evidence import reap as reap_external_evidence
from ..storage.base import CAPTURE_JOB_KINDS, DOCUMENT_JOB_KINDS, job_is_due, waits_for_capture
from ..storage import (
    MemoryJobGone,
    ObjectStore,
    Storage,
    job_payload_is_upgradeable,
    memory_slug,
    safe_id,
    utc_now,
)

router = APIRouter(prefix="/api/memory", tags=["memory"])
logger = logging.getLogger("uvicorn.error")
# How often the reorganization tells the reader it is still comparing pages.
# Liveness is the transport's job (`delphi_core/sse.py`); this is the message.
REORGANIZE_HEARTBEAT_SECONDS = 15.0


def digest_is_current(paper: dict[str, Any], settings: Settings) -> bool:
    """Whether Memory may rely on the stored digest without rebuilding it."""
    return digest_metadata_is_current(paper, settings)


def require_enabled(settings: Settings) -> None:
    if not settings.memory_enabled:
        raise HTTPException(403, "Memory is turned off on this server")


JOB_KIND_LABELS = {
    "page-rewrite": "Rewriting one Memory page",
    "document": "Filing a document",
    "session": "Filing a session",
    "domain": "Writing a domain summary",
    "reconcile": "Reconciling pages that disagree",
}
#: The kinds a reader starts by pressing something, which is what "Stop
#: filing" calls off.
CANCELLABLE_JOB_KINDS = ("document", "page-rewrite")


def describe_jobs(storage: Storage, username: str, jobs: list[dict[str, Any]]) -> None:
    """
    Give each job a name a reader can act on, in place.

    `paper:e13eedbd5826` says nothing to the person whose document it is. Two
    queries whatever the queue's depth (the projects with their papers, and
    the domains), not a lookup per job. The label comes from the records and
    not from the payload.

    A failed job also gets `failure`, why it stopped (`job_failure`); the
    pages a check refused come from the events those jobs left, one more read
    and only when there are such jobs.
    """
    titles: dict[str, str] = {}
    projects: dict[str, str] = {}
    for project in storage.list_projects_with_papers(username):
        projects[project["id"]] = project.get("name", "")
        for paper in project.get("papers", []):
            titles[paper["id"]] = paper.get("title") or paper.get("filename", "")
    domain_titles = {
        domain["slug"]: domain.get("title") or domain["slug"]
        for domain in storage.memory_domains(username)
    }
    for job in jobs:
        payload = job.get("payload") or {}
        kind = job["kind"]
        if kind == "page-rewrite":
            subject = payload.get("pageTitle") or payload.get("pageSlug") or ""
        elif kind == "domain":
            subject = domain_titles.get(payload.get("domain", ""), payload.get("domain", ""))
        else:
            subject = titles.get(payload.get("paperId") or "", "")
        # A document that has since been deleted leaves the kind to speak for
        # itself, not an empty line where a title should be.
        kind_label = JOB_KIND_LABELS.get(kind, kind)
        job["label"] = subject or kind_label
        job["context"] = (
            kind_label
            if subject
            else projects.get(payload.get("projectId") or "", "")
        )
    checked = [job.get("marker") or "" for job in jobs if recorded_cause(job) == "check"]
    events = storage.latest_marker_events(username, checked) if checked else {}
    for job in jobs:
        job["failure"] = job_failure(job, events.get(job.get("marker") or ""))


# How long a failed job waits before it is due again. One entry per retry the
# ceiling allows; a ceiling raised past this list simply reuses the last delay.
MEMORY_RETRY_DELAYS = (60, 300, 1800)


def retry_time(
    attempts: int, settings: Settings, *, at_once: bool = False, delays: tuple[int, ...] = MEMORY_RETRY_DELAYS
) -> str | None:
    """When a job that failed on its `attempts`th claim is due again; None once it has had them all.

    The ceiling is the setting's, not a literal: a hardcoded 3 meant a job that
    reported its failures gave up at three while one that was merely abandoned
    kept being reclaimed until `memory_job_max_attempts`, so the two halves of
    the same rule disagreed about when a document had had enough. The schedule
    is indexed defensively because it is shorter than the ceiling may be.
    """
    if attempts >= settings.memory_job_max_attempts:
        return None
    delay = 0 if at_once else delays[min(attempts, len(delays)) - 1]
    return (datetime.now(UTC) + timedelta(seconds=delay)).isoformat()


def maintenance_snapshot(storage: Storage, username: str) -> dict[str, Any]:
    """
    The queue's counts and its rows, and deliberately no labels.

    The drain asks for this after every job it finishes, only ever to report
    `remaining` — so labelling here would put two queries on that path per job
    for a string nothing on it reads. `describe_jobs` is the reader-facing
    route's business.
    """
    queued = storage.list_memory_jobs(username)
    # A capture is the queue's, not Memory's: no Memory drain takes it. A job
    # parked on the reader's answer is a question its document's card asks,
    # not work in line, so nothing counts it as filing or offers to stop it.
    jobs = [job for job in queued if job["kind"] not in CAPTURE_JOB_KINDS and not waits_for_reader(job)]
    now = utc_now()
    # The claim's own test, so `remaining` never counts a job that is waiting
    # for its session to end, or for its page to be read whole, and that no
    # drain could take.
    due = sum(job_is_due(job, now) and not waits_for_capture(job, queued) for job in jobs)
    return {
        "pending": sum(job["status"] == "pending" for job in jobs),
        "leased": sum(job["status"] == "leased" for job in jobs),
        # What "Stop filing" would actually remove, counted by the same rule
        # `cancel_memory_jobs` applies — so the button cannot offer to stop
        # work the cancel would leave, or stay hidden over work it would take.
        # A parked job is not counted though Stop takes it: it is not work, and
        # its document, filed again, asks again.
        # Both halves of that have bitten: counting only `pending` hid the
        # button over a queue waiting out its retry backoff, which is the
        # clearest case for stopping, and excluding `leased` hid it during a
        # single-document run, which is the case a reader is most likely to be
        # watching when they want out.
        "cancellable": sum(
            job["kind"] in CANCELLABLE_JOB_KINDS
            and (
                job["status"] in ("pending", "leased")
                or (job["status"] == "failed" and job.get("retryAt") is not None)
            )
            for job in jobs
        ),
        "failed": sum(job["status"] == "failed" for job in jobs),
        "due": due,
        "jobs": jobs,
    }


@router.get("/maintenance")
def get_memory_maintenance(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """Account-scoped durable work, including failures a reader may retry."""
    require_enabled(settings)
    snapshot = maintenance_snapshot(storage, username)
    describe_jobs(storage, username, snapshot["jobs"])
    # How many tries a job gets, so a job still retrying can say which is next.
    return {**snapshot, "maxAttempts": settings.memory_job_max_attempts}


@router.post("/maintenance/jobs/{job_id}/retry")
def retry_memory_maintenance(
    job_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    require_enabled(settings)
    return storage.retry_memory_job(username, job_id)


@router.post("/maintenance/cancel")
def cancel_memory_maintenance(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """
    Stop the filing the reader started, without undoing what it has done.

    Update is the one control that commits an account to an unbounded amount
    of model spend: one press queues a job per out-of-date document, and the
    pump drains them for the rest of the session. This is the way back.

    Scoped to the kinds a reader presses a button for
    (`CANCELLABLE_JOB_KINDS`). A `domain` job is a rewrite Memory owes itself
    and is cheap; it is not what "stop filing" means.

    It reaches the document being written this second. The drain asks
    `memory_job_exists` as each stage starts and stands down when the
    answer is no, so stopping abandons the stage in flight and saves the rest.

    Only a job that has given up keeps its place, so Health can still show
    why. Pages already written stay, a filing stopped partway writes nothing
    (pages and event are one commit at the end), and a document that was out
    of date still is, so the offer comes back.
    """
    require_enabled(settings)
    return {
        "cancelled": storage.cancel_memory_jobs(
            username, kinds=CANCELLABLE_JOB_KINDS
        )
    }


@router.post("/sessions/release")
def release_sessions(
    body: SessionRelease | None = None,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """
    The reader left a session, so its job may run now.

    A session's job waits while the session is open: every answered turn and
    every note change pushes its wait forward. This ends the wait. The window
    calls it when the document beside the chat changes or the panel goes away
    (`paperId`), when a Memory chat is left (`conversationId`), and with no
    body when it is launched, which releases every waiting session of the
    account: closing the app sends nothing, and at launch no session is open.
    "File it now" is the same call.

    It runs nothing itself; the next drain claims what it released. Calling it
    again, or for a session with no job, releases nothing and answers 0. A
    reader who comes back and asks again holds a new wait, also on a job that
    is running: that job keeps its row and returns to the wait when it ends.
    """
    require_enabled(settings)
    body = body or SessionRelease()
    marker = (
        session_marker(paper_id=body.paperId) if body.paperId
        else session_marker(conversation_id=body.conversationId) if body.conversationId
        else None
    )
    return {"released": storage.release_memory_jobs(username, kind=SESSION, marker=marker)}


async def run_maintenance_job(
    job: dict[str, Any],
    *,
    client: httpx.AsyncClient,
    storage: Storage,
    objects: ObjectStore,
    username: str,
    settings: Settings,
    use_standard_tier: bool,
) -> AsyncIterator[dict[str, Any]]:
    """
    Run one leased job with the pass its kind names.

    Each pass ends with one `_memory_result`. A job that already committed
    and was claimed again answers `reused` from its own event, so a process
    that died between the event and the job's removal pays for nothing twice.
    """
    if job["kind"] == "document":
        # Closed with this generator, not whenever it is collected: a drain
        # the reader left must release the digest claim it holds now.
        async with aclosing(run_document_job(
            job, client=client, storage=storage, objects=objects, username=username,
            settings=settings, use_standard_tier=use_standard_tier,
        )) as events:
            async for event in events:
                yield event
        return
    if job["kind"] in (SESSION, RECONCILE, DOMAIN):
        async with aclosing(run_job(
            job, http=client, storage=storage, objects=objects, username=username,
            settings=settings, use_standard_tier=use_standard_tier,
        )) as events:
            async for event in events:
                yield event
        return
    if job["kind"] == "page-rewrite":
        from ..memory_rewrite import rewrite_page
        async for event in rewrite_page(client, storage, objects, username, settings,
                                       job=job, use_standard_tier=use_standard_tier):
            yield event
        return
    raise ValueError(f"No pass runs {job['kind']!r} jobs")


async def run_document_job(
    job: dict[str, Any],
    *,
    client: httpx.AsyncClient,
    storage: Storage,
    objects: ObjectStore,
    username: str,
    settings: Settings,
    use_standard_tier: bool,
) -> AsyncIterator[dict[str, Any]]:
    """
    A `document` job: make what the pipeline files from, then run the pipeline.

    Import queues the job in the write that makes the document visible, which
    is before anything has read it. So a job claimed first builds the digest
    here, and publishing a digest derives the document's source page and gives
    this same job the digest's fingerprint (`file_republished_digest`). A
    document whose digest is current and whose source page is missing gets
    the page. A document that is gone is the pipeline's to report.

    A document with no page of its own may be one whose deleted copy left a
    page. When it may be, the job waits for the reader, the question on its
    row (`memory_same_document`), and ends with `_memory_waiting`.
    """
    payload = job.get("payload") or {}
    project_id, paper_id = payload.get("projectId"), payload.get("paperId")
    try:
        paper = await run_in_threadpool(storage.get_paper, username, project_id, paper_id)
    except HTTPException:
        paper = None
    if paper is not None:
        if not digest_is_current(paper, settings):
            yield {
                "type": "progress",
                "stage": "digest_check",
                "message": f"Reading {paper.get('title', 'the document')}",
            }
            async with aclosing(generate_digest(
                client,
                storage,
                objects,
                username,
                project_id,
                paper_id,
                settings,
                use_standard_tier=use_standard_tier,
            )) as digest_events:
                async for event in digest_events:
                    if event["type"] == "_digest_ready":
                        paper = event["paper"]
                    elif not event["type"].startswith("_"):
                        yield event
        kept = await run_in_threadpool(kept_pages, storage, username, paper_id, settings)
        asked = payload.get(SAME_AS)
        if kept and asked is None:
            # A stage of its own, so a reader who stopped the filing stops it before the call.
            yield {"type": "progress", "stage": "same_document", "message": "Checking pages kept from deleted documents"}
            try:
                digest = await run_in_threadpool(load_digest, objects, username, project_id, paper_id)
            except Exception:
                # Nothing to compare, and no page to write: the pipeline says what it could not read.
                digest = None
            if digest is not None:
                asked = await same_document(client, paper, digest, kept, settings, use_standard_tier=use_standard_tier)
        if asked in {page["slug"] for page in kept}:
            await run_in_threadpool(wait_for_reader, storage, username, job, asked, settings)
            yield {"type": "_memory_waiting"}
            return
        await ensure_source_page(objects, storage, username, project_id, paper, settings)
    async with aclosing(run_job(
        job, http=client, storage=storage, objects=objects, username=username,
        settings=settings, use_standard_tier=use_standard_tier,
    )) as events:
        async for event in events:
            yield event


# Claims this process is working, keyed by account and job, so a shutdown can
# hand them back. A drain whose client disconnects releases its own claim (the
# `CancelledError` handler below); a server stopping under a request is not that
# path, and its rows stayed leased, and unclaimable, until the lease ran out.
_HELD_CLAIMS: dict[str, Callable[[], None]] = {}
#: How often this process gave each job back for a page that moved on under it.
_STALE_SEEN: dict[str, int] = {}


def _given_back(job_id: str) -> bool:
    """Whether a job that met `StaleRevision` may go back unspent once more (`jobs.STALE_RELEASES`)."""
    if len(_STALE_SEEN) > 1_000:
        _STALE_SEEN.clear()
    _STALE_SEEN[job_id] = _STALE_SEEN.get(job_id, 0) + 1
    return _STALE_SEEN[job_id] <= STALE_RELEASES


def release_held_claims() -> int:
    """Hand back every claim still held; called as the application shuts down."""
    released = 0
    for key, release in list(_HELD_CLAIMS.items()):
        _HELD_CLAIMS.pop(key, None)
        try:
            release()
            released += 1
        except Exception:
            logger.warning("could not release Memory claim %s", key, exc_info=True)
    return released


@router.post("/maintenance/drain")
def drain_memory_maintenance(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """Claim and process one due job while a foreground request stays open."""
    require_enabled(settings)
    if not settings.api_key:
        raise HTTPException(503, "No model provider is configured")
    now = datetime.now(UTC)
    # The whole job's budget, not one model call's. See
    # `memory_job_lease_seconds` for why the two are different numbers.
    lease_seconds = max(60.0, settings.memory_job_lease_seconds)
    job = storage.claim_memory_job(
        username,
        now=now.isoformat(),
        lease_expires_at=(now + timedelta(seconds=lease_seconds)).isoformat(),
        max_attempts=settings.memory_job_max_attempts,
    )
    request_id = uuid4().hex

    async def stream() -> AsyncIterator[str]:
        if job is None:
            yield sse(
                {
                    "type": "done",
                    "requestId": request_id,
                    "claimed": False,
                    "remaining": maintenance_snapshot(storage, username)["due"],
                }
            )
            return
        account = storage.get_account(username) or {}
        use_standard_tier = bool(account.get("useStandardTier", True))
        claim_key = f"{username}:{job['id']}"
        try:
            timeout = httpx.Timeout(settings.memory_review_timeout_seconds, connect=20)
            result: dict[str, Any] = {}
            # What the job read, when its pass says: the row is completed
            # against it, so a change that arrived during the work is kept.
            read_fingerprint: str | None = (job.get("payload") or {}).get("fingerprint")
            # The claim is a fence now, so the work has to keep saying it is
            # alive; stop saying it and the row frees within one lease instead
            # of being held for the length of a whole pass.
            stood_down = False
            # A document that may be one the reader deleted waits for their answer (`memory_same_document`).
            waiting = False
            # Held outside the `async with` so the handlers below can present
            # it: every mutation of the row is fenced on the lease it was
            # claimed under, and a stale worker must not fail or hand back the
            # claim its successor is holding.
            lease = LeaseHolder(expiry=job.get("leaseExpiresAt"))
            # Fenced on whichever lease is current when it runs, like the
            # handlers below; a successor's claim is never touched.
            _HELD_CLAIMS[claim_key] = lambda: storage.release_memory_job(
                username, job["id"], expected_lease_expires_at=lease.expiry
            )
            async with (
                renewing_lease(storage, username, job, settings) as lease,
                httpx.AsyncClient(timeout=timeout) as client,
            ):
                # `aclosing` because the loop below can leave early. Breaking
                # out of a bare `async for` happens to work under CPython,
                # whose refcounting finalises the generator as soon as the name
                # goes out of scope — but that is a property of the
                # interpreter, not of the code, and what is being relied on
                # here is that `GeneratorExit` reaches a pass holding the model
                # client. Saying so explicitly costs one line.
                async with aclosing(
                    run_maintenance_job(
                        job,
                        client=client,
                        storage=storage,
                        objects=objects,
                        username=username,
                        settings=settings,
                        use_standard_tier=use_standard_tier,
                    )
                ) as pass_:
                    stage: str | None = None
                    try:
                        async for event in pass_:
                            # Between stages, and only between stages: has the
                            # reader called this off? A document is a selection,
                            # the agent's loop and a check, so each boundary is a
                            # chance not to pay for what is left. Checked on
                            # change rather than per frame because the question
                            # costs a query and the answer cannot change mid-stage
                            # in any way we could act on.
                            if event.get("stage") != stage:
                                stage = event.get("stage")
                                # Two ways to stop, and they were one for too long.
                                # The row being gone is the reader calling it off.
                                # The *lease* being gone is another worker having
                                # taken this job over after ours lapsed — and the
                                # row still exists in that case, so asking only
                                # whether it exists let a lapsed worker run on and
                                # publish beside its own successor.
                                if lease.lost or not storage.memory_job_exists(
                                    username, job["id"]
                                ):
                                    stood_down = True
                                    break
                            if event["type"] == "_memory_waiting":
                                waiting = True
                            elif event["type"] == "_memory_result":
                                read_fingerprint = event.get("fingerprint") or read_fingerprint
                                result = {
                                    "pages": event.get("pages", []),
                                    "figures": event.get("figures", []),
                                    "method": event.get("method"),
                                    "reused": event.get("reused", False),
                                }
                            elif not event["type"].startswith("_"):
                                yield sse(
                                    {**event, "requestId": request_id, "jobId": job["id"]}
                                )
                    except MemoryJobGone:
                        # The row went between the last stage check and the
                        # commit, and the commit refused under its lock: the
                        # same stand-down, caught at the one moment the stage
                        # check cannot see.
                        stood_down = True
                # Nothing to complete when the row is already gone, and nothing
                # written either: a document's pages and its event are one
                # commit at the end of the pass, so a filing stopped partway
                # leaves the document exactly as out of date as it was.
                if waiting and not stood_down:
                    # Handed back unspent; the row keeps the wait its question set.
                    storage.release_memory_job(username, job["id"], expected_lease_expires_at=lease.expiry)
                elif not stood_down:
                    storage.complete_memory_job(
                        username,
                        job["id"],
                        expected_lease_expires_at=lease.expiry,
                        # If the record changed while the job ran, the row is
                        # kept for another pass.
                        fingerprint=read_fingerprint,
                    )
                remaining = maintenance_snapshot(storage, username)["due"]
            yield sse(
                {
                    "type": "done",
                    "requestId": request_id,
                    # `claimed` drives the client's loop, and after standing
                    # down the honest answer is that this drain is not carrying
                    # work forward: the reader emptied the queue under it. A
                    # worker that read `true` here would count a document it
                    # abandoned as one it filed, and the card would report a
                    # filing that never happened.
                    "claimed": not stood_down,
                    "cancelled": stood_down,
                    "jobId": job["id"],
                    "kind": job["kind"],
                    "marker": job["marker"],
                    "result": result,
                    "remaining": remaining,
                }
            )
        except (asyncio.CancelledError, GeneratorExit):
            # The reader navigated, reloaded, or closed the tab. Nothing failed,
            # so nothing is recorded against the document -- and the claim goes
            # back unspent, because `except Exception` below cannot see this at
            # all (`CancelledError` is a `BaseException`) and the row would
            # otherwise sit leased, with an attempt spent and no error, until
            # the lease ran out. One real document burned all three attempts
            # that way without a single filing ever being tried.
            storage.release_memory_job(
                username, job["id"], expected_lease_expires_at=lease.expiry
            )
            raise
        except Exception as exc:
            if isinstance(exc, StaleRevision) and _given_back(job["id"]):
                # Another job moved Memory on under this one: no fault of the
                # job, so it goes back with its attempt unspent, due at once.
                storage.release_memory_job(username, job["id"], expected_lease_expires_at=lease.expiry)
                yield sse({
                    "type": "error", "requestId": request_id, "jobId": job["id"], "message": str(exc),
                    "retryAt": datetime.now(UTC).isoformat(), "terminal": False,
                })
                return
            # A page that moved on under a job is no fault of the job: it is
            # due again at once, to be written against the fresh page.
            retry_at = retry_time(int(job.get("attempts") or 1), settings, at_once=isinstance(exc, StaleRevision))
            try:
                failed = storage.fail_memory_job(
                    username,
                    job["id"],
                    error=str(exc),
                    retry_at=retry_at,
                    diagnostics=attempt_diagnostics(exc),
                    expected_lease_expires_at=lease.expiry,
                )
            except HTTPException:
                # The row can be gone by the time we get here: the reader
                # may stop the filing, or delete the document, while this
                # drain holds its job leased. A 404 raised from inside this
                # handler would leave the generator with nothing more to
                # yield, no `error` frame and no `done`, which is the silent
                # stream death invariant 50a exists to stop. So report the
                # failure and let the drain carry on to the next job.
                failed = {"retryAt": retry_at}
            logger.warning("Memory maintenance job failed", exc_info=True)
            yield sse(
                {
                    "type": "error",
                    "requestId": request_id,
                    "jobId": job["id"],
                    "message": str(exc),
                    "retryAt": failed.get("retryAt"),
                    "terminal": failed.get("retryAt") is None,
                }
            )
        finally:
            _HELD_CLAIMS.pop(claim_key, None)

    return event_stream(stream())


@router.get("")
def memory_overview(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """Domains, pages and the log — everything the shell needs to open."""
    require_enabled(settings)
    domains = storage.memory_domains(username)
    pages = storage.list_memory_pages(username, limit=settings.memory_max_pages)
    index = prime_memory_graph_index(
        storage,
        username,
        pages=pages,
        domains=domains,
        links=storage.list_memory_links(username),
    )
    catalog = index.qualified_graph()
    return {
        "version": MEMORY_VERSION,
        "revision": index.revision,
        "statistics": index.statistics,
        "domains": catalog["domains"],
        "pages": catalog["pages"],
        # The edge list travels with the overview because the graph needs all
        # of it and none of the bodies — the one shape a listing can carry
        # without becoming the thing invariant 30 exists to prevent.
        "links": catalog["links"],
        "events": [_listed(event) for event in storage.list_memory_events(username, limit=50)],
    }


def _listed(event: dict[str, Any]) -> dict[str, Any]:
    """An event as the overview lists it: a dropped page's staged body stays in the log, for whoever diagnoses it."""
    if not any("body" in item for item in event.get("dropped") or ()):
        return event
    staged = ("body", "summary")
    return {**event, "dropped": [{key: value for key, value in item.items() if key not in staged} for item in event["dropped"]]}


#: A tab that is running an Update stamps this record as it goes. Longer than
#: the gap between two documents finishing and far shorter than a run, so a
#: closed tab is recognised as gone within a document's worth of time.
UPDATE_HEARTBEAT_STALE_SECONDS = 180


def _update_state(storage: Storage, username: str) -> dict[str, Any] | None:
    """
    The account's Update run, with `stale` derived rather than stored.

    A `running` record whose heartbeat has stopped is not a run in progress:
    the Update pass lives in the tab that started it, so a closed tab is the
    documented end of one. Deriving it on read is what keeps a stale record
    from animating a progress bar nothing is advancing — and it cannot be
    stored, because the thing that would have to write it is the tab that
    is gone.
    """
    state = storage.get_memory_update(username)
    if state is None:
        return None
    stale = False
    if state.get("status") == "running":
        beat = state.get("heartbeatAt") or state.get("startedAt") or ""
        try:
            beaten = datetime.fromisoformat(beat.replace("Z", "+00:00"))
        except ValueError:
            beaten = None
        stale = (
            beaten is None
            or (datetime.now(UTC) - beaten).total_seconds()
            > UPDATE_HEARTBEAT_STALE_SECONDS
        )
    return {**state, "stale": stale}


@router.get("/update")
def memory_update_state(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """What the account's one Update run is doing, for a tab that did not start it."""
    require_enabled(settings)
    return {"update": _update_state(storage, username)}


@router.put("/update")
def write_memory_update_state(
    body: MemoryUpdateProgress,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """
    Record how far the run in this browser has got.

    Counts only, and the timestamps are the server's: `startedAt` is kept from
    the record already there so a run keeps one start across every tick, and
    `heartbeatAt` is stamped here rather than accepted, because a clock the
    server does not own is not a clock it can measure staleness against.
    """
    require_enabled(settings)
    now = utc_now()
    previous = storage.get_memory_update(username) or {}
    state = {
        **body.model_dump(),
        "startedAt": (
            previous.get("startedAt")
            if previous.get("status") == "running" and body.status == "running"
            else now
        )
        or now,
        "heartbeatAt": now,
        "finishedAt": None if body.status == "running" else now,
    }
    return {"update": {**(storage.set_memory_update(username, state) or {}), "stale": False}}


@router.delete("/update")
def clear_memory_update_state(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """The reader dismissing the result. A run in progress is not cleared here."""
    require_enabled(settings)
    storage.set_memory_update(username, None)
    return {"update": None}


@router.get("/documents/{paper_id}/filing")
def document_filing_state(
    paper_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """
    Whether one document has been filed, and whether work for it is still owed.

    The Reader's rail draws a document with no page of its own from `GET
    /graph` alone, and that one fact spells several situations the same way:
    never filed, filing queued and not yet run, filed by a job that found
    nothing to write, and filed by a pass Delphi has since replaced (`stale`,
    from the predicate the Update button counts with). `dropped` lists what
    the document's last job staged and could not write, each with the
    checker's reason, which is when the card offers Retry. `version` is
    served so no client spells the constant itself.

    `sameAs` is the kept page a parked job asks about, while that page is
    still kept, and when its document was deleted (`memory_same_document`); a
    parked job is not `queued`.

    Records only, and bounded: two log reads, the library twice, the source
    pages and the account's own job list. No object read and no model call.
    """
    require_enabled(settings)
    paper_id = safe_id(paper_id)
    # Reached by paper id alone, so the record comes from the one library read
    # `describe_jobs` already makes. A document that is gone answers the
    # never-filed shape, which is what this card says for anything it cannot find.
    paper = next(
        (
            item
            for project in storage.list_projects_with_papers(username)
            for item in project.get("papers", [])
            if item["id"] == paper_id
        ),
        {"id": paper_id},
    )
    family = document_family(paper_id)
    status = document_filing_status(
        storage.memory_event_versions(username, family[:1]),
        paper,
        storage.latest_marker_events(username, family),
    )
    queued = False
    stuck = False
    asked = None
    for job in storage.list_memory_jobs(username):
        if job["kind"] not in DOCUMENT_JOB_KINDS:
            continue
        if (job.get("payload") or {}).get("paperId") != paper_id:
            continue
        if waits_for_reader(job):
            asked = job["payload"][SAME_AS]
        elif job["status"] in ("pending", "leased"):
            queued = True
        elif job["status"] == "failed":
            # A failure carrying a retry time is still owed work, whether or
            # not that time has come; one that has given up is the state the
            # reader has to be told about, because nothing will pick it up
            # again on its own.
            if job.get("retryAt") is not None:
                queued = True
            else:
                stuck = True
    return {
        "filed": status["filed"],
        "queued": queued,
        "stuck": stuck,
        "stale": status["stale"],
        "dropped": status["dropped"],
        "filedVersion": status["filedVersion"],
        "version": MEMORY_VERSION,
        "sameAs": next(
            ({"slug": page["slug"], "title": page["title"], "deletedAt": deleted_at(storage, username, page)}
             for page in kept_pages(storage, username, paper_id, settings) if page["slug"] == asked),
            None,
        ) if asked else None,
    }


@router.post("/documents/{paper_id}/same-as")
async def answer_same_document(
    paper_id: str,
    body: SameDocumentAnswer,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """
    The reader's answer to whether a document is the one a kept page was
    written from. Either way the document gets its page now: the kept one,
    rewritten from this document's digest, or one of its own. Then its job
    is let go to file the rest. 409 when no question about it stands.
    """
    require_enabled(settings)
    paper_id = safe_id(paper_id)

    def question() -> tuple[str, dict[str, Any], str]:
        asked = next(
            (job["payload"][SAME_AS] for job in storage.list_memory_jobs(username)
             if job["marker"] == document_marker(paper_id) and waits_for_reader(job)),
            None,
        )
        found = next(
            ((project["id"], paper) for project in storage.list_projects_with_papers(username)
             for paper in project.get("papers") or () if paper["id"] == paper_id),
            None,
        )
        if found is None or not asked or asked not in {page["slug"] for page in kept_pages(storage, username, paper_id, settings)}:
            raise HTTPException(409, "There is no question about this document to answer")
        project_id, paper = found
        return asked, paper, project_id

    asked, paper, project_id = await run_in_threadpool(question)
    digest = await run_in_threadpool(load_digest, objects, username, project_id, paper_id)
    if not await refresh_source_page(objects, storage, username, project_id, paper, digest, settings,
                                     kept=asked if body.use else None):
        raise HTTPException(503, "Could not write its page just now; try again")
    # This document's job, and any other asking about the same page, run again on what stands now.
    await run_in_threadpool(release_asked_about, storage, username, asked)
    return {"used": body.use}


@router.get("/graph")
def memory_graph(
    request: Request,
    response: Response,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """
    Pages, edges and domains — the three things a Related Memory rail needs.

    Deliberately *not* `GET /api/memory`. That route heals missing domain
    domain pages on the way past, which makes it a write, and it carries the event log
    as well. Both are right for the wiki's own shell, which is opened
    intentionally; neither is right for the Reader, where this is fetched
    beside a document the reader came to read. A read on that path that can
    write, or that grows with the event log, is the cost invariant 57a exists
    to refuse — the Dashboard learned it the expensive way.

    No bodies, for the reason invariant 30 gives for every other listing.
    """
    require_enabled(settings)
    index = get_memory_graph_index(
        storage, username, max_pages=settings.memory_max_pages
    )
    etag = f'"{index.revision}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    response.headers["ETag"] = etag
    return {
        "revision": index.revision,
        "statistics": index.statistics,
        **index.qualified_graph(),
    }


@router.get("/neighborhood")
def memory_neighborhood(
    slug: str = Query(min_length=1, max_length=60),
    hops: int | None = Query(default=None, ge=0, le=4),
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """A bounded local graph for rails; never downloads the whole account."""
    require_enabled(settings)
    index = get_memory_graph_index(
        storage, username, max_pages=settings.memory_max_pages
    )
    target = memory_slug(slug)
    if target not in index.pages_by_slug and target not in index.adjacency:
        raise HTTPException(404, "Memory page not found")
    return index.neighborhood(target, settings.memory_related_hops if hops is None else hops)


@router.get("/documents/{paper_id}/neighborhood")
def document_memory_neighborhood(
    paper_id: str,
    hops: int | None = Query(default=None, ge=0, le=4),
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """Filing state plus the canonical source page's bounded neighborhood."""
    require_enabled(settings)
    paper_id = safe_id(paper_id)
    index = get_memory_graph_index(
        storage, username, max_pages=settings.memory_max_pages
    )
    source = index.source_page_by_paper_id.get(paper_id)
    filing = document_filing_state(paper_id, username, storage, settings)
    if source is None:
        return {
            "paperId": paper_id,
            "revision": index.revision,
            "statistics": index.statistics,
            "center": None,
            "distances": {},
            "domains": [],
            "pages": [],
            "links": [],
            "filing": filing,
            "sourcePage": None,
        }
    return {
        "paperId": paper_id,
        **index.neighborhood(source["slug"], settings.memory_related_hops if hops is None else hops),
        "filing": filing,
        "sourcePage": source,
    }


@router.get("/health")
def memory_health(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """
    What is wrong with the base's shape, plus whatever the last check found.

    Two tiers in one request. The body is arithmetic over the records —
    orphans, uncaptured figures, dropped targets — and carries
    **no `api_key` guard**, because it makes no model call and a reader with no
    provider configured is entitled to their own counters. `lastCheck` is the
    newest lint event, which is where contradictions live;
    absent means nobody has ever run one, which the tab shows as a dash rather
    than a zero.

    Kept off `GET /api/memory`, which every mount of the shell fetches:
    folding health in would charge the Pages and Graph tabs for the figure and
    event queries only this one reads.
    """
    require_enabled(settings)
    health = build_memory_health(storage, username, settings=settings)
    # Kind-filtered, not a scan of the newest mixed page: after a busy Update
    # the lint scrolls out of `list_memory_events`' limit and the tab would
    # claim nobody ever looked. Same windowing failure `has_memory_event`
    # exists to stop for ingest markers.
    return {
        **health,
        "lastCheck": storage.latest_memory_event(username, kind="lint"),
    }


@router.get("/pages")
def list_pages(
    kind: list[str] | None = Query(default=None),
    domain: list[str] | None = Query(default=None),
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    require_enabled(settings)
    return storage.list_memory_pages(
        username,
        kinds=kind,
        domains=domain,
        limit=settings.memory_max_pages,
    )


@router.get("/search")
def search_pages(
    q: str = Query(default="", max_length=400),
    domain: str | None = Query(default=None),
    limit: int = Query(default=12, ge=1, le=50),
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    require_enabled(settings)
    return {
        "query": q,
        "results": storage.search_memory_pages(
            username, q, domain=domain, limit=limit
        ),
    }


@router.get("/domains")
def list_domains(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    require_enabled(settings)
    # An empty domain the reader made is listed: it is how they see Create
    # worked. One the model named and every page has since left (the unsorted
    # domain, once its documents are filed) is a row nobody asked for.
    return {
        "domains": [
            domain
            for domain in storage.memory_domains(username)
            if domain.get("pages") or domain.get("origin") == "reader"
        ]
    }


@router.post("/domains")
def create_domain(
    body: MemoryDomainWrite,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """
    A domain the reader named, rather than one an ingest happened to invent.

    Upsert rather than create: naming a domain that already exists is a rename
    plus a claim, which is exactly what a reader means when they type a better
    name over one the model chose. `origin` is set here and never taken from
    the request — see `MemoryDomainWrite`.
    """
    require_enabled(settings)
    record = storage.upsert_memory_domain(
        username,
        {
            "slug": memory_slug(body.slug or body.title),
            "title": body.title,
            "summary": body.summary,
            "origin": "reader",
            **({"position": body.position} if body.position is not None else {}),
        },
    )
    return record


@router.patch("/domains/{slug}")
def edit_domain(
    slug: str,
    body: MemoryDomainWrite,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    require_enabled(settings)
    target = memory_slug(slug)
    if not any(
        entry["slug"] == target for entry in storage.memory_domains(username)
    ):
        raise HTTPException(404, "Domain not found")
    record = storage.upsert_memory_domain(
        username,
        {
            # The address never moves. Renaming the slug would break every
            # `[[link]]` and every stored `domain` on every page at once, and
            # the title is the part anyone actually reads.
            "slug": target,
            "title": body.title,
            "summary": body.summary,
            "origin": "reader",
            **({"position": body.position} if body.position is not None else {}),
        },
    )
    sync_domain_page(
        storage, username, slug=target, title=body.title, max_pages=settings.memory_max_pages
    )
    return record


@router.post("/domains/{slug}/compose")
def compose_domain_now(
    slug: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """
    The reader asked for a domain's page now, so its job does not wait to settle.

    A domain's job waits after each change to the domain so that a burst is
    one composition. This queues the job if nothing has, and makes it due at
    once. It runs nothing itself; the next drain claims it. A domain whose
    members are as its page was composed from, or that has too few for a
    page, costs no model call: the job says so and ends.
    """
    require_enabled(settings)
    target = memory_slug(slug)
    if not any(entry["slug"] == target for entry in storage.memory_domains(username)):
        raise HTTPException(404, "Domain not found")
    job = storage.enqueue_memory_job(username, **domain_job(target, settle_seconds=0))
    storage.release_memory_jobs(username, kind=DOMAIN, marker=job["marker"])
    return {"queued": job["marker"]}


@router.delete("/domains/{slug}", status_code=204)
def remove_domain(
    slug: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    require_enabled(settings)
    storage.delete_memory_domain(username, memory_slug(slug))


@router.post("/reorganize/stream")
async def reorganize_stream(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """Propose the same reader-reviewed moves without leaving the edge silent."""
    require_enabled(settings)
    if not settings.api_key:
        raise HTTPException(503, "No model provider is configured")
    account = await run_in_threadpool(storage.get_account, username) or {}
    use_standard_tier = bool(account.get("useStandardTier", True))
    request_id = uuid4().hex

    async def stream() -> AsyncIterator[str]:
        task: asyncio.Task[dict[str, Any]] | None = None
        try:
            # The proposal has no meaningful partial result, but an immediate
            # first byte and periodic progress keep Cloudflare from replacing a
            # healthy long model call with a 524 page.
            yield sse(
                {
                    "type": "progress",
                    "requestId": request_id,
                    "message": "Reviewing page placement…",
                }
            )
            timeout = httpx.Timeout(settings.memory_review_timeout_seconds, connect=20)
            async with httpx.AsyncClient(timeout=timeout) as client:
                task = asyncio.create_task(
                    propose_reorganization(
                        client,
                        storage,
                        username,
                        settings,
                        use_standard_tier=use_standard_tier,
                    )
                )
                while not task.done():
                    try:
                        await asyncio.wait_for(
                            asyncio.shield(task),
                            timeout=REORGANIZE_HEARTBEAT_SECONDS,
                        )
                    except TimeoutError:
                        yield sse(
                            {
                                "type": "progress",
                                "requestId": request_id,
                                "message": "Still comparing pages and domains…",
                            }
                        )
                proposal = await task
            yield sse({"type": "done", "requestId": request_id, **proposal})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Memory reorganization failed", exc_info=True)
            yield sse(
                {"type": "error", "requestId": request_id, "message": str(exc)}
            )
        finally:
            # Cloud Run must not inherit detached model work after the reader
            # closes the tab or navigates away.
            if task is not None and not task.done():
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

    return event_stream(stream())


@router.post("/pages/move")
def move_pages(
    body: MemoryPageMove,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """
    Re-file pages into a domain.

    Deliberately not `POST /pages/{slug}/domain`: a reorganization is one
    decision over many pages, and applied a page at a time it can stop halfway
    and leave the wiki in a shape the reader did not choose.
    """
    require_enabled(settings)
    moved = storage.move_memory_pages(username, body.slugs, body.domain)
    storage.append_memory_event(
        username,
        {
            "kind": "refile",
            "createdAt": utc_now(),
            "summary": (
                f"Moved {len(moved)} page{'' if len(moved) == 1 else 's'} into "
                f"{memory_slug(body.domain)}."
            ),
            "pages": [page["slug"] for page in moved],
        },
    )
    return {"pages": moved}


def compiled_from(
    storage: Storage, username: str, citations: list[dict[str, Any]], library: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """
    The documents a page was compiled from, grouped and named.

    Citations are stored per claim — one row per `[E1]` marker — which is the
    right shape for checking a locator and the wrong shape for a reader, who
    wants to know *which papers* this came from and roughly how much of each.
    So they are grouped by document here, with the passage count and the
    locators kept.

    One scan over the account rather than one per paper: a page cites a handful
    of documents and the alternative is a second index that can disagree with
    the record, which is the same call `resolve_account_paper` makes. The page
    read makes that scan once (`library`) for everything it names.

    A document that has since been deleted or moved out of reach comes back
    `available: false` rather than being dropped. Invariant 41 — provenance
    survives the paper — so the dangling citation is exactly what the reader
    should see, and it is what the lint pass already reports. It keeps the
    title its filings recorded (`filed_titles`), so the reader can still tell
    which document it was.
    """
    grouped: dict[str, dict[str, Any]] = {}
    for citation in citations:
        paper_id = citation.get("paperId")
        if not paper_id:
            continue
        entry = grouped.setdefault(
            paper_id,
            {
                "paperId": paper_id,
                "projectId": None,
                "title": None,
                "passages": 0,
                "pages": [],
                "sections": [],
                "available": False,
            },
        )
        entry["passages"] += 1
        page_number = citation.get("page")
        if isinstance(page_number, int) and page_number not in entry["pages"]:
            entry["pages"].append(page_number)
        section = citation.get("section")
        # A PDF's section is `page-12`, which the page number already says
        # better; only a web anchor is worth showing as one.
        if (
            isinstance(section, str)
            and section
            and not section.startswith("page-")
            and section not in entry["sections"]
        ):
            entry["sections"].append(section)
    if not grouped:
        return []
    for project in library:
        if all(entry["available"] for entry in grouped.values()):
            break
        for paper in project.get("papers", []):
            entry = grouped.get(paper["id"])
            if entry is None:
                continue
            entry["available"] = True
            entry["title"] = paper.get("title")
            entry["projectId"] = project["id"]
    gone = [paper_id for paper_id, entry in grouped.items() if not entry["available"]]
    for paper_id, title in filed_titles(storage, username, gone).items():
        grouped[paper_id]["title"] = title
    for entry in grouped.values():
        entry["pages"].sort()
        entry["sections"].sort()
    # Most-cited first: the document a page actually rests on should be the one
    # named at the top of the rail.
    return sorted(
        grouped.values(),
        key=lambda entry: (-entry["passages"], entry["title"] or entry["paperId"]),
    )


def filed_titles(storage: Storage, username: str, paper_ids: list[str]) -> dict[str, str]:
    """
    The title each document's filings recorded, newest first: how a document
    no longer in the library is still named. One read of the log's newest
    event per marker; a document whose filings predate the `title` key is
    absent.
    """
    if not paper_ids:
        return {}
    markers = {
        marker: paper_id
        for paper_id in paper_ids
        for marker in (*document_family(paper_id), session_marker(paper_id=paper_id))
    }
    titles: dict[str, tuple[str, str]] = {}
    for marker, event in storage.latest_marker_events(username, list(markers)).items():
        paper_id, at = markers[marker], str(event.get("createdAt") or "")
        if event.get("title") and at >= titles.get(paper_id, ("", ""))[0]:
            titles[paper_id] = (at, str(event["title"]))
    return {paper_id: title for paper_id, (_, title) in titles.items()}


def source_document(
    paper_id: str | None, sources: list[dict[str, Any]], library: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """
    Where a source page's document is now, or `projectId: null` when it is no
    longer in the library. From the page's sources when they name it, which
    already scanned the account.
    """
    if not paper_id:
        return None
    for source in sources:
        if source["paperId"] == paper_id:
            return {"paperId": paper_id, "projectId": source.get("projectId")}
    for project in library:
        if any(paper["id"] == paper_id for paper in project.get("papers", [])):
            return {"paperId": paper_id, "projectId": project["id"]}
    return {"paperId": paper_id, "projectId": None}


def with_captures_held(
    storage: Storage, username: str, citations: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """
    Each outside citation marked `captured: false` when its capture is gone,
    so the page shows it as text instead of a link that cannot open. Only a
    404 is gone: a read that failed for another reason leaves the link.
    """
    held: dict[str, bool] = {}
    for citation in citations:
        evidence_id = citation.get("evidenceId")
        if not evidence_id:
            continue
        if evidence_id not in held:
            try:
                storage.get_external_evidence(username, evidence_id)
                held[evidence_id] = True
            except HTTPException as error:
                held[evidence_id] = error.status_code != 404
        citation["captured"] = held[evidence_id]
    return citations


def citation_section_titles(
    objects: ObjectStore,
    username: str,
    citations: list[dict[str, Any]],
    sources: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Add digest section names without changing citation locators.

    Memory citations deliberately store a PDF page or a web anchor and
    nothing descriptive. The research digest already groups those same,
    validated evidence rows under readable headings. Join the two by evidence
    id when its locator agrees, falling back to a locator only when the digest
    gives that locator one unambiguous label. Missing and legacy digests simply
    leave the optional display field absent.
    """
    enriched = [dict(citation) for citation in citations]
    by_paper: dict[str, list[dict[str, Any]]] = {}
    for citation in enriched:
        paper_id = citation.get("paperId")
        if paper_id:
            by_paper.setdefault(paper_id, []).append(citation)

    for source in sources:
        paper_id = source["paperId"]
        project_id = source.get("projectId")
        if not project_id or paper_id not in by_paper:
            continue
        try:
            digest = load_digest(objects, username, project_id, paper_id)
        except (HTTPException, KeyError, TypeError, ValueError, json.JSONDecodeError):
            continue
        labels = digest_evidence_labels(str(digest.get("contentMarkdown") or ""))
        digest_citations = {
            item.get("id"): item for item in digest.get("citations") or ()
        }
        locator_labels: dict[tuple[int | None, str | None], set[str]] = {}
        for evidence_id, digest_citation in digest_citations.items():
            label = labels.get(evidence_id)
            if not label:
                continue
            locator = (
                digest_citation.get("page"),
                digest_citation.get("section"),
            )
            locator_labels.setdefault(locator, set()).add(label)

        for citation in by_paper[paper_id]:
            locator = (citation.get("page"), citation.get("section"))
            digest_citation = digest_citations.get(citation.get("id"))
            label = None
            if digest_citation and locator == (
                digest_citation.get("page"),
                digest_citation.get("section"),
            ):
                label = labels.get(citation["id"])
            if label is None:
                candidates = locator_labels.get(locator, set())
                if len(candidates) == 1:
                    label = next(iter(candidates))
            if label:
                citation["sectionTitle"] = label
    return enriched


@router.get("/pages/{slug}")
def read_page(
    slug: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    require_enabled(settings)
    page = storage.get_memory_page(username, memory_slug(slug))
    # Read once: sources, a source page's document and Written by all name documents.
    library = storage.list_projects_with_papers(username)
    sources = compiled_from(storage, username, page.get("citations") or [], library)
    page = dict(page)
    page["citations"] = with_captures_held(storage, username, citation_section_titles(
        objects, username, page.get("citations") or [], sources
    ))
    return {
        "page": page,
        # A wiki without backlinks is a pile of pages. This is the half a link
        # table exists for.
        "backlinks": storage.memory_backlinks(username, page["slug"]),
        # Citations resolved to the documents they name, so the rail can say
        # "DeepSeek R1 · 3 passages" instead of an opaque id.
        "sources": sources,
        # A source page's document, found by its id wherever it is filed now:
        # the Reader's address names the project, and a page never stores one.
        "document": source_document(page.get("sourcePaperId"), sources, library)
        if page.get("kind") == "source" else None,
        # Who wrote it, from the event log. A source page is its
        # document's (36f) and a domain page its members' (74).
        "authors": written_by(storage, username, page["slug"], library) if page.get("kind") == "concept" else [],
    }


@router.delete("/pages/{slug}", status_code=204)
def remove_page(
    slug: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    require_enabled(settings)
    page = storage.get_memory_page(username, memory_slug(slug))
    removed = storage.delete_memory_page(username, page["slug"])
    # A rewrite queued for the page has nothing left to rewrite (50).
    for job in storage.list_memory_jobs(username):
        if job["kind"] == "page-rewrite" and (job.get("payload") or {}).get("pageSlug") == page["slug"]:
            storage.clear_memory_job(username, job["marker"])
    # A document waiting to be asked about this page files as usual (`memory_same_document`).
    release_asked_about(storage, username, page["slug"])
    storage.append_memory_event(username, {
        "kind": "delete",
        "createdAt": utc_now(),
        "summary": f"Deleted {page['title']}.",
        "pages": [],
        "edits": [{"slug": page["slug"], "title": page["title"], "kind": page["kind"], "action": "deleted", "note": None}],
    })
    # Record first here, unusually, and deliberately: a page is what makes its
    # figures reachable, so an orphaned WebP is invisible and reapable while a
    # page whose figures were deleted first renders broken images.
    for key in removed.object_keys:
        objects.delete(key)
    reap_external_evidence(storage, objects, username, settings)


@router.get("/documents/{paper_id}/dependents")
def document_dependents(
    paper_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """The pages a reader deleting this document may remove with it."""
    require_enabled(settings)
    return {"pages": dependent_pages(storage, username, [paper_id], settings)}


@router.get("/projects/{project_id}/dependents")
def project_dependents(
    project_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """
    The pages a reader deleting this project may remove with it. Its documents
    go together, so a concept citing two of them is offered here though neither
    document's own delete offers it.
    """
    require_enabled(settings)
    papers = storage.get_project(username, project_id).get("papers") or ()
    # As the library rail lists them: the documents being read, then the finished ones.
    ordered = sorted(papers, key=lambda paper: bool(paper.get("doneAt")))
    return {"pages": dependent_pages(storage, username, [paper["id"] for paper in ordered], settings)}


def dependent_pages(storage: Storage, username: str, paper_ids: list[str], settings: Settings) -> list[dict]:
    """
    The source page of each document, and each concept written from one that
    cites no source outside them. A page that also cites another document or a
    captured web page stays, its citation dangling (41); Delphi's own inference
    names no source.
    """
    order = {paper_id: index for index, paper_id in enumerate(paper_ids)}
    offered = []
    for page in storage.list_memory_pages(username, kinds=["source", "concept"], limit=settings.memory_max_pages):
        if page.get("sourcePaperId") not in order:
            continue
        if page["kind"] == "concept":
            citations = storage.get_memory_page(username, page["slug"]).get("citations") or ()
            if any(item.get("claimType") != "derived" and item.get("paperId") not in order for item in citations):
                continue
        rank = order[page["sourcePaperId"]] if page["kind"] == "source" else len(order)
        offered.append((rank, {"slug": page["slug"], "title": page["title"], "kind": page["kind"]}))
    # The documents' own pages first, as the library lists them: they are what the reader is deleting.
    offered.sort(key=lambda item: item[0])
    return [page for _, page in offered]


@router.get("/figures/{figure_id}")
def read_figure(
    figure_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """
    Serve one captured figure. Owner only, and 404 for everyone else.

    These are pixels out of documents the reader added, held for their own
    recall. Modelled on `preview_chat_image`, including the private cache
    header: a shared cache holding a reader's figures would defeat the
    ownership check that just ran.
    """
    require_enabled(settings)
    figure = storage.get_memory_figure(username, figure_id)
    if not figure.get("objectKey"):
        # Capture failed for this one, so there are no bytes to serve. The page
        # renders its source URL instead; answering 404 is what tells it so.
        raise HTTPException(404, "That figure was kept as a link, not captured")
    key = figure["objectKey"]
    media_type = figure.get("mimeType") or (
        "image/svg+xml" if str(key).endswith(".svg") else "image/webp"
    )
    return StreamingResponse(
        objects.open_range(key),
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=3600"},
    )


def _filing_statuses(
    storage: Storage, username: str, projects: list[dict[str, Any]], only: set[str] | None = None
) -> dict[str, dict[str, Any]]:
    """`document_filing_status` for every document of the library, from two reads of the log."""
    papers = [
        paper for project in projects for paper in project.get("papers", [])
        if only is None or paper["id"] in only
    ]
    versions = storage.memory_event_versions(username, [document_marker(paper["id"]) for paper in papers])
    events = storage.latest_marker_events(
        username, [marker for paper in papers for marker in document_family(paper["id"])]
    )
    return {paper["id"]: document_filing_status(versions, paper, events) for paper in papers}


@router.get("/backfill/papers")
def backfill_candidates(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """
    Every document in the account, with the facts that decide what filing it
    costs and whether it is worth filing at all.

    `digestReady` because building a missing digest is a whole-document read,
    and the reader is owed that number before they start. `filed` because
    without it the client cannot tell work from a no-op. `stale` because a
    document filed by a pass Delphi has replaced is in Memory and was written
    by something that no longer exists. `dropped` because a document whose
    last job could not write a page it staged is current and still owed that
    page, and the press files it again.

    `document_filing_status` decides all of it, shared with `POST
    /backfill/papers`, `GET /documents/{id}/filing` and
    `delphi_core.backfill.memory`.

    One read of the library and two of the log, however many documents there
    are. Archived documents are included: a finished document leaves the
    working set for chat, not Memory. A document whose filing waits on the
    reader's answer is not: no press can file it (`memory_same_document`).
    """
    require_enabled(settings)
    projects = storage.list_projects_with_papers(username)
    statuses = _filing_statuses(storage, username, projects)
    asking = {job["payload"].get("paperId") for job in storage.list_memory_jobs(username) if waits_for_reader(job)}
    papers: list[dict[str, Any]] = []
    for project in projects:
        for paper in project.get("papers", []):
            if paper["id"] in asking:
                continue
            status = statuses[paper["id"]]
            papers.append(
                {
                    "projectId": project["id"],
                    "paperId": paper["id"],
                    "projectName": project.get("name") or "",
                    "title": paper.get("title") or paper.get("filename") or "Untitled",
                    "digestReady": digest_is_current(paper, settings),
                    "filed": status["filed"],
                    "filedVersion": status["filedVersion"],
                    "stale": status["stale"],
                    "dropped": status["dropped"],
                }
            )
    # Served, so no client spells the constant itself.
    return {"version": MEMORY_VERSION, "papers": papers}


@router.post("/backfill/papers")
def enqueue_backfill(
    body: MemoryBackfillRequest | None = None,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """
    Hand the library's backlog to the durable queue.

    Each document that is owed work becomes a `document` job with the leases,
    the retry schedule and the failure record every other job has, and the
    pump drains it. Nothing here runs the work; this route only writes rows.

    A document is owed work when it was never filed, when it was filed by a
    pass Delphi has replaced, or when its last job dropped a target. A
    document that is current and whole is skipped by its own stamp, so a press
    with nothing to do costs nothing.

    A document that needs filing has very often already been tried and
    failed, and an enqueue alone hands back the dead row. So a failed job is
    revived as well, exactly as `POST /maintenance/jobs/{id}/retry` does for
    one row: attempts back to zero.

    Every count is of documents now waiting, not of rows written, so pressing
    twice reports the same backlog. The four are disjoint.
    """
    require_enabled(settings)
    existing = {job["marker"]: job for job in storage.list_memory_jobs(username)}
    projects = storage.list_projects_with_papers(username)
    statuses = _filing_statuses(
        storage, username, projects, None if body is None else set(body.paperIds)
    )
    now = utc_now()
    queued = 0
    revived = 0
    upgraded = 0
    in_flight = 0
    for project in projects:
        for paper in project.get("papers", []):
            status = statuses.get(paper["id"])
            if status is None:
                continue
            again = status["stale"] or bool(status["dropped"])
            if status["filed"] and not again:
                continue
            marker = status["marker"]
            stalled = existing.get(marker)
            if stalled is not None and waits_for_reader(stalled):
                # Its question is the reader's to answer, in the document's card.
                continue
            if stalled is not None and not job_payload_is_upgradeable(stalled, now):
                # Leased and still running. Reported, so a press that changed
                # nothing because the work is in flight does not read as "your
                # library is up to date".
                in_flight += 1
                continue
            storage.enqueue_memory_job(
                username,
                kind="document",
                marker=marker,
                payload={"projectId": project["id"], "paperId": paper["id"]},
                target_version=MEMORY_VERSION,
            )
            if stalled is not None and stalled.get("status") == "failed":
                storage.retry_memory_job(username, stalled["id"])
                revived += 1
            elif again:
                upgraded += 1
            else:
                queued += 1
    # Update means now: a domain still settling after the last change is
    # composed in this run, behind the documents.
    storage.release_memory_jobs(username, kind=DOMAIN)
    return {
        "queued": queued,
        "revived": revived,
        "upgraded": upgraded,
        "inFlight": in_flight,
    }


@router.post("/pages/{slug}/rewrite")
def enqueue_page_rewrite(
    slug: str,
    body: MemoryPageRewriteRequest | None = None,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """Opt into the current authoring pass for one page, optionally saying why."""
    require_enabled(settings)
    page = storage.get_memory_page(username, slug)
    if page["kind"] != "concept":
        raise HTTPException(422, "Only a concept page can be rewritten in place")
    source_id = page.get("sourcePaperId")
    document = next(((project, paper) for project in storage.list_projects_with_papers(username)
                     for paper in project.get("papers", []) if paper["id"] == source_id), None)
    if document is None:
        raise HTTPException(409, "The source document is no longer available for a grounded rewrite")
    project, paper = document
    note = body.note if body else ""
    # The note is part of what this job *is*: the same words twice stay one job
    # that still recovers as `reused` (invariant 50), while different words are
    # different work. A note-free press keeps the marker it has always had.
    marker = f"page:{slug}:rewrite:{MEMORY_VERSION}:{page['revision']}"
    if note:
        marker += ":" + hashlib.sha256(note.encode()).hexdigest()[:12]
    job = storage.enqueue_memory_job(username, kind="page-rewrite", marker=marker,
        payload={"pageSlug": slug, "pageTitle": page["title"], "paperId": paper["id"], "projectId": project["id"],
                 **({"readerNote": note} if note else {})})
    if job["status"] == "failed":
        job = storage.retry_memory_job(username, job["id"])
    return job


@router.post("/lint")
def lint_route(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """Check Memory for pages that disagree. It reports and queues; it writes no page."""
    require_enabled(settings)
    if not settings.api_key:
        raise HTTPException(503, "No model provider is configured")
    account = storage.get_account(username) or {}
    use_standard_tier = bool(account.get("useStandardTier", True))
    request_id = uuid4().hex

    async def stream() -> AsyncIterator[str]:
        try:
            timeout = httpx.Timeout(settings.memory_review_timeout_seconds, connect=20)
            async with httpx.AsyncClient(timeout=timeout) as client:
                async for event in lint_memory(
                    client,
                    storage,
                    objects,
                    username,
                    settings,
                    use_standard_tier=use_standard_tier,
                ):
                    yield sse(_terminal(event, request_id))
        except Exception as exc:
            logger.warning("Memory lint failed", exc_info=True)
            yield sse({"type": "error", "requestId": request_id, "message": str(exc)})

    return event_stream(stream())


def _terminal(event: dict[str, Any], request_id: str) -> dict[str, Any]:
    """Turn the module's internal terminal event into the wire's `done`."""
    if event["type"] != "_memory_result":
        return {**event, "requestId": request_id}
    terminal = {
        "type": "done",
        "requestId": request_id,
        "pages": event.get("pages", []),
        "figures": event.get("figures", []),
        "method": event.get("method"),
        "reused": event.get("reused", False),
    }
    return terminal


