"""
Local format 5: `knowledge/` becomes `memory/`, with the two stored names outside it.

The step (`delphi_core/storage/local_format.py`) names the files it will rewrite in
`knowledge/format.json`, rewrites `account.json`'s `knowledgeUpdate` and each
Memory conversation's `kind` in place with a copy of each file kept in
`knowledge.format-4/`, renames the directory, and then writes
`memory/format.json`. The stores are seeded as 0.6.9 wrote them at format 4,
and the golden library is the one 0.6.9 did write; a test opens a copy of it,
never the committed files, because opening a store migrates it.
"""

import json
import shutil
import sys
from pathlib import Path

import pytest

import delphi_core.backfill as backfill
from delphi_core.config import Settings
from delphi_core.storage import LocalObjectStore, LocalStorage, local_format
from delphi_core.stores import Stores
from tests.build_golden import GOLDEN, USERNAME, golden_settings, signed_in

THEN = "2026-10-01T00:00:00+00:00"
#: A slug and a page with the English word in it, as the owner's library has
#: one: what format 5 renames is fields, never strings.
SLUG = "training-on-new-knowledge-degrades-learned-behavior"
MEMORY_CHAT, DOCUMENT_CHAT, SECOND_CHAT = "a" * 32, "b" * 32, "c" * 32
UPDATE = {"status": "running", "total": 3, "done": 1, "failed": 0}


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def conversation(conversation_id, kind, title, *, paper=None):
    return {
        "memoryFiledThrough": "r1", "id": conversation_id, "kind": kind, "projectId": "proj" if paper else None,
        "paperId": paper, "title": title, "createdAt": THEN, "lastEngagedAt": THEN,
        "messages": [
            {"role": "user", "content": "Is knowledge_base_chat the kind, and knowledgeUpdate the key?",
             "createdAt": THEN, "requestId": "r1"},
            {"role": "assistant", "content": "See [[training-on-new-knowledge-degrades-learned-behavior]].",
             "createdAt": THEN, "requestId": "r1"},
        ],
        "generation": 0, "threadKey": f"conversation-{conversation_id}-0",
    }


def seed_format_four(root, owner="reader", *, old_names=True):
    """An account as 0.6.9 left it at format 4: Memory in `knowledge/`, the old names in their fields when `old_names`."""
    user = root / "users" / owner
    account = {"username": owner, "email": None, "passwordSalt": "s", "passwordHash": "h", "useStandardTier": True,
               "createdAt": THEN}
    if old_names:
        # Where `set_knowledge_update` put it, with a key written after it.
        account |= {"knowledgeUpdate": UPDATE, "passwordUpdatedAt": THEN}
    write(user / "account.json", account)
    knowledge = user / "knowledge"
    write(knowledge / "format.json", {"format": 4})
    body = ("What a fine-tune on new knowledge costs. Not [[knowledge-distillation]]; the words knowledge_base_chat "
            "and knowledgeUpdate here are prose. [E1]")
    write(knowledge / "pages" / f"{SLUG}.json", {
        "id": "page-one", "slug": SLUG, "kind": "concept", "domain": "general",
        "title": "Training on new knowledge degrades learned behavior", "summary": "knowledge_base_chat is a word here.",
        "body": body, "tags": ["knowledge"], "aliases": [], "links": ["knowledge-distillation"], "revision": 2,
        "citations": [{"id": 1, "claimType": "author-claim", "paperId": "p1", "page": 3, "section": None,
                       "noteId": None, "evidenceId": None}],
        "createdAt": THEN, "updatedAt": THEN,
    })
    write(knowledge / "pages" / "knowledge-distillation.json", {
        "id": "page-two", "slug": "knowledge-distillation", "kind": "concept", "domain": "general",
        "title": "Knowledge distillation", "summary": "", "body": f"Compare [[{SLUG}]].", "tags": [], "aliases": [],
        "links": [SLUG], "citations": [], "revision": 1, "createdAt": THEN, "updatedAt": THEN,
    })
    write(knowledge / "versions" / SLUG / "00000002.json", {
        "slug": SLUG, "revision": 2, "title": "Training on new knowledge degrades learned behavior", "summary": "",
        "body": body, "citations": [], "createdAt": THEN, "eventId": "ev-1", "trigger": "document", "note": None})
    write(knowledge / "domains.json", [{"slug": "general", "title": "General", "summary": None, "origin": "model",
                                        "position": 0, "createdAt": THEN, "updatedAt": THEN}])
    write(knowledge / "events.json", [{"id": "ev-1", "kind": "document", "requestId": "paper:p1",
                                       "version": "knowledge-v6", "createdAt": THEN, "pages": [SLUG]}])
    write(knowledge / "jobs.json", [])
    write(knowledge / "figures.json", [])
    write(knowledge / "graph.json", {"revision": 4})
    conversations = user / "conversations"
    write(conversations / f"{DOCUMENT_CHAT}.json", conversation(DOCUMENT_CHAT, "document_chat", "On paper one", paper="p1"))
    if old_names:
        write(conversations / f"{MEMORY_CHAT}.json", conversation(MEMORY_CHAT, "knowledge_base_chat", "knowledgeUpdate?"))
        write(conversations / f"{SECOND_CHAT}.json", conversation(SECOND_CHAT, "knowledge_base_chat", "Another"))
    return user


def tree(root):
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


def stamped(root):
    return {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in sorted(root.rglob("*")) if path.is_file()}


def opened(root):
    return LocalStorage(Settings(data_dir=root))


def holds_its_place(user):
    """`knowledge` is the note format 5 leaves where the directory was: a file, not a directory."""
    return json.loads((user / "knowledge").read_text()) == local_format.FORMER_PLACE


REWRITTEN = ["account.json", f"conversations/{MEMORY_CHAT}.json", f"conversations/{SECOND_CHAT}.json"]


# --- the step ----------------------------------------------------------------


def test_a_format_four_store_is_renamed_the_first_time_it_is_opened(tmp_path):
    user = seed_format_four(tmp_path)
    before = tree(user)

    storage = opened(tmp_path)

    after = tree(user)
    assert holds_its_place(user) and after.pop("knowledge")
    assert json.loads(after["memory/format.json"]) == {"format": local_format.LOCAL_FORMAT} == {"format": 5}
    # The directory moved whole: every file in it is in `memory/` as it was, but its marker.
    assert {name.replace("memory/", "knowledge/", 1): held for name, held in after.items()
            if name.startswith("memory/") and name != "memory/format.json"} == \
        {name: held for name, held in before.items() if name.startswith("knowledge/") and name != "knowledge/format.json"}
    # The Update run's key, renamed where it stood, its value and the rest as they were.
    account, was = json.loads(after["account.json"]), json.loads(before["account.json"])
    assert list(account) == ["memoryUpdate" if key == "knowledgeUpdate" else key for key in was]
    assert account == {**{key: value for key, value in was.items() if key != "knowledgeUpdate"}, "memoryUpdate": UPDATE}
    for chat in (MEMORY_CHAT, SECOND_CHAT):
        name = f"conversations/{chat}.json"
        assert json.loads(after[name]) == {**json.loads(before[name]), "kind": "memory_chat"}
    # A document chat holds no old name and is not touched.
    assert after[f"conversations/{DOCUMENT_CHAT}.json"] == before[f"conversations/{DOCUMENT_CHAT}.json"]
    # Read through the store as the code names them now.
    assert storage.get_memory_update("reader") == UPDATE
    listed = storage.list_scope_conversations("reader", "general")["items"]
    assert sorted((row["id"], row["kind"]) for row in listed) == [(MEMORY_CHAT, "memory_chat"), (SECOND_CHAT, "memory_chat")]
    assert storage.get_memory_page("reader", SLUG)["revision"] == 2
    assert [row["revision"] for row in storage.list_page_versions("reader", SLUG)] == [2]
    assert len(storage.list_memory_events("reader", limit=10)) == 1


def test_what_the_step_rewrote_is_kept_beside_it_as_format_four_left_it(tmp_path):
    user = seed_format_four(tmp_path)
    before = tree(user)

    opened(tmp_path)

    kept = user / local_format.BEFORE_RENAME
    assert tree(kept) == {name: before[name] for name in REWRITTEN}
    # Taken once: a later open, as a new process, copies nothing over it.
    held = stamped(tmp_path)
    local_format._CURRENT.clear()
    opened(tmp_path)
    assert stamped(tmp_path) == held


def test_only_the_named_fields_are_rewritten(tmp_path):
    """The word in a slug, a title, a body, a tag, a summary, a message or a filing version stays."""
    user = seed_format_four(tmp_path)
    before = tree(user)

    opened(tmp_path)

    after = tree(user)
    for name in (f"pages/{SLUG}.json", "pages/knowledge-distillation.json", f"versions/{SLUG}/00000002.json",
                 "events.json"):
        assert after[f"memory/{name}"] == before[f"knowledge/{name}"]
    renamed = json.loads(after[f"conversations/{MEMORY_CHAT}.json"])
    assert renamed["title"] == "knowledgeUpdate?" and "knowledge_base_chat" in renamed["messages"][0]["content"]
    changed = {name for name in after if name in before and after[name] != before[name]}
    assert changed == set(REWRITTEN)


def test_the_step_names_what_it_will_rewrite_before_it_rewrites_anything(tmp_path, monkeypatch):
    user = seed_format_four(tmp_path)
    before = tree(user)

    def refuse(source, target):
        raise OSError("the process died")

    monkeypatch.setattr(local_format.shutil, "copy2", refuse)
    with pytest.raises(OSError):
        opened(tmp_path)

    assert json.loads((user / "knowledge" / "format.json").read_text()) == {"format": 4, "renaming": {"files": REWRITTEN}}
    assert {name: held for name, held in tree(user).items() if name != "knowledge/format.json"} == \
        {name: held for name, held in before.items() if name != "knowledge/format.json"}


def stop_at(monkeypatch, user, point):
    """Make the step stop at `point`, as a process that died there would."""
    real_write, real_copy, real_rename = LocalStorage._write_json, local_format.shutil.copy2, local_format.os.rename
    write_fails = {
        "a copy": user / "account.json",
        "the account": user / "conversations" / f"{MEMORY_CHAT}.json",
        "a conversation": user / "conversations" / f"{SECOND_CHAT}.json",
        "the rename": user / "memory" / "format.json",
    }.get(point)

    def writing(self, path, value):
        if path == write_fails:
            raise OSError("the process died")
        real_write(self, path, value)

    def copying(source, target):
        if point == "the plan" or (point == "a half copy" and Path(source).name == f"{MEMORY_CHAT}.json"):
            # Half a file, and then nothing.
            Path(target).write_bytes(Path(source).read_bytes()[:20])
            raise OSError("the process died")
        return real_copy(source, target)

    def renaming(source, target):
        if point == "the rewrites" and Path(source) == user / "knowledge":
            raise OSError("the process died")
        return real_rename(source, target)

    monkeypatch.setattr(LocalStorage, "_write_json", writing)
    monkeypatch.setattr(local_format.shutil, "copy2", copying)
    monkeypatch.setattr(local_format.os, "rename", renaming)


@pytest.mark.parametrize("point", ["the plan", "a copy", "a half copy", "the account", "a conversation",
                                   "the rewrites", "the rename"])
def test_an_interrupted_rename_finishes_on_the_next_open(tmp_path, monkeypatch, point):
    """A crash at each point of the step, then an ordinary open: the store is as one uninterrupted run leaves it."""
    seed_format_four(tmp_path / "whole")
    opened(tmp_path / "whole")
    user = seed_format_four(tmp_path / "cut")
    stop_at(monkeypatch, user, point)

    with pytest.raises(OSError):
        opened(tmp_path / "cut")

    # Still format 4, and still saying what it was doing, wherever the marker now is.
    renamed = point == "the rename"
    assert (user / "memory").exists() is renamed and (user / "knowledge").is_dir() is not renamed
    held = user / ("memory" if renamed else "knowledge") / "format.json"
    assert json.loads(held.read_text()) == {"format": 4, "renaming": {"files": REWRITTEN}}
    # A bulk command takes it for what it is: behind.
    assert "at local format 4" in local_format.not_current(tmp_path / "cut")["reader"]
    monkeypatch.undo()

    opened(tmp_path / "cut")

    assert tree(tmp_path / "cut") == tree(tmp_path / "whole")
    # Whole copies of the files as they were, a half copy among them taken again.
    kept = tree(user / local_format.BEFORE_RENAME)
    assert sorted(kept) == sorted(REWRITTEN)
    assert json.loads(kept["account.json"])["knowledgeUpdate"] == UPDATE
    assert {json.loads(kept[name])["kind"] for name in REWRITTEN[1:]} == {"knowledge_base_chat"}


def test_a_file_that_took_an_old_name_after_the_plan_is_rewritten_and_kept_too(tmp_path, monkeypatch):
    """A release before format 5 that ran between the plan and the resume saw format 4 and wrote as it always did."""
    user = seed_format_four(tmp_path)
    with monkeypatch.context() as stopped:
        stop_at(stopped, user, "the plan")
        with pytest.raises(OSError):
            opened(tmp_path)
    late = "f" * 32
    write(user / "conversations" / f"{late}.json", conversation(late, "knowledge_base_chat", "Written after the plan"))
    local_format._CURRENT.clear()

    storage = opened(tmp_path)

    assert json.loads((user / "conversations" / f"{late}.json").read_text())["kind"] == "memory_chat"
    kept = json.loads((user / local_format.BEFORE_RENAME / "conversations" / f"{late}.json").read_text())
    assert kept["kind"] == "knowledge_base_chat"
    assert late in {row["id"] for row in storage.list_scope_conversations("reader", "general")["items"]}


def test_a_store_with_nothing_to_rewrite_is_renamed_and_keeps_no_copy(tmp_path):
    """Each account takes the step; one with no old name in a field keeps no copy."""
    seed_format_four(tmp_path)
    quiet = seed_format_four(tmp_path, "quiet", old_names=False)
    before = tree(quiet)

    opened(tmp_path)

    assert not (quiet / local_format.BEFORE_RENAME).exists()
    assert (tmp_path / "users" / "reader" / local_format.BEFORE_RENAME).is_dir()
    after = tree(quiet)
    assert json.loads(after.pop("memory/format.json")) == {"format": 5}
    assert json.loads(after.pop("knowledge")) == local_format.FORMER_PLACE
    assert after == {("memory/" + name[len("knowledge/"):] if name.startswith("knowledge/") else name): held
                     for name, held in before.items() if name != "knowledge/format.json"}


def test_a_new_account_starts_at_format_five_in_memory(tmp_path, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the rename ran on an account that was never behind")

    monkeypatch.setattr(local_format, "_rename", refuse)
    storage = opened(tmp_path)
    storage.create_account("reader", None, "salt", "hash")
    storage.set_memory_update("reader", UPDATE)

    user = tmp_path / "users" / "reader"
    assert json.loads((user / "memory" / "format.json").read_text()) == {"format": 5}
    assert holds_its_place(user) and not (user / local_format.BEFORE_RENAME).exists()
    assert json.loads((user / "account.json").read_text())["memoryUpdate"] == UPDATE
    local_format._CURRENT.clear()
    assert opened(tmp_path).get_memory_update("reader") == UPDATE


def test_a_store_at_format_five_is_not_renamed_again(tmp_path, monkeypatch):
    seed_format_four(tmp_path)
    opened(tmp_path)
    held = stamped(tmp_path)

    def refuse(*args, **kwargs):
        raise AssertionError("the rename ran twice")

    monkeypatch.setattr(local_format, "_rename", refuse)
    local_format._CURRENT.clear()
    opened(tmp_path)

    assert stamped(tmp_path) == held


# --- refused ------------------------------------------------------------------


def downgraded(root):
    """A format 5 profile into which a Memory in the old layout came back: a backup restored by hand, say."""
    user = seed_format_four(root)
    opened(root)
    (user / "knowledge").unlink()
    write(user / "knowledge" / "format.json", {"format": 4})
    write(user / "knowledge" / "pages" / "written-after.json", {"slug": "written-after", "kind": "concept"})
    local_format._CURRENT.clear()
    return user


def test_a_profile_holding_both_directories_is_refused_and_both_are_kept(tmp_path, caplog):
    downgraded(tmp_path)
    held = stamped(tmp_path)

    for _ in range(2):
        # Refused at every open, not once: it is never taken for current.
        with caplog.at_level("ERROR", logger="uvicorn.error"), pytest.raises(RuntimeError, match="both knowledge/ and memory/"):
            opened(tmp_path)

    assert stamped(tmp_path) == held
    # Logged once, though every request that constructs the store asks again.
    assert caplog.text.count(f"{tmp_path / 'users' / 'reader'} holds both knowledge/ and memory/") == 1


def test_a_release_before_format_five_finds_a_file_where_its_directory_was(tmp_path):
    """The first two things 0.6.9 does there, it cannot: read its marker (it catches only a missing one), or make the directory again."""
    user = seed_format_four(tmp_path)
    opened(tmp_path)

    assert holds_its_place(user)
    with pytest.raises(NotADirectoryError):
        (user / "knowledge" / "format.json").read_text()
    with pytest.raises((FileExistsError, NotADirectoryError)):
        (user / "knowledge" / "pages").mkdir(parents=True, exist_ok=True)


def test_an_account_at_format_five_without_its_note_gets_one_on_the_next_open(tmp_path):
    """A run cut short after its marker and before the note: the next open writes it."""
    user = seed_format_four(tmp_path)
    opened(tmp_path)
    (user / "knowledge").unlink()
    local_format._CURRENT.clear()

    opened(tmp_path)

    assert holds_its_place(user)


def test_a_memory_note_without_its_directory_is_refused(tmp_path):
    user = seed_format_four(tmp_path)
    opened(tmp_path)
    shutil.rmtree(user / "memory")
    local_format._CURRENT.clear()

    with pytest.raises(RuntimeError, match="memory/ is missing"):
        opened(tmp_path)


def test_a_memory_directory_without_its_marker_is_refused_before_any_step(tmp_path):
    """Taken for format 1, the retirement would run beside it and stamp every conversation as filed."""
    user = seed_format_four(tmp_path)
    (user / "knowledge").rename(user / "memory")
    (user / "memory" / "format.json").unlink()
    held = stamped(tmp_path)

    with pytest.raises(RuntimeError, match="memory/ has no format.json"):
        opened(tmp_path)

    assert stamped(tmp_path) == held


# --- object keys (L4) -----------------------------------------------------------


def test_a_figure_and_a_capture_stored_before_format_5_still_read_after_it(tmp_path):
    """Their records keep the `knowledge/u/…` keys they were stored under; the bytes moved with the directory."""
    library = tmp_path / "library"
    shutil.copytree(GOLDEN / "local", library)
    user = library / "users" / USERNAME
    knowledge = user / "knowledge"
    [figure] = json.loads((knowledge / "figures.json").read_text())
    figure_bytes = (knowledge / "figures" / f"{figure['id']}.webp").read_bytes()
    # A capture, stored as 0.6.9 stored one, cited by the page the figure is on.
    capture_key = f"knowledge/u/{USERNAME}/evidence/goldencapture.json"
    sections = [{"anchor": "results", "title": "Results", "level": 2, "markdown": "Stable prefixes halve latency."}]
    write(knowledge / "evidence" / "goldencapture.json", {"sections": sections})
    write(knowledge / "evidence.json", [{
        "id": "goldencapture", "url": "https://example.org/prefix", "finalUrl": "https://example.org/prefix",
        "title": "Prefix reuse", "contentHash": "0" * 64, "findings": [], "objectKey": capture_key,
        "capturedAt": THEN}])
    [page_path] = [path for path in (knowledge / "pages").glob("*.json")
                   if json.loads(path.read_text())["id"] == figure["pageId"]]
    page = json.loads(page_path.read_text())
    page["citations"].append({"id": 2, "claimType": "external", "paperId": None, "page": None, "section": None,
                              "noteId": None, "evidenceId": "goldencapture"})
    write(page_path, page)

    settings = golden_settings(library, external_evidence_reap_grace_seconds=0)
    storage = LocalStorage(settings)
    objects = LocalObjectStore(library, settings.chat_image_retention_days)

    assert not knowledge.is_dir()
    [stored] = storage.list_memory_figures(USERNAME)
    record = storage.get_external_evidence(USERNAME, "goldencapture")
    assert (stored["objectKey"], record["objectKey"]) == (figure["objectKey"], capture_key)
    assert stored["objectKey"].startswith(f"knowledge/u/{USERNAME}/figures/")
    assert b"".join(objects.open_range(stored["objectKey"])) == figure_bytes
    assert json.loads(objects.get_text(record["objectKey"]))["sections"] == sections
    with signed_in(settings, storage, objects) as client:
        served = client.get(f"/api/memory/figures/{figure['id']}")
        assert (served.status_code, served.content) == (200, figure_bytes)
        assert client.get("/api/evidence/goldencapture").json()["sections"] == sections

        assert client.delete(f"/api/memory/pages/{page['slug']}").status_code == 204

        assert client.get("/api/evidence/goldencapture").status_code == 404
    assert not objects.exists(stored["objectKey"]) and not objects.exists(capture_key)
    assert not (user / "memory" / "figures" / f"{figure['id']}.webp").exists()
    assert not (user / "memory" / "evidence" / "goldencapture.json").exists()


# --- the golden library -----------------------------------------------------------


def test_the_golden_library_written_at_format_four_opens_at_format_five(tmp_path):
    """0.6.9's own library: the directory moves whole, and the Memory chat alone is rewritten and kept."""
    library = tmp_path / "library"
    shutil.copytree(GOLDEN / "local", library)
    user = library / "users" / USERNAME
    before = tree(user)
    assert json.loads(before["knowledge/format.json"]) == {"format": 4}

    LocalStorage(golden_settings(library))

    after = tree(user)
    chats = [name for name in before if name.startswith("conversations/")
             and json.loads(before[name])["kind"] == "knowledge_base_chat"]
    assert len(chats) == 1
    [chat] = chats
    expected = {("memory/" + name[len("knowledge/"):] if name.startswith("knowledge/") else name): held
                for name, held in before.items() if name != "knowledge/format.json"}
    expected |= {"memory/format.json": after["memory/format.json"], chat: after[chat],
                 f"{local_format.BEFORE_RENAME}/{chat}": before[chat], "knowledge": after["knowledge"]}
    assert after == expected
    assert json.loads(after["memory/format.json"]) == {"format": 5} and holds_its_place(user)
    assert json.loads(after[chat]) == {**json.loads(before[chat]), "kind": "memory_chat"}
    # The committed library is as it was written: every test opens a copy.
    assert (GOLDEN / "local" / "users" / USERNAME / "knowledge" / "format.json").exists()
    assert not (GOLDEN / "local" / "users" / USERNAME / "memory").exists()


# --- the bulk commands ---------------------------------------------------------------


def command_settings(monkeypatch, root):
    settings = Settings(_env_file=None, data_dir=root)
    monkeypatch.setattr(backfill, "default_stores", lambda: (settings, Stores.local()))
    return settings


@pytest.mark.parametrize("held", ["behind", "ahead", "split"])
def test_a_bulk_command_refuses_a_store_not_at_format_five(tmp_path, monkeypatch, held):
    """It never migrates a store itself: only the app renames the directory, and a newer store is not its to read."""
    if held == "behind":
        seed_format_four(tmp_path)
    elif held == "ahead":
        seed_format_four(tmp_path)
        opened(tmp_path)
        write(tmp_path / "users" / "reader" / "memory" / "format.json", {"format": 6})
    else:
        downgraded(tmp_path)
    local_format._CURRENT.clear()
    command_settings(monkeypatch, tmp_path)
    before = stamped(tmp_path)

    with pytest.raises(SystemExit) as refused:
        backfill.open_stores()

    said = str(refused.value.code)
    assert said.startswith("Not run: this command works only on a local store at format 5.")
    assert {"behind": "reader: at local format 4; open it in Delphi",
            "ahead": "reader: at local format 6, newer than this release's 5",
            "split": f"reader: {tmp_path / 'users' / 'reader'} holds both knowledge/ and memory/"}[held] in said
    assert stamped(tmp_path) == before


def test_a_bulk_command_runs_on_a_store_at_format_five_and_refuses_one_behind(tmp_path, monkeypatch, capsys):
    """Through a real command's `main`, both ways."""
    from delphi_core.backfill import index

    seed_format_four(tmp_path)
    command_settings(monkeypatch, tmp_path)
    monkeypatch.setattr(sys, "argv", ["index", "--quiet"])
    local_format._CURRENT.clear()

    with pytest.raises(SystemExit, match="reader: at local format 4"):
        index.main()
    assert (tmp_path / "users" / "reader" / "knowledge").is_dir()

    opened(tmp_path)
    assert local_format.not_current(tmp_path) == {}
    assert index.main() == 0
    assert "storage local" in capsys.readouterr().out
