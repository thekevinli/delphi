"""
Why a Memory job failed: the cause each error is, what an attempt records, and
what the maintenance route tells the reader about every failed job.

The route cases run the real drain, against the journey rig's fixture as the
provider (`tests/rig_library.py`) or with the pass replaced by one that raises.
"""

import json

import httpx
import pytest
from fastapi import HTTPException

from delphi_core.harness.provider import ProviderError, Terminal
from delphi_core.memory_maintenance.domain import AnswerRefused
from delphi_core.memory_failure import (
    CAUSES,
    attempt_diagnostics,
    failure_cause,
    job_failure,
    recorded_cause,
)
from delphi_core.memory_maintenance.gather import MissingEvidence
from delphi_core.memory_maintenance.pipeline import EveryPageDropped
from delphi_core.memory_maintenance.run import JobDeadline, StaleRevision
from delphi_core.memory_maintenance.select import SelectionUnreadable
from delphi_core.memory_maintenance.verify import UnreadableVerdicts
from delphi_core.research_digest import DigestRejected

from delphi_core_testkit.conformance.memory_routes import signed_in

from tests.rig_library import Rig


pytestmark = pytest.mark.kb_maintenance


def refused(status: int) -> httpx.HTTPStatusError:
    """What httpx raises for a provider that answered `status`."""
    request = httpx.Request("POST", "https://provider.test/v1/responses")
    response = httpx.Response(status, request=request)
    return httpx.HTTPStatusError(f"Error '{status}' for url '{request.url}'", request=request, response=response)


@pytest.mark.parametrize(
    ("error", "cause"),
    [
        (EveryPageDropped("Muon optimizer: stronger than the source"), "check"),
        (ProviderError("The filing was cut off before it finished (max_output_tokens)", Terminal.INCOMPLETE), "answer"),
        (ProviderError("The filing ended before the provider said it was finished", Terminal.ENDED), "answer"),
        (UnreadableVerdicts("it has no list of objections"), "answer"),
        (AnswerRefused("the correction was refused too"), "answer"),
        (SelectionUnreadable("The selection did not answer in JSON"), "answer"),
        # The digest a document job builds first fails the same ways.
        (DigestRejected("Digest Markdown must contain evidence markers"), "answer"),
        (ProviderError("Digest response ended without a result", Terminal.ENDED), "answer"),
        (ProviderError("Digest response failed", Terminal.FAILED), "provider"),
        (ProviderError("server_error", Terminal.FAILED), "provider"),
        (refused(429), "provider"),
        (refused(503), "provider"),
        (refused(524), "provider"),
        (refused(404), "provider"),
        (httpx.ReadTimeout("The read operation timed out"), "provider"),
        (httpx.ConnectError("Connection refused"), "provider"),
        (TimeoutError(), "provider"),
        (JobDeadline("deadline: the agent ran out of time with nothing staged"), "provider"),
        (refused(401), "signin"),
        (refused(403), "signin"),
        (StaleRevision(["position-encoding"]), "interrupted"),
        (MissingEvidence("Document 'p1' has no research digest to file from"), "document"),
        (HTTPException(404, "Extracted text is unavailable"), "document"),
        (HTTPException(500, "Could not write the page"), "unknown"),
        (refused(400), "unknown"),
        (RuntimeError("the notes paper:p1 filed could not be stamped"), "unknown"),
    ],
)
def test_each_error_is_one_cause(error, cause):
    assert failure_cause(error) == cause


def test_a_cause_is_read_from_the_error_and_never_from_its_wording():
    """A page title or a checker's sentence can say anything; neither moves a failure."""
    assert failure_cause(RuntimeError("Client error '429 Too Many Requests'")) == "unknown"
    assert failure_cause(EveryPageDropped("Rate limits: 401 Unauthorized is not in the passage")) == "check"


def test_a_failed_attempt_records_why_and_which_cause_that_is():
    """Bounded, with whatever its error carried beside it; the store dates it."""
    plain = attempt_diagnostics(ValueError("page 'x' was truncated"))
    assert plain == {"rejection": "page 'x' was truncated", "cause": "unknown"}

    class Costly(ProviderError):
        telemetry = {"callCount": 2}

    costly = attempt_diagnostics(Costly("no limitation " * 200, Terminal.INCOMPLETE))
    assert costly == {"callCount": 2, "rejection": ("no limitation " * 200)[:800], "cause": "answer"}


def failed(*telemetry: dict, status: str = "failed") -> dict:
    return {"status": status, "marker": "paper:p1", "updatedAt": "2026-10-30T09:00:00Z",
            "payload": {"attemptTelemetry": list(telemetry)}}


def test_a_failed_job_is_told_by_its_last_attempt():
    assert recorded_cause(failed({"cause": "provider"}, status="pending")) is None
    assert recorded_cause(failed({"cause": "provider"}, {"cause": "signin"})) == "signin"
    # Claimed and abandoned until the queue gave up on it: whatever failed earlier,
    # the attempt that ended it was interrupted.
    assert recorded_cause(failed({"cause": "provider"}, {"rejection": "never finished", "abandoned": True})) == "interrupted"
    # Failed before causes were recorded, or with one this build does not know.
    assert recorded_cause(failed({"rejection": "Filing failed"})) == "unknown"
    assert recorded_cause(failed({"cause": "gremlins"})) == "unknown"
    assert recorded_cause(failed()) == "unknown"
    assert set(CAUSES) == {"check", "answer", "provider", "signin", "interrupted", "document", "unknown"}


def test_only_a_check_failure_carries_the_pages_its_event_dropped():
    event = {"dropped": [{"slug": "muon", "title": "Muon optimizer", "action": "create",
                          "reason": "Stronger than the source.", "quote": "q", "body": "…"}]}
    at = "2026-10-30T08:00:00Z"
    assert job_failure(failed({"cause": "check", "failedAt": at}), event) == {
        "cause": "check", "failedAt": at, "pages": [{"title": "Muon optimizer", "reason": "Stronger than the source."}]}
    assert job_failure(failed({"cause": "provider", "failedAt": at}), event)["pages"] == []
    assert job_failure(failed({"cause": "check", "failedAt": at}), None)["pages"] == []
    assert job_failure(failed({"cause": "check"}, status="leased"), event) is None


def test_a_failure_is_dated_by_its_attempt_and_a_row_from_before_by_its_update():
    assert job_failure(failed({"cause": "signin", "failedAt": "2026-10-30T08:00:00Z"}))["failedAt"] == "2026-10-30T08:00:00Z"
    assert job_failure(failed({"rejection": "Filing failed"}))["failedAt"] == "2026-10-30T09:00:00Z"
    # A failure recorded without a cause is still its own entry: it is not
    # told, or dated, by the attempt before it.
    later = failed({"cause": "signin", "failedAt": "2026-10-30T08:00:00Z"},
                   {"rejection": "terminal", "failedAt": "2026-10-30T09:30:00Z"})
    assert job_failure(later) == {"cause": "unknown", "failedAt": "2026-10-30T09:30:00Z", "pages": []}


def frames(response) -> list[dict]:
    assert response.status_code == 200, response.text
    return [json.loads(line.removeprefix("data: ")) for line in response.text.splitlines() if line.startswith("data: ")]


def document(snapshot: dict) -> dict:
    """The document job of a maintenance snapshot."""
    (job,) = [job for job in snapshot["jobs"] if job["kind"] == "document"]
    return job


def test_the_maintenance_route_says_why_each_job_stopped(tmp_path, monkeypatch):
    """
    Through the real drain: a document whose every page the check refused
    names those pages; one the provider refused the sign-in for says so; one
    abandoned until the queue gave up on it was interrupted.
    """
    rig = Rig(tmp_path, monkeypatch, memory_drain_workers=1, memory_job_max_attempts=3)
    rig.refuse("aaaaaaaaaaa5", "Refused Study")
    with signed_in(rig.settings, rig.storage, rig.objects) as client:
        done = frames(client.post("/api/memory/maintenance/drain"))
        assert [frame["type"] for frame in done if frame["type"] in ("error", "done")] == ["error"]
        listed = client.get("/api/memory/maintenance").json()
    assert listed["maxAttempts"] == 3
    job = document(listed)
    assert (job["status"], job["attempts"], job["retryAt"] is not None) == ("failed", 1, True)
    assert job["failure"]["cause"] == "check"
    assert [page["title"] for page in job["failure"]["pages"]] == ["Prefix reuse aaaaaaaaaaa5"]
    assert job["failure"]["pages"][0]["reason"].startswith("The document reports one comparison")

    # The same document, now refused at the door.
    async def signed_out(job, **_kw):
        raise refused(401)
        yield  # pragma: no cover

    monkeypatch.setattr("delphi_core.routers.memory.run_maintenance_job", signed_out)
    rig.storage.retry_memory_job("reader", job["id"])
    with signed_in(rig.settings, rig.storage, rig.objects) as client:
        frames(client.post("/api/memory/maintenance/drain"))
        job = document(client.get("/api/memory/maintenance").json())
    assert (job["failure"]["cause"], job["failure"]["pages"]) == ("signin", [])
    assert "401" in job["lastError"]

    # Re-enqueued while failed (a republished digest refreshes the row's
    # payload): the row moves on, but the failure is the same one.
    signin = job["failure"]["failedAt"]
    rig.storage.enqueue_memory_job(
        "reader", kind="document", marker=job["marker"], payload={"fingerprint": "republished"})
    with signed_in(rig.settings, rig.storage, rig.objects) as client:
        moved = document(client.get("/api/memory/maintenance").json())
    assert moved["updatedAt"] != job["updatedAt"]
    assert moved["failure"]["failedAt"] == signin

    # Claimed three times and never reported: the third claim's lease runs out.
    rig.storage.retry_memory_job("reader", job["id"])
    for minute in (0, 5, 10, 15):
        rig.storage.claim_memory_job(
            "reader", now=f"2100-01-01T00:{minute:02d}:00+00:00",
            lease_expires_at=f"2100-01-01T00:{minute + 1:02d}:00+00:00", max_attempts=3,
        )
    with signed_in(rig.settings, rig.storage, rig.objects) as client:
        job = document(client.get("/api/memory/maintenance").json())
    assert (job["status"], job["retryAt"]) == ("failed", None)
    assert (job["failure"]["cause"], job["failure"]["pages"]) == ("interrupted", [])
    assert job["failure"]["failedAt"] > signin


def test_a_digest_the_document_job_could_not_build_is_the_answer_it_gave(tmp_path, monkeypatch):
    """A document job builds the document's digest before it files; its failures are named too."""
    rig = Rig(tmp_path, monkeypatch, memory_drain_workers=1, memory_job_max_attempts=3)
    rig.pdf("aaaaaaaaaaa1", "Cache paper")

    async def rejected(*_args, **_kw):
        raise DigestRejected("Digest Markdown must contain evidence markers")
        yield  # pragma: no cover

    monkeypatch.setattr("delphi_core.routers.memory.digest_is_current", lambda *_args: False)
    monkeypatch.setattr("delphi_core.routers.memory.generate_digest", rejected)
    with signed_in(rig.settings, rig.storage, rig.objects) as client:
        frames(client.post("/api/memory/maintenance/drain"))
        job = document(client.get("/api/memory/maintenance").json())
    assert job["status"] == "failed"
    assert job["failure"]["cause"] == "answer"
    assert job["lastError"] == "Digest Markdown must contain evidence markers"


def test_a_job_that_has_not_failed_has_no_failure(tmp_path, monkeypatch):
    rig = Rig(tmp_path, monkeypatch)
    rig.pdf("aaaaaaaaaaa1", "Cache paper")
    with signed_in(rig.settings, rig.storage, rig.objects) as client:
        job = document(client.get("/api/memory/maintenance").json())
    assert (job["status"], job["failure"]) == ("pending", None)
