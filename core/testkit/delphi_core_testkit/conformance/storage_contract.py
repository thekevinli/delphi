"""
The same behaviour, asserted against every Storage implementation.

This is the safety net for the migration: any divergence between the filesystem
and Postgres backends — key casing, ordering, 404-vs-403, what a missing record
returns — fails here rather than in production.

Each store is opened by the consumer's `store_harness`; a harness that cannot
reach its store, Postgres with no scratch database, marks its cases skipped.
"""

import json
import threading

import pytest
from fastapi import HTTPException

from delphi_core.schemas import CONVERSATION_TITLE_MAX_CHARS
from delphi_core.storage.base import CAPTURE_JOB_KINDS, MEMORY_JOB_KINDS
from delphi_core_testkit.conformance._support import chat_key


@pytest.fixture
def storage(store_harness, tmp_path):
    store = store_harness.make(tmp_path)
    store.create_account("reader", "reader@example.test", "salt", "hash")
    return store


def test_memory_search_ranking_is_shared_unicode_and_account_scoped(storage):
    storage.create_account("other", None, "salt", "hash")
    rows = [
        {"slug": "title-hit", "title": "Attention", "summary": "Description", "body": "Body"},
        {"slug": "summary-hit", "title": "Summary hit", "summary": "Attention", "body": "Body"},
        {"slug": "body-hit", "title": "Body hit", "summary": "Description", "body": "Attention " * 30},
        {"slug": "chinese", "title": "注意力机制", "summary": "中文说明", "body": "公式"},
    ]
    for owner in ("reader", "other"):
        for row in rows:
            storage.upsert_memory_page(owner, {**row, "kind": "source", "domain": "ml"}, max_pages=50)
    for query, expected in [("How does attention work?", ["title-hit", "summary-hit", "body-hit"]),
                            ("注意力机制", ["chinese"]), ("volcanology", [])]:
        found = storage.search_memory_pages("reader", query)
        assert [hit["slug"] for hit in found] == expected
    storage.upsert_memory_page("other", {"slug": "secret", "title": "Secretword",
                                  "summary": "private", "body": "private", "kind": "source", "domain": "ml"}, max_pages=50)
    assert storage.search_memory_pages("reader", "secretword") == []
    assert storage.search_memory_pages("reader", "attention", domain="other") == []


def test_page_bodies_are_read_together_and_only_the_owners(storage):
    storage.create_account("other", None, "salt", "hash")
    for owner, body in (("reader", "Mine, line one.\nLine two."), ("other", "Theirs.")):
        storage.upsert_memory_page(owner, {"slug": "shared-slug", "title": "T", "summary": "s",
                                              "body": body, "kind": "concept", "domain": "ml"}, max_pages=50)
    storage.upsert_memory_page("reader", {"slug": "second", "title": "U", "summary": "s",
                                             "body": "Another.", "kind": "source", "domain": "ml"}, max_pages=50)
    assert storage.memory_page_bodies("reader") == {
        "shared-slug": "Mine, line one.\nLine two.", "second": "Another.",
    }
    assert storage.memory_page_bodies("nobody") == {}


def test_account_round_trip(storage):
    account = storage.get_account("reader")
    assert account["username"] == "reader"
    assert account["passwordSalt"] == "salt"
    assert storage.account_exists("reader")
    assert not storage.account_exists("nobody")
    assert storage.get_account("nobody") is None

    with pytest.raises(HTTPException) as taken:
        storage.create_account("reader", None, "s", "h")
    assert taken.value.status_code == 409


def test_password_update_replaces_only_the_credentials(storage):
    before = storage.get_account("reader")

    storage.update_password("reader", "new-salt", "new-hash")

    after = storage.get_account("reader")
    assert after["passwordSalt"] == "new-salt"
    assert after["passwordHash"] == "new-hash"
    assert after["username"] == before["username"]
    assert after["email"] == before["email"]
    assert after["createdAt"] == before["createdAt"]

    with pytest.raises(HTTPException) as missing:
        storage.update_password("nobody", "salt", "hash")
    assert missing.value.status_code == 404


def test_account_service_tier_preference_defaults_to_standard_and_round_trips(storage):
    assert storage.get_account("reader").get("useStandardTier", True)

    updated = storage.update_account_preferences("reader", use_standard_tier=False)

    assert updated["useStandardTier"] is False
    assert storage.get_account("reader")["useStandardTier"] is False

    with pytest.raises(HTTPException) as missing:
        storage.update_account_preferences("nobody", use_standard_tier=True)
    assert missing.value.status_code == 404


def test_project_list_is_newest_first_and_counts_papers(storage):
    first = storage.create_project("reader", "First")
    second = storage.create_project("reader", "Second")
    storage.add_paper(
        "reader", first["id"], {"id": "p1", "title": "A", "filename": "a.pdf"}
    )

    listed = storage.list_projects("reader")
    assert [item["id"] for item in listed] == [second["id"], first["id"]]
    assert {item["id"]: item["paperCount"] for item in listed} == {
        first["id"]: 1,
        second["id"]: 0,
    }

    # A rename must not reorder the list.
    storage.rename_project("reader", first["id"], "First renamed")
    assert [item["id"] for item in storage.list_projects("reader")] == [
        second["id"],
        first["id"],
    ]


def test_bulk_project_read_matches_get_project_for_every_project(storage):
    """The Dashboard's one-shot read must be the loop it replaced, not a variant."""
    first = storage.create_project("reader", "First")
    second = storage.create_project("reader", "Second")
    storage.add_paper(
        "reader", first["id"], {"id": "p1", "title": "A", "filename": "a.pdf"}
    )
    storage.add_paper(
        "reader", first["id"], {"id": "p2", "title": "B", "filename": "b.pdf"}
    )
    storage.create_account("stranger", None, "salt", "hash")
    storage.create_project("stranger", "Theirs")

    bulk = storage.list_projects_with_papers("reader")
    assert [item["id"] for item in bulk] == [second["id"], first["id"]]
    assert bulk == [storage.get_project("reader", item["id"]) for item in bulk]
    assert [paper["id"] for paper in bulk[1]["papers"]] == ["p1", "p2"]
    assert storage.list_projects_with_papers("stranger")[0]["name"] == "Theirs"


def test_another_users_project_is_absent_not_forbidden(storage):
    project = storage.create_project("reader", "Private")
    storage.create_account("stranger", None, "salt", "hash")

    with pytest.raises(HTTPException) as denied:
        storage.get_project("stranger", project["id"])
    assert denied.value.status_code == 404
    assert storage.list_projects("stranger") == []


def test_papers_keep_insertion_order_then_follow_an_explicit_reorder(storage):
    project = storage.create_project("reader", "Ordering")
    for paper_id in ("a", "b", "c"):
        storage.add_paper(
            "reader",
            project["id"],
            {"id": paper_id, "title": paper_id.upper(), "filename": f"{paper_id}.pdf"},
        )
    assert [
        paper["id"] for paper in storage.get_project("reader", project["id"])["papers"]
    ] == ["a", "b", "c"]

    # A swap in one statement is what the deferrable unique constraint exists for.
    reordered = storage.reorder_papers("reader", project["id"], ["c", "a", "b"])
    assert [paper["id"] for paper in reordered["papers"]] == ["c", "a", "b"]
    assert [
        paper["id"] for paper in storage.get_project("reader", project["id"])["papers"]
    ] == ["c", "a", "b"]

    storage.delete_paper("reader", project["id"], "a")
    assert [
        paper["id"] for paper in storage.get_project("reader", project["id"])["papers"]
    ] == ["c", "b"]


def test_moving_a_paper_takes_its_digest_highlights_and_chat_with_it(storage):
    source = storage.create_project("reader", "From")
    destination = storage.create_project("reader", "To")
    for paper_id in ("a", "b", "c"):
        storage.add_paper(
            "reader",
            source["id"],
            {"id": paper_id, "title": paper_id.upper(), "filename": f"{paper_id}.pdf"},
        )
    stroke = storage.add_highlight(
        "reader",
        source["id"],
        "b",
        {
            "type": "pdf",
            "page": 1,
            "rects": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04}],
            "text": "a claim",
            "color": "amber",
        },
    )
    storage.add_note(
        "reader",
        source["id"],
        "b",
        {
            "highlightId": stroke["id"],
            "page": 1,
            "anchorY": 0.4,
            "quotedText": "a claim",
            "body": "worth checking",
        },
    )
    paper_chat = chat_key(storage, "reader", source["id"], "paper-b")
    storage.append_message(
        "reader",
        source["id"],
        paper_chat,
        {
            "role": "assistant",
            "content": "Why?",
            "viewportEvidence": {
                "evidenceId": "request-1",
                "url": "https://example.com/reply",
                "title": "Reply",
                "kind": "html",
                "sourceHash": "a" * 64,
            },
        },
    )
    before = storage.get_paper("reader", source["id"], "b")

    storage.add_paper(
        "reader",
        destination["id"],
        {"id": "z", "title": "Z", "filename": "z.pdf"},
    )

    moved = storage.move_paper("reader", source["id"], "b", destination["id"])

    # First in its new project, not last: the reader just did this, and at the
    # end of a full list the result lands where they cannot see it.
    assert [paper["id"] for paper in moved["papers"]] == ["b", "z"]
    assert moved["id"] == destination["id"]
    # Dense on both sides: the gap the paper left has to close, or the next
    # reorder in the source project writes a position that already exists.
    assert [
        paper["id"] for paper in storage.get_project("reader", source["id"])["papers"]
    ] == ["a", "c"]
    # The record itself is carried, not rebuilt: a move is not an opportunity to
    # quietly drop the digest, the provider file id, or the reader's rename.
    assert storage.get_paper("reader", destination["id"], "b") == before
    with pytest.raises(HTTPException) as gone:
        storage.get_paper("reader", source["id"], "b")
    assert gone.value.status_code == 404

    # What is about the document travels with it.
    assert len(storage.list_highlights("reader", destination["id"], "b")) == 1
    # Including what the reader wrote against it: a note is about the passage,
    # not about the collection the paper happened to be filed in.
    assert [
        note["body"] for note in storage.list_notes("reader", destination["id"], "b")
    ] == ["worth checking"]
    assert storage.list_notes("reader", source["id"], "a") == []
    assert [
        message["content"]
        for message in storage.get_thread("reader", destination["id"], paper_chat)["messages"]
    ] == ["Why?"]
    assert storage.get_thread("reader", destination["id"], paper_chat)["messages"][0][
        "viewportEvidence"
    ]["evidenceId"] == "request-1"
    with pytest.raises(HTTPException) as left:
        storage.get_thread("reader", source["id"], paper_chat)
    assert left.value.status_code == 404

    # Nothing else travelled: a move re-homes the document and what is about
    # it, and nothing else.


def test_a_moved_paper_lands_where_the_drag_said_it_would(storage):
    source = storage.create_project("reader", "From")
    destination = storage.create_project("reader", "To")
    storage.add_paper(
        "reader", source["id"], {"id": "m", "title": "M", "filename": "m.pdf"}
    )
    for paper_id in ("x", "y"):
        storage.add_paper(
            "reader",
            destination["id"],
            {"id": paper_id, "title": paper_id.upper(), "filename": f"{paper_id}.pdf"},
        )

    moved = storage.move_paper("reader", source["id"], "m", destination["id"], 1)

    # The drag showed the reader a gap between X and Y. Landing it anywhere else
    # would make the animation a lie.
    assert [paper["id"] for paper in moved["papers"]] == ["x", "m", "y"]
    # Out of range is clamped rather than refused: the destination can have
    # gained or lost a paper in another tab while the drag was in the air.
    storage.move_paper("reader", destination["id"], "m", source["id"], 99)
    assert [
        paper["id"] for paper in storage.get_project("reader", source["id"])["papers"]
    ] == ["m"]


def test_a_moved_paper_takes_a_free_slug_in_its_new_project(storage):
    source = storage.create_project("reader", "From")
    destination = storage.create_project("reader", "To")
    storage.add_paper(
        "reader", source["id"], {"id": "mine", "title": "Results", "filename": "a.pdf"}
    )
    storage.add_paper(
        "reader",
        destination["id"],
        {"id": "theirs", "title": "Results", "filename": "b.pdf"},
    )

    storage.move_paper("reader", source["id"], "mine", destination["id"])

    # A slug is unique only inside its project, so an identical title already
    # sitting in the destination is a collision to resolve, not a failure.
    assert storage.get_paper("reader", destination["id"], "mine")["slug"] == "results-2"
    resolved = storage.resolve_reader("reader", destination["slug"], "results-2")
    assert resolved["paperId"] == "mine"


def test_a_paper_cannot_be_moved_into_a_project_that_is_not_yours(storage):
    storage.create_account("stranger", None, "salt", "hash")
    source = storage.create_project("reader", "Mine")
    theirs = storage.create_project("stranger", "Theirs")
    storage.add_paper(
        "reader", source["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )

    with pytest.raises(HTTPException) as denied:
        storage.move_paper("reader", source["id"], "p", theirs["id"])
    # 404, not 403: the destination must not be confirmed to exist.
    assert denied.value.status_code == 404
    assert [
        paper["id"] for paper in storage.get_project("reader", source["id"])["papers"]
    ] == ["p"]


def test_paper_record_shape_matches_across_backends(storage):
    project = storage.create_project("reader", "Shape")
    stored = storage.add_paper(
        "reader",
        project["id"],
        {
            "id": "paper-x",
            "title": "Title",
            "filename": "MDLM (2406.07524v2).pdf",
            "pages": 12,
            "tokens": 3400,
            "bytes": 987654,
            "createdAt": "2026-01-01T00:00:00+00:00",
        },
    )
    assert stored == {
        "id": "paper-x",
        "title": "Title",
        "slug": "title",
        "filename": "MDLM (2406.07524v2).pdf",
        "pages": 12,
        "tokens": 3400,
        "bytes": 987654,
        "createdAt": "2026-01-01T00:00:00+00:00",
    }
    assert storage.get_paper("reader", project["id"], "paper-x") == stored
    assert "doneAt" not in stored

    with pytest.raises(HTTPException) as missing:
        storage.get_paper("reader", project["id"], "nope")
    assert missing.value.status_code == 404


def test_a_web_document_round_trips_its_kind_and_address(storage):
    project = storage.create_project("reader", "Lil'Log")
    stored = storage.add_paper(
        "reader",
        project["id"],
        {
            "id": "page-x",
            "kind": "web",
            "title": "Why We Think",
            "filename": "lilianweng.github.io/posts/2025-05-01-thinking",
            "url": "https://lilianweng.github.io/posts/2025-05-01-thinking/",
            "favicon": "https://lilianweng.github.io/favicon_wine.ico",
            # Sections, not pages, for a web document.
            "pages": 24,
            "tokens": 16657,
            "bytes": 67025,
            "createdAt": "2026-07-29T00:00:00+00:00",
        },
    )

    assert stored["kind"] == "web"
    assert stored["url"] == "https://lilianweng.github.io/posts/2025-05-01-thinking/"
    assert stored["favicon"] == "https://lilianweng.github.io/favicon_wine.ico"
    assert storage.get_paper("reader", project["id"], "page-x") == stored

    initialized = storage.update_paper_snapshot(
        "reader", project["id"], "page-x", {"pages": 26, "tokens": 17000, "bytes": 68000}
    )
    assert (initialized["pages"], initialized["tokens"], initialized["bytes"]) == (
        26,
        17000,
        68000,
    )
    # A re-snapshot moves counts and nothing else — especially not the
    # immutable address or the title document creation chose.
    assert initialized["title"] == "Why We Think"
    assert initialized["kind"] == "web"


def test_a_papers_derived_fields_carry_their_versions_in_both_backends(storage):
    """
    Both backends round-trip the fields that make thumbnails
    repairable, and both omit them when unset — a record written before they
    existed must serialise exactly as it did.
    """
    project = storage.create_project("reader", "Project")
    bare = storage.add_paper(
        "reader", project["id"], {"id": "a", "title": "A", "filename": "a.pdf"}
    )
    assert "thumbnailAttemptedAt" not in bare
    # Zero failures is the absence of failures, in both backends: one omits a
    # falsy column, the other has to be told to.
    assert "thumbnailAttempts" not in bare

    stamped = storage.update_paper_snapshot("reader", project["id"], "a", {
        "thumbnailAvailable": False,
        "thumbnailVersion": 6,
        "thumbnailAttemptedAt": "2026-08-14T00:00:00+00:00",
        "thumbnailAttempts": 2,
    })
    assert stamped["thumbnailAttemptedAt"] == "2026-08-14T00:00:00+00:00"
    assert stamped["thumbnailAttempts"] == 2
    assert storage.get_paper("reader", project["id"], "a") == stamped

    # A snapshot that does not mention them leaves them where they were, the
    # same way it treats every other field it was not given.
    kept = storage.update_paper_snapshot("reader", project["id"], "a", {"pages": 9})
    assert kept["thumbnailAttemptedAt"] == "2026-08-14T00:00:00+00:00"
    assert kept["thumbnailAttempts"] == 2

    # A success clears the count, and clearing it removes the field again
    # rather than serving a zero one backend would not have written.
    cleared = storage.update_paper_snapshot("reader", project["id"], "a", {
        "thumbnailAvailable": True, "thumbnailAttempts": 0,
    })
    assert "thumbnailAttempts" not in cleared


def test_marking_a_paper_done_round_trips_and_clears(storage):
    project = storage.create_project("reader", "Archive")
    storage.add_paper(
        "reader", project["id"], {"id": "a", "title": "A", "filename": "a.pdf"}
    )
    storage.add_paper(
        "reader", project["id"], {"id": "b", "title": "B", "filename": "b.pdf"}
    )
    assert storage.count_active_papers("reader", project["id"]) == 2

    done = storage.set_paper_done("reader", project["id"], "a", True)
    assert done["doneAt"]
    assert storage.count_active_papers("reader", project["id"]) == 1
    # A done paper is still reachable directly and through the project list.
    assert storage.get_paper("reader", project["id"], "a")["doneAt"]
    assert [
        paper["id"] for paper in storage.get_project("reader", project["id"])["papers"]
    ] == ["a", "b"]

    cleared = storage.set_paper_done("reader", project["id"], "a", False)
    assert "doneAt" not in cleared
    assert "doneAt" not in storage.get_paper("reader", project["id"], "a")
    assert storage.count_active_papers("reader", project["id"]) == 2


def test_a_done_paper_survives_a_move_with_its_flag(storage):
    source = storage.create_project("reader", "From")
    destination = storage.create_project("reader", "To")
    storage.add_paper(
        "reader", source["id"], {"id": "a", "title": "A", "filename": "a.pdf"}
    )
    storage.set_paper_done("reader", source["id"], "a", True)
    before = storage.get_paper("reader", source["id"], "a")

    storage.move_paper("reader", source["id"], "a", destination["id"])

    assert storage.get_paper("reader", destination["id"], "a") == before
    assert storage.get_paper("reader", destination["id"], "a")["doneAt"]


def test_a_pdf_record_gains_no_web_fields(storage):
    """The wire format for existing papers stays byte-identical."""
    project = storage.create_project("reader", "PDFs")
    stored = storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )

    assert "kind" not in stored
    assert "url" not in stored
    assert "doneAt" not in stored


def test_reader_slugs_are_scoped_allocated_and_resolved(storage):
    first = storage.create_project("reader", "Schrödinger's Café")
    second = storage.create_project("reader", "Schrödinger's Café")
    punctuation = storage.create_project("reader", "日本語 !!!")
    assert [first["slug"], second["slug"], punctuation["slug"]] == [
        "schrodingers-cafe",
        "schrodingers-cafe-2",
        "project",
    ]

    one = storage.add_paper(
        "reader",
        first["id"],
        {"id": "one", "title": "Results", "filename": "one.pdf"},
    )
    two = storage.add_paper(
        "reader",
        first["id"],
        {"id": "two", "title": "Results", "filename": "two.pdf"},
    )
    fallback = storage.add_paper(
        "reader",
        first["id"],
        {"id": "three", "title": "日本語", "filename": "three.pdf"},
    )
    assert [one["slug"], two["slug"], fallback["slug"]] == [
        "results",
        "results-2",
        "document",
    ]

    resolved = storage.resolve_reader(
        "reader", first["slug"], two["slug"]
    )
    assert resolved["project"]["id"] == first["id"]
    assert resolved["paperId"] == "two"
    assert storage.resolve_reader("reader", second["slug"])["paperId"] is None

    storage.create_account("stranger", None, "salt", "hash")
    theirs = storage.create_project("stranger", "Schrödinger's Café")
    their_paper = storage.add_paper(
        "stranger",
        theirs["id"],
        {"id": "theirs", "title": "Results", "filename": "theirs.pdf"},
    )
    assert theirs["slug"] == first["slug"]
    assert their_paper["slug"] == one["slug"]
    assert (
        storage.resolve_reader("stranger", theirs["slug"], their_paper["slug"])[
            "project"
        ]["owner"]
        == "stranger"
    )


def test_renames_retire_routes_and_freed_slugs_are_reused(storage):
    project = storage.create_project("reader", "Original")
    paper = storage.add_paper(
        "reader",
        project["id"],
        {"id": "paper", "title": "Draft", "filename": "draft.pdf"},
    )

    renamed_project = storage.rename_project("reader", project["id"], "Final")
    renamed_paper = storage.rename_paper(
        "reader", project["id"], paper["id"], "Published"
    )
    with pytest.raises(HTTPException) as old_project:
        storage.resolve_reader("reader", "original")
    assert old_project.value.status_code == 404
    with pytest.raises(HTTPException) as old_paper:
        storage.resolve_reader("reader", "final", "draft")
    assert old_paper.value.status_code == 404
    assert (
        storage.resolve_reader(
            "reader", renamed_project["slug"], renamed_paper["slug"]
        )["paperId"]
        == paper["id"]
    )

    reused_project = storage.create_project("reader", "Original")
    reused_paper = storage.add_paper(
        "reader",
        project["id"],
        {"id": "replacement", "title": "Draft", "filename": "draft-2.pdf"},
    )
    assert reused_project["slug"] == "original"
    assert reused_paper["slug"] == "draft"

    storage.delete_paper("reader", project["id"], "replacement")
    assert storage.add_paper(
        "reader",
        project["id"],
        {"id": "again", "title": "Draft", "filename": "again.pdf"},
    )["slug"] == "draft"


def test_a_document_takes_its_printed_title_only_while_it_is_still_named_after_its_file(storage):
    project = storage.create_project("reader", "Papers")
    storage.add_paper("reader", project["id"], {"id": "ntk", "title": "ntk", "filename": "ntk.pdf"})
    printed = "Neural Tangent Kernel: Convergence and Generalization in Neural Networks"

    adopted = storage.adopt_paper_title("reader", project["id"], "ntk", f" {printed}  ")
    assert adopted["title"] == printed and adopted["slug"] != "ntk"
    stored = storage.get_paper("reader", project["id"], "ntk")
    assert stored["title"] == printed and stored["slug"] == adopted["slug"]
    # The file's name is still served: chat answers written before cite the document by it.
    assert adopted["filename"] == stored["filename"] == "ntk.pdf"
    listed = next(p for p in storage.get_project("reader", project["id"])["papers"] if p["id"] == "ntk")
    assert (listed["title"], listed["filename"]) == (printed, "ntk.pdf")
    assert storage.resolve_reader("reader", project["slug"], adopted["slug"])["paperId"] == "ntk"
    # Once it is no longer the file's name, nothing is adopted over it: not a
    # second printed title, and never over a title the reader set.
    assert storage.adopt_paper_title("reader", project["id"], "ntk", "Another title") is None
    storage.add_paper("reader", project["id"], {"id": "mine", "title": "My reading of muP", "filename": "mup.pdf"})
    assert storage.adopt_paper_title("reader", project["id"], "mine", "Tensor Programs V") is None
    assert storage.get_paper("reader", project["id"], "mine")["title"] == "My reading of muP"
    # An empty title, a title equal to the stored one and a record with no file name adopt nothing.
    storage.add_paper("reader", project["id"], {"id": "raw", "title": "raw", "filename": "raw.pdf"})
    assert storage.adopt_paper_title("reader", project["id"], "raw", "   ") is None
    assert storage.adopt_paper_title("reader", project["id"], "raw", "raw") is None
    assert storage.get_paper("reader", project["id"], "raw")["title"] == "raw"
    with pytest.raises(HTTPException) as missing:
        storage.adopt_paper_title("reader", project["id"], "absent", "A title")
    assert missing.value.status_code == 404


def test_openai_file_id_is_written_once_and_never_overwritten(storage):
    project = storage.create_project("reader", "Cache")
    storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )
    assert "openaiFileId" not in storage.get_paper("reader", project["id"], "p")

    storage.set_openai_file("reader", project["id"], "p", "file-first")
    # The second write is what two concurrent first-questions would do; it must
    # not replace the id, or one uploaded file is orphaned.
    storage.set_openai_file("reader", project["id"], "p", "file-second")

    paper = storage.get_paper("reader", project["id"], "p")
    assert paper["openaiFileId"] == "file-first"
    assert paper["openaiFileUploadedAt"]

    # Recovery is deliberately different from the first-write path: only the
    # request that still sees the stale id may replace it.
    assert not storage.replace_openai_file(
        "reader", project["id"], "p", "file-lost-race", "file-third"
    )
    assert storage.replace_openai_file(
        "reader", project["id"], "p", "file-first", "file-refreshed"
    )
    assert storage.get_paper("reader", project["id"], "p")["openaiFileId"] == (
        "file-refreshed"
    )


def test_a_conversation_keeps_a_title_of_the_full_length_in_both_backends(storage):
    """
    A title is bounded by `CONVERSATION_TITLE_MAX_CHARS`, however it was named,
    and a store keeps one of that length whole: a narrower column would cut a
    generated title and refuse a rename the API accepted.
    """
    project = storage.create_project("reader", "Project")
    storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )
    claim = storage.claim_conversation_title(
        "reader", project_id=project["id"],
        thread_key=chat_key(storage, "reader", project["id"], "paper-p"),
        engagement_id="one", fallback_title="A question",
    )
    assert claim
    full = ("A" * (CONVERSATION_TITLE_MAX_CHARS - 2)) + " B"
    storage.set_conversation_title(
        "reader", claim["id"], title=full, model="m",
        updated_at="2026-01-04T00:00:00+00:00",
    )
    assert storage.get_conversation("reader", claim["id"])["title"] == full
    renamed = full[::-1]
    storage.rename_conversation("reader", claim["id"], renamed, claim["generation"])
    assert storage.get_conversation("reader", claim["id"])["title"] == renamed


def test_a_conversation_is_titled_once_per_engagement_in_both_backends(storage):
    """
    Both backends gate the spend on the same thing, and on that alone: the
    engagement holding the claim. One mounted chat buys one title however many
    turns it takes, and a conversation reopened later is titled again from what
    it has become rather than keeping the name its opening question earned.
    """
    project = storage.create_project("reader", "Project")
    storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )
    key = chat_key(storage, "reader", project["id"], "paper-p")

    def claim(engagement):
        return storage.claim_conversation_title(
            "reader", project_id=project["id"], thread_key=key,
            engagement_id=engagement, fallback_title="A question",
        )

    first = claim("one")
    assert first
    assert claim("one") is None
    # Nothing was written, so the next mount is allowed to try again.
    assert claim("two")
    storage.set_conversation_title(
        "reader", first["id"], title="A real title", model="m",
        updated_at="2026-01-04T00:00:00+00:00",
    )
    assert claim("two") is None
    assert claim("three")
    record = storage.get_conversation("reader", first["id"])
    assert (record["title"], record["titleModel"]) == ("A real title", "m")


def test_a_claim_the_stream_never_spent_is_handed_back_in_both_backends(storage):
    """
    A request that fails before there is an answer makes no title attempt at
    all, and the reader's obvious next move is to ask the same question again
    from the same open chat. If the failed request kept the claim, that retry —
    and every question after it — is refused the title it should have bought.
    """
    project = storage.create_project("reader", "Project")
    storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )
    key = chat_key(storage, "reader", project["id"], "paper-p")

    def claim(engagement):
        return storage.claim_conversation_title(
            "reader", project_id=project["id"], thread_key=key,
            engagement_id=engagement, fallback_title="A question",
        )

    first = claim("one")
    assert first
    storage.release_conversation_title_claim("reader", first["id"], engagement_id="one")
    # The retry, from the same mount, now buys the title the failure did not.
    assert claim("one")
    storage.set_conversation_title(
        "reader", first["id"], title="A real title", model="m",
        updated_at="2026-01-04T00:00:00+00:00",
    )
    assert claim("one") is None
    # A release naming an engagement that no longer holds the claim takes
    # nothing away from the mount that does.
    storage.release_conversation_title_claim("reader", first["id"], engagement_id="two")
    assert claim("one") is None
    assert storage.get_conversation("reader", first["id"])["title"] == "A real title"


def test_chat_images_have_stable_thread_scoped_numbers_and_append_only_references(storage):
    project = storage.create_project("reader", "Images")
    storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )
    thread = chat_key(storage, "reader", project["id"], "paper-p")
    base = {
        "width": 512,
        "height": 256,
        "sourceBytes": 1000,
        "normalizedBytes": 600,
        "sourceFormat": "png",
        "createdAt": "2026-01-01T00:00:00+00:00",
        "expiresAt": "2026-01-31T00:00:00+00:00",
    }
    first = storage.add_chat_image(
        "reader", project["id"], thread,
        {**base, "id": "image-one", "imageKey": "one", "thumbnailKey": "one-thumb"},
        max_count=50, max_bytes=32 * 1024 * 1024,
    )
    second = storage.add_chat_image(
        "reader", project["id"], thread,
        {**base, "id": "image-two", "imageKey": "two", "thumbnailKey": "two-thumb"},
        max_count=50, max_bytes=32 * 1024 * 1024,
    )
    assert (first["number"], second["number"]) == (1, 2)

    referenced = storage.reference_chat_images(
        "reader", project["id"], thread, [first["id"]],
        "2026-01-02T00:00:00+00:00", "What does this show?",
    )
    assert referenced[0]["firstUseExcerpt"] == "What does this show?"
    with pytest.raises(HTTPException) as used:
        storage.delete_unused_chat_image("reader", project["id"], thread, first["id"])
    assert used.value.status_code == 409

    removed = storage.delete_unused_chat_image(
        "reader", project["id"], thread, second["id"]
    )
    assert removed["number"] == 2
    third = storage.add_chat_image(
        "reader", project["id"], thread,
        {**base, "id": "image-three", "imageKey": "three", "thumbnailKey": "three-thumb"},
        max_count=50, max_bytes=32 * 1024 * 1024,
    )
    assert third["number"] == 3

    storage.append_message(
        "reader", project["id"], thread,
        {"role": "user", "content": "Question", "referencedImages": [{"id": first["id"], "number": 1}]},
    )
    assert storage.get_thread("reader", project["id"], thread)["messages"][0][
        "referencedImages"
    ] == [{"id": first["id"], "number": 1}]


def test_the_account_wide_chat_holds_images_of_its_own(storage):
    """
    The Memory conversation is a thread like any other, so it can hold
    images — and its numbering is its own.

    Nothing about the *record* ever prevented this: `ChatImage` hangs off a
    thread, and the account-wide thread has always been a thread. What blocked
    it was an object key that assumed a project, which is why this case is
    written against `project_id=None` rather than against a placeholder id.
    """
    base = {
        "width": 512,
        "height": 256,
        "sourceBytes": 1000,
        "normalizedBytes": 600,
        "sourceFormat": "png",
        "createdAt": "2026-01-01T00:00:00+00:00",
        "expiresAt": "2026-01-31T00:00:00+00:00",
    }
    kb = chat_key(storage, "reader")
    add = lambda name: storage.add_chat_image(  # noqa: E731
        "reader", None, kb,
        {**base, "id": name, "imageKey": name, "thumbnailKey": f"{name}-thumb"},
        max_count=50, max_bytes=32 * 1024 * 1024,
    )
    first, second = add("kb-one"), add("kb-two")
    assert (first["number"], second["number"]) == (1, 2)

    referenced = storage.reference_chat_images(
        "reader", None, kb, [first["id"]],
        "2026-01-02T00:00:00+00:00", "What is in this diagram?",
    )
    assert referenced[0]["firstUseExcerpt"] == "What is in this diagram?"
    # A sent image is part of the record of the conversation.
    with pytest.raises(HTTPException) as used:
        storage.delete_unused_chat_image("reader", None, kb, first["id"])
    assert used.value.status_code == 409
    assert storage.delete_unused_chat_image("reader", None, kb, second["id"])["number"] == 2

    # A project's chat numbers independently: these are two conversations, and
    # "@[Image #1]" has to mean one thing inside each of them.
    project = storage.create_project("reader", "Elsewhere")
    storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )
    thread = chat_key(storage, "reader", project["id"], "paper-p")
    elsewhere = storage.add_chat_image(
        "reader", project["id"], thread,
        {**base, "id": "p-one", "imageKey": "p-one", "thumbnailKey": "p-one-thumb"},
        max_count=50, max_bytes=32 * 1024 * 1024,
    )
    assert elsewhere["number"] == 1
    assert [image["id"] for image in storage.list_chat_images(
        "reader", None, kb, "2026-01-02T00:00:00+00:00"
    )] == [first["id"]]

    # Clearing the conversation takes its images with it — both the rows and,
    # on the filesystem backend, the sidecars that hold the number counter. A
    # cleared chat whose next image came back as #3 would be reporting a
    # conversation that no longer exists.
    cleared = storage.delete_conversation("reader", storage.get_thread("reader", None, kb)["conversationId"], 0)
    assert cleared["action"] == "reset"
    kb = chat_key(storage, "reader")
    assert storage.list_chat_images(
        "reader", None, kb, "2026-01-02T00:00:00+00:00"
    ) == []
    assert add("kb-three")["number"] == 1
    assert storage.list_chat_images(
        "reader", project["id"], thread, "2026-01-02T00:00:00+00:00"
    )[0]["id"] == "p-one"


def test_digest_claims_are_owned_expiring_and_retain_a_valid_card(storage):
    project = storage.create_project("reader", "Digest")
    storage.add_paper(
        "reader",
        project["id"],
        {
            "id": "p",
            "title": "P",
            "filename": "p.pdf",
            "pages": 4,
            "sourceHash": "a" * 64,
        },
    )
    assert "digest" not in storage.get_paper("reader", project["id"], "p")
    base = {
        "version": "research-digest-v1",
        "model": "gpt-6-luna",
        "sourceMode": "pdf-multimodal",
        "sourceHash": "a" * 64,
        "estimatedTokens": 0,
    }
    assert storage.claim_digest(
        "reader",
        project["id"],
        "p",
        claim_id="first",
        expires_at="2999-01-01T00:00:00+00:00",
        metadata=base,
        force=False,
    ) == "claimed"
    assert storage.claim_digest(
        "reader",
        project["id"],
        "p",
        claim_id="second",
        expires_at="2999-01-01T00:00:00+00:00",
        metadata=base,
        force=False,
    ) == "busy"
    ready = storage.complete_digest(
        "reader",
        project["id"],
        "p",
        "first",
        {**base, "status": "ready", "estimatedTokens": 42, "updatedAt": "now"},
    )
    assert ready["digest"]["status"] == "ready"
    assert storage.claim_digest(
        "reader",
        project["id"],
        "p",
        claim_id="reuse",
        expires_at="2999-01-01T00:00:00+00:00",
        metadata=base,
        force=False,
    ) == "ready"

    # A new default author does not invalidate the completed artifact.
    assert storage.claim_digest(
        "reader", project["id"], "p", claim_id="new-author",
        expires_at="2999-01-01T00:00:00+00:00",
        metadata={**base, "model": "gpt-6-sol"}, force=False,
    ) == "ready"
    assert storage.get_paper("reader", project["id"], "p")["digest"]["model"] == base["model"]

    # A forced replacement owns a claim but leaves the previous ready card visible.
    assert storage.claim_digest(
        "reader",
        project["id"],
        "p",
        claim_id="replace",
        expires_at="2999-01-01T00:00:00+00:00",
        metadata=base,
        force=True,
    ) == "claimed"
    assert storage.get_paper("reader", project["id"], "p")["digest"]["status"] == "ready"
    storage.fail_digest(
        "reader",
        project["id"],
        "p",
        "replace",
        {**base, "status": "failed", "updatedAt": "later"},
    )
    assert storage.get_paper("reader", project["id"], "p")["digest"]["status"] == "ready"

    # A stale ready predecessor also remains visible while a newer version
    # is being built. The expired claim is recoverable without publishing a
    # pending card over that predecessor.
    assert storage.claim_digest(
        "reader",
        project["id"],
        "p",
        claim_id="expired",
        expires_at="2000-01-01T00:00:00+00:00",
        metadata={**base, "model": "another-model", "version": "research-digest-v2"},
        force=False,
    ) == "claimed"
    assert storage.get_paper("reader", project["id"], "p")["digest"]["status"] == "ready"
    assert storage.claim_digest(
        "reader",
        project["id"],
        "p",
        claim_id="recovered",
        expires_at="2999-01-01T00:00:00+00:00",
        metadata={**base, "model": "another-model", "version": "research-digest-v2"},
        force=False,
    ) == "claimed"
    assert storage.get_paper("reader", project["id"], "p")["digest"]["status"] == "ready"
    storage.fail_digest(
        "reader",
        project["id"],
        "p",
        "recovered",
        {**base, "model": "another-model", "status": "failed", "updatedAt": "later"},
    )
    storage.update_paper_snapshot(
        "reader",
        project["id"],
        "p",
        {"sourceHash": "b" * 64},
    )
    assert storage.get_paper("reader", project["id"], "p")["digest"]["status"] == "missing"

    storage.create_account("stranger", None, "salt", "hash")
    with pytest.raises(HTTPException) as denied:
        storage.claim_digest(
            "stranger",
            project["id"],
            "p",
            claim_id="stolen",
            expires_at="2999-01-01T00:00:00+00:00",
            metadata=base,
            force=False,
        )
    assert denied.value.status_code == 404


def test_a_claim_survives_concurrent_writes_to_a_sibling_paper(storage):
    """
    Two documents in one project, filed at the same time, must not overwrite
    each other's digest bookkeeping.

    The Memory backfill runs three ingests at once, which is three of these
    against one project. On the filesystem backend a project is one JSON file,
    so a claim written by one worker was silently lost to a sibling's save that
    had read the file first; the build that lost it answered `409: Digest build
    claim expired` fifteen minutes later, and the paper's `digest` field was
    gone entirely. Postgres never had the problem, which is exactly why this
    belongs in the contract suite rather than beside the implementation.
    """
    project = storage.create_project("reader", "Concurrent")
    for paper_id in ("one", "two"):
        storage.add_paper(
            "reader",
            project["id"],
            {
                "id": paper_id,
                "title": paper_id,
                "filename": f"{paper_id}.pdf",
                "pages": 4,
                "sourceHash": "a" * 64,
            },
        )
    base = {
        "version": "research-digest-v1",
        "model": "gpt-6-luna",
        "sourceMode": "pdf-multimodal",
        "sourceHash": "a" * 64,
        "estimatedTokens": 0,
    }

    def build(paper_id: str, results: dict[str, str]) -> None:
        for _ in range(20):
            claim_id = f"{paper_id}-claim"
            claimed = storage.claim_digest(
                "reader",
                project["id"],
                paper_id,
                claim_id=claim_id,
                expires_at="2999-01-01T00:00:00+00:00",
                metadata=base,
                force=True,
            )
            assert claimed == "claimed"
            # Whatever else the sibling worker is doing to this project mid-build.
            storage.set_paper_source_hash("reader", project["id"], paper_id, "a" * 64)
            storage.set_openai_file("reader", project["id"], paper_id, f"f-{paper_id}")
            storage.complete_digest(
                "reader",
                project["id"],
                paper_id,
                claim_id,
                {**base, "status": "ready", "updatedAt": "now"},
            )
        results[paper_id] = "ok"

    results: dict[str, str] = {}
    failures: list[BaseException] = []

    def run(paper_id: str) -> None:
        try:
            build(paper_id, results)
        except BaseException as exc:  # noqa: BLE001 - reported, not swallowed
            failures.append(exc)

    threads = [
        threading.Thread(target=run, args=(paper_id,)) for paper_id in ("one", "two")
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not failures, failures
    assert results == {"one": "ok", "two": "ok"}
    for paper_id in ("one", "two"):
        paper = storage.get_paper("reader", project["id"], paper_id)
        assert paper["digest"]["status"] == "ready"
        assert paper["openaiFileId"] == f"f-{paper_id}"


def test_a_new_project_carries_no_guidance_of_its_own(storage):
    """
    A project used to reference a persona and serve its body as SKILLS.md —
    one thing wearing two names. Both are gone: the voice a question is
    answered in belongs to the conversation asking it, not to the folder the
    document happens to sit in.
    """
    project = storage.create_project("reader", "Fresh")

    assert "persona" not in project
    assert "skills" not in project
    assert "persona" not in storage.get_project("reader", project["id"])


def test_editing_a_persona_reaches_every_conversation_using_it(storage):
    """
    Referenced, never copied — the property that survived the move off
    projects. Improving a persona is not supposed to leave half a reader's
    conversations on last week's wording, so nothing is propagated on write:
    each conversation stores the id and resolves the body on its next turn.
    """
    persona = storage.create_persona(
        "reader",
        {"name": "Shared", "element": "bolt", "content": "Lead with the claim."},
    )
    first = storage.create_project("reader", "One")
    second = storage.create_project("reader", "Two")
    for project in (first, second):
        storage.add_paper(
            "reader", project["id"],
            {"id": f"p-{project['id']}", "title": "P", "filename": "p.pdf"},
        )
    keys = [
        chat_key(storage, "reader", project["id"], f"paper-p-{project['id']}")
        for project in (first, second)
    ]
    for project, key in zip((first, second), keys):
        storage.set_conversation_persona(
            "reader", project_id=project["id"], thread_key=key,
            persona_id=persona["id"],
        )

    storage.update_persona("reader", persona["id"], {"content": "Lead with the delta."})

    for project, key in zip((first, second), keys):
        assert storage.get_thread("reader", project["id"], key)["personaId"] == (
            persona["id"]
        )
    assert storage.get_persona("reader", persona["id"])["content"] == (
        "Lead with the delta."
    )


def test_a_persona_read_never_carries_where_it_is_used(storage):
    """
    Reading a persona used to name the owner's projects using it, so an edit
    could warn what it would reach. There is nothing to name now — and a
    browsing stranger was never entitled to it anyway, which is why the field
    was omitted rather than emptied.
    """
    storage.create_account("stranger", None, "salt", "hash")
    persona = storage.create_persona(
        "reader",
        {
            "name": "Published",
            "element": "water",
            "content": "Ask why.",
            "visibility": "public",
        },
    )

    assert "projects" not in storage.get_persona("reader", persona["id"])
    assert "projects" not in storage.get_persona("stranger", persona["id"])


def test_a_stale_revision_is_refused_rather_than_overwriting(storage):
    persona = storage.create_persona(
        "reader",
        {"name": "Careful", "element": "wind", "content": "First."},
    )
    storage.update_persona(
        "reader", persona["id"], {"content": "Second."}, expected_revision=1
    )

    with pytest.raises(HTTPException) as conflict:
        storage.update_persona(
            "reader", persona["id"], {"content": "Third."}, expected_revision=1
        )

    assert conflict.value.status_code == 409
    assert storage.get_persona("reader", persona["id"])["content"] == "Second."


def test_a_persona_a_conversation_uses_can_still_be_deleted(storage):
    """
    Deleting used to be refused while a project pointed at the persona, because
    that project would have been left with no guidance at all. A conversation
    resolves its persona per turn, so a dangling id is an ordinary state that
    falls back to the default — and refusing on conversations instead would
    make a persona used for a month undeletable, which is worse than the rule
    it replaces.
    """
    persona = storage.create_persona(
        "reader",
        {"name": "Pinned", "element": "leaf", "content": "Ask first."},
    )
    project = storage.create_project("reader", "Holder")
    storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )
    key = chat_key(storage, "reader", project["id"], "paper-p")
    storage.set_conversation_persona(
        "reader", project_id=project["id"], thread_key=key, persona_id=persona["id"]
    )

    storage.delete_persona("reader", persona["id"])

    with pytest.raises(HTTPException):
        storage.get_persona("reader", persona["id"])
    # The conversation keeps the id it was held in; resolution is what falls
    # back, so the record is not rewritten behind the reader's back.
    assert storage.get_thread("reader", project["id"], key)["personaId"] == persona["id"]


def test_a_private_persona_is_absent_to_everyone_else(storage):
    storage.create_account("stranger", None, "salt", "hash")
    persona = storage.create_persona(
        "reader",
        {"name": "Mine", "element": "fire", "content": "Private."},
    )

    with pytest.raises(HTTPException) as denied:
        storage.get_persona("stranger", persona["id"])
    # 404, never 403: the API must not confirm the id exists to someone who
    # cannot see it.
    assert denied.value.status_code == 404
    assert storage.browse_personas("stranger")["items"] == []


def test_publishing_makes_a_persona_browsable_and_unpublishing_hides_it(storage):
    storage.create_account("stranger", None, "salt", "hash")
    persona = storage.create_persona(
        "reader",
        {
            "name": "Close reader",
            "element": "water",
            "tagline": "Slow, thorough, sceptical.",
            "content": "Quote before paraphrasing.",
        },
    )

    storage.update_persona("reader", persona["id"], {"visibility": "public"})
    listed = storage.browse_personas("stranger")
    assert [item["id"] for item in listed["items"]] == [persona["id"]]
    assert listed["items"][0]["author"] == "reader"
    # A browse page carries no bodies; that is what keeps it a few hundred bytes
    # a row instead of thirty kilobytes.
    assert "content" not in listed["items"][0]
    assert storage.browse_personas("stranger", query="sceptical")["items"]
    assert storage.browse_personas("stranger", query="nothing here")["items"] == []

    storage.update_persona("reader", persona["id"], {"visibility": "private"})
    assert storage.browse_personas("stranger")["items"] == []


def test_installing_a_persona_forks_it_so_later_edits_do_not_reach_the_installer(
    storage,
):
    storage.create_account("stranger", None, "salt", "hash")
    persona = storage.create_persona(
        "reader",
        {
            "name": "Shared",
            "element": "bolt",
            "content": "Original wording.",
            "visibility": "public",
        },
    )

    installed = storage.install_persona("stranger", persona["id"])

    storage.update_persona("reader", persona["id"], {"content": "Rewritten."})
    storage.update_persona("reader", persona["id"], {"visibility": "private"})
    storage.delete_persona("reader", persona["id"])

    # The whole safety argument for a marketplace: an author can edit, unpublish
    # and delete, and nothing reaches a reader who already installed it. That
    # fork matters more than it did — every chat request now names a persona
    # id, so it is what stands between a stranger's mutable text and this
    # reader's own conversation.
    assert storage.get_persona("stranger", installed["id"])["content"] == (
        "Original wording."
    )


def test_installing_twice_returns_the_same_copy(storage):
    storage.create_account("stranger", None, "salt", "hash")
    persona = storage.create_persona(
        "reader",
        {
            "name": "Popular",
            "element": "leaf",
            "content": "Body.",
            "visibility": "public",
        },
    )

    first = storage.install_persona("stranger", persona["id"])
    second = storage.install_persona("stranger", persona["id"])

    # Idempotent by constraint, not by a check: a double-click or a retry must
    # not litter the library with duplicates.
    assert first["id"] == second["id"]
    assert len(storage.list_personas("stranger")) == 1
    assert first["installedFrom"] == persona["id"]


def test_browse_pages_forward_without_repeating_a_row(storage):
    for index in range(5):
        storage.create_persona(
            "reader",
            {
                "name": f"Public {index}",
                "element": "stone",
                "content": "Body.",
                "visibility": "public",
            },
        )

    first = storage.browse_personas("reader", limit=2)
    second = storage.browse_personas("reader", limit=2, cursor=first["nextCursor"])
    third = storage.browse_personas("reader", limit=2, cursor=second["nextCursor"])

    seen = [item["id"] for page in (first, second, third) for item in page["items"]]
    assert len(seen) == 5
    assert len(set(seen)) == 5
    assert third["nextCursor"] is None
    # A cursor is a value a stranger can edit; a broken one starts again rather
    # than failing the request.
    assert len(storage.browse_personas("reader", cursor="not-a-cursor")["items"]) == 5


def test_chat_appends_do_not_overwrite_each_other(storage):
    project = storage.create_project("reader", "Chat")
    storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )
    key = chat_key(storage, "reader", project["id"], "paper-p")
    # A created conversation holds nothing and still names itself, in *both*
    # backends — the divergence this suite exists to catch.
    empty = storage.get_thread("reader", project["id"], key)
    assert empty["messages"] == [] and empty["conversationId"]

    storage.append_message("reader", project["id"], key, {"role": "user", "content": "1"})
    # Simulates a second tab: it read the thread before the first turn landed and
    # still must not drop it.
    stale = storage.get_thread("reader", project["id"], key)
    storage.append_message(
        "reader", project["id"], key, {"role": "assistant", "content": "2"}
    )
    storage.append_message("reader", project["id"], key, {"role": "user", "content": "3"})

    assert len(stale["messages"]) == 1
    assert [m["content"] for m in storage.get_thread("reader", project["id"], key)["messages"]] == [
        "1",
        "2",
        "3",
    ]

    # Clearing a context's only conversation empties it in place under a new
    # generation, so the old selector — and any late write through it — is stale.
    assert storage.delete_conversation("reader", empty["conversationId"], 0)["action"] == "reset"
    with pytest.raises(HTTPException) as stale_key:
        storage.get_thread("reader", project["id"], key)
    assert stale_key.value.status_code == 409
    cleared = storage.get_thread("reader", project["id"], chat_key(storage, "reader", project["id"], "paper-p"))
    assert cleared["messages"] == [] and cleared["conversationId"] == empty["conversationId"]


def test_a_conversation_remembers_the_persona_it_is_held_in(storage):
    """
    A persona is a property of the conversation, not of the project it sits in,
    so it survives a read and two conversations hold different ones at once.
    """
    project = storage.create_project("reader", "Personas")
    storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )
    key = chat_key(storage, "reader", project["id"], "paper-p")

    # Never chosen reads as None in *both* backends. The filesystem record has
    # no `personaId` key at all before one is picked, and an absent key has to
    # answer the same as a NULL column — this suite exists for exactly that
    # divergence.
    assert storage.get_thread("reader", project["id"], key)["personaId"] is None

    storage.set_conversation_persona(
        "reader", project_id=project["id"], thread_key=key, persona_id="mentor"
    )
    assert storage.get_thread("reader", project["id"], key)["personaId"] == "mentor"

    # The account-wide conversation is a scope like any other and keeps its own.
    kb = chat_key(storage, "reader")
    assert storage.get_thread("reader", None, kb)["personaId"] is None
    storage.set_conversation_persona(
        "reader", project_id=None, thread_key=kb, persona_id="tutor"
    )
    assert storage.get_thread("reader", None, kb)["personaId"] == "tutor"
    # Setting one did not reach the other.
    assert storage.get_thread("reader", project["id"], key)["personaId"] == "mentor"


def test_choosing_a_persona_does_not_put_a_conversation_in_the_recent_list(storage):
    """
    Picking a persona writes to the conversation, which means creating one if
    the reader has not spoken yet. That must not show up as a chat they had.

    Both backends already require a message before a conversation is recent —
    `exists(chat_messages)` in SQL, a truthy `messages` on the filesystem — and
    this pins the two together, because the alternative is a menu that quietly
    litters the reader's history every time it is opened.
    """
    project = storage.create_project("reader", "Quiet")
    storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )
    key = chat_key(storage, "reader", project["id"], "paper-p")

    storage.set_conversation_persona(
        "reader", project_id=project["id"], thread_key=key, persona_id="adhd"
    )
    assert storage.list_recent_conversations("reader") == []

    storage.append_message("reader", project["id"], key, {"role": "user", "content": "1"})
    assert len(storage.list_recent_conversations("reader")) == 1


def test_dropping_the_last_user_turn_is_a_tail_delete_not_a_rewrite(storage):
    """
    Editing the latest question removes that prompt and the stale answer after
    it, and nothing earlier. A later question from another tab is a 409 so two
    tabs cannot silently drop each other's turns — the same reason append is
    not a whole-thread write.
    """
    project = storage.create_project("reader", "Chat")
    storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )
    key = chat_key(storage, "reader", project["id"], "paper-p")
    storage.append_message(
        "reader", project["id"], key,
        {"role": "user", "content": "keep me", "requestId": "request_keep01"},
    )
    storage.append_message(
        "reader", project["id"], key,
        {"role": "assistant", "content": "kept answer", "requestId": "request_keep01"},
    )
    storage.append_message(
        "reader", project["id"], key,
        {"role": "user", "content": "typo here", "requestId": "request_edit01"},
    )
    storage.append_message(
        "reader", project["id"], key,
        {
            "role": "assistant",
            "content": "stale answer",
            "requestId": "request_edit01",
        },
    )
    dropped = storage.drop_from_last_user_turn(
        "reader", project["id"], key, "request_edit01",
    )
    assert [item["content"] for item in dropped] == ["typo here", "stale answer"]
    remaining = storage.get_thread("reader", project["id"], key)["messages"]
    assert [item["content"] for item in remaining] == ["keep me", "kept answer"]

    with pytest.raises(HTTPException) as moved:
        storage.drop_from_last_user_turn(
            "reader", project["id"], key, "request_edit01",
        )
    assert moved.value.status_code == 409

    kb = chat_key(storage, "reader")
    storage.append_memory_message(
        "reader",
        {"role": "user", "content": "wiki question", "requestId": "request_wiki01"}, kb,
    )
    storage.append_memory_message(
        "reader",
        {"role": "assistant", "content": "wiki answer", "requestId": "request_wiki01"}, kb,
    )
    storage.drop_from_last_user_turn("reader", None, kb, "request_wiki01")
    assert storage.get_thread("reader", None, kb)["messages"] == []


def test_an_answer_holds_the_documents_session_job_and_retracting_it_leaves_the_queue_alone(storage):
    project = storage.create_project("reader", "Jobs")
    storage.add_paper(
        "reader", project["id"], {"id": "kept", "title": "Kept", "filename": "k.pdf"}
    )
    key = chat_key(storage, "reader", project["id"], "paper-kept")
    storage.append_message(
        "reader",
        project["id"],
        key,
        {"role": "user", "content": "what is this", "requestId": "answer-retried1"},
    )
    storage.append_message(
        "reader",
        project["id"],
        key,
        {"role": "assistant", "content": "an answer", "requestId": "answer-retried1"},
    )
    # A whole answer holds the document's session job beside the document's own.
    queued = [(job["kind"], job["marker"]) for job in storage.list_memory_jobs("reader")]
    assert queued == [("document", "paper:kept"), ("session", "session:paper:kept")]

    # Retracting the turn removes no job: the session's job finds nothing left
    # to file when it runs, and ends without a model call.
    storage.drop_from_last_user_turn(
        "reader", project["id"], key, "answer-retried1",
    )
    assert [(job["kind"], job["marker"]) for job in storage.list_memory_jobs("reader")] == queued
    assert storage.get_thread("reader", project["id"], key)["messages"] == []


def test_highlights_round_trip_both_variants(storage):
    project = storage.create_project("reader", "Marks")
    storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )

    pdf = storage.add_highlight(
        "reader",
        project["id"],
        "p",
        {
            "type": "pdf",
            "page": 3,
            "rects": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04}],
            "text": "a claim",
            "color": "amber",
        },
    )
    assert pdf["type"] == "pdf" and pdf["page"] == 3
    assert pdf["rects"] == [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04}]

    text = storage.add_highlight(
        "reader",
        project["id"],
        "p",
        {"type": "text", "start": 10, "end": 20, "text": "b claim", "color": "amber"},
    )
    assert text["start"] == 10 and text["end"] == 20

    listed = storage.list_highlights("reader", project["id"], "p")
    assert {item["id"] for item in listed} == {pdf["id"], text["id"]}

    storage.delete_highlight("reader", project["id"], "p", pdf["id"])
    assert [item["id"] for item in storage.list_highlights("reader", project["id"], "p")] == [
        text["id"]
    ]


def add_annotated_paper(storage, project_id, paper_id="p"):
    """A paper with one stroke on it, ready for a note to hang off."""
    storage.add_paper(
        "reader",
        project_id,
        {"id": paper_id, "title": "P", "filename": "p.pdf"},
    )
    return storage.add_highlight(
        "reader",
        project_id,
        paper_id,
        {
            "type": "pdf",
            "page": 3,
            "rects": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04}],
            "text": "a claim",
            "color": "amber",
        },
    )


def note_payload(highlight_id, body="compare against the SSD-LM numbers"):
    return {
        "highlightId": highlight_id,
        "page": 3,
        "anchorY": 0.2,
        "quotedText": "a claim",
        "body": body,
    }


def test_notes_round_trip(storage):
    project = storage.create_project("reader", "Marks")
    highlight = add_annotated_paper(storage, project["id"])

    note = storage.add_note(
        "reader", project["id"], "p", note_payload(highlight["id"])
    )
    assert note["highlightId"] == highlight["id"]
    assert note["page"] == 3 and note["anchorY"] == 0.2
    assert note["body"] == "compare against the SSD-LM numbers"
    assert note["filedAt"] is None

    listed = storage.list_notes("reader", project["id"], "p")
    assert [item["id"] for item in listed] == [note["id"]]

    edited = storage.update_note(
        "reader", project["id"], "p", note["id"], "actually the opposite"
    )
    assert edited["body"] == "actually the opposite"
    assert edited["id"] == note["id"]

    storage.delete_note("reader", project["id"], "p", note["id"])
    assert storage.list_notes("reader", project["id"], "p") == []


def test_an_anchor_holds_one_note_so_writing_again_is_an_edit(storage):
    # Re-opening the icon and typing is an edit. A second row would give the
    # gutter two icons at the same coordinate, one of them unreachable.
    project = storage.create_project("reader", "Marks")
    highlight = add_annotated_paper(storage, project["id"])

    first = storage.add_note(
        "reader", project["id"], "p", note_payload(highlight["id"], "first thought")
    )
    second = storage.add_note(
        "reader", project["id"], "p", note_payload(highlight["id"], "second thought")
    )

    assert second["id"] == first["id"]
    listed = storage.list_notes("reader", project["id"], "p")
    assert len(listed) == 1
    assert listed[0]["body"] == "second thought"


def test_removing_a_stroke_removes_its_note_but_not_the_other_way_round(storage):
    # The highlight owns where the note points, so a note cannot outlive it.
    # Emptying the editor, though, means "no note here" — not "un-highlight it".
    project = storage.create_project("reader", "Marks")
    highlight = add_annotated_paper(storage, project["id"])
    note = storage.add_note(
        "reader", project["id"], "p", note_payload(highlight["id"])
    )

    storage.delete_note("reader", project["id"], "p", note["id"])
    assert len(storage.list_highlights("reader", project["id"], "p")) == 1

    again = storage.add_note(
        "reader", project["id"], "p", note_payload(highlight["id"])
    )
    storage.delete_highlight("reader", project["id"], "p", highlight["id"])
    assert storage.list_notes("reader", project["id"], "p") == []
    assert again["id"] is not None


def test_a_note_is_unfiled_until_a_pass_reads_it_and_unfiled_again_when_edited(storage):
    # The whole of the lazy contract: a note is offered to the document's next
    # pass until a pass has actually used it, and nothing else stops that.
    # Changing it puts it back in the queue.
    project = storage.create_project("reader", "Marks")
    highlight = add_annotated_paper(storage, project["id"])
    note = storage.add_note(
        "reader", project["id"], "p", note_payload(highlight["id"])
    )

    assert [item["id"] for item in storage.list_unfiled_notes("reader", project["id"], "p")] == [
        note["id"]
    ]

    storage.mark_notes_filed(
        "reader", project["id"], "p", [note["id"]], "2026-08-10T00:00:00Z"
    )
    assert storage.list_unfiled_notes("reader", project["id"], "p") == []
    assert storage.list_notes("reader", project["id"], "p")[0]["filedAt"] == (
        "2026-08-10T00:00:00Z"
    )

    storage.update_note("reader", project["id"], "p", note["id"], "revised")
    assert [item["id"] for item in storage.list_unfiled_notes("reader", project["id"], "p")] == [
        note["id"]
    ]


def test_every_change_to_a_note_holds_the_one_session_job_of_its_document(storage):
    # A note may change Memory, but not each time one is taken: every change
    # refreshes one waiting job, and the job runs when the session ends.
    project = storage.create_project("reader", "Marks")
    highlight = add_annotated_paper(storage, project["id"])
    before = [job["id"] for job in storage.list_memory_jobs("reader")]

    def held():
        [job] = [job for job in storage.list_memory_jobs("reader") if job["id"] not in before]
        assert (job["kind"], job["marker"], job["status"]) == ("session", "session:paper:p", "pending")
        assert job["retryAt"] > "2026" and job["payload"]["projectId"] == project["id"]
        return job["id"], job["payload"]["fingerprint"]

    note = storage.add_note(
        "reader", project["id"], "p", note_payload(highlight["id"])
    )
    first = held()
    storage.update_note("reader", project["id"], "p", note["id"], "revised")
    second = held()
    storage.delete_note("reader", project["id"], "p", note["id"])
    third = held()
    assert first[0] == second[0] == third[0]
    assert len({first[1], second[1], third[1]}) == 3
    # Deleting a note that is not there changes nothing, and neither does
    # deleting a highlight that carries none.
    storage.delete_note("reader", project["id"], "p", note["id"])
    storage.delete_highlight("reader", project["id"], "p", highlight["id"])
    assert held() == third


def test_storing_a_linked_pdf_keeps_the_paper_and_stops_serving_its_address(storage):
    # The id is the point: a re-import would have made a second document and
    # orphaned the highlights, notes, digest and thread hanging off this one.
    project = storage.create_project("reader", "Links")
    storage.add_paper(
        "reader",
        project["id"],
        {
            "id": "p",
            "title": "MDLM",
            "filename": "2406.07524v2.pdf",
            "kind": "web",
            "url": "https://arxiv.org/pdf/2406.07524v2",
            "favicon": "https://arxiv.org/favicon.ico",
            "pages": 20,
        },
    )
    stroke = storage.add_highlight(
        "reader",
        project["id"],
        "p",
        {"type": "pdf", "page": 1, "rects": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04}],
         "text": "a claim", "color": "amber"},
    )
    storage.add_note("reader", project["id"], "p", note_payload(stroke["id"]))

    stored = storage.store_linked_pdf(
        "reader",
        project["id"],
        "p",
        {
            "filename": "2406.07524v2.pdf",
            "pages": 21,
            "tokens": 9000,
            "bytes": 1234,
            "sourceHash": "b" * 64,
        },
    )

    assert stored["id"] == "p"
    assert stored["pages"] == 21 and stored["bytes"] == 1234
    # A stored PDF's record is a PDF's exactly — no `kind`, no `url`, no
    # `favicon` — so nothing downstream can mistake it for a live document.
    assert "kind" not in stored
    assert "url" not in stored
    assert "favicon" not in stored
    assert storage.get_paper("reader", project["id"], "p") == stored

    assert len(storage.list_highlights("reader", project["id"], "p")) == 1
    assert len(storage.list_notes("reader", project["id"], "p")) == 1


def test_deleting_a_project_reports_provider_files_and_removes_everything(storage):
    project = storage.create_project("reader", "Doomed")
    storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )
    storage.set_openai_file("reader", project["id"], "p", "file-abc")

    removed = storage.delete_project("reader", project["id"])
    assert removed.openai_file_ids == ["file-abc"]
    assert storage.list_projects("reader") == []
    with pytest.raises(HTTPException) as gone:
        storage.get_project("reader", project["id"])
    assert gone.value.status_code == 404


# --- the raw-layer index ------------------------------------------------
# Derived rows, so these assert the properties a cache has to hold: it agrees
# with the objects it was built from, it belongs to exactly one account, it
# survives being rebuilt, and it disappears with what it described.

SECTIONS = [
    {
        "kind": "page",
        "locator": "1",
        "ordinal": 1,
        "title": "Page 1",
        "text": "We introduce a variational autoencoder trained by amortized inference.",
    },
    {
        "kind": "page",
        "locator": "2",
        "ordinal": 2,
        "title": "Page 2",
        "text": "Related work mentions autoencoder architectures only in passing.",
    },
]


def indexed_project(storage, name, paper_id, sections):
    project = storage.create_project("reader", name)
    storage.add_paper(
        "reader",
        project["id"],
        {"id": paper_id, "title": f"{name} paper", "filename": f"{paper_id}.pdf"},
    )
    storage.index_document_sections("reader", project["id"], paper_id, sections)
    return project


def test_coverage_beats_repetition_however_often_one_term_is_said(storage):
    """Both backends weight coverage, and it outranks sheer frequency.

    `score_section` multiplies its frequency total by `(covered / len(terms))
    ** 2`; Postgres reaches the same shape by multiplying `ts_rank_cd` — which
    measures how densely matches cluster and knows nothing about how many terms
    matched at all — by the same factor. Without it the two backends disagreed
    about the *first* result, which is the one anybody looks at: over an `OR`
    query a short section shouting one term outranked the section that actually
    answered the question.

    Coverage is a *weighting*, not an override, and the fixture says so: three
    repetitions of one term lose to a section holding both, and the first draft
    of this test used thirty, which beats coverage on the filesystem backend
    too (`min(in_text, 12)` lets one term earn twelve while full coverage of two
    single mentions earns two). A test asserting more than the scorer promises
    is a test that will be deleted the first time someone tunes it.
    """
    indexed_project(
        storage,
        "Covers both",
        "both",
        [
            {
                "kind": "page",
                "locator": "1",
                "ordinal": 1,
                "title": "Page 1",
                "text": "A variational autoencoder, described once.",
            }
        ],
    )
    indexed_project(
        storage,
        "Repeats one",
        "loud",
        [
            {
                "kind": "page",
                "locator": "1",
                "ordinal": 1,
                "title": "Page 1",
                "text": " ".join(["variational"] * 3),
            }
        ],
    )

    hits = storage.search_documents("reader", "variational autoencoder")

    assert [hit["paperId"] for hit in hits][0] == "both"
    # The near miss is still a hit — this is the ladder's raw rung, where a
    # partial answer beats nothing, unlike the collective search box.
    assert {hit["paperId"] for hit in hits} == {"both", "loud"}
    assert hits[0]["score"] > hits[1]["score"]


def test_library_search_reaches_across_projects_and_ranks_the_better_page_first(storage):
    first = indexed_project(storage, "Alpha", "a", SECTIONS)
    second = indexed_project(
        storage,
        "Beta",
        "b",
        [
            {
                "kind": "section",
                "locator": "variational-inference",
                "ordinal": 1,
                "title": "Variational inference",
                "text": "A short note on the variational objective.",
            }
        ],
    )

    hits = storage.search_documents("reader", "variational autoencoder")

    # One question, two projects: the whole reason search is account-wide.
    assert {hit["projectId"] for hit in hits} == {first["id"], second["id"]}
    # The page that actually discusses both terms outranks the ones that
    # mention one of them, which is the coverage half of the ranking.
    assert hits[0]["paperId"] == "a" and hits[0]["locator"] == "1"
    assert hits[0]["snippet"]
    assert hits[0]["locatorLabel"] == "p. 1"
    # A section carries the anchor a citation already uses, not a page number.
    section_hit = next(hit for hit in hits if hit["paperId"] == "b")
    assert section_hit["kind"] == "section"
    assert section_hit["locator"] == "variational-inference"

    # Scoping is a filter the caller may ask for, never the default.
    scoped = storage.search_documents("reader", "autoencoder", project_id=first["id"])
    assert {hit["projectId"] for hit in scoped} == {first["id"]}
    # And to one document, for a reader that may read only that one.
    one = storage.search_documents("reader", "variational autoencoder", paper_id="a")
    assert one and {hit["paperId"] for hit in one} == {"a"}


def test_a_strangers_documents_never_appear_in_a_search(storage):
    project = indexed_project(storage, "Private", "a", SECTIONS)
    storage.create_account("stranger", None, "salt", "hash")

    assert storage.search_documents("stranger", "variational") == []
    # And the write side is scoped the same way: a project owned by someone
    # else is absent, not forbidden.
    with pytest.raises(HTTPException) as hidden:
        storage.index_document_sections("stranger", project["id"], "a", SECTIONS)
    assert hidden.value.status_code == 404


def test_extracted_html_title_can_be_stored_and_found(storage):
    from delphi_core.document_index import sections_from_web_document
    from delphi_core.web_extract import extract

    document = extract(
        "<html><head><title>Rényi bo\x00und</title></head>"
        "<body><article><p>A useful result.</p></article></body></html>",
        "https://example.test/article", 600_000,
    )
    project = storage.create_project("reader", "Alpha")
    paper = storage.add_paper("reader", project["id"], {
        "id": "web-title", "kind": "web", "filename": "article.web",
        "title": document["title"],
    })
    assert paper["title"] == "Rényi bound"
    storage.index_document_sections(
        "reader", project["id"], paper["id"], sections_from_web_document(document),
    )
    hits = storage.search_workspace("reader", "bound")["documents"]
    assert len(hits) == 1
    assert hits[0]["title"] == "Rényi bound"


def test_reindexing_replaces_rather_than_accumulates(storage):
    project = indexed_project(storage, "Alpha", "a", SECTIONS)

    # Re-running the backfill must not duplicate anything.
    storage.index_document_sections("reader", project["id"], "a", SECTIONS)
    assert len(storage.search_documents("reader", "autoencoder")) == 2

    # A re-snapshot that dropped a section must drop it from search too, or a
    # citation points at a heading the document no longer has.
    storage.index_document_sections("reader", project["id"], "a", SECTIONS[:1])
    remaining = storage.search_documents("reader", "autoencoder")
    assert [hit["locator"] for hit in remaining] == ["1"]


@pytest.mark.parametrize("kind", ["pdf", "web"])
def test_indexing_source_controls_preserves_objects_and_restores_search(storage, tmp_path, kind):
    from delphi_core.routers.projects import index_paper_sections
    from delphi_core.storage import LocalObjectStore, paper_key

    project = storage.create_project("reader", "Alpha")
    paper = storage.add_paper("reader", project["id"], {
        "id": "a", "title": "Document", "filename": "a.pdf", "kind": kind,
    })
    storage.index_document_sections("reader", project["id"], "a", SECTIONS)
    objects = LocalObjectStore(tmp_path / "objects")
    source = (
        "--- Page 1 ---\nClean introduction.\n--- Page 2 ---\n"
        "A vari\x00ational bottleneck preserves café information."
        if kind == "pdf" else json.dumps({"sections": [
            {"anchor": "intro", "title": "Introduction", "markdown": "Clean introduction."},
            {"anchor": "result", "title": "Res\x00ult", "markdown":
             "A vari\x00ational bottleneck preserves café information."},
        ]})
    )
    key = paper_key("reader", project["id"], "a", "txt" if kind == "pdf" else "web")
    objects.put_text(key, source)
    for _ in range(2):
        assert index_paper_sections(storage, objects, "reader", project["id"], paper) == 2
        hits = storage.search_documents("reader", "bottleneck")
        assert len(hits) == 1
        assert hits[0]["locator"] == ("2" if kind == "pdf" else "result")
        assert "variational" in hits[0]["snippet"]
        assert "café" in hits[0]["snippet"]
        assert len(storage.search_workspace("reader", "bottleneck")["documents"]) == 1
        assert objects.get_text(key) == source


def test_deleting_a_paper_removes_its_sections(storage):
    project = indexed_project(storage, "Alpha", "a", SECTIONS)

    storage.delete_paper("reader", project["id"], "a")

    assert storage.search_documents("reader", "autoencoder") == []


def test_moving_a_paper_carries_its_sections_to_the_new_project(storage):
    source = indexed_project(storage, "Alpha", "a", SECTIONS)
    destination = storage.create_project("reader", "Beta")

    storage.move_paper("reader", source["id"], "a", destination["id"])

    hits = storage.search_documents("reader", "autoencoder")
    # Left behind, a hit would name the project the paper just left.
    assert {hit["projectId"] for hit in hits} == {destination["id"]}
    assert {hit["projectName"] for hit in hits} == {"Beta"}


def test_an_empty_query_returns_nothing_rather_than_the_whole_library(storage):
    indexed_project(storage, "Alpha", "a", SECTIONS)

    assert storage.search_documents("reader", "") == []
    assert storage.search_documents("reader", "   ") == []


# --- the account-wide search box --------------------------------------------
#
# `search_documents` above is the lenient search the model's tools use. These
# cases are its opposite number, and what they hold both backends to is the
# collective rule: Postgres enforces it with an `&`-joined tsquery, the
# filesystem backend with a gate in `score_collective`, and a divergence between
# those two is exactly the kind of thing only a shared suite notices.


def searchable_account(storage):
    """One account holding all three kinds of thing a search can reach."""
    project = indexed_project(
        storage,
        "Diffusion",
        "a",
        [
            {
                "kind": "page", "locator": "1", "ordinal": 1, "title": "",
                "text": "We train the metaquery encoder; the training signal "
                        "comes from the retrieval head.",
            },
            {
                "kind": "page", "locator": "2", "ordinal": 2, "title": "",
                "text": "The metaquery is passed to the decoder unchanged.",
            },
        ],
    )
    storage.upsert_memory_page(
        "reader",
        {
            "slug": "metaquery-training", "kind": "concept",
            "domain": "retrieval", "title": "Metaquery training",
            "summary": "How the metaquery encoder is trained.",
            "body": "The metaquery training objective is contrastive.",
        },
        max_pages=400,
    )
    storage.append_message(
        "reader", project["id"], chat_key(storage, "reader", project["id"], "paper-a"),
        {"role": "user", "content": "how is the metaquery training set up?"},
    )
    return project


def test_the_search_box_reaches_pages_documents_and_chats_alike(storage):
    project = searchable_account(storage)

    found = storage.search_workspace("reader", "metaquery training")

    assert [hit["slug"] for hit in found["memory"]] == ["metaquery-training"]
    # The locator is what makes a document hit openable at the right place.
    assert [hit["locator"] for hit in found["documents"]] == ["1"]
    assert found["documents"][0]["projectSlug"] == project["slug"]
    assert len(found["conversations"]) == 1
    assert "metaquery" in found["conversations"][0]["snippet"]
    # One shape whatever it names, so one renderer draws all three.
    for rows in found.values():
        for hit in rows:
            assert {"kind", "title", "subtitle", "snippet", "score"} <= set(hit)


def test_a_query_is_one_phrase_and_not_a_bag_of_words(storage):
    searchable_account(storage)

    both = storage.search_workspace("reader", "metaquery training")
    # Page 2 says "metaquery" and never "training"; a coverage-weighted search
    # would rank it below page 1 and still return it.
    assert [hit["locator"] for hit in both["documents"]] == ["1"]

    # Each term alone still finds what it names — it is the pair that is one
    # question, not the words individually. Both pages say "metaquery" and both
    # belong to one paper, so what comes back is one document that said it
    # twice, quoted at the first of them.
    alone = storage.search_workspace("reader", "metaquery")
    assert [hit["locator"] for hit in alone["documents"]] == ["1"]
    assert alone["documents"][0]["occurrences"] == 2


def test_a_document_appears_once_however_often_it_says_the_word(storage):
    """
    A section is where the words sit; a document is what the reader is after.

    Ranking the places would fill the list with one document's table of
    contents — six rows of the same title — and bury every other document that
    answered the question once.
    """
    searchable_account(storage)
    indexed_project(
        storage,
        "Robotics",
        "b",
        [{"kind": "page", "locator": "1", "ordinal": 1, "title": "",
          "text": "A passing note on metaquery encoders."}],
    )

    found = storage.search_workspace("reader", "metaquery")

    assert [hit["occurrences"] for hit in found["documents"]] == [2, 1]
    # Repetition is a tie-break on top of the best place, not a replacement for
    # it: the document that says it twice comes first.
    assert found["documents"][0]["projectSlug"] != found["documents"][1]["projectSlug"]


def test_a_conversation_is_quoted_at_the_turn_that_first_said_it(storage):
    """
    The earliest matching turn, not the strongest.

    It is where the reader asked the question they are now searching for, and
    it does not move when they retype the query differently.
    """
    project = indexed_project(storage, "Diffusion", "a", [])
    for text in (
        "how is the metaquery training set up?",
        "and the metaquery training schedule, and the metaquery training loss?",
    ):
        storage.append_message(
            "reader", project["id"], chat_key(storage, "reader", project["id"], "paper-a"),
            {"role": "user", "content": text},
        )

    found = storage.search_workspace("reader", "metaquery training")

    assert len(found["conversations"]) == 1
    assert "how is the metaquery training set up" in found["conversations"][0]["snippet"]
    assert found["conversations"][0]["occurrences"] == 2


def test_the_search_box_is_scoped_to_its_account(storage):
    searchable_account(storage)
    storage.create_account("stranger", None, "salt", "hash")

    assert storage.search_workspace("stranger", "metaquery training") == {
        "memory": [], "documents": [], "conversations": []
    }


def test_an_empty_query_searches_nothing_rather_than_everything(storage):
    searchable_account(storage)

    assert storage.search_workspace("reader", "   ") == {
        "memory": [], "documents": [], "conversations": []
    }


def test_each_scope_is_bounded_by_the_limit_it_was_given(storage):
    searchable_account(storage)

    found = storage.search_workspace("reader", "metaquery", limit=1)

    assert len(found["documents"]) == 1


def test_every_account_is_listed_for_maintenance(storage):
    storage.create_account("second", None, "salt", "hash")

    assert storage.list_usernames() == ["reader", "second"]


# --- Memory -------------------------------------------------
# Every case here is scoped to an account, never a project. That is the whole
# correction the KB makes to per-project notes, and it is the property most
# likely to be eroded by a later convenience.


def concept(slug="kl-divergence", **overrides):
    return {
        "slug": slug,
        "kind": "concept",
        "domain": "ml",
        "title": "KL divergence",
        "summary": "why it appears in the ELBO",
        "body": "Part of [[ml]]. See also [[variational-inference]].",
        **overrides,
    }


def test_a_memory_page_round_trips_and_rebuilds_its_links(storage):
    written = storage.upsert_memory_page("reader", concept(), max_pages=50)

    assert written["slug"] == "kl-divergence"
    assert written["revision"] == 1
    # Edges come out of the body, so a page and its links cannot disagree.
    assert set(written["links"]) == {"ml", "variational-inference"}

    read = storage.get_memory_page("reader", "kl-divergence")
    assert read["body"] == concept()["body"]
    # A page records nothing about how well, how often or how recently the
    # reader met it.
    assert not {"level", "observations", "lastSeenAt", "encounters"} & set(read)

    # Keyed by slug, so filing the same thing twice revises rather than
    # duplicating — which is what makes an ingest safe to retry.
    again = storage.upsert_memory_page(
        "reader", concept(body="Part of [[ml]] only."), max_pages=50
    )
    assert again["revision"] == 2
    assert again["links"] == ["ml"]
    assert len(storage.list_memory_pages("reader")) == 1


def test_graph_revision_changes_only_with_graph_state(storage):
    initial = storage.memory_graph_revision("reader")

    storage.upsert_memory_page("reader", concept(), max_pages=50)
    written = storage.memory_graph_revision("reader")
    assert written != initial

    # A failed write publishes neither graph state nor an invalidation key.
    before_failure = storage.memory_graph_revision("reader")
    with pytest.raises(HTTPException):
        storage.upsert_memory_page(
            "reader", concept(slug="second", title="Second"), max_pages=1
        )
    assert storage.memory_graph_revision("reader") == before_failure

    storage.delete_memory_page("reader", "kl-divergence")
    removed = storage.memory_graph_revision("reader")
    assert removed != written


def test_memory_snapshot_replacement_is_complete_and_atomic(storage):
    storage.upsert_memory_page("reader", concept(), max_pages=50)
    # A figure on the page being replaced, because production has one on almost
    # every source page and the replacement never names `memory_figures`: it
    # leans on the page's `ondelete="CASCADE"`. A snapshot carrying no figures
    # would not notice a row left behind pointing at a page that is gone.
    storage.add_memory_figure(
        "reader",
        {
            "id": "old-figure",
            "pageSlug": "kl-divergence",
            "caption": "written by the pass being replaced",
            "objectKey": "knowledge/u/reader/figures/old-figure.webp",
            "origin": {"paperId": "paper-a", "page": 7},
            "width": 800,
            "height": 400,
            "bytes": 20_000,
        },
        max_per_page=4,
    )
    storage.append_memory_event(
        "reader", {"kind": "answer", "requestId": "old-event"}
    )
    storage.enqueue_memory_job(
        "reader",
        kind="domain",
        marker="old-job",
        payload={"projectId": "project", "conversationId": "conversation"},
    )
    before = storage.memory_graph_revision("reader")
    snapshot = {
        "domains": [
            {
                "slug": "systems",
                "title": "Systems",
                "origin": "reader",
                "position": 0,
            }
        ],
        "pages": [
            {
                "id": "candidate-page",
                "slug": "new-source",
                "kind": "source",
                "domain": "systems",
                "title": "New source",
                "summary": "Built in isolation.",
                "body": "Explains [[new-concept]].",
                "sourcePaperId": "paper-1",
                "sourceProjectId": "project-1",
            }
        ],
        "figures": [
            {
                "id": "candidate-figure",
                "pageId": "candidate-page",
                "caption": "captured in isolation",
                "objectKey": "knowledge/u/reader/figures/candidate-figure.webp",
                "origin": {"paperId": "paper-1", "page": 3},
                "width": 640,
                "height": 480,
                "bytes": 10_000,
            }
        ],
        "events": [
            {
                "kind": "document",
                "requestId": "paper:paper-1",
                "createdAt": "2026-09-01T12:00:00Z",
            }
        ],
    }

    storage.replace_memory_snapshot("reader", snapshot, max_pages=50)

    assert storage.memory_graph_revision("reader") != before
    assert [page["slug"] for page in storage.list_memory_pages("reader")] == [
        "new-source"
    ]
    assert storage.list_memory_links("reader") == [
        {"from": "new-source", "to": "new-concept"}
    ]
    assert storage.memory_domains("reader")[0]["origin"] == "reader"
    assert storage.list_memory_events("reader")[0]["requestId"] == (
        "paper:paper-1"
    )
    assert storage.list_memory_jobs("reader") == []
    # The old figure went with its page; the candidate's arrived with the new
    # one. A figure the snapshot did not carry must not survive it.
    assert [figure["id"] for figure in storage.list_memory_figures("reader")] == [
        "candidate-figure"
    ]
    with pytest.raises(HTTPException) as removed:
        storage.get_memory_page("reader", "kl-divergence")
    assert removed.value.status_code == 404


def test_invalid_snapshot_does_not_replace_the_active_graph(storage):
    storage.upsert_memory_page("reader", concept(), max_pages=50)
    before = storage.memory_graph_revision("reader")

    # A figure naming a page the candidate does not carry is refused by both
    # backends: the alternative is a figure row pointing at nothing, which
    # reads as a captured picture that will not load.
    with pytest.raises(HTTPException) as orphan:
        storage.replace_memory_snapshot(
            "reader",
            {
                "domains": [],
                "pages": [],
                "figures": [{"id": "lost", "pageId": "nobody", "caption": "orphan"}],
                "events": [],
            },
            max_pages=50,
        )
    assert orphan.value.status_code == 422
    assert storage.memory_graph_revision("reader") == before
    assert storage.get_memory_page("reader", "kl-divergence")["title"] == (
        "KL divergence"
    )


def test_a_listing_never_carries_a_page_body(storage):
    storage.upsert_memory_page("reader", concept(), max_pages=50)

    for entry in storage.list_memory_pages("reader"):
        # Structural, not a query discipline: a listing that can carry bodies
        # is a listing that eventually does.
        assert "body" not in entry
        assert entry["title"] == "KL divergence"

    for hit in storage.search_memory_pages("reader", "divergence"):
        assert "body" not in hit


def test_a_dangling_link_stays_on_the_edge_list(storage):
    storage.upsert_memory_page("reader", concept(), max_pages=50)

    # `variational-inference` has no page. The store keeps the edge anyway:
    # it records what the body says, and whoever writes a page repairs its links.
    assert "variational-inference" in storage.get_memory_page(
        "reader", "kl-divergence"
    )["links"]
    assert [
        entry["slug"]
        for entry in storage.memory_backlinks("reader", "variational-inference")
    ] == ["kl-divergence"]
    assert "variational-inference" not in {
        entry["slug"] for entry in storage.list_memory_pages("reader")
    }

    # Writing the target later resolves the link with no repair step: nothing
    # was ever stored that has to be rewritten.
    storage.upsert_memory_page(
        "reader",
        concept(slug="variational-inference", title="Variational inference", body="Body."),
        max_pages=50,
    )
    assert [
        entry["slug"]
        for entry in storage.memory_backlinks("reader", "variational-inference")
    ] == ["kl-divergence"]


def test_a_page_belongs_to_an_account_not_a_project(storage):
    project = storage.create_project("reader", "Diffusion")
    storage.upsert_memory_page(
        "reader", concept(sourceProjectId=project["id"]), max_pages=50
    )
    storage.create_account("stranger", None, "salt", "hash")

    # Deleting the project it was compiled from leaves its Memory pages standing.
    storage.delete_project("reader", project["id"])
    assert storage.get_memory_page("reader", "kl-divergence")["title"]

    # And a stranger sees nothing, with a 404 rather than a 403.
    assert storage.list_memory_pages("stranger") == []
    with pytest.raises(HTTPException) as hidden:
        storage.get_memory_page("stranger", "kl-divergence")
    assert hidden.value.status_code == 404


def test_the_page_count_is_bounded(storage):
    storage.upsert_memory_page("reader", concept(), max_pages=1)

    with pytest.raises(HTTPException) as full:
        storage.upsert_memory_page("reader", concept(slug="second"), max_pages=1)
    assert full.value.status_code == 409

    # A revision of an existing page is never refused: the bound is on how many
    # pages exist, not on how often one may be corrected.
    storage.upsert_memory_page("reader", concept(summary="revised"), max_pages=1)


def test_domains_are_counted_and_scoped_per_project(storage):
    first = storage.create_project("reader", "Machine learning")
    second = storage.create_project("reader", "Hiking")
    storage.upsert_memory_page(
        "reader", concept(sourceProjectId=first["id"]), max_pages=50
    )
    storage.upsert_memory_page(
        "reader",
        concept(
            slug="switchbacks",
            title="Switchbacks",
            domain="hiking",
            body="Body.",
            sourceProjectId=second["id"],
        ),
        max_pages=50,
    )

    assert {entry["domain"] for entry in storage.memory_domains("reader")} == {
        "ml",
        "hiking",
    }


def test_writing_a_page_creates_the_domain_it_claims(storage):
    # No page may reference a domain that does not exist. The row is written by
    # the page write itself, so an ingest naming a brand-new domain files
    # rather than failing.
    storage.upsert_memory_page("reader", concept(domain="astronomy"), max_pages=50)

    domains = {entry["slug"]: entry for entry in storage.memory_domains("reader")}
    assert domains["astronomy"]["origin"] == "model"
    assert domains["astronomy"]["title"] == "Astronomy"
    assert domains["astronomy"]["pages"] == 1


def test_a_domain_the_reader_named_keeps_its_title_and_is_never_downgraded(storage):
    storage.upsert_memory_domain(
        "reader",
        {
            "slug": "efficiency-serving",
            "title": "Efficiency & serving",
            "summary": "How models are made cheap enough to run.",
            "origin": "reader",
            "position": 2,
        },
    )
    # An ingest naming the same domain must not take it back off them, and must
    # not overwrite the name they chose with a slug in sentence case.
    storage.upsert_memory_page(
        "reader", concept(domain="efficiency-serving"), max_pages=50
    )

    record = next(
        entry
        for entry in storage.memory_domains("reader")
        if entry["slug"] == "efficiency-serving"
    )
    assert record["title"] == "Efficiency & serving"
    assert record["summary"] == "How models are made cheap enough to run."
    assert record["origin"] == "reader"
    assert record["position"] == 2
    assert record["pages"] == 1


def test_an_empty_domain_is_still_listed(storage):
    # The domain a reader has just created and not filed anything into yet is
    # exactly the one they need to see, so a zero count must not hide it.
    storage.upsert_memory_domain(
        "reader", {"slug": "roman-history", "title": "Roman history", "origin": "reader"}
    )

    listed = {entry["slug"]: entry for entry in storage.memory_domains("reader")}
    assert listed["roman-history"]["pages"] == 0


def test_domains_sort_by_reader_order_then_by_how_full_they_are(storage):
    storage.upsert_memory_page("reader", concept(), max_pages=50)
    storage.upsert_memory_page(
        "reader", concept(slug="switchbacks", domain="hiking"), max_pages=50
    )
    storage.upsert_memory_page(
        "reader", concept(slug="scree", domain="hiking"), max_pages=50
    )
    # Position is the reader's, and it wins over the page count.
    storage.upsert_memory_domain("reader", {"slug": "ml", "position": -1})

    assert [entry["slug"] for entry in storage.memory_domains("reader")] == [
        "ml",
        "hiking",
    ]


def test_a_domain_holding_pages_refuses_to_be_deleted(storage):
    storage.upsert_memory_page("reader", concept(), max_pages=50)

    # Cascading would delete the reader's own writing to tidy up a label.
    with pytest.raises(HTTPException) as refused:
        storage.delete_memory_domain("reader", "ml")
    assert refused.value.status_code == 409

    storage.delete_memory_page("reader", "kl-divergence")
    storage.delete_memory_domain("reader", "ml")
    assert all(entry["slug"] != "ml" for entry in storage.memory_domains("reader"))


def test_moving_pages_refiles_them_in_one_write(storage):
    storage.upsert_memory_page("reader", concept(), max_pages=50)
    storage.upsert_memory_page(
        "reader", concept(slug="elbo", title="ELBO"), max_pages=50
    )
    moved = storage.move_memory_pages(
        "reader", ["kl-divergence", "elbo"], "variational-methods"
    )

    assert {page["domain"] for page in moved} == {"variational-methods"}
    # The destination exists as a record, not just as a string on two pages.
    assert any(
        entry["slug"] == "variational-methods"
        for entry in storage.memory_domains("reader")
    )
    after = {page["slug"]: page for page in storage.list_memory_pages("reader")}
    assert {after[slug]["domain"] for slug in ("kl-divergence", "elbo")} == {"variational-methods"}


def test_moving_a_page_that_does_not_exist_moves_nothing(storage):
    storage.upsert_memory_page("reader", concept(), max_pages=50)

    with pytest.raises(HTTPException) as refused:
        storage.move_memory_pages("reader", ["kl-divergence", "no-such-page"], "ml2")
    assert refused.value.status_code == 404


def test_figures_are_page_scoped_owner_only_and_bounded(storage):
    storage.upsert_memory_page("reader", concept(), max_pages=50)
    storage.create_account("stranger", None, "salt", "hash")

    figure = storage.add_memory_figure(
        "reader",
        {
            "id": "fig1",
            "pageSlug": "kl-divergence",
            "caption": "where the gap opens",
            "objectKey": "knowledge/u/reader/figures/fig1.webp",
            "origin": {"paperId": "paper-a", "page": 7},
            "width": 800,
            "height": 400,
            "bytes": 20_000,
        },
        max_per_page=1,
    )
    assert figure["captured"] is True
    assert storage.get_memory_figure("reader", "fig1")["caption"] == (
        "where the gap opens"
    )

    with pytest.raises(HTTPException) as full:
        storage.add_memory_figure(
            "reader", {"id": "fig2", "pageSlug": "kl-divergence"}, max_per_page=1
        )
    assert full.value.status_code == 409

    # Pixels out of someone's own library: absent for anyone else.
    with pytest.raises(HTTPException) as hidden:
        storage.get_memory_figure("stranger", "fig1")
    assert hidden.value.status_code == 404

    # Deleting the page reports the bytes, because no store can cascade into
    # the object store.
    removed = storage.delete_memory_page("reader", "kl-divergence")
    assert removed.object_keys == ["knowledge/u/reader/figures/fig1.webp"]
    assert storage.list_memory_figures("reader") == []


def test_a_figure_that_could_not_be_captured_is_kept_as_a_link(storage):
    storage.upsert_memory_page("reader", concept(), max_pages=50)

    figure = storage.add_memory_figure(
        "reader",
        {
            "id": "fig1",
            "pageSlug": "kl-divergence",
            "caption": "the architecture",
            "sourceUrl": "https://example.test/fig.png",
        },
        max_per_page=6,
    )

    # It appears rather than vanishing, and says it is a link so the lint pass
    # can report it when it stops resolving.
    assert figure["captured"] is False
    assert figure["sourceUrl"] == "https://example.test/fig.png"
    assert storage.delete_memory_page("reader", "kl-divergence").object_keys == []


def test_figures_list_by_page(storage):
    """`page_id` narrows the listing to one page's figures, in the order they were kept, in both stores."""
    storage.create_account("stranger", None, "salt", "hash")
    pages = {
        slug: storage.upsert_memory_page("reader", concept(slug, title=title), max_pages=50)["id"]
        for slug, title in (("kl-divergence", "KL divergence"), ("elbo", "ELBO"))
    }
    for figure_id, slug in (("fig-kl-1", "kl-divergence"), ("fig-elbo", "elbo"), ("fig-kl-2", "kl-divergence")):
        storage.add_memory_figure(
            "reader",
            {"id": figure_id, "pageSlug": slug, "caption": figure_id,
             "objectKey": f"knowledge/u/reader/figures/{figure_id}.webp"},
            max_per_page=6,
        )

    def listed(username="reader", **narrowed):
        return [(figure["id"], figure["pageId"]) for figure in storage.list_memory_figures(username, **narrowed)]

    assert listed(page_id=pages["kl-divergence"]) == [
        ("fig-kl-1", pages["kl-divergence"]), ("fig-kl-2", pages["kl-divergence"])]
    assert listed(page_id=pages["elbo"]) == [("fig-elbo", pages["elbo"])]
    assert sorted(listed()) == sorted(listed(page_id=pages["kl-divergence"]) + listed(page_id=pages["elbo"]))
    assert listed(page_id="no-such-page") == []
    assert listed("stranger", page_id=pages["elbo"]) == []


def test_memory_events_and_messages_are_appended_not_rewritten(storage):
    storage.append_memory_event("reader", {"kind": "ingest", "summary": "one"})
    storage.append_memory_event("reader", {"kind": "lint", "summary": "two"})

    events = storage.list_memory_events("reader")
    assert [event["summary"] for event in events] == ["two", "one"]
    assert all(event["createdAt"] for event in events)

    # Two tabs, interleaved: an append that read the thread first would drop
    # whichever landed second.
    kb = chat_key(storage, "reader")
    before = storage.get_thread("reader", None, kb)
    storage.append_memory_message("reader", {"role": "user", "content": "first"}, kb)
    storage.append_memory_message("reader", {"role": "user", "content": "second"}, kb)
    assert before["messages"] == []
    assert [item["content"] for item in storage.get_thread("reader", None, kb)["messages"]] == [
        "first",
        "second",
    ]

    storage.delete_conversation("reader", before["conversationId"], 0)
    assert storage.get_thread("reader", None, chat_key(storage, "reader"))["messages"] == []


def test_an_ingest_marker_is_still_found_under_a_pile_of_newer_entries(storage):
    storage.append_memory_event(
        "reader", {"kind": "document", "requestId": "paper:p1"}
    )
    for index in range(150):
        storage.append_memory_event(
            "reader", {"kind": "lint", "requestId": f"lint-{index}"}
        )

    # The marker is long past any page of the log the listing would return, and
    # that is the whole point: a windowed check would report this document as
    # never filed and file it again, a second model call for one reading.
    assert "paper:p1" not in [
        event.get("requestId") for event in storage.list_memory_events("reader")
    ]
    assert storage.has_memory_event("reader", "paper:p1") is True

    assert storage.has_memory_event("reader", "paper:p2") is False
    # Scoped to the account like everything else here, so one reader's ingest
    # can never make another's look already done.
    storage.create_account("stranger", None, "salt", "hash")
    assert storage.has_memory_event("stranger", "paper:p1") is False


def test_a_page_s_events_are_every_one_naming_it_oldest_first_past_any_window(storage):
    def edits(*slugs):
        return [{"slug": slug, "title": slug, "kind": "concept", "action": "revised", "note": None} for slug in slugs]

    storage.append_memory_event("reader", {
        "kind": "document", "marker": "paper:p1", "createdAt": "2026-01-01T00:00:00Z", "edits": edits("softmax"),
    })
    for index in range(60):
        storage.append_memory_event("reader", {
            "kind": "document", "marker": f"paper:x{index}", "createdAt": "2026-01-02T00:00:00Z", "edits": edits("other"),
        })
    storage.append_memory_event("reader", {
        "kind": "session", "marker": "session:paper:p1", "createdAt": "2026-01-03T00:00:00Z",
        "edits": edits("other", "softmax"),
    })
    # A move names its pages and edits none: it wrote nothing of them.
    storage.append_memory_event("reader", {"kind": "refile", "createdAt": "2026-01-04T00:00:00Z", "pages": ["softmax"]})

    # The first author is far past the fifty the Log reads, and is still first.
    assert [event["marker"] for event in storage.page_events("reader", "softmax")] == ["paper:p1", "session:paper:p1"]
    assert storage.page_events("reader", "never-written") == []
    storage.create_account("stranger", None, "salt", "hash")
    assert storage.page_events("stranger", "softmax") == []


def test_a_marker_reports_the_pass_that_filed_it_most_recently(storage):
    """The refile's skip test, and why it reads the *newest* matching event.

    A refile appends beside the old event rather than replacing it — the log is
    append-only for the same reason chat is — so a document filed under v1 and
    then refiled under v2 holds both. Answering with the first would report
    every refiled document as still stale, and a `--force` run would rewrite
    the whole library again on its next pass, forever.
    """
    assert storage.memory_event_version("reader", "paper:p1") is None

    storage.append_memory_event(
        "reader",
        {"kind": "document", "requestId": "paper:p1", "version": "knowledge-v1"},
    )
    assert storage.memory_event_version("reader", "paper:p1") == "knowledge-v1"

    for index in range(150):
        storage.append_memory_event(
            "reader", {"kind": "lint", "requestId": f"noise-{index}"}
        )
    storage.append_memory_event(
        "reader",
        {"kind": "document", "requestId": "paper:p1", "version": "knowledge-v2"},
    )
    # Past any page of the log a listing would return, like the marker above.
    assert storage.memory_event_version("reader", "paper:p1") == "knowledge-v2"

    # An event written before the stamp existed has no version, which is not
    # the same as "filed by the current pass" — it must read as work to do.
    storage.append_memory_event(
        "reader", {"kind": "document", "requestId": "paper:p2"}
    )
    assert storage.memory_event_version("reader", "paper:p2") is None

    storage.create_account("stranger", None, "salt", "hash")
    assert storage.memory_event_version("stranger", "paper:p1") is None


def test_many_markers_are_answered_in_one_read_and_absence_means_unfiled(storage):
    """The batched form, and the distinction the singular one cannot make.

    `memory_event_version` answers `None` both for a marker nothing filed and
    for one filed before the stamp existed, because its only caller treats those
    alike. Every reader-facing surface has to tell them apart: one is "not in
    your wiki", the other is "in your wiki, written by something we have
    replaced", and they get different sentences and different verbs. So the
    key's *presence* carries "filed" and the value carries "by what".
    """
    assert storage.memory_event_versions("reader", []) == {}

    storage.append_memory_event(
        "reader",
        {"kind": "document", "requestId": "paper:a", "version": "knowledge-v1"},
    )
    storage.append_memory_event(
        "reader", {"kind": "document", "requestId": "paper:b"}
    )
    for index in range(150):
        storage.append_memory_event(
            "reader", {"kind": "lint", "requestId": f"batch-noise-{index}"}
        )
    storage.append_memory_event(
        "reader",
        {"kind": "document", "requestId": "paper:a", "version": "knowledge-v2"},
    )

    found = storage.memory_event_versions(
        "reader", ["paper:a", "paper:b", "paper:c"]
    )
    # Newest wins, past any page a listing would return — the same rule and the
    # same tie-break the singular form uses, or a document reports stale on one
    # surface and current on another.
    assert found["paper:a"] == "knowledge-v2"
    # Present, so filed; valueless, so filed by a pass that predates the stamp.
    assert "paper:b" in found and found["paper:b"] is None
    # Absent, so never filed at all.
    assert "paper:c" not in found

    # The two forms must never disagree about the same marker.
    for marker in ("paper:a", "paper:b", "paper:c"):
        assert found.get(marker) == storage.memory_event_version("reader", marker)

    storage.create_account("stranger", None, "salt", "hash")
    assert storage.memory_event_versions("stranger", ["paper:a"]) == {}


def test_cancelling_removes_future_spend_and_leaves_everything_else(storage):
    """The reader calling off work they asked for, and the two rows it spares.

    Update commits an account to an unbounded amount of model spend, so there
    has to be a way back. What "back" means is the whole of this test: remove
    everything that will still cost something, and touch nothing else.

    A row a worker is holding goes too, which is the part that reads wrong
    until the shape of a filing is taken seriously. It is not one model call
    but a plan, a call per page that plan asks for and a verification, so the
    row is mostly *unpaid* work; the drain reads its absence at the next stage
    boundary and stands down. Sparing it — the first version of this rule — is
    why a one-document run had a Stop button that did nothing at all.

    A row that has given up will never spend again, and its error is the only
    account of why, which the reader may still want. And a job the reader never
    pressed a button for is not theirs to cancel by this act.
    """
    project = storage.create_project("reader", "Diffusion")["id"]

    def queue(marker, kind="document"):
        storage.enqueue_memory_job(
            "reader", kind=kind, marker=marker,
            payload={"projectId": project, "paperId": marker.split(":")[1]},
        )

    # Queued oldest-first, because the claim below takes the oldest pending one
    # and the fixture has to be deterministic about which row a worker holds.
    queue("paper:running")
    queue("paper:waiting")
    queue("paper:retrying")
    queue("paper:gaveup")
    storage.enqueue_memory_job(
        "reader", kind="domain", marker="domain:ml", payload={"domain": "ml"},
    )

    # Held by a worker whose model call is already in flight.
    claimed = storage.claim_memory_job(
        "reader", now="2026-01-01T00:00:00+00:00",
        lease_expires_at="2999-01-01T00:00:00+00:00", max_attempts=9,
    )
    assert claimed["marker"] == "paper:running"

    rows = {job["marker"]: job for job in storage.list_memory_jobs("reader")}
    # Waiting to run again after a transient failure: still future spend.
    storage.fail_memory_job(
        "reader", rows["paper:retrying"]["id"],
        error="provider was busy", retry_at="2099-01-01T00:00:00+00:00",
    )
    # Gave up: nothing will run it, and `lastError` is the diagnosis.
    storage.fail_memory_job(
        "reader", rows["paper:gaveup"]["id"], error="refused", retry_at=None,
    )

    cancelled = storage.cancel_memory_jobs(
        "reader", kinds=("document", "document")
    )
    left = {job["marker"]: job for job in storage.list_memory_jobs("reader")}

    assert "paper:waiting" not in left
    assert "paper:retrying" not in left
    # In flight, and mostly unpaid: the drain stands down when it finds the row
    # gone, which is the only way to stop a document already being written.
    assert "paper:running" not in left
    assert cancelled == 3
    # Gave up: kept, with the reason a reader can still read.
    assert left["paper:gaveup"]["lastError"] == "refused"
    # And the absence is legible to the worker holding it, which is what makes
    # the deletion a signal rather than only a tidy-up.
    assert storage.memory_job_exists("reader", claimed["id"]) is False
    assert storage.memory_job_exists(
        "reader", left["paper:gaveup"]["id"]
    ) is True
    # Not the reader's press, and cheap: untouched.
    assert "domain:ml" in left

    # Idempotent, and honest about having done nothing the second time.
    assert storage.cancel_memory_jobs(
        "reader", kinds=("document", "document")
    ) == 0
    # Scoped to this account like everything else here.
    storage.create_account("stranger", None, "salt", "hash")
    assert storage.cancel_memory_jobs(
        "stranger", kinds=("document", "document")
    ) == 0
    assert len(storage.list_memory_jobs("reader")) == len(left)


def test_a_queued_job_learns_the_version_it_is_being_filed_for(storage):
    """Re-enqueueing reconciles one field, and only on a row nobody is running.

    `(username, marker)` is unique, so a second enqueue hands back the row that
    is already there — right for the ordinary catch-up and wrong for an upgrade,
    where a document queued as "never filed" has to learn the version it is now
    being filed *for* or the reader's press does nothing for it.

    What must not happen is the rest of the payload moving: `move_paper`
    rewrites the provenance of queued work, and an enqueue that replaced the
    payload wholesale would send the job back to the project the document has
    just left.
    """
    project = storage.create_project("reader", "Diffusion")["id"]
    storage.enqueue_memory_job(
        "reader",
        kind="document",
        marker="paper:p9",
        payload={"projectId": project, "paperId": "p9"},
    )
    storage.enqueue_memory_job(
        "reader",
        kind="document",
        marker="paper:p9",
        # A caller that has lost track of where the document lives; the row's
        # own provenance is the one that is right.
        payload={"projectId": "somewhere-else", "paperId": "p9"},
        target_version="knowledge-v2",
    )
    rows = [job for job in storage.list_memory_jobs("reader") if job["marker"] == "paper:p9"]
    assert len(rows) == 1
    assert rows[0]["payload"]["targetVersion"] == "knowledge-v2"
    assert rows[0]["payload"]["projectId"] == project
    assert rows[0]["attempts"] == 0

    # A row a worker is actually holding has already read the payload it will
    # run with, so it is left exactly as it is.
    claimed = storage.claim_memory_job(
        "reader",
        now="2026-01-01T00:00:00+00:00",
        lease_expires_at="2999-01-01T00:00:00+00:00",
        max_attempts=3,
    )
    assert claimed["marker"] == "paper:p9"
    storage.enqueue_memory_job(
        "reader",
        kind="document",
        marker="paper:p9",
        payload={"projectId": project, "paperId": "p9"},
        target_version="knowledge-v3",
    )
    held = [job for job in storage.list_memory_jobs("reader") if job["marker"] == "paper:p9"][0]
    assert held["payload"]["targetVersion"] == "knowledge-v2"

    # An *expired* lease is not that row. `claim_memory_job` re-reads the
    # payload on the next claim, so a press must be able to reach it — otherwise
    # a drain the reader navigated away from would put a document out of reach
    # of the button that exists to repair it.
    storage.fail_memory_job("reader", held["id"], error="interrupted", retry_at=None)
    storage.enqueue_memory_job(
        "reader",
        kind="document",
        marker="paper:p9",
        payload={"projectId": project, "paperId": "p9"},
        target_version="knowledge-v3",
    )
    repaired = [job for job in storage.list_memory_jobs("reader") if job["marker"] == "paper:p9"][0]
    assert repaired["payload"]["targetVersion"] == "knowledge-v3"


def test_the_newest_event_of_one_kind_is_found_under_a_pile_of_others(storage):
    # Health's `lastCheck` needs the newest lint, not the newest event. A
    # windowed scan of the mixed list loses it the moment paper-added lines
    # outnumber the listing limit — the same burial
    # `has_memory_event` already guards against for ingest markers.
    storage.append_memory_event(
        "reader",
        {"kind": "lint", "summary": "first check", "requestId": "lint-old"},
    )
    storage.append_memory_event(
        "reader",
        {"kind": "lint", "summary": "second check", "requestId": "lint-new"},
    )
    for index in range(60):
        storage.append_memory_event(
            "reader", {"kind": "document", "summary": f"paper {index}"}
        )

    assert "lint" not in {
        event.get("kind") for event in storage.list_memory_events("reader")
    }
    latest = storage.latest_memory_event("reader", kind="lint")
    assert latest is not None
    assert latest["summary"] == "second check"
    assert storage.latest_memory_event("reader", kind="reorganize") is None
    storage.create_account("stranger", None, "salt", "hash")
    assert storage.latest_memory_event("stranger", kind="lint") is None


def test_memory_jobs_are_account_scoped_deduplicated_and_leased(storage):
    job = storage.enqueue_memory_job(
        "reader",
        kind="domain",
        marker="request-12345678",
        payload={"projectId": "p", "threadKey": "paper-p"},
    )
    duplicate = storage.enqueue_memory_job(
        "reader",
        kind="domain",
        marker="request-12345678",
        payload={"projectId": "different"},
    )
    assert duplicate["id"] == job["id"]
    assert duplicate["payload"]["projectId"] == "p"

    storage.create_account("stranger", None, "salt", "hash")
    assert storage.list_memory_jobs("stranger") == []

    claimed = storage.claim_memory_job(
        "reader", now="2026-08-08T00:00:00+00:00",
        lease_expires_at="2026-08-08T00:02:00+00:00",
        max_attempts=6,
    )
    assert claimed["id"] == job["id"]
    assert claimed["status"] == "leased"
    assert claimed["attempts"] == 1
    assert storage.claim_memory_job(
        "reader", now="2026-08-08T00:01:00+00:00",
        lease_expires_at="2026-08-08T00:03:00+00:00",
        max_attempts=6,
    ) is None

    reclaimed = storage.claim_memory_job(
        "reader", now="2026-08-08T00:02:01+00:00",
        lease_expires_at="2026-08-08T00:04:00+00:00",
        max_attempts=6,
    )
    assert reclaimed["id"] == job["id"]
    assert reclaimed["attempts"] == 2
    failed = storage.fail_memory_job(
        "reader",
        job["id"],
        error="temporary",
        retry_at="2026-08-08T00:05:00+00:00",
        diagnostics={"verifierResult": "rejected", "callCount": 2},
    )
    assert failed["status"] == "failed"
    assert failed["lastError"] == "temporary"
    # Every failure is its own entry, dated as the row was, so the last entry
    # is always the failure the row is in.
    assert failed["payload"]["attemptTelemetry"] == [
        {"rejection": "temporary", "verifierResult": "rejected", "callCount": 2, "failedAt": failed["updatedAt"]}
    ]
    assert storage.claim_memory_job(
        "reader", now="2026-08-08T00:04:59+00:00",
        lease_expires_at="2026-08-08T00:06:00+00:00",
        max_attempts=6,
    ) is None
    assert storage.claim_memory_job(
        "reader", now="2026-08-08T00:05:00+00:00",
        lease_expires_at="2026-08-08T00:06:00+00:00",
        max_attempts=6,
    )["attempts"] == 3

    terminal = storage.fail_memory_job("reader", job["id"], error="terminal", retry_at=None)
    assert terminal["payload"]["attemptTelemetry"][-1] == {"rejection": "terminal", "failedAt": terminal["updatedAt"]}
    reset = storage.retry_memory_job("reader", job["id"])
    assert reset["status"] == "pending"
    assert reset["attempts"] == 0
    storage.complete_memory_job("reader", job["id"])
    assert storage.list_memory_jobs("reader") == []


def test_a_job_nobody_stayed_for_falls_behind_the_work_that_has_had_no_turn(storage):
    """
    The queue runs in rounds, not first-come-first-served forever.

    `attempts` counts *claims*, so a drain the reader navigated away from looks
    identical to a failure that never reported itself: leased, then nothing,
    then due again the moment the lease expires. Under a strict `createdAt`
    order that job is claimed first every time and everything behind it waits
    forever — which is exactly how a library ended up with thirty-nine papers
    queued at zero attempts behind ones that had been claimed a dozen times.
    """
    stale = storage.enqueue_memory_job(
        "reader", kind="document", marker="paper:old",
        payload={"projectId": "p", "paperId": "old"},
    )
    # Claimed and abandoned twice: the lease expires, nothing is reported.
    for minute in (0, 3):
        claimed = storage.claim_memory_job(
            "reader",
            now=f"2026-08-08T00:{minute:02d}:00+00:00",
            lease_expires_at=f"2026-08-08T00:{minute + 1:02d}:00+00:00",
            max_attempts=6,
        )
        assert claimed["id"] == stale["id"]

    fresh = storage.enqueue_memory_job(
        "reader", kind="document", marker="paper:new",
        payload={"projectId": "p", "paperId": "new"},
    )
    # Both are due; the one that has never had a turn takes this one.
    assert storage.claim_memory_job(
        "reader", now="2026-08-08T00:10:00+00:00",
        lease_expires_at="2026-08-08T00:11:00+00:00",
        max_attempts=6,
    )["id"] == fresh["id"]


def test_document_jobs_run_before_any_other_kind(storage):
    answer = storage.enqueue_memory_job(
        "reader",
        kind="domain",
        marker="domain:first",
        payload={"domain": "first"},
    )
    document = storage.enqueue_memory_job(
        "reader",
        kind="document",
        marker="paper:priority",
        payload={"projectId": "p", "paperId": "priority"},
    )
    claimed = [
        storage.claim_memory_job(
            "reader",
            now=f"2026-08-08T00:00:0{second}+00:00",
            lease_expires_at="2026-08-08T00:05:00+00:00",
            max_attempts=6,
        )["id"]
        for second in (0, 1)
    ]
    assert claimed == [document["id"], answer["id"]]


def test_a_job_at_its_attempt_ceiling_leaves_the_queue_rather_than_blocking_it(storage):
    """
    A ceiling is what makes an abandoned job stop being work.

    It is failed on the way past — not skipped — so it stays visible in the
    maintenance snapshot, carries the reason, and can be retried by hand.
    """
    job = storage.enqueue_memory_job(
        "reader", kind="document", marker="paper:doomed",
        payload={"projectId": "p", "paperId": "doomed"},
    )
    for minute in (0, 5, 10):
        assert storage.claim_memory_job(
            "reader",
            now=f"2026-08-08T00:{minute:02d}:00+00:00",
            lease_expires_at=f"2026-08-08T00:{minute + 1:02d}:00+00:00",
            max_attempts=3,
        )["id"] == job["id"]

    assert storage.claim_memory_job(
        "reader", now="2026-08-08T00:20:00+00:00",
        lease_expires_at="2026-08-08T00:21:00+00:00",
        max_attempts=3,
    ) is None
    record = storage.list_memory_jobs("reader")[0]
    assert record["status"] == "failed"
    assert record["retryAt"] is None
    assert "never finished" in record["lastError"]
    # No worker reported the attempt, and the row says so: that is how the
    # reader is told it was interrupted rather than why an earlier one failed.
    assert record["payload"]["attemptTelemetry"][-1] == {
        "rejection": record["lastError"], "abandoned": True, "failedAt": record["updatedAt"],
    }
    assert storage.retry_memory_job("reader", job["id"])["attempts"] == 0


def test_every_domain_change_queues_the_domain_rewrite_it_makes_necessary(storage):
    """A domain page describes a membership, so a membership change is durable work.

    This used to be a `POST` route, fired by the browser from inside the
    Update flow — so a domain whose pages had moved kept a domain page describing where
    they used to be until somebody pressed a button, and a tab closed mid-pass
    lost the rewrite entirely.
    """
    from delphi_core.storage.base import domain_job_marker

    def domain_jobs():
        return [
            job["payload"]["domain"]
            for job in storage.list_memory_jobs("reader")
            if job["kind"] == "domain"
        ]

    # A domain named by an ingest is a new domain, whichever route named it.
    storage.upsert_memory_page("reader", concept(), max_pages=50)
    assert domain_jobs() == ["ml"]

    # Collapsed on a stable marker: ten changes to one domain are one rewrite.
    storage.upsert_memory_page("reader", concept(slug="elbo"), max_pages=50)
    assert domain_jobs() == ["ml"]

    # A rename leaves a domain page framed under the name the domain used to have.
    storage.complete_memory_job(
        "reader",
        next(
            job["id"]
            for job in storage.list_memory_jobs("reader")
            if job["marker"] == domain_job_marker("ml")
        ),
    )
    assert domain_jobs() == []
    storage.upsert_memory_domain("reader", {"slug": "ml", "title": "Machine learning"})
    assert domain_jobs() == ["ml"]
    # Writing the same title again changes nothing, so it queues nothing new.
    before = storage.list_memory_jobs("reader")
    storage.upsert_memory_domain("reader", {"slug": "ml", "title": "Machine learning"})
    assert storage.list_memory_jobs("reader") == before

    # Both ends of a move: the domain gaining a page and the one losing it.
    storage.move_memory_pages("reader", ["elbo"], "statistics")
    assert sorted(domain_jobs()) == ["ml", "statistics"]

    # And a domain that stops existing takes its queued rewrite with it.
    storage.move_memory_pages("reader", ["elbo"], "ml")
    storage.delete_memory_domain("reader", "statistics")
    assert "statistics" not in domain_jobs()


def _settle_domains(storage, *slugs):
    """Complete the queued domain jobs, so the next change is seen to queue one or not."""
    for job in storage.list_memory_jobs("reader"):
        if job["kind"] == "domain" and (not slugs or job["payload"]["domain"] in slugs):
            storage.complete_memory_job("reader", job["id"])


def _domains_owed(storage):
    return sorted(job["payload"]["domain"] for job in storage.list_memory_jobs("reader") if job["kind"] == "domain")


def _publish(storage, *pages, kind="document"):
    return storage.commit_memory_update(
        "reader", pages=list(pages), figures=[], max_pages=50, max_figures_per_page=4,
        event={"kind": kind, "requestId": f"{kind}:{len(pages)}", "summary": "x", "pages": [page["slug"] for page in pages]},
    )


def test_a_domain_is_owed_its_page_for_membership_a_summary_or_its_name_and_for_nothing_else(storage):
    """§6 of the plan: not on every commit. Both write paths, the upsert and the commit, hold the same rule."""
    _publish(storage, concept())
    assert _domains_owed(storage) == ["ml"]
    _settle_domains(storage)

    # An unrelated commit: the body moved, the summary and the domain did not.
    for write in (lambda page: _publish(storage, page), lambda page: storage.upsert_memory_page("reader", page, max_pages=50)):
        current = storage.get_memory_page("reader", "kl-divergence")
        write(concept(body=current["body"] + " More.", expectedRevision=current["revision"]))
        assert _domains_owed(storage) == []

    # A member's summary changed, through either path.
    _publish(storage, concept(summary="what it measures"))
    assert _domains_owed(storage) == ["ml"]
    _settle_domains(storage)
    storage.upsert_memory_page("reader", concept(summary="what it measures, and in which direction"), max_pages=50)
    assert _domains_owed(storage) == ["ml"]
    _settle_domains(storage)

    # A page that joins, and one written into another domain: both ends.
    _publish(storage, concept(slug="elbo", title="ELBO"))
    assert _domains_owed(storage) == ["ml"]
    _settle_domains(storage)
    _publish(storage, concept(slug="elbo", title="ELBO", domain="statistics"))
    assert _domains_owed(storage) == ["ml", "statistics"]
    _settle_domains(storage)

    # The domain's own page is the composer's write and owes the domain nothing.
    _publish(storage, {"slug": "ml", "kind": "domain", "domain": "ml", "title": "Ml", "summary": "s", "body": "How [[kl-divergence]] fits."}, kind="domain")
    _publish(storage, {"slug": "ml", "kind": "domain", "domain": "ml", "title": "Ml", "summary": "another", "body": "How [[kl-divergence]] fits."}, kind="domain")
    assert _domains_owed(storage) == []
    # Deleting it owes nothing either; deleting a member does.
    storage.delete_memory_page("reader", "ml")
    assert _domains_owed(storage) == []
    storage.delete_memory_page("reader", "kl-divergence")
    assert _domains_owed(storage) == ["ml"]

    # The reader renames the domain.
    _settle_domains(storage)
    storage.upsert_memory_domain("reader", {"slug": "ml", "title": "Machine learning"})
    assert _domains_owed(storage) == ["ml"]


def test_a_domains_job_waits_for_the_domain_to_settle_and_a_release_claims_it_at_once(storage):
    from datetime import UTC, datetime, timedelta

    from delphi_core.storage.domains import DOMAIN_SETTLE_SECONDS

    def claim():
        now = datetime.now(UTC)
        return storage.claim_memory_job(
            "reader", now=now.isoformat(), lease_expires_at=(now + timedelta(minutes=5)).isoformat(), max_attempts=3)

    assert storage.domain_settle_seconds == DOMAIN_SETTLE_SECONDS == 600
    storage.upsert_memory_page("reader", concept(), max_pages=50)
    (job,) = storage.list_memory_jobs("reader")
    first_wait, first_change = job["retryAt"], job["payload"]["fingerprint"]
    assert job["status"] == "pending" and first_wait > (datetime.now(UTC) + timedelta(seconds=500)).isoformat()
    assert claim() is None

    # A burst is one job: each change names itself on the row and pushes the wait forward.
    storage.upsert_memory_page("reader", concept(slug="elbo", title="ELBO"), max_pages=50)
    (job,) = storage.list_memory_jobs("reader")
    assert job["retryAt"] > first_wait and job["payload"]["fingerprint"] != first_change
    assert job["payload"]["domain"] == "ml" and claim() is None

    # An explicit request does not wait.
    assert storage.release_memory_jobs("reader", kind="domain") == 1
    claimed = claim()
    assert claimed["marker"] == "domain:ml"
    # A change that arrives while the page is composed keeps the row, waiting again.
    storage.upsert_memory_page("reader", concept(slug="vi", title="VI"), max_pages=50)
    assert storage.complete_memory_job("reader", claimed["id"], fingerprint=claimed["payload"]["fingerprint"]) is False
    (job,) = storage.list_memory_jobs("reader")
    assert job["status"] == "pending" and job["retryAt"] is not None and claim() is None

    # A store told to wait no time (the journey rig) has the job due as it is queued.
    storage.domain_settle_seconds = 0
    storage.upsert_memory_page("reader", concept(slug="kl", title="KL", domain="statistics"), max_pages=50)
    assert claim()["marker"] == "domain:statistics"


def test_a_refused_domain_delete_keeps_the_work_queued_against_it(storage):
    """The clear belongs after the refusal, not before it."""
    storage.upsert_memory_page("reader", concept(), max_pages=50)
    with pytest.raises(HTTPException) as refused:
        storage.delete_memory_domain("reader", "ml")
    assert refused.value.status_code == 409
    assert [job["payload"]["domain"] for job in storage.list_memory_jobs("reader")] == [
        "ml"
    ]


def test_a_move_that_names_a_missing_page_moves_nothing(storage):
    """One decision over many pages, so a bad slug is not a half-applied refile."""
    storage.upsert_memory_page("reader", concept(), max_pages=50)
    with pytest.raises(HTTPException):
        storage.move_memory_pages("reader", ["kl-divergence", "not-a-page"], "stats")
    assert storage.get_memory_page("reader", "kl-divergence")["domain"] == "ml"


def test_import_queues_one_document_job_done_queues_nothing_and_an_answer_holds_its_session(storage):
    source = storage.create_project("reader", "Source")
    destination = storage.create_project("reader", "Destination")
    storage.add_paper(
        "reader", source["id"], {"id": "queued", "title": "Queued", "filename": "q.pdf"}
    )
    from delphi_core.storage.base import MEMORY_VERSION

    queued = storage.list_memory_jobs("reader")
    assert [(job["kind"], job["marker"], job["status"]) for job in queued] == [
        ("document", "paper:queued", "pending")
    ]
    assert queued[0]["payload"] == {
        "projectId": source["id"], "paperId": "queued", "targetVersion": MEMORY_VERSION,
    }

    # Marking a document done is library state: `doneAt` is written and nothing is queued.
    assert storage.set_paper_done("reader", source["id"], "queued", True)["doneAt"]
    storage.set_paper_done("reader", source["id"], "queued", True)
    assert storage.get_paper("reader", source["id"], "queued")["doneAt"]
    assert not storage.set_paper_done("reader", source["id"], "queued", False).get("doneAt")
    assert storage.list_memory_jobs("reader") == queued
    key = chat_key(storage, "reader", source["id"], "paper-queued")
    storage.append_message(
        "reader", source["id"], key,
        {"role": "user", "content": "question", "requestId": "answer-12345678"},
    )
    storage.append_message(
        "reader",
        source["id"],
        key,
        {"role": "assistant", "content": "answer", "requestId": "answer-12345678"},
    )
    # A whole answer holds a session job: the document's beside a document,
    # the conversation's own in a Memory chat.
    memory_chat = chat_key(storage, "reader")
    for role, content in (("user", "What do I know?"), ("assistant", "A Memory answer")):
        storage.append_memory_message(
            "reader", {"role": role, "content": content, "requestId": "memory-12345678"}, memory_chat
        )
    conversation = storage.get_thread("reader", None, memory_chat)["conversationId"]
    sessions = {job["marker"]: job for job in storage.list_memory_jobs("reader") if job["kind"] == "session"}
    assert set(sessions) == {"session:paper:queued", f"session:conversation:{conversation}"}
    assert sessions["session:paper:queued"]["payload"] | {"fingerprint": ""} == {
        "projectId": source["id"], "paperId": "queued", "targetVersion": MEMORY_VERSION, "fingerprint": "",
    }
    assert sessions[f"session:conversation:{conversation}"]["payload"]["conversationId"] == conversation
    assert all(job["retryAt"] for job in sessions.values())

    storage.move_paper("reader", source["id"], "queued", destination["id"])
    assert {
        job["payload"]["projectId"] for job in storage.list_memory_jobs("reader") if "paperId" in job["payload"]
    } == {destination["id"]}

    # Deleting the document removes its session job with its own.
    storage.delete_paper("reader", destination["id"], "queued")
    assert [job["marker"] for job in storage.list_memory_jobs("reader")] == [f"session:conversation:{conversation}"]


def test_thread_and_project_deletion_remove_only_the_work_they_destroy(storage):
    project = storage.create_project("reader", "Disposable")
    storage.add_paper(
        "reader", project["id"], {"id": "kept", "title": "Kept", "filename": "k.pdf"}
    )
    key = chat_key(storage, "reader", project["id"], "paper-kept")
    storage.append_message(
        "reader", project["id"], key,
        {"role": "user", "content": "question", "requestId": "answer-87654321"},
    )
    storage.append_message(
        "reader",
        project["id"],
        key,
        {"role": "assistant", "content": "answer", "requestId": "answer-87654321"},
    )
    conversation = storage.get_thread("reader", project["id"], key)["conversationId"]
    storage.delete_conversation("reader", conversation, 0)
    # The session's job is the document's, not the conversation's: it stays,
    # and finds nothing of the deleted chat when it runs.
    assert [job["kind"] for job in storage.list_memory_jobs("reader")] == [
        "document", "session"
    ]
    key = chat_key(storage, "reader", project["id"], "paper-kept")
    storage.append_message(
        "reader", project["id"], key,
        {"role": "user", "content": "question", "requestId": "failed-12345678"},
    )
    storage.append_message(
        "reader",
        project["id"],
        key,
        {
            "role": "assistant",
            "content": "Request failed",
            "requestId": "failed-12345678",
            "error": True,
        },
    )
    storage.append_memory_message(
        "reader", {"role": "assistant", "content": "KB Ask answer"}, chat_key(storage, "reader")
    )
    # A failed answer holds nothing, and neither does a message with no request.
    assert [job["kind"] for job in storage.list_memory_jobs("reader")] == [
        "document", "session"
    ]

    storage.delete_project("reader", project["id"])
    assert storage.list_memory_jobs("reader") == []

def test_a_cut_off_answer_is_stored_and_never_queued_for_filing(storage):
    """
    A response the provider cut off is shown with what was written and marked
    as cut off, and it holds no job. The whole answer that replaces it on a
    retry does.
    """
    project = storage.create_project("reader", "Reading")
    storage.add_paper("reader", project["id"], {"id": "cut", "title": "Cut", "filename": "c.pdf"})
    storage.clear_memory_job("reader", "paper:cut")
    key = chat_key(storage, "reader", project["id"], "paper-cut")
    storage.append_message(
        "reader", project["id"], key,
        {"role": "user", "content": "question", "requestId": "cutoff-12345678"},
    )
    storage.append_message(
        "reader", project["id"], key,
        {"role": "assistant", "content": "Half an ans", "requestId": "cutoff-12345678",
         "incomplete": {"reason": "max_output_tokens"}},
    )
    assert storage.list_memory_jobs("reader") == []
    stored = storage.get_thread("reader", project["id"], key)["messages"][-1]
    assert stored["incomplete"] == {"reason": "max_output_tokens"} and stored["content"] == "Half an ans"

    storage.drop_from_last_user_turn("reader", project["id"], key, "cutoff-12345678")
    storage.append_message(
        "reader", project["id"], key,
        {"role": "user", "content": "question", "requestId": "retry-123456789"},
    )
    storage.append_message(
        "reader", project["id"], key,
        {"role": "assistant", "content": "The whole answer.", "requestId": "retry-123456789"},
    )
    assert [job["marker"] for job in storage.list_memory_jobs("reader")] == ["session:paper:cut"]
    # The cut-off exchange is behind the conversation's watermark: only the retry is owed.
    conversation = storage.get_conversation("reader", storage.get_thread("reader", project["id"], key)["conversationId"])
    assert conversation["memoryFiledThrough"] == ""


def test_memory_update_publication_rolls_back_all_records_together(storage):
    page = {
        "slug": "attention",
        "kind": "concept",
        "domain": "ml",
        "title": "Attention",
        "summary": "A mechanism.",
        "body": "First body.",
    }
    first = storage.commit_memory_update(
        "reader",
        pages=[page],
        figures=[
            {
                "id": "figure-one",
                "pageSlug": "attention",
                "caption": "A grounded figure",
                "objectKey": "knowledge/u/reader/figures/figure-one.webp",
            }
        ],
        event={"kind": "ingest", "requestId": "request-one"},
        max_pages=50,
        max_figures_per_page=1,
    )
    assert first["pages"][0]["revision"] == 1
    assert first["event"]["edits"][0]["action"] == "created"
    assert any(
        job["kind"] == "domain" and job["payload"]["domain"] == "ml"
        for job in storage.list_memory_jobs("reader")
    )

    # Two figures against a ceiling of one, in a single commit -- the ceiling
    # has to be reached *within* one filing now, because a filing supersedes
    # the rows of the pages it rewrites and so can never be refused for what
    # the pass before it left behind.
    with pytest.raises(HTTPException) as refused:
        storage.commit_memory_update(
            "reader",
            pages=[{**page, "body": "A partial revision must not survive."}],
            figures=[
                {
                    "id": "figure-two",
                    "pageSlug": "attention",
                    "caption": "The one it may hold",
                    "objectKey": "knowledge/u/reader/figures/figure-two.webp",
                },
                {
                    "id": "figure-three",
                    "pageSlug": "attention",
                    "caption": "Too many",
                    "objectKey": "knowledge/u/reader/figures/figure-three.webp",
                },
            ],
            event={"kind": "ingest", "requestId": "request-two"},
            max_pages=50,
            max_figures_per_page=1,
        )
    assert refused.value.status_code == 409
    held = storage.get_memory_page("reader", "attention")
    assert held["body"] == "First body."
    assert held["revision"] == 1
    assert [event["requestId"] for event in storage.list_memory_events("reader")] == [
        "request-one"
    ]
    # And the figure the refused filing would have replaced is still there.
    assert [figure["id"] for figure in storage.list_memory_figures("reader")] == [
        "figure-one"
    ]


def test_a_lapsed_worker_cannot_touch_its_successors_claim(storage):
    """A lease is a fence, and identifying a claim by job id is not one.

    Renewal has always compared the expiry it last wrote. Completion, failure
    and release did not -- so a worker whose lease had lapsed could finish,
    fail, or hand back the claim its *successor* was holding. The release case
    is the sharpest: it dropped the successor's attempt and turned a live lease
    back into a pending row, which a third worker could then take and run
    alongside the second.
    """
    storage.enqueue_memory_job(
        "reader", kind="document", marker="paper:p1", payload={}
    )
    first = storage.claim_memory_job(
        "reader", now="2026-01-01T00:00:00+00:00",
        lease_expires_at="2026-01-01T00:04:00+00:00", max_attempts=3,
    )
    # Its lease lapses and the next drain takes the job over.
    second = storage.claim_memory_job(
        "reader", now="2026-01-01T00:05:00+00:00",
        lease_expires_at="2026-01-01T00:09:00+00:00", max_attempts=3,
    )
    assert second is not None and second["attempts"] == 2

    # None of the three mutations may reach the successor's claim.
    storage.release_memory_job(
        "reader", first["id"],
        expected_lease_expires_at=first["leaseExpiresAt"],
    )
    storage.fail_memory_job(
        "reader", first["id"], error="stale worker", retry_at=None,
        expected_lease_expires_at=first["leaseExpiresAt"],
    )
    storage.complete_memory_job(
        "reader", first["id"],
        expected_lease_expires_at=first["leaseExpiresAt"],
    )

    held = storage.list_memory_jobs("reader")
    assert len(held) == 1
    assert held[0]["status"] == "leased"
    assert held[0]["attempts"] == 2
    assert held[0]["leaseExpiresAt"] == "2026-01-01T00:09:00+00:00"
    assert held[0]["lastError"] in (None, "")

    # The worker that does hold it still may.
    storage.complete_memory_job(
        "reader", second["id"],
        expected_lease_expires_at=second["leaseExpiresAt"],
    )
    assert storage.list_memory_jobs("reader") == []


def test_a_cancelled_claim_is_handed_back_unspent(storage):
    """A reader who navigates away has not used up their document's chances.

    `attempts` counts claims because an abandoned drain used to be
    indistinguishable from a crash. A cancellation is distinguishable now --
    the drain route catches `asyncio.CancelledError` by name -- and counting it
    cost a real document all three of its attempts without a single filing ever
    being tried, which is also why it never reached the last-attempt rule that
    files a page over the verifier's objection. Worse, the row stayed `leased`
    with no error until the lease ran out, holding its place at the head of the
    queue with nothing running behind it.
    """
    storage.enqueue_memory_job(
        "reader", kind="document", marker="paper:p1", payload={}
    )
    claimed = storage.claim_memory_job(
        "reader",
        now="2026-01-01T00:00:00+00:00",
        lease_expires_at="2026-01-01T00:04:00+00:00",
        max_attempts=3,
    )
    assert claimed["attempts"] == 1

    storage.release_memory_job("reader", claimed["id"])

    held = storage.list_memory_jobs("reader")[0]
    assert held["status"] == "pending"
    assert held["attempts"] == 0
    assert held["leaseExpiresAt"] is None
    # …so the very next drain may take it, rather than waiting out a lease that
    # nothing is behind.
    again = storage.claim_memory_job(
        "reader",
        now="2026-01-01T00:00:05+00:00",
        lease_expires_at="2026-01-01T00:04:05+00:00",
        max_attempts=3,
    )
    assert again is not None and again["attempts"] == 1

    # A job nobody holds is not released out from under the queue.
    storage.release_memory_job("reader", again["id"])
    storage.release_memory_job("reader", again["id"])
    assert storage.list_memory_jobs("reader")[0]["attempts"] == 0
    storage.release_memory_job("reader", "no-such-job")


def test_a_filing_supersedes_the_figures_of_the_page_it_rewrites(storage):
    """A rewritten body cannot keep the rows the body before it named.

    Rows used to be appended, and a refile regenerates the same pictures under
    fresh ids -- so a page filed twice held both sets, the older pointing at
    prose that no longer embeds it. Worse than the duplication: the per-page
    ceiling counts rows, so a page already holding most of its allowance could
    never be filed again. It hit 409 partway through appending, and every
    retry reproduced it exactly until the job gave up.
    """
    page = {
        "slug": "attention",
        "kind": "concept",
        "domain": "ml",
        "title": "Attention",
        "summary": "A mechanism.",
        "body": "First body, showing two pictures.",
    }
    storage.commit_memory_update(
        "reader",
        pages=[page],
        figures=[
            {
                "id": f"figure-{name}",
                "pageSlug": "attention",
                "caption": name,
                "objectKey": f"knowledge/u/reader/figures/figure-{name}.webp",
            }
            for name in ("one", "two")
        ],
        event={"kind": "document", "requestId": "paper:attention"},
        max_pages=50,
        max_figures_per_page=2,
    )

    # The refile: same document, same two pictures, fresh ids. Under the old
    # append this raised 409 on the very first row.
    committed = storage.commit_memory_update(
        "reader",
        pages=[{**page, "body": "Second body, showing the same two pictures."}],
        figures=[
            {
                "id": f"figure-{name}",
                "pageSlug": "attention",
                "caption": name,
                "objectKey": f"knowledge/u/reader/figures/figure-{name}.webp",
            }
            for name in ("three", "four")
        ],
        event={"kind": "document", "requestId": "paper:attention"},
        max_pages=50,
        max_figures_per_page=2,
    )

    assert [figure["id"] for figure in storage.list_memory_figures("reader")] == [
        "figure-three",
        "figure-four",
    ]
    # The bytes the rows no longer name are handed back to be reaped, rather
    # than deleted here: a row pointing at bytes that are gone is a broken
    # page, so publication comes first (invariant 7).
    assert sorted(committed["supersededObjectKeys"]) == [
        "knowledge/u/reader/figures/figure-one.webp",
        "knowledge/u/reader/figures/figure-two.webp",
    ]

def test_one_update_run_per_account_is_recorded_read_back_and_dismissed(storage):
    """
    The Update pass runs in one tab, so the record is how every other surface
    learns about it — and clearing it is the reader dismissing a result, which
    is a different thing from a run with zero counts.
    """
    assert storage.get_memory_update("reader") is None

    running = {
        "status": "running",
        "total": 21,
        "processed": 3,
        "filed": 3,
        "skipped": 0,
        "failures": 0,
        "detail": "",
        "startedAt": "2026-08-27T10:00:00+00:00",
        "heartbeatAt": "2026-08-27T10:02:00+00:00",
        "finishedAt": None,
    }
    assert storage.set_memory_update("reader", running) == running
    assert storage.get_memory_update("reader") == running

    finished = {**running, "status": "done", "processed": 21, "filed": 21}
    storage.set_memory_update("reader", finished)
    assert storage.get_memory_update("reader")["status"] == "done"

    assert storage.set_memory_update("reader", None) is None
    assert storage.get_memory_update("reader") is None

    with pytest.raises(HTTPException) as missing:
        storage.get_memory_update("nobody")
    assert missing.value.status_code == 404


def test_a_live_claim_can_push_its_fence_forward_and_a_stale_one_cannot(storage):
    """
    The lease is a fence, not a budget for the work.

    It used to be the budget, sized to outlast a whole filing, and the cost was
    what a dead worker left behind: a document held for the full lease with
    nothing running and no way to release it, because `retry_memory_job`
    refuses anything that is not already failed. So the lease is short and a
    live worker renews it; a worker that dies stops renewing and the row frees
    within one lease.

    The compare is what makes that safe. If a claim lapsed and somebody else
    took it, the original worker's renewal must not steal it back.
    """
    job = storage.enqueue_memory_job(
        "reader",
        kind="document",
        marker="paper:fenced",
        payload={"projectId": "p", "paperId": "fenced"},
    )
    claimed = storage.claim_memory_job(
        "reader",
        now="2026-08-08T00:00:00+00:00",
        lease_expires_at="2026-08-08T00:02:00+00:00",
        max_attempts=6,
    )
    assert claimed["id"] == job["id"]

    assert storage.renew_memory_job_lease(
        "reader",
        job["id"],
        expected_lease_expires_at="2026-08-08T00:02:00+00:00",
        lease_expires_at="2026-08-08T00:04:00+00:00",
    )
    # The old fence is no longer ours, so renewing against it is refused --
    # which is exactly what a worker resuming after its claim lapsed would do.
    assert not storage.renew_memory_job_lease(
        "reader",
        job["id"],
        expected_lease_expires_at="2026-08-08T00:02:00+00:00",
        lease_expires_at="2026-08-08T00:06:00+00:00",
    )

    # And once the fence really lapses, the next worker takes it and the
    # original cannot renew over the top.
    reclaimed = storage.claim_memory_job(
        "reader",
        now="2026-08-08T00:05:00+00:00",
        lease_expires_at="2026-08-08T00:07:00+00:00",
        max_attempts=6,
    )
    assert reclaimed["id"] == job["id"]
    assert not storage.renew_memory_job_lease(
        "reader",
        job["id"],
        expected_lease_expires_at="2026-08-08T00:04:00+00:00",
        lease_expires_at="2026-08-08T00:09:00+00:00",
    )


def test_a_pass_with_no_provenance_to_offer_does_not_erase_the_page_s(storage):
    """A domain page or lint rewrite must not cost a page its document.

    `upsert_memory_page` assigned `sourcePaperId` unconditionally, and the
    lint and domain page callers pass none because they have none — so recomposing an
    domain quietly unlinked every source page in it. The Reader rail finds a
    document's page by that field and the refile reuses its slug by it, so both
    would have silently started failing on a page that still looks fine.

    A caller with nothing to say about provenance is not saying "no".
    """
    storage.create_account("ada", None, "salt", "hash")
    storage.upsert_memory_page(
        "ada",
        {
            "slug": "mdlm",
            "kind": "source",
            "domain": "ml",
            "title": "MDLM",
            "body": "Filed from the document's digest.",
            "sourcePaperId": "doc1",
            "sourceProjectId": "project-one",
        },
        max_pages=100,
    )

    # A domain-page-style rewrite: same slug, new prose, no provenance in hand.
    storage.upsert_memory_page(
        "ada",
        {
            "slug": "mdlm",
            "kind": "source",
            "domain": "ml",
            "title": "MDLM",
            "body": "Rewritten by a pass that never saw the paper.",
        },
        max_pages=100,
    )

    held = storage.get_memory_page("ada", "mdlm")
    assert held["sourcePaperId"] == "doc1"
    # The project is never kept: a page names its document by id alone.
    assert "sourceProjectId" not in held
    assert held["body"] == "Rewritten by a pass that never saw the paper."


def test_replaying_a_library_queues_work_that_one_clear_takes_back(storage):
    """
    What cloning an account leans on, in both backends.

    Cloning an account writes through the shipped methods: `add_paper` queues
    a `document` job and a replayed answer holds a `session` job. Left in place the pump would drain every one of
    them the moment the new account opened a tab. The clone clears the queue
    afterwards, because the queue is derived work. Both halves are asserted:
    that the writer really does queue, and that one clear over every kind
    leaves nothing behind.
    """
    project = storage.create_project("reader", "Cloned")
    for paper_id in ("first", "second"):
        storage.add_paper(
            "reader",
            project["id"],
            {"id": paper_id, "title": paper_id, "filename": f"{paper_id}.pdf"},
        )
    key = chat_key(storage, "reader", project["id"], "paper-first")
    storage.append_message(
        "reader", project["id"], key,
        {"role": "user", "content": "Why?", "requestId": "q1"},
    )
    storage.append_message(
        "reader", project["id"], key,
        {"role": "assistant", "content": "Because.", "requestId": "q1"},
    )

    queued = sorted(job["kind"] for job in storage.list_memory_jobs("reader"))
    assert queued == ["document", "document", "session"]

    cleared = storage.cancel_memory_jobs("reader", kinds=MEMORY_JOB_KINDS)

    assert cleared == 3
    assert storage.list_memory_jobs("reader") == []
    # The records the clone exists to carry are untouched by the clear.
    assert len(storage.get_project("reader", project["id"])["papers"]) == 2
    assert len(storage.list_recent_conversations("reader", limit=10)) == 1


@pytest.mark.parametrize("kind", ["gap", "question", "synthesis", "note"])
def test_a_page_of_a_kind_memory_does_not_hold_is_refused(storage, kind):
    page = {"slug": "kept-explanation", "kind": "concept", "domain": "ml", "title": "Kept",
            "body": "An explanation with [[related]]."}
    storage.upsert_memory_page("reader", page, max_pages=50)
    retired = {**page, "kind": kind, "title": "A hole", "body": "Still to learn."}
    writes = (
        lambda: storage.upsert_memory_page("reader", retired, max_pages=50),
        lambda: storage.upsert_memory_page("reader", {**retired, "slug": "a-hole"}, max_pages=50),
        lambda: storage.commit_memory_update(
            "reader", pages=[{**page, "body": "Rewritten"}, {**retired, "slug": "a-hole"}], figures=[],
            event={"kind": "document", "requestId": "paper:retired"}, max_pages=50, max_figures_per_page=5),
        lambda: storage.replace_memory_snapshot(
            "reader", {"pages": [{**retired, "id": "p1", "slug": "a-hole"}]}, max_pages=50),
    )
    for write in writes:
        with pytest.raises(HTTPException) as error:
            write()
        assert error.value.status_code == 422
    # Nothing a refused write named was stored, and the page it would have
    # replaced is as it was.
    held = storage.get_memory_page("reader", page["slug"])
    assert (held["kind"], held["title"], held["body"], held["revision"]) == ("concept", "Kept", page["body"], 1)
    assert [row["slug"] for row in storage.list_memory_pages("reader", limit=50)] == [page["slug"]]
    assert not storage.has_memory_event("reader", "paper:retired")


@pytest.mark.parametrize("claim", ["reader-inference", "conversation", "digest-inference", None])
def test_a_citation_of_a_claim_type_memory_does_not_hold_is_refused(storage, claim):
    page = {"slug": "cited", "kind": "concept", "domain": "ml", "title": "Cited", "body": "A claim [E1].",
            "citations": [{"id": 1, "claimType": "derived", "paperId": None, "page": None, "section": None}]}
    storage.upsert_memory_page("reader", page, max_pages=50)
    retired = {**page, "body": "Another claim [E1].", "citations": [{**page["citations"][0], "claimType": claim}]}
    writes = (
        lambda: storage.upsert_memory_page("reader", retired, max_pages=50),
        lambda: storage.commit_memory_update(
            "reader", pages=[retired], figures=[],
            event={"kind": "document", "requestId": "paper:retired"}, max_pages=50, max_figures_per_page=5),
        lambda: storage.replace_memory_snapshot("reader", {"pages": [{**retired, "id": "p1"}]}, max_pages=50),
    )
    for write in writes:
        with pytest.raises(HTTPException) as error:
            write()
        assert error.value.status_code == 422
    held = storage.get_memory_page("reader", "cited")
    assert (held["body"], held["revision"]) == (page["body"], 1)
    assert [row["claimType"] for row in held["citations"]] == ["derived"]
    assert not storage.has_memory_event("reader", "paper:retired")
    # Each of the four that exist is stored as written.
    for kept in ("author-claim", "external", "reader-note", "derived"):
        storage.upsert_memory_page(
            "reader", {**page, "citations": [{**page["citations"][0], "claimType": kept}]}, max_pages=50)
        assert storage.get_memory_page("reader", "cited")["citations"][0]["claimType"] == kept


def test_a_write_names_the_revision_it_read_or_is_last_writer_wins(storage):
    page = {"slug": "revised", "kind": "concept", "domain": "ml", "title": "Revised", "body": "First"}
    # A page that does not exist yet is revision 0.
    first = storage.upsert_memory_page("reader", {**page, "expectedRevision": 0}, max_pages=50)
    storage.upsert_memory_page("reader", {**page, "body": "Second", "expectedRevision": first["revision"]}, max_pages=50)
    for stale in (0, first["revision"]):
        with pytest.raises(HTTPException) as error:
            storage.upsert_memory_page("reader", {**page, "body": "Stale", "expectedRevision": stale}, max_pages=50)
        assert error.value.status_code == 409
    assert storage.get_memory_page("reader", "revised")["body"] == "Second"
    # A write that names no revision is not checked.
    assert storage.upsert_memory_page("reader", {**page, "body": "Third"}, max_pages=50)["revision"] == 3


def test_stale_filing_cannot_replace_a_newer_body_or_publish_its_marker(storage):
    page = {"slug": "concurrent-learning", "kind": "concept", "domain": "ml", "title": "Learning", "body": "First"}
    first = storage.upsert_memory_page("reader", page, max_pages=50)
    storage.upsert_memory_page("reader", {**page, "body": "Newer conversation"}, max_pages=50)
    with pytest.raises(HTTPException) as error:
        storage.commit_memory_update("reader", pages=[{**page, "body": "Slow filing", "expectedRevision": first["revision"]}],
            figures=[], event={"kind": "document", "requestId": "paper:p"}, max_pages=50, max_figures_per_page=5)
    assert error.value.status_code == 409
    assert storage.get_memory_page("reader", page["slug"])["body"] == "Newer conversation"
    assert not storage.has_memory_event("reader", "paper:p")


def test_a_target_version_upgrades_a_queued_job_without_replacing_its_provenance(storage):
    job = storage.enqueue_memory_job("reader", kind="document", marker="paper:p",
        payload={"projectId": "moved", "paperId": "p"})
    updated = storage.enqueue_memory_job("reader", kind="document", marker="paper:p",
        payload={"projectId": "old", "paperId": "p"}, target_version="v2")
    assert updated["id"] == job["id"]
    assert updated["payload"] == {"projectId": "moved", "paperId": "p", "targetVersion": "v2"}


def test_page_rewrite_publication_retains_figure_rows_and_queues_no_graph_work(storage):
    page = {"slug": "stable-page", "kind": "concept", "domain": "ml", "title": "Stable",
            "body": "Prior [[related]] ![Evidence](figure:stable-figure)"}
    storage.upsert_memory_page("reader", page, max_pages=50)
    storage.add_memory_figure("reader", {"id": "stable-figure", "pageSlug": page["slug"],
        "caption": "Evidence", "objectKey": "knowledge/stable.webp"}, max_per_page=5)
    before = storage.get_memory_page("reader", page["slug"])
    for pending in storage.list_memory_jobs("reader"):
        storage.complete_memory_job("reader", pending["id"])
    storage.commit_memory_update("reader", pages=[{**page, "body": "Clearer [[related]] ![Evidence](figure:stable-figure)",
        "expectedRevision": before["revision"]}], figures=[],
        event={"kind": "page-rewrite", "requestId": "rewrite-one"}, max_pages=50, max_figures_per_page=5)
    after = storage.get_memory_page("reader", page["slug"])
    assert after["figures"] == before["figures"]
    assert after["links"] == before["links"]
    assert not storage.list_memory_jobs("reader")


def test_operation_completion_is_owner_and_marker_scoped(storage):
    storage.append_memory_event("reader", {"kind": "document", "requestId": "paper:p",
        "operationId": "operation-one", "pages": ["a"]})
    assert storage.has_memory_event("reader", "paper:p", operation_id="operation-one")
    assert not storage.has_memory_event("reader", "paper:p", operation_id="operation-two")
    assert not storage.has_memory_event("reader", "paper:q", operation_id="operation-one")
    storage.create_account("other", None, "salt", "hash")
    assert not storage.has_memory_event("other", "paper:p", operation_id="operation-one")


def test_filing_events_with_equal_timestamps_keep_publication_order(storage):
    event = {"kind": "document", "requestId": "paper:ties", "paperId": "ties",
        "pages": ["a"], "createdAt": "2026-09-06T01:00:00+00:00", "version": "old"}
    storage.append_memory_event("reader", event)
    storage.append_memory_event("reader", {**event, "version": "new"})
    assert storage.memory_event_version("reader", event["requestId"]) == "new"
    assert storage.memory_event_versions("reader", [event["requestId"]]) == {event["requestId"]: "new"}


# --- first-run onboarding -------------------------------------------------

def _file(storage, project_id, paper_id, *, fence_job=None):
    """Publish a document's filing under its job's marker."""
    return storage.commit_memory_update(
        "reader",
        pages=[{"slug": f"page-{paper_id}", "kind": "source", "domain": "ml",
                "title": f"Page {paper_id}", "summary": "s", "body": "b"}],
        figures=[],
        event={"kind": "document", "requestId": f"paper:{paper_id}", "marker": f"paper:{paper_id}",
               "projectId": project_id, "paperId": paper_id},
        max_pages=50,
        max_figures_per_page=4,
        fence_job=fence_job,
    )


def _claim(storage):
    return storage.claim_memory_job(
        "reader", now="2026-09-18T00:00:00+00:00",
        lease_expires_at="2099-01-01T00:00:00+00:00", max_attempts=6,
    )


def test_onboarding_records_its_projects_and_a_fresh_account_starts_it(storage):
    assert storage.settle_onboarding("reader", require_filing=True)["outcome"] == "fresh"
    assert storage.onboarding_status("reader", require_filing=True) == {"status": None}

    ordinary = storage.create_project("reader", "Ordinary")
    assert storage.onboarding_status("reader", require_filing=True) == {"status": None}
    storage.delete_project("reader", ordinary["id"])

    first = storage.create_project("reader", "First", onboarding=True)
    second = storage.create_project("reader", "Second", onboarding=True)
    record = storage.get_account("reader")["onboarding"]
    assert record["status"] == "running"
    assert record["projectIds"] == [first["id"], second["id"]]
    status = storage.onboarding_status("reader", require_filing=True)
    assert status == {"status": "running", "uploaded": 0, "filed": 0, "pending": 0, "completed": 0}


def test_an_interrupted_attempt_with_nothing_filed_is_removed_and_starts_over(storage):
    project = storage.create_project("reader", "Robotics", onboarding=True)
    storage.add_paper("reader", project["id"], {"id": "p1", "title": "A", "filename": "a.pdf"})
    assert [job["marker"] for job in storage.list_memory_jobs("reader")] == ["paper:p1"]

    settled = storage.settle_onboarding("reader", require_filing=True)
    assert settled["outcome"] == "restart"
    assert settled["projectIds"] == [project["id"]]
    assert storage.list_projects("reader") == []
    # Its filing work goes with it, so nothing can publish for it later.
    assert storage.list_memory_jobs("reader") == []
    assert "onboarding" not in storage.get_account("reader")
    assert storage.settle_onboarding("reader", require_filing=True)["outcome"] == "fresh"


def test_an_interrupted_attempt_with_one_document_filed_opens_the_dashboard(storage):
    project = storage.create_project("reader", "Robotics", onboarding=True)
    storage.add_paper("reader", project["id"], {"id": "p1", "title": "A", "filename": "a.pdf"})
    storage.add_paper("reader", project["id"], {"id": "p2", "title": "B", "filename": "b.pdf"})
    _file(storage, project["id"], "p1")
    assert storage.onboarding_status("reader", require_filing=True)["completed"] == 1

    # The reader never reached the last screen; one completed document is enough.
    assert storage.settle_onboarding("reader", require_filing=True)["outcome"] == "complete"
    assert [p["id"] for p in storage.get_project("reader", project["id"])["papers"]] == ["p1", "p2"]
    assert storage.get_account("reader")["onboarding"]["status"] == "complete"
    assert storage.settle_onboarding("reader", require_filing=True)["outcome"] == "complete"


def test_with_filing_off_an_uploaded_document_completes_the_attempt(storage):
    project = storage.create_project("reader", "Robotics", onboarding=True)
    assert storage.settle_onboarding("reader", require_filing=False, finishing=True)["outcome"] == "running"
    storage.add_paper("reader", project["id"], {"id": "p1", "title": "A", "filename": "a.pdf"})
    assert storage.settle_onboarding("reader", require_filing=False)["outcome"] == "complete"


def test_failed_filing_never_completes_onboarding(storage):
    project = storage.create_project("reader", "Robotics", onboarding=True)
    storage.add_paper("reader", project["id"], {"id": "p1", "title": "A", "filename": "a.pdf"})
    assert storage.settle_onboarding("reader", require_filing=True, finishing=True)["outcome"] == "running"
    job = _claim(storage)
    storage.fail_memory_job("reader", job["id"], error="provider down", retry_at=None)
    # The final screen offers restart; failing is never successful filing.
    assert storage.onboarding_status("reader", require_filing=True)["pending"] == 0
    assert storage.settle_onboarding("reader", require_filing=True, finishing=True)["outcome"] == "running"
    assert storage.settle_onboarding("reader", require_filing=True)["outcome"] == "restart"
    assert storage.list_projects("reader") == []


def test_an_account_from_before_onboarding_lands_on_the_dashboard(storage):
    storage.create_project("reader", "Existing library")
    assert storage.settle_onboarding("reader", require_filing=True)["outcome"] == "complete"
    assert storage.get_account("reader")["onboarding"]["status"] == "complete"


def test_a_fenced_commit_publishes_only_while_its_job_is_leased(storage):
    from delphi_core.storage import MemoryJobGone

    project = storage.create_project("reader", "Robotics", onboarding=True)
    storage.add_paper("reader", project["id"], {"id": "p1", "title": "A", "filename": "a.pdf"})
    job = _claim(storage)
    assert job["marker"] == "paper:p1"
    committed = _file(storage, project["id"], "p1", fence_job=(job["id"], job["attempts"]))
    assert committed["event"]["requestId"] == "paper:p1"

    storage.add_paper("reader", project["id"], {"id": "p2", "title": "B", "filename": "b.pdf"})
    second = _claim(storage)
    storage.cancel_memory_jobs("reader", kinds=MEMORY_JOB_KINDS)
    with pytest.raises(MemoryJobGone):
        _file(storage, project["id"], "p2", fence_job=(second["id"], second["attempts"]))
    assert not storage.has_memory_event("reader", "paper:p2")
    with pytest.raises(HTTPException):
        storage.get_memory_page("reader", "page-p2")


def test_cleanup_and_a_running_filing_serialise_on_the_account_lock(storage, store_harness):
    """The race the fence exists for, made deterministic.

    Hold the account lock the commit takes, start a fenced commit (it blocks),
    run the cleanup inside the held lock, then release. The commit must see its
    job row gone and publish nothing — no page and no event appear after the
    cleanup, which is the failure: artifacts published for a deleted attempt.
    """
    from delphi_core.storage import MemoryJobGone

    project = storage.create_project("reader", "Robotics", onboarding=True)
    storage.add_paper("reader", project["id"], {"id": "p1", "title": "A", "filename": "a.pdf"})
    job = _claim(storage)

    outcome: dict = {}
    started = threading.Event()

    def filing():
        started.set()
        try:
            _file(storage, project["id"], "p1", fence_job=(job["id"], job["attempts"]))
            outcome["result"] = "published"
        except MemoryJobGone:
            outcome["result"] = "refused"

    # The harness holds the account lock as its store takes it, and `cleanup`
    # makes under it the write settle_onboarding makes, deleting the attempt's
    # job rows, while the fenced commit waits behind the same lock.
    with store_harness.hold_account_lock(storage, "reader") as cleanup:
        worker = threading.Thread(target=filing)
        worker.start()
        started.wait()
        worker.join(timeout=1.0)
        assert worker.is_alive(), "the commit must wait for the account lock"
        settled = cleanup()
    worker.join(timeout=10)
    if settled is None:
        settled = storage.settle_onboarding("reader", require_filing=True)

    assert not worker.is_alive()
    assert settled["outcome"] == "restart"
    assert outcome["result"] == "refused"
    assert not storage.has_memory_event("reader", "paper:p1")
    with pytest.raises(HTTPException):
        storage.get_memory_page("reader", "page-p1")


def test_a_reclaimed_filing_refuses_the_old_worker_at_commit(storage):
    from delphi_core.storage import MemoryJobGone

    project = storage.create_project("reader", "First", onboarding=True)
    storage.add_paper("reader", project["id"], {"id": "p1", "title": "A", "filename": "a.pdf"})
    old = _claim(storage)
    replacement = storage.claim_memory_job(
        "reader", now="2100-01-01T00:00:00+00:00",
        lease_expires_at="2100-01-02T00:00:00+00:00", max_attempts=6,
    )
    assert old["id"] == replacement["id"]
    with pytest.raises(MemoryJobGone):
        _file(storage, project["id"], "p1", fence_job=(old["id"], old["attempts"]))
    assert not storage.has_memory_event("reader", "paper:p1")
    _file(storage, project["id"], "p1", fence_job=(replacement["id"], replacement["attempts"]))
    assert storage.has_memory_event("reader", "paper:p1")


def test_html_annotations_retry_without_losing_notes(storage):
    from delphi_core_testkit.conformance._support import html_payload
    project = storage.create_project("reader", "Web reading")
    add_annotated_paper(storage, project["id"])
    payload = html_payload()
    original = storage.add_highlight("reader", project["id"], "p", payload)
    note = storage.add_note("reader", project["id"], "p", {
        "highlightId":original["id"], "page":None,"anchorY":None,
        "quotedText":payload["text"],"body":"Keep my thoughts"})
    retry = storage.add_highlight("reader", project["id"], "p", payload)
    assert original == retry
    assert retry["anchor"] == payload["anchor"]
    assert storage.list_notes("reader",project["id"],"p")[0]["id"] == note["id"]
    assert storage.list_notes("reader",project["id"],"p")[0]["page"] is None
    with pytest.raises(ValueError):
        storage.add_highlight("reader",project["id"],"p",{**payload,"text":"changed"})


def test_cached_html_placements_never_rewrite_original_anchors(storage):
    from delphi_core_testkit.conformance._support import html_payload
    project = storage.create_project("reader", "Web placements")
    add_annotated_paper(storage, project["id"])
    original = storage.add_highlight("reader", project["id"], "p", html_payload())
    storage.save_highlight_placements("reader", project["id"], "p", "c"*64,
                                      [{"id": original["id"], "start": 20, "end": 30}])
    after = next(item for item in storage.list_highlights("reader", project["id"], "p") if item["id"] == original["id"])
    assert after["anchor"] == original["anchor"]
    assert after["text"] == original["text"]
    assert after["placement"] == {"revision":"c"*64, "start":20, "end":30}
    storage.save_highlight_placements("reader", project["id"], "p", "d"*64,
                                      [{"id": original["id"], "start": 20, "end": 21}])
    reread = next(item for item in storage.list_highlights("reader", project["id"], "p") if item["id"] == original["id"])
    assert reread["placement"] == after["placement"]


def test_section_anchors_name_their_owning_documents_in_one_project(storage):
    """A bare `§anchor` citation is routed by this map, so both backends must
    agree on it: web sections only, document order, one project, owner-scoped."""
    section = lambda anchor, ordinal: {  # noqa: E731
        "kind": "section", "locator": anchor, "ordinal": ordinal, "title": anchor, "text": f"About {anchor}.",
    }
    project = indexed_project(storage, "Robots", "pi", [section("introduction", 1), section("leveraging-more-data", 2)])
    storage.add_paper("reader", project["id"], {"id": "lingbot", "title": "LingBot", "filename": "l.pdf"})
    storage.index_document_sections("reader", project["id"], "lingbot", [
        {"kind": "page", "locator": "3", "ordinal": 3, "title": "", "text": "A PDF page is not an anchor."},
    ])
    elsewhere = indexed_project(storage, "Elsewhere", "other", [section("unrelated", 1)])

    assert storage.list_section_anchors("reader", project["id"]) == {"pi": ["introduction", "leveraging-more-data"]}
    assert storage.list_section_anchors("reader", elsewhere["id"]) == {"other": ["unrelated"]}
    storage.create_account("stranger", None, "salt", "hash")
    with pytest.raises(HTTPException) as denied:
        storage.list_section_anchors("stranger", project["id"])
    assert denied.value.status_code == 404


def test_the_page_copy_and_the_text_are_written_under_one_lock_without_losing_either(storage, tmp_path):
    """
    A reader's annotation sends the page copy and the text refresh at once, and
    two tabs can each send both. Each writer reads `.web` and writes it back
    whole, so they must serialise on `annotation_revision_lock` — a row lock on
    Postgres, the project lock on the filesystem — and each must keep the
    other's half.
    """
    import threading
    import time

    from delphi_core.storage import LocalObjectStore
    from delphi_core.web_revision import freeze, page_fields, page_text, publish_saved_page, publish_snapshot, read_revision

    url = "https://example.org/article"
    words = "Diffusion models learn the score of a distribution blurred by noise. " * 8
    project = storage.create_project("reader", "Pages")["id"]
    storage.add_paper("reader", project, {"id": "page", "kind": "web", "title": "Article", "url": url,
                                          "filename": "example.org/article", "pages": 1, "tokens": 1, "bytes": 1})
    objects = LocalObjectStore(tmp_path / "objects")
    text = lambda n: {"url": url, "title": "Article", "sections": [{"anchor": "a", "title": "A", "markdown": words}, *(
        {"anchor": f"s{i}", "title": "S", "markdown": f"Paragraph {i} added later."} for i in range(n))]}
    copy = lambda n: freeze(f"<html><body><p>{words}</p><p>Copy {n}</p></body></html>", url, 1180)
    publish_snapshot(objects, "reader", project, "page", text(0), {}, page=page_fields(copy(0), url, "t0"))

    # Held: the other writer waits for it rather than interleaving with it.
    entered, release, order = threading.Event(), threading.Event(), []

    def holder():
        with storage.annotation_revision_lock("reader", project, "page"):
            entered.set()
            release.wait(5)
            order.append("holder")

    thread = threading.Thread(target=holder)
    thread.start()
    entered.wait(5)
    waiter = threading.Thread(target=lambda: (publish_saved_page(objects, "reader", project, "page", copy(99), page_text(copy(99)), url, storage), order.append("waiter")))
    waiter.start()
    time.sleep(0.3)
    assert order == []
    release.set()
    thread.join(5)
    waiter.join(5)
    assert order == ["holder", "waiter"]

    failures = []

    def pages():
        for n in range(1, 6):
            try:
                publish_saved_page(objects, "reader", project, "page", copy(n), page_text(copy(n)), url, storage)
            except Exception as exc:  # pragma: no cover - reported below
                failures.append(exc)

    def texts():
        for n in range(1, 6):
            for _attempt in range(20):
                try:
                    previous = read_revision(objects, "reader", project, "page")
                    publish_snapshot(objects, "reader", project, "page", text(n), previous, storage)
                    break
                except HTTPException as exc:
                    # Another text write between the read and the lock is the
                    # one conflict there is; the page copy never causes it.
                    assert exc.status_code == 409 and "changed during refresh" in exc.detail
            else:  # pragma: no cover
                failures.append("the text never landed")

    workers = [threading.Thread(target=pages), threading.Thread(target=texts)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(30)
    assert failures == []
    final = read_revision(objects, "reader", project, "page")
    assert final["savedDom"] == copy(5) and final["sections"] == text(5)["sections"]


def test_external_evidence_is_owner_only_immutable_and_kept_while_something_cites_it(storage):
    """
    A captured outside source belongs to the reader whose digest or page cites
    it, is written once, and goes when the last thing citing it goes. What
    cites it is read from the citing artifacts, in both stores alike.
    """
    storage.create_account("other", None, "salt", "hash")
    project = storage.create_project("reader", "Outside sources")
    storage.add_paper("reader", project["id"], {"id": "paper-a", "title": "Paper A", "filename": "a.pdf"})

    def capture(evidence_id: str, captured_at: str | None = None) -> dict:
        return storage.put_external_evidence("reader", {
            "id": evidence_id, "url": f"https://example.org/{evidence_id}", "title": "A later result",
            "contentHash": "c" * 64,
            "findings": [{"claim": "It was superseded.", "quote": "we supersede", "anchor": "results", "bearsOn": "correction"}],
            **({"capturedAt": captured_at} if captured_at else {}),
        })

    old = "2026-01-01T00:00:00+00:00"
    kept = capture("ev-digest", old)
    assert kept["objectKey"] == "knowledge/u/reader/evidence/ev-digest.json"
    assert kept["finalUrl"] == "https://example.org/ev-digest" and kept["capturedAt"] == old
    capture("ev-page", old)
    capture("ev-orphan", old)
    capture("ev-fresh")

    # Written once: what a page said on the day it was read does not change.
    with pytest.raises(HTTPException) as again:
        capture("ev-digest")
    assert again.value.status_code == 409
    # Read back whole, by its owner and nobody else.
    assert storage.get_external_evidence("reader", "ev-digest") == kept
    for username, evidence_id in (("other", "ev-digest"), ("reader", "no-such-evidence")):
        with pytest.raises(HTTPException) as missing:
            storage.get_external_evidence(username, evidence_id)
        assert missing.value.status_code == 404

    # A digest names its evidence in its metadata; a page names it in a citation.
    metadata = {"status": "generating", "sourceHash": "h", "version": "v"}
    assert storage.claim_digest(
        "reader", project["id"], "paper-a", claim_id="claim",
        expires_at="2999-01-01T00:00:00+00:00", metadata=metadata, force=False,
    ) == "claimed"
    storage.complete_digest(
        "reader", project["id"], "paper-a", "claim",
        {**metadata, "status": "ready", "evidenceIds": ["ev-digest"]},
    )
    storage.upsert_memory_page("reader", {
        "kind": "concept", "domain": "ml", "title": "Later work", "summary": "What came after.", "body": "It was superseded. [E1]",
        "citations": [{"id": 1, "claimType": "external", "evidenceId": "ev-page", "section": "results", "paperId": None, "page": None, "noteId": None}],
    }, max_pages=50)
    assert storage.external_evidence_references("reader") == {
        "ev-digest": [{"kind": "digest", "paperId": "paper-a"}],
        "ev-page": [{"kind": "page", "slug": "later-work"}],
    }
    assert storage.external_evidence_references("other") == {}

    # Reaping takes what nothing cites, spares a capture too new to have been
    # cited yet, and hands back the bytes' keys for the caller to delete.
    assert storage.delete_unreferenced_external_evidence("reader", older_than_seconds=3600) == [
        "knowledge/u/reader/evidence/ev-orphan.json"
    ]
    assert storage.get_external_evidence("reader", "ev-fresh")["id"] == "ev-fresh"
    assert storage.delete_unreferenced_external_evidence("reader", older_than_seconds=3600) == []

    # When the citing page goes, so does the reference, with nothing to clean up.
    storage.delete_memory_page("reader", "later-work")
    assert list(storage.external_evidence_references("reader")) == ["ev-digest"]
    assert storage.delete_unreferenced_external_evidence("reader", older_than_seconds=3600) == [
        "knowledge/u/reader/evidence/ev-page.json"
    ]


# --- Memory maintenance storage: aliases, version history, waiting jobs -----

def _concept(slug="attention", **fields):
    return {"slug": slug, "kind": "concept", "domain": "ml", "title": "Attention",
            "summary": "A mechanism.", "body": "Body.", **fields}


def _commit(storage, pages, request_id, **options):
    return storage.commit_memory_update(
        "reader", pages=pages, figures=[], event={"kind": "ingest", "requestId": request_id},
        max_pages=50, max_figures_per_page=4, **options,
    )


def _claim_at(storage, now="2026-01-01T00:00:00+00:00"):
    return storage.claim_memory_job(
        "reader", now=now, lease_expires_at="2999-01-01T00:00:00+00:00", max_attempts=9,
    )


def test_aliases_are_stored_cleaned_and_kept_by_a_write_that_does_not_name_them(storage):
    written = storage.upsert_memory_page("reader", _concept(
        title="Self-Attention", slug="self-attention",
        aliases=["  Scaled   dot-product attention ", "self attention", "SELF-ATTENTION",
                 "Intra-attention", "intra attention", "", 7],
    ), max_pages=50)
    # The title and the slug are not aliases of themselves, and two spellings
    # that compare equal are one alias, kept as first written.
    assert written["aliases"] == ["Scaled dot-product attention", "Intra-attention"]
    assert storage.get_memory_page("reader", "self-attention")["aliases"] == written["aliases"]
    assert storage.list_memory_pages("reader")[0]["aliases"] == written["aliases"]

    # A pass that never read the aliases has not decided to drop them.
    storage.upsert_memory_page(
        "reader", _concept(title="Self-Attention", slug="self-attention", body="Revised."), max_pages=50
    )
    assert storage.get_memory_page("reader", "self-attention")["aliases"] == written["aliases"]
    committed = _commit(storage, [_concept(title="Self-Attention", slug="self-attention", aliases=[])], "r-1")
    assert committed["pages"][0]["aliases"] == []
    assert storage.get_memory_page("reader", "self-attention")["aliases"] == []
    assert storage.upsert_memory_page(
        "reader", {**_concept("plain"), "kind": "source", "title": "Plain"}, max_pages=50
    )["aliases"] == []


def test_a_search_matches_an_alias_and_a_slug_lookup_resolves_one(storage):
    from delphi_core.memory_graph_index import MemoryGraphIndex

    storage.upsert_memory_page("reader", _concept(
        "low-rank-adaptation", title="Low-rank adaptation", summary="Adapters.", body="Text.",
        aliases=["LoRA", "Low-Rank Adapters"],
    ), max_pages=50)
    storage.upsert_memory_page("reader", _concept(
        "prefix-tuning", title="Prefix tuning", summary="Mentions lora once.", body="Text.",
    ), max_pages=50)
    # The alias scores as the title does, so it outranks a summary mention.
    assert [hit["slug"] for hit in storage.search_memory_pages("reader", "lora")] == [
        "low-rank-adaptation", "prefix-tuning",
    ]
    assert storage.search_memory_pages("reader", "lora")[0]["aliases"] == ["LoRA", "Low-Rank Adapters"]
    assert [hit["slug"] for hit in storage.search_memory_pages("reader", "adapters low rank")][0] == "low-rank-adaptation"

    index = MemoryGraphIndex.build(
        revision=1, pages=storage.list_memory_pages("reader"), domains=[], links=[],
    )
    assert index.aliases == {"lora": "low-rank-adaptation", "low rank adapters": "low-rank-adaptation"}
    for name in ("lora", "LoRA", "low-rank-adapters", "Low Rank  Adapters"):
        assert index.resolve_slug(name) == "low-rank-adaptation"
    # A page's own slug wins over another page's alias, and an unknown name
    # comes back as it was.
    assert index.resolve_slug("prefix-tuning") == "prefix-tuning"
    assert index.resolve_slug("nothing-here") == "nothing-here"


def test_every_revision_of_a_concept_or_domain_page_is_kept_with_its_cause(storage):
    first = _commit(storage, [
        _concept(_eventNote="first written", citations=[{"id": 1, "claimType": "derived"}]),
        {**_concept("ml"), "kind": "domain", "title": "ML"},
        {**_concept("a-paper"), "kind": "source", "title": "A paper"},
    ], "r-1", trigger="document")
    storage.upsert_memory_page(
        "reader", _concept(body="Asked about.", expectedRevision=1),
        max_pages=50, trigger="conversation", note="what the reader asked",
    )
    storage.upsert_memory_page("reader", _concept(body="Third."), max_pages=50)

    versions = storage.list_page_versions("reader", "attention")
    assert [(row["revision"], row["trigger"], row["note"], row["body"]) for row in versions] == [
        (3, None, None, "Third."),
        (2, "conversation", "what the reader asked", "Asked about."),
        (1, "document", "first written", "Body."),
    ]
    assert versions[2] == {
        "slug": "attention", "revision": 1, "title": "Attention", "summary": "A mechanism.",
        "body": "Body.", "citations": [{"id": 1, "claimType": "derived"}],
        "createdAt": first["pages"][0]["updatedAt"], "eventId": first["event"]["id"],
        "trigger": "document", "note": "first written",
    }
    # The event the row names is the one in the log.
    assert storage.list_memory_events("reader")[0]["id"] == first["event"]["id"]
    assert versions[0]["eventId"] is None
    assert [row["revision"] for row in storage.list_page_versions("reader", "ml")] == [1]
    # A source page is derived from its document and has no history.
    assert storage.list_page_versions("reader", "a-paper") == []
    assert storage.list_page_versions("reader", "no-such-page") == []

    history = storage.page_history("reader", ["attention", "ml", "a-paper", "no-such-page"])
    assert history["attention"]["latest"]["revision"] == 3
    assert history["attention"]["asked"]["revision"] == 2
    assert history["attention"]["asked"]["note"] == "what the reader asked"
    assert "body" not in history["attention"]["latest"] and "body" not in history["attention"]["asked"]
    assert history["ml"]["latest"]["revision"] == 1 and history["ml"]["asked"] is None
    assert history["a-paper"] == {"latest": None, "asked": None}
    assert history["no-such-page"] == {"latest": None, "asked": None}
    assert storage.page_history("reader", []) == {}

    with pytest.raises(HTTPException) as unknown:
        storage.upsert_memory_page("reader", _concept(), max_pages=50, trigger="whim")
    assert unknown.value.status_code == 422
    assert len(storage.list_page_versions("reader", "attention")) == 3


def test_version_history_keeps_the_newest_twenty_and_goes_with_the_page(storage):
    storage.create_account("other", None, "salt", "hash")
    storage.upsert_memory_page("other", _concept(body="Theirs."), max_pages=50)
    for number in range(1, 24):
        storage.upsert_memory_page(
            "reader", _concept(body=f"Revision {number}."), max_pages=50,
            trigger="conversation" if number == 2 else "document",
        )
    versions = storage.list_page_versions("reader", "attention")
    assert [row["revision"] for row in versions] == list(range(23, 3, -1))
    assert versions[-1]["body"] == "Revision 4."
    # The `conversation` row was the second revision, and it is gone with it.
    assert storage.page_history("reader", ["attention"])["attention"]["asked"] is None
    assert [row["body"] for row in storage.list_page_versions("other", "attention")] == ["Theirs."]

    storage.delete_memory_page("reader", "attention")
    assert storage.list_page_versions("reader", "attention") == []
    # A page later written at the same slug starts a history of its own.
    storage.upsert_memory_page("reader", _concept(body="Again."), max_pages=50)
    assert [(row["revision"], row["body"]) for row in storage.list_page_versions("reader", "attention")] == [
        (1, "Again."),
    ]
    assert len(storage.list_page_versions("other", "attention")) == 1


def test_a_refused_commit_leaves_no_version_row_behind(storage):
    _commit(storage, [_concept()], "r-1", trigger="document")
    with pytest.raises(HTTPException) as stale:
        _commit(storage, [
            _concept(body="Lands first.", expectedRevision=1),
            _concept("other-page", title="Other", expectedRevision=7),
        ], "r-2", trigger="document")
    assert stale.value.status_code == 409
    assert [row["revision"] for row in storage.list_page_versions("reader", "attention")] == [1]
    assert storage.list_page_versions("reader", "other-page") == []
    assert storage.get_memory_page("reader", "attention")["body"] == "Body."


def test_a_commit_told_to_require_revisions_refuses_a_concept_without_one(storage):
    source = {**_concept("a-paper"), "kind": "source", "title": "A paper"}
    with pytest.raises(HTTPException) as refused:
        _commit(storage, [source, _concept()], "r-1", require_revision=True)
    assert refused.value.status_code == 422
    assert "attention" in refused.value.detail
    # The whole commit is refused, the source page beside it included.
    assert storage.list_memory_pages("reader") == []
    with pytest.raises(HTTPException) as domain:
        _commit(storage, [{**_concept("ml"), "kind": "domain", "title": "ML"}], "r-1", require_revision=True)
    assert domain.value.status_code == 422

    # A source page needs none, and a new concept is written against revision 0.
    _commit(storage, [source, _concept(expectedRevision=0)], "r-2", require_revision=True)
    assert storage.get_memory_page("reader", "attention")["revision"] == 1
    with pytest.raises(HTTPException) as stale:
        _commit(storage, [_concept(expectedRevision=0)], "r-3", require_revision=True)
    assert stale.value.status_code == 409
    # A draft of another kind over a stored concept is a write to that concept.
    with pytest.raises(HTTPException) as disguised:
        _commit(storage, [{**_concept(), "kind": "source"}], "r-4", require_revision=True)
    assert disguised.value.status_code == 422
    _commit(storage, [_concept(body="Second.", expectedRevision=1)], "r-5", require_revision=True)
    # Today's callers pass nothing and are last-writer-wins, as before.
    _commit(storage, [_concept(body="Third.")], "r-6")
    assert storage.get_memory_page("reader", "attention")["revision"] == 3


def test_deleting_a_page_turns_every_link_to_it_into_plain_text(storage):
    storage.upsert_memory_page("reader", _concept(
        "softmax", title="The softmax function", body="Normalises scores.",
    ), max_pages=50)
    storage.upsert_memory_page("reader", _concept("kept", title="Kept", body="Stays."), max_pages=50)
    body = (
        "Scores pass through [[softmax]], also written [[softmax|a softmax layer]] "
        "or [[Softmax]]; see [[kept]] and [[never-written]].\n\n"
        "Inline `m[[softmax]]` stays.\n\n"
        "```python\nweights = table[[softmax]]\n```\n"
    )
    storage.upsert_memory_page("reader", _concept(body=body), max_pages=50, trigger="document")
    storage.upsert_memory_page("reader", {
        **_concept("a-paper", body="It uses [[softmax]]."), "kind": "source", "title": "A paper",
    }, max_pages=50)
    # Named only inside code: the link index holds the edge, the prose has no link.
    storage.upsert_memory_page("reader", _concept("code-only", title="Code", body="`x[[softmax]]`"), max_pages=50)

    storage.delete_memory_page("reader", "softmax")

    holder = storage.get_memory_page("reader", "attention")
    assert holder["body"] == (
        "Scores pass through The softmax function, also written a softmax layer "
        "or The softmax function; see [[kept]] and [[never-written]].\n\n"
        "Inline `m[[softmax]]` stays.\n\n"
        "```python\nweights = table[[softmax]]\n```\n"
    )
    assert holder["revision"] == 2
    versions = storage.list_page_versions("reader", "attention")
    assert [(row["revision"], row["trigger"], row["note"]) for row in versions] == [
        (2, None, "link to a deleted page became text"), (1, "document", None),
    ]
    assert versions[0]["body"] == holder["body"]
    source = storage.get_memory_page("reader", "a-paper")
    assert (source["body"], source["revision"]) == ("It uses The softmax function.", 2)
    assert storage.list_page_versions("reader", "a-paper") == []
    # Nothing to repair, so no revision: neither the page that only named it
    # in code nor the one that never linked to it.
    assert storage.get_memory_page("reader", "code-only")["revision"] == 1
    assert storage.get_memory_page("reader", "kept")["revision"] == 1
    assert {"from": "a-paper", "to": "softmax"} not in storage.list_memory_links("reader")
    assert {"from": "attention", "to": "kept"} in storage.list_memory_links("reader")
    # Both still name it inside code, which the link index reads as a link.
    assert sorted(page["slug"] for page in storage.memory_backlinks("reader", "softmax")) == [
        "attention", "code-only",
    ]


def test_a_pending_job_waits_for_its_time_and_is_claimed_once_released(storage):
    waiting = storage.enqueue_memory_job(
        "reader", kind="session", marker="session:paper:p1", payload={"paperId": "p1"},
        not_before="2026-01-01T00:30:00+00:00",
    )
    assert (waiting["status"], waiting["retryAt"]) == ("pending", "2026-01-01T00:30:00+00:00")
    storage.enqueue_memory_job(
        "reader", kind="session", marker="session:conversation:c1", payload={},
        not_before="2026-01-01T00:30:00+00:00",
    )
    assert _claim_at(storage, now="2026-01-01T00:29:59+00:00") is None
    # Releasing by a marker that matches nothing, or by another kind, frees nothing.
    assert storage.release_memory_jobs("reader", marker="session:paper:other") == 0
    assert storage.release_memory_jobs("reader", kind="domain") == 0
    assert _claim_at(storage, now="2026-01-01T00:29:59+00:00") is None

    assert storage.release_memory_jobs("reader", marker="session:paper:p1") == 1
    claimed = _claim_at(storage, now="2026-01-01T00:00:00+00:00")
    assert (claimed["marker"], claimed["retryAt"]) == ("session:paper:p1", None)
    assert _claim_at(storage, now="2026-01-01T00:00:00+00:00") is None
    # The other is due when its time comes without anyone releasing it.
    assert _claim_at(storage, now="2026-01-01T00:30:00+00:00")["marker"] == "session:conversation:c1"

    # With no filter, every waiting job of the account: the app launched again.
    for marker in ("session:paper:p2", "session:paper:p3"):
        storage.enqueue_memory_job(
            "reader", kind="session", marker=marker, payload={}, not_before="2999-01-01T00:00:00+00:00",
        )
    storage.enqueue_memory_job(
        "reader", kind="domain", marker="domain:ml", payload={}, not_before="2999-01-01T00:00:00+00:00",
    )
    assert storage.release_memory_jobs("reader", kind="session") == 2
    assert storage.release_memory_jobs("reader") == 1
    assert storage.release_memory_jobs("reader") == 0
    with pytest.raises(HTTPException) as missing:
        storage.release_memory_jobs("nobody")
    assert missing.value.status_code == 404


def test_a_job_with_no_wait_is_due_at_once_and_a_failed_one_keeps_its_backoff(storage):
    storage.enqueue_memory_job("reader", kind="domain", marker="request-0001", payload={})
    claimed = _claim_at(storage)
    assert claimed["marker"] == "request-0001"
    storage.fail_memory_job(
        "reader", claimed["id"], error="boom", retry_at="2026-01-01T00:05:00+00:00",
    )
    # A release is for waiting work; a backoff is not waiting on the reader.
    assert storage.release_memory_jobs("reader") == 0
    assert _claim_at(storage, now="2026-01-01T00:04:59+00:00") is None
    assert _claim_at(storage, now="2026-01-01T00:05:00+00:00")["marker"] == "request-0001"


def test_an_enqueue_on_a_waiting_marker_pushes_the_wait_and_replaces_the_fingerprint(storage):
    first = storage.enqueue_memory_job(
        "reader", kind="session", marker="session:paper:p1",
        payload={"paperId": "p1", "projectId": "one", "fingerprint": "f1"},
        not_before="2026-01-01T00:30:00+00:00",
    )
    second = storage.enqueue_memory_job(
        "reader", kind="session", marker="session:paper:p1",
        payload={"fingerprint": "f2"}, not_before="2026-01-01T00:45:00+00:00",
    )
    assert second["id"] == first["id"]
    assert second["retryAt"] == "2026-01-01T00:45:00+00:00"
    # Merged, not replaced: what the later enqueue did not name is kept.
    assert second["payload"] == {"paperId": "p1", "projectId": "one", "fingerprint": "f2"}
    assert storage.list_memory_jobs("reader") == [second]
    assert _claim_at(storage, now="2026-01-01T00:44:59+00:00") is None
    assert _claim_at(storage, now="2026-01-01T00:45:00+00:00")["payload"]["fingerprint"] == "f2"

    # An enqueue that names neither a wait nor a fingerprint still leaves an
    # existing row's payload alone, as it always has.
    storage.enqueue_memory_job("reader", kind="domain", marker="request-0001", payload={"projectId": "one"})
    again = storage.enqueue_memory_job("reader", kind="domain", marker="request-0001", payload={"projectId": "two"})
    assert (again["payload"], again["retryAt"]) == ({"projectId": "one"}, None)


def test_a_job_whose_fingerprint_changed_during_the_work_stays_queued(storage):
    storage.enqueue_memory_job(
        "reader", kind="session", marker="session:paper:p1", payload={"fingerprint": "f1"},
    )
    claimed = _claim_at(storage)
    # A turn arrives while the pass is running.
    storage.enqueue_memory_job(
        "reader", kind="session", marker="session:paper:p1", payload={"fingerprint": "f2"},
        not_before="2026-01-01T00:30:00+00:00",
    )
    assert storage.complete_memory_job("reader", claimed["id"], fingerprint="f1") is False
    [kept] = storage.list_memory_jobs("reader")
    assert (kept["id"], kept["status"], kept["attempts"], kept["leaseExpiresAt"]) == (
        claimed["id"], "pending", 0, None,
    )
    assert kept["payload"]["fingerprint"] == "f2"
    # It waits as the later enqueue asked, and can still be released.
    assert kept["retryAt"] == "2026-01-01T00:30:00+00:00"
    assert _claim_at(storage, now="2026-01-01T00:29:00+00:00") is None
    assert storage.release_memory_jobs("reader", kind="session") == 1
    again = _claim_at(storage)
    assert storage.complete_memory_job("reader", again["id"], fingerprint="f2") is True
    assert storage.list_memory_jobs("reader") == []

    # No fingerprint on either side: completion removes the job, as before.
    storage.enqueue_memory_job("reader", kind="document", marker="paper:p1", payload={"fingerprint": "d1"})
    storage.enqueue_memory_job("reader", kind="domain", marker="request-0001", payload={})
    document = _claim_at(storage)
    answer = _claim_at(storage)
    assert storage.complete_memory_job("reader", document["id"]) is True
    assert storage.complete_memory_job("reader", answer["id"], fingerprint="anything") is True
    assert storage.complete_memory_job("reader", "gone-already") is True
    assert storage.list_memory_jobs("reader") == []


def test_a_cancelled_claim_goes_back_to_the_wait_an_enqueue_gave_it(storage):
    storage.enqueue_memory_job("reader", kind="session", marker="session:paper:p1", payload={"fingerprint": "f1"})
    claimed = _claim_at(storage)
    storage.enqueue_memory_job(
        "reader", kind="session", marker="session:paper:p1", payload={"fingerprint": "f2"},
        not_before="2026-01-01T00:30:00+00:00",
    )
    storage.release_memory_job("reader", claimed["id"])
    [job] = storage.list_memory_jobs("reader")
    assert (job["status"], job["attempts"], job["retryAt"]) == ("pending", 0, "2026-01-01T00:30:00+00:00")
    # With no enqueue in between, a handed-back claim is due at once, as before.
    storage.enqueue_memory_job("reader", kind="domain", marker="request-0001", payload={})
    storage.release_memory_job("reader", _claim_at(storage)["id"])
    assert _claim_at(storage)["marker"] == "request-0001"


def test_a_document_job_is_claimed_before_a_session_job_queued_earlier(storage):
    assert {"document", "session"} <= set(MEMORY_JOB_KINDS)
    for kind, marker in (("session", "session:paper:p1"), ("domain", "domain:ml"), ("document", "paper:p1")):
        storage.enqueue_memory_job("reader", kind=kind, marker=marker, payload={})
    assert [_claim_at(storage)["kind"] for _ in range(3)] == ["document", "session", "domain"]


def test_a_conversation_records_how_far_memory_filing_has_covered_it(storage):
    project = storage.create_project("reader", "Chat")
    storage.add_paper("reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"})
    key = chat_key(storage, "reader", project["id"], "paper-p")
    conversation_id = storage.get_thread("reader", project["id"], key)["conversationId"]
    assert storage.get_conversation("reader", conversation_id)["memoryFiledThrough"] is None
    for request_id in ("request_one001", "request_two002"):
        storage.append_message("reader", project["id"], key,
                               {"role": "user", "content": "q", "requestId": request_id})
        storage.append_message("reader", project["id"], key,
                               {"role": "assistant", "content": "a", "requestId": request_id})

    storage.set_memory_filed_through("reader", conversation_id, "request_two002")
    assert storage.get_conversation("reader", conversation_id)["memoryFiledThrough"] == "request_two002"
    assert storage.list_recent_conversations("reader")[0]["memoryFiledThrough"] == "request_two002"

    # Retracting the request the mark names moves it back to what remains.
    storage.drop_from_last_user_turn("reader", project["id"], key, "request_two002")
    assert storage.get_conversation("reader", conversation_id)["memoryFiledThrough"] == "request_one001"
    # A mark that names an earlier request is not disturbed by a tail edit.
    storage.append_message("reader", project["id"], key,
                           {"role": "user", "content": "q", "requestId": "request_three3"})
    storage.drop_from_last_user_turn("reader", project["id"], key, "request_three3")
    assert storage.get_conversation("reader", conversation_id)["memoryFiledThrough"] == "request_one001"
    storage.drop_from_last_user_turn("reader", project["id"], key, "request_one001")
    assert storage.get_conversation("reader", conversation_id)["memoryFiledThrough"] is None

    storage.set_memory_filed_through("reader", conversation_id, "request_one001")
    storage.set_memory_filed_through("reader", conversation_id, None)
    assert storage.get_conversation("reader", conversation_id)["memoryFiledThrough"] is None
    storage.create_account("other", None, "salt", "hash")
    for owner, target in (("other", conversation_id), ("reader", "nosuchconversation")):
        with pytest.raises(HTTPException) as missing:
            storage.set_memory_filed_through(owner, target, "request_one001")
        assert missing.value.status_code == 404


def test_resetting_a_conversation_clears_its_filing_mark(storage):
    key = chat_key(storage, "reader")
    conversation_id = storage.get_thread("reader", None, key)["conversationId"]
    storage.set_memory_filed_through("reader", conversation_id, "request_one001")
    storage.delete_conversation("reader", conversation_id, 0, reset=True)
    assert storage.get_conversation("reader", conversation_id)["memoryFiledThrough"] is None


def test_a_promoted_snapshot_replaces_the_history_with_the_pages(storage):
    for number in (1, 2):
        storage.upsert_memory_page("reader", _concept(body=f"Old {number}."), max_pages=50)
    storage.upsert_memory_page("reader", _concept("dropped", title="Dropped"), max_pages=50)
    candidate = {
        "id": "candidate-1", "slug": "attention", "kind": "concept", "domain": "ml", "title": "Attention",
        "summary": "A mechanism.", "body": "Rebuilt.", "aliases": ["Attn"], "revision": 1,
        "createdAt": "2026-09-01T12:00:00Z", "updatedAt": "2026-09-01T12:00:00Z",
    }
    snapshot = {"domains": [{"slug": "ml", "title": "ML"}], "pages": [candidate], "figures": [], "events": []}
    # A refused candidate leaves the history it would have replaced.
    with pytest.raises(HTTPException):
        storage.replace_memory_snapshot("reader", {
            **snapshot, "figures": [{"id": "lost", "pageId": "nobody", "caption": "orphan"}],
        }, max_pages=50)
    assert [row["body"] for row in storage.list_page_versions("reader", "attention")] == ["Old 2.", "Old 1."]

    storage.replace_memory_snapshot("reader", snapshot, max_pages=50)
    assert storage.get_memory_page("reader", "attention")["aliases"] == ["Attn"]
    assert [(row["revision"], row["body"], row["trigger"]) for row in storage.list_page_versions("reader", "attention")] == [
        (1, "Rebuilt.", None),
    ]
    assert storage.list_page_versions("reader", "dropped") == []


def test_deleting_a_domain_takes_its_page_history_with_it(storage):
    storage.upsert_memory_page(
        "reader", {**_concept("optics"), "kind": "domain", "domain": "optics", "title": "Optics"}, max_pages=50,
    )
    assert len(storage.list_page_versions("reader", "optics")) == 1
    storage.delete_memory_domain("reader", "optics")
    assert storage.list_page_versions("reader", "optics") == []


def test_latest_marker_events_gives_the_newest_event_each_job_marker_left(storage):
    """
    What the last job for a marker did, however it ended. A job whose every
    page was dropped writes an event that is not under its marker as
    `requestId`, so `memory_event_versions` does not see it; this read does.
    """
    storage.create_account("stranger", None, "salt", "hash")
    assert storage.latest_marker_events("reader") == {}
    assert storage.latest_marker_events("reader", []) == {}

    def log(owner, marker, request_id, created, **fields):
        return storage.append_memory_event(owner, {
            "kind": "document", "marker": marker, "requestId": request_id, "createdAt": created, **fields})

    log("reader", "paper:a", "paper:a", "2026-10-01T00:00:00+00:00", outcome="filed", fingerprint="one")
    failed = log("reader", "paper:a", "paper:a:dropped:1", "2026-10-02T00:00:00+00:00", outcome="failed",
                 fingerprint="two", dropped=[{"slug": "s", "title": "S", "action": "create", "reason": "r", "quote": "q"}])
    part = log("reader", "paper:a:part:1", "paper:a:part:1", "2026-10-03T00:00:00+00:00", outcome="nothing")
    # An event with no marker is not a job's, and another account's is not ours.
    storage.append_memory_event("reader", {"kind": "lint", "requestId": "lint-1"})
    log("stranger", "paper:a", "paper:a", "2026-10-04T00:00:00+00:00", outcome="filed")

    found = storage.latest_marker_events("reader", ["paper:a", "paper:a:part:1", "paper:never"])
    assert set(found) == {"paper:a", "paper:a:part:1"}
    # The newest, which is the failed one: its marker is not settled by it.
    assert found["paper:a"]["id"] == failed["id"] and found["paper:a"]["outcome"] == "failed"
    assert found["paper:a"]["fingerprint"] == "two" and found["paper:a"]["dropped"][0]["slug"] == "s"
    assert found["paper:a:part:1"]["id"] == part["id"]
    assert storage.memory_event_versions("reader", ["paper:a"]) == {"paper:a": None}

    # Narrowed to one marker, and unnarrowed: every marker in the account's log.
    assert set(storage.latest_marker_events("reader", ["paper:a"])) == {"paper:a"}
    assert set(storage.latest_marker_events("reader")) == {"paper:a", "paper:a:part:1"}

    # Two events in the same instant: the one written last wins, as it does for versions.
    log("reader", "paper:tie", "paper:tie", "2026-10-05T00:00:00+00:00", fingerprint="first")
    log("reader", "paper:tie", "paper:tie", "2026-10-05T00:00:00+00:00", fingerprint="second")
    assert storage.latest_marker_events("reader", ["paper:tie"])["paper:tie"]["fingerprint"] == "second"


def test_a_partial_page_queues_its_capture_and_its_filing_waits_for_it(storage):
    """A web page an add read at its first window is finished by a `capture` job.

    `add_paper` queues it beside the document's job when the record says
    `capture: "partial"`. No claim that names no kinds takes it, and none takes
    the document's job while the capture is owed: queued, leased or backing
    off. The capture's own claim names its kind. Done, or given up, the
    document's job is free. The record says `capture` only while it is partial.
    """
    project = storage.create_project("reader", "Books")["id"]
    lease = "2999-01-01T00:00:00+00:00"

    def claim(now="2026-01-01T00:00:00+00:00", **kinds):
        return storage.claim_memory_job("reader", now=now, lease_expires_at=lease, max_attempts=9, **kinds)

    added = storage.add_paper("reader", project, {
        "id": "book", "kind": "web", "title": "Book", "filename": "book", "url": "https://example.notion.site/book",
        "pages": 3, "tokens": 10, "capture": "partial",
    })
    assert added["capture"] == "partial"
    queued = {job["kind"]: job for job in storage.list_memory_jobs("reader")}
    assert set(queued) == {"capture", "document"}
    assert queued["capture"]["marker"] == "capture:book" and queued["capture"]["payload"]["paperId"] == "book"
    assert claim() is None

    held = claim(kinds=CAPTURE_JOB_KINDS)
    assert held["marker"] == "capture:book"
    # Leased, then backing off: the filing still waits.
    assert claim() is None
    storage.fail_memory_job("reader", held["id"], error="the page timed out", retry_at="2026-01-01T00:05:00+00:00",
                            expected_lease_expires_at=lease)
    assert claim() is None and claim(kinds=CAPTURE_JOB_KINDS) is None
    retried = claim("2026-01-01T00:06:00+00:00", kinds=CAPTURE_JOB_KINDS)
    assert retried["id"] == held["id"]
    whole = storage.update_paper_snapshot("reader", project, "book", {"capture": None})
    assert "capture" not in whole and "capture" not in storage.get_paper("reader", project, "book")
    assert storage.complete_memory_job("reader", retried["id"], expected_lease_expires_at=lease) is True
    assert claim()["marker"] == "paper:book"

    # A capture that gave up keeps the first window, and the filing goes ahead on it.
    storage.add_paper("reader", project, {
        "id": "notes", "kind": "web", "title": "Notes", "filename": "notes", "url": "https://example.notion.site/notes",
        "pages": 1, "tokens": 5, "capture": "partial",
    })
    given_up = claim(kinds=CAPTURE_JOB_KINDS)
    storage.fail_memory_job("reader", given_up["id"], error="walled", retry_at=None, expected_lease_expires_at=lease)
    assert claim()["marker"] == "paper:notes"

    # A page read whole at its add owes no capture.
    storage.add_paper("reader", project, {
        "id": "essay", "kind": "web", "title": "Essay", "filename": "essay", "url": "https://example.org/essay",
        "pages": 1, "tokens": 5,
    })
    assert "capture" not in storage.get_paper("reader", project, "essay")
    assert all(job["marker"] != "capture:essay" for job in storage.list_memory_jobs("reader"))
    assert claim()["marker"] == "paper:essay"
