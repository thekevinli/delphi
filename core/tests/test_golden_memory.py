"""
The golden Memory library, opened by the code in this checkout.

`tests/data/golden/` is one account's Memory as an earlier release wrote it
through the local store, and the kit's snapshot is what every Memory,
conversation and plan read answered for it then (`build_golden`,
`delphi_core_testkit.golden`). Opening it now has to answer the same: a local
format step that loses, moves or renames what a reader had fails here, on
data the new code did not write for itself. A product holds its own store's
copy of the library to the same snapshot.

A read whose answer changed on purpose is recorded again with
`python -m tests.build_golden --snapshot-only`, and the snapshot's diff is
the change.
"""

import json
import shutil

import pytest

from delphi_core_testkit.golden import difference, differing, snapshot
from tests.build_golden import GOLDEN, USERNAME, read_local

pytestmark = pytest.mark.kb_maintenance


def test_the_golden_holds_every_kind_of_thing_memory_stores():
    """What the library is for: a migration proven on it met each of these."""
    answers = snapshot()
    manifest = json.loads((GOLDEN / "manifest.json").read_text())
    marker = GOLDEN / "local" / "users" / USERNAME / "knowledge" / "format.json"
    assert json.loads(marker.read_text())["format"] == manifest["localFormat"]

    pages = answers["/api/memory/pages"]["json"]
    assert {page["kind"] for page in pages} == {"source", "concept", "domain"}
    assert answers["/api/memory/graph"]["json"]["links"]
    [figure] = [answer for route, answer in answers.items() if route.startswith("/api/memory/figures/")]
    assert (figure["status"], figure["type"]) == (200, "image/webp")
    versions = {route: answer["rows"] for route, answer in answers.items() if route.startswith("Storage.list_page_versions")}
    assert max(len(rows) for rows in versions.values()) >= 3
    assert {row["trigger"] for rows in versions.values() for row in rows} >= {"document", "conversation", "notes", "domain"}
    jobs = answers["/api/memory/maintenance"]["json"]["jobs"]
    assert [(job["kind"], job["status"]) for job in jobs] == [("document", "pending")]
    kinds = {conversation["kind"] for conversation in answers["/api/conversations"]["json"]}
    assert kinds == {"memory_chat", "document_chat"}
    assert len(answers["/api/plans"]["json"]["plans"]) == 1
    [notes] = [answer["json"] for route, answer in answers.items() if route.endswith("/notes") and answer["json"]]
    cited = {citation["noteId"] for page in pages
             for citation in answers[f"/api/memory/pages/{page['slug']}"]["json"]["page"]["citations"]}
    assert {note["id"] for note in notes} <= cited


def test_the_local_library_answers_as_it_did_when_it_was_written():
    """Written at format 4, opened at format 5: every read as the snapshot says."""
    assert difference(read_local(GOLDEN / "local"), snapshot()) is None


@pytest.mark.parametrize("stored, key, read", [
    ("knowledge/pages/shared-idea-g7.json", "summary", "/api/memory/pages/shared-idea-g7"),
    ("knowledge/jobs.json", "marker", "/api/memory/maintenance"),
    ("conversations/*.json", "kind", "/api/conversations"),
    ("projects/*/notes/goldenpaperc.json", "body", "/papers/goldenpaperc/notes"),
])
def test_a_renamed_stored_key_fails_the_comparison(tmp_path, stored, key, read):
    """The comparison is not vacuous: one key renamed on disk, and the read that serves it no longer matches."""
    library = tmp_path / "library"
    shutil.copytree(GOLDEN / "local", library)
    path = sorted((library / "users" / USERNAME).glob(stored))[0]
    held = json.loads(path.read_text())
    record = held[0] if isinstance(held, list) else held
    record[f"{key}Renamed"] = record.pop(key)
    path.write_text(json.dumps(held))

    parted = differing(read_local(library), snapshot())

    assert any(route.endswith(read) for route in parted), parted
