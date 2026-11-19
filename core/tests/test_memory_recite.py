"""
A true claim cited at the wrong passage of its document is given the right one before any repair.

The pages below are shaped on the evaluation corpus's real cases: the digest
cited the page where a passage continues, a sentence of two facts cited the
page of one of them, a domain page cited the section beside the one that
says it, and a paraphrase shared too few words with its page to be matched.
Delphi finds the passage that holds the claim, by its words or by asking the
finder, and adds it to the sentence's citations; a claim the document holds
nowhere is left to the author's repair, as before.
"""

import json
from pathlib import Path

import httpx
import pytest

from delphi_core.config import Settings
from delphi_core.harness.provider import ResponsesClient
from delphi_core.memory_maintenance.ops import Change
from delphi_core.memory_maintenance.run import EvidenceSet, Objection
from delphi_core.memory_maintenance.staging import Evidence, MemoryDraft, StagedPage
from delphi_core.memory_maintenance.verify import CONTRACT, FIND_CONTRACT
from delphi_core.memory_maintenance.verify_find import CANDIDATES, Ask, accepted, request_text
from delphi_core.memory_maintenance.verify_locate import candidates, locate, terms
from delphi_core.memory_maintenance.verify_recite import reapply, recite

PAGES = {
    1: "Abstract. We study how to allocate a training compute budget between model size and tokens.",
    2: "Section 2 fits a parametric loss to over 400 runs and reads the optimal allocation from it.",
    3: "Appendix B. We include all training FLOPs, including those contributed by the embedding matrices. "
       "We also count embedding matrices in the total parameter count.",
    4: "Table A4. FLOP comparison per sequence: attention, dense blocks and logits, with the backward pass "
       "assumed to cost twice the forward pass.",
    5: "Larger datasets will require extra care to account for train-test overlap, and web data carries "
       "toxic language, biases and private information.",
    6: "References.",
}
CLAIM = "The parameter totals count the embedding matrices, as the FLOP accounting does."
NOWHERE = "The authors trained a 9B-parameter vision transformer on video for three epochs."
SECTIONS = {
    "intro": "Why scaling laws are fitted at all, and what a power law is.",
    "kaplan": "Kaplan et al. count non-embedding parameters and fit a frontier with a different curvature.",
    "reconciling": "Embedding parameters are a non-negligible fraction of small models, so counting them or not "
                   "changes the fitted allocation exponent between the two papers.",
    "trickiness": "Fits are sensitive to how you round the precision and how you average the loss.",
}


def evidence(pages=PAGES, sections=None):
    def passage(citation):
        if citation.get("paperId") == "p1":
            return pages.get(citation.get("page"))
        if citation.get("paperId") == "w1":
            return (sections or {}).get(citation.get("section"))
        return None

    sources = [Evidence("p1", title="Compute-optimal training", pages=len(pages))]
    if sections:
        sources.append(Evidence("w1", title="Scaling laws, carefully", sections=tuple(sections)))
    return EvidenceSet(kind="document", marker="paper:p1", paper_id="p1", sources=tuple(sources), passage=passage)


def staged(body, citations, action="create", changes=(), refs=None):
    draft = MemoryDraft([Evidence("p1", pages=len(PAGES))])
    draft.stage(StagedPage(
        slug="compute-optimal", action=action, revision=3 if action == "edit" else 0, title="Compute-optimal training",
        aliases=(), domain="scaling", summary="How to split compute.", body=body, citations=tuple(citations),
        changes=tuple(changes), refs=refs or {},
    ))
    return draft


def cited(number, page, paper="p1", section=None):
    return {"id": number, "claimType": "author-claim", "paperId": paper, "page": page, "section": section,
            "noteId": None, "evidenceId": None}


def unsupported(quote, source="p1", finding="unsupported"):
    return Objection("compute-optimal", finding, quote, "The cited page does not say this.", source, True)


class Finder:
    """A provider that answers the finder's one call with a script, and records what it was asked."""

    def __init__(self, answer=None):
        self.answer, self.asked = answer or {"claims": []}, []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.asked.append(json.loads(request.content))
        return httpx.Response(200, json={
            "status": "completed", "usage": {"input_tokens": 10, "output_tokens": 5},
            "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(self.answer)}]}],
        })


async def run_recite(draft, objections, *, evidence_set=None, answer=None):
    finder = Finder(answer)
    settings = Settings(openai_api_key="test-key", memory_verify_model="gpt-6.1-sol")
    async with httpx.AsyncClient(transport=httpx.MockTransport(finder)) as http:
        standing, recited, _ = await recite(
            ResponsesClient(http, settings), settings, draft, evidence_set or evidence(), objections,
            timeout=30, use_standard_tier=True,
        )
    return (standing, recited), finder.asked


def test_the_page_that_holds_a_claim_is_found_near_the_page_cited():
    assert locate(CLAIM, PAGES, [4]) == (3,)
    # The page cited already holds it: nothing to move.
    assert locate(CLAIM, PAGES, [3]) == ()
    # Held nowhere, or on too few words to tell: no page.
    assert locate(NOWHERE, PAGES, [4]) == ()
    assert locate("Embedding matrices.", PAGES, [4]) == ()


def test_a_page_far_from_the_citation_must_hold_nearly_all_of_the_claim():
    far = {**{number: f"Filler page {number} on unrelated optimiser settings." for number in range(1, 30)}, 25: PAGES[3]}
    assert locate(CLAIM, far, [2]) == (25,)
    # Only part of the claim, far away: not enough.
    far[25] = "We include all training FLOPs, including the embedding matrices."
    assert locate(CLAIM, far, [2]) == ()


def test_a_nearby_page_loses_to_one_farther_off_that_holds_clearly_more():
    pages = {number: f"Filler page {number} on unrelated optimiser settings." for number in range(1, 30)}
    pages[25] = "Eight experts with top-1 routing in sparse early fusion."
    pages[4] = "Sparse early fusion uses experts with routing."
    # Page 4 is beside the citation and holds most of it; page 25 holds all of it.
    assert locate("Eight-expert, top-1 sparse early fusion routing", pages, [3]) == (25,)


def test_two_passages_that_hold_a_claim_alike_are_left_to_the_finder():
    pages = {number: f"Filler page {number} about optimiser warmup." for number in range(1, 30)}
    pages[2] = "We vary the expert granularity from 2 to 16 and find the optimum between 8 and 12."
    pages[3] = "We vary the expert granularity from 2 to 16 and find the optimum between 8 and 12."
    assert locate("Expert granularity is varied from 2 to 16, with the optimum between 8 and 12.", pages, [11]) == ()


def test_a_saved_page_is_searched_by_its_sections():
    claim = "Counting embedding parameters changes the fitted allocation exponent for small models."
    assert locate(claim, SECTIONS, ["trickiness"]) == ("reconciling",)


def test_terms_ignore_citation_markers_and_spelling_and_read_number_words():
    assert terms("The embeddings [E3] are counted.") == terms("the EMBEDDINGS are   counted")
    assert "#3" not in terms("Counted [E3].")
    assert "#8" in terms("eight activated experts") and "#8" in terms("8 activated experts")
    # A list of numbers is several numbers; a thousands separator is one.
    assert {"#6", "#8"} <= terms("G = 6,8") and "#12500" in terms("12,500 steps")
    assert "#1t" in terms("a 1T-token subset") and "#300m" in terms("a 300M encoder")
    assert terms("masked") & terms("masks") and terms("optimal") & terms("optimum")
    # A Latin word set inside Chinese text is still a word.
    assert "signsg" in terms("此时退化为SignSGD，即SignSGD实际上是范数下的最速梯度下降") and "退化" in terms("此时退化为")


def test_the_candidates_for_the_finder_include_the_passages_beside_the_cited_one():
    chosen = candidates(CLAIM, PAGES, [4], 3)
    assert 3 in chosen and 5 in chosen and 4 not in chosen and chosen == sorted(chosen)


@pytest.mark.anyio
async def test_a_claim_cited_one_page_off_gets_the_page_that_holds_it_and_keeps_the_old_one():
    body = f"## Accounting\n\nIt counts the FLOP table in full. {CLAIM} [E1][E2]\n\nThe rest follows. [E1]\n"
    draft = staged(body, [cited(1, 2), cited(2, 4)])

    (standing, recited), asked = await run_recite(draft, [unsupported(CLAIM)])

    assert standing == [] and asked == []
    assert [(item.slug, item.cited, item.added, item.how) for item in recited] == [("compute-optimal", (2, 4), (3,), "words")]
    page = draft.staged_page("compute-optimal")
    assert f"{CLAIM} [E1][E2][E3]" in page.body and "The rest follows. [E1]\n" in page.body
    assert page.citations[-1] == cited(3, 3)


@pytest.mark.anyio
async def test_a_claim_the_document_holds_nowhere_is_left_for_the_repair():
    body = f"## Accounting\n\n{NOWHERE} [E1]\n"
    draft = staged(body, [cited(1, 4)])
    before = draft.staged_page("compute-optimal")
    objection = unsupported(NOWHERE)

    (standing, recited), asked = await run_recite(draft, [objection])

    assert (standing, recited) == ([objection], [])
    assert draft.staged_page("compute-optimal") is before
    # Words placed it nowhere, so the finder was asked, with the passages most likely to hold it.
    [request] = asked
    assert request["instructions"] == FIND_CONTRACT and request["text"]["format"]["name"] == "memory_claim_passages"
    assert NOWHERE in request["input"][0]["content"][0]["text"]


@pytest.mark.anyio
async def test_the_finders_passage_is_added_only_when_its_sentence_is_on_it():
    paraphrase = "Embedding tables are part of the size the paper reports for each model."
    body = f"## Accounting\n\n{paraphrase} [E1]\n"
    on_page = "We also count embedding matrices in the total parameter count."
    shown = candidates(paraphrase, PAGES, [4], 6)

    draft = staged(body, [cited(1, 4)])
    answer = {"claims": [{"claim": 1, "found": [{"passage": shown.index(3) + 1, "sentence": on_page}]}]}
    (standing, recited), _ = await run_recite(draft, [unsupported(paraphrase)], answer=answer)
    assert standing == [] and [(item.added, item.how) for item in recited] == [((3,), "model")]
    assert f"{paraphrase} [E1][E2]" in draft.staged_page("compute-optimal").body

    # The same sentence said to be on another page is set aside.
    draft = staged(body, [cited(1, 4)])
    answer = {"claims": [{"claim": 1, "found": [{"passage": shown.index(5) + 1, "sentence": on_page}]}]}
    (standing, recited), _ = await run_recite(draft, [unsupported(paraphrase)], answer=answer)
    assert recited == [] and len(standing) == 1


@pytest.mark.anyio
async def test_a_claim_cited_to_the_wrong_section_of_a_saved_page_gets_the_right_one():
    claim = "Counting embedding parameters changes the fitted allocation exponent for small models."
    body = f"## Accounting\n\n{claim} [E1]\n"
    draft = staged(body, [cited(1, None, paper="w1", section="trickiness")])
    (standing, recited), asked = await run_recite(
        draft, [unsupported(claim, source="w1")], evidence_set=evidence(sections=SECTIONS)
    )
    assert standing == [] and asked == [] and recited[0].added == ("reconciling",)
    page = draft.staged_page("compute-optimal")
    assert page.citations[-1] == cited(2, None, paper="w1", section="reconciling") and f"{claim} [E1][E2]" in page.body


@pytest.mark.anyio
async def test_a_number_that_differs_from_its_page_may_be_on_another():
    body = f"## Accounting\n\n{CLAIM} [E1]\n"
    draft = staged(body, [cited(1, 4)])
    (standing, recited), _ = await run_recite(draft, [unsupported(CLAIM, finding="differs")])
    assert standing == [] and recited[0].added == (3,)


@pytest.mark.anyio
async def test_only_a_claim_on_a_passage_of_a_document_of_the_set_is_recited():
    body = f"## Accounting\n\n{CLAIM} [E1]\n"
    draft = staged(body, [cited(1, 4)])
    removed = Objection("compute-optimal", "removed", CLAIM, "It was taken out.", None, True)
    elsewhere = unsupported(CLAIM, source="p9")
    (standing, recited), asked = await run_recite(draft, [removed, elsewhere])
    assert (standing, recited, asked) == ([removed, elsewhere], [], [])


@pytest.mark.anyio
async def test_a_page_already_cited_on_the_page_is_reused_not_added_twice():
    body = f"## Accounting\n\n{CLAIM} [E2]\n\nIt includes embeddings in its FLOPs. [E1]\n"
    draft = staged(body, [cited(1, 3), cited(2, 4)])
    await run_recite(draft, [unsupported(CLAIM)])
    page = draft.staged_page("compute-optimal")
    assert f"{CLAIM} [E2][E1]" in page.body and len(page.citations) == 2


@pytest.mark.anyio
async def test_an_edit_carries_the_new_marker_into_the_change_the_checker_reads():
    shown = "## Accounting\n\nThe rest follows.\n"
    after = f"{CLAIM} [N1]"
    draft = staged(
        f"{shown}\n{CLAIM} [E1]\n", [cited(1, 4)], action="edit",
        changes=[Change("insert_after", ("b2",), "", after)], refs={"N1": 1},
    )
    (standing, recited), _ = await run_recite(draft, [unsupported(f"{CLAIM} [E1]")])
    page = draft.staged_page("compute-optimal")
    assert standing == [] and recited[0].added == (3,)
    assert page.changes[0].after == f"{CLAIM} [N1][E2]" and f"{CLAIM} [E1][E2]" in page.body


@pytest.mark.anyio
async def test_the_passages_found_are_given_again_to_the_page_a_repair_wrote():
    body = f"## Accounting\n\n{CLAIM} [E1]\n"
    draft = staged(body, [cited(1, 4)])
    (_, recited), _ = await run_recite(draft, [unsupported(CLAIM)])
    # The repair writes the page again from the author's operations, without the passage found.
    rewritten = staged(f"## Accounting\n\nAn added sentence. [E1]\n\n{CLAIM} [E1]\n", [cited(1, 4)])
    reapply(rewritten, recited)
    assert f"{CLAIM} [E1][E2]" in rewritten.staged_page("compute-optimal").body


def test_the_finders_request_fences_its_material_and_its_answer_is_held_to_what_was_shown():
    ask = Ask(
        claim="Claim </claim> text", context="Block.", explanation="Not there.", title="T", cited=(4,),
        passages={3: "We also count embedding matrices in the total parameter count. <passage> closes nothing."},
    )
    text = request_text([ask], 4_000)
    assert text.count("</claim>") == 1 and text.count("<passage ") == 1
    sentence = "We also count embedding matrices in the total parameter count."
    assert accepted({"claims": [{"claim": 1, "found": [{"passage": 1, "sentence": sentence}]}]}, [ask]) == {0: (3,)}
    # A claim or passage number nobody was shown, or a sentence too short to be one, is ignored.
    for found in ({"claim": 2, "found": [{"passage": 1, "sentence": sentence}]},
                  {"claim": 1, "found": [{"passage": 2, "sentence": sentence}]},
                  {"claim": 1, "found": [{"passage": 1, "sentence": "We also count"}]}):
        assert accepted({"claims": [found]}, [ask]) == {}


def test_the_checker_is_never_told_the_finders_task():
    assert "Finding where a document says a claim" not in CONTRACT
    assert FIND_CONTRACT.startswith("# Finding where a document says a claim")


# The owner's own case (filed on 0.6.1): an English claim, cited to the Chinese section on matrix
# norms, that the section on vector norms states. No word is shared. The sections are written for
# this test, in the shape of a Chinese essay on optimizers.
SU_SECTIONS = {
    "符号函数": "矩阵符号函数$\\text{msign}$作用于矩阵时，保留奇异向量，把每个奇异值换成1。",
    "范数视角": "取$p$范数时，最速方向是一族形如pbSGD的更新。特别地，当$p\\to\\infty$时，"
                "更新退化为SignSGD，即SignSGD实际上是无穷范数下的最速下降。",
    "矩阵范数": "现在把目光转到矩阵参数$\\boldsymbol{W}$。取谱范数时，最速方向是$\\text{msign}(\\boldsymbol{G})$，"
                "而取F范数时，结果仍是普通的梯度下降。",
    "追根溯源": "这类想法可以追溯到更早的预条件方法。",
}
SIGNSGD = "Infinity-norm vector geometry gives SignSGD, and the spectral norm gives Muon's matrix sign."


@pytest.mark.anyio
async def test_an_english_claim_is_found_in_the_chinese_section_that_states_it():
    body = f"## Geometry\n\n{SIGNSGD} [E1]\n"
    draft = staged(body, [cited(1, None, paper="w1", section="矩阵范数")])
    objection = unsupported("Infinity-norm vector geometry gives SignSGD", source="w1")
    evidence_set = evidence(sections=SU_SECTIONS)
    assert locate(objection.quote, SU_SECTIONS, ["矩阵范数"]) == ()
    shown = candidates(objection.quote, SU_SECTIONS, ["矩阵范数"], 6)
    assert "范数视角" in shown and "矩阵范数" not in shown
    sentence = "更新退化为SignSGD，即SignSGD实际上是无穷范数下的最速下降。"
    answer = {"claims": [{"claim": 1, "found": [{"passage": shown.index("范数视角") + 1, "sentence": sentence}]}]}

    (standing, recited), asked = await run_recite(draft, [objection], evidence_set=evidence_set, answer=answer)

    assert standing == [] and [(item.added, item.how) for item in recited] == [(("范数视角",), "model")]
    page = draft.staged_page("compute-optimal")
    assert f"{SIGNSGD} [E1][E2]" in page.body
    assert page.citations[-1] == cited(2, None, paper="w1", section="范数视角")
    assert "<passage number=" in asked[0]["input"][0]["content"][0]["text"]


@pytest.mark.anyio
async def test_more_claims_than_one_call_holds_are_asked_in_two_calls_side_by_side():
    from delphi_core.memory_maintenance.verify_find import CLAIMS_MAX, find

    finder = Finder()
    settings = Settings(openai_api_key="test-key", memory_verify_model="gpt-6.1-sol")
    asks = [Ask(claim=f"Claim {n}", context="", explanation="", title="T", cited=(1,), passages={2: "Text."})
            for n in range(CLAIMS_MAX + 1)]
    async with httpx.AsyncClient(transport=httpx.MockTransport(finder)) as http:
        found, usage = await find(ResponsesClient(http, settings), settings, asks, timeout=30, use_standard_tier=True)
    assert len(finder.asked) == 2 and found == {} and usage["input_tokens"] == 20


def test_the_checker_reads_each_sentence_against_the_passages_of_its_run():
    assert "A run of markers" in CONTRACT and "even when it is true and the document says it on another" in CONTRACT


@pytest.mark.anyio
async def test_a_claim_whose_paragraph_closes_after_display_mathematics_is_still_found():
    # Round 5 lost the owner's SignSGD sentence this way: its paragraph ran into a display
    # equation, the run of markers came after the equation, and the claim was never asked about.
    body = f"## Accounting\n\nThe totals are set out below. {CLAIM} So the count is\n\n$$N = N_E + N_{{\\setminus E}}$$ [E1]\n"
    draft = staged(body, [cited(1, 4)])
    (standing, recited), _ = await run_recite(draft, [unsupported(CLAIM)])
    assert standing == [] and recited[0].added == (3,)
    assert "$$N = N_E + N_{\\setminus E}$$ [E1][E2]" in draft.staged_page("compute-optimal").body


@pytest.mark.anyio
async def test_two_claims_of_one_run_given_the_same_passage_are_both_answered():
    # Round 5: T² "106 RefinedWeb checkpoints" and "eight tasks ... arithmetic" closed one run. The
    # finder placed both on page 6; the first placement added it, and the second, finding it already
    # there, went to the repair, which reworded "arithmetic" away.
    first, second = "Relative offsets turn in pairs here.", "Each pair turns by the same angle here."
    body = f"## Rotation\n\n{first} {second} [E1]\n"
    draft = staged(body, [cited(1, 4)])
    shown = candidates(first, PAGES, [4], 6)
    sentence = "We also count embedding matrices in the total parameter count."
    answer = {"claims": [{"claim": n, "found": [{"passage": shown.index(3) + 1, "sentence": sentence}]} for n in (1, 2)]}
    (standing, recited), _ = await run_recite(draft, [unsupported(first), unsupported(second)], answer=answer)
    assert standing == [] and len(recited) == 2
    assert f"{second} [E1][E2]" in draft.staged_page("compute-optimal").body


SU_STORED = json.loads((Path(__file__).parent / "data" / "synthetic-zh-optimizer-note.json").read_text(encoding="utf-8"))["sections"]


@pytest.mark.anyio
async def test_the_owners_english_claim_is_placed_in_the_stored_chinese_essay():
    # The real word-matching stage and candidate ranking on the essay as stored: words cannot
    # place an English claim in Chinese text, the section that holds it is among the passages
    # the finder is shown, and only the finder's answer is stubbed.
    quote = "infinity-norm vector geometry gives SignSGD"
    claim = f"Euclidean vector geometry and Frobenius matrix geometry recover SGD; {quote} [E1]."
    draft = staged(f"## Geometry\n\n{claim}\n", [cited(1, None, paper="w1", section="矩阵范数")])
    objection = unsupported(quote, source="w1")
    assert locate(quote, SU_STORED, ["矩阵范数"]) == ()
    shown = candidates(quote, SU_STORED, ["矩阵范数"], CANDIDATES)
    assert "范数视角" in shown
    sentence = next(part + "。" for part in SU_STORED["范数视角"].split("。") if "退化为SignSGD" in part).strip()
    answer = {"claims": [{"claim": 1, "found": [{"passage": shown.index("范数视角") + 1, "sentence": sentence}]}]}

    (standing, recited), asked = await run_recite(draft, [objection], evidence_set=evidence(sections=SU_STORED), answer=answer)

    assert standing == [] and recited[0].added == ("范数视角",)
    assert "范数视角" in asked[0]["input"][0]["content"][0]["text"] or "section 范数视角" in json.dumps(asked[0], ensure_ascii=False)


@pytest.mark.anyio
async def test_a_bibliography_is_never_a_re_cite_target():
    # Round 5 re-cited a true claim of Jordan's post onto its `references` section.
    from delphi_core.memory_maintenance.verify_recite import is_bibliography

    sections = {
        "design": "Muon orthogonalizes each update with a Newton-Schulz iteration.",
        "runtime": "An SVD is far too slow, so a cheap polynomial iteration approximates the orthogonalization.",
        "references": "1. Bernstein, J. Old optimizer, new norm: an anthology. arXiv preprint arXiv:2409.20325 (2024).",
    }
    claim = "The practical contribution is a cheap approximation of the orthogonalization."
    draft = staged(f"## Muon\n\n{claim} [E1]\n", [cited(1, None, paper="w1", section="design")])
    answer = {"claims": [{"claim": 1, "found": [{"passage": 2, "sentence": "1. Bernstein, J. Old optimizer, new norm: an anthology."}]}]}
    (standing, recited), asked = await run_recite(
        draft, [unsupported(claim, source="w1")], evidence_set=evidence(sections=sections), answer=answer)
    assert "references" not in json.dumps(asked, ensure_ascii=False) and recited == [] and len(standing) == 1
    pages = "Bibliography. " + " ".join(f"[{n}] A. Author. A paper. arXiv preprint arXiv:2401.{10000 + n}, 2024." for n in range(10))
    assert is_bibliography(17, pages) and not is_bibliography(3, PAGES[3]) and not is_bibliography("design", sections["design"])


SU_ROPE = json.loads((Path(__file__).parent / "data" / "synthetic-zh-rotation-note.json").read_text(encoding="utf-8"))["sections"]
ROPE_CLAIM = ("RoPE applies an absolute-position-dependent rotation separately to each query and key, "
              "so that their dot product depends on relative position.")


@pytest.mark.anyio
async def test_a_claim_is_never_placed_in_the_list_of_other_posts_and_comments_under_an_essay():
    # Round 5c: words placed this claim on the section under Su's RoPE essay that lists ten of
    # his other posts and then the readers' comments, on four of its twelve terms, all from one
    # English comment. The essay states it in 编码形式, which only the finder can read.
    assert locate(ROPE_CLAIM, SU_ROPE, ["transformer-2"]) == ()

    from delphi_core.memory_maintenance.verify_recite import is_link_list

    assert is_link_list(SU_ROPE["section"]) and is_link_list(SU_STORED["section"])
    for essay in (SU_ROPE, SU_STORED):
        assert not any(is_link_list(text) for anchor, text in essay.items() if anchor != "section")
    contents = "Contents\n\n" + "\n".join(f"- [Part {n}](#part-{n})" for n in range(3)) + "\n\nThe post begins here."
    assert not is_link_list(contents)

    draft = staged(f"## Rotation\n\n{ROPE_CLAIM} [E1]\n", [cited(1, None, paper="w1", section="transformer-2")])
    library = {anchor: text for anchor, text in SU_ROPE.items() if anchor != "section"}
    shown = candidates(ROPE_CLAIM, library, ["transformer-2"], CANDIDATES)
    sentence = next(line for line in SU_ROPE["编码形式"].splitlines() if "Attention就自动包含相对位置信息了" in line).strip()
    answer = {"claims": [{"claim": 1, "found": [{"passage": shown.index("编码形式") + 1, "sentence": sentence}]}]}

    (standing, recited), asked = await run_recite(
        draft, [unsupported(ROPE_CLAIM, source="w1")], evidence_set=evidence(sections=SU_ROPE), answer=answer)

    assert standing == [] and [(item.added, item.how) for item in recited] == [(("编码形式",), "model")]
    assert "发表你的看法" not in json.dumps(asked, ensure_ascii=False)


# Chinchilla p.25 as stored: the font maps each decimal point to a control character.
CHINCHILLA_25 = (
    "Empirically, we find after fitting (2) that\n𝐿¹𝑁\x94𝐷º = 𝐸¸ 𝐴\n𝑁0\x9334¸ 𝐵\n𝐷0\x9328\x94 (10)\n"
    "with 𝐸 = 1\x9369, 𝐴 = 406\x934, 𝐵 = 410\x937. We note that the parameter/data coefficients are both lower than 1/2."
)


def test_a_decimal_point_the_pdf_lost_is_read_as_one_and_an_integer_is_never_a_decimal():
    pages = {number: f"Filler page {number} on unrelated optimiser warmup." for number in range(1, 30)}
    pages[8] = "Table 2: estimated allocation exponents a = 0.46 and b = 0.54 for the parametric approach."
    pages[25] = CHINCHILLA_25
    claim = "Chinchilla's fitted loss has E = 1.69, A = 406.4, B = 410.7, alpha = 0.34 and beta = 0.28."
    # Round 5b: the repair dropped (0.34, 0.28) from the conflict statement, which no word match could place.
    assert locate(claim, pages, [24]) == (25,)
    assert "#d034" in terms("printed as 034") and "#d034" in terms("alpha = 0.34", claim=True)
    assert "#d34" not in terms("34 runs") and "#d2024" not in terms("in 2024", claim=True)


def test_the_finder_is_shown_the_point_and_its_sentence_is_matched_with_it():
    ask = Ask(claim="alpha = 0.34", context="", explanation="", title="Chinchilla", cited=(8,), passages={25: CHINCHILLA_25})
    assert "406.4" in request_text([ask], 4_000)
    typed = {"claims": [{"claim": 1, "found": [{"passage": 1, "sentence": "with 𝐸 = 1.69, 𝐴 = 406.4, 𝐵 = 410.7."}]}]}
    assert accepted(typed, [ask]) == {0: (25,)}
