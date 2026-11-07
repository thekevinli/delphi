"""
The bulk Memory catch-up: which documents it queues, how it drains them, and what it reports.

The end-to-end tests run the real pipeline on real local stores, with the
journey rig's fixture as the provider (`tests/rig_library.py`).
"""

import asyncio
import sys

import pytest

from delphi_core.backfill import memory as catch_up
from delphi_core.backfill.memory import (
    describe_run,
    drain_account,
    enqueue_account,
    filing_summary,
    owed_documents,
    tally,
)
from delphi_core.config import Settings
from delphi_core.memory import MEMORY_VERSION
from delphi_core.memory_maintenance.run import StaleRevision
from delphi_core.storage import LocalObjectStore, LocalStorage
from tests.rig_library import Rig


def seeded(tmp_path, **given):
    settings = Settings(_env_file=None, data_dir=tmp_path, openai_api_key="sk-test", **given)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    project = storage.create_project("reader", "Reading")
    storage.add_paper(
        "reader",
        project["id"],
        {"id": "one", "title": "A paper", "filename": "one.pdf", "pages": 4},
    )
    return settings, storage, project


def file_event(storage, version, *, dropped=()):
    storage.append_memory_event(
        "reader",
        {
            "kind": "document",
            "version": version,
            "requestId": "paper:one",
            "marker": "paper:one",
            "outcome": "filed",
            "summary": "filed",
            "pages": [],
            "dropped": list(dropped),
        },
    )


def test_a_document_never_filed_is_queued_once_however_often_it_is_asked(tmp_path):
    """Import already queued it, and the marker is unique: the catch-up adds no second row."""
    _settings, storage, _project = seeded(tmp_path)
    assert enqueue_account(storage, "reader", verbose=False) == 1
    assert enqueue_account(storage, "reader", verbose=False) == 1
    jobs = storage.list_memory_jobs("reader")
    assert [(job["kind"], job["marker"]) for job in jobs] == [("document", "paper:one")]
    assert jobs[0]["payload"]["targetVersion"] == MEMORY_VERSION


def test_a_filed_document_is_skipped_and_force_takes_the_ones_that_are_behind(tmp_path, capsys):
    """
    The skip test is the document's own event, so an interrupted run can be
    started again. A new job for a filed document files it a second time:
    nothing but this check stands in front of that.
    """
    _settings, storage, _project = seeded(tmp_path)
    storage.clear_memory_job("reader", "paper:one")
    assert [item["why"] for item in owed_documents(storage, "reader")] == ["unfiled"]
    file_event(storage, "knowledge-v1")
    # Filed by a pass Delphi has replaced: work under --force, skipped without.
    assert enqueue_account(storage, "reader", verbose=False) == 0
    assert storage.list_memory_jobs("reader") == []
    assert enqueue_account(storage, "reader", verbose=True, force=True) == 1
    assert f"(filed by knowledge-v1, now {MEMORY_VERSION})" in capsys.readouterr().out
    storage.clear_memory_job("reader", "paper:one")

    # Current and whole: not even --force files it again.
    file_event(storage, MEMORY_VERSION)
    assert enqueue_account(storage, "reader", verbose=False, force=True) == 0

    # Current, and its last job could not write a page it staged.
    file_event(storage, MEMORY_VERSION, dropped=[
        {"slug": "attention", "title": "Attention", "action": "create", "reason": "unsupported", "quote": "q"}
    ])
    assert enqueue_account(storage, "reader", verbose=False) == 0
    assert enqueue_account(storage, "reader", verbose=True, force=True) == 1
    assert "(its last job dropped Attention)" in capsys.readouterr().out


def test_a_job_that_gave_up_is_revived_for_a_document_still_owed(tmp_path):
    _settings, storage, _project = seeded(tmp_path)
    job = storage.claim_memory_job("reader", now="2026-10-13T00:00:00+00:00", lease_expires_at="2026-10-13T00:05:00+00:00", max_attempts=3)
    storage.fail_memory_job("reader", job["id"], error="gave up", retry_at=None)
    assert enqueue_account(storage, "reader", verbose=False) == 1
    (revived,) = storage.list_memory_jobs("reader")
    assert (revived["status"], revived["attempts"]) == ("pending", 0)


def test_a_dry_run_counts_the_work_and_queues_none_of_it(tmp_path):
    """`add_paper` queues its own job, so the queue is never empty here. A dry run must not add to it."""
    _settings, storage, project = seeded(tmp_path)
    before = [job["id"] for job in storage.list_memory_jobs("reader")]
    storage.add_paper(
        "reader",
        project["id"],
        {"id": "two", "title": "Another", "filename": "two.pdf", "pages": 2},
    )
    storage.clear_memory_job("reader", "paper:two")
    assert enqueue_account(storage, "reader", verbose=False, dry_run=True) == 2
    assert [job["id"] for job in storage.list_memory_jobs("reader")] == before


def run_command(monkeypatch, settings, storage, *flags) -> int:
    """`python -m delphi_core.backfill.memory` with these flags, over these stores."""
    monkeypatch.setattr(catch_up, "open_stores", lambda: (settings, storage, LocalObjectStore(settings.data_dir)))
    monkeypatch.setattr(sys, "argv", ["memory", "--quiet", *flags])
    return catch_up.main()


def test_the_backfill_command_reports_a_dry_run_and_a_queue(tmp_path, monkeypatch, capsys):
    """The operator reads one line of what the command did, naming the pass the work is for."""
    settings, storage, _project = seeded(tmp_path)
    storage.clear_memory_job("reader", "paper:one")

    assert run_command(monkeypatch, settings, storage, "--dry-run") == 0
    assert f"\n1 documents to file at {MEMORY_VERSION} (never filed)\n" in capsys.readouterr().out
    assert storage.list_memory_jobs("reader") == []

    assert run_command(monkeypatch, settings, storage) == 0
    assert (
        f"\n1 documents queued for {MEMORY_VERSION} (never filed); readers' own tabs will drain them\n"
        in capsys.readouterr().out
    )
    assert [job["marker"] for job in storage.list_memory_jobs("reader")] == ["paper:one"]


def test_the_backfill_command_does_nothing_where_memory_is_turned_off(tmp_path, monkeypatch, capsys):
    """The operator's switch is read before anything is queued, and the command says why it stopped."""
    settings, storage, _project = seeded(tmp_path, memory_enabled=False)
    storage.clear_memory_job("reader", "paper:one")

    assert run_command(monkeypatch, settings, storage) == 2
    assert "turned off" in capsys.readouterr().err
    assert storage.list_memory_jobs("reader") == []


@pytest.mark.asyncio
async def test_the_catch_up_files_a_library_and_says_what_happened_to_each_document(tmp_path, monkeypatch, capsys):
    """Enqueue, drain, report: one `document` job per document, through every real stage."""
    rig = Rig(tmp_path, monkeypatch, memory_drain_workers=1)
    rig.pdf("aaaaaaaaaaa1", "Cache paper")
    rig.pdf("aaaaaaaaaaa2", "Shared Idea Study k3x9 A")
    rig.pdf("aaaaaaaaaaa3", "Shared Idea Study k3x9 B")
    rig.pdf("aaaaaaaaaaa4", "Disputed Claim Study one")
    rig.refuse("aaaaaaaaaaa5", "Refused Study")

    assert enqueue_account(rig.storage, "reader", verbose=False) == 5
    assert len(rig.jobs()) == 5
    runs = await drain_account(rig.storage, rig.objects, rig.settings, "reader", verbose=True, total=5)

    filed = {run["title"]: run for run in runs if run["kind"] == "document"}
    assert {title: run["outcome"] for title, run in filed.items()} == {
        "Cache paper": "filed", "Shared Idea Study k3x9 A": "filed", "Shared Idea Study k3x9 B": "filed",
        "Disputed Claim Study one": "filed", "Refused Study": "failed",
    }
    # The second document of a series edits the page the first created.
    assert (filed["Shared Idea Study k3x9 A"]["created"], filed["Shared Idea Study k3x9 A"]["edited"]) == (1, 0)
    assert (filed["Shared Idea Study k3x9 B"]["created"], filed["Shared Idea Study k3x9 B"]["edited"]) == (0, 1)
    assert filed["Shared Idea Study k3x9 B"]["pages"] == ["shared-idea-k3x9"]
    # A page the checker blocked once was repaired, and nothing was dropped.
    assert filed["Disputed Claim Study one"]["dropped"] == []
    refused = filed["Refused Study"]
    assert [(target["slug"], target["action"]) for target in refused["dropped"]] == [("prefix-reuse-aaaaaaaaaaa5", "create")]
    assert refused["retryAt"] and refused["attempts"] == 1
    # Each stage a pass announced was timed, the digest it had to build first included.
    assert {"digest_check", "memory_select", "memory_maintain", "memory_verify", "memory_commit"} <= set(refused["stages"])

    assert rig.pages("concept") == ["prefix-reuse-aaaaaaaaaaa1", "prefix-reuse-aaaaaaaaaaa4", "shared-idea-k3x9"]
    assert len(rig.pages("source")) == 5
    # The failed job waits for its retry; everything else left the queue.
    assert rig.jobs() == [("document", "paper:aaaaaaaaaaa5", "failed")]
    assert rig.asked("research_digest") == 5

    said = capsys.readouterr()
    assert "paper:aaaaaaaaaaa3 Shared Idea Study k3x9 B: filed (0 created, 1 edited)" in said.out
    assert "paper:aaaaaaaaaaa5 Refused Study: failed, attempt 1, due again at" in said.err
    assert "dropped: Prefix reuse aaaaaaaaaaa5 (create): The document reports one comparison" in said.err
    assert tally(runs).splitlines()[:2] == [
        "document jobs: 4 filed · 0 nothing · 1 failed",
        "pages: 3 created · 1 edited · 1 targets dropped",
    ]

    summary = filing_summary(rig.events())
    assert summary["jobs"] == {"filed": 4, "nothing": 0, "failed": 1}
    assert summary["documents"] == {"filed": 4, "nothing": 0, "failed": 1, "sourcePageOnly": 1}
    assert summary["pages"] == {"created": 3, "edited": 1}
    assert [(target["paperId"], target["slug"], target["outstanding"]) for target in summary["dropped"]] == [
        ("aaaaaaaaaaa5", "prefix-reuse-aaaaaaaaaaa5", True)]
    telemetry = summary["telemetry"]
    assert [telemetry[stage]["jobs"] for stage in ("select", "maintain", "verify")] == [5, 5, 5]
    assert all(telemetry[stage]["inputTokens"] > 0 and telemetry[stage]["outputTokens"] > 0 for stage in ("select", "maintain", "verify"))
    assert telemetry["rounds"] >= 10 and telemetry["ended"] == {"completed": 5}

    # Started again, the run pays only for what is still owed: the four filed
    # documents are skipped by their events, and the one that failed is tried
    # again now, from the digest it already has.
    assert [item["paperId"] for item in owed_documents(rig.storage, "reader", force=True)] == ["aaaaaaaaaaa5"]
    assert enqueue_account(rig.storage, "reader", verbose=False, force=True) == 1
    again = await drain_account(rig.storage, rig.objects, rig.settings, "reader", verbose=False)
    assert [(run["marker"], run["outcome"]) for run in again] == [("paper:aaaaaaaaaaa5", "failed")]
    assert rig.asked("research_digest") == 5 and rig.asked("memory_file_selection") == 5 + 4 + 2


@pytest.mark.asyncio
async def test_a_job_whose_record_changed_while_it_ran_stays_queued_and_is_run_again(tmp_path, monkeypatch):
    """The job is completed against the fingerprint its pass read, as the drain route completes it."""
    settings, storage, project = seeded(tmp_path, memory_drain_workers=1)
    read: list[str] = []

    async def passes(job, **_kw):
        read.append(job["payload"].get("fingerprint", ""))
        if len(read) == 1:
            # A digest republished during the work names what the next pass must read.
            storage.enqueue_memory_job(
                "reader", kind="document", marker=job["marker"],
                payload={"projectId": project["id"], "paperId": "one", "fingerprint": "second"},
            )
        yield {"type": "_memory_result", "pages": [], "reused": False, "outcome": "nothing",
               "fingerprint": "first" if len(read) == 1 else "second"}

    monkeypatch.setattr("delphi_core.backfill.memory.run_maintenance_job", passes)
    runs = await drain_account(storage, LocalObjectStore(tmp_path), settings, "reader", verbose=False)
    assert [run["outcome"] for run in runs] == ["requeued", "nothing"]
    assert read == ["", "second"] and storage.list_memory_jobs("reader") == []
    assert "kept in the queue" in describe_run(runs[0])


@pytest.mark.asyncio
async def test_a_failure_waits_out_the_backoff_and_a_page_that_moved_on_is_tried_again_at_once(tmp_path, monkeypatch):
    settings, storage, _project = seeded(tmp_path, memory_drain_workers=1, memory_job_max_attempts=3)
    attempts: list[int] = []

    async def moved_on(job, **_kw):
        attempts.append(job["attempts"])
        raise StaleRevision("position-encoding moved on")
        yield  # pragma: no cover

    monkeypatch.setattr("delphi_core.backfill.memory.run_maintenance_job", moved_on)
    runs = await drain_account(storage, LocalObjectStore(tmp_path), settings, "reader", verbose=False)
    # Given back with its attempt unspent while other jobs move Memory on, a few times in a
    # row; a job that keeps meeting them then fails like any other, due again at once,
    # until the ceiling: the third failure stays put.
    assert attempts == [1, 1, 1, 1, 2, 3]
    assert [run["outcome"] for run in runs] == ["moved-on"] * 3 + ["failed"] * 3
    assert runs[-1]["retryAt"] is None and "gave up" in describe_run(runs[-1])
    (job,) = storage.list_memory_jobs("reader")
    assert (job["status"], job["retryAt"]) == ("failed", None)

    async def broken(job, **_kw):
        raise RuntimeError("the provider said no")
        yield  # pragma: no cover

    storage.retry_memory_job("reader", job["id"])
    monkeypatch.setattr("delphi_core.backfill.memory.run_maintenance_job", broken)
    (run,) = await drain_account(storage, LocalObjectStore(tmp_path), settings, "reader", verbose=False)
    # Any other failure waits a minute, so the lane ends with the job still queued.
    assert run["outcome"] == "failed" and run["retryAt"] is not None
    assert storage.list_memory_jobs("reader")[0]["lastError"] == "the provider said no"


@pytest.mark.asyncio
async def test_a_job_withdrawn_while_it_runs_is_stood_down_at_the_next_stage(tmp_path, monkeypatch):
    settings, storage, _project = seeded(tmp_path, memory_drain_workers=1)
    reached: list[str] = []

    async def called_off(job, **_kw):
        yield {"type": "progress", "stage": "memory_gather", "message": "Reading"}
        storage.clear_memory_job("reader", job["marker"])
        yield {"type": "progress", "stage": "memory_select", "message": "Deciding"}
        reached.append("past the stage after the withdrawal")
        yield {"type": "_memory_result", "pages": [], "reused": False, "outcome": "nothing"}

    monkeypatch.setattr("delphi_core.backfill.memory.run_maintenance_job", called_off)
    (run,) = await drain_account(storage, LocalObjectStore(tmp_path), settings, "reader", verbose=False)
    assert run["outcome"] == "withdrawn" and reached == []


@pytest.mark.asyncio
async def test_a_drain_runs_its_lanes_at_once(tmp_path, monkeypatch):
    """
    A job is mostly waiting on a model, so what sets the wall clock of a whole
    library is how many of those waits overlap. Lanes are safe for the reason
    the browser's three-worker drain is safe: `claim_memory_job` hands each
    caller a distinct row.
    """
    settings = Settings(_env_file=None, data_dir=tmp_path, memory_drain_workers=3)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    project = storage.create_project("reader", "Reading")
    for index in range(6):
        storage.enqueue_memory_job(
            "reader",
            kind="document",
            marker=f"paper:p{index}",
            payload={"projectId": project["id"], "paperId": f"p{index}"},
        )

    live = 0
    peak = 0
    claimed: list[str] = []

    async def slow(job, **_kw):
        nonlocal live, peak
        live += 1
        peak = max(peak, live)
        claimed.append(job["marker"])
        await asyncio.sleep(0.05)
        live -= 1
        yield {"type": "_memory_result", "pages": [], "reused": False, "outcome": "nothing"}

    monkeypatch.setattr("delphi_core.backfill.memory.run_maintenance_job", slow)
    runs = await drain_account(
        storage, LocalObjectStore(tmp_path), settings, "reader",
        verbose=False, total=6,
    )

    assert [run["outcome"] for run in runs] == ["nothing"] * 6
    # Every job ran exactly once: no two lanes took the same row.
    assert sorted(claimed) == sorted(f"paper:p{i}" for i in range(6))
    assert peak > 1, "lanes did not overlap"
    assert peak <= 3, "a lane ceiling that does not hold is not a ceiling"


@pytest.mark.asyncio
async def test_one_lane_is_still_a_valid_drain(tmp_path, monkeypatch):
    """The ceiling is a setting, so a deployment can turn it back down."""
    settings, storage, _project = seeded(tmp_path, memory_drain_workers=1)

    async def once(job, **_kw):
        yield {"type": "_memory_result", "pages": [], "reused": True}

    monkeypatch.setattr("delphi_core.backfill.memory.run_maintenance_job", once)
    (run,) = await drain_account(storage, LocalObjectStore(tmp_path), settings, "reader", verbose=False)
    assert run["outcome"] == "reused" and storage.list_memory_jobs("reader") == []


def test_a_later_clean_job_settles_an_earlier_jobs_drop(tmp_path):
    """The summary counts every drop, and says which ones the document is still owed."""
    target = {"slug": "attention", "title": "Attention", "action": "edit", "reason": "unsupported", "quote": "q"}
    events = [
        {"kind": "document", "marker": "paper:one", "paperId": "one", "outcome": "failed", "pages": [],
         "dropped": [target], "createdAt": "2026-10-13T00:00:00Z"},
        {"kind": "document", "marker": "paper:one", "paperId": "one", "outcome": "filed", "pages": ["attention"],
         "edits": [{"slug": "attention", "action": "revised"}], "dropped": [], "createdAt": "2026-10-13T00:01:00Z",
         "advisory": {"count": 2, "objections": [{"finding": "differs"}, {"finding": "unsupported"}]},
         "telemetry": {"select": {"inputTokens": 10}, "maintain": {"input_tokens": 30, "cached_tokens": 5},
                       "verify": {}, "rounds": 2, "ended": "completed"}},
        {"kind": "domain", "marker": "domain:ml", "pages": ["ml"]},
    ]
    summary = filing_summary(events)
    assert summary["jobs"] == {"filed": 1, "nothing": 0, "failed": 1}
    assert summary["documents"] == {"filed": 1, "nothing": 0, "failed": 0, "sourcePageOnly": 0}
    assert summary["pages"] == {"created": 0, "edited": 1}
    assert [(item["slug"], item["reason"], item["outstanding"]) for item in summary["dropped"]] == [("attention", "unsupported", False)]
    assert summary["advisory"] == {"count": 2, "byFinding": {"differs": 1, "unsupported": 1}}
    # The stages spell their counts differently; the summary speaks one spelling.
    assert summary["telemetry"]["maintain"] == {"jobs": 1, "inputTokens": 30, "cacheReadTokens": 5}
    assert summary["telemetry"]["verify"] == {"jobs": 0}


@pytest.mark.asyncio
async def test_a_digest_backfill_followed_by_a_filing_backfill_files_each_document_once(tmp_path, monkeypatch):
    """
    Publishing a digest queues the document's job with the digest's
    fingerprint. The filing backfill finds that job under the same marker, the
    drain completes it against the fingerprint it read, and a republish that
    changed nothing queues nothing more.
    """
    from delphi_core.backfill.digests import rebuild_account
    from delphi_core.memory_maintenance.jobs import document_fingerprint
    from delphi_core.research_digest import load_digest

    rig = Rig(tmp_path, monkeypatch, memory_drain_workers=1)
    rig.pdf("aaaaaaaaaaa1", "Shared Idea Study k3x9 A")
    rig.pdf("aaaaaaaaaaa2", "Shared Idea Study k3x9 B")

    async def digests(force=False):
        return await rebuild_account(
            rig.storage, rig.objects, rig.settings, "reader", dry_run=False, force=force, verbose=False)

    def documents_queued():
        return [job for job in rig.storage.list_memory_jobs("reader") if job["kind"] == "document"]

    # The digest backfill builds both digests, derives both source pages, and
    # gives each document's one job the fingerprint of what it will read.
    assert await digests() == (2, 2, 0)
    assert len(rig.pages("source")) == 2 and rig.pages("concept") == []
    fingerprints = {
        f"paper:{paper_id}": document_fingerprint(load_digest(rig.objects, "reader", rig.project, paper_id))
        for paper_id in ("aaaaaaaaaaa1", "aaaaaaaaaaa2")}
    assert {job["marker"]: job["payload"]["fingerprint"] for job in documents_queued()} == fingerprints

    # The filing backfill adds no job to those, and files each document once.
    assert enqueue_account(rig.storage, "reader", verbose=False) == 2
    assert len(documents_queued()) == 2
    runs = await drain_account(rig.storage, rig.objects, rig.settings, "reader", verbose=False)
    assert [(run["marker"], run["outcome"]) for run in runs if run["kind"] == "document"] == [
        ("paper:aaaaaaaaaaa1", "filed"), ("paper:aaaaaaaaaaa2", "filed")]
    assert {event["marker"]: event["fingerprint"] for event in rig.events()} == fingerprints
    assert documents_queued() == [] and rig.asked("research_digest") == 2

    # Either backfill again: nothing is owed, and a digest rebuilt to the same
    # words is not new evidence, so no job is queued and no document refiled.
    assert await digests() == (0, 0, 0)
    assert await digests(force=True) == (2, 2, 0)
    assert rig.asked("research_digest") == 4 and documents_queued() == []
    assert enqueue_account(rig.storage, "reader", verbose=False, force=True) == 0
    assert [run for run in await drain_account(rig.storage, rig.objects, rig.settings, "reader", verbose=False)
            if run["kind"] == "document"] == []
    assert len(rig.events()) == 2
