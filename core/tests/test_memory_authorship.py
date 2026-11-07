"""
Who wrote a Memory page, and what deleting a page or a document takes with it.

The fold is pure and runs on events alone; the routes run through the app on
the local store, as `test_memory_routes.py` does.
"""

import pytest

from delphi_core.config import Settings
from delphi_core.memory_authorship import page_authors
from delphi_core.memory_same_document import deleted_at
from delphi_core.storage import LocalObjectStore, LocalStorage
from delphi_core.storage.base import LINK_REPAIR_NOTE, MEMORY_JOB_KINDS

from delphi_core_testkit.conformance.memory_routes import concept, signed_in

from tests.chat_keys import chat_key
from tests.helpers import seed_paper

pytestmark = pytest.mark.kb_maintenance

PAPERS = {"p1": ("proj", "LLaDA"), "p2": ("proj", "MMaDA")}


def event(marker, at, *, action="revised", note=None, title=None, slug="remasking"):
    return {
        "marker": marker, "createdAt": at, **({"title": title} if title else {}),
        "edits": [{"slug": slug, "title": "Remasking", "kind": "concept", "action": action, "note": note}],
    }


def rows(events, papers=PAPERS, chats=None):
    return [
        (row["kind"], row["id"], row["title"], row["firstAt"], row["note"], row["removed"])
        for row in page_authors(events, "remasking", papers=papers, chats=chats or {})
    ]


def test_each_author_is_one_row_in_the_order_it_first_wrote_with_its_latest_note():
    assert rows([
        event("paper:p1", "1", action="created", note="Wrote it from §3.2."),
        event("session:paper:p2", "2", note="Your question on block length."),
        event("paper:p1:part:1", "3", note="Added Table 4."),
        event("session:conversation:c1", "4", note="Linked parallel decoding.", title="Which tricks stack?"),
    ], chats={"c1": (0, "Which tricks stack?")}) == [
        ("document", "p1", "LLaDA", "1", "Added Table 4.", False),
        ("session", "p2", "MMaDA", "2", "Your question on block length.", False),
        ("chat", "c1", "Which tricks stack?", "4", "Linked parallel decoding.", False),
    ]


def test_delphi_s_own_upkeep_is_no_author():
    assert rows([
        event("paper:p1", "1", action="created"),
        event("reconcile:abc", "2"), event("domain:ml", "3"), event("page:remasking:rewrite:v1:2", "4"),
        {"kind": "delete", "createdAt": "5", "edits": [{"slug": "remasking", "action": "deleted"}]},
    ]) == [("document", "p1", "LLaDA", "1", None, False)]


def test_a_page_filed_again_after_it_was_deleted_starts_its_authorship_afresh():
    assert rows([
        event("paper:p1", "1", action="created"),
        {"kind": "delete", "createdAt": "2", "edits": [{"slug": "remasking", "action": "deleted"}]},
        event("paper:p2", "3", action="created"),
    ]) == [("document", "p2", "MMaDA", "3", None, False)]


def test_a_removed_author_keeps_the_name_its_event_kept_and_a_live_one_shows_its_name_now():
    assert rows([
        event("paper:gone", "1", action="created", title="dKV-Cache"),
        event("paper:p1", "2", title="LLaDA, as it was called then"),
        event("session:conversation:c1", "3", title="A chat since deleted"),
        event("paper:older", "4"),
    ]) == [
        ("document", "gone", "dKV-Cache", "1", None, True),
        ("document", "p1", "LLaDA", "2", None, False),
        ("chat", "c1", "A chat since deleted", "3", None, True),
        # Filed before events kept a name: the reader is told it is gone, not what it was.
        ("document", "older", None, "4", None, True),
    ]


def local(tmp_path):
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-authorship-test")
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    return settings, storage, LocalObjectStore(tmp_path)


def cites(*paper_ids):
    return {
        "body": " ".join(f"A claim [E{index}]." for index, _ in enumerate(paper_ids, 1)),
        "citations": [
            {"id": index, "claimType": "author-claim", "paperId": paper_id, "page": 1}
            for index, paper_id in enumerate(paper_ids, 1)
        ],
    }


def test_a_concept_page_names_its_authors_and_deleting_one_rewrites_nothing(tmp_path):
    settings, storage, objects = local(tmp_path)
    project = storage.create_project("reader", "Reading")
    for paper_id, title in (("p1", "LLaDA"), ("p2", "dKV-Cache")):
        storage.add_paper("reader", project["id"], {"id": paper_id, "title": title, "filename": f"{paper_id}.pdf", "pages": 2})
    storage.upsert_memory_page("reader", concept("Remasking", sourcePaperId="p1", **cites("p1", "p2")), max_pages=50)
    storage.upsert_memory_page("reader", {**concept("LLaDA"), "kind": "source", "sourcePaperId": "p1"}, max_pages=50)
    storage.append_memory_event("reader", event("paper:p1", "2026-09-12T00:00:00Z", action="created", title="LLaDA"))
    storage.append_memory_event("reader", event("paper:p2", "2026-10-09T00:00:00Z", note="Caching goes stale.", title="dKV-Cache"))
    before = storage.get_memory_page("reader", "remasking")

    with signed_in(settings, storage, objects) as client:
        read = client.get("/api/memory/pages/remasking").json()
        assert [(row["title"], row["removed"], row["projectId"]) for row in read["authors"]] == [
            ("LLaDA", False, project["id"]), ("dKV-Cache", False, project["id"]),
        ]
        # A source page is its document's, and says so already.
        assert client.get("/api/memory/pages/llada").json()["authors"] == []

        assert client.delete(f"/api/projects/{project['id']}/papers/p2").status_code == 204
        after = client.get("/api/memory/pages/remasking").json()

    assert [(row["title"], row["removed"], row["note"]) for row in after["authors"]] == [
        ("LLaDA", False, None), ("dKV-Cache", True, "Caching goes stale."),
    ]
    # The deleted document is still named where the page cites it, by the title its filing kept.
    assert {(source["paperId"], source["title"], source["available"]) for source in after["sources"]} == {
        ("p1", "LLaDA", True), ("p2", "dKV-Cache", False),
    }
    assert (after["page"]["body"], after["page"]["revision"]) == (before["body"], before["revision"])


def test_a_memory_chat_s_row_greys_once_the_chat_is_deleted_even_when_its_id_is_used_again(tmp_path):
    settings, storage, objects = local(tmp_path)
    selector = chat_key(storage, "reader")
    chat_id = selector.split("-")[1]
    storage.append_memory_message("reader", {"role": "user", "content": "Which tricks stack?"}, selector)
    storage.upsert_memory_page("reader", concept("Remasking"), max_pages=50)
    storage.append_memory_event("reader", {
        **event(f"session:conversation:{chat_id}", "1", action="created", title="Which tricks stack?"), "chatGeneration": 0,
    })

    def authors(client):
        return [(row["title"], row["removed"]) for row in client.get("/api/memory/pages/remasking").json()["authors"]]

    # Opening a page reads the chats that wrote it, never every conversation the account holds.
    storage.list_scope_conversations = lambda *_, **__: pytest.fail("Written by listed every chat")
    with signed_in(settings, storage, objects) as client:
        assert authors(client) == [("Which tricks stack?", False)]
        # The only Memory chat is reset under its id when deleted, and the next question reuses it.
        storage.delete_conversation("reader", chat_id, 0)
        assert authors(client) == [("Which tricks stack?", True)]
        assert storage.create_conversation("reader", "general", None, None, "next")["id"] == chat_id
        storage.append_memory_message("reader", {"role": "user", "content": "What is RoPE?"}, f"conversation-{chat_id}-1")
        assert authors(client) == [("Which tricks stack?", True)]


def test_deleting_a_page_logs_it_and_takes_its_queued_rewrite(tmp_path):
    settings, storage, objects = local(tmp_path)
    project = storage.create_project("reader", "Reading")
    storage.add_paper("reader", project["id"], {"id": "p1", "title": "LLaDA", "filename": "p1.pdf", "pages": 2})
    storage.upsert_memory_page("reader", concept("Remasking", sourcePaperId="p1"), max_pages=50)
    storage.upsert_memory_page("reader", concept("Kept", sourcePaperId="p1"), max_pages=50)
    storage.cancel_memory_jobs("reader", kinds=MEMORY_JOB_KINDS)

    with signed_in(settings, storage, objects) as client:
        for slug in ("remasking", "kept"):
            assert client.post(f"/api/memory/pages/{slug}/rewrite").status_code == 200
        assert client.delete("/api/memory/pages/remasking").status_code == 204
        assert client.delete("/api/memory/pages/remasking").status_code == 404

    assert [job["payload"]["pageSlug"] for job in storage.list_memory_jobs("reader") if job["kind"] == "page-rewrite"] == ["kept"]
    logged = storage.list_memory_events("reader")[0]
    assert (logged["kind"], logged["edits"]) == ("delete", [
        {"slug": "remasking", "title": "Remasking", "kind": "concept", "action": "deleted", "note": None},
    ])


def test_deleting_a_page_turns_its_neighbours_links_to_words_and_owes_its_domain_a_composition(tmp_path):
    settings, storage, objects = local(tmp_path)
    storage.upsert_memory_page("reader", concept("Remasking"), max_pages=50)
    storage.upsert_memory_page("reader", concept("KV caching", "Stale for [[remasking|re-masked tokens]]."), max_pages=50)
    storage.upsert_memory_page("reader", {
        "kind": "domain", "slug": "ml", "domain": "ml", "title": "ML", "summary": "How the pages relate.",
        "body": "Caching works against [[remasking]].",
    }, max_pages=50)
    storage.cancel_memory_jobs("reader", kinds=MEMORY_JOB_KINDS)
    for job in storage.list_memory_jobs("reader"):
        storage.clear_memory_job("reader", job["marker"])

    with signed_in(settings, storage, objects) as client:
        assert client.delete("/api/memory/pages/remasking").status_code == 204
        backlinks = client.get("/api/memory/pages/kv-caching").json()

    assert storage.get_memory_page("reader", "kv-caching")["body"] == "Stale for re-masked tokens."
    assert storage.get_memory_page("reader", "ml")["body"] == "Caching works against Remasking."
    for slug in ("kv-caching", "ml"):
        assert storage.list_page_versions("reader", slug)[0]["note"] == LINK_REPAIR_NOTE
    assert backlinks["page"]["links"] == []
    # Its domain no longer holds it: the domain page is composed again, from what stands.
    assert [job["marker"] for job in storage.list_memory_jobs("reader") if job["kind"] == "domain"] == ["domain:ml"]


def test_a_document_offers_its_own_page_and_the_concepts_that_cite_only_it(tmp_path):
    settings, storage, objects = local(tmp_path)
    for title, fields in (
        ("LLaDA", {"kind": "source", "sourcePaperId": "p1"}),
        ("Only this one", {"sourcePaperId": "p1", **cites("p1", "p1")}),
        ("Also another", {"sourcePaperId": "p1", **cites("p1", "p2")}),
        ("Written from another", {"sourcePaperId": "p2", **cites("p1")}),
        # A captured web page is a source of its own: with web evidence on, a claim may rest on one.
        ("Also the web", {"sourcePaperId": "p1", "body": "A claim [E1]. Another [E2].", "citations": [
            {"id": 1, "claimType": "author-claim", "paperId": "p1", "page": 1},
            {"id": 2, "claimType": "external", "evidenceId": "ev1", "section": "intro"},
        ]}),
        ("With an inference", {"sourcePaperId": "p1", "body": "A claim [E1]. So [E2].", "citations": [
            {"id": 1, "claimType": "author-claim", "paperId": "p1", "page": 1},
            {"id": 2, "claimType": "derived"},
        ]}),
    ):
        storage.upsert_memory_page("reader", concept(title, **fields), max_pages=50)

    with signed_in(settings, storage, objects) as client:
        offered = client.get("/api/memory/documents/p1/dependents").json()["pages"]
        assert client.get("/api/memory/documents/nothing/dependents").json() == {"pages": []}

    assert sorted((page["title"], page["kind"]) for page in offered) == [
        ("LLaDA", "source"), ("Only this one", "concept"), ("With an inference", "concept")]
    assert offered[0]["kind"] == "source"


def project_of(settings, storage, name, *paper_ids):
    project = storage.create_project("reader", name)["id"]
    for paper_id in paper_ids:
        seed_paper(settings, "reader", project, {"id": paper_id, "title": paper_id.upper(), "kind": "pdf"})
    return project


def test_a_project_offers_each_document_s_page_and_the_concepts_that_cite_only_its_documents(tmp_path):
    settings, storage, objects = local(tmp_path)
    project = project_of(settings, storage, "Diffusion", "p1", "p2")
    project_of(settings, storage, "Elsewhere", "p3")
    for title, fields in (
        ("LLaDA", {"kind": "source", "sourcePaperId": "p1"}),
        ("MMaDA", {"kind": "source", "sourcePaperId": "p2"}),
        ("Outside", {"kind": "source", "sourcePaperId": "p3"}),
        # Kept when its document was deleted earlier: no document in this project wrote it.
        ("Kept from before", {"kind": "source", "sourcePaperId": "gone"}),
        ("Only the first", {"sourcePaperId": "p1", **cites("p1")}),
        # Neither document's own delete offers it; the project's does.
        ("Both of them", {"sourcePaperId": "p1", **cites("p1", "p2")}),
        ("Also outside", {"sourcePaperId": "p2", **cites("p2", "p3")}),
        ("Written outside", {"sourcePaperId": "p3", **cites("p1")}),
        ("Also the web", {"sourcePaperId": "p1", "body": "A claim [E1]. Another [E2].", "citations": [
            {"id": 1, "claimType": "author-claim", "paperId": "p1", "page": 1},
            {"id": 2, "claimType": "external", "evidenceId": "ev1", "section": "intro"},
        ]}),
        ("With an inference", {"sourcePaperId": "p2", "body": "A claim [E1]. So [E2].", "citations": [
            {"id": 1, "claimType": "author-claim", "paperId": "p2", "page": 1},
            {"id": 2, "claimType": "derived"},
        ]}),
    ):
        storage.upsert_memory_page("reader", concept(title, **fields), max_pages=50)

    with signed_in(settings, storage, objects) as client:
        offered = client.get(f"/api/memory/projects/{project}/dependents").json()["pages"]
        alone = client.get("/api/memory/documents/p1/dependents").json()["pages"]

    assert [(page["title"], page["kind"]) for page in offered[:2]] == [("LLaDA", "source"), ("MMaDA", "source")]
    assert sorted(page["title"] for page in offered[2:]) == ["Both of them", "Only the first", "With an inference"]
    assert {page["kind"] for page in offered[2:]} == {"concept"}
    assert all(set(page) == {"slug", "title", "kind"} for page in offered)
    assert "Both of them" not in {page["title"] for page in alone}


def test_an_empty_project_offers_nothing_and_another_reader_s_is_not_found(tmp_path):
    settings, storage, objects = local(tmp_path)
    empty = project_of(settings, storage, "Empty")
    storage.create_account("other", None, "salt", "hash")
    theirs = storage.create_project("other", "Theirs")["id"]
    storage.upsert_memory_page("reader", concept("Unrelated", sourcePaperId="p9", **cites("p9")), max_pages=50)

    with signed_in(settings, storage, objects) as client:
        assert client.get(f"/api/memory/projects/{empty}/dependents").json() == {"pages": []}
        assert client.get(f"/api/memory/projects/{theirs}/dependents").status_code == 404
        assert client.get("/api/memory/projects/nothing/dependents").status_code == 404


def test_with_memory_off_a_project_offers_no_pages(tmp_path):
    settings, storage, objects = local(tmp_path)
    project = project_of(settings, storage, "Diffusion", "p1")
    settings = settings.model_copy(update={"memory_enabled": False})

    with signed_in(settings, storage, objects) as client:
        assert client.get(f"/api/memory/projects/{project}/dependents").status_code == 403


def test_deleting_a_project_with_its_ticked_pages_keeps_the_rest_and_dates_a_kept_page(tmp_path):
    settings, storage, objects = local(tmp_path)
    project = project_of(settings, storage, "Diffusion", "p1", "p2")
    project_of(settings, storage, "Elsewhere", "p3")
    for title, fields in (
        ("LLaDA", {"kind": "source", "sourcePaperId": "p1"}),
        ("MMaDA", {"kind": "source", "sourcePaperId": "p2"}),
        ("Both of them", {"sourcePaperId": "p1", **cites("p1", "p2")}),
        ("Cites both", {"sourcePaperId": "p3", "body": "Builds on [[both-of-them]] [E1].",
                        "citations": [{"id": 1, "claimType": "author-claim", "paperId": "p3", "page": 1}]}),
    ):
        storage.upsert_memory_page("reader", concept(title, **fields), max_pages=50)

    with signed_in(settings, storage, objects) as client:
        offered = client.get(f"/api/memory/projects/{project}/dependents").json()["pages"]
        # What the dialog does: the project, then each ticked page; the reader unticked MMaDA.
        assert client.delete(f"/api/projects/{project}").status_code == 204
        for page in offered:
            if page["slug"] != "mmada":
                assert client.delete(f"/api/memory/pages/{page['slug']}").status_code == 204
        kept = client.get("/api/memory/pages/mmada").json()["page"]

    assert sorted(page["slug"] for page in storage.list_memory_pages("reader", limit=50)) == ["cites-both", "mmada"]
    assert storage.get_memory_page("reader", "cites-both")["body"] == "Builds on Both of them [E1]."
    # The kept page's document is gone, and its deletion is recorded for the card that may offer it back.
    assert deleted_at(storage, "reader", kept) is not None


def test_a_source_page_kept_when_its_document_went_deletes_later_as_any_page_does(tmp_path):
    settings, storage, objects = local(tmp_path)
    project = project_of(settings, storage, "Diffusion", "p1", "p2")
    storage.upsert_memory_page("reader", concept("LLaDA", "The digest.", kind="source", sourcePaperId="p1"), max_pages=50)
    storage.upsert_memory_page(
        "reader", concept("Builds on it", sourcePaperId="p2", **{**cites("p2"), "body": "Builds on [[llada]] [E1]."}),
        max_pages=50,
    )
    key = "knowledge/u/reader/figures/fig1.webp"
    objects.put_text(key, "a figure its digest captured")
    storage.add_memory_figure("reader", {"id": "fig1", "pageSlug": "llada", "caption": "c", "objectKey": key}, max_per_page=6)

    with signed_in(settings, storage, objects) as client:
        assert client.delete(f"/api/projects/{project}/papers/p1").status_code == 204
        # What the page's header reads to offer the delete.
        assert client.get("/api/memory/pages/llada").json()["document"] == {"paperId": "p1", "projectId": None}
        for job in storage.list_memory_jobs("reader"):
            storage.clear_memory_job("reader", job["marker"])
        assert client.delete("/api/memory/pages/llada").status_code == 204
        assert client.get("/api/memory/pages/llada").status_code == 404

    # As a concept's delete leaves Memory: links to it become words, its bytes go,
    # its domain is composed again, and the log names it.
    assert storage.get_memory_page("reader", "builds-on-it")["body"] == "Builds on LLaDA [E1]."
    assert storage.list_page_versions("reader", "builds-on-it")[0]["note"] == LINK_REPAIR_NOTE
    assert not objects.exists(key)
    assert [job["marker"] for job in storage.list_memory_jobs("reader") if job["kind"] == "domain"] == ["domain:ml"]
    logged = next(event for event in storage.list_memory_events("reader") if event["kind"] == "delete")
    assert logged["edits"] == [{"slug": "llada", "title": "LLaDA", "kind": "source", "action": "deleted", "note": None}]


def test_a_project_lists_its_source_pages_as_the_library_rail_does_finished_documents_last(tmp_path):
    settings, storage, objects = local(tmp_path)
    project = project_of(settings, storage, "Diffusion", "p1", "p2", "p3")
    storage.set_paper_done("reader", project, "p1", True)
    for title, paper in (("LLaDA", "p1"), ("MMaDA", "p2"), ("Dream", "p3")):
        storage.upsert_memory_page("reader", concept(title, kind="source", sourcePaperId=paper), max_pages=50)

    with signed_in(settings, storage, objects) as client:
        offered = client.get(f"/api/memory/projects/{project}/dependents").json()["pages"]

    assert [page["title"] for page in offered] == ["MMaDA", "Dream", "LLaDA"]
