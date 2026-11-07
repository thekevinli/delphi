"""
Memory routes both frontends call, driven where no other test drove them.

Each case goes through the app with a signed-in reader, so the setting, the
storage method or the module imported at call time that a route names is
reached the way a request reaches it. The pages listing runs on every store;
the rewrite and the lint run against the journey rig's scripted provider
(`tests/rig_library.py`), which nothing outside the test machine can answer.
The listing is the kit's (`delphi_core_testkit.conformance.memory_routes`).
"""

import json

import httpx
import pytest

from delphi_core.config import Settings
from delphi_core.storage import LocalObjectStore, LocalStorage
from delphi_core.storage.base import MEMORY_JOB_KINDS

from delphi_core_testkit.conformance.memory_routes import (
    signed_in,
    concept,
    storage,
    test_the_pages_route_filters_by_kind_and_domain,
)

from tests.helpers import ProviderTransport
from tests.rig_library import Rig


#: What this module runs from the kit, named so pyflakes counts the imports
#: above as used: it cannot see pytest collect them.
__all__ = [
    "signed_in",
    "concept",
    "storage",
    "test_the_pages_route_filters_by_kind_and_domain",
]


pytestmark = pytest.mark.kb_maintenance


def local(tmp_path, **given):
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-routes-test", **given)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    return settings, storage, LocalObjectStore(tmp_path)


def frames(response) -> list[dict]:
    """The data frames of an event stream, in order."""
    assert response.status_code == 200, response.text
    return [json.loads(line.removeprefix("data: ")) for line in response.text.splitlines() if line.startswith("data: ")]


def test_memory_routes_answer_403_where_memory_is_turned_off(tmp_path):
    settings, storage, objects = local(tmp_path, memory_enabled=False)
    storage.upsert_memory_page("reader", concept("KV cache"), max_pages=50)
    with signed_in(settings, storage, objects) as client:
        for method, path in (("GET", "/api/memory/pages"), ("POST", "/api/memory/lint")):
            refused = client.request(method, path)
            assert refused.status_code == 403, (path, refused.text)
            assert "turned off" in refused.json()["detail"]


def test_renaming_a_domain_retitles_its_composed_page(tmp_path):
    """The page a domain opens as takes the reader's new name at once; its words stay the composer's."""
    settings, storage, objects = local(tmp_path)
    storage.upsert_memory_page("reader", concept("KV cache"), max_pages=50)
    storage.upsert_memory_page("reader", {
        "kind": "domain", "slug": "ml", "domain": "ml", "title": "ML",
        "summary": "How the pages of this domain relate.", "body": "Caching and batching both trade memory for time.",
    }, max_pages=50)
    before = storage.get_memory_page("reader", "ml")

    with signed_in(settings, storage, objects) as client:
        renamed = client.patch("/api/memory/domains/ml", json={"title": "Machine learning"})
        assert renamed.status_code == 200, renamed.text
        page = client.get("/api/memory/pages/ml").json()["page"]

    assert (page["title"], page["revision"]) == ("Machine learning", before["revision"] + 1)
    assert (page["kind"], page["summary"], page["body"]) == (before["kind"], before["summary"], before["body"])


def test_asking_again_after_a_failed_rewrite_rearms_the_same_job(tmp_path):
    """A rewrite that gave up is revived by the next press at the same revision, not left failed."""
    settings, storage, objects = local(tmp_path)
    project = storage.create_project("reader", "Reading")
    storage.add_paper("reader", project["id"], {"id": "p1", "title": "A paper", "filename": "p1.pdf", "pages": 2})
    storage.upsert_memory_page("reader", concept("Prefix reuse", sourcePaperId="p1"), max_pages=50)
    storage.cancel_memory_jobs("reader", kinds=MEMORY_JOB_KINDS)

    with signed_in(settings, storage, objects) as client:
        first = client.post("/api/memory/pages/prefix-reuse/rewrite")
        assert first.status_code == 200, first.text
        claimed = storage.claim_memory_job(
            "reader", now="2100-01-01T00:00:00+00:00", lease_expires_at="2100-01-01T01:00:00+00:00", max_attempts=3,
        )
        assert claimed["id"] == first.json()["id"]
        storage.fail_memory_job("reader", claimed["id"], error="The check objected.", retry_at=None)
        assert [job["status"] for job in storage.list_memory_jobs("reader")] == ["failed"]

        again = client.post("/api/memory/pages/prefix-reuse/rewrite")

    assert again.status_code == 200, again.text
    assert (again.json()["id"], again.json()["status"], again.json()["attempts"]) == (first.json()["id"], "pending", 0)


def test_a_page_rewrite_runs_through_the_drain(tmp_path, monkeypatch):
    """The drain runs a rewrite with its own pass: the page moves on a revision and the job leaves the queue."""
    rig = Rig(tmp_path, monkeypatch)
    rig.pdf("aaaaaaaaaaa1", "Prefix caching study")
    rig.storage.upsert_memory_page("reader", concept(
        "Prefix reuse", "## Prefix reuse\n\nPrefix caching reuses the unchanged beginning of a prompt.",
        sourcePaperId="aaaaaaaaaaa1",
    ), max_pages=50)
    rig.storage.cancel_memory_jobs("reader", kinds=MEMORY_JOB_KINDS)
    before = rig.storage.get_memory_page("reader", "prefix-reuse")

    with signed_in(rig.settings, rig.storage, rig.objects) as client:
        queued = client.post("/api/memory/pages/prefix-reuse/rewrite", json={"note": "Say how it was measured."})
        assert queued.status_code == 200, queued.text
        done = frames(client.post("/api/memory/maintenance/drain"))[-1]

    assert (done["type"], done["kind"], done["claimed"], done["jobId"]) == (
        "done", "page-rewrite", True, queued.json()["id"])
    after = rig.storage.get_memory_page("reader", "prefix-reuse")
    assert after["revision"] == before["revision"] + 1
    assert after["body"].startswith(before["body"]) and "## Worked measurement detail" in after["body"]
    assert rig.asked("knowledge_page_rewrite") == 1
    assert "page-rewrite" not in {job["kind"] for job in rig.storage.list_memory_jobs("reader")}


def test_the_lint_route_streams_the_check_and_ends_in_done(tmp_path, monkeypatch):
    """
    The Check button's stream: a progress frame, then `done`. What the check
    found is on its event, which Health reads, and each contradiction has queued
    the job that reconciles it.
    """
    rig = Rig(tmp_path, monkeypatch)
    for title, line in (
        ("Warmup", "Disputed finding: warmup runs for the first 4,000 steps."),
        ("Learning rate schedule", "Disputed finding: warmup lasts 10,000 steps."),
        ("Label smoothing", "Label smoothing spreads a little probability over the wrong classes."),
    ):
        rig.storage.upsert_memory_page("reader", concept(title, f"## {title}\n\n{line}"), max_pages=50)
    rig.storage.cancel_memory_jobs("reader", kinds=MEMORY_JOB_KINDS)

    with signed_in(rig.settings, rig.storage, rig.objects) as client:
        sent = frames(client.post("/api/memory/lint"))
        health = client.get("/api/memory/health").json()

    assert [frame["type"] for frame in sent] == ["progress", "done"]
    assert sent[0]["message"] == "Checking 3 pages"
    assert {frame["requestId"] for frame in sent} == {sent[-1]["requestId"]}
    assert (sent[-1]["pages"], sent[-1]["reused"], sent[-1]["method"]) == (
        [], False, "Compared the pages supplied, and nothing else.")
    [finding] = health["lastCheck"]["contradictions"]
    assert sorted(finding["pages"]) == ["learning-rate-schedule", "warmup"]
    assert [job["kind"] for job in rig.storage.list_memory_jobs("reader")] == ["reconcile"]


def test_a_lint_the_provider_refuses_ends_in_one_error_frame(tmp_path, monkeypatch):
    """A refusal reaches the reader as the stream's last frame, with its reason, and no check is recorded."""
    settings, storage, objects = local(
        tmp_path, openai_api_key="test-key", openai_api_base_url="https://api.openai.test/v1"
    )
    for title in ("Warmup", "Learning rate schedule"):
        storage.upsert_memory_page("reader", concept(title, f"## {title}\n\nA claim about warmup."), max_pages=50)

    def refuse(_request):
        return httpx.Response(400, json={"error": {
            "message": "Invalid schema for response_format: unsupported keyword.", "code": "invalid_json_schema"}})

    client_class = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **given: client_class(**{**given, "transport": ProviderTransport(refuse)})
    )
    with signed_in(settings, storage, objects) as client:
        sent = frames(client.post("/api/memory/lint"))

    assert [frame["type"] for frame in sent] == ["progress", "error"]
    assert "Invalid schema for response_format" in sent[-1]["message"]
    assert storage.latest_memory_event("reader", kind="lint") is None


def test_a_source_page_opens_its_document_where_it_is_now_and_marks_a_capture_no_longer_kept(tmp_path):
    """A page filed before its document moved, citing a capture since removed, reads as what is there now."""
    settings, storage, objects = local(tmp_path)
    filed_in = storage.create_project("reader", "Filed in")
    moved_to = storage.create_project("reader", "Moved to")
    storage.add_paper("reader", filed_in["id"], {"id": "aaaaaaaaaaa1", "title": "T2", "filename": "t2.pdf", "pages": 20})
    storage.upsert_memory_page("reader", {
        "kind": "source", "domain": "ml", "title": "T2", "summary": "What T2 says.", "body": "It says so [E1][E2].",
        "sourcePaperId": "aaaaaaaaaaa1", "sourceProjectId": filed_in["id"],
        "citations": [
            {"id": 1, "claimType": "author-claim", "paperId": "aaaaaaaaaaa1", "page": 2},
            {"id": 2, "claimType": "external", "evidenceId": "0a624f90eeca47399fc6fad1", "section": "limits"},
            {"id": 3, "claimType": "external", "evidenceId": "keptcapture0000000000001", "section": "intro"},
        ],
    }, max_pages=50)
    storage.put_external_evidence("reader", {
        "id": "keptcapture0000000000001", "url": "https://outside.example/a", "contentHash": "0", "findings": [],
    })
    # Written as pages were before they named their document by id alone, and
    # citing no passage of it, so the document is found by scanning the library.
    path = tmp_path / "users" / "reader" / "memory" / "pages" / "t2.json"
    record = json.loads(path.read_text())
    path.write_text(json.dumps({**record, "sourceProjectId": filed_in["id"], "citations": record["citations"][1:]}))
    storage.move_paper("reader", filed_in["id"], "aaaaaaaaaaa1", moved_to["id"])
    storage.delete_project("reader", filed_in["id"])

    with signed_in(settings, storage, objects) as client:
        body = client.get("/api/memory/pages/t2").json()
        page = body["page"]
        assert "sourceProjectId" not in page
        assert body["document"] == {"paperId": "aaaaaaaaaaa1", "projectId": moved_to["id"]}
        assert [citation.get("captured") for citation in page["citations"]] == [False, True]
        assert all("sourceProjectId" not in listed for listed in client.get("/api/memory/pages").json())

        storage.delete_project("reader", moved_to["id"])
        assert client.get("/api/memory/pages/t2").json()["document"] == {"paperId": "aaaaaaaaaaa1", "projectId": None}
