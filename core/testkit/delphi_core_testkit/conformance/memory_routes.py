"""
Memory routes both frontends call, driven where no other test drove them.

Each case goes through the app with a signed-in reader, so the setting, the
storage method or the module imported at call time that a route names is
reached the way a request reaches it. Here, the pages listing, on every
store the consumer's `store_harness` opens.
"""

from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from delphi_core.config import Settings, get_settings
from delphi_core.deps import get_object_store, get_storage
from delphi_core.main import app
from delphi_core.security import make_session
from delphi_core.storage import LocalObjectStore


@contextmanager
def signed_in(settings, storage, objects):
    """A client of the app over these stores, signed in as `reader`."""
    app.dependency_overrides.update({
        get_settings: lambda: settings, get_storage: lambda: storage, get_object_store: lambda: objects,
    })
    try:
        with TestClient(app) as client:
            client.cookies.set("delphi_session", make_session("reader", settings.session_secret, 1))
            yield client
    finally:
        app.dependency_overrides.clear()


def concept(title, body="Body.", **fields):
    return {"kind": "concept", "domain": "ml", "title": title, "summary": f"What {title} is.", "body": body, **fields}


@pytest.fixture
def storage(store_harness, tmp_path):
    store = store_harness.make(tmp_path)
    store.create_account("reader", None, "salt", "hash")
    return store


def test_the_pages_route_filters_by_kind_and_domain(storage, tmp_path):
    """The listing the chat panel asks for, narrowed by kind, by domain and by both, on both stores."""
    for title, kind, domain in (
        ("KV cache", "concept", "ml"),
        ("Speculative decoding", "concept", "systems"),
        ("A serving paper", "source", "ml"),
        ("Batching", "source", "systems"),
    ):
        storage.upsert_memory_page(
            "reader", {**concept(title), "kind": kind, "domain": domain}, max_pages=50
        )
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-routes-test")
    with signed_in(settings, storage, LocalObjectStore(tmp_path)) as client:
        def slugs(query=""):
            response = client.get("/api/memory/pages" + query)
            assert response.status_code == 200, response.text
            return sorted(page["slug"] for page in response.json())

        assert slugs() == ["a-serving-paper", "batching", "kv-cache", "speculative-decoding"]
        assert slugs("?kind=concept") == ["kv-cache", "speculative-decoding"]
        assert slugs("?domain=ml") == ["a-serving-paper", "kv-cache"]
        assert slugs("?kind=concept&domain=ml") == ["kv-cache"]
        assert slugs("?kind=source&kind=concept&domain=systems") == ["batching", "speculative-decoding"]
        assert slugs("?domain=nowhere") == []
