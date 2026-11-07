"""The page-level Memory metrics, on small candidates written by hand.

Every candidate here is files under `tmp_path`; nothing constructs a store,
reaches a server or calls a provider.
"""

import copy
import json

import pytest

from delphi_core.backfill import memory_eval
from delphi_core.backfill.memory_eval import (
    EXAMPLE_KEY,
    JUDGE_METRICS,
    blocks,
    edit_safety,
    inventory,
    load_candidate,
    load_keys,
    name_key,
    over_length,
    page_changes,
    retired,
    score_candidate,
    score_events,
    unresolved_citations,
    unresolved_links,
    validate_key,
)


def page(slug, *, kind="concept", title=None, body="Text.", citations=(), aliases=None, **more):
    made = {"id": f"id-{slug}", "slug": slug, "kind": kind, "domain": "ml", "title": title or slug.replace("-", " ").title(),
            "summary": "", "body": body, "tags": [], "citations": list(citations), "revision": 1, **more}
    if aliases is not None:
        made["aliases"] = aliases
    return made


def cite(number, *, claim="author-claim", paper="doc1", at=1, section=None, note=None, evidence=None):
    return {"id": number, "claimType": claim, "paperId": paper, "page": at, "section": section, "noteId": note, "evidenceId": evidence}


def write_candidate(root, pages, *, user="reader", documents=(("doc1", 10, "one.pdf"), ("web1", 12, "")), notes=("note1",),
                    evidence=("ev1",), layout="knowledge"):
    """`layout` names the account's Memory directory: "knowledge", as the frozen candidates hold it, or "memory" from format 5."""
    home = root / "users" / user
    (home / layout / "pages").mkdir(parents=True, exist_ok=True)
    for made in pages:
        (home / layout / "pages" / f"{made['slug']}.json").write_text(json.dumps(made))
    (home / layout / "evidence.json").write_text(json.dumps([{"id": name, "url": "https://x.example"} for name in evidence]))
    project = home / "projects" / "proj1"
    (project / "notes").mkdir(parents=True, exist_ok=True)
    (project / "meta.json").write_text(json.dumps({
        "id": "proj1", "papers": [{"id": name, "title": name, "pages": count, "filename": filename} for name, count, filename in documents],
    }))
    (project / "notes" / "doc1.json").write_text(json.dumps([{"id": name, "body": "A note."} for name in notes]))
    return root


def key_with(**sections):
    return {"format": memory_eval.KEY_FORMAT, "reviewed": True, "reviewedBy": "owner", **sections}


CONCEPTS = [
    {"id": "position-encoding", "title": "Position encoding", "aliases": ["positional encodings", "position embedding"]},
    {"id": "attention", "title": "Self-attention", "aliases": []},
]


# --- keys --------------------------------------------------------------------


def test_the_example_key_is_a_valid_key_with_every_section():
    assert validate_key(EXAMPLE_KEY) == []
    assert all(EXAMPLE_KEY.get(section) for section in memory_eval.SECTIONS)


def test_formats_prints_the_example_as_json(capsys):
    assert memory_eval.main(["formats"]) == 0
    assert json.loads(capsys.readouterr().out) == EXAMPLE_KEY


def problems_after(change):
    key = copy.deepcopy(EXAMPLE_KEY)
    change(key)
    return "\n".join(validate_key(key))


@pytest.mark.parametrize("change, expected", [
    (lambda key: key.update(format="keys/0"), "format: must be"),
    (lambda key: key.pop("reviewed"), "reviewed: must be true or false"),
    (lambda key: key.update(reviewed=True), "a reviewed key names who reviewed it"),
    (lambda key: key.update(answers=[]), "answers: is not a section"),
    (lambda key: key["documents"].append({"key": "rope", "id": "zz"}), "`key` 'rope' is used 2 times"),
    (lambda key: key["concepts"][0].pop("title"), "`title` must be a non-empty string"),
    (lambda key: key["concepts"][0].update(aliases="RoPE"), "`aliases` must be a list of strings"),
    (lambda key: key["concepts"][1]["aliases"].append("Positional Encoding"), "one name, one concept"),
    (lambda key: key["concepts"][0].update(documents=["nowhere"]), "which is not a document in this key"),
    (lambda key: key["mustNotSplit"][0].update(first="unknown"), "`first` names 'unknown'"),
    (lambda key: key["mustNotSplit"][0].update(second=[]), "`second` must be a concept id or a non-empty list"),
    (lambda key: key["mustNotSplit"][0].pop("reason"), "`reason` must be a non-empty string"),
    (lambda key: key["claims"][0].update(concept="unknown"), "`concept` names 'unknown'"),
    (lambda key: key["claims"][0]["numbers"][0].update(value=10000), "as the source prints it, as a string"),
    (lambda key: key["claims"][0]["numbers"][0].pop("unit"), "`unit` must say what 10000 counts"),
    (lambda key: key["claims"][0].update(locator={"document": "rope"}), "needs a `page` number or a `section`"),
    (lambda key: key["claims"][0].update(locator={"document": "lost", "page": 2}), "`locator.document` must name a document"),
    (lambda key: key["connections"][0]["sources"][0].update(relation="cites"), "`relation` must be one of builds-on"),
    (lambda key: key["connections"][0]["concepts"][0].update(to="position-encoding"), "relates a thing to itself"),
    (lambda key: key["events"][0].update(type="upload"), "`type` must be one of import"),
    (lambda key: key["events"][0].pop("document"), "a import event names its `document`"),
    (lambda key: key["events"][2].pop("expect"), "an empty list means nothing is filed"),
    (lambda key: key["events"][1]["expect"][0].update(action="rewrite"), "`action` must be \"create\" or \"edit\""),
    (lambda key: key["events"][0]["expect"][0].update(mayChange=["x"]), "a created page has no earlier text"),
    (lambda key: key["events"][1]["expect"][0].update(supersedes=["g9"]), "which is not a claim in this key"),
    (lambda key: key["events"].append(dict(key["events"][2])), "`id` 'e3' is used 2 times"),
    (lambda key: key["associations"][0].update(mustNotBring=["position-encoding"]), "is in `buildsOn` and `mustNotBring`"),
    (lambda key: key["associations"][0].pop("relation"), "`relation` must be a non-empty string"),
    (lambda key: key["associations"][0].update(finished=["unread"]), "which is not a document in this key"),
])
def test_a_malformed_key_is_reported_by_what_is_wrong(change, expected):
    assert expected in problems_after(change)


def test_a_key_that_is_not_an_object_or_has_no_section_is_refused():
    assert validate_key([]) == ["key: a key file is a JSON object"]
    assert any("holds none of" in problem for problem in validate_key({"format": memory_eval.KEY_FORMAT, "reviewed": False}))


def test_key_files_are_read_together_so_one_may_name_anothers_concepts(tmp_path):
    first = tmp_path / "concepts.json"
    first.write_text(json.dumps(key_with(documents=EXAMPLE_KEY["documents"], concepts=EXAMPLE_KEY["concepts"])))
    second = tmp_path / "events.json"
    second.write_text(json.dumps({"format": memory_eval.KEY_FORMAT, "reviewed": False, "events": EXAMPLE_KEY["events"]}))
    # Alone, the events file names concepts it does not define.
    _, alone = load_keys([second])
    assert any("is not a concept in this key" in problem for problem in alone)
    merged, problems = load_keys([first, second])
    assert problems == []
    assert len(merged["events"]) == 3 and len(merged["concepts"]) == 2
    # One draft file makes the whole key a draft.
    assert merged["reviewed"] is False


def test_keys_command_names_every_problem_and_fails(tmp_path, capsys):
    broken = copy.deepcopy(EXAMPLE_KEY)
    broken["claims"][0]["concept"] = "unknown"
    path = tmp_path / "key.json"
    path.write_text(json.dumps(broken))
    unreadable = tmp_path / "not.json"
    unreadable.write_text("{")
    assert memory_eval.main(["keys", str(path), str(unreadable)]) == 1
    printed = capsys.readouterr().out
    assert "malformed  together: claims[g1]: `concept` names 'unknown'" in printed
    assert "malformed  not.json: cannot be read as JSON" in printed
    assert "DRAFT, not reviewed" in printed
    path.write_text(json.dumps(EXAMPLE_KEY))
    assert memory_eval.main(["keys", str(path)]) == 0


# --- a candidate ---------------------------------------------------------------


def test_a_candidate_is_read_from_a_data_root_or_an_account_directory(tmp_path):
    root = write_candidate(tmp_path / "c", [page("a")])
    for path in (root, root / "users" / "reader"):
        candidate = load_candidate(path)
        assert candidate.user == "reader" and list(candidate.by_slug) == ["a"]
        assert set(candidate.documents) == {"doc1", "web1"} and candidate.notes == {"note1"} and candidate.evidence == {"ev1"}


def test_two_accounts_need_a_user_and_an_empty_directory_is_refused(tmp_path):
    root = write_candidate(tmp_path / "c", [page("a")])
    write_candidate(root, [page("b")], user="other")
    with pytest.raises(SystemExit, match="other, reader"):
        load_candidate(root)
    assert list(load_candidate(root, "other").by_slug) == ["b"]
    with pytest.raises(SystemExit, match="no account 'nobody'"):
        load_candidate(root, "nobody")
    with pytest.raises(SystemExit, match="no account with a Memory directory"):
        load_candidate(tmp_path / "empty")


def test_a_synced_folders_duplicate_file_is_a_stray_not_a_second_page(tmp_path):
    root = write_candidate(tmp_path / "c", [page("a")])
    pages = root / "users" / "reader" / "knowledge" / "pages"
    (pages / "a 2.json").write_text((pages / "a.json").read_text())
    (pages / "torn.json").write_text("{")
    candidate = load_candidate(root)
    assert [made["slug"] for made in candidate.pages] == ["a"]
    assert candidate.strays == ["a 2.json", "torn.json"]


def test_a_candidate_in_the_memory_layout_is_read_from_a_data_root_or_an_account_directory(tmp_path):
    root = write_candidate(tmp_path / "c", [page("a")], layout="memory")
    for path in (root, root / "users" / "reader"):
        candidate = load_candidate(path)
        assert candidate.user == "reader" and list(candidate.by_slug) == ["a"]
        assert set(candidate.documents) == {"doc1", "web1"} and candidate.notes == {"note1"} and candidate.evidence == {"ev1"}
        assert candidate.memory == root / "users" / "reader" / "memory"


def test_a_synced_folders_duplicate_file_is_a_stray_in_the_memory_layout_too(tmp_path):
    root = write_candidate(tmp_path / "c", [page("a")], layout="memory")
    pages = root / "users" / "reader" / "memory" / "pages"
    (pages / "a 2.json").write_text((pages / "a.json").read_text())
    (pages / "torn.json").write_text("{")
    candidate = load_candidate(root)
    assert [made["slug"] for made in candidate.pages] == ["a"]
    assert candidate.strays == ["a 2.json", "torn.json"]


def test_a_data_root_may_hold_an_account_in_each_layout_and_reading_them_writes_nothing(tmp_path):
    """A candidate is a frozen archive: each account is read under the name its store wrote, and is never migrated."""
    root = write_candidate(tmp_path / "c", [page("old-page")], user="before", evidence=("ev-old",))
    write_candidate(root, [page("new-page")], user="after", evidence=("ev-new",), layout="memory")

    def files():
        return {str(path.relative_to(root)): path.read_bytes() if path.is_file() else None for path in root.rglob("*")}

    held = files()
    with pytest.raises(SystemExit, match="after, before"):
        load_candidate(root)
    before, after = load_candidate(root, "before"), load_candidate(root, "after")
    assert (list(before.by_slug), before.evidence, before.memory.name) == (["old-page"], {"ev-old"}, "knowledge")
    assert (list(after.by_slug), after.evidence, after.memory.name) == (["new-page"], {"ev-new"}, "memory")
    score_candidate(before)
    score_candidate(after)
    assert files() == held


def test_an_account_holding_both_directories_is_refused_as_the_store_refuses_it(tmp_path):
    root = write_candidate(tmp_path / "c", [page("left-behind")])
    write_candidate(root, [page("current")], layout="memory")
    with pytest.raises(SystemExit, match="both memory/ and knowledge/"):
        load_candidate(root)


def test_the_refusal_and_the_help_name_both_layouts(tmp_path, capsys):
    with pytest.raises(SystemExit) as refused:
        load_candidate(tmp_path)
    assert "users/<user>/memory/pages/" in str(refused.value) and "users/<user>/knowledge/pages/" in str(refused.value)
    with pytest.raises(SystemExit):
        memory_eval.main(["--help"])
    printed = capsys.readouterr().out
    assert "users/<user>/memory/pages/" in printed and "users/<user>/knowledge/pages/" in printed


# --- metrics that need no key ----------------------------------------------------


def test_kinds_and_claim_types_outside_the_page_model_and_learning_fields_are_found(tmp_path):
    candidate = load_candidate(write_candidate(tmp_path, [
        page("a", citations=[cite(1), cite(2, claim="external", paper=None, evidence="ev1"), cite(3, claim="reader-note", note="note1"),
                             cite(4, claim="derived", paper=None, at=None)]),
        page("e", kind="essay"), page("s", kind="stub"), page("e2", kind="essay"),
        page("src", kind="source"), page("area", kind="domain"),
        page("guess", citations=[cite(1, claim="a-guess"), cite(2, claim="a-guess")]),
        page("lv", level="expert"), page("ob", observations=[{"kind": "chat"}]),
        page("empty", observations=[]),
    ]))
    found = retired(candidate)
    assert found["kinds"] == {"essay": ["e", "e2"], "stub": ["s"]}
    assert found["claimTypes"] == {"a-guess": ["guess"]}
    assert found["fields"] == ["lv", "ob"] and found["count"] == 6


def test_a_key_may_say_when_it_was_reviewed():
    assert validate_key(key_with(concepts=CONCEPTS, reviewedOn="2026-10-12")) == []
    assert validate_key(key_with(concepts=CONCEPTS, reviewedAt="2026-10-12T22:26:00Z")) == []


def test_a_link_with_no_page_behind_it_is_unresolved(tmp_path):
    candidate = load_candidate(write_candidate(tmp_path, [
        page("a", body="See [[b]], [[Missing Page|the missing one]] and [[b]] again. Not a link: [x](y)."),
        page("b", body="Back to [[a]]."),
    ]))
    assert unresolved_links(candidate) == [{"page": "a", "target": "missing-page"}]


def test_citations_resolve_to_a_document_a_note_or_evidence_in_the_candidate(tmp_path):
    candidate = load_candidate(write_candidate(tmp_path, [
        page("ok", body="One [E1], two [E2], three [E3], four [E4].", citations=[
            cite(1), cite(2, claim="reader-note", note="note1"), cite(3, claim="external", paper=None, at=None, evidence="ev1"),
            cite(4, claim="derived", paper=None, at=None),
        ]),
        page("bad", body="[E1] [E2] [E3] [E4] [E5] [E9]", citations=[
            cite(1, paper="gone"), cite(2, claim="reader-note", note="deleted"),
            cite(3, claim="external", paper=None, at=None, evidence="lost"),
            cite(4, claim="author-claim", paper=None, at=None), cite(5, at=11),
        ]),
        page("web", body="[E1]", citations=[cite(1, paper="web1", at=40)]),
    ]))
    found = unresolved_citations(candidate)
    assert [(row["page"], row["citation"]) for row in found["unresolved"]] == [("bad", 1), ("bad", 2), ("bad", 3)]
    assert found["unresolved"][0]["paperId"] == "gone" and found["unresolved"][1]["noteId"] == "deleted"
    assert found["unresolved"][2]["evidenceId"] == "lost"
    assert found["unlocated"] == [{"page": "bad", "citation": 4, "claimType": "author-claim", "needs": "paperId"}]
    # A PDF's page count bounds its citations; a web document's "pages" are not page numbers.
    assert found["pageOutOfRange"] == [{"page": "bad", "citation": 5, "claimType": "author-claim", "cites": 11, "documentPages": 10}]
    assert found["markers"] == [{"page": "bad", "marker": "[E9]"}]


def test_pages_over_their_accepted_length_by_kind(tmp_path):
    candidate = load_candidate(write_candidate(tmp_path, [
        page("fits", body="x" * 12_000), page("long", body="x" * 12_001), page("wall", body="x" * 16_001),
        page("domain", kind="domain", body="x" * 9_001), page("digest", kind="source", body="x" * 50_000),
    ]))
    assert over_length(candidate) == [
        {"page": "domain", "kind": "domain", "length": 9_001, "accept": 9_000, "pastTheWall": False},
        {"page": "long", "kind": "concept", "length": 12_001, "accept": 12_000, "pastTheWall": False},
        {"page": "wall", "kind": "concept", "length": 16_001, "accept": 12_000, "pastTheWall": True},
    ]


# --- the concept inventory -------------------------------------------------------


def test_names_match_whatever_the_case_punctuation_or_plural():
    assert name_key("Position-Encodings") == name_key("position encoding") == "position encoding"
    assert name_key("  RoPE (rotary) ") == "rope rotary"
    assert name_key("Loss") == "loss" and name_key("Bias") == "bia" == name_key("bias")
    assert name_key("位置编码") == "位置编码"


def test_two_pages_answering_to_one_concept_are_a_duplicate(tmp_path):
    candidate = load_candidate(write_candidate(tmp_path, [
        page("position-encoding"), page("how-positions-are-encoded", title="Positional encodings"),
        page("embeddings", aliases=["Position embedding"]), page("self-attention"),
        # A source or a domain page with the concept's name is not a second concept page.
        page("position-encoding-paper", kind="source", title="Position encoding"),
        page("domain", kind="domain", title="Self-attention"),
    ]))
    found = inventory(candidate, key_with(concepts=CONCEPTS))
    assert found["duplicates"] == [
        {"concept": "position-encoding", "pages": ["embeddings", "how-positions-are-encoded", "position-encoding"]}
    ]
    assert found["present"] == ["attention", "position-encoding"] and found["missing"] == []


def test_a_must_not_split_pair_with_a_page_on_each_side_is_a_violation(tmp_path):
    key = key_with(concepts=CONCEPTS, mustNotSplit=[
        {"first": "position-encoding", "second": ["RoPE", "Rotary position embedding"], "reason": "one idea"},
        {"first": ["Self-attention"], "second": ["Scaled dot-product attention"], "reason": "one idea"},
    ])
    split = load_candidate(write_candidate(tmp_path / "split", [page("position-encoding"), page("rope", title="RoPE")]))
    found = inventory(split, key)
    assert found["splits"] == [{"first": ["position-encoding"], "second": ["rope"], "reason": "one idea"}]
    assert found["missing"] == ["attention"]
    # One page that answers to both names is what the key asks for.
    whole = load_candidate(write_candidate(tmp_path / "whole", [page("position-encoding", aliases=["RoPE"])]))
    assert inventory(whole, key)["splits"] == []
    # And one side alone is no violation either.
    alone = load_candidate(write_candidate(tmp_path / "alone", [page("rope", title="RoPE")]))
    assert inventory(alone, key)["splits"] == []


def test_gold_claim_numbers_are_looked_for_on_the_concepts_page(tmp_path):
    key = key_with(
        documents=[{"key": "d", "id": "doc1"}], concepts=CONCEPTS,
        claims=[
            {"id": "g1", "concept": "position-encoding", "text": "t", "numbers": [{"value": "10000", "unit": "base"}],
             "locator": {"document": "d", "page": 1}},
            {"id": "g2", "concept": "position-encoding", "text": "t",
             "numbers": [{"value": "0.5", "unit": "ratio"}, {"value": "20", "unit": "tokens per parameter"}],
             "locator": {"document": "d", "page": 1}},
            {"id": "g3", "concept": "attention", "text": "t", "numbers": [{"value": "8", "unit": "heads"}], "locator": {"document": "d", "page": 1}},
            {"id": "g4", "concept": "attention", "text": "no numbers", "locator": {"document": "d", "page": 2}},
        ],
    )
    assert validate_key(key) == []
    # 120 and 20.5 are not 20; 10000 is on the page; 0.5 is.
    candidate = load_candidate(write_candidate(tmp_path, [page("position-encoding", body="Base 10000, ratio 0.5, also 120 and 20.5.")]))
    summary = score_candidate(candidate, key)
    assert summary["metrics"]["claimNumbers"] == {
        "claims": 3, "allPresent": 1,
        "absent": [{"claim": "g2", "concept": "position-encoding", "numbers": 2, "missing": ["20"]},
                   {"claim": "g3", "concept": "attention", "numbers": 1, "missing": ["8"]}],
    }


# --- a scripted edit -------------------------------------------------------------

BEFORE = page("position-encoding", body=(
    "# Position encoding\n\nSinusoids add a fixed signal. [E1]\n\n## Rotary\n\nRoPE rotates pairs of dimensions. [E2]\n\n"
    "## Result\n\nThe old paper reports 31.2 BLEU. [E3]"
), citations=[cite(1, at=3), cite(2, at=4), cite(3, at=9)])


def test_blocks_are_what_blank_lines_separate():
    assert blocks("# T\n\nA line\nand its wrap.\n \n\n- x\n- y\n") == ["# T", "A line\nand its wrap.", "- x\n- y"]


def test_an_addition_keeps_every_block_and_every_citation_even_renumbered():
    after = page("position-encoding", revision=2, body=(
        "# Position encoding\n\nSinusoids add a fixed signal. [E2]\n\n## Rotary\n\nRoPE rotates pairs of dimensions. [E3]\n\n"
        "## Variants\n\nTwo-axis rotation extends it. [E1]\n\n## Result\n\nThe old paper reports 31.2 BLEU. [E4]"
    ), citations=[cite(1, paper="web1", at=None, section="variants"), cite(2, at=3), cite(3, at=4), cite(4, at=9)])
    result = edit_safety(BEFORE, after)
    # The bodies differ only by marker numbers, which is a change of text: blocks are compared as written.
    assert result["citationsOwed"] == 3 and result["citationsRetained"] == 3 and result["citationRetention"] == 1.0
    assert result["untouchedKept"] is False and len(result["untouchedMissing"]) == 3


def test_untouched_text_must_survive_word_for_word():
    after = copy.deepcopy(BEFORE)
    after["revision"] = 2
    after["body"] = BEFORE["body"] + "\n\n## Variants\n\nTwo-axis rotation extends it. [E4]"
    after["citations"] = [*BEFORE["citations"], cite(4, paper="web1", at=None, section="variants")]
    kept = edit_safety(BEFORE, after)
    assert kept["untouchedKept"] and kept["untouchedMissing"] == [] and kept["removedShare"] == 0.0
    assert (kept["blocksBefore"], kept["untouched"], kept["revisionBefore"], kept["revisionAfter"]) == (6, 6, 1, 2)
    assert kept["citationRetention"] == 1.0 and kept["citationsLost"] == []

    after["body"] = after["body"].replace("RoPE rotates pairs of dimensions. [E2]", "RoPE rotates dimension pairs.")
    lost = edit_safety(BEFORE, after)
    assert not lost["untouchedKept"] and lost["untouchedMissing"] == ["RoPE rotates pairs of dimensions. [E2]"]
    assert lost["removedShare"] == round(1 / 6, 4)
    assert lost["citationRetention"] == round(2 / 3, 4)
    assert lost["citationsLost"] == [{"claimType": "author-claim", "paperId": "doc1", "page": 4, "section": None,
                                      "noteId": None, "evidenceId": None}]


def test_a_block_the_script_supersedes_may_change_and_take_its_citation_with_it():
    after = copy.deepcopy(BEFORE)
    after["body"] = BEFORE["body"].replace("The old paper reports 31.2 BLEU. [E3]", "A later paper corrects this to 29.8 BLEU. [E4]")
    after["citations"] = [cite(1, at=3), cite(2, at=4), cite(4, paper="web1", at=None, section="results")]
    unscripted = edit_safety(BEFORE, after)
    assert not unscripted["untouchedKept"] and unscripted["citationRetention"] == round(2 / 3, 4)
    scripted = edit_safety(BEFORE, after, ["31.2 BLEU"])
    assert scripted["untouchedKept"] and scripted["untouched"] == 5
    assert scripted["citationsOwed"] == 2 and scripted["citationRetention"] == 1.0


def test_a_citation_left_in_the_list_but_no_longer_used_is_not_retained():
    after = copy.deepcopy(BEFORE)
    after["body"] = BEFORE["body"].replace(" [E2]", "")
    assert edit_safety(BEFORE, after)["citationRetention"] == round(2 / 3, 4)


def test_a_page_with_no_citations_has_no_retention_figure():
    assert edit_safety(page("a", body="One."), page("a", body="One.\n\nTwo."))["citationRetention"] is None


def test_edit_command_reads_two_candidates_and_fails_on_lost_text(tmp_path, capsys):
    before = write_candidate(tmp_path / "before", [BEFORE])
    grown = copy.deepcopy(BEFORE)
    grown["body"] += "\n\nMore."
    after = write_candidate(tmp_path / "after", [grown])
    command = ["edit", "--before", str(before), "--after", str(after), "--slug", "position-encoding"]
    assert memory_eval.main(command) == 0
    assert json.loads(capsys.readouterr().out)["untouchedKept"] is True
    assert memory_eval.main(["edit", "--before", str(after), "--after", str(before), "--slug", "position-encoding"]) == 1
    capsys.readouterr()
    with pytest.raises(SystemExit, match="No page 'nope'"):
        memory_eval.main([*command[:-1], "nope"])


# --- the scripted events ---------------------------------------------------------


def event_key(reviewed=True):
    return {
        "format": memory_eval.KEY_FORMAT, "reviewed": reviewed, "reviewedBy": "owner" if reviewed else None,
        "documents": [{"key": "d", "id": "doc1"}],
        "concepts": CONCEPTS,
        "events": [
            {"id": "e1", "type": "import", "document": "d", "expect": [{"action": "create", "concept": "position-encoding"}]},
            {"id": "e2", "type": "chat", "expect": [{"action": "edit", "concept": "position-encoding"}]},
            {"id": "e3", "type": "small-talk", "expect": []},
            {"id": "e4", "type": "chat", "expect": [{"action": "edit", "concept": "position-encoding"}]},
            {"id": "e5", "type": "small-talk", "expect": []},
            {"id": "e6", "type": "note-add", "document": "d", "expect": [{"action": "edit", "concept": "attention"}]},
        ],
    }


def snapshots(tmp_path):
    root = tmp_path / "snapshots"
    source = page("the-paper", kind="source", body="Digest.")
    grown = copy.deepcopy(BEFORE)
    grown["revision"] = 2
    grown["body"] += "\n\n## Variants\n\nTwo-axis rotation extends it. [E1]"
    write_candidate(root / "start", [])
    write_candidate(root / "e1", [source, BEFORE])                      # created, as expected
    write_candidate(root / "e2", [source, grown])                       # edited, as expected, nothing lost
    write_candidate(root / "e3", [source, grown])                       # nothing, as expected
    # e4: the key expects an edit; a second page was created instead.
    write_candidate(root / "e4", [source, grown, page("rope-variants", title="Position embedding")])
    # e5: small talk that filed a page.
    write_candidate(root / "e5", [source, grown, page("rope-variants", title="Position embedding"), page("thanks")])
    # e6 has no snapshot.
    return root


def test_events_are_scored_against_the_snapshots_before_and_after_each(tmp_path):
    result = score_events(event_key(), snapshots(tmp_path))
    assert result["events"] == 5 and result["unscored"] == ["e6"]
    by_event = {row["event"]: row for row in result["rows"]}
    assert by_event["e1"]["created"] == ["position-encoding"] and by_event["e1"]["expectations"][0]["ok"]
    assert by_event["e2"]["edited"] == ["position-encoding"] and by_event["e2"]["edits"][0]["untouchedKept"]
    assert by_event["e3"]["filedNothing"] and by_event["e3"]["expectsNothing"]
    assert by_event["e4"]["expectations"] == [
        {"concept": "position-encoding", "expected": "edit", "observed": "create", "ok": False}
    ]
    assert by_event["e5"]["unexpected"] == ["thanks"] and not by_event["e5"]["filedNothing"]
    # Three expectations, two as the key names them.
    assert result["createVsEditAccuracy"] == round(2 / 3, 4)
    # One event filed nothing and the key agrees; of the two the key says file nothing, one did.
    assert result["nothingToFilePrecision"] == 1.0 and result["nothingToFileRecall"] == 0.5
    assert result["edits"] == 1 and result["editsKeepingUntouchedText"] == 1 and result["citationRetention"] == 1.0


def test_a_source_or_domain_page_appearing_is_not_a_filing(tmp_path):
    before = load_candidate(write_candidate(tmp_path / "a", [page("idea")]))
    after = load_candidate(write_candidate(tmp_path / "b", [
        page("idea", revision=2), page("paper", kind="source"), page("domain", kind="domain"),
    ]))
    # A revision number alone is not an edit either: what is written has to differ.
    assert page_changes(before, after) == {"created": [], "deleted": [], "edited": []}


def test_events_command_needs_an_events_section(tmp_path, capsys):
    path = tmp_path / "key.json"
    path.write_text(json.dumps(key_with(concepts=CONCEPTS)))
    with pytest.raises(SystemExit, match="`events` section"):
        memory_eval.main(["events", "--key", str(path), "--snapshots", str(tmp_path)])
    path.write_text(json.dumps(event_key()))
    assert memory_eval.main(["events", "--key", str(path), "--snapshots", str(snapshots(tmp_path))]) == 0
    assert json.loads(capsys.readouterr().out)["events"] == 5


# --- the report ------------------------------------------------------------------


def test_a_clean_candidate_passes_every_gate_and_the_summary_is_written(tmp_path, capsys):
    root = write_candidate(tmp_path / "c", [
        page("position-encoding", body="See [[self-attention]]. [E1]", citations=[cite(1)]), page("self-attention"),
        page("the-paper", kind="source"),
    ])
    key = tmp_path / "key.json"
    key.write_text(json.dumps(key_with(concepts=CONCEPTS)))
    out = tmp_path / "out"
    assert memory_eval.main(["report", "--candidate", str(root), "--arm", "new", "--key", str(key), "--out", str(out)]) == 0
    printed = capsys.readouterr().out
    assert "3 pages (2 concept, 1 source) over 2 documents, 1 citations" in printed
    assert "pass      no retired kind, claim type or level" in printed and "pass      duplicate violations: zero" in printed
    assert "inventory concepts with a page" in printed and "2 of 2" in printed
    assert ("needs a judge model (memory_judge): gold-claim recall, supported-claim rate, domain rubric, "
            "blind pairwise preference, edit safety by meaning") in printed
    summary = json.loads((out / "memory-eval-new.json").read_text())
    assert summary["format"] == memory_eval.REPORT_FORMAT and summary["arm"] == "new" and summary["failed"] is False
    assert [gate["status"] for gate in summary["gates"]] == ["pass", "pass", "pass", "pass"]
    assert [row["metric"] for row in summary["needsJudge"]] == list(JUDGE_METRICS)


def test_each_structural_failure_fails_its_own_gate(tmp_path, capsys):
    root = write_candidate(tmp_path / "c", [
        page("position-encoding", body="See [[nowhere]]. [E1]", citations=[cite(1, paper="gone")]),
        page("positional", title="Positional encodings"), page("open-question", kind="stub"),
    ])
    key = tmp_path / "key.json"
    key.write_text(json.dumps(key_with(concepts=CONCEPTS)))
    assert memory_eval.main(["report", "--candidate", str(root), "--key", str(key), "--out", str(tmp_path / "out")]) == 1
    printed = capsys.readouterr().out
    assert "FAIL      no retired kind, claim type or level  1 stub" in printed
    assert "FAIL      no unresolved link                    1 in 1 page(s)" in printed
    assert "FAIL      every citation resolves               1 unresolved" in printed
    assert "FAIL      duplicate violations: zero            1 concept(s) on two pages, 0 split pair(s)" in printed
    assert (tmp_path / "out" / "memory-eval.json").exists()


def test_a_draft_key_gates_nothing_and_says_so(tmp_path, capsys):
    root = write_candidate(tmp_path / "c", [page("position-encoding"), page("positional", title="Positional encodings")])
    key = tmp_path / "key.json"
    key.write_text(json.dumps({"format": memory_eval.KEY_FORMAT, "reviewed": False, "concepts": CONCEPTS}))
    assert memory_eval.main(["report", "--candidate", str(root), "--key", str(key), "--out", str(tmp_path / "out")]) == 0
    printed = capsys.readouterr().out
    assert "DRAFT KEYS" in printed and "draft     duplicate violations: zero" in printed


def test_a_reference_arm_is_measured_and_fails_nothing(tmp_path, capsys):
    root = write_candidate(tmp_path / "c", [page("g", kind="stub", body="[[nowhere]]")])
    assert memory_eval.main(["pages", "--candidate", str(root), "--arm", "old"]) == 1
    capsys.readouterr()
    assert memory_eval.main(["pages", "--candidate", str(root), "--arm", "old", "--reference"]) == 0
    printed = capsys.readouterr().out
    assert "A reference arm" in printed and "measured  no retired kind, claim type or level  1 stub" in printed and "FAIL" not in printed


def test_the_event_gates_join_the_report(tmp_path, capsys):
    root = snapshots(tmp_path)
    key = tmp_path / "key.json"
    key.write_text(json.dumps(event_key()))
    code = memory_eval.main(["report", "--candidate", str(root / "e5"), "--key", str(key), "--snapshots", str(root),
                             "--out", str(tmp_path / "out")])
    printed = capsys.readouterr().out
    assert "pass      untouched text survives every scripted edit  1 of 1 edits" in printed
    assert "pass      citation retention at least 98%" in printed and "100.0%" in printed
    assert "pass      nothing-to-file precision at least 90%" in printed
    assert "create-vs-edit accuracy" in printed and "67%" in printed and "events with no snapshot" in printed
    # e4 made a second page that answers to the position-encoding concept: the duplicate gate sees it.
    assert code == 1 and "FAIL      duplicate violations: zero" in printed
    with pytest.raises(SystemExit, match="--snapshots needs a key"):
        memory_eval.main(["report", "--candidate", str(root / "e5"), "--snapshots", str(root), "--out", str(tmp_path / "out")])


def test_the_chat_rigs_summary_is_folded_in(tmp_path, capsys):
    root = write_candidate(tmp_path / "c", [page("a")])
    questions = tmp_path / "questions.json"
    questions.write_text(json.dumps({
        "library": [{"key": "d", "file": "d.pdf"}],
        "questions": [{"id": "q1", "class": "document", "scope": "document", "open": "d", "prompt": "?", "facts": ["a", "b"]}],
    }))
    bench = tmp_path / "bench"
    bench.mkdir()
    (bench / "stage.json").write_text(json.dumps({"projectId": "p", "papers": {"d": "1"}, "pages": {}}))
    record = {"id": "q1", "kind": "document", "answer": "x", "firstTextMs": 2100, "error": None, "incomplete": None,
              "sources": [], "searched": False, "links": []}
    for arm in ("none", "new"):
        (bench / f"arm-{arm}.jsonl").write_text(json.dumps(record) + "\n")
    (bench / "arm-new.graded.jsonl").write_text(json.dumps({"id": "q1", "facts": [True, False], "errors": []}) + "\n")
    assert memory_eval.main(["report", "--candidate", str(root), "--out", str(tmp_path / "out"), "--chat", str(bench),
                             "--questions", str(questions)]) == 0
    printed = capsys.readouterr().out
    assert "chat arm new: 1 answers, 1 of 2 key facts, 2.1s to first text" in printed
    assert "chat arm none: 1 answers, not judged, 2.1s to first text" in printed
    assert set(json.loads((tmp_path / "out" / "memory-eval.json").read_text())["chat"]["arms"]) == {"new", "none"}


def test_the_chat_rigs_summary_is_not_folded_in_without_the_question_file_it_was_run_with(tmp_path):
    """Core ships no question file, so none is assumed: the run is refused before anything is scored or written."""
    root = write_candidate(tmp_path / "c", [page("a")])
    bench = tmp_path / "bench"
    bench.mkdir()
    with pytest.raises(SystemExit, match="--chat needs --questions"):
        memory_eval.main(["report", "--candidate", str(root), "--out", str(tmp_path / "out"), "--chat", str(bench)])
    assert not (tmp_path / "out").exists()


# --- what is not here --------------------------------------------------------------


def test_the_judge_metrics_are_named_here_and_measured_by_the_judge_module():
    from delphi_core.backfill import memory_judge

    assert all(len(what) > 40 for what in JUDGE_METRICS.values())
    for function in (memory_judge.gold_claim_recall, memory_judge.supported_claim_rate, memory_judge.domain_rubric,
                     memory_judge.pairwise_preference, memory_judge.edits_by_meaning):
        assert len((function.__doc__ or "").strip()) > 200


def test_help_explains_every_subcommand(capsys):
    with pytest.raises(SystemExit):
        memory_eval.main(["--help"])
    printed = capsys.readouterr().out
    for command in ("formats", "keys", "pages", "edit", "events", "report"):
        assert command in printed
        with pytest.raises(SystemExit):
            memory_eval.main([command, "--help"])
        assert len(capsys.readouterr().out) > 150
    assert "no command here calls a model" in printed


def test_the_module_never_opens_a_store():
    """Constructing `LocalStorage` runs migrations; scoring the old arm must not rewrite it first."""
    source = (memory_eval.__file__ and open(memory_eval.__file__, encoding="utf-8").read()) or ""
    assert "LocalStorage(" not in source and "import LocalStorage" not in source


def test_an_external_citation_opens_a_passage_only_when_its_quote_is_in_the_section_it_names(tmp_path):
    """§13.4: every external citation opens a passage containing its quote."""
    from delphi_core.backfill.memory_eval import outside_passages, score_candidate
    from delphi_core.storage import external_evidence_key

    quote = "Cache expiry and concurrent load remain confounders in production."
    write_candidate(tmp_path, [page("a", body="One [E1]. Two [E2]. Three [E3].", citations=[
        cite(1, claim="external", paper=None, at=None, section="limits", evidence="ev1"),
        cite(2, claim="external", paper=None, at=None, section="intro", evidence="ev1"),
        cite(3, claim="external", paper=None, at=None, section="limits", evidence="ev2"),
    ])], evidence=())
    home = tmp_path / "users" / "reader"
    # Where the local object store kept a capture's text before format 5; it writes under memory/ now.
    (home / "knowledge" / "evidence").mkdir(parents=True)
    records = []
    for name, said in (("ev1", f"Limitations. {quote}"), ("ev2", "The section says something else entirely.")):
        (home / "knowledge" / "evidence" / f"{name}.json").write_text(json.dumps({"sections": [
            {"anchor": "intro", "markdown": "An introduction."}, {"anchor": "limits", "markdown": said}]}))
        records.append({"id": name, "url": "https://x.example", "objectKey": external_evidence_key("reader", name),
                        "findings": [{"anchor": "limits", "quote": quote, "claim": "c", "bearsOn": "supports"}]})
    (home / "knowledge" / "evidence.json").write_text(json.dumps(records))

    candidate = load_candidate(tmp_path)
    found = outside_passages(candidate)
    assert found["cited"] == 3
    assert [(row["citation"], row["problem"]) for row in found["failing"]] == [
        (2, "no quote of the capture is found in that section"), (3, "no quote of the capture is found in that section")]
    gates = {gate["label"]: gate for gate in score_candidate(candidate)["gates"]}
    assert gates["every external citation opens a passage containing its quote"]["detail"] == "2 of 3 do not"


def test_an_external_citation_in_the_memory_layout_opens_a_passage_only_when_its_quote_is_in_the_section_it_names(tmp_path):
    """The same, with each capture's text where the local object store writes it from format 5."""
    from delphi_core.backfill.memory_eval import outside_passages, score_candidate
    from delphi_core.storage import LocalObjectStore, external_evidence_key

    quote = "Cache expiry and concurrent load remain confounders in production."
    write_candidate(tmp_path, [page("a", body="One [E1]. Two [E2]. Three [E3].", citations=[
        cite(1, claim="external", paper=None, at=None, section="limits", evidence="ev1"),
        cite(2, claim="external", paper=None, at=None, section="intro", evidence="ev1"),
        cite(3, claim="external", paper=None, at=None, section="limits", evidence="ev2"),
    ])], evidence=(), layout="memory")
    home = tmp_path / "users" / "reader"
    objects = LocalObjectStore(tmp_path)
    records = []
    for name, said in (("ev1", f"Limitations. {quote}"), ("ev2", "The section says something else entirely.")):
        objects.put_text(external_evidence_key("reader", name), json.dumps({"sections": [
            {"anchor": "intro", "markdown": "An introduction."}, {"anchor": "limits", "markdown": said}]}))
        records.append({"id": name, "url": "https://x.example", "objectKey": external_evidence_key("reader", name),
                        "findings": [{"anchor": "limits", "quote": quote, "claim": "c", "bearsOn": "supports"}]})
    (home / "memory" / "evidence.json").write_text(json.dumps(records))

    candidate = load_candidate(tmp_path)
    found = outside_passages(candidate)
    assert found["cited"] == 3
    assert [(row["citation"], row["problem"]) for row in found["failing"]] == [
        (2, "no quote of the capture is found in that section"), (3, "no quote of the capture is found in that section")]
    gates = {gate["label"]: gate for gate in score_candidate(candidate)["gates"]}
    assert gates["every external citation opens a passage containing its quote"]["detail"] == "2 of 3 do not"
