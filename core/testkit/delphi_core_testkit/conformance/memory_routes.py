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


def test_a_document_deleted_with_its_page_takes_the_domain_that_page_was_last_in(storage, tmp_path):
    """
    What the delete dialog does with the document's page ticked: the document,
    then its page. The document alone keeps its page, so its domain stays (41);
    the page was that domain's last, so deleting it removes the domain too.
    """
    project = storage.create_project("reader", "Diffusion")["id"]
    storage.add_paper("reader", project, {"id": "p1", "title": "LLaDA", "filename": "llada.pdf"})
    storage.upsert_memory_page(
        "reader",
        {**concept("LLaDA"), "kind": "source", "domain": "diffusion-language-models", "sourcePaperId": "p1"},
        max_pages=50,
    )
    storage.upsert_memory_page("reader", concept("Masked diffusion"), max_pages=50)
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-routes-test")
    with signed_in(settings, storage, LocalObjectStore(tmp_path)) as client:
        def domains():
            response = client.get("/api/memory/domains")
            assert response.status_code == 200, response.text
            return sorted(entry["slug"] for entry in response.json()["domains"])

        assert domains() == ["diffusion-language-models", "ml"]
        assert client.delete(f"/api/projects/{project}/papers/p1").status_code == 204
        assert domains() == ["diffusion-language-models", "ml"]

        assert client.delete("/api/memory/pages/llada").status_code == 204
        assert domains() == ["ml"]
        assert client.delete("/api/memory/domains/diffusion-language-models").status_code == 404
        assert all(job.get("payload", {}).get("domain") != "diffusion-language-models"
                   for job in storage.list_memory_jobs("reader"))


def _domains(storage):
    return {entry["slug"]: entry for entry in storage.memory_domains("reader")}


def test_a_delete_that_leaves_a_domain_one_page_moves_it_to_the_domain_it_links_to(storage, tmp_path):
    """One page is no field: it joins the domain its links reach most, and the emptied domain goes."""
    storage.upsert_memory_page("reader", {**concept("Adam"), "domain": "optimizers"}, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("SGD", "Plain steps; see [[warmup]]."), "domain": "optimizers"}, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("Warmup"), "domain": "training"}, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("Batch size"), "domain": "training"}, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("Switchbacks"), "domain": "hiking"}, max_pages=50)
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-routes-test")
    with signed_in(settings, storage, LocalObjectStore(tmp_path)) as client:
        assert client.delete("/api/memory/pages/adam").status_code == 204

    assert storage.get_memory_page("reader", "sgd")["domain"] == "training"
    assert "optimizers" not in _domains(storage) and _domains(storage)["training"]["pages"] == 3
    moved = [event for event in storage.list_memory_events("reader", limit=10) if event.get("kind") == "refile"]
    assert [event["pages"] for event in moved] == [["sgd"]]


def test_a_lone_page_linked_nowhere_goes_where_its_words_match(storage, tmp_path):
    storage.upsert_memory_page("reader", {**concept("Adam"), "domain": "optimizers"}, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("Muon"), "domain": "optimizers"}, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("Muon variants"), "domain": "spectral-methods"}, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("Switchbacks"), "domain": "hiking"}, max_pages=50)
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-routes-test")
    with signed_in(settings, storage, LocalObjectStore(tmp_path)) as client:
        assert client.delete("/api/memory/pages/adam").status_code == 204

    assert storage.get_memory_page("reader", "muon")["domain"] == "spectral-methods"
    assert "optimizers" not in _domains(storage)


def test_a_lone_page_stays_in_a_domain_the_reader_named_or_when_nothing_is_close(storage, tmp_path):
    """The reader's own domain is theirs to fold; a page with nowhere to go keeps its domain."""
    storage.upsert_memory_domain("reader", {"slug": "reading-list", "title": "Reading list", "origin": "reader"})
    for title in ("Adam", "SGD"):
        storage.upsert_memory_page("reader", {**concept(title), "domain": "reading-list"}, max_pages=50)
    for title in ("Kayaks", "Paddles"):
        storage.upsert_memory_page("reader", {**concept(title), "domain": "boats"}, max_pages=50)
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-routes-test")
    with signed_in(settings, storage, LocalObjectStore(tmp_path)) as client:
        assert client.delete("/api/memory/pages/adam").status_code == 204
        assert client.delete("/api/memory/pages/kayaks").status_code == 204

    assert storage.get_memory_page("reader", "sgd")["domain"] == "reading-list"
    # Nothing in another domain links to Paddles or shares its words.
    assert storage.get_memory_page("reader", "paddles")["domain"] == "boats"


def _a_page_to_delete(storage):
    """`optimizers` holds two pages, `training` three, `reading-list` (the reader's) two and `solo` one."""
    storage.upsert_memory_page("reader", {**concept("Adam"), "domain": "optimizers"}, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("SGD", "Plain steps; see [[warmup]]."), "domain": "optimizers"}, max_pages=50)
    for title in ("Warmup", "Batch size", "Learning rate"):
        storage.upsert_memory_page("reader", {**concept(title), "domain": "training"}, max_pages=50)
    storage.upsert_memory_domain("reader", {"slug": "reading-list", "title": "Reading list", "origin": "reader"})
    for title in ("Lion", "Sophia"):
        storage.upsert_memory_page("reader", {**concept(title), "domain": "reading-list"}, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("Cairns"), "domain": "solo"}, max_pages=50)


def test_a_pages_deletion_says_when_its_domain_goes_and_where_the_page_left_moves(storage, tmp_path):
    _a_page_to_delete(storage)
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-routes-test")
    with signed_in(settings, storage, LocalObjectStore(tmp_path)) as client:
        def shown(slug):
            answer = client.get(f"/api/memory/pages/{slug}/deletion")
            assert answer.status_code == 200, answer.text
            return answer.json()

        second_to_last = shown("adam")
        last = shown("cairns")
        nothing = {slug: shown(slug) for slug in ("warmup", "lion")}
        assert client.get("/api/memory/pages/nowhere/deletion").status_code == 404

    assert second_to_last["domain"]["slug"] == "optimizers"
    # SGD goes where its links reach, and any other domain may be picked instead.
    assert second_to_last["left"] == {"slug": "sgd", "title": "SGD", "kind": "concept", "suggested": "training"}
    assert sorted(entry["slug"] for entry in second_to_last["destinations"]) == ["reading-list", "solo", "training"]
    assert last == {"domain": {"slug": "solo", "title": last["domain"]["title"]}, "left": None, "destinations": []}
    # Two pages stay in Training; the reader's own domain keeps one.
    assert nothing == {slug: {"domain": None, "left": None, "destinations": []} for slug in ("warmup", "lion")}


def test_the_page_a_domain_would_keep_moves_where_the_reader_chose_and_a_stale_choice_is_refused(storage, tmp_path):
    _a_page_to_delete(storage)
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-routes-test")
    with signed_in(settings, storage, LocalObjectStore(tmp_path)) as client:
        def delete(moves):
            return client.request("DELETE", "/api/memory/pages/adam", json={"moves": moves}).status_code

        # A page the domain would not keep alone, then destinations it cannot take: nothing is deleted.
        assert delete({"adam": "training"}) == 409
        assert [delete({"sgd": target}) for target in ("optimizers", "general", "nowhere")] == [422, 422, 422]
        assert storage.get_memory_page("reader", "adam")["domain"] == "optimizers"
        assert delete({"sgd": "solo"}) == 204

    assert storage.get_memory_page("reader", "sgd")["domain"] == "solo"
    assert "optimizers" not in _domains(storage)
    moved = [event for event in storage.list_memory_events("reader", limit=10) if event.get("kind") == "refile"]
    assert [event["pages"] for event in moved] == [["sgd"]]


def _a_library_to_delete_from(storage):
    """`optimizers`: two concepts and a document's page; `training` links to one of them; `hiking` is far away."""
    storage.upsert_memory_page("reader", {**concept("Adam", "Moments; see [[sgd]]."), "domain": "optimizers"}, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("SGD"), "domain": "optimizers"}, max_pages=50)
    storage.upsert_memory_page("reader", {
        **concept("Adam paper", "Introduces [[adam]]; tuned with [[warmup]]."), "kind": "source",
        "domain": "optimizers", "sourcePaperId": "p1",
    }, max_pages=50)
    storage.upsert_memory_page("reader", {
        "kind": "domain", "slug": "optimizers", "domain": "optimizers", "title": "Optimizers",
        "summary": "s", "body": "From [[sgd]] to [[adam]].",
    }, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("Warmup", "Pairs with [[adam]]."), "domain": "training"}, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("Batch size", "Read [[optimizers]] first."), "domain": "training"}, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("Switchbacks"), "domain": "hiking"}, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("Cairns"), "domain": "hiking"}, max_pages=50)


def test_a_domains_deletion_shows_what_moves_what_goes_and_what_loses_a_link(storage, tmp_path):
    _a_library_to_delete_from(storage)
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-routes-test")
    with signed_in(settings, storage, LocalObjectStore(tmp_path)) as client:
        shown = client.get("/api/memory/domains/optimizers/deletion")
        assert shown.status_code == 200, shown.text
        plan = shown.json()
        assert client.get("/api/memory/domains/nowhere/deletion").status_code == 404
        assert client.get("/api/memory/domains/general/deletion").status_code == 422

    assert plan["domain"] == {"slug": "optimizers", "title": "Optimizers"}
    assert sorted(plan["members"]) == ["adam", "adam-paper", "sgd"]
    # The document's page goes where its links reach most.
    assert plan["sources"] == [{"slug": "adam-paper", "title": "Adam paper", "kind": "source", "suggested": "training"}]
    assert sorted(page["slug"] for page in plan["pages"]) == ["adam", "sgd"]
    # Every page that stays and links to one that goes: the moved page, and two outside it.
    assert sorted((page["slug"], page["domain"]) for page in plan["unlinked"]) == [
        ("adam-paper", "optimizers"), ("batch-size", "training"), ("warmup", "training"),
    ]
    assert sorted(entry["slug"] for entry in plan["destinations"]) == ["hiking", "training"]


def test_a_domain_deleted_as_the_reader_confirmed_it_is_recorded_and_leaves_no_dead_link(storage, tmp_path):
    _a_library_to_delete_from(storage)
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-routes-test")
    with signed_in(settings, storage, LocalObjectStore(tmp_path)) as client:
        plan = client.get("/api/memory/domains/optimizers/deletion").json()
        # Without what the reader was shown, a domain holding pages is refused.
        assert client.delete("/api/memory/domains/optimizers").status_code == 409
        deleted = client.request("DELETE", "/api/memory/domains/optimizers", json={
            "members": plan["members"], "moves": {"adam-paper": "training"},
        })
        assert deleted.status_code == 200, deleted.text
        listed = sorted(entry["slug"] for entry in client.get("/api/memory/domains").json()["domains"])

    assert [page["slug"] for page in deleted.json()["moved"]] == ["adam-paper"]
    assert sorted(page["slug"] for page in deleted.json()["deleted"]) == ["adam", "optimizers", "sgd"]
    assert listed == ["hiking", "training"]
    slugs = {page["slug"] for page in storage.list_memory_pages("reader")}
    assert all(edge["to"] in slugs for edge in storage.list_memory_links("reader"))
    events = storage.list_memory_events("reader", limit=10)
    assert [event["kind"] for event in events[:2]] == ["delete", "refile"]
    assert sorted(edit["slug"] for edit in events[0]["edits"]) == ["adam", "optimizers", "sgd"]


def test_general_is_never_named_renamed_deleted_or_moved_into(storage, tmp_path):
    """`general` is where a document's page waits to be filed, not a domain the reader can act on."""
    storage.upsert_memory_page("reader", {
        **concept("Waiting paper"), "kind": "source", "domain": "general", "sourcePaperId": "p1",
    }, max_pages=50)
    storage.upsert_memory_page("reader", {**concept("Adam"), "domain": "optimizers"}, max_pages=50)
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-routes-test")
    with signed_in(settings, storage, LocalObjectStore(tmp_path)) as client:
        assert client.post("/api/memory/domains", json={"title": "General"}).status_code == 422
        assert client.patch("/api/memory/domains/general", json={"title": "Model architectures"}).status_code == 422
        assert client.request("DELETE", "/api/memory/domains/general", json={
            "members": ["waiting-paper"], "moves": {"waiting-paper": "optimizers"},
        }).status_code == 422
        assert client.post("/api/memory/pages/move", json={"moves": {"adam": "general"}}).status_code == 422
        # Out of it is how a waiting page is placed by hand.
        assert client.post("/api/memory/pages/move", json={"moves": {"waiting-paper": "optimizers"}}).status_code == 200

    assert storage.get_memory_page("reader", "adam")["domain"] == "optimizers"
    assert "general" not in _domains(storage)


def test_a_move_that_leaves_a_domain_one_page_folds_it_as_a_delete_does(storage, tmp_path):
    """Update's moves, applied: a domain the model named that they leave with one page is no field either."""
    for title in ("Adam", "SGD", "Muon"):
        storage.upsert_memory_page("reader", {**concept(title, "See [[warmup]]."), "domain": "optimizers"}, max_pages=50)
    for title in ("Warmup", "Batch size"):
        storage.upsert_memory_page("reader", {**concept(title), "domain": "training"}, max_pages=50)
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-routes-test")
    with signed_in(settings, storage, LocalObjectStore(tmp_path)) as client:
        moved = client.post("/api/memory/pages/move", json={"moves": {"adam": "training", "sgd": "training"}})
        assert moved.status_code == 200, moved.text

    assert storage.get_memory_page("reader", "muon")["domain"] == "training"
    assert "optimizers" not in _domains(storage) and _domains(storage)["training"]["pages"] == 5


def test_an_update_that_empties_a_domain_and_puts_one_page_in_folds_nothing(storage, tmp_path):
    """The set is one decision: `optimizers` gives up both its pages and takes Cairns, as the reader chose, and keeps it."""
    for title in ("Adam", "SGD"):
        storage.upsert_memory_page("reader", {**concept(title, "See [[warmup]]."), "domain": "optimizers"}, max_pages=50)
    for title in ("Warmup", "Batch size"):
        storage.upsert_memory_page("reader", {**concept(title), "domain": "training"}, max_pages=50)
    for title in ("Switchbacks", "Ridges"):
        storage.upsert_memory_page("reader", {**concept(title), "domain": "hiking"}, max_pages=50)
    # It links home, so a fold would take it straight back.
    storage.upsert_memory_page("reader", {**concept("Cairns", "Mark [[switchbacks]]."), "domain": "hiking"}, max_pages=50)
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-routes-test")
    with signed_in(settings, storage, LocalObjectStore(tmp_path)) as client:
        moved = client.post("/api/memory/pages/move", json={"moves": {"adam": "training", "sgd": "training", "cairns": "optimizers"}})
        assert moved.status_code == 200, moved.text

    assert {slug: storage.get_memory_page("reader", slug)["domain"] for slug in ("adam", "sgd", "cairns")} == {
        "adam": "training", "sgd": "training", "cairns": "optimizers"}
    assert not [event for event in storage.list_memory_events("reader", limit=10)
                if event.get("kind") == "refile" and "domain held no other page" in event.get("summary", "")]


def test_deleting_a_domains_own_page_moves_none_of_its_pages(storage, tmp_path):
    """The dialog shows nothing for a domain's own page, so the delete does nothing more than it showed."""
    storage.upsert_memory_page("reader", {**concept("Adam", "See [[warmup]]."), "domain": "optimizers"}, max_pages=50)
    storage.upsert_memory_page("reader", {
        "slug": "optimizers", "kind": "domain", "domain": "optimizers", "title": "Optimizers", "summary": "s",
        "body": "How [[adam]] relates.",
    }, max_pages=50)
    for title in ("Warmup", "Batch size"):
        storage.upsert_memory_page("reader", {**concept(title), "domain": "training"}, max_pages=50)
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-routes-test")
    with signed_in(settings, storage, LocalObjectStore(tmp_path)) as client:
        shown = client.get("/api/memory/pages/optimizers/deletion").json()
        assert (shown["domain"], shown["left"]) == (None, None)
        assert client.delete("/api/memory/pages/optimizers").status_code == 204

    assert storage.get_memory_page("reader", "adam")["domain"] == "optimizers"
    assert "optimizers" in _domains(storage)
