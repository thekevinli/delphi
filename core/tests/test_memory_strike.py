"""
What a repair could not mend is struck from new text, and a page checked again is shown only what changed.

The owner's profile lost a whole new page, `muon-optimizer`, over one sentence:
the checker objected to "infinity-norm vector geometry gives SignSGD", the
repair was refused, and the page was dropped. Now the sentence the objection
quotes is taken out and only what changed is checked again.
"""

from delphi_core.memory_maintenance.ops import Change
from delphi_core.memory_maintenance.run import Objection
from delphi_core.memory_maintenance.staging import StagedPage
from delphi_core.memory_maintenance.verify_again import Refused, passed_units, sentences, strike, unit_key, units_of


def cited(number, page):
    return {"id": number, "claimType": "author-claim", "paperId": "p1", "page": page, "section": None,
            "noteId": None, "evidenceId": None}


def page(body, citations, action="create", changes=(), refs=None):
    return StagedPage(
        slug="muon-optimizer", action=action, revision=2 if action == "edit" else 0, title="Muon optimizer", aliases=(),
        domain="optimizers", summary="What Muon does.", body=body, citations=tuple(citations), changes=tuple(changes),
        refs=refs or {},
    )


def why(result):
    """Why a strike was refused, or None when it was made."""
    return result.why if isinstance(result, Refused) else None


def unsupported(quote, finding="unsupported"):
    return Objection("muon-optimizer", finding, quote, "The cited passage does not say this.", "p1", True)


BODY = (
    "## Geometry\n\n"
    "Frobenius geometry gives SGD. Infinity-norm vector geometry gives SignSGD [E1][E2].\n\n"
    "The spectral norm gives the matrix sign of the gradient [E2].\n"
)


def test_the_quoted_sentence_goes_and_its_closing_run_stays_on_the_sentence_before():
    struck = strike(page(BODY, [cited(1, 4), cited(2, 7)]), [unsupported("infinity-norm vector geometry gives SignSGD")])
    assert "SignSGD" not in struck.body
    assert "Frobenius geometry gives SGD. [E1][E2]" in struck.body and "matrix sign of the gradient [E2]" in struck.body
    assert [citation["id"] for citation in struck.citations] == [1, 2]


def test_a_block_left_citing_nothing_goes_and_so_does_a_citation_nothing_names():
    body = "## Geometry\n\nThe angle doubles with every layer [E1]. Training ends early.\n\nThe spectral norm gives the sign [E2].\n"
    struck = strike(page(body, [cited(1, 4), cited(2, 7)]), [unsupported("The angle doubles with every layer")])
    assert "Training ends early" not in struck.body and "doubles" not in struck.body
    assert [citation["id"] for citation in struck.citations] == [2]
    # A sentence before it keeps the run that may have closed it too, and is checked again with it.
    body = "## Geometry\n\nIt is exact. The angle doubles with every layer [E1].\n"
    struck = strike(page(body, [cited(1, 4)]), [unsupported("The angle doubles with every layer")])
    assert "It is exact. [E1]" in struck.body


def test_a_table_row_goes_and_a_table_with_none_left_goes_whole():
    body = "## Results\n\n| Optimizer | Overhead |\n|---|---|\n| Muon | 0.7% [E1] |\n| AdamW | 0% [E2] |\n"
    struck = strike(page(body, [cited(1, 4), cited(2, 5)]), [unsupported("| Muon | 0.7%")])
    assert "| Muon |" not in struck.body and "| AdamW | 0% [E2] |" in struck.body
    struck = strike(struck, [unsupported("| AdamW | 0%")])
    assert why(struck) == "the quote is in more than one row of a table, or its table would be left with no row"


def test_old_text_a_removal_and_a_quote_that_is_not_there_are_never_struck():
    shown = "## Geometry\n\nThe spectral norm gives the matrix sign of the gradient [E2].\n"
    after = "Frobenius geometry gives SGD; infinity-norm geometry gives SignSGD [N1]."
    edit = page(shown + "\n" + after.replace("[N1]", "[E3]") + "\n", [cited(2, 7), cited(3, 4)], action="edit",
                changes=[Change("insert_after", ("b2",), "", after)], refs={"N1": 3})
    assert why(strike(edit, [unsupported("matrix sign of the gradient")], shown)) == "the quote is text the page already held"
    assert why(strike(edit, [unsupported("Frobenius geometry gives SGD", finding="removed")], shown)) == "a removed objection is never struck"
    assert why(strike(edit, [unsupported("nothing like this is on the page")], shown)) == "no single block of the page holds the quote"
    # New text of an edit is struck from the change the checker reads as well as from the body; and
    # an edit left with nothing new is no strike at all.
    assert why(strike(edit, [unsupported("infinity-norm geometry gives SignSGD")], shown)) == "nothing new would be left of the edit"


def test_a_check_passes_unit_by_unit_and_a_renumbered_citation_is_the_same_unit():
    one = page(BODY, [cited(1, 4), cited(2, 7)])
    units = units_of(one, [])
    passed = passed_units({"muon-optimizer": units}, [unsupported("infinity-norm vector geometry gives SignSGD")], {})
    keys = passed["muon-optimizer"]
    # The summary, the heading and the last block passed; the objected block did not.
    assert len(keys) == len(units) - 1
    renumbered = page(BODY.replace("[E2]", "[E9]"), [cited(1, 4), cited(9, 7)])
    assert unit_key("The spectral norm gives the matrix sign of the gradient [E9].", renumbered, "block") == unit_key(
        "The spectral norm gives the matrix sign of the gradient [E2].", one, "block")


# Review of 0.6.4 (PR #146): each case below damaged or passed what it should not have.

def test_a_quote_no_single_unit_holds_passes_nothing_new_on_its_page():
    # A paragraph running into display mathematics: the objected claim spans two blocks.
    body = "## Bound\n\nThe loss is bounded by\n\n$$L \\le C$$ for every run [E1].\n\nUnrelated text [E2].\n"
    one = page(body, [cited(1, 4), cited(2, 7)])
    units = units_of(one, [])
    spanning = unsupported("The loss is bounded by $$L \\le C$$ for every run")
    assert passed_units({"muon-optimizer": units}, [spanning], {}) == {"muon-optimizer": frozenset()}
    earlier = frozenset({"held"})
    assert passed_units({"muon-optimizer": units}, [spanning], {"muon-optimizer": earlier}) == {"muon-optimizer": earlier}


OLD = "## Origins\n\nThe method first appeared in a 2024 blog post [E2]. It was tuned by hand.\n"


def edited(after, op="replace", reason="superseded", before="The method first appeared in a 2024 blog post [E2]. It was tuned by hand."):
    body = OLD.replace(before, after) if before else OLD + "\n" + after + "\n"
    return page(body, [cited(2, 3), cited(3, 9)], action="edit",
                changes=[Change(op, ("b2",), before, after, reason, ("N1",))], refs={"N1": 3})


def test_striking_all_of_a_replacement_never_deletes_what_it_replaced():
    struck = strike(edited("The method was introduced in a 2025 paper [E3]."), [unsupported("introduced in a 2025 paper")], OLD)
    assert why(struck) == "all of a replacement would go, leaving a deletion of what it replaced"


def test_a_strike_that_would_take_old_text_with_it_is_refused():
    # The struck sentence shares its block with an old one that cites nothing of its own.
    after = "It was tuned by hand. The coefficients come from a grid search [E3]."
    one = edited(after, op="replace_text", reason=None, before="It was tuned by hand.")
    assert why(strike(one, [unsupported("The coefficients come from a grid search")], OLD)) == "all of a replacement would go, leaving a deletion of what it replaced"


def test_a_list_item_is_struck_whole_and_a_wrapped_paragraph_never_is():
    listed = "## Steps\n\n- Normalize the update [E1]\n- Scale by the shape\n  for every matrix [E1]\n- Clip at one [E2]\n\nMore [E2].\n"
    struck = strike(page(listed, [cited(1, 4), cited(2, 7)]), [unsupported("Scale by the shape")])
    # An item is one claim, with the line that continues it; the list keeps the rest.
    assert "Scale by the shape" not in struck.body and "for every matrix" not in struck.body
    assert "- Normalize the update [E1]\n- Clip at one [E2]" in struck.body
    alone = "## Steps\n\n- Scale by the shape [E1]\n\nMore [E2].\n"
    assert why(strike(page(alone, [cited(1, 4), cited(2, 7)]), [unsupported("Scale by the shape")])) == "the quote is in more than one item of a list, or its list would be left with none"
    wrapped = "## Steps\n\nNormalize the update first.\nThen scale by the shape [E1].\n\nMore [E2].\n"
    assert why(strike(page(wrapped, [cited(1, 4), cited(2, 7)]), [unsupported("Then scale by the shape")])) == "the quote is in a quotation or a paragraph of several lines"


def test_chinese_sentences_end_at_their_stops_and_abbreviations_end_nothing():
    chinese = "## 范数\n\n当p趋于无穷时退化为SignSGD。这一结论来自范数视角[E1]。谱范数给出msign[E2]。\n\n其他内容[E2]。\n"
    struck = strike(page(chinese, [cited(1, 4), cited(2, 7)]), [unsupported("这一结论来自范数视角")])
    assert "退化为SignSGD" in struck.body and "这一结论" not in struck.body and "谱范数给出msign[E2]。" in struck.body
    figure = "## Results\n\nAs Fig. 2 shows, the loss falls with width [E1]. The gap closes at 1B [E2].\n\nMore [E2].\n"
    assert sentences("As Fig. 2 shows, the loss falls with width [E1]. The gap closes at 1B [E2].") == [
        "As Fig. 2 shows, the loss falls with width [E1].", " The gap closes at 1B [E2]."]
    struck = strike(page(figure, [cited(1, 4), cited(2, 7)]), [unsupported("the loss falls with width")])
    assert "As Fig." not in struck.body and "The gap closes at 1B [E2]." in struck.body


def test_a_strike_that_leaves_no_cited_block_is_refused():
    only = "## Geometry\n\nInfinity-norm vector geometry gives SignSGD [E1].\n\n## Next\n"
    assert why(strike(page(only, [cited(1, 4)]), [unsupported("Infinity-norm vector geometry gives SignSGD")])) == "no cited block would be left"



# Review of round 5b: a strike that left "In contrast to aggregate-loss allocation, it asks …" with
# nothing before it, and took the domain page's only link to the rare-task page with it.

def test_a_sentence_goes_with_the_ones_that_lean_on_it_and_a_paragraph_that_leans_on_it_refuses_the_strike():
    body = ("## Mechanism\n\nRare tasks are retained by a theorem for orthogonal mixtures [E1]. In contrast to "
            "aggregate-loss allocation, it asks which capabilities survive [E2]. Allocation is a separate question [E2].\n\nMore [E2].\n")
    struck = strike(page(body, [cited(1, 4), cited(2, 7)]), [unsupported("a theorem for orthogonal mixtures")])
    # One claim: the sentence and the one that points back at it. What does not lean on it stays.
    assert "orthogonal mixtures" not in struck.body and "it asks which" not in struck.body
    assert "Allocation is a separate question [E2]." in struck.body
    leaning = ("## Mechanism\n\nRare tasks are retained by a theorem [E1]. It is proved for mixtures. It holds at scale. "
               "It is tight [E2].\n\nMore [E2].\n")
    assert why(strike(page(leaning, [cited(1, 4), cited(2, 7)]), [unsupported("Rare tasks are retained by a theorem")])) == "more sentences lean on the one that would go than a strike may take"
    two = "## Mechanism\n\nRare tasks are retained by a theorem for orthogonal mixtures [E1].\n\nIt asks which capabilities survive [E2].\n"
    assert why(strike(page(two, [cited(1, 4), cited(2, 7)]), [unsupported("a theorem for orthogonal mixtures")])) == "the next paragraph opens by referring back to the sentence that would go"


def test_a_strike_is_refused_when_it_takes_the_pages_only_link_to_another_page():
    body = ("## Mechanism\n\n[[rare-task-retention]] explains retention by a theorem [E1]. Allocation is a separate "
            "question [E2].\n\nMore [E2].\n")
    assert why(strike(page(body, [cited(1, 4), cited(2, 7)]), [unsupported("explains retention by a theorem")])) == "a link to another page would go with the sentence"
    linked_twice = body + "\nSee [[rare-task-retention]] for the evidence [E2].\n"
    assert why(strike(page(linked_twice, [cited(1, 4), cited(2, 7)]), [unsupported("explains retention by a theorem")])) is None


def test_a_strike_that_would_take_far_more_than_its_quote_is_refused():
    # Two sentences the split cannot tell apart: no stop between them.
    body = ("## Leverage\n\nLower activation ratios raise efficiency leverage at fixed FLOPs across every budget "
            "studied in the paper and its appendix $A<3\\%$ this does not identify a hardware optimum [E1].\n\nMore [E2].\n")
    assert why(strike(page(body, [cited(1, 4), cited(2, 7)]), [unsupported("this does not identify a hardware optimum")])) == "the sentences around the quote could not be told apart"


def test_in_a_run_that_files_notes_a_strike_never_parts_inference_from_the_note_it_rests_on():
    from delphi_core.memory_maintenance.staging import MemoryDraft
    from delphi_core.memory_maintenance.verify_round import _struck

    note = {"id": 2, "claimType": "reader-note", "paperId": "p1", "page": None, "section": None,
            "noteId": "n1", "evidenceId": None}
    derived = {"id": 3, "claimType": "derived", "paperId": None, "page": None, "section": None,
               "noteId": None, "evidenceId": None}
    body = (
        "## Cost\n\nThe baseline runs at 120 ms [E1].\n\nThe reader finds the comparison unfair to the baseline. "
        "They doubt it holds at scale [E2], so the saving reported is overstated [E3].\n"
    )
    staged = page(body, [cited(1, 4), note, derived])
    objection = [unsupported("They doubt it holds at scale")]
    assert why(strike(staged, objection)) is None  # the strike alone would leave [E3] without [E2]
    draft = MemoryDraft(notes=("n1",))
    draft.stage(staged)
    assert _struck(draft, "muon-optimizer", objection, set()) == "striking it would part Delphi's inference from the note it rests on"
    assert draft.staged_page("muon-optimizer") is staged
    # Where no note is filed, the same strike is made.
    draft = MemoryDraft()
    draft.stage(staged)
    assert _struck(draft, "muon-optimizer", objection, set()) == ""


def test_in_a_run_that_files_notes_a_strike_that_touches_no_note_is_still_made():
    from delphi_core.memory_maintenance.staging import MemoryDraft, ShownPage
    from delphi_core.memory_maintenance.verify_round import _struck

    def cite(number, kind, **given):
        return {"id": number, "claimType": kind, "paperId": "p1", "page": given.get("page"), "section": None,
                "noteId": given.get("note"), "evidenceId": None}

    # A stored paragraph carries Delphi's earlier inference, with no note; the edit adds a
    # document's sentence to it, and the note's own sentence elsewhere.
    shown = "## Cost\n\nThe saving is overstated at scale [E1] [E3].\n\nThe baseline runs at 120 ms [E2].\n"
    shown_cites = (cite(1, "author-claim", page=4), cite(2, "author-claim", page=5), cite(3, "derived"))
    body = ("## Cost\n\nThe saving is overstated at scale [E1] [E3]. The paper measures a 3x speedup [E5].\n\n"
            "The baseline runs at 120 ms [E2].\n\nThe reader doubts the warm start [E4].\n")
    changes = (
        Change("replace", ("b2",), "The saving is overstated at scale [E1] [E3].",
               "The saving is overstated at scale [E1] [E3]. The paper measures a 3x speedup [N2]."),
        Change("insert_after", ("b3",), "", "The reader doubts the warm start [N1]."),
    )
    staged = page(body, [*shown_cites, cite(4, "reader-note", note="n1"), cite(5, "author-claim", page=2)],
                  action="edit", changes=changes, refs={"N1": 4, "N2": 5})
    objection = [unsupported("The paper measures a 3x speedup")]
    for notes in (("n1",), ()):
        draft = MemoryDraft(notes=notes)
        draft.show(ShownPage("muon-optimizer", "concept", 2, "Muon optimizer", "optimizers", "S", shown, citations=shown_cites))
        draft.stage(staged)
        # The inference was never beside the note: striking the paper's sentence takes nothing from it.
        assert _struck(draft, "muon-optimizer", objection, set()) == "", notes


def test_a_parting_the_page_already_had_does_not_refuse_a_strike():
    from delphi_core.memory_maintenance.reader_notes import parted

    note = {"id": 2, "claimType": "reader-note", "paperId": "p1", "page": None, "section": None,
            "noteId": "n1", "evidenceId": None}
    derived = {"id": 3, "claimType": "derived", "paperId": None, "page": None, "section": None,
               "noteId": None, "evidenceId": None}
    cites = [cited(1, 4), note, derived, cited(4, 6)]
    before = ("## Cost\n\nThe reader doubts the saving [E2], so it is overstated [E3].\n\n"
              "Earlier: overstated at scale [E3].\n\nThe paper measures 40 ms [E4]. It is fast [E1].\n")
    after = ("## Cost\n\nThe reader doubts the saving [E2], so it is overstated [E3].\n\n"
             "Earlier: overstated at scale [E3].\n\nIt is fast [E1].\n")
    assert parted(before, cites, after, [c for c in cites if c["id"] != 4], {"n1"}) is False
    parted_after = "## Cost\n\nSo it is overstated [E3].\n\nEarlier: overstated at scale [E3].\n"
    assert parted(before, cites, parted_after, [cited(1, 4), derived], {"n1"}) is True
    # Parting one statement while removing another that carried the same inference alone still parts it.
    cancelled = "## Cost\n\nSo it is overstated [E3].\n\nThe paper measures 40 ms [E4]. It is fast [E1].\n"
    assert parted(before, cites, cancelled, [cited(1, 4), derived, cited(4, 6)], {"n1"}) is True


CONTROL_2 = (
    "In matched roughly 2B-activated models (5e20 FLOPs budget, target loss 0.149), adding HeteroP is the last ablation step. "
    "It lowers the FLOPs needed to reach the target loss from 1.50e20 to 6.27e19 [E4]. "
    "The paper reports the gain over the Chimera-dense baseline as 4.1× [E12]."
)


def _shown(text, signatures=None):
    from types import SimpleNamespace

    return SimpleNamespace(after=text, signatures=signatures or {})


def test_a_claim_is_a_sentence_with_those_that_lean_on_it_an_item_or_a_row_and_never_its_markers():
    from delphi_core.memory_maintenance.verify_claims import claims

    first = ("in matched roughly 2b-activated models (5e20 flops budget, target loss 0.149), adding heterop is the last "
             "ablation step. it lowers the flops needed to reach the target loss from 1.50e20 to 6.27e19.")
    # A later claim of a paragraph is kept under its first, so rewriting the lead-in reopens it.
    assert [key for key, _ in claims(CONTROL_2)] == [first, f"{first} ⟩ the paper reports the gain over the chimera-dense baseline as 4.1×."]
    # A claim is kept by the locators its markers cite; one with none of its own, by the run that closes it.
    assert [cites for _, cites in claims(CONTROL_2, {"E4": "p23", "E12": "p28"})] == [frozenset({"p23"}), frozenset({"p28"})]
    assert [key for key, _ in claims("- Scale by the shape [E1]\n  - for every matrix\n- Clip at one [E2]")] == [
        "- scale by the shape - for every matrix", "- clip at one"]
    # A row is kept under its table's header, and an item under the line that leads into its list.
    assert [key for key, _ in claims("| Model | FLOPs |\n|---|---|\n| Wan | 4.29e20 [E3] |")] == ["model flops", "model flops ⟩ wan 4.29e20"]
    assert [key for key, _ in claims("Each step is cumulative [E1].\n\n- MoE 1.5x [E2]")] == [
        "each step is cumulative.", "each step is cumulative. ⟩ - moe 1.5x"]


def test_a_verdict_stands_while_the_claims_words_and_passages_do():
    from delphi_core.memory_maintenance.verify_claims import already_passed, passed_claims

    def objecting(quote, blocking=True):
        return Objection("p", "unsupported", quote, "x", "doc", blocking=blocking)

    cites = {"E4": "p23", "E9": "p27", "E12": "p28"}
    # Control-2: the first check quotes the clause's sentence, the second another, the third the clause again.
    first = passed_claims({"p": _shown(CONTROL_2, cites)}, [objecting(
        "adding HeteroP is the last ablation step. It lowers the FLOPs needed to reach the target loss from 1.50e20 to 6.27e19.")], {})
    recited = _shown(CONTROL_2.replace("[E4]", "[E4][E9]"), cites)
    second = passed_claims({"p": recited}, [objecting("The paper reports the gain over the Chimera-dense baseline as 4.1×.")], first)
    third = objecting("In matched roughly 2B-activated models (5e20 FLOPs budget, target loss 0.149)")
    assert not already_passed(third, recited, first)
    assert already_passed(third, recited, second)
    # Reworded, with the sentence it leans on reworded, or without a passage it passed on: no check has passed it.
    assert not already_passed(objecting("In matched about 2B-activated models"), _shown(CONTROL_2.replace("roughly", "about"), cites), second)
    leaned_on = _shown(CONTROL_2.replace("[E4]", "[E4][E9]").replace("is the last ablation step", "is the final ablation step"), cites)
    assert not already_passed(objecting("It lowers the FLOPs needed to reach the target loss"), leaned_on, second)
    assert not already_passed(third, _shown(CONTROL_2.replace("[E4]", "[E9]"), cites), second)
    # A claim an objection touched is not passed, even when the objection was only advice.
    advised = passed_claims({"p": _shown(CONTROL_2, cites)}, [objecting("The paper reports the gain", blocking=False)], {})
    assert "the paper reports the gain over the chimera-dense baseline as 4.1×." not in advised["p"]
    # A blocking quote no single block holds once passes nothing new.
    assert passed_claims({"p": _shown(CONTROL_2)}, [objecting("words nowhere on the page at all")], {}) == {}


def test_a_quote_two_blocks_hold_is_placed_in_neither_and_struck_from_neither():
    # Review of 76663a5: the first block holding a quote was taken for the claim the checker meant.
    from delphi_core.memory_maintenance.verify_claims import already_passed, passed_claims

    body = ("## Results\n\nChimera-dense at 2B reaches loss 0.149 at 5e20 FLOPs in Fig. 12 [E1].\n\n"
            "The ablation's HeteroP model reaches loss 0.149 at 5e20 FLOPs [E2].\n")
    quote = "reaches loss 0.149 at 5e20 FLOPs"
    assert passed_claims({"p": _shown(body)}, [Objection("p", "unsupported", quote, "x", "doc", blocking=True)], {}) == {}
    assert why(strike(page(body, [cited(1, 4), cited(2, 7)]), [unsupported(quote)])) == "the quote is in more than one block of the page"
    from delphi_core.memory_maintenance.verify_claims import claims

    # Even with every claim of the page passed, a quote two blocks hold keeps no verdict.
    assert not already_passed(Objection("p", "unsupported", quote, "x", "doc", blocking=True), _shown(body), {"p": dict(claims(body))})


def test_a_struck_claim_takes_its_own_markers_and_a_parent_item_its_nested_items():
    body = ("## Notes\n\nChimera trains a dense baseline [E1]. HeteroP gives 4.1× [E2]. It is the largest gain [E3]. "
            "This holds at 2B [E4].\n\nOther block cites [E5].\n")
    struck = strike(page(body, [cited(n, n) for n in range(1, 6)]), [unsupported("HeteroP gives 4.1×")])
    assert "Chimera trains a dense baseline [E1]." in struck.body and "[E3]" not in struck.body and "[E4]" not in struck.body
    listed = "## Items\n\n- Parent item states X [E1].\n  - child detail of X [E2].\n- Second item states Y [E3].\n\nOther block [E5].\n"
    struck = strike(page(listed, [cited(n, n) for n in (1, 2, 3, 5)]), [unsupported("Parent item states X")])
    assert "child detail" not in struck.body and "- Second item states Y [E3]." in struck.body


def test_an_edits_objection_is_placed_in_what_it_writes_never_in_what_it_replaces():
    # Review of 76663a5: the old text was searched first, so the new claim was recorded as passed.
    from delphi_core.memory_maintenance.verify_claims import already_passed, passed_claims

    written = _shown("Muon is systematically worse than AdamW at every scale and with HeteroP [E7].", {"E7": "p29"})
    first = passed_claims({"s": written}, [Objection("s", "unsupported", "Muon is systematically worse than AdamW", "x", "doc", blocking=True)], {})
    assert "muon is systematically worse than adamw at every scale and with heterop." not in first.get("s", {})
    later = Objection("s", "unsupported", "AdamW at every scale and with HeteroP", "x", "doc", blocking=True)
    assert not already_passed(later, written, first)


def test_an_objection_whose_sentence_already_went_with_a_struck_claim_is_not_a_reason_to_refuse():
    # fixed-1 (Chimera, 2026-10-21): the second objection quoted the sentence the first one's strike took with it.
    body = ("## Muon\n\nIn that paper's comparison, Muon was used for hidden layers [E1]. Its loss was worse than AdamW's [E2].\n\n"
            "Other block cites [E3].\n")
    struck = strike(page(body, [cited(1, 4), cited(2, 5), cited(3, 6)]),
                    [unsupported("Muon was used for hidden layers"), unsupported("Its loss was worse than AdamW's")])
    assert "Muon was used" not in struck.body and "Its loss" not in struck.body and "Other block cites [E3]." in struck.body


def test_an_objection_partly_struck_already_takes_what_is_left_of_it_and_never_skips_a_refusal():
    # Review of ea32993: the "already gone" skip ran before the refusals and left half a quote standing.
    body = ("## Ablation\n\nThe ablation adds parts in turn [E1]. HeteroP alone gives 4.1x. It is the largest step [E2].\n\n"
            "Muon is systematically worse than AdamW at every scale [E3].\n\nOther block [E4].\n")
    cites = [cited(n, n) for n in range(1, 5)]
    first = unsupported("HeteroP alone gives 4.1x")
    in_summary = unsupported("It is the largest step")
    struck = strike(page(body, cites), [first, unsupported("It is the largest step")])
    assert "largest step" not in struck.body and "The ablation adds parts in turn [E1]." in struck.body
    # Its marker went with it, not onto a sentence that cites for itself.
    assert "[E1]. [E2]" not in struck.body and "[E2]" not in struck.body
    summarised = page(body, cites)
    summarised = summarised.__class__(**{**summarised.__dict__, "summary": "It is the largest step of the ablation."})
    assert why(strike(summarised, [first, in_summary])) == "the quote is in the page's summary, which a strike cannot cut"
    # A quote over the struck sentence and the next: the next goes too, rather than being skipped.
    one_block = ("## Ablation\n\nChimera trains on mixed hardware [E1]. HeteroP alone gives 4.1x. "
                 "Muon is systematically worse than AdamW at every scale [E3].\n\nOther block [E4].\n")
    struck = strike(page(one_block, cites), [first, unsupported("gives 4.1x. Muon is systematically worse")])
    assert "Muon is systematically worse" not in struck.body and "Chimera trains on mixed hardware [E1]." in struck.body


def test_an_edit_that_adds_one_bullet_loses_the_bullet_and_keeps_the_rest():
    shown = "## Steps\n\n- Normalize the update [E1]\n\nIt converges faster [E2].\n"
    after_bullet = "- Scale by the shape [N1]"
    after_text = "Clipping keeps it stable [N2]."
    body = "## Steps\n\n- Normalize the update [E1]\n- Scale by the shape [E3]\n\nClipping keeps it stable [E4].\n\nIt converges faster [E2].\n"
    edit = page(body, [cited(n, n) for n in range(1, 5)], action="edit",
                changes=[Change("insert_after", ("b2",), "", after_bullet), Change("insert_after", ("b3",), "", after_text)],
                refs={"N1": 3, "N2": 4})
    struck = strike(edit, [unsupported("Scale by the shape")], shown)
    assert "Scale by the shape" not in struck.body and "Clipping keeps it stable" in struck.body
