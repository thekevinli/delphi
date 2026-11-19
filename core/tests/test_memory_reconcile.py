"""
A disagreement between two pages, from the Memory check that finds it to the edit that answers it.

Lint reads the pages and reports two that disagree; that queues a `reconcile`
job; the drain claims it like any other; the maintenance agent starts from
the two pages with the documents both cite as its only evidence, and what it
writes is checked and committed with the trigger `reconcile`. The stores, the
queue and every stage are real. The provider is the journey rig's fixture,
which reports a disagreement between two pages that each hold a line starting
"Disputed finding:".
"""

import httpx
import pytest

from delphi_core.backfill.memory import drain_account
from delphi_core.memory import lint_memory
from delphi_core.memory_maintenance import jobs, maintain
from delphi_core.storage.base import HELD_JOB_KINDS, MEMORY_JOB_KINDS
from tests.rig_library import Rig, provider

FIRST = "Disputed finding: a stable prefix halves latency in every deployment."
SECOND = "Disputed finding: a stable prefix halved latency in one comparison only."


def disputing(rig, **second):
    """Two concept pages that cite the same document and state its finding differently."""
    rig.pdf("aaaaaaaaaaa1", "Cache paper")
    cited = [{"id": 1, "claimType": "author-claim", "paperId": "aaaaaaaaaaa1", "page": 2}]
    for title, line in (("Latency claims", FIRST), ("Measured reuse", SECOND)):
        rig.storage.upsert_memory_page("reader", {
            "kind": "concept", "domain": "caching", "title": title, "summary": "What was measured.",
            "body": f"## {title}\n\n{line} [E1]\n", "citations": cited, **(second if title == "Measured reuse" else {}),
        }, max_pages=50)
    # Only the disagreement is under test: the document's own job and the domain's are not.
    rig.storage.cancel_memory_jobs("reader", kinds=MEMORY_JOB_KINDS)


async def lint(rig):
    async with httpx.AsyncClient() as client:
        return [event async for event in lint_memory(client, rig.storage, rig.objects, "reader", rig.settings)]


def reconciles(rig):
    return [job for job in rig.storage.list_memory_jobs("reader") if job["kind"] == "reconcile"]


def requests_of(rig):
    """What each request of the job was: a selection, a round of the agent, a check."""
    return [name for name in rig.provider.asked if name in ("memory_file_selection", "agent", "memory_verdicts")]


@pytest.mark.asyncio
async def test_a_disagreement_lint_finds_is_reconciled_by_an_edit_that_cites_what_both_pages_cite(tmp_path, monkeypatch):
    rig = Rig(tmp_path, monkeypatch, memory_drain_workers=1)
    disputing(rig)
    before = {slug: rig.storage.get_memory_page("reader", slug) for slug in ("latency-claims", "measured-reuse")}

    event = (await lint(rig))[-1]["event"]

    # Lint wrote no page and queued one job for the two pages, at the revisions it read.
    marker = jobs.reconcile_marker(["latency-claims", "measured-reuse"])
    assert event["reconcile"] == [marker]
    # Lint reads the newest page first, and the fixture's agent edits the page the check quoted first.
    first, second = event["contradictions"][0]["pages"]
    assert {first, second} == {"latency-claims", "measured-reuse"}
    (job,) = reconciles(rig)
    assert job["payload"]["slugs"] == ["latency-claims", "measured-reuse"] and job["status"] == "pending"
    assert job["payload"]["fingerprint"] == jobs.reconcile_fingerprint({"latency-claims": 1, "measured-reuse": 1})
    assert {slug: rig.storage.get_memory_page("reader", slug)["revision"] for slug in before} == {
        "latency-claims": 1, "measured-reuse": 1}

    # Nothing holds the kind back any more: the next drain claims it.
    assert HELD_JOB_KINDS == ()
    runs = await drain_account(rig.storage, rig.objects, rig.settings, "reader", verbose=False)

    assert [(run["marker"], run["kind"], run["outcome"]) for run in runs if run["kind"] == "reconcile"] == [
        (marker, "reconcile", "filed")]
    assert provider.refusals == [] and reconciles(rig) == []
    # No selection: the pages were known. The agent's write, its last word, the check.
    assert requests_of(rig) == ["agent", "agent", "memory_verdicts"]
    edited, other = (rig.storage.get_memory_page("reader", slug) for slug in (first, second))
    assert edited["revision"] == 2
    # The other page is as it was; only the link now pointing at it is new.
    assert {**other, "linkDegree": 0} == {**before[second], "linkDegree": 0}
    # What the page said is kept word for word, and what was added cites the document both pages cite.
    assert edited["body"].startswith(before[first]["body"].rstrip())
    assert f"The sources disagree here: [[{second}]] states the finding differently" in edited["body"]
    assert [(c["id"], c["claimType"], c["paperId"], c["page"]) for c in edited["citations"]] == [
        (1, "author-claim", "aaaaaaaaaaa1", 2), (2, "author-claim", "aaaaaaaaaaa1", 1)]
    version = rig.storage.list_page_versions("reader", first)[0]
    assert (version["trigger"], version["revision"]) == ("reconcile", 2)
    assert version["note"] == "Said that the sources disagree on the disputed finding."
    filed = next(e for e in rig.storage.list_memory_events("reader", limit=10) if e["kind"] == "reconcile")
    assert (filed["requestId"], filed["marker"], filed["outcome"], filed["pages"]) == (marker, marker, "filed", [first])
    assert filed["selection"] is None and filed["telemetry"]["select"] == {}
    # The agent was shown what the check said, fenced, and both pages open.
    request = next(body for body in provider.requests if any(tool.get("name") == "edit_memory" for tool in body.get("tools", [])))
    text = provider.input_text(request)
    assert '<event kind="reconcile">' in text and "<page_disagreement>" in text
    assert f'[[latency-claims]] says: "{FIRST} [E1]"' in text and f'[[measured-reuse]] says: "{SECOND} [E1]"' in text
    assert "=== [[measured-reuse]] " in text and "=== [[latency-claims]] " in text
    assert "paperId `aaaaaaaaaaa1`" in text and "Start from [[latency-claims]], [[measured-reuse]]." in text

    # The same finding over the new text is a new job; the one that ran is not run again for the old.
    again = (await lint(rig))[-1]["event"]
    assert again["reconcile"] == [marker]
    assert reconciles(rig)[0]["payload"]["fingerprint"] == jobs.reconcile_fingerprint({first: 2, second: 1})


@pytest.mark.asyncio
@pytest.mark.parametrize("moved", ["written again", "deleted", "no longer a concept"])
async def test_a_reconcile_job_whose_pages_moved_on_ends_with_nothing_and_asks_no_model(tmp_path, monkeypatch, moved):
    rig = Rig(tmp_path, monkeypatch, memory_drain_workers=1)
    disputing(rig)
    await lint(rig)
    asked = len(rig.provider.asked)
    page = rig.storage.get_memory_page("reader", "measured-reuse")
    if moved == "written again":
        rig.storage.upsert_memory_page("reader", {**page, "body": page["body"] + "\nMore.\n"}, max_pages=50)
    else:
        rig.storage.delete_memory_page("reader", "measured-reuse")
        if moved == "no longer a concept":
            rig.storage.upsert_memory_page("reader", {
                "kind": "source", "domain": "caching", "slug": "measured-reuse", "title": "Measured reuse",
                "summary": "A digest.", "body": "Digest.", "sourcePaperId": "aaaaaaaaaaa1"}, max_pages=50)
    for job in rig.storage.list_memory_jobs("reader"):
        if job["kind"] != "reconcile":
            rig.storage.clear_memory_job("reader", job["marker"])

    runs = await drain_account(rig.storage, rig.objects, rig.settings, "reader", verbose=False)

    assert [(run["kind"], run["outcome"]) for run in runs] == [("reconcile", "nothing")]
    assert len(rig.provider.asked) == asked and reconciles(rig) == []
    event = rig.storage.list_memory_events("reader", limit=1)[0]
    assert (event["kind"], event["outcome"], event["pages"]) == ("reconcile", "nothing", [])
    assert event["summary"] == {
        "written again": "A page was written again after the check found the disagreement.",
        "deleted": "The page measured-reuse is no longer in Memory.",
        "no longer a concept": "The page measured-reuse is no longer a concept or domain page.",
    }[moved]
    # Nothing was written by the job itself.
    assert rig.storage.list_page_versions("reader", "latency-claims")[0]["trigger"] != "reconcile"


def test_the_contract_says_what_to_do_with_a_disagreement():
    told = " ".join(maintain.CONTRACT.split())
    for phrase in (
        "**When the event is pages that disagree** (`<page_disagreement>`)",
        "work out what each page says and which evidence supports which",
        "If the evidence contradicts one page, correct that page",
        "Say on both pages that the sources disagree",
        "Never delete a supported claim to make two pages agree.",
    ):
        assert phrase in told, phrase
