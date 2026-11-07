"""
Block labelling and addressed edits (plan tests V1 and V2).

The promise under test is that an edit changes what it names and nothing else:
the split is lossless, an untouched block comes through byte for byte, and
whatever is wrong with an edit comes back as a sentence, never an exception.
"""

import random

import pytest

from delphi_core.memory_maintenance.blocks import join_blocks, show_page, split_blocks
from delphi_core.memory_maintenance.ops import CITATION_ID_MAX, apply_operations

PAGE = (
    "## Position encoding\n"
    "\n"
    "Sinusoidal encodings add a fixed signal to each token [E1].\n"
    "\n"
    "Learned encodings are a table of vectors [E2], see [[attention]].\n"
    "\n"
    "- absolute\n"
    "- relative\n"
    "\n"
    "The table has $512$ rows and $512$ columns.\n"
)
CITATIONS = [
    {"id": 1, "claimType": "author-claim", "paperId": "p-a", "page": 3, "section": None},
    {"id": 2, "claimType": "author-claim", "paperId": "p-a", "page": 5, "section": None},
]

BODIES = {
    "plain": PAGE,
    "no trailing newline": "# Title\n\nOne paragraph.\n\nAnother",
    "crlf": "## Heading\r\n\r\nFirst paragraph\r\nwraps.\r\n\r\n- a\r\n- b\r\n\r\n```\r\ncode\r\n\r\nmore\r\n```\r\n",
    "nested list": (
        "Intro:\n\n- outer one\n  - inner a\n  - inner b\n\n    A paragraph inside the item.\n\n"
        "- outer two\n\n  ```python\n  x = [[1, 2]]\n\n  y = 3\n  ```\n\n1. first\n2. second\n\nAfter the list.\n"
    ),
    "table": "| Model | BLEU |\n|:------|-----:|\n| base  | 27.3 |\n| big   | 28.4 |\n\nThe big model wins [E1].\n",
    "fenced code": (
        "Before.\n\n```python\ndef f():\n\n    return [[a]]\n\n\n# not a heading\n```\n\n"
        "~~~\n``` inside\n\n~~~\n\nAfter [[slug|label]].\n"
    ),
    "display maths": (
        "The loss is\n$$\nL = -\\sum_i y_i\n\n\\log p_i\n$$\nwhere $y$ is the label.\n\n"
        "\\[\na^2 + b^2\n\n= c^2\n\\]\n\n\\begin{align}\nx &= 1 \\\\\n\ny &= 2\n\\end{align}\n\n$$E = mc^2$$\n"
    ),
    "blockquote": "> A quoted line\n> and another.\n\n> A second quote.\n\nPlain.\n",
    "tight headings": "# One\n## Two\ntext straight after\n### Three\n- item\n",
    "blank edges": "\n\n  \nLeading blank lines.\n\n\n\nMany between.\n\n\n",
    "unclosed fence": "Text.\n\n```\nnever closed\n\nstill code\n",
    "unclosed maths": "$$ a + b\n\nA paragraph, not maths.\n",
    "only whitespace": " \n\n",
    "empty": "",
    "mermaid": "Flow:\n\n```mermaid\ngraph TD\n  A --> B\n\n  B --> C\n```\n",
    "rule and html": "Above\n\n---\n\n<details>\n<summary>More</summary>\n\nHidden.\n\n</details>\n",
}


@pytest.mark.parametrize("name", sorted(BODIES))
def test_split_then_join_is_the_identity(name):
    body = BODIES[name]
    blocks = split_blocks(body)
    assert join_blocks(blocks) == body
    assert [block.id for block in blocks] == [f"b{number}" for number in range(1, len(blocks) + 1)]
    for block in blocks:
        assert block.lead + block.content + block.tail == block.text


def test_split_then_join_is_the_identity_on_shuffled_and_cut_bodies():
    """Property-style: any reordering of real-looking lines, cut anywhere, still joins back."""
    lines = [line for body in BODIES.values() for line in body.splitlines(keepends=True)]
    chooser = random.Random(20261012)
    for _ in range(400):
        body = "".join(chooser.sample(lines, chooser.randint(1, 40)))
        body = body[: chooser.randint(0, len(body))]
        assert join_blocks(split_blocks(body)) == body
        # Showing a page must never fail, whatever the body.
        assert show_page(body).count("<block id=") == len(split_blocks(body))


def contents(body: str) -> list[str]:
    return [block.content for block in split_blocks(body)]


def test_each_kind_of_block_is_one_block():
    assert contents(BODIES["fenced code"]) == [
        "Before.",
        "```python\ndef f():\n\n    return [[a]]\n\n\n# not a heading\n```",
        "~~~\n``` inside\n\n~~~",
        "After [[slug|label]].",
    ]
    assert contents(BODIES["display maths"]) == [
        "The loss is",
        "$$\nL = -\\sum_i y_i\n\n\\log p_i\n$$",
        "where $y$ is the label.",
        "\\[\na^2 + b^2\n\n= c^2\n\\]",
        "\\begin{align}\nx &= 1 \\\\\n\ny &= 2\n\\end{align}",
        "$$E = mc^2$$",
    ]
    assert contents(BODIES["table"]) == [
        "| Model | BLEU |\n|:------|-----:|\n| base  | 27.3 |\n| big   | 28.4 |",
        "The big model wins [E1].",
    ]
    assert contents(BODIES["blockquote"]) == ["> A quoted line\n> and another.", "> A second quote.", "Plain."]
    assert contents(BODIES["tight headings"]) == ["# One", "## Two", "text straight after", "### Three", "- item"]


def test_a_list_keeps_what_is_nested_in_it():
    assert contents(BODIES["nested list"]) == [
        "Intro:",
        "- outer one\n  - inner a\n  - inner b\n\n    A paragraph inside the item.\n\n"
        "- outer two\n\n  ```python\n  x = [[1, 2]]\n\n  y = 3\n  ```\n\n1. first\n2. second",
        "After the list.",
    ]


def test_maths_left_unclosed_does_not_swallow_the_page():
    assert contents(BODIES["unclosed maths"]) == ["$$ a + b", "A paragraph, not maths."]
    # A fence is different: Markdown itself runs an unclosed one to the end.
    assert contents(BODIES["unclosed fence"]) == ["Text.", "```\nnever closed\n\nstill code"]


def test_a_page_is_shown_with_each_block_under_its_label():
    assert show_page("## Title\n\nA paragraph\nof two lines.\n\n- a\n- b\n") == (
        '<block id="b1">\n## Title\n</block>\n'
        '<block id="b2">\nA paragraph\nof two lines.\n</block>\n'
        '<block id="b3">\n- a\n- b\n</block>'
    )
    assert show_page("") == ""
    # Shown with plain newlines, whatever the page stores.
    assert "\r" not in show_page(BODIES["crlf"])


def test_insert_after_a_block_and_at_the_start():
    edit = apply_operations(PAGE, [
        {"op": "insert_after", "block": "b3", "markdown": "Rotary encodings rotate pairs of dimensions."},
        {"op": "insert_after", "block": "start", "markdown": "*Draft.*"},
    ], citations=CITATIONS)
    assert edit.ok and edit.problems == ()
    assert edit.body == (
        "*Draft.*\n\n"
        "## Position encoding\n\n"
        "Sinusoidal encodings add a fixed signal to each token [E1].\n\n"
        "Learned encodings are a table of vectors [E2], see [[attention]].\n\n"
        "Rotary encodings rotate pairs of dimensions.\n\n"
        "- absolute\n- relative\n\n"
        "The table has $512$ rows and $512$ columns.\n"
    )
    assert [change.op for change in edit.changes] == ["insert_after", "insert_after"]


def test_inserting_after_the_last_block_keeps_how_the_page_ended():
    assert apply_operations("One.\n", [{"op": "insert_after", "block": "b1", "markdown": "Two."}]).body == "One.\n\nTwo.\n"
    assert apply_operations("One.", [{"op": "insert_after", "block": "b1", "markdown": "Two.\n\n"}]).body == "One.\n\nTwo."
    assert apply_operations("", [{"op": "insert_after", "block": "start", "markdown": "First."}]).body == "First."
    # New text between a heading and the paragraph tight under it gets its own blank lines.
    assert apply_operations("# H\ntext\n", [{"op": "insert_after", "block": "b1", "markdown": "New."}]).body == (
        "# H\n\nNew.\n\ntext\n"
    )


def test_replace_one_block_and_an_adjacent_run():
    edit = apply_operations(PAGE, [
        {"op": "replace", "blocks": ["b3", "b2"], "markdown": "Both kinds [E1][E2] reach [[attention]].",
         "reason": "duplicate"},
    ], citations=CITATIONS)
    assert edit.ok
    assert edit.body == (
        "## Position encoding\n\n"
        "Both kinds [E1][E2] reach [[attention]].\n\n"
        "- absolute\n- relative\n\n"
        "The table has $512$ rows and $512$ columns.\n"
    )
    (change,) = edit.changes
    assert change.blocks == ("b2", "b3") and change.reason == "duplicate"
    assert change.before == (
        "Sinusoidal encodings add a fixed signal to each token [E1].\n\n"
        "Learned encodings are a table of vectors [E2], see [[attention]]."
    )
    assert change.after == "Both kinds [E1][E2] reach [[attention]]."


def test_delete_blocks_that_are_not_adjacent():
    edit = apply_operations(PAGE, [{"op": "delete", "blocks": ["b4", "b2"], "reason": "off-topic"}], citations=CITATIONS)
    assert edit.ok
    assert edit.body == (
        "## Position encoding\n\n"
        "Learned encodings are a table of vectors [E2], see [[attention]].\n\n"
        "The table has $512$ rows and $512$ columns.\n"
    )
    assert edit.dropped == (1,)
    assert [citation["id"] for citation in edit.citations] == [2]


def test_replace_text_changes_one_occurrence_inside_a_block():
    edit = apply_operations(PAGE, [{"op": "replace_text", "block": "b2", "find": "a fixed signal", "with": "a fixed sinusoid"}], citations=CITATIONS)
    assert edit.ok
    assert edit.body == PAGE.replace("a fixed signal", "a fixed sinusoid")


def test_replace_text_with_no_match_and_with_two_is_refused():
    none = apply_operations(PAGE, [{"op": "replace_text", "block": "b2", "find": "a learned signal", "with": "x"}])
    assert none.problems == (
        "Operation 1 (replace_text): `find` does not occur in b2; copy the text exactly as the page "
        "shows it, or replace the whole block.",
    )
    assert none.body == "" and not none.ok
    two = apply_operations(PAGE, [{"op": "replace_text", "block": "b5", "find": "$512$", "with": "$1024$"}])
    assert two.problems == (
        "Operation 1 (replace_text): `find` occurs 2 times in b5; lengthen it until it occurs once, "
        "or replace the whole block.",
    )
    # Text that exists, but in another block, is not a match.
    assert not apply_operations(PAGE, [{"op": "replace_text", "block": "b3", "find": "a fixed signal", "with": "x"}]).ok


def test_overlapping_operations_are_refused():
    edit = apply_operations(PAGE, [
        {"op": "replace", "blocks": ["b2", "b3"], "markdown": "One."},
        {"op": "replace_text", "block": "b3", "find": "Learned", "with": "Trained"},
        {"op": "delete", "blocks": ["b2"], "reason": "duplicate"},
    ])
    assert edit.problems == (
        "Operation 2 (replace_text) and operation 1 both change b3; operations may not overlap, "
        "so put every change to a block in one operation.",
        "Operation 3 (delete) and operation 1 both change b2; operations may not overlap, "
        "so put every change to a block in one operation.",
    )
    twice = apply_operations(PAGE, [
        {"op": "insert_after", "block": "b1", "markdown": "A."},
        {"op": "insert_after", "block": "b1", "markdown": "B."},
    ])
    assert twice.problems == (
        "Operation 2 (insert_after) inserts after b1, and so does operation 1; put both in one "
        "operation, in the order wanted.",
    )


def test_inserting_after_a_block_another_operation_removes_is_not_an_overlap():
    edit = apply_operations(PAGE, [
        {"op": "delete", "blocks": ["b4"], "reason": "duplicate"},
        {"op": "insert_after", "block": "b4", "markdown": "In its place."},
    ])
    assert edit.ok and "Learned encodings are a table of vectors [E2], see [[attention]].\n\nIn its place.\n\nThe table" in edit.body


def test_an_unknown_block_id_is_refused_by_name():
    edit = apply_operations(PAGE, [
        {"op": "replace", "blocks": ["b9"], "markdown": "x"},
        {"op": "insert_after", "block": "b0", "markdown": "x"},
        {"op": "delete", "blocks": ["b2", "b2"], "reason": "duplicate"},
    ])
    assert edit.problems == (
        "Operation 1 (replace) names b9, which the page does not have; its blocks are b1 to b5.",
        "Operation 2 (insert_after) names b0, which the page does not have; its blocks are b1 to b5.",
        "Operation 3 (delete) names a block twice; name each block once.",
    )
    assert apply_operations("", [{"op": "delete", "blocks": ["b1"]}]).problems == (
        'Operation 1 (delete) names b1, which the page does not have; it is empty, so insert after "start".',
    )


def test_malformed_operations_are_refused_in_sentences_never_raised():
    edit = apply_operations(PAGE, [
        {"op": "append", "markdown": "x"},
        {"op": "replace", "blocks": ["b2"], "markdown": "  \n"},
        {"op": "replace", "blocks": ["b2", "b4"], "markdown": "x"},
        {"op": "replace_text", "block": "b3", "find": "", "with": "x"},
        {"op": "replace_text", "block": "b1", "find": "## Position encoding", "with": ""},
        {"op": "delete", "blocks": "b5"},
        {"op": "insert_after", "block": "b5", "markdown": '<block id="b6">\nText\n</block>'},
        "not an operation",
    ])
    assert edit.problems == (
        "Operation 1 has op 'append'; an operation is insert_after, replace, delete or replace_text.",
        "Operation 2 (replace) has no `markdown`; to remove a block, use delete.",
        "Operation 3 (replace) names blocks that are not next to each other (b2, b4); a replace takes "
        "one block or an unbroken run, so use one operation for each run.",
        "Operation 4 (replace_text) needs `find`, the exact text to change, and `with`, the text to put in its place.",
        "Operation 5 (replace_text): would leave b1 empty; delete the block instead.",
        "Operation 6 (delete) names no block; give block ids as the page showed them, such as b3.",
        "Operation 7 (insert_after) includes a <block> tag; write the Markdown alone, without the labels.",
        "Operation 8 has op None; an operation is insert_after, replace, delete or replace_text.",
    )
    everything = apply_operations("Only.\n", [{"op": "delete", "blocks": ["b1"], "reason": "off-topic"}])
    assert everything.problems == ("The operations would leave the page with no text.",)


@pytest.mark.parametrize("name", sorted(name for name, body in BODIES.items() if len(split_blocks(body)) >= 3))
def test_blocks_no_operation_names_are_preserved_byte_for_byte(name):
    body = BODIES[name]
    blocks = split_blocks(body)
    edit = apply_operations(body, [
        {"op": "replace", "blocks": ["b2"], "markdown": "REPLACED\nover two lines"},
        {"op": "insert_after", "block": "b1", "markdown": "INSERTED"},
    ])
    assert edit.ok
    position = 0
    for block in blocks:
        if block.id == "b2":
            continue
        # Every untouched block is there whole, blank lines included, in order.
        found = edit.body.find(block.text, position)
        assert found >= 0, block.id
        position = found + len(block.text)
    untouched = apply_operations(body, [])
    assert untouched.ok and untouched.body == body


def test_new_text_takes_the_pages_line_ending():
    body = BODIES["crlf"]
    edit = apply_operations(body, [
        {"op": "insert_after", "block": "b2", "markdown": "New\nparagraph."},
        {"op": "replace_text", "block": "b2", "find": "paragraph\nwraps", "with": "paragraph\nstill wraps"},
    ])
    assert edit.ok
    assert "First paragraph\r\nstill wraps.\r\n\r\nNew\r\nparagraph.\r\n\r\n- a\r\n" in edit.body
    assert "\n" not in edit.body.replace("\r\n", "")


def test_new_citations_are_numbered_into_the_pages_sequence():
    edit = apply_operations(PAGE, [
        {"op": "insert_after", "block": "b5", "markdown": "Rotary variants interleave [N2], after [N7] and [E1]."},
        {"op": "replace_text", "block": "b3", "find": "a table", "with": "a trained table [N7]"},
    ], citations=CITATIONS, new_citations=[
        {"ref": "N2", "claimType": "author-claim", "paperId": "p-b", "page": 4},
        {"ref": "N7", "claimType": "external", "evidenceId": "ev1", "section": "s2"},
    ])
    assert edit.ok
    # Numbered in the order the page cites them, after the page's highest id.
    assert edit.refs == {"N7": 3, "N2": 4}
    assert "a trained table [E3] of vectors [E2]" in edit.body
    assert edit.body.endswith("Rotary variants interleave [E4], after [E3] and [E1].\n")
    assert "[N" not in edit.body
    assert list(edit.citations) == [
        *CITATIONS,
        {"id": 3, "claimType": "external", "paperId": None, "page": None, "section": "s2", "noteId": None, "evidenceId": "ev1"},
        {"id": 4, "claimType": "author-claim", "paperId": "p-b", "page": 4, "section": None, "noteId": None, "evidenceId": None},
    ]
    # The model's own text is what the preservation check reads.
    assert edit.changes[0].after == "Rotary variants interleave [N2], after [N7] and [E1]."


def test_citations_no_marker_cites_any_more_are_dropped():
    edit = apply_operations(PAGE, [
        {"op": "replace", "blocks": ["b2"], "markdown": "Sinusoids are superseded by rotation [N1].",
         "reason": "superseded", "evidence": ["N1"]},
    ], citations=CITATIONS, new_citations=[
        {"ref": "N1", "claimType": "author-claim", "paperId": "p-b", "page": 2},
        {"ref": "N2", "claimType": "derived"},
    ])
    assert edit.ok
    # [E1] left with its block; N2 was defined and never cited. The new one does not take 1.
    assert edit.dropped == (1,)
    assert edit.refs == {"N1": 3}
    assert [citation["id"] for citation in edit.citations] == [2, 3]
    assert edit.changes[0].evidence == ("N1",)


def test_citation_mistakes_are_refused_by_name():
    edit = apply_operations(PAGE, [
        {"op": "insert_after", "block": "b5", "markdown": "Claim [N1], and [N3], and [E9]."},
    ], citations=CITATIONS, new_citations=[{"ref": "N1", "claimType": "derived"}])
    assert edit.problems == (
        "The new text cites [N3], and `citations` defines no N3; define it, or remove the marker.",
        "The new text cites [E9], which is not one of this page's citations; cite evidence the page "
        "does not have yet as [N1], [N2], … and define each in `citations`.",
    )
    shapes = apply_operations(PAGE, [], new_citations=[
        {"ref": "E1", "claimType": "derived"}, {"ref": "N1"}, {"ref": "N1"}, {"claimType": "derived"},
    ])
    assert shapes.problems == (
        "A new citation has ref 'E1'; name new citations N1, N2, … and cite them in the text as [N1].",
        "Citation N1 is defined twice; define each reference once.",
        "A new citation has ref None; name new citations N1, N2, … and cite them in the text as [N1].",
    )


def test_a_page_out_of_ids_reuses_dropped_ones_and_then_refuses():
    body = "Old [E98].\n\nKept [E99].\n"
    citations = [{"id": 98, "claimType": "derived"}, {"id": 99, "claimType": "derived"}]
    new = [{"ref": "N1", "claimType": "derived"}]
    edit = apply_operations(body, [
        {"op": "replace", "blocks": ["b1"], "markdown": "New [N1].", "reason": "superseded", "evidence": ["N1"]},
    ], citations=citations, new_citations=new)
    assert edit.ok and edit.refs == {"N1": 1} and edit.body == "New [E1].\n\nKept [E99].\n"
    full = "".join(f"Claim [E{number}].\n\n" for number in range(1, CITATION_ID_MAX + 1))
    refused = apply_operations(
        full, [{"op": "insert_after", "block": "b1", "markdown": "More [N1]."}],
        citations=[{"id": number, "claimType": "derived"} for number in range(1, CITATION_ID_MAX + 1)],
        new_citations=new,
    )
    assert refused.problems == ("The page would carry more than 99 citations; cite fewer sources in this edit.",)
