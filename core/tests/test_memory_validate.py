"""
The deterministic checks on a Memory edit (plan tests V3 and V4, with links and shape).

Each check answers in sentences an agent can act on, so the tests pin the
sentences: a refusal that stopped naming its block or its marker would still
be a refusal, and no longer one the agent could fix.
"""

from delphi_core.memory_maintenance.ops import apply_operations
from delphi_core.memory_maintenance.validate import (
    CONCEPT_LIMITS,
    DOMAIN_LIMITS,
    REASONS,
    BodyLimits,
    _LINK,
    calculation_problems,
    evaluate,
    malformed_math_in_body,
    preservation_problems,
    repair_links,
    shape_problems,
)
from delphi_core.research_digest import malformed_math_in_body as the_digests_rule
from delphi_core.storage.base import WIKI_LINK

FILLER = "Background that no operation touches, long enough that a small edit is a small share. " * 6
PAGE = (
    "## Position encoding\n\n"
    "Sinusoidal encodings add a fixed signal to each token [E1].\n\n"
    "Learned encodings are a table of vectors [E2], see [[attention]].\n\n"
    f"{FILLER}\n"
)
CITATIONS = [{"id": 1, "claimType": "derived"}, {"id": 2, "claimType": "derived"}]
NEW = [{"ref": "N1", "claimType": "author-claim", "paperId": "p-b", "page": 2}]


def problems(operations, **options):
    edit = apply_operations(PAGE, operations, citations=CITATIONS, new_citations=NEW)
    assert edit.ok, edit.problems
    return preservation_problems(PAGE, edit.changes, **options)


def test_an_edit_that_only_adds_to_the_page_passes_without_a_reason():
    assert problems([
        {"op": "replace", "blocks": ["b3"], "markdown": (
            "Learned encodings are a table of vectors [E2], trained with the model [N1], see [[attention]]."
        )},
        {"op": "insert_after", "block": "b4", "markdown": "A new paragraph [N1]."},
        {"op": "replace_text", "block": "b2", "find": "a fixed signal", "with": "a fixed sinusoidal signal"},
    ]) == []


def test_rewording_the_pages_text_needs_a_reason_and_there_is_none_for_shortening():
    # Round 1 of the evaluation: edits "condensed" blocks the event never touched,
    # and the earlier text of a page stopped surviving word for word.
    reworded = {"op": "replace", "blocks": ["b3"], "markdown": "Learned encodings [E2] are trained with [[attention]] [N1]."}
    assert problems([reworded]) == [
        "Operation 1 (replace) on b3 changes 7 words of the page's text ('a table of vectors [E2], see [[attention]].') "
        "and states no `reason`. Text a page keeps keeps its words: add yours around it, or, where the "
        "evidence supersedes, contradicts or repeats it, use `replace` with that reason.",
    ]
    assert problems([{**reworded, "reason": "duplicate"}]) == []
    assert problems([{**reworded, "reason": "condensed"}]) == [
        "Operation 1 (replace) on b3 gives the reason 'condensed'; a reason is one of superseded, "
        "contradicted, duplicate, off-topic, moved, withdrawn.",
    ]
    # `replace_text` states no reason, so it may never reword more than a joint.
    assert problems([{"op": "replace_text", "block": "b2", "find": "add a fixed signal to each token",
                      "with": "shift every token by a constant"}]) == [
        "Operation 1 (replace_text) on b2 changes 6 words of the page's text ('add fixed signal to each token') "
        "and states no `reason`. Text a page keeps keeps its words: add yours around it, or, where the "
        "evidence supersedes, contradicts or repeats it, use `replace` with that reason.",
    ]
    # A clause added to a sentence moves its full stop: that is adding, not rewording.
    assert problems([{"op": "replace", "blocks": ["b2"], "markdown": (
        "Sinusoidal encodings add a fixed signal to each token [E1], whose frequencies fall geometrically [N1]."
    )}]) == []


def test_a_vanished_marker_or_link_without_a_reason_is_refused():
    assert problems([{"op": "replace", "blocks": ["b3"], "markdown": "Learned encodings are a table of vectors."}]) == [
        "Operation 1 (replace) on b3 removes [E2], [[attention]] and states no `reason`; keep what is "
        "there, or give one of superseded, contradicted, duplicate, off-topic, moved, withdrawn.",
    ]
    assert problems([{"op": "delete", "blocks": ["b2"]}]) == [
        "Operation 1 (delete) on b2 removes [E1] and states no `reason`; keep what is there, or give "
        "one of superseded, contradicted, duplicate, off-topic, moved, withdrawn.",
    ]
    # A delete says why even when it takes no citation with it.
    assert problems([{"op": "delete", "blocks": ["b1"]}]) == [
        "Operation 1 (delete) on b1 removes text and states no `reason`; keep what is there, or give "
        "one of superseded, contradicted, duplicate, off-topic, moved, withdrawn.",
    ]


def test_replace_text_can_never_remove_a_marker_or_a_link():
    assert problems([{"op": "replace_text", "block": "b3", "find": ", see [[attention]]", "with": ""}]) == [
        "Operation 1 (replace_text) on b3 removes [[attention]]; only a replace or a delete may remove "
        "a citation or a link, and it must state a `reason`.",
    ]
    # The same link written with a label is the same link.
    assert problems([{"op": "replace_text", "block": "b3", "find": "[[attention]]", "with": "[[Attention|attention itself]]"}]) == []


def test_a_stated_reason_lets_a_marker_go_and_two_reasons_need_evidence():
    for reason in ("duplicate", "off-topic"):
        assert problems([{"op": "delete", "blocks": ["b2"], "reason": reason}]) == []
    assert problems([{"op": "delete", "blocks": ["b2"], "reason": "superseded"}]) == [
        "Operation 1 (delete) on b2 says the text is superseded and names no evidence; list in "
        "`evidence` the citation that supersedes it, such as N1.",
    ]
    assert problems([{"op": "replace", "blocks": ["b2"], "markdown": "Rotation replaced it [N1].", "reason": "contradicted"}]) == [
        "Operation 1 (replace) on b2 says the text is contradicted and names no evidence; list in "
        "`evidence` the citation that contradicts it, such as N1.",
    ]
    superseded = [{"op": "replace", "blocks": ["b2"], "markdown": "Rotation replaced it [N1].", "reason": "superseded", "evidence": ["N1"]}]
    assert problems(superseded) == []
    assert problems(superseded, evidence={"N1", "E1", "E2"}) == []
    assert problems(superseded, evidence={"E1", "E2"}) == [
        "Operation 1 (replace) on b2 names N1 as evidence, which is neither a citation this edit "
        "defines nor one the page has.",
    ]


def test_a_reason_outside_the_closed_set_is_refused():
    assert REASONS == ("superseded", "contradicted", "duplicate", "off-topic", "moved", "withdrawn")
    assert problems([{"op": "delete", "blocks": ["b2"], "reason": "tidier"}]) == [
        "Operation 1 (delete) on b2 gives the reason 'tidier'; a reason is one of superseded, "
        "contradicted, duplicate, off-topic, moved, withdrawn.",
    ]


def test_an_edit_may_not_remove_more_than_a_quarter_of_a_body():
    body = "".join(f"Paragraph {number} " + "x" * 487 + ".\n\n" for number in range(10))
    assert len(body) == 5020

    def removal(operations, text=body):
        edit = apply_operations(text, operations)
        assert edit.ok, edit.problems
        return preservation_problems(text, edit.changes)

    two = [{"op": "delete", "blocks": ["b1", "b2"], "reason": "duplicate"}]
    three = [{"op": "delete", "blocks": ["b1", "b2", "b3"], "reason": "duplicate"}]
    assert removal(two) == []
    assert removal(three) == [
        "The edit removes 1,504 of the page's 5,020 characters; one edit may remove at most 1,255 "
        "of them (25%, and never less than 1,000). Keep more of what the page says.",
    ]
    # Text added elsewhere does not pay for text removed here.
    assert len(removal([*three, {"op": "insert_after", "block": "b9", "markdown": "y" * 2000}])) == 1
    # A replacement counts for what it shrinks by, not for what it rewrites.
    rewrite = [{"op": "replace", "blocks": ["b1", "b2", "b3", "b4"], "markdown": "z" * 1990, "reason": "duplicate"}]
    assert removal(rewrite) == []
    assert len(removal([{**rewrite[0], "markdown": "z" * 490}])) == 1


def test_a_short_page_may_lose_a_paragraph_whatever_share_of_it_that_is():
    # A quarter of a three-paragraph page is less than one paragraph of it.
    short = "".join(f"Paragraph {number} " + "x" * 287 + ".\n\n" for number in range(3))
    assert len(short) == 906
    one = apply_operations(short, [{"op": "delete", "blocks": ["b2"], "reason": "duplicate"}])
    assert preservation_problems(short, one.changes) == []
    # The floor is a number of characters, not a licence to empty a page.
    longer = "".join(f"Paragraph {number} " + "x" * 487 + ".\n\n" for number in range(6))
    most = apply_operations(longer, [{"op": "delete", "blocks": ["b1", "b2", "b3"], "reason": "duplicate"}])
    assert preservation_problems(longer, most.changes) == [
        "The edit removes 1,504 of the page's 3,012 characters; one edit may remove at most 1,000 "
        "of them (25%, and never less than 1,000). Keep more of what the page says.",
    ]
    assert preservation_problems(longer, most.changes, removal_floor=0)[0].startswith(
        "The edit removes 1,504 of the page's 3,012 characters; one edit may remove at most 753 "
    )


def test_a_move_is_believed_only_when_the_text_is_inserted_elsewhere():
    body = "".join(f"Paragraph {number} [E{number}] " + "x" * 480 + ".\n\n" for number in range(1, 4))
    citations = [{"id": number, "claimType": "derived", "paperId": None, "page": None, "section": None} for number in range(1, 4)]
    moved = "Paragraph 1 [E1] " + "x" * 480 + "."

    def check(operations):
        edit = apply_operations(body, operations, citations=citations)
        assert edit.ok, edit.problems
        return edit, preservation_problems(body, edit.changes)

    # Deleted here and inserted there: nothing is lost, and nothing counts as removed.
    edit, found = check([
        {"op": "delete", "blocks": ["b1"], "reason": "moved"},
        {"op": "insert_after", "block": "b3", "markdown": moved},
    ])
    assert found == [] and edit.body.count(moved) == 1 and edit.body.startswith("Paragraph 2")
    # Re-wrapped is still moved; reworded is not, and neither is text that went nowhere.
    assert check([
        {"op": "delete", "blocks": ["b1"], "reason": "moved"},
        {"op": "insert_after", "block": "b3", "markdown": "Before it.\n\n" + moved.replace(" ", "\n", 2)},
    ])[1] == []
    refusal = (
        "Operation 1 (delete) on b1 says the text was moved, and no other operation of this edit "
        "inserts it unchanged; insert the same text where it belongs, or give another reason."
    )
    assert check([{"op": "delete", "blocks": ["b1"], "reason": "moved"}])[1] == [refusal]
    assert check([
        {"op": "delete", "blocks": ["b1"], "reason": "moved"},
        {"op": "insert_after", "block": "b3", "markdown": moved.replace("[E1]", "")},
    ])[1] == [refusal]
    # What a replace puts in the block's own place is not where the block went.
    assert check([{"op": "replace", "blocks": ["b1"], "markdown": moved + " And more.", "reason": "moved"}])[1] == [
        refusal.replace("(delete)", "(replace)")
    ]


def test_a_link_with_no_page_becomes_its_words_and_one_that_resolves_is_left():
    body = (
        "See [[rope]], [[rotary-embeddings]], [[Relative Position]] and [[gone|the old idea]].\n"
        "Again [[gone]] and [[rope|RoPE]].\n"
    )
    repaired, slugs = repair_links(body, {"rope"})
    assert repaired == (
        "See [[rope]], rotary embeddings, Relative Position and the old idea.\n"
        "Again gone and [[rope|RoPE]].\n"
    )
    assert slugs == ["rotary-embeddings", "relative-position", "gone"]
    # A page created in the same commit resolves like one that exists.
    assert repair_links(body, {"rope", "rotary-embeddings", "relative-position", "gone"}) == (body, [])


def test_link_repair_leaves_code_alone():
    body = "Index with `m[[0]]`.\n\n```python\nx = [[1, 2]]\n\ny = z[[i]]\n```\n\nThen [[missing]].\n"
    assert repair_links(body, set()) == (body.replace("[[missing]]", "missing"), ["missing"])


def test_the_link_pattern_is_the_stores_with_the_label_captured():
    assert _LINK.pattern.replace("(?:\\|(", "(?:\\|").replace("))?", ")?") == WIKI_LINK.pattern


def calculation(**changed):
    return {
        "expression": "params_big / params_base",
        "inputs": [
            {"name": "params_big", "value": 213e6, "unit": "parameters", "citation": "N1"},
            {"name": "params_base", "value": 65e6, "unit": "parameters", "citation": "E2"},
        ],
        "result": 3.28,
        "unit": "x",
        **changed,
    }


def test_a_correct_derivation_passes():
    assert calculation_problems([calculation()]) == []
    assert calculation_problems([calculation()], citations={"N1", "E2"}) == []
    # Within one per cent is rounding; inputs may also be given by name.
    assert calculation_problems([calculation(result=3.3)]) == []
    assert calculation_problems([{
        "expression": "(d_model * 4) ** 2 / 2 - -1", "result": 2097153, "unit": "",
        "inputs": {"d_model": {"value": 512, "unit": "", "citation": "E1"}},
    }]) == []


def test_an_incorrect_derivation_is_refused_with_both_numbers():
    assert calculation_problems([calculation(), calculation(result=3.4)]) == [
        "Calculation 2 (`params_big / params_base`) comes to 3.27692 with the inputs given, and the "
        "result stated is 3.4; correct the result, the expression or the inputs.",
    ]
    assert calculation_problems([calculation(result=None)]) == [
        "Calculation 1 (`params_big / params_base`) states no numeric result.",
    ]


def test_a_missing_input_is_refused():
    assert calculation_problems([calculation(expression="params_big / params_small")]) == [
        "Calculation 1 (`params_big / params_small`) uses `params_small`, which is not among its "
        "inputs; give every quantity it uses in `inputs`, with its value, unit and citation.",
    ]
    assert calculation_problems([calculation(inputs=[])]) == [
        "Calculation 1 (`params_big / params_base`) uses `params_big`, which is not among its inputs; "
        "give every quantity it uses in `inputs`, with its value, unit and citation.",
    ]


def test_an_input_needs_a_value_and_a_citation():
    rows = [
        {"name": "params_big", "value": "213M", "unit": "parameters", "citation": "N1"},
        {"name": "params_base", "value": 65e6, "unit": "parameters", "citation": ""},
        {"name": "two words", "value": 1, "unit": "", "citation": "N1"},
    ]
    assert calculation_problems([calculation(inputs=rows)]) == [
        "Calculation 1 (`params_big / params_base`): input `params_big` has no numeric value.",
        "Calculation 1 (`params_big / params_base`): input `params_base` has no citation; say where the number comes from.",
        "Calculation 1 (`params_big / params_base`) has an input named 'two words'; name an input as one word, such as d_model.",
    ]
    assert calculation_problems([calculation()], citations={"N1"}) == [
        "Calculation 1 (`params_big / params_base`): input `params_base` cites E2, which is not a "
        "citation of this page or this edit.",
    ]


def test_nothing_but_arithmetic_is_evaluated():
    assert evaluate("2 * (3 + 4) ** 2 / 7 - 1", {}) == (13.0, None)
    assert evaluate("-a + +b", {"a": 1, "b": 2.5}) == (1.5, None)
    arithmetic = "an expression is numbers, its named inputs, + - * / ** and parentheses"
    smuggled = {
        "__import__('os').system('true')": f"contains a function call; {arithmetic}",
        "abs(a)": f"contains a function call; {arithmetic}",
        "a.real": f"contains an attribute lookup; {arithmetic}",
        "a.__class__": f"contains an attribute lookup; {arithmetic}",
        "[a][0]": f"contains an index; {arithmetic}",
        "a if a else 1": f"contains `a if a else 1`; {arithmetic}",
        "a // 2": f"contains `a // 2`; {arithmetic}",
        "a % 2": f"contains `a % 2`; {arithmetic}",
        "a < 2": f"contains `a < 2`; {arithmetic}",
        "True + 1": f"contains `True`; {arithmetic}",
        "'a' * 3": f"contains `'a'`; {arithmetic}",
        "1j * 1j": f"contains `1j`; {arithmetic}",
        "(lambda: 1)()": f"contains a function call; {arithmetic}",
        "(a := 2)": f"contains `(a := 2)`; {arithmetic}",
    }
    for expression, refusal in smuggled.items():
        assert evaluate(expression, {"a": 3.0}) == (None, refusal), expression
    # A name is an input or it is nothing: no builtin, no constant.
    for name in ("open", "pi", "__builtins__", "exit"):
        value, refusal = evaluate(name, {"a": 3.0})
        assert value is None and refusal.startswith(f"uses `{name}`, which is not among its inputs")


def test_arithmetic_with_no_value_is_refused_not_raised():
    unreadable = "cannot be read as arithmetic that has a value"
    assert evaluate("1 / (a - a)", {"a": 3.0}) == (None, "divides by zero with the inputs given")
    assert evaluate("9 ** 9 ** 9", {}) == (None, unreadable)
    assert evaluate("2 +", {}) == (None, unreadable)
    assert evaluate("a; b", {"a": 1, "b": 2}) == (None, unreadable)
    assert evaluate("import os", {}) == (None, unreadable)
    assert evaluate("(-8) ** (1 / 3)", {}) == (None, "takes a fractional power of a negative number")
    assert evaluate("1" + " + 1" * 200, {}) == (None, "needs an expression of at most 300 characters")
    assert evaluate("", {}) == (None, "needs an expression of at most 300 characters")
    assert evaluate(None, {}) == (None, "needs an expression of at most 300 characters")


def test_body_length_is_held_to_the_accept_limit_and_refused_at_the_wall():
    limits = BodyLimits(target=80, accept=120, wall=160)
    assert shape_problems("x" * 120, limits) == []
    assert shape_problems("x" * 121, limits) == [
        "The page body would be 121 characters, and a page is about 80. "
        "Add less, and never shorten what the page already says to make room: what does not fit "
        "belongs on the page for the narrower idea it is about, linked from this one.",
    ]
    assert shape_problems("x" * 160, limits) == [
        "The page body is 160 characters, the most that can be sent, so its end was probably cut "
        "off. A page is about 80 characters; write a shorter one.",
    ]
    assert shape_problems(" \n", limits) == ["The page body is empty."]
    assert (CONCEPT_LIMITS, DOMAIN_LIMITS) == (BodyLimits(8_000, 12_000, 16_000), BodyLimits(12_000, 18_000, 24_000))


def test_a_url_in_a_body_is_refused_outside_code():
    assert shape_problems("See https://example.org/paper?id=1 for more.", CONCEPT_LIMITS) == [
        "The body contains a URL (https://example.org/paper?id=1); a page names its sources through "
        "citations, never an address. Remove it.",
    ]
    assert len(shape_problems("![chart](http://cdn.example.org/a.png)", CONCEPT_LIMITS)) == 1
    assert len(shape_problems("Visit www.example.org today.", CONCEPT_LIMITS)) == 1
    assert shape_problems("Run `curl https://example.org`.\n\n```sh\nwget http://example.org/x\n```\n", CONCEPT_LIMITS) == []
    assert shape_problems("![chart](figure:fig1) and [[attention]] [E1].", CONCEPT_LIMITS) == []


def test_latex_is_held_to_the_rule_a_digest_is():
    assert shape_problems("The rate $\\alpha + beta$ is fixed.", CONCEPT_LIMITS) == [
        "The body's LaTeX is malformed (beta): close every $, write Greek letters as commands such "
        "as \\alpha, and leave no literal \\n inside maths.",
    ]
    assert len(shape_problems("Unclosed $x^2 here.", CONCEPT_LIMITS)) == 1
    assert shape_problems("It costs $5 and $x^2$ is fine, as is\n\n$$\n\\alpha^2\n$$\n", CONCEPT_LIMITS) == []
    # The copy answers as the original does.
    for body in ("$\\alpha + beta$", "$a \\n b$", "Unclosed $x^2 here.", "$$\\text{alpha} + \\pi$$", "$5 and $6", "plain"):
        assert malformed_math_in_body(body) == the_digests_rule(body), body
