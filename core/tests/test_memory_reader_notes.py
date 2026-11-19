"""
What rests on a reader's note is cited to it, and goes when the note goes (`reader_notes.py`).

The cases are the ones the 0.6.3 live check found (`work/plan2/live063`):
a note's arithmetic and its conclusion filed as Delphi's own inference
(`derived`) beside the paper's pages, with no note citation, so that deleting
the note retracted nothing. Admission is tested through `admit`, the door
both write tools use; the deterministic withdrawal through
`reader_notes.without_notes`, which the session's commit runs on a page the
agent left alone.
"""

from delphi_core.memory_maintenance.admit import stage_create, stage_edit
from delphi_core.memory_maintenance.blocks import statements
from delphi_core.memory_maintenance.reader_notes import kept_problems, without_notes, withdrawn
from delphi_core.memory_maintenance.staging import Evidence, ExistingPage, MemoryDraft, ShownPage

PAPER = "a842537c9dd9"
NOTE = "3799c59a4d4c"
OTHER_NOTE = "70d8e4ba1343"
BODY = (
    "## Numerical checks\n"
    "\n"
    "The experiment compares two widths, $n = 500$ and $n = 10000$. [E1]\n"
    "\n"
    "Theorem 2 holds for any $T$ such that the integral stays stochastically bounded. [E2]\n"
)
CITATIONS = (
    {"id": 1, "claimType": "author-claim", "paperId": PAPER, "page": 8, "section": None, "noteId": None, "evidenceId": None},
    {"id": 2, "claimType": "author-claim", "paperId": PAPER, "page": 6, "section": None, "noteId": None, "evidenceId": None},
)
ARITHMETIC = (
    "By calculation, the width ratio is $10{,}000/500 = 20$, giving $20^2 = 400$ times as many hidden-to-hidden "
    "weights, so the stability experiment is not a matched comparison. [E1][N1]"
)


def op(kind, **given):
    return {"op": kind, "block": "", "blocks": [], "markdown": "", "find": "", "with": "", "evidence": [], **given}


def cite(ref, kind="author-claim", **given):
    return {"ref": ref, "claimType": kind, "paperId": PAPER if kind != "derived" else None, **given}


def run(notes=(NOTE, OTHER_NOTE), *, filing=True, gone=(), body=BODY, citations=CITATIONS):
    """A run with the NTK paper and its notes as evidence; `filing` says whether it files them."""
    draft = MemoryDraft([Evidence(PAPER, title="ntk", pages=19, notes=frozenset(notes))], gone_notes=gone,
                        notes=notes if filing else ())
    draft.show(ShownPage("neural-tangent-kernel", "concept", 3, "Neural tangent kernel", "infinite-width-networks",
                         "The NTK.", body, citations=tuple(dict(c) for c in citations)))
    return draft


def edit(draft, operations, citations=(), **given):
    return stage_edit(draft, [], slug="neural-tangent-kernel", operations=operations, citations=list(citations),
                      note="added the reader's check", **given)


# --- a run that files notes ------------------------------------------------


def test_the_readers_arithmetic_written_as_delphis_inference_is_refused_until_it_cites_the_note():
    draft = run()
    said = edit(draft, [op("insert_after", block="b2", markdown=ARITHMETIC)], [cite("N1", "derived")])
    assert said.startswith("Error:") and draft.staged == ()
    assert "is Delphi's own inference ([N1] is derived)" in said and "By calculation, the width ratio" in said
    assert f"this run's notes: {NOTE}, {OTHER_NOTE}" in said and "`reader-note`" in said

    # The same paragraph, with the note it rests on beside the page and the inference.
    said = edit(draft, [op("insert_after", block="b2", markdown=ARITHMETIC + "[N2]")],
                [cite("N1", "derived"), cite("N2", "reader-note", noteId=NOTE)])
    assert said.startswith("Staged") and [page.slug for page in draft.staged] == ["neural-tangent-kernel"]


def test_text_that_cites_nothing_rests_on_a_note_and_a_heading_or_display_maths_states_nothing():
    draft = run()
    said = edit(draft, [op("insert_after", block="b3", markdown="So Figure 1 says little about networks of practical width.")])
    assert said.startswith("Error:") and "cites nothing" in said
    said = edit(draft, [op("insert_after", block="b3", markdown="### Width and parameter count\n\n$$P \\propto n^2$$")])
    assert said.startswith("Staged"), said


def test_what_a_documents_page_says_stands_without_the_note_and_stays_when_it_goes():
    draft = run()
    said = edit(draft, [op("insert_after", block="b3", markdown="The constancy is shown on $[0, T]$ only. [E2]")])
    assert said.startswith("Staged"), said


def test_a_clause_of_inference_added_inside_a_paragraph_needs_the_note_in_that_paragraph():
    draft = run()
    added = {"find": "stochastically bounded. [E2]", "with": "stochastically bounded. [E2] This is not an infinite-time guarantee. [N1]"}
    said = edit(draft, [op("replace_text", block="b3", **added)], [cite("N1", "derived")])
    assert said.startswith("Error:") and "[N1] is derived" in said
    with_note = {**added, "with": added["with"] + "[N2]"}
    said = edit(draft, [op("replace_text", block="b3", **with_note)], [cite("N1", "derived"), cite("N2", "reader-note", noteId=OTHER_NOTE)])
    assert said.startswith("Staged"), said
    # Taking words out of a paragraph writes nothing that could rest on a note.
    said = edit(run(), [op("replace_text", block="b3", find="any $T$ such that ", **{"with": "any $T$ that "})])
    assert "rests on a note" not in said


def test_each_item_of_a_list_carries_its_own_note_and_a_new_page_is_held_to_the_same_rule():
    draft = run()
    body = "## A regime\n\n- The kernel stays fixed during training. [N1]\n- This is lazy training. [N2]\n- It is the reader's view. [N3][N2]"
    refs = [cite("N1", page=6), cite("N2", "derived"), cite("N3", "reader-note", noteId=NOTE)]
    said = stage_create(draft, [ExistingPage("neural-tangent-kernel", "Neural tangent kernel", "concept")], title="Lazy training",
                        domain="infinite-width-networks", summary="A regime.", body=body, citations=refs, note="created")
    assert said.startswith("Error:") and "'- This is lazy training.'" in said and "reader's view" not in said


def test_only_what_an_edit_adds_is_held_to_the_rule():
    listed = BODY + "\n- The ratio is 20. [E3]\n- Widths are 500 and 10000. [E1]\n"
    cited = (*CITATIONS, {"id": 3, "claimType": "derived", "paperId": None, "page": None, "section": None,
                          "noteId": None, "evidenceId": None})
    draft = run(body=listed, citations=cited)
    # A replace that copies an item of Delphi's earlier inference and adds one resting on the note.
    added = "- The ratio is 20. [E3]\n- Widths are 500 and 10000. [E1]\n- The reader finds the comparison unmatched. [N1]"
    said = edit(draft, [op("replace", blocks=["b4"], markdown=added)], [cite("N1", "reader-note", noteId=NOTE)])
    assert said.startswith("Staged"), said
    # The same through replace_text, repeating the item it found.
    found = {"find": "- The ratio is 20. [E3]", "with": "- The ratio is 20. [E3]\n- It is unmatched. [N1]"}
    said = edit(run(body=listed, citations=cited), [op("replace_text", block="b4", **found)],
                [cite("N1", "reader-note", noteId=NOTE)])
    assert said.startswith("Staged"), said
    # A pointer to another page states nothing to rest on anything.
    said = edit(run(), [op("insert_after", block="b3", markdown="See also [[lazy-training]].")])
    assert said.startswith("Staged"), said


def test_marked_maths_is_a_statement_and_inference_written_there_cites_the_note():
    said = edit(run(), [op("insert_after", block="b3", markdown="$$10000/500 = 20,\\quad 20^2 = 400$$ [N1]")],
                [cite("N1", "derived")])
    assert said.startswith("Error:") and "[N1] is derived" in said


def test_a_run_that_files_no_note_may_write_its_own_inference():
    draft = run(filing=False)
    said = edit(draft, [op("insert_after", block="b2", markdown=ARITHMETIC)], [cite("N1", "derived")])
    assert said.startswith("Staged"), said


# --- a note the reader deleted ---------------------------------------------

NOTED = BODY + "\nBy calculation the wider network has 400 times the weights. [E3][E4]\n\n- kept [E1][E3]\n- the reader doubts it [E4]\n"
NOTED_CITATIONS = (
    *CITATIONS,
    {"id": 3, "claimType": "derived", "paperId": None, "page": None, "section": None, "noteId": None, "evidenceId": None},
    {"id": 4, "claimType": "reader-note", "paperId": PAPER, "page": None, "section": None, "noteId": NOTE, "evidenceId": None},
)


def test_what_rested_only_on_a_deleted_note_is_found_statement_by_statement():
    found = withdrawn(NOTED, NOTED_CITATIONS, {NOTE})
    assert [item.text.strip() for item in found] == [
        "By calculation the wider network has 400 times the weights. [E3][E4]", "- the reader doubts it [E4]"]
    assert withdrawn(NOTED, NOTED_CITATIONS, {OTHER_NOTE}) == []


def test_an_edit_that_keeps_the_words_without_the_citation_is_refused():
    draft = run(gone={NOTE}, body=NOTED, citations=NOTED_CITATIONS, filing=False)
    words = "By calculation the wider network has 400 times the weights."
    # Merged into a statement of the paper's, the words stand on nothing that says them.
    said = edit(draft, [op("delete", blocks=["b4"], reason="withdrawn"),
                        op("replace", blocks=["b3"], markdown=BODY.split("\n\n")[2].strip() + " " + words, reason="withdrawn"),
                        op("replace", blocks=["b5"], markdown="- kept [E1][E3]", reason="withdrawn")])
    assert said.startswith("Error:") and "b4 said 'By calculation" in said
    said = edit(draft, [op("replace", blocks=["b4"], markdown=words + " [E3]", reason="withdrawn"),
                        op("replace", blocks=["b5"], markdown="- kept [E1][E3]", reason="withdrawn")])
    assert said.startswith("Error:") and "b4 said 'By calculation the wider network" in said
    assert "on the word of a note the reader deleted" in said and said.count("on the word of") == 1
    # The same words cited to the page that says them stand on that page.
    said = edit(draft, [op("replace", blocks=["b4"], markdown=words + " [N1]", reason="withdrawn"),
                        op("replace", blocks=["b5"], markdown="- kept [E1][E3]", reason="withdrawn")], [cite("N1", page=8)])
    assert said.startswith("Staged"), said
    said = edit(draft, [op("delete", blocks=["b4"], reason="withdrawn"),
                        op("replace", blocks=["b5"], markdown="- kept [E1][E3]", reason="withdrawn")])
    assert said.startswith("Staged"), said
    staged = draft.staged[0]
    assert kept_problems(NOTED, NOTED_CITATIONS, {NOTE}, staged.body, staged.citations) == []


def test_a_page_the_agent_left_alone_loses_what_rested_only_on_the_note_and_nothing_else():
    body, citations = without_notes(NOTED + "\n| a | b |\n|---|---|\n| x | the reader's row [E4] |\n\nLast. [E2]\n", NOTED_CITATIONS, {NOTE})
    assert body == BODY + "\n- kept [E1][E3]\n\nLast. [E2]\n"
    assert [item["id"] for item in citations] == [1, 2, 3]
    # A statement that also cites the paper keeps its words, without the note's marker.
    mixed, _ = without_notes(BODY + "\nThe paper's widths, as the reader read them. [E1][E4]", NOTED_CITATIONS, {NOTE})
    assert mixed == BODY + "\nThe paper's widths, as the reader read them. [E1]"
    # A nested item is a statement of its own, and a block that goes whole keeps two paragraphs two.
    nested, _ = without_notes("Intro [E1]:\n- the paper's [E1]\n  - the reader's [E3][E4]\n\nNext [E2].\n",
                              NOTED_CITATIONS, {NOTE})
    assert nested == "Intro [E1]:\n- the paper's [E1]\n\nNext [E2].\n"
    joined, _ = without_notes("Intro [E1]:\n- x [E4]\n- y [E3][E4]\n\nNext [E2].\n", NOTED_CITATIONS, {NOTE})
    assert joined == "Intro [E1]:\n\nNext [E2].\n"
    # Asked to keep the words, it takes off the markers and the citations only.
    kept, cited = without_notes(NOTED, NOTED_CITATIONS, {NOTE}, withdraw=False)
    assert "the reader doubts it\n" in kept and "[E4]" not in kept and [item["id"] for item in cited] == [1, 2, 3]


def test_a_statement_is_a_paragraph_an_item_a_row_or_marked_maths_and_never_a_heading_code_or_a_figure():
    body = (
        "## Heading\n\nA paragraph [E1].\n\n- an item [E2]\n  continued\n    - nested [E5]\n- another [E3]\n\n"
        "| a | b |\n|:--|--:|\n| 1 | 2 [E4] |\n\n$$x = 1$$\n\n$$y = 2$$ [E6]\n\n![a figure](figure:abc123)\n\n"
        "```\ncode [E9]\n```\n\n|x| is a norm, not a table [E7].\n"
    )
    assert [(item.block, item.text) for item in statements(body)] == [
        ("b2", "A paragraph [E1]."), ("b3", "- an item [E2]\n  continued\n"), ("b3", "    - nested [E5]\n"),
        ("b3", "- another [E3]"), ("b4", "| 1 | 2 [E4] |"), ("b6", "$$y = 2$$ [E6]"),
        ("b9", "|x| is a norm, not a table [E7]."),
    ]
    assert all(body[item.start:item.end] == item.text for item in statements(body))
