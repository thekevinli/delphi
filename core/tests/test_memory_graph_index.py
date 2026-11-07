"""The active-graph index stays linear, bounded, and one-hop exact."""

from time import perf_counter

from delphi_core.memory_graph_index import MemoryGraphIndex


def page(index: int, *, domain: str = "domain"):
    return {
        "id": f"id-{index}",
        "slug": f"page-{index}",
        "kind": "source" if index == 0 else "concept",
        "domain": domain,
        "title": f"Page {index}",
        "summary": f"Summary {index}",
        "sourcePaperId": "paper-zero" if index == 0 else None,
        "updatedAt": f"2026-01-01T00:{index % 60:02d}:00Z",
        "linkDegree": 0,
    }


def test_thousand_page_ten_thousand_link_index_builds_under_local_budget():
    pages = [page(index) for index in range(1_000)]
    links = [
        {"from": f"page-{source}", "to": f"page-{(source + offset) % 1_000}"}
        for source in range(1_000)
        for offset in range(1, 11)
    ]
    started = perf_counter()
    index = MemoryGraphIndex.build(
        revision=7,
        pages=pages,
        domains=[{"slug": "domain", "title": "Domain"}],
        links=links,
    )
    elapsed = perf_counter() - started

    assert elapsed < 0.5
    assert index.statistics == {
        "pages": 1_000,
        "links": 10_000,
        "domains": 1,
        "unresolvedTargets": 0,
    }
    assert index.pages_by_slug["page-999"]["title"] == "Page 999"
    assert index.source_page_by_paper_id["paper-zero"]["slug"] == "page-0"
    neighborhood = index.neighborhood("page-500", 1)
    assert max(neighborhood["distances"].values()) == 1
    assert len(neighborhood["pages"]) < 30
