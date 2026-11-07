"""The staging area on its own: what it holds, what it counts and what it replaces."""

import pytest

from delphi_core.memory_maintenance.staging import DraftFull, Evidence, MemoryDraft, ShownPage, StagedPage


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
        "Change one of those, or leave `c` for a later run and say so when you finish."
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
