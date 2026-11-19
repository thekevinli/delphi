"""The staging area on its own: what it holds, what it counts and what it replaces."""

import pytest

from delphi_core.memory_maintenance.staging import (
    LEFT_MAX_ITEMS, DigestLine, DraftFull, Evidence, LeftItem, MemoryDraft, ShownPage, StagedPage,
)


def page(slug: str, action: str = "edit", **given) -> StagedPage:
    return StagedPage(**{
        "slug": slug, "action": action, "revision": 3 if action == "edit" else 0, "title": slug.title(),
        "aliases": (), "domain": "ml", "summary": "A page.", "body": "Text.", "citations": (), **given,
    })


def test_a_draft_holds_what_the_run_may_cite_and_what_it_was_shown():
    draft = MemoryDraft([Evidence("p1", pages=4), Evidence("x1", kind="external", sections=("s1",))])
    assert set(draft.evidence) == {"p1", "x1"} and draft.evidence["x1"].kind == "external"
    assert draft.max_pages == 2 and draft.staged == () and draft.shown == {}
    first = ShownPage("rope", "concept", 3, "RoPE", "ml", "Rotations.", "Old body.")
    draft.show(first)
    draft.show(ShownPage("rope", "concept", 4, "RoPE", "ml", "Rotations.", "New body."))
    # A later showing replaces an earlier: the labels are those of the last one the run saw.
    assert (draft.shown["rope"].revision, draft.shown["rope"].body) == (4, "New body.")


def test_a_second_write_for_a_page_replaces_the_first_and_keeps_its_place():
    draft = MemoryDraft(max_pages=2)
    assert draft.stage(page("a", note="one")) is None
    assert draft.stage(page("b", "create")) is None
    replaced = draft.stage(page("a", note="two"))
    assert replaced.note == "one"
    assert [(staged.slug, staged.note) for staged in draft.staged] == [("a", "two"), ("b", "")]
    assert draft.staged_page("a").note == "two" and draft.staged_page("c") is None
    assert draft.created == frozenset({"b"})


def test_a_draft_refuses_a_page_beyond_its_cap_and_has_room_again_after_a_discard():
    draft = MemoryDraft(max_pages=2)
    draft.stage(page("a"))
    draft.stage(page("b", "create"))
    assert draft.full_problem("a") is None
    problem = (
        "This run has staged `a`, `b`, and 2 pages are the most one run may write. "
        "Change one of those, or leave `c` for a later run."
    )
    assert draft.full_problem("c") == problem
    with pytest.raises(DraftFull) as refused:
        draft.stage(page("c"))
    assert str(refused.value) == problem and [staged.slug for staged in draft.staged] == ["a", "b"]
    # The checker blocked a page: it is dropped, and the run's other page stands.
    assert draft.discard("b").slug == "b" and draft.discard("b") is None
    assert draft.created == frozenset() and draft.full_problem("c") is None
    draft.stage(page("c"))
    assert [staged.slug for staged in draft.staged] == ["a", "c"]


def test_what_a_run_leaves_is_what_it_handed_on_then_what_it_was_turned_away_from():
    draft = MemoryDraft(max_pages=1)
    assert draft.left == ()
    draft.stage(page("a"))
    draft.full_problem("b")
    draft.full_problem("c")
    # A write turned away for want of room is left even when nothing was handed on.
    assert draft.left == (LeftItem("b"), LeftItem("c"))
    draft.handed_on = (LeftItem("c", "its training recipe, section 4"), LeftItem("New idea", "the distillation step"))
    # What was handed on comes first and says what; a slug it names is not repeated.
    assert draft.left == (LeftItem("c", "its training recipe, section 4"), LeftItem("New idea", "the distillation step"),
                          LeftItem("b"))
    draft.handed_on = tuple(LeftItem(f"idea-{number}") for number in range(LEFT_MAX_ITEMS + 3))
    assert len(draft.left) == LEFT_MAX_ITEMS and draft.left[0] == LeftItem("idea-0")
    assert LeftItem("c", "why", (7,)).stored() == {"target": "c", "what": "why", "evidence": [7]}


def test_a_left_item_is_read_back_as_its_event_keeps_it_and_what_is_not_one_is_not():
    item = LeftItem("Paired rotation", "the pairing, p. 2", (1, 4))
    assert LeftItem.read(item.stored()) == item
    # An event written before items named their lines reads with none.
    assert LeftItem.read({"target": "a", "what": "b"}) == LeftItem("a", "b")
    assert LeftItem.read({"target": "a", "evidence": [3, "4", True, 3]}) == LeftItem("a", "", (3,))
    assert [LeftItem.read(stored) for stored in ("a", {"what": "b"}, {"target": "  "}, None)] == [None] * 4


def test_a_digest_line_is_located_by_a_citation_of_its_own_document_at_its_own_place():
    on_page, in_section = DigestLine(1, page=2), DigestLine(2, section="#Method")
    assert on_page.located_by("p1", {"paperId": "p1", "page": 2}) and on_page.where() == "p. 2"
    assert not on_page.located_by("p1", {"paperId": "p2", "page": 2})
    assert not on_page.located_by("p1", {"paperId": "p1", "page": 2, "noteId": "n1"})
    assert in_section.located_by("w1", {"paperId": "w1", "section": "method"}) and in_section.name == "E2"
    assert not DigestLine(3).located_by("p1", {"paperId": "p1", "section": ""})


def test_what_is_unaccounted_for_is_the_unfiled_lines_no_staged_page_cites_and_nothing_handed_on_names():
    lines = (DigestLine(1, page=1), DigestLine(2, page=2), DigestLine(3, page=3), DigestLine(4, page=4, filed=True))
    draft = MemoryDraft([Evidence("p1", pages=4)], document="p1", digest=lines)
    assert draft.unaccounted() == lines[:3]
    draft.stage(page("a", citations=({"id": 1, "claimType": "author-claim", "paperId": "p1", "page": 2},)))
    draft.handed_on = (LeftItem("b", "", (3,)),)
    assert draft.unaccounted() == (lines[0],)
