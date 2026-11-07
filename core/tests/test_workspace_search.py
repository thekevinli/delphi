"""
One search over the whole account, and the rule that makes it a search box.

The unit cases pin *properties* rather than scores — which of two records comes
back, and in what order — because the weights are meant to be tuned and a test
that fails when the ranking improves teaches people to ignore the suite.

The property that must never move is the collective one: a query is one phrase,
so a record carrying half of it is not a weak hit, it is not a hit.
"""

from fastapi.testclient import TestClient

from tests.chat_keys import chat_key
from delphi_core.config import Settings, get_settings
from delphi_core.main import app
from delphi_core.routers.projects import index_paper_sections
from delphi_core.storage import LocalStorage
from delphi_core.workspace_search import (
    Match,
    collapse_matches,
    collapsed_score,
    collective_terms,
    conversation_row,
    score_collective,
    tsquery_all,
)

from tests.helpers import seed_paper

BOTH = (
    "--- Page 1 ---\n\nWe train the metaquery encoder jointly with a frozen "
    "backbone, and the training signal comes from the retrieval head.\n"
)
ONE = (
    "--- Page 1 ---\n\nThe metaquery is passed to the decoder unchanged.\n\n"
    "--- Page 2 ---\n\nSampling is deterministic here.\n"
)
OTHER = (
    "--- Page 1 ---\n\nTraining runs for ninety thousand steps on eight "
    "devices.\n"
)


# --- the collective rule, as a pure function --------------------------------


def test_a_record_missing_any_term_scores_nothing():
    terms = collective_terms("metaquery training")

    assert score_collective(terms, "", "the metaquery encoder") == 0.0
    assert score_collective(terms, "", "training for ninety steps") == 0.0
    assert score_collective(terms, "", "metaquery training runs") > 0.0


def test_the_terms_may_be_spread_across_title_and_body():
    # The gate is about the record, not about one of its fields — which is what
    # the Postgres side says too, welding the columns into one vector.
    terms = collective_terms("metaquery training")

    assert score_collective(terms, "Metaquery", "the training loop") > 0.0


def test_a_contiguous_phrase_outranks_the_same_words_scattered():
    terms = collective_terms("metaquery training")
    together = score_collective(terms, "", "the metaquery training objective")
    apart = score_collective(
        terms, "", "the metaquery is fixed. later, training begins."
    )

    assert together > apart


def test_a_phrase_survives_the_line_break_a_pdf_wrapped_it_on():
    # Stored PDF text carries the source's own wrapping, so a substring test
    # would call this a miss.
    terms = collective_terms("metaquery training")

    assert score_collective(terms, "", "the metaquery\ntraining objective") > 0.0


def test_matching_ignores_case_and_accents():
    assert score_collective(collective_terms("RÉNYI divergence"), "", "renyi divergence") > 0.0
    assert score_collective(collective_terms("metaquery"), "", "MetaQuery") > 0.0


def test_a_single_term_query_earns_no_phrase_bonus():
    # Every single-term match is trivially contiguous, so a bonus there would
    # apply to all of them and rank nothing.
    one = score_collective(collective_terms("training"), "", "training")
    assert one == score_collective(collective_terms("training"), "", "training")
    assert one > 0.0


def test_postgres_is_handed_the_same_rule_and_the_same_prefix_threshold():
    # `&` is the collective rule; `:*` only on terms long enough that a prefix
    # is autocomplete rather than a fragment, matching `count_term` in Python.
    assert tsquery_all(collective_terms("metaquery training")) == (
        "metaquery:* & training:*"
    )
    assert tsquery_all(collective_terms("qk norm")) == "qk & norm:*"


# --- one hit per thing ------------------------------------------------------


def test_every_place_in_one_thing_becomes_one_row():
    rows = collapse_matches([
        Match(owner="paper-a", order=3, score=2.0, payload="third"),
        Match(owner="paper-a", order=1, score=9.0, payload="first"),
        Match(owner="paper-b", order=1, score=5.0, payload="only"),
    ])

    assert [row.owner for row in rows] == ["paper-a", "paper-b"]
    assert rows[0].occurrences == 2
    # The first place in the document, not the strongest — what is quoted must
    # be where the document starts explaining itself, and must not move when
    # the query is retyped.
    assert rows[0].payload == "first"


def test_repetition_lifts_a_hit_without_overturning_a_better_one():
    # Saying it in four places is evidence; it is not four times the answer,
    # and a document that says the phrase once in a sentence written for it
    # still wins.
    assert collapsed_score(10.0, 1) == 10.0
    assert collapsed_score(10.0, 4) > collapsed_score(10.0, 1)
    assert collapsed_score(10.0, 40) < collapsed_score(30.0, 1)


def test_a_place_that_did_not_match_is_not_a_place():
    assert collapse_matches([Match("a", 0, 0.0, "x")]) == []


def test_a_row_names_where_it_came_from_without_naming_ids_the_client_cannot_use():
    row = conversation_row(
        conversation={"id": "c1", "kind": "document_chat", "title": "On metaquery"},
        project={"name": "Diffusion", "slug": "diffusion"},
        paper_slug="metaquery",
        snippet="how is the metaquery encoder trained",
        score=1.0,
    )

    assert row["kind"] == "conversation"
    assert row["title"] == "On metaquery"
    assert row["subtitle"] == "Diffusion"
    assert row["conversationId"] == "c1"


def test_a_memory_conversation_names_itself_rather_than_a_project():
    row = conversation_row(
        conversation={"id": "c2", "kind": "memory_chat", "title": "What next"},
        project=None,
        paper_slug="",
        snippet="",
        score=1.0,
    )

    assert row["subtitle"] == "Memory"


# --- the route, over a real account -----------------------------------------


def signed_in(client):
    client.post(
        "/api/auth/register", json={"username": "reader", "password": "password-123"}
    )
    return client.post("/api/projects", json={"name": "Diffusion"}).json()["id"]


def indexed(settings, project_id, paper_id, title, text):
    seed_paper(
        settings,
        "reader",
        project_id,
        {"id": paper_id, "title": title, "filename": f"{paper_id}.pdf"},
        text=text,
    )
    storage = LocalStorage(settings)
    objects = app.state.stores.objects(settings)
    paper = storage.get_paper("reader", project_id, paper_id)
    index_paper_sections(storage, objects, "reader", project_id, paper)


def test_a_two_word_query_is_one_phrase_not_two_searches(tmp_path):
    """The rule this whole module exists for, seen end to end."""
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id = signed_in(client)
            indexed(settings, project_id, "both", "Unified retrieval", BOTH)
            indexed(settings, project_id, "one", "Decoder notes", ONE)
            indexed(settings, project_id, "other", "Scaling runs", OTHER)

            results = client.get(
                "/api/search", params={"q": "metaquery training"}
            ).json()["results"]

            assert [hit["title"] for hit in results["documents"]] == [
                "Unified retrieval"
            ]

            # Each word alone still finds its own document; it is the pair that
            # is a single question.
            alone = client.get("/api/search", params={"q": "metaquery"}).json()
            assert {hit["title"] for hit in alone["results"]["documents"]} == {
                "Unified retrieval", "Decoder notes"
            }
    finally:
        app.dependency_overrides.clear()


def test_search_reaches_pages_documents_and_chats_in_one_query(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id = signed_in(client)
            indexed(settings, project_id, "both", "Unified retrieval", BOTH)

            storage = LocalStorage(settings)
            storage.upsert_memory_page("reader", {
                "slug": "metaquery-training",
                "kind": "concept",
                "domain": "Retrieval",
                "title": "Metaquery training",
                "summary": "How the metaquery encoder is trained.",
                "body": "The metaquery training objective is contrastive.",
            }, max_pages=400)
            storage.append_message(
                "reader", project_id, chat_key(storage, "reader", project_id, "paper-both"),
                {"role": "user", "content": "how is the metaquery training set up?"},
            )

            results = client.get(
                "/api/search", params={"q": "metaquery training"}
            ).json()["results"]

            assert [hit["slug"] for hit in results["memory"]] == [
                "metaquery-training"
            ]
            assert results["memory"][0]["subtitle"] == "Retrieval"
            assert [hit["title"] for hit in results["documents"]] == [
                "Unified retrieval"
            ]
            assert len(results["conversations"]) == 1
            assert "metaquery" in results["conversations"][0]["snippet"]
    finally:
        app.dependency_overrides.clear()


def test_a_conversation_is_found_by_its_title_as_well_as_its_turns(tmp_path):
    """A title is written from the whole exchange and can name what no one turn said."""
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id = signed_in(client)
            storage = LocalStorage(settings)
            seed_paper(
                settings, "reader", project_id,
                {"id": "paper", "title": "Decoder notes", "filename": "paper.pdf"},
                text="Plain text.",
            )
            storage.append_message(
                "reader", project_id, chat_key(storage, "reader", project_id, "paper-paper"),
                {"role": "user", "content": "how is it wired end to end?"},
            )
            conversation = storage.list_recent_conversations("reader", limit=1)[0]
            storage.set_conversation_title(
                "reader", conversation["id"],
                title="Metaquery training setup",
                model="test-model", updated_at="2026-08-18T00:00:00Z",
            )

            results = client.get(
                "/api/search", params={"q": "metaquery training"}
            ).json()["results"]

            assert [hit["title"] for hit in results["conversations"]] == [
                "Metaquery training setup"
            ]
    finally:
        app.dependency_overrides.clear()


def test_one_document_is_one_row_however_many_pages_say_the_word(tmp_path):
    """The list is of documents; a concordance of one document is not a list."""
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id = signed_in(client)
            indexed(settings, project_id, "one", "Decoder notes", ONE)

            documents = client.get(
                "/api/search", params={"q": "metaquery"}
            ).json()["results"]["documents"]

            assert len(documents) == 1
            assert documents[0]["locator"] == "1"
    finally:
        app.dependency_overrides.clear()


def test_a_deleted_document_stops_being_findable(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id = signed_in(client)
            indexed(settings, project_id, "both", "Unified retrieval", BOTH)

            client.delete(f"/api/projects/{project_id}/papers/both")

            results = client.get(
                "/api/search", params={"q": "metaquery training"}
            ).json()["results"]
            assert results["documents"] == []
    finally:
        app.dependency_overrides.clear()


def test_an_empty_query_answers_with_nothing_rather_than_everything(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id = signed_in(client)
            indexed(settings, project_id, "both", "Unified retrieval", BOTH)

            results = client.get("/api/search", params={"q": "  "}).json()["results"]
            assert results == {"memory": [], "documents": [], "conversations": []}
    finally:
        app.dependency_overrides.clear()


def test_the_result_count_is_clamped_to_the_configured_ceiling(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        workspace_search_max_results=2,
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id = signed_in(client)
            storage = LocalStorage(settings)
            for index in range(5):
                storage.upsert_memory_page("reader", {
                    "slug": f"page-{index}",
                    "kind": "concept",
                    "domain": "Retrieval",
                    "title": f"Metaquery training {index}",
                    "summary": "",
                    "body": "metaquery training",
                }, max_pages=400)

            results = client.get(
                "/api/search", params={"q": "metaquery training", "limit": 50}
            ).json()["results"]
            assert len(results["memory"]) == 2
    finally:
        app.dependency_overrides.clear()


def test_one_account_cannot_search_another(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id = signed_in(client)
            indexed(settings, project_id, "both", "Unified retrieval", BOTH)
            client.post("/api/auth/logout")

            client.post(
                "/api/auth/register",
                json={"username": "stranger", "password": "password-123"},
            )
            results = client.get(
                "/api/search", params={"q": "metaquery training"}
            ).json()["results"]
            assert results == {"memory": [], "documents": [], "conversations": []}
    finally:
        app.dependency_overrides.clear()


def test_search_requires_a_session(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            assert client.get("/api/search", params={"q": "x"}).status_code == 401
    finally:
        app.dependency_overrides.clear()
