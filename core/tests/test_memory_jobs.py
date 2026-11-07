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


def test_a_document_has_three_follow_ups_and_a_session_no_numbered_part():
    marker = jobs.document_marker("p1")
    seen = []
    while (marker := jobs.follow_up_marker(marker)) is not None:
        seen.append(marker)
    assert seen == ["paper:p1:part:1", "paper:p1:part:2", "paper:p1:part:3"]
    assert jobs.follow_up_marker(jobs.session_marker(paper_id="p1")) is None
    assert jobs.follow_up_marker("paper:p1:added") is None


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
