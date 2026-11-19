"""
A document added while a deleted document's page is kept: Delphi asks before using that page.

The real drain and pipeline on local stores, as `test_memory_filing.py` runs
them; only the provider is scripted, and it answers the same-document check too.
"""

import json
from types import SimpleNamespace

import httpx
import pytest

from delphi_core.backfill import memory as catch_up
from delphi_core.memory_same_document import WAITS_FOR_READER, deleted_marker, note_deleted
from delphi_core.routers.memory import maintenance_snapshot
from delphi_core.storage import utc_now
from delphi_core.storage.base import job_is_due
from delphi_core_testkit.conformance.memory_routes import signed_in

from tests.helpers import ProviderTransport
from tests.test_memory_filing import Library

pytestmark = pytest.mark.kb_maintenance

KEPT = "rotary-position-embedding"


class Rig(Library):
    """The filing rig, whose provider also says which kept page a document is (`same`),
    having first done whatever else happens while it is asked (`during`)."""

    def __init__(self, tmp_path, same=None, during=None):
        super().__init__(tmp_path)
        self.same = same
        self.during = during

    def provider(self) -> httpx.AsyncClient:
        rest = super().provider()._transport.handler

        def handler(request: httpx.Request) -> httpx.Response:
            if ((json.loads(request.content).get("text") or {}).get("format") or {}).get("name") == "same_document":
                self.asked.append("same_document")
                if self.during:
                    self.during(self)
                return self._json({"slug": self.same})
            return rest(request)

        return httpx.AsyncClient(transport=ProviderTransport(handler))

    def keep(self, title="Rotary Position Embedding", slug=KEPT):
        """A source page whose document the reader deleted, keeping the page."""
        self.storage.upsert_memory_page("reader", {
            "slug": slug, "kind": "source", "domain": "ml", "title": title, "summary": "Position as a rotation.",
            "body": "The deleted copy's digest.", "sourcePaperId": "gone",
        }, max_pages=50)

    def sources(self):
        return sorted((page["slug"], page["sourcePaperId"]) for page in self.storage.list_memory_pages("reader", kinds=["source"]))

    def filing(self):
        with signed_in(self.settings, self.storage, self.objects) as client:
            return client.get("/api/memory/documents/p1/filing").json()

    def answer(self, use):
        with signed_in(self.settings, self.storage, self.objects) as client:
            return client.post("/api/memory/documents/p1/same-as", json={"use": use})


@pytest.mark.asyncio
async def test_a_document_titled_like_a_kept_page_waits_for_the_reader_and_writes_nothing(tmp_path, monkeypatch):
    library = Rig(tmp_path)
    library.keep()

    await library.drain(monkeypatch)

    # Its digest is written, and nothing else: no page of its own, the kept page untouched, nothing filed.
    assert library.sources() == [(KEPT, "gone")]
    assert library.storage.get_memory_page("reader", KEPT)["body"] == "The deleted copy's digest."
    assert library.asked == ["research_digest"]
    [job] = library.jobs()
    assert (job["status"], job["payload"]["sameAs"], job["retryAt"]) == ("pending", KEPT, WAITS_FOR_READER)
    assert not job_is_due(job, utc_now())
    filing = library.filing()
    assert (filing["sameAs"], filing["queued"]) == ({"slug": KEPT, "title": "Rotary Position Embedding", "deletedAt": None}, False)
    # A question, not work in line: nothing counts it as filing or offers to stop it.
    snapshot = maintenance_snapshot(library.storage, "reader")
    assert [job for job in snapshot["jobs"] if job["kind"] == "document"] == [] and snapshot["cancellable"] == 0

    # Until the reader answers, draining claims nothing and asks nothing.
    await library.drain(monkeypatch)
    assert library.asked == ["research_digest"]


@pytest.mark.asyncio
async def test_use_that_page_rewrites_the_kept_page_for_this_document_and_files_the_rest(tmp_path, monkeypatch):
    library = Rig(tmp_path)
    library.keep()
    await library.drain(monkeypatch)

    assert library.answer(True).status_code == 200

    page = library.storage.get_memory_page("reader", KEPT)
    assert (page["sourcePaperId"], page["domain"], page["body"]) == ("p1", "ml", library.digests[0]["contentMarkdown"])
    assert library.sources() == [(KEPT, "p1")]
    assert library.filing()["sameAs"] is None
    await library.drain(monkeypatch)
    assert "memory_file_selection" in library.asked and library.jobs() == []
    assert library.answer(True).status_code == 409


@pytest.mark.asyncio
async def test_keep_separate_gives_the_document_its_own_page_and_leaves_the_kept_one(tmp_path, monkeypatch):
    library = Rig(tmp_path)
    library.keep()
    await library.drain(monkeypatch)

    assert library.answer(False).status_code == 200

    assert library.sources() == [(KEPT, "gone"), (f"{KEPT}-p1", "p1")]
    assert library.storage.get_memory_page("reader", KEPT)["body"] == "The deleted copy's digest."
    await library.drain(monkeypatch)
    assert library.jobs() == []


@pytest.mark.asyncio
async def test_a_kept_page_titled_otherwise_is_asked_about_only_when_the_check_names_it(tmp_path, monkeypatch):
    library = Rig(tmp_path, same="rope-journal")
    library.keep(title="RoPE, the journal version", slug="rope-journal")

    await library.drain(monkeypatch)

    assert library.asked == ["research_digest", "same_document"]
    assert [job["payload"]["sameAs"] for job in library.jobs()] == ["rope-journal"]


@pytest.mark.asyncio
async def test_a_check_that_names_no_kept_page_files_as_usual(tmp_path, monkeypatch):
    library = Rig(tmp_path, same=None)
    library.keep(title="Attention Is All You Need", slug="attention")

    await library.drain(monkeypatch)

    assert library.asked[:2] == ["research_digest", "same_document"]
    assert library.sources() == [("attention", "gone"), ("rotary-position-embedding", "p1")]
    assert library.jobs() == []


@pytest.mark.asyncio
async def test_a_check_naming_a_page_that_is_not_kept_files_as_usual(tmp_path, monkeypatch):
    library = Rig(tmp_path, same="attention")
    library.keep(title="RoPE, the journal version", slug="rope-journal")

    await library.drain(monkeypatch)

    assert library.sources() == [("rope-journal", "gone"), ("rotary-position-embedding", "p1")]
    assert library.jobs() == []


@pytest.mark.asyncio
async def test_a_filing_stopped_while_the_check_runs_leaves_no_question_behind(tmp_path, monkeypatch):
    library = Rig(tmp_path, same="rope-journal",
                  during=lambda rig: rig.storage.cancel_memory_jobs("reader", kinds=["document"]))
    library.keep(title="RoPE, the journal version", slug="rope-journal")

    await library.drain(monkeypatch)

    assert library.jobs() == []
    assert library.sources() == [("rope-journal", "gone")]


@pytest.mark.asyncio
async def test_a_kept_page_deleted_while_the_check_runs_lets_the_document_file_as_usual(tmp_path, monkeypatch):
    library = Rig(tmp_path, same="rope-journal",
                  during=lambda rig: rig.storage.delete_memory_page("reader", "rope-journal"))
    library.keep(title="RoPE, the journal version", slug="rope-journal")

    await library.drain(monkeypatch)
    # Let go at once, not parked on a question nobody can answer.
    assert job_is_due(library.jobs()[0], utc_now())
    await library.drain(monkeypatch)

    assert library.sources() == [("rotary-position-embedding", "p1")]
    assert library.jobs() == []


@pytest.mark.asyncio
async def test_the_bulk_drain_hands_the_question_back_for_the_reader(tmp_path, monkeypatch):
    library = Rig(tmp_path)
    library.keep()
    monkeypatch.setattr(catch_up, "httpx", SimpleNamespace(AsyncClient=lambda **_: library.provider(), Timeout=httpx.Timeout))

    runs = await catch_up.drain_account(library.storage, library.objects, library.settings, "reader", verbose=False)

    assert [run["outcome"] for run in runs if run["kind"] == "document"] == ["asking"]
    assert [job["retryAt"] for job in library.jobs()] == [WAITS_FOR_READER]
    assert library.filing()["sameAs"]["slug"] == KEPT


@pytest.mark.asyncio
async def test_the_question_is_dated_by_when_the_kept_pages_document_was_deleted(tmp_path, monkeypatch):
    library = Rig(tmp_path)
    library.keep()
    note_deleted(library.storage, "reader", ["gone", "never-filed"], library.settings)
    await library.drain(monkeypatch)

    [event] = library.storage.latest_marker_events("reader", [deleted_marker("gone"), deleted_marker("never-filed")]).values()
    assert event["summary"] == "Deleted the document Rotary Position Embedding."
    assert library.filing()["sameAs"]["deletedAt"] == event["createdAt"]


@pytest.mark.asyncio
@pytest.mark.parametrize("deleting", ["the document", "its project"])
async def test_deleting_a_document_whose_page_stays_notes_when(tmp_path, monkeypatch, deleting):
    library = Rig(tmp_path)
    await library.drain(monkeypatch)

    with signed_in(library.settings, library.storage, library.objects) as client:
        path = f"/api/projects/{library.project}" + ("/papers/p1" if deleting == "the document" else "")
        assert client.delete(path).status_code == 204

    assert library.sources() == [(KEPT, "p1")]
    assert deleted_marker("p1") in library.storage.latest_marker_events("reader", [deleted_marker("p1")])


@pytest.mark.asyncio
async def test_a_document_waiting_on_its_question_is_no_press_s_to_file(tmp_path, monkeypatch):
    library = Rig(tmp_path)
    library.keep()
    await library.drain(monkeypatch)

    with signed_in(library.settings, library.storage, library.objects) as client:
        assert client.get("/api/memory/backfill/papers").json()["papers"] == []
        assert client.post("/api/memory/backfill/papers").json()["queued"] == 0
    assert [job["retryAt"] for job in library.jobs()] == [WAITS_FOR_READER]


@pytest.mark.asyncio
async def test_with_no_page_kept_nothing_is_asked(tmp_path, monkeypatch):
    library = Rig(tmp_path)

    await library.drain(monkeypatch)

    assert "same_document" not in library.asked
    assert library.sources() == [("rotary-position-embedding", "p1")]


@pytest.mark.asyncio
async def test_deleting_the_kept_page_lets_the_waiting_document_file_as_usual(tmp_path, monkeypatch):
    library = Rig(tmp_path)
    library.keep()
    await library.drain(monkeypatch)

    with signed_in(library.settings, library.storage, library.objects) as client:
        assert client.delete(f"/api/memory/pages/{KEPT}").status_code == 204

    assert job_is_due(library.jobs()[0], utc_now())
    await library.drain(monkeypatch)
    assert library.sources() == [(KEPT, "p1")]
    assert library.jobs() == []
