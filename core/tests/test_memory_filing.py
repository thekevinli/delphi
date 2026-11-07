"""
What queues a document's job, and what the job does when it is claimed.

Import queues one `document` job. Publishing a digest derives the document's
source page and queues the same job with the digest's fingerprint, unless the
last job already read that digest. A job claimed before the digest exists
builds it first. Real local stores, the real drain and the real pipeline; only
the provider is scripted.
"""

import json

import httpx
import pytest

from delphi_core.config import Settings
from delphi_core.memory import MEMORY_VERSION, document_filing_status
from delphi_core.memory_maintenance.jobs import document_family, document_fingerprint
from delphi_core.research_digest import generate_digest, load_digest
from delphi_core.routers import memory as routes
from delphi_core.storage import LocalObjectStore, LocalStorage, paper_key
from tests.helpers import ProviderTransport
from tests.test_memory_maintain import call, calls, cite, closing

MARKER = "paper:p1"
NOTHING = {"nothingToFile": True, "reason": "Memory already says all of this.", "pages": [], "needsOutside": None}
NEW_PAGE = {"nothingToFile": False, "reason": "No page explains rotation yet.", "pages": [], "needsOutside": None}
CREATE = {
    "title": "Rotary embedding", "aliases": [], "domain": "ml", "summary": "Position as a rotation.",
    "body": "## Rotary embedding\n\nPairs of dimensions are rotated by the position [N1].",
    "citations": [cite("N1", page=2)], "calculations": [], "note": "new page", "distinctFrom": [], "distinctReason": "",
}


def digest(text="The method rotates pairs of dimensions. [E1]"):
    return {
        "contentMarkdown": text,
        "citations": [{"id": 1, "claimType": "author-claim", "page": 2, "section": None}],
        "assets": [],
    }


class Library:
    """An account with one imported PDF whose text is stored and whose digest does not exist yet."""

    def __init__(self, tmp_path):
        self.settings = Settings(
            _env_file=None, data_dir=tmp_path, openai_api_key="test-key",
            openai_api_base_url="https://api.openai.test/v1",
        )
        self.storage = LocalStorage(self.settings)
        self.objects = LocalObjectStore(tmp_path)
        self.storage.create_account("reader", None, "salt", "hash")
        self.project = self.storage.create_project("reader", "Reading")["id"]
        self.storage.add_paper("reader", self.project, {
            "id": "p1", "title": "Rotary Position Embedding", "filename": "p.pdf", "pages": 2, "tokens": 20, "bytes": 100,
        })
        self.objects.put_text(
            paper_key("reader", self.project, "p1", "txt"),
            "--- Page 1 ---\n\nOrder matters.\n\n--- Page 2 ---\n\nPairs of dimensions are rotated by the position.",
        )
        self.storage.set_openai_file("reader", self.project, "p1", "file-p1")
        self.asked: list[str] = []
        self.digests = [digest()]
        self.select = NEW_PAGE

    def provider(self) -> httpx.AsyncClient:
        """Answers each request by what it is: a digest, a selection, a check, or a round of the agent."""
        rounds = [calls(call("create_memory", CREATE, "c1")), closing("Filed rotary embedding.")]

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            name = ((body.get("text") or {}).get("format") or {}).get("name") or "agent"
            self.asked.append(name)
            if name == "research_digest":
                written = self.digests.pop(0) if len(self.digests) > 1 else self.digests[0]
                frame = {"type": "response.output_text.delta", "delta": json.dumps(written)}
                return httpx.Response(200, content=f"data: {json.dumps(frame)}\n\n".encode())
            if name == "memory_file_selection":
                question_two = "Question two" in body["input"][-1]["content"]
                return self._json(NOTHING | {"nothingToFile": False} if question_two else self.select)
            if name == "memory_verdicts":
                return self._json({"objections": []})
            return httpx.Response(200, content=rounds.pop(0) if len(rounds) > 1 else rounds[0])

        return httpx.AsyncClient(transport=ProviderTransport(handler))

    @staticmethod
    def _json(answer: dict) -> httpx.Response:
        return httpx.Response(200, json={
            "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(answer)}]}],
            "usage": {"input_tokens": 50, "output_tokens": 5},
        })

    def jobs(self):
        """The queued document jobs. Writing a source page also queues its domain's own job."""
        return [job for job in self.storage.list_memory_jobs("reader") if job["kind"] == "document"]

    async def republish(self):
        async with self.provider() as client:
            async for _ in generate_digest(
                client, self.storage, self.objects, "reader", self.project, "p1", self.settings, force=True
            ):
                pass
        return load_digest(self.objects, "reader", self.project, "p1")

    async def drain(self, monkeypatch) -> list[dict]:
        """One `POST /maintenance/drain`, with the provider the route would have reached."""
        client = self.provider()
        with monkeypatch.context() as patched:
            patched.setattr(routes.httpx, "AsyncClient", lambda **_: client)
            response = routes.drain_memory_maintenance("reader", self.storage, self.objects, self.settings)
            frames = [frame async for frame in response.body_iterator]
        return [
            json.loads(line[len("data: "):])
            for frame in frames
            for line in (frame.decode() if isinstance(frame, bytes) else frame).splitlines()
            if line.startswith("data: ")
        ]


@pytest.mark.asyncio
async def test_a_document_job_claimed_before_its_digest_exists_makes_the_digest_and_then_files(tmp_path, monkeypatch):
    library = Library(tmp_path)
    # Import queued the job and nothing has read the document yet.
    assert [(job["kind"], job["marker"]) for job in library.jobs()] == [("document", MARKER)]
    assert "fingerprint" not in library.jobs()[0]["payload"]

    events = await library.drain(monkeypatch)

    stages = [event["stage"] for event in events if event.get("stage")]
    assert stages[0] == "digest_check" and any(stage.startswith("digest_") for stage in stages[1:])
    assert stages[-5:] == ["memory_gather", "memory_select", "memory_maintain", "memory_verify", "memory_commit"]
    assert library.asked[0] == "research_digest" and library.asked.count("research_digest") == 1
    done = events[-1]
    assert done["type"] == "done" and done["claimed"] and done["kind"] == "document" and done["marker"] == MARKER
    assert [page["slug"] for page in done["result"]["pages"]] == ["rotary-embedding"]
    assert done["result"]["reused"] is False

    # The digest it built is what it filed from, and publishing it gave the
    # document its source page without a model.
    stored = load_digest(library.objects, "reader", library.project, "p1")
    pages = {page["slug"]: page for page in library.storage.list_memory_pages("reader", limit=10)}
    assert pages["rotary-position-embedding"]["kind"] == "source"
    assert pages["rotary-position-embedding"]["sourcePaperId"] == "p1"
    assert pages["rotary-embedding"]["kind"] == "concept"
    event = library.storage.latest_marker_events("reader", [MARKER])[MARKER]
    assert (event["outcome"], event["fingerprint"], event["version"]) == (
        "filed", document_fingerprint(stored), MEMORY_VERSION)
    # One job throughout: the publish gave the claimed job its fingerprint, the
    # job read that digest, and so it completed and left the queue empty.
    assert library.jobs() == []


@pytest.mark.asyncio
async def test_a_digest_republish_queues_the_document_with_its_fingerprint_and_an_unchanged_one_does_not(
    tmp_path, monkeypatch
):
    library = Library(tmp_path)
    library.select = NOTHING
    await library.drain(monkeypatch)
    assert library.jobs() == []
    first = load_digest(library.objects, "reader", library.project, "p1")

    # The same digest again: the last job read exactly this, so nothing is queued.
    assert await library.republish() == first
    assert library.jobs() == []

    # A digest that says something else is new evidence: one job, carrying its hash.
    library.digests = [digest("The method rotates pairs, and the angle depends on position. [E1]")]
    second = await library.republish()
    assert second != first
    queued = library.jobs()
    assert [(job["kind"], job["marker"], job["status"]) for job in queued] == [("document", MARKER, "pending")]
    assert queued[0]["payload"] == {
        "projectId": library.project, "paperId": "p1", "fingerprint": document_fingerprint(second),
        "targetVersion": MEMORY_VERSION,
    }
    # And the source page follows the digest in the same request.
    page = library.storage.get_memory_page("reader", "rotary-position-embedding")
    assert "the angle depends on position" in page["body"]

    # Publishing it again before the job runs leaves the one job as it is.
    library.digests = [digest("The method rotates pairs, and the angle depends on position. [E1]")]
    await library.republish()
    assert [job["id"] for job in library.jobs()] == [queued[0]["id"]]

    # Once the job has read it, the same digest queues nothing more.
    await library.drain(monkeypatch)
    assert library.jobs() == []
    await library.republish()
    assert library.jobs() == []


@pytest.mark.asyncio
async def test_a_digest_that_changes_while_its_job_runs_keeps_the_job_for_another_pass(tmp_path):
    """The job completes against the fingerprint it read, not the one it was queued with."""
    library = Library(tmp_path)
    library.select = NOTHING
    read = await library.republish()
    job = library.storage.claim_memory_job(
        "reader", now="2026-10-13T00:00:00+00:00", lease_expires_at="2099-01-01T00:00:00+00:00", max_attempts=3
    )
    async with library.provider() as client:
        result = [event async for event in routes.run_maintenance_job(
            job, client=client, storage=library.storage, objects=library.objects, username="reader",
            settings=library.settings, use_standard_tier=True,
        )][-1]
    assert result["fingerprint"] == document_fingerprint(read)

    # A republish lands after the job read the digest and before the drain completes it.
    library.digests = [digest("A different account of the method. [E1]")]
    later = await library.republish()
    assert not library.storage.complete_memory_job("reader", job["id"], fingerprint=result["fingerprint"])
    kept = library.jobs()
    assert [(row["id"], row["status"], row["attempts"]) for row in kept] == [(job["id"], "pending", 0)]
    assert kept[0]["payload"]["fingerprint"] == document_fingerprint(later)


def test_filing_status_reports_what_the_documents_last_job_dropped(tmp_path):
    library = Library(tmp_path)
    storage, paper = library.storage, {"id": "p1"}
    dropped = {"slug": "rotary-embedding", "title": "Rotary embedding", "action": "create",
               "reason": "The passage does not say the angle grows.", "quote": "an angle that grows with position"}

    def status():
        family = document_family("p1")
        return document_filing_status(
            storage.memory_event_versions("reader", family[:1]), paper, storage.latest_marker_events("reader", family)
        )

    assert status() == {"filed": False, "filedVersion": None, "stale": False, "dropped": [], "marker": MARKER}

    # Every page dropped: the job failed, the marker is not settled, and the target is named.
    storage.append_memory_event("reader", {
        "kind": "document", "requestId": f"{MARKER}:dropped:1", "marker": MARKER, "outcome": "failed",
        "version": MEMORY_VERSION, "pages": [], "dropped": [{**dropped, "internal": "not served"}],
        "createdAt": "2026-10-13T00:00:01+00:00",
    })
    assert status() == {"filed": False, "filedVersion": None, "stale": False, "dropped": [dropped], "marker": MARKER}

    # A job that found nothing to file settles the marker.
    storage.append_memory_event("reader", {
        "kind": "document", "requestId": MARKER, "marker": MARKER, "outcome": "nothing", "version": "knowledge-v1",
        "pages": [], "dropped": [], "createdAt": "2026-10-13T00:00:02+00:00",
    })
    assert status() == {"filed": True, "filedVersion": "knowledge-v1", "stale": True, "dropped": [], "marker": MARKER}

    # The newest event of the document's markers speaks, a follow-up's included.
    storage.append_memory_event("reader", {
        "kind": "document", "requestId": f"{MARKER}:part:1", "marker": f"{MARKER}:part:1", "outcome": "filed",
        "version": MEMORY_VERSION, "pages": ["other"], "dropped": [dropped], "createdAt": "2026-10-13T00:00:03+00:00",
    })
    assert status()["dropped"] == [dropped]
    assert routes.document_filing_state("p1", username="reader", storage=storage, settings=library.settings) == {
        "filed": True, "queued": True, "stuck": False, "stale": True, "dropped": [dropped],
        "filedVersion": "knowledge-v1", "version": MEMORY_VERSION, "sameAs": None,
    }


@pytest.mark.asyncio
async def test_a_job_whose_pages_another_job_moved_on_goes_back_without_spending_an_attempt(tmp_path, monkeypatch):
    from delphi_core.memory_maintenance.jobs import STALE_RELEASES
    from delphi_core.memory_maintenance.run import StaleRevision

    library = Library(tmp_path)
    library.storage.enqueue_memory_job(
        "reader", kind="document", marker="paper:p1", payload={"projectId": library.project, "paperId": "p1"},
        target_version=MEMORY_VERSION,
    )

    async def moved_on(job, **_kw):
        raise StaleRevision(["rotary-embedding"])
        yield  # pragma: no cover

    monkeypatch.setattr(routes, "run_maintenance_job", moved_on)
    routes._STALE_SEEN.clear()
    for _ in range(STALE_RELEASES):
        frames = await library.drain(monkeypatch)
        error = next(frame for frame in frames if frame["type"] == "error")
        assert error["terminal"] is False
        (job,) = library.jobs()
        # Due at once, and the attempt the claim counted is given back.
        assert (job["status"], job["attempts"]) == ("pending", 0)
    # A job that keeps meeting other writers fails like any other.
    await library.drain(monkeypatch)
    (job,) = library.jobs()
    assert (job["status"], job["attempts"]) == ("failed", 1)
