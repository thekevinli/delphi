"""
The account export: a folder that explains itself and needs nothing of Delphi.

Read against a copy of the golden library, which holds every kind of thing an
account stores — documents, digests, notes, both kinds of chat, every page
kind, a captured figure, a plan — written by an earlier release.
"""

import io
import json
import posixpath
import re
import shutil
import zipfile
from pathlib import Path
from urllib.parse import unquote

import pytest

from delphi_core.account_export import assistant_turn, index_html
from delphi_core_testkit.golden import golden_settings, signed_in
from tests.build_golden import GOLDEN, NOTE_PAPER

pytestmark = pytest.mark.kb_maintenance

LINK = re.compile(r"\]\(([^)\s]+)\)")


@pytest.fixture(scope="module")
def export(tmp_path_factory):
    from delphi_core.storage import LocalObjectStore, LocalStorage

    data = tmp_path_factory.mktemp("export") / "data"
    shutil.copytree(GOLDEN / "local", data)
    settings = golden_settings(data)
    with signed_in(settings, LocalStorage(settings), LocalObjectStore(data)) as client:
        response = client.get("/api/export")
    assert response.status_code == 200, response.text[:500]
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    [root] = {name.split("/")[0] for name in archive.namelist()}
    assert f'filename="{root}.zip"' in response.headers["content-disposition"]
    files = {name[len(root) + 1:]: archive.read(name) for name in archive.namelist()}
    return files, json.loads(files["manifest.json"])


def text(files, name):
    return files[name].decode()


def test_the_folder_names_every_file_it_holds_and_holds_every_file_it_names(export):
    files, manifest = export
    assert {"README.md", "manifest.json", "index.html"} <= set(files)
    named = [d["path"] for d in manifest["projects"]]
    named += [path for p in manifest["projects"] for d in p["documents"] for path in d["files"].values()]
    named += [p["path"] for d in manifest["memory"]["domains"] for p in d["pages"]]
    named += [c["path"] for c in manifest["chats"]] + [p["path"] for p in manifest["plans"]]
    assert all(any(name == path or name.startswith(path + "/") for name in files) for path in named)
    assert manifest["chats"] and manifest["plans"] and manifest["memory"]["domains"]
    assert {c["scope"] for c in manifest["chats"]} == {"document", "memory"}


def test_every_link_in_every_markdown_file_resolves_inside_the_folder(export):
    files, _ = export
    checked = 0
    for name, data in files.items():
        if not name.endswith(".md") or name.startswith("memory/evidence/"):
            continue
        for target in LINK.findall(data.decode()):
            if re.match(r"[a-z]+:", target):
                continue
            path = unquote(target.split("#")[0])
            assert posixpath.normpath(posixpath.join(posixpath.dirname(name), path)) in files, (name, target)
            checked += 1
    assert checked


def test_no_reference_only_delphi_could_resolve_is_left(export):
    files, _ = export
    pages = {name: data.decode() for name, data in files.items() if name.startswith("memory/") and name.endswith(".md")
             and not name.startswith("memory/evidence/")}
    assert pages
    for name, body in pages.items():
        assert "figure:" not in body and "[[" not in body and not re.search(r"\[E\d+\]", body), name
    assert any("[^1]: " in body for body in pages.values())
    assert any("](../figures/" in body for body in pages.values())


def test_a_note_cited_by_memory_opens_the_annotations_it_was_written_in(export):
    files, manifest = export
    [document] = [d for p in manifest["projects"] for d in p["documents"] if d["id"] == NOTE_PAPER]
    annotations = text(files, document["files"]["annotations"])
    assert "**Note**" in annotations
    assert json.loads(files[document["files"]["annotations"].replace(".md", ".json")])["notes"]
    cited = [body for name, body in ((n, d.decode()) for n, d in files.items() if n.startswith("memory/") and n.endswith(".md"))
             if "your note: [" in body]
    assert cited and all("/annotations.md)" in body for body in cited)


def test_a_chat_reads_as_a_transcript_with_its_calls_in_place(export):
    files, manifest = export
    transcripts = [text(files, chat["path"]) for chat in manifest["chats"]]
    assert all(t.startswith("✻ Delphi · ") for t in transcripts)
    assert all("\n\n> " in t and "\n\n⏺ " in t for t in transcripts)
    assert any(re.search(r"^⏺ \w+\(.*\)\n  ⎿  ", t, re.M) for t in transcripts)


def test_a_stretch_of_work_lands_where_it_happened_in_the_answer():
    """Offsets count UTF-16 units: an emoji before the stretch must not shift it."""
    message = {"role": "assistant", "content": "😀 first part. second part.", "trace": [{
        "offset": 15, "entries": [{"kind": "tool", "tool": "open_memory", "args": {"slug": "x"}, "ok": True,
                                   "results": [{"slug": "x", "title": "X"}]}]}]}
    assert assistant_turn(message) == ["⏺ 😀 first part.", "⏺ open_memory(slug: \"x\")\n  ⎿  X", "⏺ second part."]


def test_the_index_keeps_a_hostile_title_as_data():
    page = index_html({"projects": [{"name": "</script><script>alert(1)</script>", "documents": []}]})
    data = page.split('<script id="data" type="application/json">')[1].split("</script>")[0]
    assert json.loads(data)["projects"][0]["name"].startswith("</script>")
