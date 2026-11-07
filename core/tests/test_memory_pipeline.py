"""
One document job, from its claim to its event, through every stage.

Everything is real but the provider: the local stores, the queue and its
lease, gather, the selection's parsing, the agent's loop and its write tools,
the checker's blocking rule and the commit. The provider is scripted by what
each request is: a selection, the same-idea question, a round of the agent, or
a check.
"""

import asyncio
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from delphi_core.memory import MEMORY_VERSION
from delphi_core.memory_maintenance import jobs
from delphi_core.memory_maintenance.pipeline import EveryPageDropped, run_job
from delphi_core.memory_maintenance.run import JobDeadline
from tests.test_memory_gather import Library
from tests.test_memory_maintain import call, calls, cite, closing, op, outputs

BODY = (
    "## Position encoding\n\n"
    "Sinusoidal encodings add a fixed signal to each token.\n\n"
    "Learned encodings are a table of vectors.\n"
)
ADDED = "Rotary schemes rotate pairs of dimensions by an angle that grows with position [N1]."
REPAIRED = "Rotary schemes rotate pairs of dimensions, with the angle set by the position [N1]."
SELECTED = {"nothingToFile": False, "reason": "It extends position encoding.", "pages": ["position-encoding"], "needsOutside": None}
NOTHING = {"nothingToFile": True, "reason": "Memory already says all of this.", "pages": [], "needsOutside": None}
NO_SAME_IDEA = {"nothingToFile": False, "reason": "No page explains it.", "pages": [], "needsOutside": None}
CLEAN = {"objections": []}
NOT_FOUND = {"claims": []}


def objection(slug="position-encoding", quote="rotate pairs of dimensions by an angle"):
    return {"objections": [{
        "slug": slug, "finding": "differs", "quote": quote,
        "explanation": "The passage says the angle is set by position, not that it grows.", "evidenceId": None,
    }]}


def edit(text=ADDED, **given) -> dict:
    return {"slug": "position-encoding", "operations": [op("insert_after", block="b3", markdown=text)],
            "citations": [cite("N1", page=2)], "calculations": [], "summary": "", "aliases": [],
            "note": "added rotary schemes", **given}


def create(title, **given) -> dict:
    return {"title": title, "aliases": [], "domain": "ml", "summary": f"What {title} is.",
            "body": f"## {title}\n\nRelative offsets are rotated in pairs [N1].", "citations": [cite("N1", page=2)],
            "calculations": [], "note": f"new page for {title}", "distinctFrom": [], "distinctReason": "", **given}


class Run:
    """A library with one PDF, Memory with its source page and one concept, and a claimed document job."""

    def __init__(self, tmp_path, **settings):
        self.library = Library(tmp_path, openai_api_key="test-key", **settings)
        self.library.pdf()
        self.storage, self.settings = self.library.storage, self.library.settings
        for row in (
            {"kind": "source", "domain": "ml", "title": "Rotary Position Embedding", "summary": "Its digest.",
             "body": "The digest. See [[position-encoding]].\n", "sourcePaperId": "p1", "sourceProjectId": self.library.project},
            {"kind": "concept", "domain": "ml", "title": "Position encoding", "summary": "How order reaches a model.", "body": BODY},
        ):
            self.storage.upsert_memory_page("reader", row, max_pages=50)
        self.sent: list[dict] = []
        self.job = self.claim()

    def claim(self, marker=None):
        marker = marker or jobs.document_marker("p1")
        self.storage.enqueue_memory_job(
            "reader", kind="document", marker=marker,
            payload={"projectId": self.library.project, "paperId": "p1"}, target_version=MEMORY_VERSION,
        )
        now = datetime.now(UTC)
        while True:
            job = self.storage.claim_memory_job(
                "reader", now=now.isoformat(), lease_expires_at=(now + timedelta(minutes=5)).isoformat(), max_attempts=3
            )
            assert job is not None, f"no job to claim for {marker}"
            if job["marker"] == marker:
                return job

    async def run(self, *, select=SELECTED, agent=(), checks=(CLEAN,), same=NO_SAME_IDEA, job=None, slow=0.0, before_check=None,
                  research=(), found=(NOT_FOUND,)):
        """Run the job against a provider that answers each kind of request from its own script."""
        rounds, verdicts, passes, finds = list(agent), list(checks), list(research), list(found)

        async def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            self.sent.append(body)
            name = ((body.get("text") or {}).get("format") or {}).get("name")
            if slow:
                await asyncio.sleep(slow)
            if name == "memory_file_selection":
                question_two = "Question two" in body["input"][-1]["content"]
                return self._answer(same if question_two else select)
            if name == "research_findings":
                # A research pass, streamed: only a web-evidence job asks one.
                return httpx.Response(200, content=passes.pop(0) if len(passes) > 1 else passes[0])
            if name == "memory_verdicts":
                if before_check:
                    before_check()
                return self._answer(verdicts.pop(0) if len(verdicts) > 1 else verdicts[0])
            if name == "memory_claim_passages":
                return self._answer(finds.pop(0) if len(finds) > 1 else finds[0])
            return httpx.Response(200, content=rounds.pop(0) if len(rounds) > 1 else rounds[0])

        events = []
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            async for event in run_job(
                job or self.job, http=http, storage=self.storage, objects=self.library.objects, username="reader",
                settings=self.settings, use_standard_tier=True,
            ):
                events.append(event)
        return events

    @staticmethod
    def _answer(answer: dict) -> httpx.Response:
        return httpx.Response(200, json={
            "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(answer)}]}],
            "usage": {"input_tokens": 500, "output_tokens": 20},
        })

    def kinds(self) -> list[str]:
        """What each request the provider got was: select, same, research, check, find, or agent."""
        said = []
        for body in self.sent:
            name = ((body.get("text") or {}).get("format") or {}).get("name")
            if name == "research_findings":
                said.append("research")
            elif name == "memory_claim_passages":
                said.append("find")
            elif name == "memory_file_selection":
                said.append("same" if "Question two" in body["input"][-1]["content"] else "select")
            else:
                said.append("check" if name == "memory_verdicts" else "agent")
        return said

    def page(self, slug="position-encoding"):
        return self.storage.get_memory_page("reader", slug)

    def events(self):
        return self.storage.list_memory_events("reader", limit=20)


def result(events):
    assert events[-1]["type"] == "_memory_result"
    return events[-1]


@pytest.mark.anyio
async def test_a_document_job_edits_the_page_it_bears_on_and_is_not_run_twice(tmp_path):
    run = Run(tmp_path)
    events = await run.run(agent=(calls(call("edit_memory", edit(), "c1")), closing("Added rotary schemes to position encoding.")))

    assert [event["stage"] for event in events[:-1]] == [
        "memory_gather", "memory_select", "memory_maintain", "memory_verify", "memory_commit"]
    done = result(events)
    assert done["outcome"] == "filed" and [page["slug"] for page in done["pages"]] == ["position-encoding"]
    assert run.kinds() == ["select", "agent", "agent", "check"]
    page = run.page()
    assert page["revision"] == 2
    # Every block the edit did not name is there word for word, and the new one is cited.
    assert BODY.strip() in page["body"] and "Rotary schemes rotate pairs" in page["body"]
    assert [(c["claimType"], c["paperId"], c["page"]) for c in page["citations"]] == [("author-claim", "p1", 2)]
    event = run.events()[0]
    assert (event["kind"], event["requestId"], event["outcome"]) == ("document", "paper:p1", "filed")
    assert event["summary"] == "Added rotary schemes to position encoding."
    assert event["selection"]["pages"] == ["position-encoding"]
    assert run.storage.list_page_versions("reader", "position-encoding")[0]["trigger"] == "document"

    # The same claimed job again, as after a crash between the commit and the
    # job's removal: found by its operation, and no model is asked anything.
    asked = len(run.sent)
    again = await run.run(agent=(closing("unused"),))
    assert result(again) == {
        "type": "_memory_result", "pages": [], "reused": True, "fingerprint": event["fingerprint"]}
    assert done["fingerprint"] == event["fingerprint"]
    assert len(run.sent) == asked and run.page()["revision"] == 2


@pytest.mark.anyio
async def test_nothing_to_file_ends_at_the_cheap_call_and_settles_the_marker(tmp_path):
    run = Run(tmp_path)
    # A concept page was written from this document before: whether there is more is the selection's to say.
    run.storage.upsert_memory_page("reader", {
        "kind": "concept", "domain": "ml", "title": "Rotary embeddings", "summary": "Rotations as position.",
        "body": "Rotations.\n", "sourcePaperId": "p1", "sourceProjectId": run.library.project}, max_pages=50)
    done = result(await run.run(select=NOTHING, agent=(closing("unused"),)))
    assert done["outcome"] == "nothing" and done["pages"] == []
    assert run.kinds() == ["select"]
    assert run.page()["revision"] == 1
    event = run.events()[0]
    assert event["outcome"] == "nothing" and event["summary"] == "Memory already says all of this."
    assert run.storage.has_memory_event("reader", "paper:p1")


@pytest.mark.anyio
async def test_an_agent_that_stages_nothing_ends_nothing_without_a_check(tmp_path):
    run = Run(tmp_path)
    done = result(await run.run(agent=(closing("The page already says this."),)))
    assert done["outcome"] == "nothing" and run.kinds() == ["select", "agent"]
    assert run.events()[0]["summary"] == "The page already says this."


@pytest.mark.anyio
async def test_a_blocked_page_is_repaired_once_and_then_commits(tmp_path):
    run = Run(tmp_path)
    done = result(await run.run(
        agent=(
            calls(call("edit_memory", edit(), "c1")), closing("Added it."),
            calls(call("edit_memory", edit(REPAIRED), "c2")), closing("Corrected the angle."),
        ),
        checks=(objection(), CLEAN),
    ))
    assert done["outcome"] == "filed"
    assert run.kinds() == ["select", "agent", "agent", "check", "agent", "agent", "check"]
    assert "with the angle set by the position" in run.page()["body"] and "grows with position" not in run.page()["body"]
    # The repair was asked for with the checker's own quote.
    repair = next(body for body in run.sent[4:] if "tools" in body)
    assert "rotate pairs of dimensions by an angle" in json.dumps(repair["input"][-1])
    assert run.events()[0]["dropped"] == []


OFF_BY_ONE = "Relative offsets are rotated in pairs [N1]."


def unsupported(quote):
    return {"objections": [{
        "slug": "position-encoding", "finding": "unsupported", "quote": quote,
        "explanation": "Page 3 does not say this.", "evidenceId": "p1",
    }]}


@pytest.mark.anyio
async def test_a_true_claim_cited_one_page_off_is_given_its_page_without_a_repair(tmp_path):
    run = Run(tmp_path)
    done = result(await run.run(
        agent=(calls(call("edit_memory", edit(OFF_BY_ONE, citations=[cite("N1", page=3)]), "c1")), closing("Added it.")),
        checks=(unsupported("Relative offsets are rotated in pairs"), CLEAN),
    ))
    assert done["outcome"] == "filed"
    # No author was asked to repair it: Delphi found the page, and the checker read it.
    assert run.kinds() == ["select", "agent", "agent", "check", "check"]
    second = json.dumps(run.sent[-1]["input"])
    assert "Relative offsets are rotated in pairs." in second
    page = run.page()
    assert "Relative offsets are rotated in pairs [E1][E2]." in page["body"]
    assert [(c["paperId"], c["page"]) for c in page["citations"]] == [("p1", 3), ("p1", 2)]
    event = run.events()[0]
    assert event["recited"] == [{
        "slug": "position-encoding", "quote": "Relative offsets are rotated in pairs", "source": "p1", "cited": [3], "page": 2,
        "added": [2], "how": "words"}]
    # What blocked the page is kept on the event, with what came of it.
    assert [(item["check"], item["finding"], item["recited"]) for item in event["blocked"]] == [(1, "unsupported", True)]


@pytest.mark.anyio
async def test_the_page_found_is_kept_through_the_authors_repair_of_another_objection(tmp_path):
    run = Run(tmp_path)
    both = {"objections": [*unsupported("Relative offsets are rotated in pairs")["objections"], *objection()["objections"]]}
    first, repaired = (f"{OFF_BY_ONE}\n\n{text}" for text in (ADDED, REPAIRED))
    done = result(await run.run(
        agent=(
            calls(call("edit_memory", edit(first, citations=[cite("N1", page=3)]), "c1")), closing("Added it."),
            calls(call("edit_memory", edit(repaired, citations=[cite("N1", page=3)]), "c2")), closing("Corrected the angle."),
        ),
        checks=(both, CLEAN),
    ))
    assert done["outcome"] == "filed"
    # The author is asked only about what Delphi could not settle.
    repair = json.dumps(next(body for body in run.sent[4:] if "tools" in body)["input"][-1])
    assert "rotate pairs of dimensions by an angle" in repair and "Relative offsets are rotated in pairs" not in repair
    body = run.page()["body"]
    assert "Relative offsets are rotated in pairs [E1][E2]." in body and "with the angle set by the position [E1]." in body


@pytest.mark.anyio
async def test_a_claim_the_document_holds_nowhere_still_goes_to_the_repair(tmp_path):
    run = Run(tmp_path)
    done = result(await run.run(
        agent=(
            calls(call("edit_memory", edit(), "c1")), closing("Added it."),
            calls(call("edit_memory", edit(REPAIRED), "c2")), closing("Corrected it."),
        ),
        checks=(unsupported("rotate pairs of dimensions by an angle that grows with position"), CLEAN),
    ))
    assert done["outcome"] == "filed"
    # Words placed it nowhere, and the finder named no passage: the author repairs it.
    assert run.kinds() == ["select", "agent", "agent", "check", "find", "agent", "agent", "check"]
    assert run.events()[0]["recited"] == []
    assert [(item["check"], item["recited"]) for item in run.events()[0]["blocked"]] == [(1, False)]


PARAPHRASED = "Positions are encoded as a turn of each coordinate pair by a relative amount [N1]."


def found(passage, sentence, claim=1):
    return {"claims": [{"claim": claim, "found": [{"passage": passage, "sentence": sentence}]}]}


@pytest.mark.anyio
async def test_a_claim_the_document_words_differently_is_placed_by_the_finder(tmp_path):
    run = Run(tmp_path)
    done = result(await run.run(
        agent=(calls(call("edit_memory", edit(PARAPHRASED, citations=[cite("N1", page=3)]), "c1")), closing("Added it.")),
        checks=(unsupported("Positions are encoded as a turn of each coordinate pair"), CLEAN),
        # The finder is shown the document's other pages, numbered, and copies the sentence from page 2.
        found=(found(2, "Relative offsets are rotated in pairs."),),
    ))
    assert done["outcome"] == "filed"
    assert run.kinds() == ["select", "agent", "agent", "check", "find", "check"]
    asked = json.dumps(next(body for body in run.sent if (body.get("text") or {}).get("format", {}).get("name") == "memory_claim_passages")["input"])
    assert "Positions are encoded as a turn" in asked and "Relative offsets are rotated in pairs." in asked
    page = run.page()
    assert "by a relative amount [E1][E2]." in page["body"]
    assert [(c["paperId"], c["page"]) for c in page["citations"]] == [("p1", 3), ("p1", 2)]
    assert run.events()[0]["recited"][0]["how"] == "model"


@pytest.mark.anyio
async def test_a_passage_the_finder_names_without_its_sentence_is_set_aside(tmp_path):
    run = Run(tmp_path)
    done = result(await run.run(
        agent=(
            calls(call("edit_memory", edit(PARAPHRASED, citations=[cite("N1", page=3)]), "c1")), closing("Added it."),
            calls(call("edit_memory", edit(REPAIRED), "c2")), closing("Corrected it."),
        ),
        checks=(unsupported("Positions are encoded as a turn of each coordinate pair"), CLEAN),
        # A sentence page 2 does not hold: no passage is taken, and the author repairs the claim.
        found=(found(1, "Positions are turned pair by pair by a relative amount."),),
    ))
    assert done["outcome"] == "filed"
    assert run.kinds() == ["select", "agent", "agent", "check", "find", "agent", "agent", "check"]
    assert run.events()[0]["recited"] == []


@pytest.mark.anyio
async def test_a_finder_that_fails_finds_nothing_and_the_job_goes_on(tmp_path):
    run = Run(tmp_path)
    done = result(await run.run(
        agent=(
            calls(call("edit_memory", edit(PARAPHRASED, citations=[cite("N1", page=3)]), "c1")), closing("Added it."),
            calls(call("edit_memory", edit(REPAIRED), "c2")), closing("Corrected it."),
        ),
        checks=(unsupported("Positions are encoded as a turn of each coordinate pair"), CLEAN),
        found=({"not": "the shape asked for"},),
    ))
    assert done["outcome"] == "filed" and run.events()[0]["recited"] == []


@pytest.mark.anyio
async def test_a_page_blocked_twice_is_dropped_and_the_stored_page_is_untouched(tmp_path):
    run = Run(tmp_path)
    with pytest.raises(EveryPageDropped, match="Position encoding"):
        await run.run(
            agent=(
                calls(call("edit_memory", edit(), "c1")), closing("Added it."),
                calls(call("edit_memory", edit(ADDED + " It is exact."), "c2")), closing("Tried again."),
            ),
            checks=(objection(), objection()),
        )
    page = run.page()
    assert page["revision"] == 1 and page["body"].strip() == BODY.strip()
    event = run.events()[0]
    assert event["outcome"] == "failed" and event["pages"] == []
    assert [(item["slug"], item["action"]) for item in event["dropped"]] == [("position-encoding", "edit")]
    assert event["dropped"][0]["quote"] == "rotate pairs of dimensions by an angle"
    # Why the sentence was not struck instead, and the page as staged: what a lost page is diagnosed from.
    # The sentence leaning on it goes with it, and the page's old text cites nothing to keep.
    assert event["dropped"][0]["unstruck"] == "no cited block would be left"
    assert "It is exact." in event["dropped"][0]["body"]
    # The marker is not settled: the job is tried again.
    assert not run.storage.has_memory_event("reader", "paper:p1")


@pytest.mark.anyio
async def test_a_page_the_repair_left_as_it_was_is_dropped_without_a_second_check(tmp_path):
    run = Run(tmp_path)
    with pytest.raises(EveryPageDropped):
        await run.run(
            agent=(calls(call("edit_memory", edit(), "c1")), closing("Added it."), closing("The objection cannot be met.")),
            checks=(objection(), CLEAN),
        )
    assert run.kinds().count("check") == 1 and run.page()["revision"] == 1


@pytest.mark.anyio
async def test_one_dropped_page_does_not_sink_the_page_that_passed(tmp_path):
    run = Run(tmp_path)
    done = result(await run.run(
        agent=(
            calls(call("edit_memory", edit(), "c1"), call("create_memory", create("Rotary embeddings"), "c2")),
            closing("Edited one page and created one."),
            closing("The objection cannot be met."),
        ),
        checks=(objection(),),
    ))
    assert done["outcome"] == "filed" and [page["slug"] for page in done["pages"]] == ["rotary-embeddings"]
    assert run.page()["revision"] == 1
    assert run.page("rotary-embeddings")["sourcePaperId"] == "p1"
    assert [item["slug"] for item in run.events()[0]["dropped"]] == ["position-encoding"]


@pytest.mark.anyio
async def test_what_had_no_room_is_queued_as_a_follow_up_of_the_same_document(tmp_path):
    run = Run(tmp_path)
    done = result(await run.run(agent=(
        calls(
            call("create_memory", create("Rotary embeddings"), "c1"),
            call("create_memory", create("Relative offsets"), "c2"),
            call("create_memory", create("Paired rotation"), "c3"),
        ),
        closing("Created two pages; paired rotation is left for a later run."),
    )))
    assert done["outcome"] == "filed" and len(done["pages"]) == 2
    queued = {job["marker"]: job for job in run.storage.list_memory_jobs("reader")}
    follow_up = queued[jobs.document_marker("p1", 1)]
    assert follow_up["kind"] == "document" and follow_up["payload"]["paperId"] == "p1"


@pytest.mark.anyio
async def test_a_job_out_of_time_fails_with_the_reason_deadline_and_writes_nothing(tmp_path):
    run = Run(tmp_path, memory_job_deadline_seconds=0.05)
    with pytest.raises(JobDeadline, match="deadline"):
        await run.run(agent=(closing("unused"),), slow=0.2)
    assert run.events() == [] and run.page()["revision"] == 1


@pytest.mark.anyio
async def test_a_page_changed_while_the_job_ran_refuses_the_commit(tmp_path):
    from delphi_core.memory_maintenance.run import StaleRevision

    run = Run(tmp_path)

    def another_job_commits():
        page = run.page()
        run.storage.upsert_memory_page(
            "reader", {**page, "body": page["body"] + "\nAnother job's line.\n", "expectedRevision": 1}, max_pages=50)

    # After the agent read the page at revision 1, and before this job commits.
    with pytest.raises(StaleRevision):
        await run.run(agent=(calls(call("edit_memory", edit(), "c1")), closing("Added it.")), before_check=another_job_commits)
    assert "Another job's line." in run.page()["body"] and "Rotary schemes" not in run.page()["body"]
    assert run.events() == []


TWO_FACTS = (
    "## Rotary embeddings\n\nRelative offsets are rotated in pairs [N1].\n\n"
    "Pairs of dimensions are rotated by position. The angle doubles with every layer [N1].\n\n"
    "Order is injected without a learned table [N1]."
)


def create_two_facts(body=TWO_FACTS):
    return create("Rotary embeddings", body=body, citations=[cite("N1", page=2)])


def sent_checks(run):
    return [json.dumps(body["input"]) for body in run.sent if (body.get("text") or {}).get("format", {}).get("name") == "memory_verdicts"]


def unsupported_on(slug, quote):
    return {"objections": [{"slug": slug, "finding": "unsupported", "quote": quote,
                            "explanation": "Page 2 does not say this.", "evidenceId": "p1"}]}


@pytest.mark.anyio
async def test_a_repair_that_changes_nothing_strikes_the_sentence_and_checks_only_that_block(tmp_path):
    run = Run(tmp_path)
    done = result(await run.run(
        agent=(calls(call("create_memory", create_two_facts(), "c1")), closing("Created it."), closing("It cannot be met.")),
        checks=(unsupported_on("rotary-embeddings", "The angle doubles with every layer"), CLEAN),
    ))
    assert done["outcome"] == "filed"
    assert run.kinds()[-4:] == ["check", "find", "agent", "check"]
    body = run.page("rotary-embeddings")["body"]
    assert "doubles" not in body and "Pairs of dimensions are rotated by position. [E1]" in body
    assert "Relative offsets are rotated in pairs [E1]." in body and "without a learned table [E1]." in body
    # The second check was shown the struck block alone: the rest had passed.
    second = sent_checks(run)[1]
    assert "Pairs of dimensions are rotated by position." in second and "without a learned table" not in second
    assert 'again=\\"true\\"' in second
    [record] = run.events()[0]["blocked"]
    assert (record["check"], record["struck"], record["recited"]) == (1, True, False)


@pytest.mark.anyio
async def test_a_page_still_blocked_after_its_repair_is_struck_once_and_checked_a_third_time(tmp_path):
    repaired = TWO_FACTS.replace("The angle doubles with every layer", "The angle halves with every layer")
    run = Run(tmp_path)
    done = result(await run.run(
        agent=(
            calls(call("create_memory", create_two_facts(), "c1")), closing("Created it."),
            calls(call("create_memory", create_two_facts(repaired), "c2")), closing("Corrected it."),
        ),
        checks=(
            unsupported_on("rotary-embeddings", "The angle doubles with every layer"),
            unsupported_on("rotary-embeddings", "The angle halves with every layer"),
            CLEAN,
        ),
    ))
    assert done["outcome"] == "filed" and run.kinds().count("check") == 3
    assert "halves" not in run.page("rotary-embeddings")["body"]
    checks = sent_checks(run)
    # Each later check reads only what changed since the one before it passed the rest.
    assert "rotated in pairs [E1]" in checks[0]
    assert "rotated in pairs [E1]" not in checks[1] and "halves" in checks[1]
    assert "halves" not in checks[2] and "Pairs of dimensions are rotated by position." in checks[2]
    assert [(item["check"], item["struck"]) for item in run.events()[0]["blocked"]] == [(1, False), (2, True)]


@pytest.mark.anyio
async def test_a_page_that_passed_is_not_shown_to_the_second_check(tmp_path):
    run = Run(tmp_path)
    await run.run(
        agent=(
            calls(call("edit_memory", edit(), "c1"), call("create_memory", create_two_facts(), "c2")), closing("Two pages."),
            calls(call("edit_memory", edit(REPAIRED), "c3")), closing("Corrected the angle."),
        ),
        checks=(objection(), CLEAN),
    )
    second = sent_checks(run)[1]
    assert "with the angle set by the position" in second and "Rotary embeddings" not in second


class OtherJob:
    """Another job, committing a page while this one runs (the drain runs jobs side by side)."""

    def __init__(self, run, title="Rotary embeddings"):
        self.run, self.title, self.done = run, title, False

    def __call__(self):
        if not self.done:
            self.done = True
            self.run.storage.upsert_memory_page("reader", {
                "kind": "concept", "domain": "ml", "title": self.title, "summary": "Written by another job.",
                "body": "Another job's page.\n"}, max_pages=50)


@pytest.mark.anyio
async def test_a_page_whose_name_another_job_took_is_not_repaired_but_filed_again(tmp_path):
    from delphi_core.memory_maintenance.run import StaleRevision

    run = Run(tmp_path)
    with pytest.raises(StaleRevision, match="rotary-embeddings"):
        await run.run(
            agent=(calls(call("create_memory", create_two_facts(), "c1")), closing("Created it."), closing("unused")),
            checks=(unsupported_on("rotary-embeddings", "The angle doubles with every layer"),),
            before_check=OtherJob(run),
        )
    # The other job's page stands, and no repair was asked of a page that can no longer be created.
    assert run.page("rotary-embeddings")["body"] == "Another job's page.\n"
    assert "agent" not in run.kinds()[run.kinds().index("check"):]


@pytest.mark.anyio
async def test_a_page_another_job_wrote_while_this_one_was_checked_stops_the_commit(tmp_path):
    from delphi_core.memory_maintenance.run import StaleRevision

    run = Run(tmp_path)
    with pytest.raises(StaleRevision):
        await run.run(
            agent=(calls(call("create_memory", create_two_facts(), "c1")), closing("Created it.")),
            before_check=OtherJob(run),
        )
    assert run.page("rotary-embeddings")["body"] == "Another job's page.\n" and run.events() == []


@pytest.mark.anyio
async def test_the_same_idea_written_by_another_job_under_another_name_stops_the_commit(tmp_path):
    from delphi_core.memory_maintenance.run import StaleRevision

    run = Run(tmp_path)
    rope = {"nothingToFile": False, "reason": "RoPE explains it.", "pages": ["rope"], "needsOutside": None}
    with pytest.raises(StaleRevision, match="rotary-embeddings"):
        await run.run(
            agent=(calls(call("create_memory", create_two_facts(), "c1")), closing("Created it.")),
            same=rope, before_check=OtherJob(run, title="RoPE"),
        )
    assert run.kinds()[-1] == "same" and run.events() == []


@pytest.mark.anyio
async def test_a_same_idea_question_that_fails_before_the_commit_does_not_fail_a_checked_job(tmp_path, monkeypatch):
    from delphi_core.memory_maintenance import pipeline
    from delphi_core.memory_maintenance.select import SelectionUnreadable

    run = Run(tmp_path)
    other = OtherJob(run, title="RoPE")
    checked = []

    async def same_idea(*_args, **_kwargs):
        if checked:
            raise SelectionUnreadable("the provider answered nothing readable")
        return []

    def during_the_check():
        checked.append(True)
        other()

    monkeypatch.setattr(pipeline, "same_idea", same_idea)
    done = result(await run.run(
        agent=(calls(call("create_memory", create_two_facts(), "c1")), closing("Created it.")),
        before_check=during_the_check,
    ))
    # Another job wrote a concept page meanwhile, the question about it failed, and the page is filed.
    assert done["outcome"] == "filed" and run.page("rotary-embeddings")["title"] == "Rotary embeddings"


@pytest.mark.anyio
async def test_a_document_whose_filing_only_edited_pages_is_refiled_on_the_selections_word(tmp_path):
    run = Run(tmp_path)
    first = result(await run.run(agent=(calls(call("edit_memory", edit(), "c1")), closing("Added rotary schemes."))))
    assert first["outcome"] == "filed"
    run.storage.complete_memory_job("reader", run.job["id"], fingerprint=first["fingerprint"])
    run.sent.clear()
    run.job = run.claim()
    # No concept page was created from it, but it was filed: "nothing" is final.
    done = result(await run.run(select=NOTHING, agent=(closing("unused"),)))
    assert done["outcome"] == "nothing" and run.kinds() == ["select"]


@pytest.mark.anyio
async def test_what_the_second_check_objects_to_is_re_cited_before_anything_is_struck(tmp_path):
    # Round 5b struck three true claims at the second check, which tried no re-cite.
    repaired = TWO_FACTS.replace("The angle doubles with every layer", "The angle halves with every layer")
    run = Run(tmp_path)
    done = result(await run.run(
        agent=(
            calls(call("create_memory", create_two_facts(), "c1")), closing("Created it."),
            calls(call("create_memory", create_two_facts(repaired), "c2")), closing("Corrected it."),
        ),
        checks=(
            unsupported_on("rotary-embeddings", "The angle doubles with every layer"),
            # The second check reads the block the repair changed, and objects to the sentence it rewrote.
            unsupported_on("rotary-embeddings", "The angle halves with every layer"),
            CLEAN,
        ),
        found=(NOT_FOUND, found(1, "Order is injected by adding a sinusoid to each token.")),
    ))
    assert done["outcome"] == "filed" and run.kinds().count("check") == 3 and run.kinds().count("find") == 2
    body = run.page("rotary-embeddings")["body"]
    assert "Pairs of dimensions are rotated by position. The angle halves with every layer [E1][E2]." in body
    records = run.events()[0]["blocked"]
    assert [(item["check"], item["recited"], item["struck"]) for item in records] == [(1, False, False), (2, True, False)]


@pytest.mark.anyio
async def test_a_later_check_cannot_block_a_claim_an_earlier_check_passed_in_the_same_words(tmp_path):
    # Control-2 (Chimera, 2026-10-20): a clause two checks had passed was refused by the third,
    # which re-read its paragraph only because a re-cite had changed the paragraph's markers.
    repaired = TWO_FACTS.replace("The angle doubles with every layer", "The angle halves with every layer")
    run = Run(tmp_path)
    done = result(await run.run(
        agent=(
            calls(call("create_memory", create_two_facts(), "c1")), closing("Created it."),
            calls(call("create_memory", create_two_facts(repaired), "c2")), closing("Corrected it."),
        ),
        checks=(
            unsupported_on("rotary-embeddings", "The angle doubles with every layer"),
            # Shown again beside the rewritten sentence, the sentence the first check passed is objected to.
            unsupported_on("rotary-embeddings", "Pairs of dimensions are rotated by position"),
        ),
        found=(NOT_FOUND,),
    ))
    # Its verdict stands: the objection is advice, nothing is re-cited or struck, and no third check runs.
    assert done["outcome"] == "filed" and run.kinds().count("check") == 2 and run.kinds().count("find") == 1
    assert "Pairs of dimensions are rotated by position. The angle halves with every layer [E1]." in run.page("rotary-embeddings")["body"]
    event = run.events()[0]
    assert [(item["check"], item["quote"]) for item in event["blocked"]] == [(1, "The angle doubles with every layer")]
    assert event["advisory"]["count"] == 1


@pytest.mark.anyio
async def test_the_last_check_strikes_what_it_still_blocks_and_files_the_rest(tmp_path):
    # Before, a claim the third check still objected to took its page with it.
    repaired = TWO_FACTS.replace("The angle doubles with every layer", "The angle halves with every layer")
    run = Run(tmp_path)
    done = result(await run.run(
        agent=(
            calls(call("create_memory", create_two_facts(), "c1")), closing("Created it."),
            calls(call("create_memory", create_two_facts(repaired), "c2")), closing("Corrected it."),
        ),
        checks=(
            unsupported_on("rotary-embeddings", "The angle doubles with every layer"),
            unsupported_on("rotary-embeddings", "The angle halves with every layer"),
            # Re-cited after the second check, and still refused by the last.
            unsupported_on("rotary-embeddings", "The angle halves with every layer"),
        ),
        found=(NOT_FOUND, found(1, "Order is injected by adding a sinusoid to each token.")),
    ))
    assert done["outcome"] == "filed" and run.kinds().count("check") == 3
    body = run.page("rotary-embeddings")["body"]
    assert "The angle halves" not in body
    assert "Relative offsets are rotated in pairs" in body and "Pairs of dimensions are rotated by position." in body
    event = run.events()[0]
    assert event["dropped"] == [] and [(item["check"], item["struck"]) for item in event["blocked"]][-1] == (3, True)


@pytest.mark.anyio
async def test_a_domain_its_author_named_by_slug_is_titled_in_words(tmp_path):
    # Round 5b titled two new domains "Scaling-laws" and "Llm-architectures".
    run = Run(tmp_path)
    page = create("Rotary embeddings", domain="llm-architectures",
                  body="## Rotary embeddings\n\nLLM attention rotates relative offsets in pairs [N1].")
    done = result(await run.run(agent=(calls(call("create_memory", page, "c1")), closing("Created it."))))
    assert done["outcome"] == "filed"
    titles = {domain["slug"]: domain["title"] for domain in run.storage.memory_domains("reader")}
    assert titles["llm-architectures"] == "LLM architectures"


@pytest.mark.anyio
async def test_each_check_records_what_came_of_its_own_objections(tmp_path):
    # Round 5c: a claim re-cited after the first check and struck after the second was recorded
    # as re-cited and struck by both checks.
    body = "## Rotary embeddings\n\nRelative offsets are rotated in pairs [N1].\n\nOrder is injected without a learned table [N2]."
    page = create("Rotary embeddings", body=body, citations=[cite("N1", page=3), cite("N2", page=1)])
    run = Run(tmp_path)
    done = result(await run.run(
        agent=(calls(call("create_memory", page, "c1")), closing("Created it.")),
        checks=(
            unsupported_on("rotary-embeddings", "Relative offsets are rotated in pairs"),
            unsupported_on("rotary-embeddings", "Relative offsets are rotated in pairs"),
        ),
    ))
    # Words gave it page 2 after the first check; after the second the finder found nothing,
    # and the paragraph struck leaves nothing for a third check to read.
    assert done["outcome"] == "filed" and run.kinds()[-3:] == ["check", "check", "find"]
    assert "Relative offsets" not in run.page("rotary-embeddings")["body"]
    records = run.events()[0]["blocked"]
    assert [(item["check"], item["recited"], item["struck"]) for item in records] == [(1, True, False), (2, False, True)]


def _with_a_neighbour(run):
    """Chinchilla in the library, and a page one link from the start that cites its page 1."""
    from tests.helpers import seed_paper

    seed_paper(run.settings, "reader", run.library.project, {"id": "ch", "title": "Chinchilla", "pages": 2, "filename": "c.pdf"},
               text="--- Page 1 ---\nOur fitted exponents are 0.50 and 0.49.\n--- Page 2 ---\nAppendix.")
    run.storage.upsert_memory_page("reader", {
        "kind": "concept", "domain": "ml", "title": "Scaling laws", "slug": "scaling-laws", "summary": "s",
        "body": "Chinchilla fits exponents near 0.50 [E1]. See [[position-encoding]].",
        "citations": [{"id": 1, "claimType": "author-claim", "paperId": "ch", "page": 1}]}, max_pages=50)


CONNECTION = ("Rotary schemes rotate pairs of dimensions by an angle that grows with position [N1], while "
              "[[scaling-laws]] is about how compute is split, with exponents near 0.50 [N2].")


@pytest.mark.anyio
async def test_a_sentence_on_how_a_page_connects_cites_what_the_page_near_it_cites_and_the_check_reads_it(tmp_path):
    # Events 37 and 60, and the upgrade trial: a true connection to another document had nothing it could cite.
    run = Run(tmp_path)
    _with_a_neighbour(run)
    done = result(await run.run(agent=(
        calls(call("edit_memory", edit(CONNECTION, citations=[cite("N1", page=2), cite("N2", paperId="ch", page=1)]), "c1")),
        closing("Connected position encoding to scaling laws."),
    )))
    assert done["outcome"] == "filed"
    page = run.page()
    assert "with exponents near 0.50 [E" in page["body"]
    assert {(item.get("paperId"), item.get("page")) for item in page["citations"]} >= {("p1", 2), ("ch", 1)}
    # The writer was told where it may cite the other document, and the check was shown that passage.
    task = [item for item in run.sent if item.get("tools")][0]
    assert "a document of the library this run cannot read, cited by [[scaling-laws]]. Only at pages 1" in json.dumps(task["input"])
    assert "Our fitted exponents are 0.50 and 0.49." in sent_checks(run)[0]


@pytest.mark.anyio
async def test_another_document_is_cited_only_where_the_pages_near_the_start_cite_it(tmp_path):
    run = Run(tmp_path)
    _with_a_neighbour(run)
    await run.run(agent=(
        calls(call("edit_memory", edit(CONNECTION, citations=[cite("N1", page=2), cite("N2", paperId="ch", page=2)]), "c1")),
        closing("Tried to cite the appendix."),
    ))
    (refusal,) = [output for body in run.sent for output in outputs(body)][-1:]
    assert "Citation N2 cites page 2 of 'Chinchilla', which this run reaches only through Memory" in refusal


@pytest.mark.anyio
async def test_the_event_records_what_the_author_called_and_the_pages_it_read(tmp_path):
    run = Run(tmp_path)
    await run.run(agent=(
        calls(call("read_paper", {"paper_id": "p1", "pages": [2, 3]}, "r1")),
        calls(call("edit_memory", edit(), "c1")), closing("Read pages 2 and 3, then added rotary schemes."),
    ))
    telemetry = run.events()[0]["telemetry"]
    assert telemetry["tools"] == {"read_paper": 1, "edit_memory": 1} and telemetry["asked"] == ["2", "3"]
