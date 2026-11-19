"""Fixed query fixtures exercise retrieval, not a model's opinion of itself."""

import json
import pytest
from delphi_core.memory_graph_index import MemoryGraphIndex
from delphi_core.memory_retrieval import lexical_score, retrieval_terms
from delphi_core.memory_harness import (
    NEIGHBOUR_LEAD_CHARS,
    OPEN_MAX_PAGES,
    memory_index,
    open_memory,
)

pytestmark = pytest.mark.kb_maintenance


def page(slug, domain="ml", **extra):
    return {"slug": slug, "title": slug.replace("-", " "), "kind": "source", "domain": domain,
            "summary": "A compact explanation.", "body": "", **extra}


def index(pages, links=()):
    return MemoryGraphIndex.build(revision=1, pages=pages, domains=[], links=list(links))


def hits(prompt, pages):
    return [{**p, "score": score} for p in pages
            if (score := lexical_score(retrieval_terms(prompt), p)) > 0]


def test_title_beats_summary_beats_body_and_repetition_does_not_help():
    terms = retrieval_terms("Explain attention")
    values = [lexical_score(terms, p) for p in [page("attention"), page("a", summary="attention"), page("b", body="attention " * 100)]]
    assert values[0] > values[1] > values[2] > 0


def reading_graph():
    """Two documents sharing a concept, a third sharing only the domain's page."""
    pages = [
        page("paper-a"), page("paper-b"), page("paper-c"),
        page("shared-idea", kind="concept"), page("ml", kind="domain"),
    ]
    links = [
        {"from": "paper-a", "to": "shared-idea"}, {"from": "paper-b", "to": "shared-idea"},
        {"from": "paper-a", "to": "ml"}, {"from": "paper-b", "to": "ml"}, {"from": "paper-c", "to": "ml"},
    ]
    return index(pages, links)


def test_a_walk_reaches_a_domain_page_but_never_goes_through_one():
    graph = reading_graph()
    reached = graph.walk("paper-a", 2)
    assert {slug: distance for slug, (distance, _) in reached.items()} == {
        "shared-idea": 1, "ml": 1, "paper-b": 2,
    }
    # paper-c shares only the domain with paper-a, which is no relation at all;
    # paper-b is related by the idea, and the walk says through what.
    assert reached["paper-b"][1] == frozenset({"shared-idea"})
    # Asked *of* a domain page, the domain page's own links are still its answer.
    assert set(graph.walk("ml", 1)) == {"paper-a", "paper-b", "paper-c"}


def test_chinese_terms_are_searchable_without_an_english_tokenizer():
    assert lexical_score(retrieval_terms("注意力机制"), page("attention", title="注意力机制")) > 0


def test_reader_center_must_be_a_source_and_neighborhoods_do_not_use_membership():
    graph = index([page("idea", kind="concept", sourcePaperId="paper"), page("sibling")])
    assert "paper" not in graph.source_page_by_paper_id
    assert graph.neighborhood("idea", 2)["distances"] == {"idea": 0}


def test_rail_depth_defaults_to_two_and_is_validated():
    from delphi_core.config import Settings
    from pydantic import ValidationError
    assert Settings(_env_file=None).memory_related_hops == 2
    for depth in (-1, 5):
        with pytest.raises(ValidationError):
            Settings(_env_file=None, memory_related_hops=depth)


# --- the Memory chat's harness: the whole index, then what the model opens ----


def library():
    return [
        {"id": "proj-1", "name": "Inference", "papers": [
            {"id": "pa", "title": "Paper A", "kind": "pdf", "pages": 20},
            {"id": "pz", "title": "A page not filed", "kind": "web", "pages": 3},
        ]},
        {"id": "proj-2", "name": "Empty", "papers": []},
    ]


def filed_graph():
    pages = [
        page("paper-a", sourcePaperId="pa", summary="Serving throughput by reusing attention state."),
        page("paper-b", summary="A second system."), page("paper-c"),
        page("shared-idea", kind="concept", summary="x" * 400), page("ml", kind="domain"),
    ]
    links = [
        {"from": "paper-a", "to": "shared-idea"}, {"from": "paper-b", "to": "shared-idea"},
        {"from": "paper-a", "to": "ml"}, {"from": "paper-b", "to": "ml"}, {"from": "paper-c", "to": "ml"},
    ]
    return index(pages, links)


def test_the_index_names_everything_and_is_the_same_for_every_question():
    """
    Relevance is the model's to decide, so nothing may be missing from what it
    decides over, and nothing in it may depend on the turn: it is one cached
    prefix, and a word of the question in it would be a miss on every request.
    """
    graph = filed_graph()
    chats = [{"title": "How batching works", "projectId": "proj-1", "paperId": "pa"},
             {"title": "Themes in my reading", "projectId": None}, {"title": ""}]
    text, counts = memory_index(graph, library(), chats, 100_000)
    assert counts == {"pages": 5, "documents": 2, "projects": 2, "conversations": 2}
    # Every project and document, each with the id a read needs and where it is filed.
    assert "Inference · project_id proj-1" in text
    assert "Paper A · pdf · 20 pp · paper_id pa · Memory page [[paper-a]]" in text
    assert "A page not filed · web page · paper_id pz · not filed in Memory" in text
    assert "Empty · project_id proj-2\n  (no documents)" in text
    assert "How batching works · Inference › Paper A" in text and "Themes in my reading · Memory" in text
    # Every page by path, with its summary and what it links to, in path order.
    assert "ml/source/paper-a · paper a · Serving throughput by reusing attention state. · → ml, shared-idea" in text
    paths = [line.split(" · ")[0] for line in text.splitlines() if line.startswith("ml/")]
    assert paths == sorted(paths) and len(paths) == 5
    assert memory_index(graph, library(), chats, 100_000)[0] == text


def test_a_long_index_shortens_its_summaries_and_never_drops_a_page():
    graph = filed_graph()
    full, _ = memory_index(graph, library(), [], 100_000)
    tight, counts = memory_index(graph, library(), [], len(full) - 100)
    assert len(tight) < len(full) and counts["pages"] == 5
    for slug in ("paper-a", "paper-b", "paper-c", "shared-idea", "ml"):
        assert f"/{slug} · " in tight
    # Too small for any summary: titles and links alone still name everything.
    bare, _ = memory_index(graph, library(), [], 10)
    assert "Serving throughput" not in bare and "ml/source/paper-a · paper a · → ml, shared-idea" in bare


def test_a_long_documents_source_page_never_squeezes_the_pages_beside_it():
    """
    A long document's source page is its digest, up to three times a standard
    one (`LONGEST_DIGEST_BUDGET`). Opened beside ordinary pages within a
    Project question's Memory budget, those pages still arrive whole, and only
    the long page is cut, from its end, where its least important material is.
    """
    from delphi_core.config import Settings
    from delphi_core.research_digest import LONGEST_DIGEST_BUDGET

    graph = filed_graph()
    bodies = {
        "paper-a": "A finding of the book [E1].\n\n" * (LONGEST_DIGEST_BUDGET.accept_chars // 29),
        "paper-b": "B's digest. " * 1_000,
        "shared-idea": "The idea, explained. " * 500,
    }
    budget = Settings().memory_inline_max_chars
    assert sum(map(len, bodies.values())) > budget
    text, opened, _ = open_memory(["paper-a", "paper-b", "shared-idea"], graph, bodies, budget)
    assert opened == ["paper-a", "paper-b", "shared-idea"]
    assert bodies["paper-b"] in text and bodies["shared-idea"] in text
    assert "[cut here" in text.split("=== [[paper-b]]")[0]


def test_opening_returns_the_chosen_pages_and_the_start_of_what_they_link_to():
    graph = filed_graph()
    bodies = {"paper-a": "A's digest. " * 20, "paper-b": "B's digest.", "paper-c": "C.",
              "shared-idea": "The idea, explained. " * 60, "ml": "Domain page."}
    text, opened, linked = open_memory(["ml/source/paper-a", "[[paper-b]]", "nowhere"], graph, bodies, 20_000)
    assert opened == ["paper-a", "paper-b"]
    assert "=== [[paper-a]] ml/source/paper-a — paper a ===\nA's digest." in text and "B's digest." in text
    # One link out: the idea both share, counted, and cut to its opening lines.
    # The domain's page links to everything in it, so it is never a neighbour.
    assert linked == ["shared-idea"]
    assert "[[shared-idea]] ml/concept/shared-idea — shared idea (linked from 2 of the pages above)" in text
    lead = text.split("(linked from 2 of the pages above)\n  ")[1].split("\n")[0]
    assert len(lead) <= NEIGHBOUR_LEAD_CHARS and lead.endswith("…")
    assert "No page exists at: nowhere" in text
    # A page the model chose is cut before it is dropped.
    bodies["shared-idea"] *= 5
    cut, opened, _ = open_memory(["shared-idea", "paper-c"], graph, bodies, 2_300)
    assert opened == ["shared-idea", "paper-c"] and "[cut here" in cut and "=== [[paper-c]]" in cut
    # Bad calls say what to do instead of failing.
    assert open_memory([], graph, bodies, 1000)[0].startswith("Error:")
    assert open_memory(["nope"], graph, bodies, 1000)[0].startswith("Error: none of those pages exist")
    many = ["paper-a"] * 3 + [f"x{i}" for i in range(20)]
    assert len(open_memory(many, graph, bodies, 9000)[1]) <= OPEN_MAX_PAGES


def test_open_memory_counts_metadata_and_tiny_budgets_exactly():
    from delphi_core.memory_harness import reader_memory_block
    pages = [page(f"p{i}", title="Title"*50) for i in range(8)]
    graph = index(pages)
    bodies = {p['slug']: 'Long body. '*10000 for p in pages}
    detail = lambda slug: {"figures": [{"id": "fig", "caption": 'caption '*400}]*6}
    for limit in (0, 10, 1000, 32000, 60000):
        text, opened, _ = open_memory(list(bodies), graph, bodies, limit, detail)
        assert len(text) <= limit
        inline = reader_memory_block(text, max_chars=limit)['content'][0]['text']
        assert len(inline) <= limit
        if limit == 60000:
            assert opened == list(bodies)
            assert all(f'[[{slug}]]' in text for slug in opened)


def test_maximum_page_index_preserves_every_candidate_above_soft_target():
    pages=[page(f'p{i}-'+('x'*180), title='Title '+('古'*195), summary='summary '*50) for i in range(1000)]
    text,counts=memory_index(index(pages), [], [], 120000)
    assert counts['pages']==1000
    assert len(text)>120000  # A compression target, never a candidate truncation.
    assert len(text)<500000  # Measured envelope for maximum legal page metadata.
    for p in pages: assert '/'+p['slug']+' · ' in text


def test_provider_overflow_is_unavailable_memory_not_empty_selection():
    import httpx
    from delphi_core.memory_harness import provider_error_message
    response=httpx.Response(400, request=httpx.Request('POST','https://provider.test'), text='context_length_exceeded')
    message=provider_error_message(httpx.HTTPStatusError('bad request', request=response.request,response=response))
    assert 'could not be consulted' in message and 'Nothing was silently omitted' in message
