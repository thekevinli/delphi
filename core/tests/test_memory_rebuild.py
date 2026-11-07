"""
Offline Memory candidates never mix with the live pages.

The staging tests run the rebuild end to end: a seeded library is cloned,
filed through the real pipeline with the journey rig's fixture as the provider
(`tests/rig_library.py`), reported on and promoted.
"""

import json

import pytest

from delphi_core.backfill.memory_rebuild import (
    _candidate_path,
    _candidate_stores,
    _clone_authority,
    _latest_candidate,
    _promote,
    _promote_digests,
    _refile_candidate,
    _rollback,
    _stage_or_resume,
    _write_dashboard,
    _write_manifest,
    build_inventory,
    build_parser,
    copy_evidence,
    describe_source_drift,
    summarize_pages,
)
from delphi_core.backfill.memory_eval import KEY_FORMAT
from delphi_core.config import Settings
from delphi_core.memory import MEMORY_VERSION
from delphi_core.storage import LocalObjectStore, LocalStorage, external_evidence_key, paper_key
from tests.rig_library import Rig


def clear_jobs(storage, username="reader"):
    for job in storage.list_memory_jobs(username):
        storage.clear_memory_job(username, job["marker"])


def seeded(tmp_path):
    settings = Settings(data_dir=tmp_path, memory_max_pages=1_000)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    project = storage.create_project("reader", "Reading")
    for paper_id in ("reactivated", "unfiled"):
        storage.add_paper(
            "reader",
            project["id"],
            {
                "id": paper_id,
                "title": paper_id.title(),
                "filename": f"{paper_id}.pdf",
                "createdAt": (
                    f"2026-01-0{1 if paper_id == 'reactivated' else 2}T00:00:00Z"
                ),
            },
        )
    for slug, title in (
        ("learning-integral-diffusion-model", "Learning integral diffusion model"),
        ("learning-the-integral-of-a-diffusion-model", "Learning the integral of a diffusion model"),
    ):
        storage.upsert_memory_page(
            "reader",
            {
                "slug": slug,
                "kind": "source",
                "domain": "learning",
                "title": title,
                "summary": "A duplicate source.",
                "body": "See [[missing-concept]].",
                "sourcePaperId": "reactivated",
                "sourceProjectId": project["id"],
            },
            max_pages=1_000,
        )
    return settings, storage, project


def test_the_dry_run_inventory_says_what_is_filed_and_fingerprints_only_the_source(tmp_path):
    settings, storage, project = seeded(tmp_path)
    report = build_inventory(storage, "reader", settings)

    assert report["documents"] == {"total": 2, "current": 0, "stale": 0, "unfiled": 2, "dropped": 0}
    assert [item["id"] for item in report["sourcePlan"]] == ["reactivated", "unfiled"]
    assert set(report["sourcePlan"][0]) == {"id", "projectId", "title", "createdAt", "filing"}
    assert report["duplicates"] == [
        {
            "paperId": "reactivated",
            "slugs": [
                "learning-integral-diffusion-model",
                "learning-the-integral-of-a-diffusion-model",
            ],
        }
    ]
    assert report["estimatedModelWork"]["documentJobs"] == 2
    assert len(report["sourceFingerprint"]) == 64
    assert report["readiness"]["readyToStage"] is True

    # A document filed live, by this pass or an older one, is reported and
    # leaves the fingerprint alone: the pages are what a rebuild replaces.
    for paper_id, version, dropped in (("reactivated", "knowledge-v1", []), ("unfiled", MEMORY_VERSION, [
        {"slug": "attention", "title": "Attention", "action": "edit", "reason": "unsupported", "quote": "q"}])):
        storage.append_memory_event("reader", {
            "kind": "document", "version": version, "requestId": f"paper:{paper_id}", "marker": f"paper:{paper_id}",
            "outcome": "filed", "pages": [], "dropped": dropped})
    later = build_inventory(storage, "reader", settings)
    assert later["documents"] == {"total": 2, "current": 1, "stale": 1, "unfiled": 0, "dropped": 1}
    assert later["sourceFingerprint"] == report["sourceFingerprint"]

    # A note the reader wrote is part of what a candidate is built from.
    stroke = storage.add_highlight("reader", project["id"], "unfiled", {"type": "pdf", "page": 1, "text": "a line"})
    storage.add_note("reader", project["id"], "unfiled", {
        "highlightId": stroke["id"], "page": 1, "anchorY": 0.2, "quotedText": "a line", "body": "Why?"})
    assert build_inventory(storage, "reader", settings)["sourceFingerprint"] != report["sourceFingerprint"]


def _ready_candidate(settings, storage, project):
    inventory = build_inventory(storage, "reader", settings)
    candidate_id = "candidate-test"
    path = _candidate_path(settings, "reader", candidate_id)
    candidate_settings, candidate, _ = _candidate_stores(settings, path)
    candidate.create_account("reader", None, "salt", "hash")
    # `_clone_authority` copies the library before it files anything, and
    # `_promote` reads it back for the digests, so the fixture has to have one.
    staged_project = candidate.create_project("reader", "Staged")["id"]
    for paper_id in ("reactivated", "unfiled"):
        candidate.add_paper(
            "reader",
            staged_project,
            {"id": paper_id, "title": paper_id.title(), "filename": f"{paper_id}.pdf"},
        )
    for paper_id in ("reactivated", "unfiled"):
        candidate.upsert_memory_page(
            "reader",
            {
                "slug": f"canonical-{paper_id}",
                "kind": "source",
                "domain": "learning",
                "title": f"Canonical {paper_id}",
                "summary": "Freshly rebuilt.",
                "body": "A self-contained source page.",
                "sourcePaperId": paper_id,
                "sourceProjectId": staged_project,
            },
            max_pages=1_000,
        )
    clear_jobs(candidate)
    manifest = {
        "candidate": candidate_id,
        "user": "reader",
        "status": "ready",
        "createdAt": "2026-09-02T12:00:00Z",
        "sourceFingerprint": inventory["sourceFingerprint"],
        "sourceRevision": inventory["activeRevision"],
        "sourcePlan": inventory["sourcePlan"],
        "projectMap": {project["id"]: staged_project},
    }
    _write_manifest(path, manifest)
    return candidate_id, candidate_settings


def test_ready_candidate_promotes_without_touching_authority_and_rolls_back(tmp_path):
    settings, storage, project = seeded(tmp_path)
    candidate_id, _ = _ready_candidate(settings, storage, project)
    objects = LocalObjectStore(tmp_path)

    _promote(storage, objects, settings, "reader", candidate_id)

    assert {page["slug"] for page in storage.list_memory_pages("reader")} == {
        "canonical-reactivated",
        "canonical-unfiled",
    }
    rebuilt = storage.get_memory_page("reader", "canonical-reactivated")
    assert rebuilt["sourcePaperId"] == "reactivated" and "sourceProjectId" not in rebuilt
    assert {paper["id"] for paper in storage.get_project("reader", project["id"])["papers"]} == {
        "reactivated",
        "unfiled",
    }

    _rollback(storage, settings, "reader")

    assert {page["slug"] for page in storage.list_memory_pages("reader")} == {
        "learning-integral-diffusion-model",
        "learning-the-integral-of-a-diffusion-model",
    }


def test_a_rollback_refuses_once_memory_has_moved_on_since_the_promotion(tmp_path):
    """A page written after the promotion would be lost to the snapshot, so the rollback refuses and keeps it."""
    settings, storage, project = seeded(tmp_path)
    candidate_id, _ = _ready_candidate(settings, storage, project)
    _promote(storage, LocalObjectStore(tmp_path), settings, "reader", candidate_id)
    storage.upsert_memory_page(
        "reader",
        {"kind": "concept", "domain": "learning", "title": "Written since", "summary": "s", "body": "Body."},
        max_pages=1_000,
    )

    with pytest.raises(ValueError, match="changed after promotion"):
        _rollback(storage, settings, "reader")

    assert {page["slug"] for page in storage.list_memory_pages("reader")} == {
        "canonical-reactivated", "canonical-unfiled", "written-since",
    }


def test_promotion_refuses_a_changed_source_authority(tmp_path):
    settings, storage, project = seeded(tmp_path)
    candidate_id, _ = _ready_candidate(settings, storage, project)
    storage.add_paper(
        "reader",
        project["id"],
        {"id": "later", "title": "Later", "filename": "later.pdf"},
    )

    with pytest.raises(ValueError, match="Source authority changed"):
        _promote(
            storage,
            LocalObjectStore(tmp_path),
            settings,
            "reader",
            candidate_id,
        )

    assert {page["slug"] for page in storage.list_memory_pages("reader")} == {
        "learning-integral-diffusion-model",
        "learning-the-integral-of-a-diffusion-model",
    }


def test_a_wiki_that_moved_under_a_long_staging_run_still_promotes(tmp_path):
    """The wiki is what this replaces, so the wiki changing is not a hazard.

    `activeRevision` used to be half the refusal, and it moves on every
    Memory write — the maintenance pump drains on focus and every five
    minutes in any open tab, so over a staging run measured in hours the guard
    was never going to pass, for a reason that was never a risk.
    """
    settings, storage, project = seeded(tmp_path)
    candidate_id, _ = _ready_candidate(settings, storage, project)
    before = storage.memory_graph_revision("reader")
    storage.upsert_memory_page(
        "reader",
        {
            "slug": "filed-while-staging",
            "kind": "concept",
            "domain": "learning",
            "title": "Filed while staging",
            "summary": "A pass that drained in another tab.",
            "body": "Ordinary work.",
        },
        max_pages=1_000,
    )
    assert storage.memory_graph_revision("reader") != before

    _promote(storage, LocalObjectStore(tmp_path), settings, "reader", candidate_id)

    assert {page["slug"] for page in storage.list_memory_pages("reader")} == {
        "canonical-reactivated",
        "canonical-unfiled",
    }


def test_accepting_drift_names_what_the_candidate_was_built_without(tmp_path):
    settings, storage, project = seeded(tmp_path)
    candidate_id, _ = _ready_candidate(settings, storage, project)
    storage.add_paper(
        "reader",
        project["id"],
        {"id": "later", "title": "Later", "filename": "later.pdf"},
    )

    # Refusing is still the default, and it says which document by name rather
    # than that a hash moved — an operator cannot weigh "the fingerprint
    # changed", but can weigh "you added Later this morning".
    with pytest.raises(ValueError, match="document added since staging: Later"):
        _promote(
            storage, LocalObjectStore(tmp_path), settings, "reader", candidate_id
        )

    _promote(
        storage,
        LocalObjectStore(tmp_path),
        settings,
        "reader",
        candidate_id,
        accept_drift=True,
    )

    assert {page["slug"] for page in storage.list_memory_pages("reader")} == {
        "canonical-reactivated",
        "canonical-unfiled",
    }
    # What was knowingly left out is on the record, beside the rollback that
    # can put it back.
    manifest = json.loads(
        (_candidate_path(settings, "reader", candidate_id) / "manifest.json").read_text()
    )
    assert manifest["acceptedDrift"] == ["document added since staging: Later"]


def test_drift_falls_back_to_a_sentence_when_no_document_moved(tmp_path):
    """A note or a domain has no label worth printing one by one."""
    assert describe_source_drift({"sourcePlan": []}, {"sourcePlan": []}) == [
        "a reader note or a domain the reader made changed since staging; "
        "the candidate was built without it"
    ]
    plan = [{"id": "p", "title": "Old title", "projectId": "a"}]
    assert describe_source_drift({"sourcePlan": [{"id": "p", "title": "New title", "projectId": "a"}]}, {"sourcePlan": plan}) == [
        "document renamed or moved since staging: New title"
    ]


def test_the_report_carries_real_bodies_and_not_only_counts(tmp_path):
    """Counts alone cannot build confidence before replacing a wiki.

    "184 pages" reads the same whether they teach anything or not, so the
    report has to carry the census *and* a bounded sample of what was actually
    written, chosen by link degree — the pages a reader meets first.
    """
    settings, storage, _ = seeded(tmp_path)

    summary = summarize_pages(storage, "reader", settings)

    assert summary["kinds"]["source"] == 2
    assert [row["slug"] for row in summary["domains"]] == ["learning"]
    assert summary["domains"][0]["kinds"] == {"source": 2}
    sources = summary["samples"]["source"]
    assert {row["slug"] for row in sources} == set(summary["slugs"])
    assert set(summary["samples"]) == {"concept", "source", "domain"}
    # A body, not just its length: this is the thing an operator reads.
    assert all("See [[missing-concept]]" in row["excerpt"] for row in sources)
    assert all(row["bodyCharacters"] > 0 for row in sources)
    # Bounded, because a report nobody can scroll is a report nobody reads.
    assert all(len(row["excerpt"]) <= 900 for row in sources)
    assert all(len(row["summary"]) <= 400 for row in sources)


def test_a_candidate_files_its_documents_in_the_order_they_were_added_whatever_their_projects(tmp_path):
    """A paper that corrects an earlier one must meet the earlier one's pages, as it did in the library.

    The clone walks projects in their own order and `add_paper` queues a job as
    it goes; the queue claims the oldest row first. So without the reorder the
    first project's newest paper was filed before the second project's oldest.
    """
    settings = Settings(data_dir=tmp_path, memory_max_pages=1_000)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    for name, papers in (("Made first", ("newest", "middle")), ("Made second", ("oldest",))):
        project = storage.create_project("reader", name)
        for paper_id in papers:
            created = {"oldest": "2026-01-01", "middle": "2026-02-01", "newest": "2026-03-01"}[paper_id]
            storage.add_paper("reader", project["id"], {
                "id": paper_id, "title": paper_id.title(), "filename": f"{paper_id}.pdf", "createdAt": f"{created}T00:00:00Z"})
    inventory = build_inventory(storage, "reader", settings)
    assert [item["id"] for item in inventory["sourcePlan"]] == ["oldest", "middle", "newest"]
    path = _candidate_path(settings, "reader", "candidate-order")
    _, candidate, candidate_objects = _candidate_stores(settings, path)
    _clone_authority(storage, LocalObjectStore(tmp_path), candidate, candidate_objects, "reader", inventory)

    claimed = []
    while (job := candidate.claim_memory_job(
        "reader", now="2100-01-01T00:00:00+00:00", lease_expires_at="2100-01-01T01:00:00+00:00", max_attempts=3,
    )) is not None and job["kind"] == "document":
        claimed.append(job["marker"])
    assert claimed == ["paper:oldest", "paper:middle", "paper:newest"]


def test_a_staged_rebuild_keeps_the_domains_the_reader_named(tmp_path):
    """
    A domain the reader made is theirs, with its name and summary, and comes
    with the library. One the model named is the filing's to make again, so it
    stays behind.
    """
    settings, storage, _project = seeded(tmp_path)
    storage.upsert_memory_domain(
        "reader", {"slug": "serving", "title": "Efficiency & serving", "summary": "Cheap to run.", "origin": "reader"}
    )
    assert {domain["slug"]: domain["origin"] for domain in storage.memory_domains("reader")} == {
        "serving": "reader", "learning": "model",
    }
    inventory = build_inventory(storage, "reader", settings)
    path = _candidate_path(settings, "reader", "candidate-domains")
    _, candidate, candidate_objects = _candidate_stores(settings, path)

    _clone_authority(storage, LocalObjectStore(tmp_path), candidate, candidate_objects, "reader", inventory)

    assert [
        (domain["slug"], domain["title"], domain["summary"], domain["origin"])
        for domain in candidate.memory_domains("reader")
    ] == [("serving", "Efficiency & serving", "Cheap to run.", "reader")]


def test_the_reports_sample_counts_a_pages_citations_not_the_listings(tmp_path):
    """The page listing carries no citations, so a sample counted from it said 0 for every page."""
    settings, storage, project = seeded(tmp_path)
    storage.upsert_memory_page("reader", {
        "slug": "cited-idea", "kind": "concept", "domain": "learning", "title": "Cited idea",
        "summary": "One cited claim.", "body": "A claim from the paper. [E1]",
        "citations": [{"id": 1, "claimType": "author-claim", "paperId": "reactivated", "page": 1}],
    }, max_pages=1_000)
    [row] = summarize_pages(storage, "reader", settings)["samples"]["concept"]
    assert row["slug"] == "cited-idea" and row["citations"] == 1


def manifest_project(path) -> str:
    """The staged project id a cloned paper's objects are filed under."""
    manifest = json.loads((path / "manifest.json").read_text())
    return next(iter(manifest["projectMap"].values()))


def test_refiling_a_candidate_keeps_the_expensive_half(tmp_path):
    """An authoring fix must not cost the digests it did not change.

    `--resume` keeps the stale pages and `--discard` throws away the cloned
    bytes and the digests with them; neither is what a changed pass needs.
    """
    settings, storage, project = seeded(tmp_path)
    candidate_id, candidate_settings = _ready_candidate(settings, storage, project)
    path = _candidate_path(settings, "reader", candidate_id)
    _, candidate, candidate_objects = _candidate_stores(settings, path)
    candidate.upsert_memory_domain(
        "reader", {"slug": "reader-domain", "title": "Mine", "origin": "reader"}
    )
    manifest = json.loads((path / "manifest.json").read_text())
    digest_key = paper_key(
        "reader", manifest_project(path), "reactivated", "digest"
    )
    candidate_objects.put_text(digest_key, "expensive")
    clear_jobs(candidate)
    _refile_candidate(candidate, candidate_settings, "reader", manifest)

    # The pass's own output is gone, so it will be written again.
    assert candidate.list_memory_pages("reader") == []
    assert candidate.list_memory_events("reader", limit=10) == []
    # Every document is queued once more, at the version being filed for.
    jobs = candidate.list_memory_jobs("reader")
    assert sorted(job["marker"] for job in jobs) == [
        "paper:reactivated",
        "paper:unfiled",
    ]
    assert {job["kind"] for job in jobs} == {"document"}
    # The reader's own domain is not the pass's to re-derive.
    assert [d["slug"] for d in candidate.memory_domains("reader")] == ["reader-domain"]
    # And the expensive half is untouched.
    assert candidate_objects.exists(digest_key)


def test_promotion_carries_the_rebuilt_digests(tmp_path):
    """The larger half of what a staging run buys must survive promotion.

    A digest is minutes of model time and is keyed on the document rather than
    on the pass that reads it. Promoting pages alone would leave production
    serving digests the new pages were not written from, and would make the
    next rebuild pay for all of them again.
    """
    from delphi_core.research_digest import RESEARCH_DIGEST_VERSION

    settings, storage, project = seeded(tmp_path)
    candidate_id, candidate_settings = _ready_candidate(settings, storage, project)
    path = _candidate_path(settings, "reader", candidate_id)
    _, candidate, candidate_objects = _candidate_stores(settings, path)
    manifest = json.loads((path / "manifest.json").read_text())
    staged = manifest["projectMap"][project["id"]]

    claim = candidate.claim_digest(
        "reader", staged, "reactivated",
        claim_id="claim-1", expires_at="2099-01-01T00:00:00Z",
        metadata={"status": "pending", "version": RESEARCH_DIGEST_VERSION},
        force=True,
    )
    assert claim == "claimed"
    candidate.complete_digest(
        "reader", staged, "reactivated", "claim-1",
        {"status": "ready", "version": RESEARCH_DIGEST_VERSION},
    )
    key = paper_key("reader", staged, "reactivated", "digest")
    candidate_objects.put_text(key, '{"digest": "rebuilt"}')

    promoted = _promote_digests(
        storage, LocalObjectStore(tmp_path), candidate, candidate_objects,
        "reader", manifest,
    )

    assert promoted == ["reactivated"]
    live = next(
        paper
        for paper in storage.get_project("reader", project["id"])["papers"]
        if paper["id"] == "reactivated"
    )
    assert live["digest"]["version"] == RESEARCH_DIGEST_VERSION
    assert live["digest"]["status"] == "ready"
    # Bytes before the record: the object the paper now points at exists.
    assert LocalObjectStore(tmp_path).exists(
        paper_key("reader", project["id"], "reactivated", "digest")
    )


def test_a_staged_candidate_carries_the_digests_figure_bytes(tmp_path):
    """A source page with no pictures is a digest copied without its assets.

    A document's `source` page *is* its research digest (§36f) and the digest's
    assets become that page's figure rows, so a candidate holding the envelope
    alone files every source page empty -- 47 of them, in the run that found
    this. `SOURCE_OBJECT_SUFFIXES` cannot name an asset, because its key
    carries an id minted per figure, and `move_paper` already
    reads the ids out of the digest for exactly that reason.

    The way it hid is the reason this test exists rather than a comment: an
    account whose digests are stale has them *regenerated* inside the
    candidate, which mints the assets locally and looks perfect. Only an
    account whose digests are all current -- the good case -- merely copies
    them, and only there does the gap appear.
    """
    from delphi_core.backfill.memory_rebuild import _copy_digest_assets
    from delphi_core.research_digest import digest_asset_key

    settings = Settings(data_dir=tmp_path)
    objects = LocalObjectStore(tmp_path)
    asset_id = "0123456789abcdef01234567"
    objects.put_text(
        paper_key("reader", "proj-live", "paper-a", "digest"),
        json.dumps(
            {
                "version": "research-digest-v7",
                "digest": {
                    "contentMarkdown": "The digest, filed verbatim. [E1]",
                    "assets": [
                        {
                            "id": asset_id,
                            "kind": "source-figure",
                            "mimeType": "image/webp",
                            "caption": "Figure 1.",
                        }
                    ],
                },
            }
        ),
    )
    objects.put_text(
        digest_asset_key("reader", "proj-live", "paper-a", asset_id, "image/webp"),
        "not really webp, but bytes under the right key",
    )

    copied = _copy_digest_assets(
        objects,
        objects,
        username="reader",
        project_id="proj-live",
        staged_project_id="proj-staged",
        paper_id="paper-a",
    )

    assert copied == 1
    # Under the *staged* project id, which is what the candidate reads.
    assert objects.exists(
        digest_asset_key("reader", "proj-staged", "paper-a", asset_id, "image/webp")
    )
    # And a paper with no digest at all is not an error.
    assert (
        _copy_digest_assets(
            objects,
            objects,
            username="reader",
            project_id="proj-live",
            staged_project_id="proj-staged",
            paper_id="paper-with-no-digest",
        )
        == 0
    )


# Staging, end to end.

CAPTURE = {
    "id": "cap000000000000000000001", "url": "https://example.org/survey", "title": "A survey", "contentHash": "h",
    "findings": [{"claim": "Same scheme.", "quote": "the same scheme", "anchor": "findings", "bearsOn": "lineage"}],
}


def capture(storage, objects, username="reader"):
    """One captured outside source, stored as a capture is: its sections as an object, then its record."""
    objects.put_text(external_evidence_key(username, CAPTURE["id"]), json.dumps({"sections": []}))
    return storage.put_external_evidence(username, CAPTURE)


def answer_key(tmp_path):
    path = tmp_path / "key.json"
    path.write_text(json.dumps({
        "format": KEY_FORMAT, "reviewed": True, "reviewedBy": "a test",
        "documents": [{"key": "a", "id": "aaaaaaaaaaa2"}, {"key": "b", "id": "aaaaaaaaaaa3"}],
        "concepts": [
            {"id": "shared-idea", "title": "Shared idea k3x9", "aliases": [], "documents": ["a", "b"]},
            {"id": "eviction", "title": "Cache eviction", "aliases": []},
        ],
    }))
    return str(path)


def library(tmp_path, monkeypatch):
    rig = Rig(tmp_path, monkeypatch, memory_drain_workers=1, memory_max_pages=1_000)
    rig.pdf("aaaaaaaaaaa1", "Cache paper")
    rig.pdf("aaaaaaaaaaa2", "Shared Idea Study k3x9 A")
    rig.pdf("aaaaaaaaaaa3", "Shared Idea Study k3x9 B")
    return rig


def staged(rig):
    path, manifest = _latest_candidate(rig.settings, "reader")
    _, candidate, candidate_objects = _candidate_stores(rig.settings, path)
    return path, manifest, candidate, candidate_objects


@pytest.mark.asyncio
async def test_a_library_is_staged_through_the_pipeline_reported_resumed_and_promoted(tmp_path, monkeypatch):
    rig = library(tmp_path, monkeypatch)
    rig.refuse("aaaaaaaaaaa4", "Refused Study")
    key = answer_key(tmp_path)

    report = await _stage_or_resume(
        rig.storage, rig.objects, rig.settings, "reader", resume=False, verbose=False, keys=[key])

    # One `document` job per document ran in the candidate; the live account was not touched.
    path, manifest, candidate, _ = staged(rig)
    assert rig.pages("concept") == [] and rig.events() == []
    assert rig.pages("concept", storage=candidate) == ["prefix-reuse-aaaaaaaaaaa1", "shared-idea-k3x9"]
    assert len(rig.pages("source", storage=candidate)) == 4
    assert [event["marker"] for event in rig.events(storage=candidate)] == [
        f"paper:aaaaaaaaaaa{n}" for n in (1, 2, 3, 4)]

    filing = report["filing"]
    assert filing["jobs"] == {"filed": 3, "nothing": 0, "failed": 1}
    assert filing["documents"] == {"filed": 3, "nothing": 0, "failed": 1, "sourcePageOnly": 1}
    assert filing["pages"] == {"created": 2, "edited": 1}
    assert [(item["paperId"], item["slug"], item["action"], item["outstanding"]) for item in filing["dropped"]] == [
        ("aaaaaaaaaaa4", "prefix-reuse-aaaaaaaaaaa4", "create", True)]
    assert filing["dropped"][0]["reason"].startswith("The document reports one comparison")
    assert filing["advisory"] == {"count": 0, "byFinding": {}}
    assert [filing["telemetry"][stage]["jobs"] for stage in ("select", "maintain", "verify")] == [4, 4, 4]
    assert filing["telemetry"]["maintain"]["outputTokens"] > 0 and filing["telemetry"]["rounds"] >= 8
    assert report["documents"] == {"total": 4, "current": 3, "stale": 0, "unfiled": 1, "dropped": 1}

    # The failed job waits in the candidate's queue, and that blocks promotion.
    assert report["status"] == "blocked" and report["readiness"]["blockers"] == ["1 maintenance jobs remain"]
    assert [(job["marker"], job["status"]) for job in report["remainingJobs"]] == [("paper:aaaaaaaaaaa4", "failed")]
    assert manifest["status"] == "blocked"
    # What each job of the run cost in time, by stage, is kept beside the report.
    assert {run["marker"]: run["outcome"] for run in manifest["lastDrain"] if run["kind"] == "document"} == {
        "paper:aaaaaaaaaaa1": "filed", "paper:aaaaaaaaaaa2": "filed", "paper:aaaaaaaaaaa3": "filed",
        "paper:aaaaaaaaaaa4": "failed"}
    assert all("memory_maintain" in run["stages"] for run in manifest["lastDrain"] if run["kind"] == "document")

    # The quality section is memory_eval's, scored against the key.
    quality = report["quality"]
    assert quality["arm"] == "new" and quality["keysReviewed"] is True
    assert quality["metrics"]["inventory"]["present"] == ["shared-idea"]
    assert quality["metrics"]["inventory"]["missing"] == ["eviction"]
    gates = {gate["label"]: gate["status"] for gate in quality["gates"]}
    assert gates["duplicate violations: zero"] == "pass" and gates["every citation resolves"] == "pass"
    assert {row["metric"] for row in quality["needsJudge"]} >= {"gold-claim recall", "supported-claim rate"}
    with pytest.raises(ValueError, match="Only a ready candidate"):
        _promote(rig.storage, rig.objects, rig.settings, "reader", manifest["candidate"])

    # Resumed once the checker lets the page through: the failed job is tried
    # again, and only that job. No digest is built twice.
    rig._refused.clear()
    digests = rig.asked("research_digest")
    report = await _stage_or_resume(rig.storage, rig.objects, rig.settings, "reader", resume=True, verbose=False)
    assert report["status"] == "ready" and "quality" not in report
    assert rig.asked("research_digest") == digests == 4
    filing = report["filing"]
    assert filing["jobs"] == {"filed": 4, "nothing": 0, "failed": 1}
    assert filing["documents"] == {"filed": 4, "nothing": 0, "failed": 0, "sourcePageOnly": 0}
    # The drop is still on the record, and a later job of the document settled it.
    assert [item["outstanding"] for item in filing["dropped"]] == [False]

    html = tmp_path / "report.html"
    _write_dashboard(html, {"active": build_inventory(rig.storage, "reader", rig.settings), "candidate": report, "change": None})
    assert "What the jobs did" in html.read_text() and "prefix-reuse-aaaaaaaaaaa4" in html.read_text()

    _promote(rig.storage, rig.objects, rig.settings, "reader", manifest["candidate"])
    assert rig.pages("concept") == [
        "prefix-reuse-aaaaaaaaaaa1", "prefix-reuse-aaaaaaaaaaa4", "shared-idea-k3x9"]
    page = rig.storage.get_memory_page("reader", "shared-idea-k3x9")
    assert "sourceProjectId" not in page and len(page["citations"]) == 2
    # The digests the candidate built came across with the pages written from them.
    assert sorted(_latest_candidate(rig.settings, "reader")[1]["promotedDigests"]) == [
        f"aaaaaaaaaaa{n}" for n in (1, 2, 3, 4)]


@pytest.mark.asyncio
async def test_a_rebuild_files_the_chats_beside_a_document_from_their_first_turn_in_the_candidate_only(tmp_path, monkeypatch):
    from tests.chat_keys import chat_key

    rig = library(tmp_path, monkeypatch)
    paper = "aaaaaaaaaaa1"
    key = chat_key(rig.storage, "reader", rig.project, f"paper-{paper}")
    for request_id, question in (("request_one001", "Worth keeping: does the prefix survive?"), ("request_two002", "Thanks.")):
        rig.storage.append_message("reader", rig.project, key, {"role": "user", "content": question, "requestId": request_id})
        rig.storage.append_message("reader", rig.project, key, {"role": "assistant", "content": "It does.", "requestId": request_id})
    conversation = rig.storage.get_thread("reader", rig.project, key)["conversationId"]
    # The reader's own account has filed this conversation already.
    rig.storage.set_memory_filed_through("reader", conversation, "request_two002")
    rig.storage.clear_memory_job("reader", f"session:paper:{paper}")
    queue = rig.jobs()

    report = await _stage_or_resume(rig.storage, rig.objects, rig.settings, "reader", resume=False, verbose=False)

    _, manifest, candidate, _ = staged(rig)
    assert report["status"] == "ready" and rig.jobs(storage=candidate) == []
    sessions = [event for event in candidate.list_memory_events("reader", limit=50) if event["kind"] == "session"]
    assert [(event["marker"], event["outcome"], event["requestIds"]) for event in sessions] == [
        (f"session:paper:{paper}", "filed", ["request_one001", "request_two002"])]
    page = candidate.get_memory_page("reader", f"prefix-reuse-{paper}")
    assert page["revision"] == 2 and "Asked again in a session" in page["body"]
    # The document was filed before its session, and the other documents have no session job.
    assert [run["kind"] for run in manifest["lastDrain"] if paper in run["marker"]] == ["document", "session"]
    # Nothing of the reader's own account moved: not the watermark, not the queue.
    assert rig.storage.get_conversation("reader", conversation)["memoryFiledThrough"] == "request_two002"
    assert rig.jobs() == queue and rig.pages("concept") == []


@pytest.mark.asyncio
async def test_a_rebuild_files_a_documents_notes_by_its_session_after_the_document(tmp_path, monkeypatch):
    rig = library(tmp_path, monkeypatch)
    paper = "aaaaaaaaaaa1"
    stroke = rig.storage.add_highlight("reader", rig.project, paper, {"type": "pdf", "page": 1, "text": "a line"})
    rig.storage.add_note("reader", rig.project, paper, {
        "highlightId": stroke["id"], "page": 1, "anchorY": 0.2, "quotedText": "a line", "body": "This ignores cache expiry."})
    rig.storage.mark_notes_filed("reader", rig.project, paper, [n["id"] for n in rig.storage.list_notes("reader", rig.project, paper)],
                                 "2026-10-12T00:00:00+00:00")
    rig.storage.clear_memory_job("reader", f"session:paper:{paper}")
    queue = rig.jobs()

    report = await _stage_or_resume(rig.storage, rig.objects, rig.settings, "reader", resume=False, verbose=False)

    _, manifest, candidate, _ = staged(rig)
    assert report["status"] == "ready" and rig.jobs(storage=candidate) == []
    # A document's job reads no note: the note is filed by the session's, after it.
    assert [run["kind"] for run in manifest["lastDrain"] if paper in run["marker"]] == ["document", "session"]
    [copied] = candidate.list_notes("reader", manifest["projectMap"][rig.project], paper)
    page = candidate.get_memory_page("reader", f"prefix-reuse-{paper}")
    assert [c["noteId"] for c in page["citations"] if c["claimType"] == "reader-note"] == [copied["id"]]
    # The reader's own account is as it was.
    assert copied["filedAt"] and rig.jobs() == queue


def one_line_pdf(text: str) -> bytes:
    """A one-page PDF whose page says `text` in a standard font."""
    content = b"BT /F1 12 Tf 72 720 Td (%s) Tj ET" % text.encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(content), content),
    ]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1) + b"".join(b"%010d 00000 n \n" % at for at in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def extraction_ready(monkeypatch):
    """The runtime check `--reextract` makes, answered: this test is about what it does next."""
    monkeypatch.setattr("delphi_core.backfill.memory_rebuild._extraction_runtime", lambda: {"pypdf": "6.20.1", "fonttools": "4.67.0"})


def test_reextract_refuses_a_runtime_that_cannot_read_a_math_fonts_encoding(monkeypatch):
    import builtins
    import importlib.metadata

    from delphi_core.backfill.memory_rebuild import _extraction_runtime

    real_import, real_version = builtins.__import__, importlib.metadata.version

    def no_fonttools(name, *args, **kwargs):
        if name == "fontTools":
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_fonttools)
    with pytest.raises(ValueError, match="needs fontTools"):
        _extraction_runtime()
    monkeypatch.setattr(builtins, "__import__", real_import)
    monkeypatch.setitem(__import__("sys").modules, "fontTools", object())
    monkeypatch.setattr(importlib.metadata, "version", lambda name: "6.14.2" if name == "pypdf" else real_version(name))
    with pytest.raises(ValueError, match="needs pypdf 6.17"):
        _extraction_runtime()


@pytest.mark.asyncio
async def test_a_candidate_staged_with_reextract_files_from_the_text_this_runtime_extracts(tmp_path, monkeypatch):
    from delphi_core.research_digest import source_hash

    extraction_ready(monkeypatch)
    rig = library(tmp_path, monkeypatch)
    paper = "aaaaaaaaaaa1"
    pdf = tmp_path / "one-line.pdf"
    pdf.write_bytes(one_line_pdf("Prefix caching reuses tokens."))
    rig.objects.put_file(paper_key("reader", rig.project, paper, "pdf"), pdf, "application/pdf")
    # The reader's account holds a current digest of the text it was imported with.
    from delphi_core.research_digest import RESEARCH_DIGEST_VERSION
    old = rig.objects.get_text(paper_key("reader", rig.project, paper, "txt"))
    current = {"status": "ready", "version": RESEARCH_DIGEST_VERSION, "sourceHash": source_hash(old)}
    assert rig.storage.claim_digest("reader", rig.project, paper, claim_id="c1", expires_at="2999-01-01T00:00:00+00:00",
                                    metadata=current, force=True) == "claimed"
    rig.storage.complete_digest("reader", rig.project, paper, "c1", current)
    rig.objects.put_text(paper_key("reader", rig.project, paper, "digest"), json.dumps({
        "version": RESEARCH_DIGEST_VERSION, "sourceHash": source_hash(old),
        "digest": {"contentMarkdown": "An old digest [E1].", "citations": [{"id": 1, "claimType": "author-claim", "page": 1, "section": None}], "assets": []}}))
    digests = rig.asked("research_digest")
    report = await _stage_or_resume(rig.storage, rig.objects, rig.settings, "reader", resume=False, verbose=False,
                                    reextract=True)

    _, manifest, candidate, candidate_objects = staged(rig)
    assert report["status"] == "ready" and manifest["reextracted"] == [paper]
    assert manifest["extraction"] == {"pypdf": "6.20.1", "fonttools": "4.67.0"}
    staged_project = manifest["projectMap"][rig.project]
    text = candidate_objects.get_text(paper_key("reader", staged_project, paper, "txt"))
    assert text == "--- Page 1 ---\n\nPrefix caching reuses tokens."
    # The digest the candidate filed from was written again, from that text: one call for this
    # document, beside the two the rig's other documents (which have no digest yet) always need.
    digest = candidate.get_paper("reader", staged_project, paper)["digest"]
    assert digest["sourceHash"] == source_hash(text) and rig.asked("research_digest") - digests == 3
    assert "An old digest" not in candidate_objects.get_text(paper_key("reader", staged_project, paper, "digest"))
    # The reader's own account still holds the text it was imported with.
    assert rig.objects.get_text(paper_key("reader", rig.project, paper, "txt")) != text
    # Such a candidate measures a change, and is never promoted over the account.
    with pytest.raises(ValueError, match="never promoted"):
        _promote(rig.storage, rig.objects, rig.settings, "reader", manifest["candidate"], accept_drift=True)


@pytest.mark.asyncio
async def test_a_pdf_whose_text_comes_out_unchanged_keeps_its_digest(tmp_path, monkeypatch):
    from delphi_core.research_digest import RESEARCH_DIGEST_VERSION, source_hash

    extraction_ready(monkeypatch)
    rig = library(tmp_path, monkeypatch)
    paper = "aaaaaaaaaaa1"
    pdf = tmp_path / "one-line.pdf"
    pdf.write_bytes(one_line_pdf("Prefix caching reuses tokens."))
    rig.objects.put_file(paper_key("reader", rig.project, paper, "pdf"), pdf, "application/pdf")
    same = "--- Page 1 ---\n\nPrefix caching reuses tokens."
    rig.objects.put_text(paper_key("reader", rig.project, paper, "txt"), same)
    current = {"status": "ready", "version": RESEARCH_DIGEST_VERSION, "sourceHash": source_hash(same)}
    rig.storage.claim_digest("reader", rig.project, paper, claim_id="c1", expires_at="2999-01-01T00:00:00+00:00",
                             metadata=current, force=True)
    rig.storage.complete_digest("reader", rig.project, paper, "c1", current)
    rig.objects.put_text(paper_key("reader", rig.project, paper, "digest"), json.dumps({
        "version": RESEARCH_DIGEST_VERSION, "sourceHash": source_hash(same),
        "digest": {"contentMarkdown": "A digest of the same text [E1].", "citations": [{"id": 1, "claimType": "author-claim", "page": 1, "section": None}], "assets": []}}))

    await _stage_or_resume(rig.storage, rig.objects, rig.settings, "reader", resume=False, verbose=False, reextract=True)

    _, manifest, _, candidate_objects = staged(rig)
    staged_project = manifest["projectMap"][rig.project]
    assert manifest["reextracted"] == []
    assert "A digest of the same text" in candidate_objects.get_text(paper_key("reader", staged_project, paper, "digest"))


@pytest.mark.asyncio
async def test_a_pdf_that_cannot_be_extracted_again_keeps_its_text_and_its_digest(tmp_path, monkeypatch):
    from delphi_core.research_digest import RESEARCH_DIGEST_VERSION, source_hash

    extraction_ready(monkeypatch)
    rig = library(tmp_path, monkeypatch)
    paper = "aaaaaaaaaaa1"
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"%PDF-1.4 this is not a readable PDF")
    rig.objects.put_file(paper_key("reader", rig.project, paper, "pdf"), broken, "application/pdf")
    old = rig.objects.get_text(paper_key("reader", rig.project, paper, "txt"))
    current = {"status": "ready", "version": RESEARCH_DIGEST_VERSION, "sourceHash": source_hash(old)}
    rig.storage.claim_digest("reader", rig.project, paper, claim_id="c1", expires_at="2999-01-01T00:00:00+00:00",
                             metadata=current, force=True)
    rig.storage.complete_digest("reader", rig.project, paper, "c1", current)
    rig.objects.put_text(paper_key("reader", rig.project, paper, "digest"), json.dumps({
        "version": RESEARCH_DIGEST_VERSION, "sourceHash": source_hash(old),
        "digest": {"contentMarkdown": "An old digest [E1].", "citations": [{"id": 1, "claimType": "author-claim", "page": 1, "section": None}], "assets": []}}))
    digests = rig.asked("research_digest")

    report = await _stage_or_resume(rig.storage, rig.objects, rig.settings, "reader", resume=False, verbose=False,
                                    reextract=True)

    _, manifest, candidate, candidate_objects = staged(rig)
    staged_project = manifest["projectMap"][rig.project]
    assert report["status"] == "ready" and manifest["reextracted"] == []
    assert candidate_objects.get_text(paper_key("reader", staged_project, paper, "txt")) == old
    # Its digest was kept, not written again; only the rig's two undigested documents asked for one.
    assert rig.asked("research_digest") - digests == 2
    assert "An old digest" in candidate_objects.get_text(paper_key("reader", staged_project, paper, "digest"))


@pytest.mark.asyncio
async def test_refiling_a_staged_candidate_files_every_document_again_from_the_digests_it_has(tmp_path, monkeypatch):
    rig = library(tmp_path, monkeypatch)
    await _stage_or_resume(rig.storage, rig.objects, rig.settings, "reader", resume=False, verbose=False)
    _, _, candidate, _ = staged(rig)
    first = rig.events(storage=candidate)
    selections = rig.asked("memory_file_selection")

    report = await _stage_or_resume(
        rig.storage, rig.objects, rig.settings, "reader", resume=True, refile=True, verbose=False)

    assert report["status"] == "ready"
    assert rig.asked("research_digest") == 3 and rig.asked("memory_file_selection") > selections
    again = rig.events(storage=candidate)
    # The earlier events went with the earlier pages: the report counts this filing only.
    assert len(again) == 3 and {event["id"] for event in again}.isdisjoint(event["id"] for event in first)
    assert report["filing"]["jobs"] == {"filed": 3, "nothing": 0, "failed": 0}
    assert report["filing"]["pages"] == {"created": 2, "edited": 1}
    assert rig.pages("concept", storage=candidate) == ["prefix-reuse-aaaaaaaaaaa1", "shared-idea-k3x9"]
    assert len(rig.pages("source", storage=candidate)) == 3


@pytest.mark.asyncio
async def test_a_staged_candidate_holds_the_captured_evidence_its_documents_cite_and_promotion_carries_it(
    tmp_path, monkeypatch
):
    rig = library(tmp_path, monkeypatch)
    # A capture a digest cites, and one nothing cites.
    capture(rig.storage, rig.objects)
    rig.storage.put_external_evidence("reader", {**CAPTURE, "id": "cap000000000000000000002"})
    project = rig.storage.list_projects_with_papers("reader")[0]
    rig.storage.add_paper("reader", project["id"], {
        "id": "aaaaaaaaaaa9", "title": "Cited Study", "filename": "c.pdf", "pages": 2,
        "digest": {"status": "failed", "evidenceIds": [CAPTURE["id"]]},
    })
    rig.objects.put_text(paper_key("reader", project["id"], "aaaaaaaaaaa9", "txt"), "--- Page 1 ---\n\nA line.")
    rig.storage.set_openai_file("reader", project["id"], "aaaaaaaaaaa9", "file-9")

    await _stage_or_resume(rig.storage, rig.objects, rig.settings, "reader", resume=False, verbose=False)

    _, _, candidate, candidate_objects = staged(rig)
    held = candidate.get_external_evidence("reader", CAPTURE["id"])
    assert (held["url"], held["findings"]) == (CAPTURE["url"], CAPTURE["findings"])
    assert candidate_objects.exists(external_evidence_key("reader", CAPTURE["id"]))
    with pytest.raises(Exception, match="Evidence not found"):
        candidate.get_external_evidence("reader", "cap000000000000000000002")

    # Into another account: bytes and record, once.
    rig.storage.create_account("other", None, "salt", "hash")
    rig.storage.create_project("other", "Reading")
    assert copy_evidence(candidate, candidate_objects, rig.storage, rig.objects, source_user="reader", target_user="other") == 0
    page = {"kind": "concept", "domain": "ml", "title": "Cites it", "summary": "s", "body": "A claim [E1].", "citations": [
        {"id": 1, "claimType": "external", "paperId": None, "page": None, "section": "findings", "evidenceId": CAPTURE["id"]}]}
    candidate.upsert_memory_page("reader", page, max_pages=50)
    assert copy_evidence(candidate, candidate_objects, rig.storage, rig.objects, source_user="reader", target_user="other") == 1
    assert rig.objects.exists(external_evidence_key("other", CAPTURE["id"]))
    assert copy_evidence(candidate, candidate_objects, rig.storage, rig.objects, source_user="reader", target_user="other") == 0

    # A capture made while staging, cited by a staged page, is promoted with the page.
    fresh = "cap000000000000000000003"
    candidate_objects.put_text(external_evidence_key("reader", fresh), json.dumps({"sections": []}))
    candidate.put_external_evidence("reader", {**CAPTURE, "id": fresh})
    page["citations"][0]["evidenceId"] = fresh
    candidate.upsert_memory_page("reader", {**page, "slug": "cites-it"}, max_pages=50)
    clear_jobs(candidate)
    _promote(rig.storage, rig.objects, rig.settings, "reader", _latest_candidate(rig.settings, "reader")[1]["candidate"])
    assert rig.storage.get_external_evidence("reader", fresh)["url"] == CAPTURE["url"]
    assert rig.objects.exists(external_evidence_key("reader", fresh))
    assert _latest_candidate(rig.settings, "reader")[1]["promotedEvidence"] == 1


def test_the_command_line_takes_a_key_and_no_filing_modes():
    args = build_parser().parse_args(["--user", "ada", "--stage", "--key", "a.json", "--key", "b.json"])
    assert args.keys == ["a.json", "b.json"]
    with pytest.raises(SystemExit):
        build_parser().parse_args(["--user", "ada", "--stage", "--modes-from", "bob"])


@pytest.mark.asyncio
async def test_the_new_web_arm_is_staged_with_web_evidence_on_and_refiled_from_the_same_frozen_passes(tmp_path, monkeypatch):
    """§13.3: `new+web`, on, from frozen captured evidence. The first staging looks; a refiling replays."""
    from delphi_core.harness import evidence as captures
    from delphi_core.web_fetch import FetchedResource
    from tests.chat_keys import chat_key
    from tests.rig_library import provider

    rig = library(tmp_path, monkeypatch)
    fetched = []

    async def fetch(url, settings, **options):
        fetched.append(url)
        return FetchedResource(url=url, body=provider.article_html(url.rsplit("/", 1)[-1]).encode(), content_type="text/html",
                               encoding="utf-8", fetched_at="2026-10-14T00:00:00+00:00")

    monkeypatch.setattr(captures, "fetch_resource", fetch)
    paper = "aaaaaaaaaaa1"
    key = chat_key(rig.storage, "reader", rig.project, f"paper-{paper}")
    answer = f"{provider.ANSWER}\n\n{provider.OUTSIDE_ANSWERED} {provider.cite(provider.NOTICE)}."
    rig.storage.append_message("reader", rig.project, key, {
        "role": "user", "content": "Worth keeping: what confounds production measurements?", "requestId": "request_web001"})
    rig.storage.append_message("reader", rig.project, key, {
        "role": "assistant", "content": answer, "requestId": "request_web001", "sources": [provider.NOTICE]})
    rig.storage.clear_memory_job("reader", f"session:paper:{paper}")
    frozen = tmp_path / "frozen"

    report = await _stage_or_resume(rig.storage, rig.objects, rig.settings, "reader", resume=False, verbose=False,
                                    keys=[answer_key(tmp_path)], web_frozen=frozen)

    _, manifest, candidate, _ = staged(rig)
    assert manifest["web"] == {"evidence": True, "frozen": str(frozen.resolve())}
    assert report["status"] == "ready" and report["arm"] == "new+web" and report["quality"]["arm"] == "new+web"
    assert report["web"]["passes"] == {"reground": {"passes": 1, "replayed": 0, "searches": 0, "captured": 1, "dropped": 1}}
    assert report["web"]["dropped"] == {"the quote is not on the page": 1}
    gates = {gate["label"]: gate["status"] for gate in report["quality"]["gates"]}
    assert gates["every external citation opens a passage containing its quote"] == "pass", report["quality"]["metrics"]["outsidePassages"]
    page = candidate.get_memory_page("reader", f"prefix-reuse-{paper}")
    assert provider.OUTSIDE_FILED in page["body"] and page["citations"][-1]["claimType"] == "external"
    assert fetched == [provider.NOTICE["url"]] and len(list(frozen.glob("*.json"))) == 1
    # Nothing of the reader's own account looked anything up or changed.
    assert rig.pages("concept") == []

    # Filed again from the same evidence: no research request, no fetch, the same capture cited.
    researched = rig.asked("research_findings")
    report = await _stage_or_resume(rig.storage, rig.objects, rig.settings, "reader", resume=True, refile=True, verbose=False)
    assert report["arm"] == "new+web" and rig.asked("research_findings") == researched and fetched == [provider.NOTICE["url"]]
    assert report["web"]["passes"]["reground"]["replayed"] == 1
    again = candidate.get_memory_page("reader", f"prefix-reuse-{paper}")
    assert again["citations"][-1]["evidenceId"] == page["citations"][-1]["evidenceId"]
