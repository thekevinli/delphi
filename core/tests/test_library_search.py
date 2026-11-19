"""
Search over the raw layer: the pure reshaping, the route, and the tool.

The unit cases here pin *properties* of the ranking rather than particular
scores, because the scores are meant to be tuned. What must not change is which
of two sections comes back first.
"""

import json

import pytest
from fastapi.testclient import TestClient

from delphi_core.config import Settings, get_settings
from delphi_core.document_index import (
    build_snippet,
    query_terms,
    rank_hits,
    score_section,
    sections_from_pdf_text,
    sections_from_web_document,
)
from delphi_core.main import app
from delphi_core.document_reads import search_library
from delphi_core.harness.tools import search_library as search_library_tool
from delphi_core.storage import LocalStorage

from tests.helpers import seed_paper

PAGED = (
    "--- Page 1 ---\n\nThe reparameterization trick makes the sampling step "
    "differentiable.\n\n--- Page 2 ---\n\nRelated work.\n\n--- Page 3 ---\n\n   "
)


def test_pdf_pages_become_rows_addressed_the_way_read_paper_addresses_them():
    rows = sections_from_pdf_text(PAGED)

    assert [row["locator"] for row in rows] == ["1", "2"]
    assert rows[0]["kind"] == "page"
    assert rows[0]["ordinal"] == 1
    # An empty page is not an addressable piece; indexing it would return hits
    # with nothing in them.
    assert all(row["text"] for row in rows)


def test_a_pdf_without_page_markers_is_still_findable_as_a_whole():
    # Extraction can produce no markers at all. An unsearchable paper is worse
    # than one that can only be found in one piece.
    rows = sections_from_pdf_text("Loose text with no markers at all.")

    assert len(rows) == 1
    assert rows[0]["locator"] == "1"


def test_pdf_controls_are_removed_before_markers_and_empty_pages_are_checked():
    rows = sections_from_pdf_text(
        "--- Pa\x00ge 1 ---\n\x00\x0c\n--- Page 2 ---\n"
        "Rényi\tα\r\nvari\x00ational \x1b[31mbound\x1b[0m"
    )
    assert [row["locator"] for row in rows] == ["2"]
    assert rows[0]["text"] == "Rényi\tα\r\nvariational bound"
    assert sections_from_pdf_text("--- Page 1 ---\n\x00\x0c") == []
    assert sections_from_pdf_text("\x00\x0c") == []
    assert sections_from_pdf_text("vari\x00ational")[0]["text"] == "variational"


def test_web_controls_are_cleaned_without_inventing_citation_anchors():
    document = {"sections": [
        {"anchor": "result", "title": "Res\x00ult", "markdown": "The bo\x00und."},
        {"anchor": "re\x00sult", "markdown": "A different section."},
        {"anchor": "empty", "markdown": "\x00\x0c"},
        {"anchor": "fallback", "title": "\x00", "markdown": "A body."},
    ]}
    before = json.dumps(document)
    rows = sections_from_web_document(document)
    assert [row["locator"] for row in rows] == ["result", "fallback"]
    assert rows[0]["title"] == "Result"
    assert rows[0]["text"] == "The bound."
    assert rows[1]["title"] == "fallback"
    assert json.dumps(document) == before


def test_web_sections_keep_the_anchor_a_citation_already_uses():
    rows = sections_from_web_document(
        {
            "sections": [
                {"anchor": "why-we-think", "title": "Why we think", "markdown": "Body."},
                {"anchor": "", "title": "Anchorless", "markdown": "Body."},
                {"anchor": "empty", "title": "Empty", "markdown": "   "},
            ]
        }
    )

    assert [row["locator"] for row in rows] == ["why-we-think"]
    assert rows[0]["kind"] == "section"
    assert rows[0]["title"] == "Why we think"


def test_a_query_is_its_distinct_meaningful_words():
    assert query_terms("The variational  autoencoder") == ["variational", "autoencoder"]
    # Repetition must not be a way to change ranking.
    assert query_terms("attention attention") == ["attention"]
    # Accents fold, so a reader typing Renyi finds Rényi.
    assert query_terms("Rényi") == ["renyi"]


def test_covering_the_whole_query_beats_repeating_one_word_of_it():
    covering = score_section(
        ["variational", "autoencoder"], "", "A variational autoencoder."
    )
    repeating = score_section(
        ["variational", "autoencoder"],
        "",
        "variational variational variational variational",
    )

    assert covering > repeating


def test_a_title_match_outranks_the_same_word_in_the_body():
    in_title = score_section(["inference"], "Inference", "Body text.")
    in_body = score_section(["inference"], "Other", "inference")

    assert in_title > in_body


def test_a_short_term_matches_whole_words_only():
    # Prefix matching would make "in" hit every section that says "inference".
    assert score_section(["in"], "", "inference everywhere") == 0


def test_a_term_long_enough_to_mean_something_matches_as_a_prefix():
    # A reader typing "att" should see "attention" before finishing the word.
    assert score_section(["att"], "", "the attention mechanism") > 0


def test_a_snippet_opens_at_the_match_and_marks_what_it_cut():
    body = ("padding " * 60) + "the reparameterization trick " + ("tail " * 60)

    snippet = build_snippet(body, ["reparameterization"], max_chars=80)

    assert "reparameterization" in snippet
    assert snippet.startswith("…") and snippet.endswith("…")
    assert len(snippet) <= 82


def test_equal_scores_come_back_in_document_order_every_time():
    hits = [
        {"score": 1.0, "paperId": "b", "ordinal": 1},
        {"score": 1.0, "paperId": "a", "ordinal": 10},
        {"score": 1.0, "paperId": "a", "ordinal": 2},
        {"score": 5.0, "paperId": "z", "ordinal": 9},
    ]

    ordered = rank_hits(hits, 10)

    # Deterministic to the last row: paging through a search that reshuffles
    # ties silently repeats and drops results.
    assert [(hit["paperId"], hit["ordinal"]) for hit in ordered] == [
        ("z", 9),
        ("a", 2),
        ("a", 10),
        ("b", 1),
    ]


def signed_in(client, settings):
    client.post(
        "/api/auth/register", json={"username": "reader", "password": "password-123"}
    )
    return client.post("/api/projects", json={"name": "Diffusion"}).json()["id"]


def test_uploading_a_paper_makes_it_findable_and_deleting_it_stops(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id = signed_in(client, settings)
            seed_paper(
                settings,
                "reader",
                project_id,
                {"id": "paper-a", "title": "VAE", "filename": "vae.pdf"},
                text=PAGED,
            )
            # Seeding writes the objects directly, as an upload does; the index
            # is rebuilt from those objects rather than from anything in hand.
            storage = LocalStorage(settings)
            from delphi_core.routers.projects import index_paper_sections

            objects = app.state.stores.objects(settings)
            paper = storage.get_paper("reader", project_id, "paper-a")
            index_paper_sections(storage, objects, "reader", project_id, paper)

            found = client.get(
                "/api/library/search", params={"q": "reparameterization"}
            ).json()
            assert [hit["locator"] for hit in found["results"]] == ["1"]
            assert found["results"][0]["paperTitle"] == "VAE"
            assert found["results"][0]["projectName"] == "Diffusion"

            client.delete(f"/api/projects/{project_id}/papers/paper-a")
            after = client.get(
                "/api/library/search", params={"q": "reparameterization"}
            ).json()
            assert after["results"] == []
    finally:
        app.dependency_overrides.clear()


def test_search_requires_a_session(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            assert client.get("/api/library/search", params={"q": "x"}).status_code == 401
    finally:
        app.dependency_overrides.clear()


class _Store:
    """Just enough Storage to drive the tool's prose paths."""

    def __init__(self, hits):
        self.hits = hits
        self.scope = None

    def search_documents(self, username, query, *, project_id=None, limit=12):
        self.scope = project_id
        return self.hits


def test_the_search_tool_names_the_call_that_opens_each_hit():
    settings = Settings()
    store = _Store(
        [
            {
                "paperId": "paper-a",
                "paperTitle": "VAE",
                "projectId": "p1",
                "projectName": "Diffusion",
                "kind": "page",
                "locator": "7",
                "locatorLabel": "p. 7",
                "snippet": "the reparameterization trick",
                "done": False,
            },
            {
                "paperId": "page-b",
                "paperTitle": "Why We Think",
                "projectId": "p2",
                "projectName": "Reading",
                "kind": "section",
                "locator": "thinking-in-tokens",
                "locatorLabel": "Thinking in tokens",
                "snippet": "sampling more tokens",
                "done": True,
            },
        ]
    )

    result = search_library(
        "reparameterization",
        store,
        "reader",
        "p1",
        settings,
        offered=frozenset({"read_paper", "read_webpage"}),
        pdf_ids=frozenset({"paper-a"}),
    )

    # A hit is a pointer. Naming the exact call that opens it is what keeps the
    # model descending the ladder instead of quoting a snippet as evidence.
    assert 'Open with: read_paper(paper_id="paper-a", pages=[7])' in result
    # A search reaches further than a read: the page in another project is
    # found, and is not printed with a call that would only be refused.
    assert "read_webpage(" not in result
    assert "Cannot be opened from this conversation." in result
    assert ", finished)" in result
    # Asked beside a project, the search covers that project.
    assert store.scope == "p1"

    # With nothing offered that reads it, no hit names a call at all; with no
    # project, any PDF in the account opens and nothing needs the caveat.
    assert "Open with" not in search_library(
        "reparameterization",
        store, "reader", "p1", settings,
    )
    account_wide = search_library(
        "reparameterization",
        _Store(store.hits[:1]), "reader", "", settings,
        offered=frozenset({"read_paper"}), pdf_ids=None,
    )
    assert "Open with: read_paper" in account_wide
    assert "cannot be opened" not in account_wide.lower()
    # And any web page in the account opens too, by the section the hit names:
    # the Memory chat reads the library's copy instead of the public original.
    web_wide = search_library(
        "reparameterization",
        _Store(store.hits[1:]), "reader", "", settings,
        offered=frozenset({"read_paper", "read_webpage"}), pdf_ids=None, web_ids=None,
    )
    assert 'Open with: read_webpage(doc_id="' in web_wide
    assert "cannot be opened" not in web_wide.lower()

    # The open document is a PDF and the only one, so no `read_paper` is
    # offered — and a hit inside it is in the request already. Calling that
    # unopenable would tell the model not to quote what it is holding.
    held_whole = search_library(
        "reparameterization",
        _Store(store.hits[:1]), "reader", "p1", settings,
        offered=frozenset({"search_library"}), attached_pdf_ids=frozenset({"paper-a"}),
    )
    assert "Already here: this PDF is attached whole" in held_whole
    assert "cannot be opened" not in held_whole.lower() and "Open with" not in held_whole


def test_the_search_tool_answers_every_failure_in_prose():
    settings = Settings()
    # A raise here would take down an answer that was otherwise fine.
    assert search_library("  ", _Store([]), "reader", "p", settings).startswith("Error:")
    empty = search_library(
        "nothing",
        _Store([]),
        "reader",
        "p",
        settings,
    )
    assert "No stored document" in empty
    assert "lexical" in empty


def test_where_a_search_looks_is_the_conversations_and_never_the_models():
    # A Project question is answered from its project and reaches the rest of
    # the account through Memory; Memory chat has no project and searches all.
    store = _Store([])
    search_library("x", store, "reader", "p1", Settings())
    assert store.scope == "p1"
    search_library("x", store, "reader", "", Settings())
    assert store.scope is None
    for scope in ("project", "account"):
        spec = search_library_tool.tool(search_library_tool.Options(scope=scope)).spec
        assert "scope" not in spec["parameters"]["properties"]



@pytest.mark.anyio
async def test_one_page_longer_than_a_reads_cap_is_read_whole_and_several_pages_are_still_cut(tmp_path):
    """Asking for fewer pages cannot reach the end of one page longer than the cap; only the budget left may cut it."""
    from delphi_core.config import Settings
    from delphi_core.harness.tool import ToolContext
    from delphi_core.harness.tools import read_paper
    from delphi_core.storage import LocalObjectStore, LocalStorage, paper_key

    settings = Settings(_env_file=None, data_dir=tmp_path, paper_tool_max_chars=1_000)
    objects = LocalObjectStore(tmp_path)
    long_page = "An appendix table row. " * 150
    objects.put_text(paper_key("reader", "proj", "p1", "txt"), f"--- Page 1 ---\n{long_page}\n--- Page 2 ---\nShort.")
    ctx = ToolContext(settings=settings, username="reader", project_id="proj", storage=LocalStorage(settings), objects=objects,
                      paper_documents={"p1": {"title": "Paper A", "pages": 2}}, document_chars_left=50_000)

    whole = (await read_paper._run(read_paper.Arguments(paper_id="p1", pages=[1]), ctx)).text
    both = (await read_paper._run(read_paper.Arguments(paper_id="p1", pages=[1, 2]), ctx)).text

    assert long_page.strip() in whole and "truncated" not in whole
    assert "truncated" in both
    ctx.document_chars_left = 600
    assert "truncated" in (await read_paper._run(read_paper.Arguments(paper_id="p1", pages=[1]), ctx)).text
