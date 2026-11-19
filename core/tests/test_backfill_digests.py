"""The bulk digest rebuild.

Filing already rebuilds a stale digest before it can file, one document at a
time, in the foreground of a reader's click. These tests pin the properties that
make doing it in bulk safe to run and safe to re-run.
"""

import importlib
import re
import sys

import pytest

from delphi_core.backfill import digests
from delphi_core.backfill.digest_model_benchmark import ARMS, SAMPLE, visual_checks
from delphi_core.backfill.digests import describe, rebuild_account, stale_documents
from delphi_core.config import Settings
from delphi_core.research_digest import RESEARCH_DIGEST_VERSION
from delphi_core.storage import LocalObjectStore, LocalStorage


def test_digest_model_benchmark_is_balanced_and_changes_only_the_model_knob():
    assert len(SAMPLE) == 16
    assert sum(row["cohort"] == "prior-reject" for row in SAMPLE) == 8
    assert sum(row["cohort"] == "clean-control" for row in SAMPLE) == 8
    assert len({row["paperId"] for row in SAMPLE}) == len(SAMPLE)
    assert ARMS == {
        "luna-high": ("gpt-6-luna", "high"),
        "sol-medium": ("gpt-6-sol", "medium"),
    }


def test_digest_model_benchmark_distinguishes_assets_from_inline_embeds():
    assert visual_checks(
        {
            "contentMarkdown": "The architecture explains the path. [E3]",
            "assets": [
                {"id": "one", "afterEvidenceId": 3},
                {"id": "two", "afterEvidenceId": 9},
            ],
        }
    ) == {
        "selectedCapturedAssets": 2,
        "inlineImageEmbedsInStoredMarkdown": 0,
        "assetsWithPresentEvidenceAnchor": 1,
        "assetsWithMissingEvidenceAnchor": 1,
    }


def seeded(tmp_path):
    settings = Settings(data_dir=tmp_path, digest_model="gpt-6-luna")
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    project = storage.create_project("reader", "Reading")
    return settings, storage, project


def add(storage, project, paper_id, title, digest=None):
    storage.add_paper(
        "reader",
        project["id"],
        {"id": paper_id, "title": title, "filename": f"{paper_id}.pdf", "pages": 4},
    )
    if digest is not None:
        storage.update_paper_snapshot("reader", project["id"], paper_id, {"digest": digest})


def current_digest(settings):
    return {
        "status": "ready",
        "sourceHash": "abc123",
        "version": RESEARCH_DIGEST_VERSION,
        "model": settings.digest_model,
    }


def test_only_documents_behind_the_current_version_are_stale(tmp_path):
    """The skip test is the shipped one, so a version bump reaches this command.

    `digest_metadata_is_current` is what the filing route consults. A second
    copy here would drift, and the drift would surface as a library this
    reported clean that filing then rebuilt anyway — the exact surprise the
    command exists to remove.
    """
    settings, storage, project = seeded(tmp_path)
    add(storage, project, "fresh", "Current", current_digest(settings))
    add(storage, project, "old", "Old", {**current_digest(settings), "version": "research-digest-v2"})
    add(storage, project, "none", "Never built")
    add(
        storage,
        project,
        "wrong-model",
        "Built by another model",
        {**current_digest(settings), "model": "some-other-model"},
    )

    stale = stale_documents(storage, settings, "reader", force=False)
    assert {paper["id"] for _, paper in stale} == {"old", "none"}

    # `--force` is the deliberate rebuild of everything, current included.
    forced = stale_documents(storage, settings, "reader", force=True)
    assert {paper["id"] for _, paper in forced} == {"fresh", "old", "none", "wrong-model"}


def test_the_dry_run_names_the_version_each_document_is_moving_from(tmp_path):
    settings, storage, project = seeded(tmp_path)
    add(storage, project, "old", "Old", {**current_digest(settings), "version": "research-digest-v2"})
    add(storage, project, "none", "Never built")
    add(
        storage,
        project,
        "half",
        "Interrupted",
        {**current_digest(settings), "status": "pending"},
    )

    _, paper_old = next(
        pair for pair in stale_documents(storage, settings, "reader", force=False)
        if pair[1]["id"] == "old"
    )
    assert describe(paper_old) == "research-digest-v2"
    assert describe({"digest": {}}) == "(none)"
    assert describe({"digest": {"status": "pending"}}) == "(pending)"


@pytest.mark.asyncio
async def test_a_dry_run_writes_nothing_and_never_reaches_the_provider(tmp_path, monkeypatch):
    settings, storage, project = seeded(tmp_path)
    add(storage, project, "old", "Old", {**current_digest(settings), "version": "research-digest-v2"})

    async def refuse(*_args, **_kwargs):
        raise AssertionError("a dry run must not build a digest")
        yield  # pragma: no cover - generator shape only

    monkeypatch.setattr("delphi_core.backfill.digests.generate_digest", refuse)
    considered, planned, failed = await rebuild_account(
        storage, None, settings, "reader", dry_run=True, force=False, verbose=False
    )
    assert (considered, planned, failed) == (1, 1, 0)
    paper = storage.get_paper("reader", project["id"], "old")
    assert paper["digest"]["version"] == "research-digest-v2"


@pytest.mark.asyncio
async def test_one_document_failing_does_not_end_the_run_or_stamp_the_document(
    tmp_path, monkeypatch
):
    """A document the pass cannot handle is reported and left exactly as it was.

    Writing a failure onto it would take it out of the next run's candidates,
    which is how a document that failed once becomes a document nothing ever
    retries.
    """
    settings, storage, project = seeded(tmp_path)
    add(storage, project, "bad", "Unreadable", {**current_digest(settings), "version": "research-digest-v1"})
    add(storage, project, "good", "Fine", {**current_digest(settings), "version": "research-digest-v1"})

    async def flaky(_client, _storage, _objects, _user, _project, paper_id, *_a, **_k):
        if paper_id == "bad":
            raise RuntimeError("Extracted text is unavailable")
        yield {"type": "_digest_ready", "reused": False}

    monkeypatch.setattr("delphi_core.backfill.digests.generate_digest", flaky)
    considered, rebuilt, failed = await rebuild_account(
        storage, None, settings, "reader", dry_run=False, force=False, verbose=False
    )
    assert considered == 2
    assert rebuilt == 1
    assert failed == 1
    # Untouched, so the next run still sees it.
    assert storage.get_paper("reader", project["id"], "bad")["digest"]["version"] == (
        "research-digest-v1"
    )


@pytest.mark.asyncio
async def test_each_document_is_told_its_place_in_the_run(tmp_path, monkeypatch):
    """`generate_digest` takes `current`/`total` for exactly this.

    A v6 digest is minutes of work; without a denominator a batch of seventeen
    is seventeen indistinguishable waits.
    """
    settings, storage, project = seeded(tmp_path)
    for index in range(3):
        add(
            storage,
            project,
            f"p{index}",
            f"Paper {index}",
            {**current_digest(settings), "version": "research-digest-v1"},
        )

    seen = []

    async def record(*_args, current=None, total=None, **_kwargs):
        seen.append((current, total))
        yield {"type": "_digest_ready", "reused": False}

    monkeypatch.setattr("delphi_core.backfill.digests.generate_digest", record)
    await rebuild_account(
        storage, None, settings, "reader", dry_run=False, force=False, verbose=False
    )
    assert seen == [(1, 3), (2, 3), (3, 3)]


@pytest.mark.asyncio
async def test_an_account_with_nothing_stale_costs_no_provider_call(tmp_path, monkeypatch):
    settings, storage, project = seeded(tmp_path)
    add(storage, project, "fresh", "Current", current_digest(settings))

    async def refuse(*_args, **_kwargs):
        raise AssertionError("nothing was stale; there was nothing to build")
        yield  # pragma: no cover - generator shape only

    monkeypatch.setattr("delphi_core.backfill.digests.generate_digest", refuse)
    assert await rebuild_account(
        storage, None, settings, "reader", dry_run=False, force=False, verbose=False
    ) == (0, 0, 0)


def test_a_digest_backfill_says_how_many_documents_it_queued_for_memory(tmp_path, monkeypatch, capsys):
    """
    A real run ends by counting the document jobs its digests left and naming
    the command that drains them.

    Only a run that is not a dry run reaches those lines, and it pays for a
    digest per document first, so nothing else runs them: a queue or a switch
    renamed under them fails after the money is spent, and a command renamed
    under the message leaves it naming one that does not exist.
    """
    settings = Settings(_env_file=None, data_dir=tmp_path, digest_model="gpt-6-luna", openai_api_key="sk-test")
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    project = storage.create_project("reader", "Reading")
    add(storage, project, "old", "Old", {**current_digest(settings), "version": "research-digest-v1"})

    async def rebuilt(*_args, **_kwargs):
        yield {"type": "_digest_ready", "reused": False}

    monkeypatch.setattr(digests, "open_stores", lambda: (settings, storage, LocalObjectStore(tmp_path)))
    monkeypatch.setattr(digests, "generate_digest", rebuilt)
    monkeypatch.setattr(sys, "argv", ["digests", "--quiet"])
    assert digests.main() == 0

    said = capsys.readouterr().out
    assert f"1 stale documents · rebuilt 1 digests at {RESEARCH_DIGEST_VERSION}" in said
    # Import queued the document's job, and the run counts it.
    queued = re.search(r"^(\d+) document jobs are queued for Memory; `([\w.]+) --drain` runs them here$", said, re.M)
    assert queued and queued[1] == "1", said
    # The command it names is one that exists, and drains.
    command = importlib.import_module(queued[2])
    monkeypatch.setattr(sys, "argv", [queued[2], "--help"])
    with pytest.raises(SystemExit):
        command.main()
    assert "--drain" in capsys.readouterr().out
