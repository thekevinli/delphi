"""
The commit that ends a maintenance job, against every store.

Each test stages pages by hand (`StagedPage`), claims a real job so the commit
has a lease to present, and reads back what the store holds afterwards. It
runs on every store the consumer's `store_harness` opens, as the storage
contract does.
"""

import json

import pytest
from fastapi import HTTPException

from delphi_core.config import Settings
from delphi_core.memory import MEMORY_VERSION
from delphi_core.memory_maintenance.commit import commit
from delphi_core.memory_maintenance.run import StaleRevision
from delphi_core.memory_maintenance.run import Authored, Dropped, EvidenceSet, Objection, Selection, Verdicts
from delphi_core.memory_maintenance.staging import MemoryDraft, StagedPage
from delphi_core.storage import MemoryJobGone
from delphi_core.storage.base import MEMORY_JOB_KINDS

from delphi_core_testkit.conformance.storage_contract import note_payload


SETTINGS = Settings()
BODY = "## Position encoding\n\nSinusoidal encodings add a fixed signal [E1]. See [[long-gone]].\n"
CITATION = {"id": 1, "claimType": "author-claim", "paperId": "p0", "page": 3, "section": None, "noteId": None, "evidenceId": None}
FIGURE_KEY = "knowledge/u/reader/figures/fig1.webp"


@pytest.fixture
def storage(store_harness, tmp_path):
    store = store_harness.make(tmp_path)
    store.create_account("reader", "reader@example.test", "salt", "hash")
    return store


def library(storage):
    """A project with one document, and one concept page another document left, with a figure."""
    project = storage.create_project("reader", "Reading")
    storage.add_paper("reader", project["id"], {"id": "p1", "title": "Paper A", "filename": "a.pdf"})
    storage.upsert_memory_page("reader", {
        "slug": "position-encoding", "kind": "concept", "domain": "transformers", "title": "Position encoding",
        "summary": "How a transformer is told where a token is.", "body": BODY, "tags": ["encoding"],
        "aliases": ["Positional encoding"], "citations": [CITATION], "sourcePaperId": "p0", "sourceProjectId": "old-project",
    }, max_pages=50)
    storage.add_memory_figure("reader", {
        "id": "fig1", "pageSlug": "position-encoding", "caption": "The signal", "objectKey": FIGURE_KEY,
        "origin": {"paperId": "p0", "page": 3}, "width": 800, "height": 400, "bytes": 20_000,
    }, max_per_page=6)
    return project


def claimed(storage, kind="document", marker="paper:p1", **payload):
    """A leased job of the new kind, as `claim_memory_job` hands one to the drain."""
    storage.cancel_memory_jobs("reader", kinds=MEMORY_JOB_KINDS)
    storage.enqueue_memory_job("reader", kind=kind, marker=marker, payload=payload, target_version=MEMORY_VERSION)
    job = storage.claim_memory_job(
        "reader", now="2026-10-12T00:00:00+00:00", lease_expires_at="2099-01-01T00:00:00+00:00", max_attempts=6,
    )
    assert job["marker"] == marker and job["kind"] == kind
    return job


def evidence(project, kind="document", marker="paper:p1", **given) -> EvidenceSet:
    return EvidenceSet(kind=kind, marker=marker, project_id=project["id"], paper_id="p1", title="Paper A", fingerprint="f1", **given)


def edit(**given) -> StagedPage:
    new = BODY + "\n## Rotary variants\n\nRotary embeddings rotate paired dimensions [E2].\n"
    return StagedPage(**{
        "slug": "position-encoding", "action": "edit", "revision": 1, "title": "Position encoding",
        "aliases": ("Positional encoding", "PE"), "domain": "transformers",
        "summary": "How a transformer is told where a token is. [E1]", "body": new,
        "citations": (CITATION, {**CITATION, "id": 2, "paperId": "p1", "page": 4}),
        "note": "added rotary variants", **given,
    })


def create(**given) -> StagedPage:
    return StagedPage(**{
        "slug": "rotary-embeddings", "action": "create", "revision": 0, "title": "Rotary embeddings", "aliases": ("RoPE",),
        "domain": "transformers", "summary": "Position as a rotation of paired dimensions.",
        "body": "Rotary embeddings rotate paired dimensions [E1]. Compare [[position-encoding]].\n",
        "citations": ({**CITATION, "paperId": "p1", "page": 4},), "note": "new page for rotary embeddings", **given,
    })


def run(storage, job, evidence, pages=(), *, selection=None, dropped=(), verdicts=None, authored=None, settings=SETTINGS):
    return commit(
        storage, "reader", settings, job=job, evidence=evidence, selection=selection, pages=list(pages),
        dropped=list(dropped), verdicts=verdicts, authored=authored,
    )


def events(storage):
    return storage.list_memory_events("reader", limit=50)


def test_an_edit_commits_at_the_revision_it_was_read_at_and_keeps_what_it_did_not_touch(storage):
    project = library(storage)
    job = claimed(storage, projectId=project["id"], paperId="p1")
    verdicts = Verdicts(
        objections=(
            Objection("position-encoding", "differs", "a quote the checker made up " * 30, "advisory only"),
            Objection("position-encoding", "unsupported", "blocked earlier and repaired", "why", "p1", blocking=True),
        ),
        usage={"input_tokens": 900},
    )
    done = run(
        storage, job, evidence(project), [edit()],
        selection=Selection(False, "bears on position encoding", ("position-encoding",), usage={"input_tokens": 50}),
        verdicts=verdicts,
        authored=Authored(MemoryDraft(), closing="Added rotary variants to position encoding.", rounds=4, usage={"output_tokens": 700}),
    )
    assert done["outcome"] == "filed" and [page["slug"] for page in done["pages"]] == ["position-encoding"]
    page = storage.get_memory_page("reader", "position-encoding")
    assert page["revision"] == 2 and page["kind"] == "concept"
    assert page["body"].endswith("Rotary embeddings rotate paired dimensions [E2].\n")
    # A link the page already had with no page behind it is not this commit's to rewrite.
    assert "[[long-gone]]" in page["body"]
    assert page["summary"] == "How a transformer is told where a token is."
    assert page["aliases"] == ["Positional encoding", "PE"]
    assert [citation["id"] for citation in page["citations"]] == [1, 2]
    # Provenance, tags and figures are the page's, not this job's.
    assert page["sourcePaperId"] == "p0" and "sourceProjectId" not in page
    assert page["tags"] == ["encoding"]
    assert [(figure["id"], figure["objectKey"]) for figure in page["figures"]] == [("fig1", FIGURE_KEY)]
    assert done["supersededObjectKeys"] == []

    event = done["event"]
    newest = storage.list_page_versions("reader", "position-encoding")[0]
    assert (newest["revision"], newest["trigger"], newest["note"], newest["eventId"]) == (2, "document", "added rotary variants", event["id"])
    assert event["kind"] == "document" and event["version"] == MEMORY_VERSION
    assert event["requestId"] == event["marker"] == "paper:p1"
    assert event["operationId"] == json.dumps([job["id"], MEMORY_VERSION, "f1"], separators=(",", ":"))
    assert (event["projectId"], event["paperId"], event["outcome"]) == (project["id"], "p1", "filed")
    assert event["summary"] == "Added rotary variants to position encoding."
    assert event["pages"] == ["position-encoding"] and event["dropped"] == [] and event["distinct"] == []
    assert event["edits"] == [{
        "slug": "position-encoding", "title": "Position encoding", "kind": "concept", "action": "revised",
        "note": "added rotary variants",
    }]
    assert event["selection"] == {
        "pages": ["position-encoding"], "reason": "bears on position encoding", "nothingToFile": False, "needsOutside": None,
    }
    assert event["advisory"]["count"] == 1
    [advisory] = event["advisory"]["objections"]
    assert advisory["finding"] == "differs" and len(advisory["quote"]) <= 400 and advisory["quote"].endswith("…")
    assert event["fingerprint"] == "f1" and event["requestIds"] == []
    assert event["telemetry"] == {
        "select": {"input_tokens": 50}, "maintain": {"output_tokens": 700}, "verify": {"input_tokens": 900},
        "rounds": 4, "ended": "completed", "tools": {}, "asked": [],
    }
    assert storage.has_memory_event("reader", "paper:p1")
    assert storage.has_memory_event("reader", "paper:p1", operation_id=event["operationId"])


def test_a_new_page_commits_with_its_aliases_and_the_document_it_came_from(storage):
    project = library(storage)
    job = claimed(storage, projectId=project["id"], paperId="p1")
    page = create(distinct_from=("position-encoding",), distinct_reason="A rotation, not an added signal.")
    done = run(storage, job, evidence(project), [page])
    stored = storage.get_memory_page("reader", "rotary-embeddings")
    assert stored["revision"] == 1 and stored["kind"] == "concept" and stored["domain"] == "transformers"
    assert stored["aliases"] == ["RoPE"]
    assert stored["sourcePaperId"] == "p1" and "sourceProjectId" not in stored
    assert "[[position-encoding]]" in stored["body"]
    event = done["event"]
    assert event["edits"][0]["action"] == "created" and event["edits"][0]["note"] == "new page for rotary embeddings"
    assert event["distinct"] == [{
        "slug": "rotary-embeddings", "from": ["position-encoding"], "reason": "A rotation, not an added signal.",
    }]
    # With no closing words from the agent, the summary is what the pages' notes say.
    assert event["summary"] == "new page for rotary embeddings"
    [version] = storage.list_page_versions("reader", "rotary-embeddings")
    assert (version["revision"], version["trigger"]) == (1, "document")


@pytest.mark.parametrize("request_ids, trigger", [(("r1", "r2"), "conversation"), ((), "notes")])
def test_a_session_job_names_its_cause_and_gives_a_new_page_no_document(storage, request_ids, trigger):
    project = library(storage)
    job = claimed(storage, kind="session", marker="session:paper:p1", projectId=project["id"], paperId="p1")
    done = run(storage, job, evidence(project, "session", "session:paper:p1", request_ids=request_ids), [create(), edit()])
    assert done["outcome"] == "filed"
    assert done["event"]["kind"] == "session" and done["event"]["requestIds"] == list(request_ids)
    # A session job is found again by what it read, as a document job is.
    assert json.loads(done["event"]["operationId"])[0] == job["id"]
    assert storage.get_memory_page("reader", "rotary-embeddings").get("sourcePaperId") is None
    assert storage.list_page_versions("reader", "rotary-embeddings")[0]["trigger"] == trigger
    assert storage.list_page_versions("reader", "position-encoding")[0]["trigger"] == trigger
    assert storage.has_memory_event("reader", "session:paper:p1")


def test_a_stale_revision_is_its_own_error_and_writes_nothing(storage):
    project = library(storage)
    job = claimed(storage, projectId=project["id"], paperId="p1")
    # Someone else revises the page after the agent read it at revision 1.
    storage.upsert_memory_page("reader", {
        "slug": "position-encoding", "kind": "concept", "domain": "transformers", "title": "Position encoding",
        "summary": "s", "body": "Rewritten by the reader.", "citations": [],
    }, max_pages=50)
    with pytest.raises(StaleRevision) as raised:
        run(storage, job, evidence(project), [create(), edit()])
    assert raised.value.slugs == ("position-encoding",)
    assert storage.get_memory_page("reader", "position-encoding")["body"] == "Rewritten by the reader."
    with pytest.raises(HTTPException):
        storage.get_memory_page("reader", "rotary-embeddings")
    assert events(storage) == [] and not storage.has_memory_event("reader", "paper:p1")

    # A page deleted since it was read, and a new page whose slug was taken meanwhile.
    storage.delete_memory_page("reader", "position-encoding")
    storage.upsert_memory_page("reader", {
        "slug": "rotary-embeddings", "kind": "concept", "domain": "transformers", "title": "Rotary embeddings",
        "summary": "s", "body": "Written by another job.", "citations": [],
    }, max_pages=50)
    with pytest.raises(StaleRevision) as raised:
        run(storage, job, evidence(project), [create(), edit()])
    assert set(raised.value.slugs) == {"position-encoding", "rotary-embeddings"}
    assert events(storage) == []


def test_a_refusal_that_is_not_a_stale_revision_stays_the_stores_own(storage):
    project = library(storage)
    job = claimed(storage, projectId=project["id"], paperId="p1")
    with pytest.raises(HTTPException) as raised:
        run(storage, job, evidence(project), [create()], settings=Settings(memory_max_pages=1))
    assert raised.value.status_code == 409 and "maximum" in raised.value.detail
    assert events(storage) == []


def test_nothing_to_file_writes_an_event_and_no_page_and_settles_the_marker(storage):
    project = library(storage)
    job = claimed(storage, kind="session", marker="session:paper:p1", projectId=project["id"], paperId="p1")
    before = storage.get_memory_page("reader", "position-encoding")
    done = run(
        storage, job, evidence(project, "session", "session:paper:p1", request_ids=("r1",)),
        selection=Selection(True, "The exchange restated what the page already says."),
    )
    assert done["outcome"] == "nothing" and done["pages"] == []
    event = done["event"]
    assert (event["outcome"], event["pages"], event["edits"], event["dropped"]) == ("nothing", [], [], [])
    assert event["summary"] == "The exchange restated what the page already says."
    assert event["selection"]["nothingToFile"] is True
    assert storage.has_memory_event("reader", "session:paper:p1")
    assert storage.get_memory_page("reader", "position-encoding") == before
    assert len(storage.list_memory_pages("reader", limit=50)) == 1


def test_nothing_is_said_in_the_words_of_whoever_found_it(storage):
    project = library(storage)
    job = claimed(storage, projectId=project["id"], paperId="p1")
    skipped = run(storage, job, evidence(project, skipped="Every exchange rested on Memory alone."))
    assert skipped["event"]["summary"] == "Every exchange rested on Memory alone." and skipped["event"]["selection"] is None
    job = claimed(storage, marker="paper:p1:part:1", projectId=project["id"], paperId="p1")
    closing = run(
        storage, job, evidence(project, marker="paper:p1:part:1"), selection=Selection(False, "bears on one page", ("position-encoding",)),
        authored=Authored(MemoryDraft(), closing="The page already covers this."),
    )
    assert closing["event"]["summary"] == "The page already covers this." and closing["outcome"] == "nothing"
    job = claimed(storage, marker="paper:p1:part:2", projectId=project["id"], paperId="p1")
    assert run(storage, job, evidence(project, marker="paper:p1:part:2"))["event"]["summary"] == "Nothing in this event was worth filing."


def test_a_link_to_a_page_deleted_since_staging_is_written_as_its_words(storage):
    project = library(storage)
    storage.upsert_memory_page("reader", {
        "slug": "attention", "kind": "concept", "domain": "transformers", "title": "Attention", "summary": "s",
        "body": "Attention weighs tokens.", "citations": [],
    }, max_pages=50)
    job = claimed(storage, projectId=project["id"], paperId="p1")
    first = create(body="Rotary embeddings act inside [[attention]] and beside [[relative-position|relative schemes]] [E1].\n")
    second = create(
        slug="relative-position", title="Relative position",
        body="Relative schemes [E1] differ from [[rotary-embeddings]] and from `[[attention]]` in code.\n",
    )
    # Both links resolved when the agent staged. Then the reader deletes one page.
    storage.delete_memory_page("reader", "attention")
    done = run(storage, job, evidence(project), [first, second])
    assert done["outcome"] == "filed"
    rotary = storage.get_memory_page("reader", "rotary-embeddings")
    assert rotary["body"] == "Rotary embeddings act inside attention and beside [[relative-position|relative schemes]] [E1].\n"
    # A link to a page of the same commit resolves; text in code is not a link.
    relative = storage.get_memory_page("reader", "relative-position")
    assert "[[rotary-embeddings]]" in relative["body"] and "`[[attention]]`" in relative["body"]


def test_dropped_targets_are_on_the_event_beside_the_pages_that_passed(storage):
    project = library(storage)
    job = claimed(storage, projectId=project["id"], paperId="p1")
    gone = Dropped("rotary-embeddings", "Rotary embeddings", "create", "unsupported: page 4 does not say this", "reach 74.9 BLEU")
    done = run(storage, job, evidence(project), [edit()], dropped=[gone])
    assert done["outcome"] == "filed"
    assert done["event"]["dropped"] == [{
        "slug": "rotary-embeddings", "title": "Rotary embeddings", "action": "create",
        "reason": "unsupported: page 4 does not say this", "quote": "reach 74.9 BLEU",
    }]
    assert storage.has_memory_event("reader", "paper:p1")


def test_a_job_whose_every_page_was_dropped_fails_with_an_event_and_an_unsettled_marker(storage):
    project = library(storage)
    highlight = storage.add_highlight("reader", project["id"], "p1", {
        "type": "pdf", "page": 3, "rects": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04}], "text": "a claim", "color": "amber",
    })
    note = storage.add_note("reader", project["id"], "p1", note_payload(highlight["id"]))
    job = claimed(storage, projectId=project["id"], paperId="p1")
    before = storage.get_memory_page("reader", "position-encoding")
    gone = Dropped("position-encoding", "Position encoding", "edit", "differs: the page prints 71.4", "reaches 74.9 BLEU")
    done = run(
        storage, job, evidence(project, notes={note["id"]: note["updatedAt"]}), dropped=[gone],
        authored=Authored(MemoryDraft(), closing="Revised position encoding."),
    )
    assert done["outcome"] == "failed" and done["pages"] == [] and done["notesFiled"] == []
    assert storage.get_memory_page("reader", "position-encoding") == before
    [event] = events(storage)
    assert event["outcome"] == "failed" and event["pages"] == [] and event["marker"] == "paper:p1"
    assert event["dropped"][0]["title"] == "Position encoding" and event["dropped"][0]["action"] == "edit"
    assert event["summary"] == "Nothing was written: Position encoding (differs: the page prints 71.4)"
    # The marker is not settled, so the job is tried again, and its notes are still to be read.
    assert event["requestId"] == f"paper:p1:dropped:{job['attempts']}"
    assert not storage.has_memory_event("reader", "paper:p1")
    assert not storage.has_memory_event("reader", "paper:p1", operation_id=event.get("operationId"))
    assert storage.list_notes("reader", project["id"], "p1")[0]["filedAt"] is None


def test_notes_are_stamped_filed_only_when_unchanged_since_they_were_read(storage):
    project = library(storage)
    notes = []
    for y in (0.2, 0.4, 0.6):
        highlight = storage.add_highlight("reader", project["id"], "p1", {
            "type": "pdf", "page": 3, "rects": [{"x": 0.1, "y": y, "w": 0.3, "h": 0.04}], "text": "a claim", "color": "amber",
        })
        notes.append(storage.add_note("reader", project["id"], "p1", note_payload(highlight["id"])))
    kept, edited, unread = notes
    read = {kept["id"]: kept["updatedAt"], edited["id"]: edited["updatedAt"], "deleted-since": "2026-10-12T00:00:00+00:00"}
    job = claimed(storage, kind="session", marker="session:paper:p1", projectId=project["id"], paperId="p1")
    # The reader edits one note while the job runs.
    storage.update_note("reader", project["id"], "p1", edited["id"], "I changed my mind")
    done = run(storage, job, evidence(project, "session", "session:paper:p1", notes=read), [edit()])
    assert done["notesFiled"] == [kept["id"]]
    filed = {note["id"]: note["filedAt"] for note in storage.list_notes("reader", project["id"], "p1")}
    assert filed[kept["id"]] and filed[edited["id"]] is None and filed[unread["id"]] is None
    assert done["event"]["kind"] == "session"
    assert storage.list_page_versions("reader", "position-encoding")[0]["trigger"] == "notes"


def test_a_nothing_outcome_stamps_the_notes_it_read(storage):
    project = library(storage)
    highlight = storage.add_highlight("reader", project["id"], "p1", {
        "type": "pdf", "page": 3, "rects": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04}], "text": "a claim", "color": "amber",
    })
    note = storage.add_note("reader", project["id"], "p1", note_payload(highlight["id"]))
    job = claimed(storage, kind="session", marker="session:paper:p1", projectId=project["id"], paperId="p1")
    done = run(
        storage, job, evidence(project, "session", "session:paper:p1", notes={note["id"]: note["updatedAt"]}),
        selection=Selection(True, "The note repeats the page."),
    )
    assert done["outcome"] == "nothing" and done["notesFiled"] == [note["id"]]


def test_the_fence_refuses_a_commit_whose_lease_is_gone(storage):
    project = library(storage)
    job = claimed(storage, projectId=project["id"], paperId="p1")
    storage.cancel_memory_jobs("reader", kinds=MEMORY_JOB_KINDS)
    with pytest.raises(MemoryJobGone):
        run(storage, job, evidence(project), [edit(), create()])
    assert storage.get_memory_page("reader", "position-encoding")["revision"] == 1
    with pytest.raises(HTTPException):
        storage.get_memory_page("reader", "rotary-embeddings")
    assert events(storage) == []
    # A lease taken again by another worker is a different attempt, and the old one is refused too.
    job = claimed(storage, projectId=project["id"], paperId="p1")
    with pytest.raises(MemoryJobGone):
        run(storage, {**job, "attempts": job["attempts"] + 1}, evidence(project), [edit()])
    assert run(storage, job, evidence(project), [edit()])["outcome"] == "filed"


def test_a_commit_enqueues_no_document_or_session_job(storage):
    project = library(storage)
    job = claimed(storage, projectId=project["id"], paperId="p1")
    run(storage, job, evidence(project), [edit(), create()])
    queued = {(row["kind"], row["marker"]) for row in storage.list_memory_jobs("reader")}
    # Its own job is still leased; the store queues the one domain the pages are in.
    assert queued == {("document", "paper:p1"), ("domain", "domain:transformers")}


def test_an_unsorted_source_page_joins_the_domain_of_the_first_concept_written_from_it(storage):
    project = library(storage)
    for slug, domain in (("paper-a", "general"), ("paper-b", "vision")):
        storage.upsert_memory_page("reader", {
            "slug": slug, "kind": "source", "domain": domain, "title": slug, "summary": "A digest.", "body": "The digest.\n",
            "sourcePaperId": "p1", "sourceProjectId": project["id"],
        }, max_pages=50)

    # An edit of a page in a domain settles nothing by itself being unsorted: the page it edits has a domain.
    job = claimed(storage, projectId=project["id"], paperId="p1")
    run(storage, job, evidence(project, start_slugs=("paper-a",)), [create()])
    assert storage.get_memory_page("reader", "paper-a")["domain"] == "transformers"

    # A source page that already has a domain stays where it is.
    job = claimed(storage, marker="paper:p1:part:1", projectId=project["id"], paperId="p1")
    run(storage, job, evidence(project, marker="paper:p1:part:1", start_slugs=("paper-b",)),
        [create(slug="relative-bias", title="Relative bias", aliases=())])
    assert storage.get_memory_page("reader", "paper-b")["domain"] == "vision"


def test_a_page_written_into_the_unsorted_domain_moves_nothing(storage):
    project = library(storage)
    storage.upsert_memory_page("reader", {
        "slug": "paper-a", "kind": "source", "domain": "general", "title": "Paper A", "summary": "A digest.",
        "body": "The digest.\n", "sourcePaperId": "p1", "sourceProjectId": project["id"],
    }, max_pages=50)
    job = claimed(storage, projectId=project["id"], paperId="p1")
    run(storage, job, evidence(project, start_slugs=("paper-a",)), [create(domain="general")])
    assert storage.get_memory_page("reader", "paper-a")["domain"] == "general"


def test_a_domain_a_new_page_brings_into_being_is_named_as_its_author_wrote_it(storage):
    # The first evaluation's desktop run showed "Llm serving": a domain was named from its slug.
    project = library(storage)
    storage.upsert_memory_domain("reader", {"slug": "transformers", "title": "Transformer models", "origin": "reader"})
    job = claimed(storage, projectId=project["id"], paperId="p1")
    run(storage, job, evidence(project), [
        create(domain="llm-serving", domain_title="LLM serving"),
        create(slug="relative-bias", title="Relative bias", aliases=(), domain_title="transformers"),
    ])
    titles = {domain["slug"]: domain["title"] for domain in storage.memory_domains("reader")}
    assert titles["llm-serving"] == "LLM serving"
    # A domain that existed keeps its name, which may be the reader's.
    assert titles["transformers"] == "Transformer models"


def test_a_domain_spelled_in_lower_case_gets_a_capital_and_nothing_else(storage):
    project = library(storage)
    job = claimed(storage, projectId=project["id"], paperId="p1")
    run(storage, job, evidence(project), [create(domain="scaling-laws", domain_title="scaling laws")])
    titles = {domain["slug"]: domain["title"] for domain in storage.memory_domains("reader")}
    assert titles["scaling-laws"] == "Scaling laws"
