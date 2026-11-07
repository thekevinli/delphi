"""
Queue one `document` job for every document Memory is owed, for every account that has one.

    backend/.venv/bin/python -m delphi_core.backfill.memory --dry-run  # what is owed, and why
    backend/.venv/bin/python -m delphi_core.backfill.memory            # queue the work
    backend/.venv/bin/python -m delphi_core.backfill.memory --drain    # and run it here
    backend/.venv/bin/python -m delphi_core.backfill.memory --user ada
    backend/.venv/bin/python -m delphi_core.backfill.memory --force --drain  # refile what is behind

Import queues each document's job itself, so this is the catch-up for a
library that is behind: a document that was never filed, and under `--force`
one filed by a pass Delphi has replaced or one whose last job dropped a page
it staged (`owed_documents`).

By default it **writes jobs only** and files nothing: the durable queue is the
mechanism the product already has, so the work inherits its leases, its
bounded retries and its idempotency. Re-running adds no row for a marker
already queued, and a document already filed is skipped by its event. A job
that had given up is revived, as the Update button does.

The pipeline answers `reused` only to the same job claimed twice. A new job is
a new operation and files the document again, so what is owed is decided here,
before anything is queued. `--force` costs one full job per document that is
behind and none for a document that is current. It does not imply `--drain`: a
queued job is run by whichever tab drains it.

`--drain` additionally runs the queued work here (`drain_account`), a few jobs
at a time. Worth it for a backlog: otherwise a browser drains it in the
foreground of whichever tab opens first. **It spends real money**: for each
job a selection, the agent's loop and a check, and first a digest where the
document has none that is current. Ctrl-C is safe: a claimed lease expires and
the job comes back.

Each job is reported as it ends, in the pipeline's own terms: `filed` with the
pages it created and edited, `nothing`, or `failed` with when it is due again,
and every target the checker made it drop with the reason.

Run `delphi_core.backfill.digests` first when digests are behind too. Publishing a
digest queues the document's job with the digest's fingerprint, this command
finds that job under the same marker and adds none, and the drain files the
document once.
"""

import argparse
import asyncio
import sys
import time
from collections import Counter
from collections.abc import Iterable, Mapping
from contextlib import aclosing
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from ..config import Settings
from ..memory import MEMORY_VERSION, document_filing_status, renewing_lease
from ..memory_failure import attempt_diagnostics
from ..memory_maintenance.jobs import STALE_RELEASES
from ..memory_maintenance.run import StaleRevision
from ..memory_maintenance.jobs import DOCUMENT, document_family, document_marker, read_marker
from ..routers.memory import MEMORY_RETRY_DELAYS, run_maintenance_job
from ..storage import MemoryJobGone, ObjectStore, Storage
from . import accounts, build_parser, documents, footer, open_stores

OUTCOMES = ("filed", "nothing", "failed")
#: The pipeline's stages in order, as its events' telemetry names them.
STAGES = ("select", "maintain", "verify")
#: One spelling for a token count, whichever stage recorded it.
_TOKENS = {
    "inputTokens": "inputTokens", "input_tokens": "inputTokens",
    "cacheReadTokens": "cacheReadTokens", "cached_tokens": "cacheReadTokens",
    "cacheWriteTokens": "cacheWriteTokens", "cache_write_tokens": "cacheWriteTokens",
    "outputTokens": "outputTokens", "output_tokens": "outputTokens",
    "reasoningTokens": "reasoningTokens", "reasoning_tokens": "reasoningTokens",
}


def owed_documents(storage: Storage, username: str, *, force: bool = False) -> list[dict[str, Any]]:
    """
    Every document that is owed a `document` job, with why.

    - `unfiled`: no job has settled its marker. Always owed.
    - `stale`: filed by a pass Delphi has replaced. Owed under `force`.
    - `dropped`: filed, and its last job dropped a page it staged. Owed under `force`.

    A document that is current and whole is owed nothing, which is what lets
    an interrupted run be started again without paying for what it already
    did. `document_filing_status` decides, as it does for the Update button.
    """
    found = list(documents(storage, username))
    versions = storage.memory_event_versions(
        username, [document_marker(paper["id"]) for _, paper in found]
    )
    events = storage.latest_marker_events(
        username, [marker for _, paper in found for marker in document_family(paper["id"])]
    )
    owed: list[dict[str, Any]] = []
    for project, paper in found:
        status = document_filing_status(versions, paper, events)
        if not status["filed"]:
            why = "unfiled"
        elif force and status["stale"]:
            why = "stale"
        elif force and status["dropped"]:
            why = "dropped"
        else:
            continue
        owed.append({
            "projectId": project["id"], "paperId": paper["id"], "marker": status["marker"],
            "title": f"{project['name']} / {paper.get('title') or paper['id']}",
            "why": why, "filedVersion": status["filedVersion"], "dropped": status["dropped"],
        })
    return owed


def _why(item: Mapping[str, Any]) -> str:
    if item["why"] == "stale":
        return f"filed by {item['filedVersion'] or 'an unversioned pass'}, now {MEMORY_VERSION}"
    if item["why"] == "dropped":
        return "its last job dropped " + ", ".join(str(target.get("title") or target.get("slug")) for target in item["dropped"])
    return "never filed"


def enqueue_account(
    storage: Storage, username: str, *, verbose: bool, force: bool = False, dry_run: bool = False
) -> int:
    """Queue one `document` job for each document `owed_documents` names. Returns how many."""
    owed = owed_documents(storage, username, force=force)
    waiting = {} if dry_run else {job["marker"]: job for job in storage.list_memory_jobs(username)}
    for item in owed:
        if not dry_run:
            storage.enqueue_memory_job(
                username,
                kind=DOCUMENT,
                marker=item["marker"],
                payload={"projectId": item["projectId"], "paperId": item["paperId"]},
                target_version=MEMORY_VERSION,
            )
            # An enqueue hands back the row that is already there, and a row
            # that gave up is never claimed again by itself.
            stalled = waiting.get(item["marker"])
            if stalled is not None and stalled.get("status") == "failed":
                storage.retry_memory_job(username, stalled["id"])
        if verbose:
            print(f"  · {'would file' if dry_run else 'queued'}: {item['title']} ({_why(item)})")
    return len(owed)


def stage_tokens(recorded: Mapping[str, Any] | None) -> dict[str, int]:
    """One stage's token counts under one spelling. The stages do not record them alike."""
    counted: Counter[str] = Counter()
    for name, value in (recorded or {}).items():
        if name in _TOKENS and isinstance(value, int):
            counted[_TOKENS[name]] += value
    return dict(counted)


def _dropped(event: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [{key: target.get(key) for key in ("slug", "title", "action", "reason")} for target in event.get("dropped") or ()]


def filing_summary(events: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """
    What a set of `document` jobs did, summed from the events they left (`memory_maintenance/event.py`).

    - `jobs` counts events by outcome, follow-ups and failed attempts included.
    - `documents` counts each document once, by the newest event of any of its
      markers, with `sourcePageOnly` for the documents no job wrote a page for.
    - `pages` are the pages the commits wrote, from the events' `edits`.
    - `dropped` is every target a job could not write, with its reason.
      `outstanding` says the drop is in the document's newest event, which is
      what `document_filing_status` reads: a later job that ran clean settles
      an earlier one's drops.
    - `advisory` counts the objections that did not block.
    - `telemetry` is tokens for each stage and the number of events that
      recorded any, with the agent's rounds and how its runs ended.

    Events of other kinds are ignored. No event records how long a stage took.
    """
    by_document: dict[str, list[Mapping[str, Any]]] = {}
    for event in sorted(
        (event for event in events if event.get("kind") == DOCUMENT),
        key=lambda event: str(event.get("createdAt") or ""),
    ):
        named = read_marker(str(event.get("marker") or ""))
        by_document.setdefault(str(event.get("paperId") or (named.paper_id if named else "")), []).append(event)

    jobs: Counter[str] = Counter()
    documents_by_outcome: Counter[str] = Counter()
    pages: Counter[str] = Counter()
    findings: Counter[str] = Counter()
    ended: Counter[str] = Counter()
    asked: Counter[str] = Counter()
    tokens = {stage: Counter() for stage in STAGES}
    advisory = rounds = source_page_only = 0
    dropped: list[dict[str, Any]] = []
    for paper_id, history in by_document.items():
        documents_by_outcome[str(history[-1].get("outcome") or "")] += 1
        source_page_only += not any(event.get("pages") for event in history)
        for event in history:
            jobs[str(event.get("outcome") or "")] += 1
            pages.update("created" if edit.get("action") == "created" else "edited" for edit in event.get("edits") or ())
            noted = event.get("advisory") or {}
            advisory += int(noted.get("count") or 0)
            findings.update(str(item.get("finding") or "unnamed") for item in noted.get("objections") or ())
            telemetry = event.get("telemetry") or {}
            for stage in STAGES:
                if telemetry.get(stage):
                    asked[stage] += 1
                    tokens[stage].update(stage_tokens(telemetry[stage]))
            rounds += int(telemetry.get("rounds") or 0)
            if telemetry.get("ended"):
                ended[str(telemetry["ended"])] += 1
            dropped += [
                {"paperId": paper_id, "marker": event.get("marker"), **target, "outstanding": event is history[-1]}
                for target in _dropped(event)
            ]
    return {
        "jobs": {name: jobs.get(name, 0) for name in OUTCOMES},
        "documents": {**{name: documents_by_outcome.get(name, 0) for name in OUTCOMES}, "sourcePageOnly": source_page_only},
        "pages": {"created": pages.get("created", 0), "edited": pages.get("edited", 0)},
        "dropped": dropped,
        # The findings are of the objections an event keeps in full, which is
        # at most `event.ADVISORY_KEPT` of each job's.
        "advisory": {"count": advisory, "byFinding": dict(sorted(findings.items()))},
        "telemetry": {
            **{stage: {"jobs": asked.get(stage, 0), **dict(tokens[stage])} for stage in STAGES},
            "rounds": rounds,
            "ended": dict(sorted(ended.items())),
        },
    }


def web_summary(events: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """
    What maintenance looked up outside the library, summed from the events'
    `outside` records (`memory_maintenance/gather_outside.py`): each kind of
    pass, how many ran and were replayed from frozen passes, the hosted calls
    they made, the pages captured, and what was dropped, by reason. Empty
    counts when web evidence was off.
    """
    passes: dict[str, Counter[str]] = {}
    reasons: Counter[str] = Counter()
    for event in events:
        for item in (event.get("outside") or {}).get("passes") or ():
            counted = passes.setdefault(str(item.get("task") or ""), Counter())
            counted["passes"] += 1
            counted["replayed"] += bool(item.get("replayed"))
            counted["searches"] += int(item.get("searches") or 0)
            counted["captured"] += len(item.get("captured") or ())
            counted["dropped"] += len(item.get("dropped") or ())
            reasons.update(str(dropped.get("reason") or "") for dropped in item.get("dropped") or ())
    return {"passes": {task: dict(counts) for task, counts in sorted(passes.items())}, "dropped": dict(sorted(reasons.items()))}


def describe_run(run: Mapping[str, Any]) -> str:
    """One finished job as a line: what it was for, how it ended, and what it wrote or could not."""
    said = str(run["marker"]) + (f" {run['title']}" if run.get("title") else "")
    outcome = run["outcome"]
    if outcome == "filed":
        said += f": filed ({run['created']} created, {run['edited']} edited)"
    elif outcome == "nothing":
        said += f": nothing ({run.get('summary') or 'nothing worth filing'})"
    elif outcome == "failed":
        again = f"due again at {run['retryAt']}" if run.get("retryAt") else "gave up"
        said += f": failed, attempt {run['attempts']}, {again}: {run.get('error')}"
    elif outcome == "reused":
        said += ": reused (this job had already committed)"
    elif outcome == "requeued":
        said += ": kept in the queue (its record changed while the job ran)"
    elif outcome == "asking":
        said += ": waits for the reader to say whether it is a document they deleted"
    elif outcome == "moved-on":
        said += f": run again at once, its attempt unspent (another job moved Memory on: {run.get('error')})"
    else:
        said += f": {outcome}"
    if run.get("dropped"):
        said += "\n      dropped: " + "; ".join(
            f"{target.get('title') or target.get('slug')} ({target.get('action')}): {target.get('reason')}"
            for target in run["dropped"]
        )
    return said


def _record_result(run: dict[str, Any], result: Mapping[str, Any]) -> None:
    """Read a pass's `_memory_result` into the job's record."""
    event = result.get("event") or {}
    if result.get("reused"):
        run["outcome"] = "reused"
    elif result.get("outcome"):
        run["outcome"] = result["outcome"]
    run["pages"] = [page.get("slug") for page in result.get("pages") or ()]
    edits = event.get("edits") or ()
    run["created"] = sum(1 for edit in edits if edit.get("action") == "created")
    run["edited"] = len(edits) - run["created"]
    run["dropped"] = _dropped(event)
    run["summary"] = str(event.get("summary") or "")


async def drain_account(
    storage: Storage,
    objects: ObjectStore,
    settings: Settings,
    username: str,
    *,
    verbose: bool,
    total: int = 0,
    workers: int | None = None,
) -> list[dict[str, Any]]:
    """
    Claim and run this account's due jobs until none is due. Returns one record for each job run.

    The same life a job has under `POST /maintenance/drain`. A job is claimed
    under a lease that is renewed while the work runs, and the work stops at
    the next stage if the lease is lost or the row is withdrawn. It is
    completed against the fingerprint the pass read, so a job whose record
    changed during the work stays queued and is run again. A failure is
    recorded with the route's backoff and the setting's attempt ceiling, and
    a page that moved on under the job (`StaleRevision`) is due again at once.

    Several lanes, because a job is mostly waiting on a model: what sets the
    wall clock of a whole library is how many of those waits overlap.
    `claim_memory_job` hands each caller a distinct row, so two lanes
    cannot take the same job. Bounded by `memory_drain_workers`, which is
    what stops one account's backlog becoming the whole provider budget.

    A record is `{marker, kind, title, outcome, created, edited, pages,
    dropped, summary, attempts, error, retryAt, seconds, stages}`. `outcome`
    is `filed`, `nothing` or `failed` for a `document` job, `reused` for one
    that had already committed, `requeued` for one kept because its record
    changed, `withdrawn` for one that was called off, and `done` for a job of
    another kind. `stages` is the seconds spent in each stage the pass
    announced, measured here because no event records time.
    """
    account = storage.get_account(username) or {}
    use_standard_tier = bool(account.get("useStandardTier", True))
    lanes = max(1, workers if workers is not None else settings.memory_drain_workers)
    lease_seconds = max(60.0, settings.memory_job_lease_seconds)
    titles = {paper["id"]: paper.get("title") or "" for _, paper in documents(storage, username)}
    runs: list[dict[str, Any]] = []
    #: Times each job was given back because Memory moved on under it (`STALE_RELEASES`).
    stale: dict[str, int] = {}

    def report(run: dict[str, Any]) -> None:
        runs.append(run)
        # Numbered against the jobs queued at the start. A job can queue
        # another (a follow-up, a domain's page), so the count may pass it.
        place = f"{len(runs)}/{total}" if total else "·"
        if run["outcome"] == "failed":
            print(f"  ! {place} {describe_run(run)}", file=sys.stderr, flush=True)
        elif verbose:
            print(f"  · {place} {describe_run(run)}", flush=True)

    async def lane() -> None:
        while True:
            now = datetime.now(UTC)
            job = storage.claim_memory_job(
                username,
                now=now.isoformat(),
                lease_expires_at=(now + timedelta(seconds=lease_seconds)).isoformat(),
                max_attempts=settings.memory_job_max_attempts,
            )
            if job is None:
                # The backlog is done, so nothing more will change a domain in
                # this run: the pages that were settling are composed now.
                if storage.release_memory_jobs(username, kind="domain"):
                    continue
                return
            payload = job.get("payload") or {}
            started = time.monotonic()
            run: dict[str, Any] = {
                "marker": job["marker"], "kind": job["kind"], "title": titles.get(payload.get("paperId") or "", ""),
                "outcome": "done", "created": 0, "edited": 0, "pages": [], "dropped": [], "summary": "",
                "attempts": int(job.get("attempts") or 1), "error": None, "retryAt": None, "stages": {},
            }
            read_fingerprint: str | None = payload.get("fingerprint")
            stage: str | None = None
            entered = started

            def leave_stage() -> None:
                if stage:
                    run["stages"][stage] = round(run["stages"].get(stage, 0.0) + time.monotonic() - entered, 3)

            def failed(error: Exception) -> None:
                """Record a failure: due again after the backoff, or at once for a page that moved on."""
                attempts = run["attempts"]
                retry_at = None
                if attempts < settings.memory_job_max_attempts:
                    delay = 0 if isinstance(error, StaleRevision) else MEMORY_RETRY_DELAYS[
                        min(attempts, len(MEMORY_RETRY_DELAYS)) - 1
                    ]
                    retry_at = (datetime.now(UTC) + timedelta(seconds=delay)).isoformat()
                try:
                    storage.fail_memory_job(
                        username,
                        job["id"],
                        error=str(error),
                        retry_at=retry_at,
                        diagnostics=attempt_diagnostics(error),
                        expected_lease_expires_at=expiry,
                    )
                except Exception:
                    # The row was withdrawn while the job failed. The failure is still reported.
                    retry_at = None
                # A job whose every page was dropped left an event that says which.
                last = storage.latest_marker_events(username, [job["marker"]]).get(job["marker"]) or {}
                if last.get("outcome") == "failed":
                    run["dropped"] = _dropped(last)
                run.update(outcome="failed", error=str(error), retryAt=retry_at)

            stood_down = False
            # Every write to the row names the lease it was claimed under, so
            # a lane that lost its claim cannot complete or fail its successor's.
            expiry = job.get("leaseExpiresAt")
            try:
                timeout = httpx.Timeout(settings.memory_review_timeout_seconds, connect=20)
                async with (
                    renewing_lease(storage, username, job, settings) as lease,
                    httpx.AsyncClient(timeout=timeout) as client,
                    aclosing(run_maintenance_job(
                        job,
                        client=client,
                        storage=storage,
                        objects=objects,
                        username=username,
                        settings=settings,
                        use_standard_tier=use_standard_tier,
                    )) as events,
                ):
                    try:
                        async for event in events:
                            if event.get("stage") != stage:
                                leave_stage()
                                stage, entered = event.get("stage"), time.monotonic()
                                if lease.lost or not storage.memory_job_exists(username, job["id"]):
                                    stood_down = True
                                    break
                            if event["type"] == "_memory_result":
                                read_fingerprint = event.get("fingerprint") or read_fingerprint
                                _record_result(run, event)
                            elif event["type"] == "_memory_waiting":
                                run["outcome"] = "asking"
                            elif verbose and event.get("type") == "progress":
                                print(f"    {job['marker']} {str(event.get('message') or '')}", flush=True)
                    except MemoryJobGone:
                        stood_down = True
                    finally:
                        leave_stage()
                        expiry = lease.expiry
                if stood_down:
                    run["outcome"] = "withdrawn"
                elif run["outcome"] == "asking":
                    # Handed back unspent; the row keeps its question for the reader's card.
                    storage.release_memory_job(username, job["id"], expected_lease_expires_at=expiry)
                # Only after the event is durable, so a process that dies
                # between the two writes is answered `reused` and files nothing twice.
                elif not storage.complete_memory_job(
                    username, job["id"], expected_lease_expires_at=expiry, fingerprint=read_fingerprint
                ):
                    run["outcome"] = "requeued"
            except StaleRevision as error:
                # Another job moved Memory on under this one: no fault of the job, so it is
                # given back with its attempt unspent and is due again at once.
                stale[job["id"]] = stale.get(job["id"], 0) + 1
                if stale[job["id"]] > STALE_RELEASES:
                    failed(error)
                else:
                    storage.release_memory_job(username, job["id"], expected_lease_expires_at=expiry)
                    run.update(outcome="moved-on", error=str(error))
            except Exception as error:
                failed(error)
            run["seconds"] = round(time.monotonic() - started, 3)
            report(run)
            # A failed job is claimable again only once `retryAt` has passed,
            # so the lane moves on and ends. One due at once is tried again
            # here, and the attempt ceiling bounds that.

    await asyncio.gather(*(lane() for _ in range(lanes)))
    return runs


def tally(runs: Iterable[Mapping[str, Any]]) -> str:
    """The closing lines of a drain: document jobs by how they ended, pages written, targets dropped."""
    runs = list(runs)
    filed = [run for run in runs if run["kind"] == DOCUMENT]
    counted = Counter(run["outcome"] for run in filed)
    said = [f"{counted.get(name, 0)} {name}" for name in OUTCOMES]
    said += [f"{count} {name}" for name, count in sorted(counted.items()) if name not in OUTCOMES]
    lines = [
        "document jobs: " + " · ".join(said),
        f"pages: {sum(run['created'] for run in filed)} created · {sum(run['edited'] for run in filed)} edited"
        f" · {sum(len(run['dropped']) for run in filed)} targets dropped",
    ]
    others = len(runs) - len(filed)
    if others:
        lines.append(f"{others} other jobs run")
    return "\n".join(lines)


async def run(args: argparse.Namespace) -> int:
    settings, storage, objects = open_stores()
    verbose = not args.quiet

    if not settings.memory_enabled:
        print("Memory is turned off on this server.", file=sys.stderr)
        return 2
    drain = bool(args.drain) and not args.dry_run
    if drain and not settings.api_key:
        print("No API key is configured; draining needs one.", file=sys.stderr)
        return 2

    queued = 0
    runs: list[dict[str, Any]] = []
    for username in accounts(storage, args):
        queued += enqueue_account(
            storage,
            username,
            verbose=verbose,
            force=args.force,
            dry_run=args.dry_run,
        )
        if drain:
            runs += await drain_account(
                storage,
                objects,
                settings,
                username,
                verbose=verbose,
                # The listing Settings shows, read once before the drain starts.
                total=len(storage.list_memory_jobs(username)),
            )
    behind = "never filed, stale or with a dropped target" if args.force else "never filed"
    if args.dry_run:
        summary = f"{queued} documents to file at {MEMORY_VERSION} ({behind})"
    else:
        summary = f"{queued} documents queued for {MEMORY_VERSION} ({behind})"
        if not drain:
            summary += "; readers' own tabs will drain them"
    if drain:
        summary += "\n" + tally(runs)
    return footer(storage, summary)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser(
        __doc__,
        dry_run="report which documents are owed a job and why; write nothing",
        force=(
            "also queue the documents filed by a pass Delphi has replaced and the ones "
            "whose last job dropped a target. A document that is current is still skipped. "
            "Add --drain to run the work here rather than leaving it to readers' tabs"
        ),
    )
    parser.add_argument(
        "--drain",
        action="store_true",
        help="also run the queued work now instead of leaving it to a reader's tab",
    )
    return asyncio.run(run(parser.parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
