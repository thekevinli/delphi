"""
The judge-model metrics of a Memory candidate (`backfill/memory_judge.py`).

A scripted judge stands in for the model: it records each question and answers
from a table, so the tests pin what the model is asked, what it is shown, and
how its answers are counted. The one request a real judge sends is checked
against a mock transport.
"""

import json

import httpx
import pytest

from delphi_core.backfill import memory_judge
from delphi_core.backfill.memory_eval import load_candidate
from delphi_core.config import Settings
from tests.test_memory_eval import cite, key_with, page, write_candidate

CONCEPTS = [
    {"id": "position-encoding", "title": "Position encoding", "aliases": ["positional encodings"]},
    {"id": "attention", "title": "Self-attention", "aliases": []},
]


class Scripted:
    """A judge that answers each question by its schema name, and remembers what it was asked."""

    def __init__(self, **answers):
        self.answers = answers
        self.asked = []

    def __call__(self, name, instructions, payload, schema):
        self.asked.append((name, payload))
        answer = self.answers[name]
        return answer(payload) if callable(answer) else answer


def candidate(tmp_path, pages, *, layout="knowledge"):
    root = write_candidate(tmp_path, pages, layout=layout)
    papers = root / "users" / "reader" / "projects" / "proj1" / "papers"
    papers.mkdir(parents=True, exist_ok=True)
    (papers / "doc1.txt").write_text("--- Page 1 ---\nSinusoids add a fixed signal.\n--- Page 2 ---\nRotation by position.\n")
    (papers / "web1.web").write_text(json.dumps({"sections": [{"anchor": "intro", "title": "Intro", "markdown": "Saved page text."}]}))
    evidence = root / "users" / "reader" / layout / "evidence"
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "ev1.json").write_text(json.dumps({"sections": [{"anchor": "s1", "title": "Survey", "markdown": "Outside text."}]}))
    return load_candidate(root)


def test_recall_asks_about_each_claim_on_its_concepts_pages_and_counts_partial_and_wrong_apart(tmp_path):
    held = candidate(tmp_path, [page("position-encoding", title="Position encoding", body="Sinusoids, base 10000 [E1].", citations=[cite(1)])])
    key = key_with(concepts=CONCEPTS, claims=[
        {"id": "g1", "concept": "position-encoding", "text": "Base 10000.", "numbers": [{"value": "10000", "unit": "base", "condition": "default"}],
         "locator": {"document": "doc1", "page": 1}},
        {"id": "g2", "concept": "position-encoding", "text": "Rotation.", "locator": {"document": "doc1", "page": 2}},
        {"id": "g3", "concept": "attention", "text": "Softmax over keys.", "locator": {"document": "doc1", "page": 2}},
    ])
    verdicts = iter(["correct", "partial"])
    judge = Scripted(gold_claim=lambda payload: {"verdict": next(verdicts), "quote": "q", "reason": "r"})
    result = memory_judge.gold_claim_recall(held, key, judge=judge)
    # A concept with no page is absent without a question.
    assert len(judge.asked) == 2
    name, payload = judge.asked[0]
    assert payload["fact"]["numbers"] == [{"value": "10000", "unit": "base", "condition": "default"}]
    assert "# Position encoding\n\nSinusoids, base 10000 [E1]." in payload["page"]
    assert [row["verdict"] for row in result["rows"]] == ["correct", "partial", "absent"]
    assert result["summary"] == {"claims": 3, "correct": 1, "partial": 1, "wrong": 0, "absent": 1, "recall": 0.3333, "recallWithPartial": 0.6667}


def test_support_shows_each_cited_paragraph_with_the_passages_it_names(tmp_path):
    body = (
        "## Position encoding\n\n"
        "Sinusoids add a fixed signal [E1]; rotation is per position [E2].\n\n"
        "A saved page says so [E3], a note doubts it [E4], a survey agrees [E5].\n\n"
        "A paragraph with no citation is not asked about.\n\n"
        "A citation of a page the document lacks [E6]."
    )
    citations = [cite(1, at=1), cite(2, at=2), cite(3, paper="web1", at=None, section="intro"),
                 cite(4, claim="reader-note", note="note1", paper=None, at=None), cite(5, claim="external", evidence="ev1", paper=None, at=None, section="s1"),
                 cite(6, at=9)]
    held = candidate(tmp_path, [page("position-encoding", body=body, citations=citations), page("doc1", kind="source", body="Digest [E1].", citations=[cite(1)])])
    judge = Scripted(supported_claims=lambda payload: {"claims": [
        {"claim": "c", "marker": "E1", "verdict": "supported", "reason": ""},
        {"claim": "d", "marker": "", "verdict": "own", "reason": ""},
        {"claim": "e", "marker": "E2", "verdict": "unsupported", "reason": ""},
    ]})
    result = memory_judge.supported_claim_rate(held, judge=judge)
    # Source pages are their documents' digests and are not asked about.
    assert [row["id"] for row in result["rows"]] == ["position-encoding#2", "position-encoding#3", "position-encoding#5"]
    first, second = judge.asked[0][1], judge.asked[1][1]
    assert [passage["text"] for passage in first["passages"]] == ["Sinusoids add a fixed signal.", "Rotation by position."]
    assert [passage["text"] for passage in second["passages"]] == [
        "Intro\n\nSaved page text.", "Passage the reader marked: \n\nWhat the reader wrote: A note.", "Survey\n\nOutside text."]
    assert second["passages"][2]["locator"] == {"claimType": "external", "section": "s1", "evidenceId": "ev1"}
    # Nothing to read is reported, not judged.
    assert result["rows"][2]["unjudged"] and len(judge.asked) == 2
    assert result["summary"] == {"paragraphs": 3, "unjudged": 1, "claims": 6, "supported": 2, "unsupported": 2, "own": 2, "supportedRate": 0.5}


def test_the_domain_rubric_is_given_the_members_and_the_domains_connections(tmp_path):
    held = candidate(tmp_path, [
        page("ml", kind="domain", body="Encodings come first [E1].", citations=[cite(1)]),
        page("position-encoding", title="Position encoding", summary="Where a token is."),
    ])
    key = key_with(concepts=CONCEPTS, connections=[{"domain": "ml", "concepts": [{"from": "attention", "to": "position-encoding", "relation": "depends-on"}], "sources": []}])
    answer = {aspect: {"score": 2, "reason": ""} for aspect in memory_judge.RUBRIC} | {"orientation": {"score": 1, "reason": ""}, "linkList": False}
    judge = Scripted(domain_rubric=answer)
    result = memory_judge.domain_rubric(held, key, judge=judge)
    payload = judge.asked[0][1]
    assert payload["members"] == [{"title": "Position encoding", "kind": "concept", "summary": "Where a token is."}]
    assert payload["connections"][0]["domain"] == "ml"
    assert result["rows"][0]["total"] == 7 and result["rows"][0]["keyedDomain"] is True
    assert result["summary"] == {"domains": 1, "linkLists": 0, "meanTotal": 7, "outOf": 8}


def test_preference_asks_both_orders_unlabelled_and_combines_them(tmp_path):
    old = candidate(tmp_path / "old", [page("position-encoding", title="Position encoding", body="Old text."),
                                       page("self-attention", title="Self-attention", body="Old attention.")])
    new = candidate(tmp_path / "new", [page("position-encoding", title="Position encoding", body="New text."),
                                       page("self-attention", title="Self-attention", body="New attention.")])
    key = key_with(concepts=CONCEPTS)

    def answer(payload):
        # Prefers the new text on position encoding in both orders; on attention, splits by position.
        if "encoding" in payload["idea"]:
            return {"winner": "A" if "New" in payload["A"] else "B", "reason": "r"}
        return {"winner": "A", "reason": "r"}

    judge = Scripted(preference=answer)
    result = memory_judge.pairwise_preference(old, new, key, judge=judge)
    assert len(judge.asked) == 4
    # Neither text says which system wrote it.
    assert all(set(payload) == {"idea", "A", "B"} for _, payload in judge.asked)
    assert [(row["id"], row["winner"]) for row in result["rows"]] == [("position-encoding", "new"), ("attention", "tie")]
    assert result["summary"] == {"concepts": 2, "oneSided": 0, "new": 1, "old": 0, "tie": 1, "newPreferred": 0.5}


def test_edits_are_judged_by_meaning_from_version_history(tmp_path):
    held = candidate(tmp_path, [page("position-encoding"), page("doc1", kind="source")])
    history = tmp_path / "users" / "reader" / "knowledge" / "versions" / "position-encoding"
    history.mkdir(parents=True)
    for revision, body, note in ((1, "About 5.9e23 FLOPs.", ""), (2, "About $5.88\\times10^{23}$ FLOPs.", "refined the figure"), (3, "Gone.", "added x")):
        (history / f"{revision:08d}.json").write_text(json.dumps({"revision": str(revision), "body": body, "note": note}))
    answers = iter([
        {"losses": [], "verdict": "kept"},
        {"losses": [{"before": "About 5.88e23 FLOPs.", "after": "", "accountedFor": False}], "verdict": "lost"},
    ])
    judge = Scripted(edit_meaning=lambda payload: next(answers))
    result = memory_judge.edits_by_meaning(held, judge=judge)
    assert judge.asked[0][1] == {"before": "About 5.9e23 FLOPs.", "after": "About $5.88\\times10^{23}$ FLOPs.", "note": "refined the figure"}
    assert [row["id"] for row in result["rows"]] == ["position-encoding@2", "position-encoding@3"]
    assert result["summary"] == {"edits": 2, "kept": 1, "unaccountedLosses": 1}


def test_edits_are_judged_by_meaning_from_version_history_in_the_memory_layout(tmp_path):
    held = candidate(tmp_path, [page("position-encoding"), page("doc1", kind="source")], layout="memory")
    history = tmp_path / "users" / "reader" / "memory" / "versions" / "position-encoding"
    history.mkdir(parents=True)
    for revision, body, note in ((1, "About 5.9e23 FLOPs.", ""), (2, "About $5.88\\times10^{23}$ FLOPs.", "refined the figure")):
        (history / f"{revision:08d}.json").write_text(json.dumps({"revision": str(revision), "body": body, "note": note}))
    judge = Scripted(edit_meaning={"losses": [], "verdict": "kept"})
    result = memory_judge.edits_by_meaning(held, judge=judge)
    assert judge.asked[0][1] == {"before": "About 5.9e23 FLOPs.", "after": "About $5.88\\times10^{23}$ FLOPs.", "note": "refined the figure"}
    assert result["summary"] == {"edits": 1, "kept": 1, "unaccountedLosses": 0}


def test_a_captured_sources_passage_is_read_from_the_memory_layout(tmp_path):
    held = candidate(tmp_path, [page("position-encoding")], layout="memory")
    outside = cite(1, claim="external", evidence="ev1", paper=None, at=None, section="s1")
    assert memory_judge.Passages(held)(outside) == "Survey\n\nOutside text."


def test_each_account_of_a_data_root_holding_both_layouts_is_judged_from_its_own_history(tmp_path):
    for user, layout in (("before", "knowledge"), ("after", "memory")):
        write_candidate(tmp_path, [page("position-encoding")], user=user, layout=layout)
        history = tmp_path / "users" / user / layout / "versions" / "position-encoding"
        history.mkdir(parents=True)
        for revision, body in ((1, "First."), (2, f"Written {user} format 5.")):
            (history / f"{revision:08d}.json").write_text(json.dumps({"revision": str(revision), "body": body, "note": ""}))
    for user in ("before", "after"):
        judge = Scripted(edit_meaning={"losses": [], "verdict": "kept"})
        memory_judge.edits_by_meaning(load_candidate(tmp_path, user), judge=judge)
        assert [payload["after"] for _, payload in judge.asked] == [f"Written {user} format 5."]


def test_repeated_runs_report_their_spread_and_agreement_with_a_person():
    runs = iter([
        {"rows": [{"id": "g1", "verdict": "correct"}, {"id": "g2", "verdict": "absent"}], "summary": {"recall": 0.5, "claims": 2}},
        {"rows": [{"id": "g1", "verdict": "correct"}, {"id": "g2", "verdict": "correct"}], "summary": {"recall": 1.0, "claims": 2}},
    ])
    result = memory_judge.measure(lambda: next(runs), runs=2, labels={"g1": "correct", "g2": "absent"})
    assert result["spread"]["recall"] == {"mean": 0.75, "min": 0.5, "max": 1.0}
    assert [entry["rate"] for entry in result["agreement"]] == [1.0, 0.5]
    assert result["agreement"][1]["disagreements"] == [{"id": "g2", "judge": "correct", "person": "absent"}]


def test_the_judge_sends_one_strict_request_and_retries_only_what_passes(monkeypatch):
    sent = []
    replies = iter([
        httpx.Response(429, json={"error": {"type": "rate_limit_exceeded"}}),
        httpx.Response(200, json={"output": [{"content": [{"type": "output_text", "text": '{"verdict": "kept", "losses": []}'}]}]}),
        httpx.Response(429, json={"error": {"type": "insufficient_quota"}}),
    ])

    def handler(request):
        sent.append(json.loads(request.content))
        return next(replies)

    settings = Settings(_env_file=None, openai_api_key="test-key")
    judge = memory_judge.ResponsesJudge("judge-model", settings, httpx.Client(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(memory_judge.time, "sleep", lambda seconds: None)
    assert judge("edit_meaning", "Check.", {"before": "a"}, memory_judge.EDIT_SCHEMA) == {"verdict": "kept", "losses": []}
    assert sent[0]["model"] == "judge-model" and sent[0]["store"] is False
    assert sent[0]["text"]["format"] == {"type": "json_schema", "name": "edit_meaning", "strict": True, "schema": memory_judge.EDIT_SCHEMA}
    assert json.loads(sent[0]["input"]) == {"before": "a"}
    # An account out of credit is not waited out.
    with pytest.raises(httpx.HTTPStatusError):
        judge("edit_meaning", "Check.", {"before": "a"}, memory_judge.EDIT_SCHEMA)
    assert judge.calls == 3


def test_concepts_are_matched_to_pages_by_meaning_and_the_judge_can_only_add(tmp_path):
    held = candidate(tmp_path, [
        page("rotary-position-embedding", title="Rotary position embedding", summary="Position as a rotation."),
        page("self-attention", title="Self-attention"),
        page("doc1", kind="source"),
    ])
    key = key_with(concepts=CONCEPTS)
    judge = Scripted(concept_pages={"matches": [
        {"concept": "position-encoding", "pages": ["rotary-position-embedding", "invented-slug"]},
        {"concept": "attention", "pages": []},
    ]})
    matched = memory_judge.match_concepts(held, key, judge=judge)
    # The judge finds the page the names miss, cannot invent one, and cannot take away a literal match.
    assert matched == {"position-encoding": ["rotary-position-embedding"], "attention": ["self-attention"]}
    payload = judge.asked[0][1]
    assert [row["slug"] for row in payload["pages"]] == ["rotary-position-embedding", "self-attention"]
    assert payload["pages"][0]["summary"] == "Position as a rotation."
    claims = key_with(concepts=CONCEPTS, claims=[{"id": "g1", "concept": "position-encoding", "text": "Rotation.", "locator": {"document": "doc1", "page": 2}}])
    recall = memory_judge.gold_claim_recall(held, claims, judge=Scripted(gold_claim={"verdict": "correct", "quote": "q", "reason": ""}), matched=matched)
    assert recall["rows"][0]["pages"] == ["rotary-position-embedding"] and recall["summary"]["recall"] == 1.0
