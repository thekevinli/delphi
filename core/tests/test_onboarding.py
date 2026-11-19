"""Onboarding resolves records and bytes together, without touching other projects."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from delphi_core.config import Settings, get_settings
from delphi_core.deps import get_current_user, get_object_store, get_storage
from delphi_core.routers import onboarding, projects
from delphi_core.storage import LocalObjectStore, LocalStorage, paper_key


@pytest.fixture
def setup(tmp_path):
    settings = Settings(data_dir=tmp_path, openai_api_key="test-only", memory_enabled=True)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    objects = LocalObjectStore(tmp_path)
    app = FastAPI()
    app.include_router(onboarding.router)
    app.dependency_overrides.update({get_settings: lambda: settings,
        get_current_user: lambda: "reader", get_storage: lambda: storage,
        get_object_store: lambda: objects})
    with TestClient(app) as client:
        yield storage, objects, client


def test_resolve_deletes_only_the_interrupted_attempts_records_and_bytes(setup):
    storage, objects, client = setup
    attempt = storage.create_project("reader", "First", onboarding=True)
    other = storage.create_project("reader", "Unrelated")
    storage.add_paper("reader", attempt["id"], {"id": "p1", "title": "First", "filename": "a.pdf"})
    old = [paper_key("reader", attempt["id"], "p1", ext) for ext in ("pdf", "digest", "digest-asset-a-webp")]
    kept = paper_key("reader", other["id"], "other", "txt")
    for key in [*old, kept]:
        objects.put_text(key, "stored bytes")
    assert client.post("/api/onboarding/resolve").json() == {"onboarding": True, "outcome": "restart"}
    assert not any(objects.exists(key) for key in old)
    assert objects.exists(kept)
    assert [p["id"] for p in storage.list_projects("reader")] == [other["id"]]
    assert storage.list_memory_jobs("reader") == []


def test_finish_does_not_count_an_uploaded_but_unfiled_document(setup):
    storage, objects, client = setup
    attempt = storage.create_project("reader", "First", onboarding=True)
    storage.add_paper("reader", attempt["id"], {"id": "p1", "title": "First", "filename": "a.pdf"})
    assert client.post("/api/onboarding/finish").json() == {"complete": False}
    assert client.get("/api/onboarding").json()["completed"] == 0
    storage.commit_memory_update("reader", pages=[], figures=[],
        event={"requestId": "paper:p1", "marker": "paper:p1", "kind": "document"},
        max_pages=10, max_figures_per_page=4)
    assert client.post("/api/onboarding/resolve").json() == {"onboarding": False, "outcome": "complete"}
    assert storage.get_project("reader", attempt["id"])["papers"]


def test_a_slow_import_discards_bytes_written_after_restart(setup):
    storage, objects, client = setup
    attempt = storage.create_project("reader", "First", onboarding=True)
    late = paper_key("reader", attempt["id"], "p1", "pdf")
    with projects._discard_deleted_project_import(storage, objects, "reader", attempt["id"]):
        assert client.post("/api/onboarding/resolve").json()["outcome"] == "restart"
        objects.put_text(late, "upload finishes after cleanup")
        assert objects.exists(late)
    assert not objects.exists(late)
    assert storage.list_projects("reader") == []
