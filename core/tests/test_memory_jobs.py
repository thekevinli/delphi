"""Job markers and fingerprints: pure, and spelled in one place."""

import pytest

from delphi_core.memory_maintenance import jobs
from delphi_core.memory_maintenance.jobs import Marker


def test_a_marker_reads_back_as_what_it_was_built_from():
    assert jobs.document_marker("p1") == "paper:p1"
    assert jobs.document_marker("p1", 2) == "paper:p1:part:2"
    assert jobs.session_marker(paper_id="p1") == "session:paper:p1"
    assert jobs.session_marker(conversation_id="c9") == "session:conversation:c9"

    assert jobs.read_marker(jobs.document_marker("p1")) == Marker(jobs.DOCUMENT, paper_id="p1")
    assert jobs.read_marker(jobs.document_marker("p1", 3)) == Marker(jobs.DOCUMENT, paper_id="p1", part=3)
    assert jobs.read_marker(jobs.session_marker(paper_id="p1")) == Marker(jobs.SESSION, paper_id="p1")
    assert jobs.read_marker(jobs.session_marker(conversation_id="c9")) == Marker(jobs.SESSION, conversation_id="c9")


@pytest.mark.parametrize("marker", [
    # The retired kinds' markers, other jobs' markers, and near misses.
    "paper:p1:added", "paper:p1:done", "domain:ml", "reconcile:abc", "", "paper:", "paper::part:1",
    "paper:p1:part:0", "paper:p1:part:01", "paper:p1:part:x", "paper:p1:part:2:more", "session:p1",
    "session:project:p1", "session:paper:", "session:paper:p1:extra",
])
def test_a_marker_of_another_kind_is_not_read_as_one_of_these(marker):
    assert jobs.read_marker(marker) is None


def test_a_marker_refuses_an_id_that_would_read_back_wrong():
    with pytest.raises(ValueError):
        jobs.document_marker("")
    with pytest.raises(ValueError):
        jobs.document_marker("p1:part:2")
    with pytest.raises(ValueError):
        jobs.document_marker("p1", -1)
    # A session is beside a document or is a Memory chat, never both and never neither.
    with pytest.raises(ValueError):
        jobs.session_marker()
    with pytest.raises(ValueError):
        jobs.session_marker(paper_id="p1", conversation_id="c1")


def _runs_of(marker: str, runs: int) -> list[str]:
    seen = [marker]
    while (marker := jobs.follow_up_marker(marker, runs)) is not None:
        seen.append(marker)
    return seen


def test_a_documents_runs_follow_its_budget_and_a_session_has_no_numbered_part():
    assert _runs_of(jobs.document_marker("p1"), 2) == ["paper:p1", "paper:p1:part:1"]
    assert _runs_of(jobs.document_marker("p1"), 4) == ["paper:p1", "paper:p1:part:1", "paper:p1:part:2", "paper:p1:part:3"]
    # A budget is held to the most any document may have, whatever it says.
    assert _runs_of(jobs.document_marker("p1"), 99) == list(jobs.document_family("p1"))
    assert len(jobs.document_family("p1")) == jobs.DOCUMENT_MAX_RUNS == 6
    # The family is every marker a run may carry, and each reads back as the document's.
    assert [jobs.read_marker(marker).part for marker in jobs.document_family("p1")] == list(range(6))
    for runs in (1, 2, 6, 99):
        assert jobs.follow_up_marker(jobs.session_marker(paper_id="p1"), runs) is None
        assert jobs.follow_up_marker(jobs.session_marker(conversation_id="c1"), runs) is None
        assert jobs.follow_up_marker("paper:p1:added", runs) is None
        assert jobs.follow_up_marker("reconcile:abc", runs) is None


def test_a_standard_document_is_filed_in_two_runs_and_the_longest_in_six():
    from delphi_core.research_digest import DIGEST_MAX_LENGTH_FACTOR, DIGEST_STANDARD_SOURCE_CHARS, digest_budget

    def budget(chars: int) -> jobs.FilingBudget:
        return jobs.FilingBudget(digest_budget(chars).factor)

    # Up to a standard paper's length nothing moves: two runs of two pages.
    for chars in (0, 5_000, 52_000, DIGEST_STANDARD_SOURCE_CHARS):
        assert (budget(chars).runs, budget(chars).pages) == (2, 4)
    assert jobs.STANDARD_FILING_BUDGET.runs == jobs.STANDARD_DOCUMENT_RUNS == 2
    # Above it, linear in the digest's own factor, a run each 30,000 characters.
    assert [budget(chars).runs for chars in (75_000, 90_000, 105_000, 120_000, 135_000, 150_000, 165_000)] == [
        3, 3, 4, 4, 5, 5, 6]
    # The cap is where the digest's is, and it holds beyond it.
    for chars in (180_000, 421_000, 10_000_000):
        assert (budget(chars).runs, budget(chars).pages) == (6, 12)
    assert jobs.FilingBudget(DIGEST_MAX_LENGTH_FACTOR).runs == jobs.DOCUMENT_MAX_RUNS
    # One run is never larger for a longer document: it is more runs.
    assert jobs.PAGES_PER_RUN == 2
    # Never fewer than one run, whatever factor is read back.
    assert jobs.FilingBudget(0).runs == 1


def test_a_document_fingerprint_is_the_digest_whatever_order_its_keys_come_in():
    digest = {
        "contentMarkdown": "A claim [E1]. Unicode stays itself: β-VAE.",
        "citations": [{"id": 1, "claimType": "author-claim", "page": 3, "section": None}],
        "assets": [],
    }
    reordered = {
        "assets": [],
        "citations": [{"section": None, "page": 3, "claimType": "author-claim", "id": 1}],
        "contentMarkdown": "A claim [E1]. Unicode stays itself: β-VAE.",
    }
    first = jobs.document_fingerprint(digest)
    assert first == jobs.document_fingerprint(reordered) == jobs.document_fingerprint(dict(digest))
    assert len(first) == 64

    # Any change to what the digest says moves it.
    assert jobs.document_fingerprint({**digest, "contentMarkdown": digest["contentMarkdown"] + " "}) != first
    assert jobs.document_fingerprint({**digest, "citations": [{**digest["citations"][0], "page": 4}]}) != first
    assert jobs.document_fingerprint({**digest, "assets": [{"id": "f1"}]}) != first
    # The order of a list is content: the evidence index is ordered.
    two = {**digest, "citations": [digest["citations"][0], {"id": 2, "claimType": "digest-inference", "page": None, "section": None}]}
    assert jobs.document_fingerprint(two) != jobs.document_fingerprint({**two, "citations": two["citations"][::-1]})


def test_a_session_fingerprint_moves_with_a_turn_and_with_a_note():
    notes = {"n1": "2026-10-12T10:00:00Z", "n2": "2026-10-12T10:05:00Z"}
    first = jobs.session_fingerprint(["r1", "r2"], notes)
    assert first == jobs.session_fingerprint(("r1", "r2"), dict(reversed(notes.items())))

    assert jobs.session_fingerprint(["r1", "r2", "r3"], notes) != first  # a turn arrived
    assert jobs.session_fingerprint(["r1"], notes) != first  # a tail edit dropped one
    assert jobs.session_fingerprint(["r1", "r2"], {**notes, "n2": "2026-10-12T10:06:00Z"}) != first  # a note was edited
    assert jobs.session_fingerprint(["r1", "r2"], {"n1": notes["n1"]}) != first  # a note was deleted
    assert jobs.session_fingerprint(["r1", "r2"], {**notes, "n3": "t"}) != first  # a note was taken
    # A request id is never confused with a note id.
    assert jobs.session_fingerprint(["n1"], {}) != jobs.session_fingerprint([], {"n1": ""})
    assert jobs.session_fingerprint([], {}) == jobs.session_fingerprint((), {})
