"""
Why a Memory job failed, as one of a few causes a reader can act on.

The drain names the cause from the exception it caught (`failure_cause`) and
records it with the attempt (`attempt_diagnostics`), so no surface has to read
a cause back out of an error's wording. The wording stays on the row as
`lastError`, the technical detail behind the cause.

- `check`: the check refused every page the job wrote, so nothing was written.
- `answer`: the model's answer was cut off, could not be read, or failed its
  checks twice (the document's digest included).
- `provider`: the provider was busy, down, past a plan's limit, or too slow.
- `signin`: the provider refused the sign-in or key.
- `interrupted`: the work stopped under the job: Delphi quit or slept while it
  ran, or another job changed the pages it was writing.
- `document`: what the job files from could not be read, or Delphi's stored
  copy of it is missing.
- `unknown`: anything else, said by its technical detail alone.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

import httpx
from starlette.exceptions import HTTPException

from .harness.provider import ProviderError, Terminal
from .memory_maintenance.domain import AnswerRefused
from .memory_maintenance.gather import MissingEvidence
from .memory_maintenance.pipeline import EveryPageDropped
from .memory_maintenance.run import JobDeadline, StaleRevision
from .memory_maintenance.select import SelectionUnreadable
from .memory_maintenance.verify import UnreadableVerdicts
from .research_digest import DigestRejected

Cause = Literal["check", "answer", "provider", "signin", "interrupted", "document", "unknown"]
CAUSES: tuple[Cause, ...] = ("check", "answer", "provider", "signin", "interrupted", "document", "unknown")


def failure_cause(error: BaseException) -> Cause:
    """Which cause `error` is, from its type and status code and never its text."""
    if isinstance(error, EveryPageDropped):
        return "check"
    if isinstance(error, StaleRevision):
        return "interrupted"
    if isinstance(error, MissingEvidence):
        return "document"
    # A store's own 404: a file of the document's that Delphi no longer has.
    if isinstance(error, HTTPException):
        return "document" if error.status_code == 404 else "unknown"
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        if status in (401, 403):
            return "signin"
        # Busy, down, past a limit, or no longer holding a file it was given.
        if status in (404, 408, 429) or status >= 500:
            return "provider"
        return "unknown"
    if isinstance(error, (httpx.TransportError, TimeoutError, JobDeadline)):
        return "provider"
    if isinstance(error, (UnreadableVerdicts, AnswerRefused, SelectionUnreadable, DigestRejected)):
        return "answer"
    if isinstance(error, ProviderError):
        # A response the provider failed is its own; one cut off is the answer's.
        return "provider" if error.terminal is Terminal.FAILED else "answer"
    return "unknown"


def attempt_diagnostics(error: BaseException) -> dict[str, Any]:
    """
    What a failed durable attempt leaves on its job row.

    `rejection` is why it failed, always present and bounded, and `cause` is
    which of `CAUSES` that is. An error that carries `telemetry` (what the
    attempt cost) has it recorded beside them. The store dates the entry
    (`Storage.fail_memory_job`).
    """
    return {
        **(getattr(error, "telemetry", None) or {}),
        "rejection": str(error)[:800],
        "cause": failure_cause(error),
    }


def recorded_cause(job: Mapping[str, Any]) -> Cause | None:
    """
    The cause a failed job's last attempt recorded, or None for a job that has not failed.

    An attempt nobody reported is the queue's own failure (`claim_memory_job`
    gives up on a job that was claimed and abandoned too often), and it says
    so with `abandoned`. A row failed before causes were recorded is `unknown`.
    """
    if job.get("status") != "failed":
        return None
    telemetry = (job.get("payload") or {}).get("attemptTelemetry") or []
    last = telemetry[-1] if telemetry and isinstance(telemetry[-1], Mapping) else {}
    if last.get("abandoned"):
        return "interrupted"
    cause = last.get("cause")
    return cause if cause in CAUSES else "unknown"


def job_failure(job: Mapping[str, Any], event: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
    """
    What the reader is told about a failed job: its cause, when it failed, and
    for `check` the pages refused and why, from the event the job left
    (`latest_marker_events`).

    `failedAt` names this failure, so a reader who has read it is not shown it
    again when the row changes for another reason (`updatedAt` moves when a
    failed row is re-enqueued). The store records every failure as the last
    entry, dated; a row from before that has `updatedAt` instead.
    """
    cause = recorded_cause(job)
    if cause is None:
        return None
    telemetry = (job.get("payload") or {}).get("attemptTelemetry") or []
    last = telemetry[-1] if telemetry and isinstance(telemetry[-1], Mapping) else {}
    dropped = (event or {}).get("dropped") or () if cause == "check" else ()
    return {
        "cause": cause,
        "failedAt": last.get("failedAt") or job.get("updatedAt"),
        "pages": [{"title": item.get("title") or "", "reason": item.get("reason") or ""} for item in dropped],
    }
