"""
A finished session is filed: its job is held while the session is open, runs
once the reader has left, and files what rested on more than Memory.

Three layers, each on the store it needs:

- what the stores do on a turn and a note change, on every store (the
  `storage` fixture of the contract suite);
- what `gather_session` reads and what the commit settles, on every store;
- whole jobs through `pipeline.run_job`, with the journey rig's fixture as the
  only provider (`tests/test_e2e_provider.py::Filed`).

The first two are the kit's (`delphi_core_testkit.conformance.memory_sessions`).
"""

import httpx
import pytest

from delphi_core.config import Settings
from delphi_core.memory_maintenance import jobs
from delphi_core.memory_maintenance.gather_session import MAX_EXCHANGES, MEMORY_ONLY, WEB_CUT, gather_session
from delphi_core.memory_maintenance.pipeline import run_job
from delphi_core.storage import LocalObjectStore

from delphi_core_testkit.conformance.memory_sessions import (
    PAPER,
    storage,
    Reader,
    read_paper,
    memory_only,
    test_one_job_covers_a_documents_chats_in_two_tabs_and_its_note_changes,
    test_a_session_job_is_not_claimed_until_the_reader_leaves_the_app_is_launched_or_the_idle_limit_passes,
    test_a_change_that_arrives_while_the_job_runs_keeps_it_with_the_new_fingerprint,
    test_a_watermark_is_null_until_the_first_whole_answer_and_never_reads_as_file_all_history,
    test_only_a_whole_answer_holds_the_job,
    test_a_watermark_is_moved_only_to_a_request_the_conversation_still_holds,
    test_the_pages_that_cite_a_note_are_found_after_the_note_is_gone,
    test_a_document_session_gathers_every_tab_cites_what_the_answers_rested_on_and_files_its_notes_in_a_run_of_their_own,
    test_an_exchange_that_rests_on_memory_alone_is_skipped_and_still_settled,
    test_a_web_source_counts_only_while_web_evidence_is_on_and_its_paragraphs_are_cut_while_it_is_off,
    test_a_notes_text_cannot_close_its_fence,
    test_a_deleted_note_that_a_page_cites_is_said_plainly_and_the_page_is_where_the_agent_starts,
    test_an_edited_note_is_filed_again_from_the_pages_that_cite_it_as_it_read_before,
    test_the_commit_takes_a_deleted_notes_citation_off_a_page_the_agent_left_alone,
    test_a_session_longer_than_one_event_is_read_in_parts_and_nothing_gone_fails_it,
    test_a_continued_session_keeps_its_row_however_often_it_is_continued,
    test_edited_notes_whose_pages_one_run_cannot_write_wait_for_the_next_part,
    test_an_edited_note_is_not_stamped_while_a_page_citing_it_was_turned_away_and_only_once,
    test_a_deleted_notes_pages_count_against_what_one_run_may_write,
)

from tests.test_e2e_provider import AGENT, CHECK, SELECT, Filed, calls_made, kinds, provider


#: What this module runs from the kit, named so pyflakes counts the imports
#: above as used: it cannot see pytest collect them.
__all__ = [
    "PAPER",
    "storage",
    "Reader",
    "read_paper",
    "memory_only",
    "test_one_job_covers_a_documents_chats_in_two_tabs_and_its_note_changes",
    "test_a_session_job_is_not_claimed_until_the_reader_leaves_the_app_is_launched_or_the_idle_limit_passes",
    "test_a_change_that_arrives_while_the_job_runs_keeps_it_with_the_new_fingerprint",
    "test_a_watermark_is_null_until_the_first_whole_answer_and_never_reads_as_file_all_history",
    "test_only_a_whole_answer_holds_the_job",
    "test_a_watermark_is_moved_only_to_a_request_the_conversation_still_holds",
    "test_the_pages_that_cite_a_note_are_found_after_the_note_is_gone",
    "test_a_document_session_gathers_every_tab_cites_what_the_answers_rested_on_and_files_its_notes_in_a_run_of_their_own",
    "test_an_exchange_that_rests_on_memory_alone_is_skipped_and_still_settled",
    "test_a_web_source_counts_only_while_web_evidence_is_on_and_its_paragraphs_are_cut_while_it_is_off",
    "test_a_notes_text_cannot_close_its_fence",
    "test_a_deleted_note_that_a_page_cites_is_said_plainly_and_the_page_is_where_the_agent_starts",
    "test_an_edited_note_is_filed_again_from_the_pages_that_cite_it_as_it_read_before",
    "test_the_commit_takes_a_deleted_notes_citation_off_a_page_the_agent_left_alone",
    "test_a_session_longer_than_one_event_is_read_in_parts_and_nothing_gone_fails_it",
    "test_a_continued_session_keeps_its_row_however_often_it_is_continued",
    "test_edited_notes_whose_pages_one_run_cannot_write_wait_for_the_next_part",
    "test_an_edited_note_is_not_stamped_while_a_page_citing_it_was_turned_away_and_only_once",
    "test_a_deleted_notes_pages_count_against_what_one_run_may_write",
]


pytestmark = pytest.mark.kb_maintenance


@pytest.mark.parametrize("web_evidence", [False, True])
def test_read_url_claims_follow_the_web_evidence_rule(storage, tmp_path, web_evidence):
    reader = Reader(storage, LocalObjectStore(tmp_path))
    chat = reader.memory_chat()
    marker = f"session:conversation:{reader.conversation(chat, project=False)}"
    final_url = "https://example.org/paper?version=" + "v" * 220
    claim = f"Outside sources report that expiry matters ([Source paper]({final_url}))."
    # The request redirected; the trace retains the complete final result URL.
    # Pagination is several calls to the same source, not several sources.
    trace = [{"offset": 0, "entries": [
        {"kind": "tool", "tool": "read_url", "ok": True,
         "args": {"url": "https://example.org/redirect", "offset": offset},
         "results": [{"kind": "web", "url": final_url, "title": "Source paper"}]}
        for offset in (0, 1000)
    ]}]
    reader.ask(chat, "request_url001", answer=claim, memory=True, trace=trace)

    def gather():
        return gather_session(storage, reader.objects, "reader", Settings(memory_web_evidence=web_evidence),
                              reader.sessions()[marker])

    only_web = gather()
    assert only_web.skipped == ("" if web_evidence else MEMORY_ONLY)
    assert "expiry matters" not in only_web.brief

    reader.ask(chat, "request_url002", answer="The library paper measures 120 ms.\n\n" + claim,
               memory=True, trace=read_paper(PAPER) + trace)
    mixed = gather()
    assert not mixed.skipped
    assert [source.id for source in mixed.sources] == [PAPER]
    assert "The library paper measures 120 ms." in mixed.brief
    assert "expiry matters" not in mixed.brief and final_url not in mixed.brief
    if web_evidence:
        assert WEB_CUT in mixed.brief
        assert mixed.web_cited == ({"url": final_url, "title": "Source paper", "sentences": [claim]},)
    else:
        assert mixed.web_cited == ()


@pytest.mark.parametrize("outcome", [{"ok": False}, {"running": True}])
def test_unsuccessful_read_url_is_not_memory_evidence(storage, tmp_path, outcome):
    reader = Reader(storage, LocalObjectStore(tmp_path))
    chat = reader.memory_chat()
    marker = f"session:conversation:{reader.conversation(chat, project=False)}"
    url = "https://example.org/unavailable"
    reader.ask(chat, "request_url003", answer=f"A claim ([unavailable]({url})).", memory=True,
               trace=[{"offset": 0, "entries": [
                   {"kind": "tool", "tool": "read_url", **outcome, "args": {"url": url},
                    "results": [{"kind": "web", "url": url, "title": "Unavailable"}]}
               ]}])
    gathered = gather_session(storage, reader.objects, "reader", Settings(memory_web_evidence=True),
                              reader.sessions()[marker])
    assert gathered.skipped == MEMORY_ONLY
    assert gathered.web_cited == ()


# --- whole jobs, with the fixture as the provider --------------------------


class Sessions(Filed):
    """`Filed`, with a reader who chats and takes notes beside a document that is already filed."""

    async def filed_document(self, paper_id=PAPER, title="Cache paper"):
        self.pdf(paper_id, title)
        done, _ = await self.file(paper_id)
        assert done["outcome"] == "filed"
        self.reader = Reader(self.storage, self.objects, project=self.library.project, paper=paper_id)
        return f"prefix-reuse-{paper_id}"

    async def end(self, marker=None, *, complete=True):
        """The reader leaves: release the session, claim its job and run it. Returns (result, requests, job)."""
        marker = marker or f"session:paper:{self.reader.paper}"
        self.storage.release_memory_jobs("reader", kind="session", marker=marker)
        for queued in self.storage.list_memory_jobs("reader"):
            if queued["marker"] != marker:
                self.storage.clear_memory_job("reader", queued["marker"])
        job = self.reader.claim()
        assert job is not None and job["marker"] == marker, job
        result, sent = await self.run(job)
        kept = None
        if complete:
            kept = not self.storage.complete_memory_job("reader", job["id"], fingerprint=result["fingerprint"])
        return result, sent, (job, kept)

    async def run(self, job):
        before = len(provider.requests)
        transport = httpx.ASGITransport(app=self.provider, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport) as http:
            try:
                events = [event async for event in run_job(
                    job, http=http, storage=self.storage, objects=self.objects, username="reader",
                    settings=self.settings, use_standard_tier=True)]
            except httpx.HTTPStatusError:
                # The fixture answers what it will not play with a 500, and says why here.
                raise AssertionError(provider.refusals) from None
        return events[-1], provider.requests[before:]

    def events(self):
        return [event for event in self.storage.list_memory_events("reader", limit=50) if event["kind"] == "session"]


@pytest.mark.anyio
async def test_a_session_beside_a_document_deepens_its_concept_page_and_small_talk_ends_at_the_selection(tmp_path, monkeypatch):
    filed = Sessions(tmp_path, monkeypatch)
    slug = await filed.filed_document()
    reader, before = filed.reader, filed.page(slug)
    first, second = reader.tab(), reader.tab("second")
    reader.ask(first, "request_one001", "Worth keeping: does the prefix survive a new question?")
    reader.ask(second, "request_two002", "Thanks, that helps.")
    # Nothing is filed while the reader is still in the session.
    assert reader.claim() is None and filed.page(slug)["revision"] == before["revision"]

    done, sent, (_, kept) = await filed.end()

    assert provider.refusals == [] and done["outcome"] == "filed" and kept is False
    assert kinds(sent) == [SELECT, AGENT, AGENT, CHECK]
    assert [name for name, _ in calls_made(sent)] == ["edit_memory"]
    page = filed.page(slug)
    assert page["revision"] == before["revision"] + 1 and page["body"].startswith(before["body"].rstrip())
    assert provider.WORKED_OUT in page["body"]
    assert [(c["claimType"], c["paperId"], c["page"]) for c in page["citations"]][-1] == ("author-claim", PAPER, 1)
    # The revision says a conversation caused it, which is what "asked about" reads.
    history = filed.storage.page_history("reader", [slug])[slug]
    assert history["latest"]["trigger"] == "conversation" and history["asked"]["revision"] == page["revision"]
    [event] = filed.events()
    assert (event["requestId"], event["outcome"], event["pages"]) == (f"session:paper:{PAPER}", "filed", [slug])
    assert event["requestIds"] == ["request_one001", "request_two002"]
    # Named as the reader knows the document, so Written by still can once it is deleted.
    assert event["title"] == "Cache paper"
    assert [item.get("title") for item in filed.storage.list_memory_events("reader") if item["kind"] == "document"] == ["Cache paper"]
    assert (reader.watermark(first), reader.watermark(second)) == ("request_one001", "request_two002")
    assert reader.sessions() == {}

    # A session of small talk afterwards: the cheap call, no agent, no page change.
    reader.ask(first, "request_three3", "Good morning.")
    done, sent, _ = await filed.end()
    assert kinds(sent) == [SELECT] and done["outcome"] == "nothing" and done["pages"] == []
    assert filed.page(slug)["revision"] == page["revision"]
    assert filed.events()[0]["outcome"] == "nothing" and reader.watermark(first) == "request_three3"


@pytest.mark.anyio
async def test_a_memory_chat_that_read_a_document_files_and_one_that_only_reread_memory_asks_no_model(tmp_path, monkeypatch):
    filed = Sessions(tmp_path, monkeypatch)
    slug = await filed.filed_document()
    reader = filed.reader
    chat = reader.memory_chat()
    marker = f"session:conversation:{reader.conversation(chat, project=False)}"
    filed.storage.set_conversation_title(
        "reader", reader.conversation(chat, project=False), title="What do I know?", model="m", updated_at="2026-01-01T00:00:00Z",
    )

    reader.ask(chat, "request_mem001", "Worth keeping: what do I know?", memory=True, trace=memory_only(slug))
    done, sent, _ = await filed.end(marker)
    assert sent == [] and done["outcome"] == "nothing" and filed.page(slug)["revision"] == 1
    [event] = filed.events()
    assert (event["outcome"], event["summary"], event["requestIds"]) == ("nothing", MEMORY_ONLY, ["request_mem001"])
    assert reader.watermark(chat, project=False) == "request_mem001" and reader.sessions() == {}

    trace = memory_only(slug)
    trace[0]["entries"].append(read_paper(PAPER)[0]["entries"][0])
    reader.ask(chat, "request_mem002", "Worth keeping: what does the paper add?", memory=True, trace=trace)
    done, sent, _ = await filed.end(marker)
    assert kinds(sent) == [SELECT, AGENT, AGENT, CHECK] and done["outcome"] == "filed"
    page = filed.page(slug)
    assert page["revision"] == 2 and provider.WORKED_OUT in page["body"]
    assert filed.storage.page_history("reader", [slug])[slug]["latest"]["trigger"] == "conversation"
    assert filed.events()[0]["requestIds"] == ["request_mem002"] and filed.events()[0]["paperId"] is None
    # The chat's own title, not the brief's "A Memory chat: …", and which of its generations wrote.
    assert (filed.events()[0]["title"], filed.events()[0]["chatGeneration"]) == ("What do I know?", 0)


@pytest.mark.anyio
async def test_a_note_is_filed_when_the_reader_leaves_and_deleting_it_removes_what_rested_on_it(tmp_path, monkeypatch):
    filed = Sessions(tmp_path, monkeypatch)
    slug = await filed.filed_document()
    reader = filed.reader
    note = reader.note()
    assert reader.claim() is None

    done, sent, _ = await filed.end()
    assert done["outcome"] == "filed" and kinds(sent) == [SELECT, AGENT, AGENT, CHECK]
    page = filed.page(slug)
    assert [c["noteId"] for c in page["citations"] if c["claimType"] == "reader-note"] == [note["id"]]
    assert "The reader noted a doubt" in page["body"]
    assert filed.storage.page_history("reader", [slug])[slug]["latest"]["trigger"] == "notes"
    assert filed.storage.list_unfiled_notes("reader", reader.project, PAPER) == []

    # An edit made while a job runs leaves the note unfiled and the job queued.
    filed.storage.update_note("reader", reader.project, PAPER, note["id"], "On reflection, expiry matters more.")
    filed.storage.release_memory_jobs("reader", kind="session")
    job = reader.claim()
    result, _ = await filed.run(job)
    edited = filed.storage.update_note("reader", reader.project, PAPER, note["id"], "Expiry and load both matter.")
    assert filed.storage.complete_memory_job("reader", job["id"], fingerprint=result["fingerprint"]) is False
    assert [n["id"] for n in filed.storage.list_unfiled_notes("reader", reader.project, PAPER)] == [note["id"]]
    assert reader.sessions()[f"session:paper:{PAPER}"]["payload"]["fingerprint"] == jobs.session_change(
        note_id=note["id"], stamp=edited["updatedAt"])
    await filed.end()
    assert filed.storage.list_unfiled_notes("reader", reader.project, PAPER) == []

    # Deleting the highlight: the claim that rested only on the note goes, and no citation dangles.
    filed.storage.delete_highlight("reader", reader.project, PAPER, note["highlightId"])
    done, sent, _ = await filed.end()
    assert provider.refusals == [] and done["outcome"] == "filed"
    [(name, arguments)] = calls_made(sent)
    assert name == "edit_memory" and arguments["operations"][0]["reason"] == "withdrawn"
    page = filed.page(slug)
    assert all(not c.get("noteId") for c in page["citations"]) and "The reader noted" not in page["body"]
    assert filed.storage.note_citations("reader", PAPER) == {}
    assert reader.sessions() == {}


@pytest.mark.anyio
async def test_a_session_files_its_exchanges_first_and_its_notes_in_a_run_of_their_own(tmp_path, monkeypatch):
    filed = Sessions(tmp_path, monkeypatch)
    slug = await filed.filed_document()
    reader = filed.reader
    reader.ask(reader.tab(), "request_one001", "Worth keeping: why is the prefix reused?")
    note = reader.note()

    done, sent, (_, kept) = await filed.end()
    # The first run is the exchange alone; the job is kept, due at once, for the note.
    assert provider.refusals == [] and done["outcome"] == "filed" and kept is True
    page = filed.page(slug)
    assert provider.WORKED_OUT in page["body"] and "The reader noted" not in page["body"]
    assert not any(c.get("noteId") for c in page["citations"])
    assert [n["id"] for n in filed.storage.list_unfiled_notes("reader", reader.project, PAPER)] == [note["id"]]
    [job] = reader.sessions().values()
    assert (job["status"], job["retryAt"]) == ("pending", None)

    done, sent, (_, kept) = await filed.end()
    assert done["outcome"] == "filed" and kept is False and reader.sessions() == {}
    assert kinds(sent) == [SELECT, AGENT, AGENT, CHECK] and "<exchange request_id" not in str(sent[0])
    page = filed.page(slug)
    assert [c["noteId"] for c in page["citations"] if c["claimType"] == "reader-note"] == [note["id"]]
    assert [event["requestIds"] for event in filed.events()] == [[], ["request_one001"]]
    assert filed.storage.list_unfiled_notes("reader", reader.project, PAPER) == []


@pytest.mark.anyio
async def test_a_job_that_died_between_its_commit_and_settling_still_leaves_its_notes_a_run(tmp_path, monkeypatch):
    from delphi_core.memory_maintenance import commit as committing

    filed = Sessions(tmp_path, monkeypatch)
    slug = await filed.filed_document()
    reader = filed.reader
    key = reader.tab()
    reader.ask(key, "request_one001", "Worth keeping: why is the prefix reused?")
    note = reader.note()
    filed.storage.release_memory_jobs("reader", kind="session")
    job = reader.claim()

    # The process dies once the pages and the event are stored, before the
    # session is settled and before its notes are queued for their own run.
    class Died(Exception):
        pass

    def died(*args, **kwargs):
        raise Died("the process died here")

    monkeypatch.setattr(committing, "settle", died)
    with pytest.raises(Died):
        await filed.run(job)
    monkeypatch.undo()
    assert reader.watermark(key) == "" and len(filed.events()) == 1

    # The job is claimed again: it reads the same exchange, answers from its own event, and settles.
    replayed, again = await filed.run(job)
    assert replayed["reused"] is True and again == [] and reader.watermark(key) == "request_one001"
    # The note is still owed its run, and gets it.
    assert filed.storage.complete_memory_job("reader", job["id"], fingerprint=replayed["fingerprint"]) is False
    done, sent, (_, kept) = await filed.end()
    assert done["outcome"] == "filed" and kept is False and reader.sessions() == {}
    page = filed.page(slug)
    assert [c["noteId"] for c in page["citations"] if c["claimType"] == "reader-note"] == [note["id"]]


@pytest.mark.anyio
async def test_a_notes_run_that_died_before_stamping_its_notes_stamps_them_when_answered_reused(tmp_path, monkeypatch):
    from delphi_core.memory_maintenance import commit as committing

    filed = Sessions(tmp_path, monkeypatch)
    await filed.filed_document()
    reader = filed.reader
    note = reader.note()
    filed.storage.release_memory_jobs("reader", kind="session")
    job = reader.claim()

    class Died(Exception):
        pass

    def died(*args, **kwargs):
        raise Died("the process died here")

    monkeypatch.setattr(committing, "stamp_notes", died)
    with pytest.raises(Died):
        await filed.run(job)
    monkeypatch.undo()
    assert [n["id"] for n in filed.storage.list_unfiled_notes("reader", reader.project, PAPER)] == [note["id"]]

    replayed, again = await filed.run(job)
    assert replayed["reused"] is True and again == []
    # Filed by the run that committed it, so never filed again as if the reader had edited it.
    assert filed.storage.list_unfiled_notes("reader", reader.project, PAPER) == []


@pytest.mark.anyio
async def test_a_reused_answer_that_cannot_stamp_still_settles_and_is_tried_again(tmp_path, monkeypatch):
    from delphi_core.memory_maintenance import commit as committing
    from delphi_core.memory_maintenance import pipeline

    filed = Sessions(tmp_path, monkeypatch)
    await filed.filed_document()
    reader = filed.reader
    key = reader.tab()
    reader.ask(key, "request_one001", "Worth keeping: why is the prefix reused?")
    filed.storage.release_memory_jobs("reader", kind="session")
    job = reader.claim()

    class Died(Exception):
        pass

    def died(*args, **kwargs):
        raise Died("the process died here")

    monkeypatch.setattr(committing, "settle", died)
    with pytest.raises(Died):
        await filed.run(job)
    monkeypatch.undo()
    monkeypatch.setattr(pipeline, "stamp_notes", lambda *args, **kwargs: None)
    with pytest.raises(RuntimeError, match="could not be stamped"):
        await filed.run(job)
    # The exchange is settled although the stamp failed, so a later session never files it again.
    assert reader.watermark(key) == "request_one001"


@pytest.mark.anyio
async def test_a_retraction_that_died_before_settling_is_recognised_although_its_commit_took_the_citations_off(tmp_path, monkeypatch):
    from delphi_core.memory_maintenance import commit as committing

    filed = Sessions(tmp_path, monkeypatch)
    slug = await filed.filed_document()
    reader = filed.reader
    note = reader.note()
    await filed.end()
    # One part: an exchange to file and a deleted note to retract.
    key = reader.tab()
    reader.ask(key, "request_one001", "Worth keeping: why is the prefix reused?")
    filed.storage.delete_highlight("reader", reader.project, PAPER, note["highlightId"])
    filed.storage.release_memory_jobs("reader", kind="session")
    job = reader.claim()

    class Died(Exception):
        pass

    def died(*args, **kwargs):
        raise Died("the process died here")

    monkeypatch.setattr(committing, "settle", died)
    with pytest.raises(Died):
        await filed.run(job)
    monkeypatch.undo()
    # The commit took the note's citation off, so a second reading of the same
    # exchange finds no deleted note: it reads differently from the run that committed.
    assert filed.storage.note_citations("reader", PAPER) == {} and reader.watermark(key) == ""
    replayed, again = await filed.run(job)
    # Recognised by the change it was claimed with: the exchange is not filed twice.
    assert replayed["reused"] is True and again == [] and reader.watermark(key) == "request_one001"
    assert len([event for event in filed.events() if event["outcome"] == "filed"]) == 2
    assert not any(c.get("noteId") for c in filed.page(slug)["citations"])


@pytest.mark.anyio
async def test_a_withheld_note_is_recorded_left_unfiled_and_filed_by_the_next_part(tmp_path, monkeypatch):
    from delphi_core.memory_maintenance import pipeline

    filed = Sessions(tmp_path, monkeypatch)
    await filed.filed_document()
    reader = filed.reader
    note = reader.note("This comparison ignores cache expiry.")
    await filed.end()
    filed.storage.update_note("reader", reader.project, PAPER, note["id"], "Expiry turns out not to matter here.")

    # A page citing the edited note is not written in this part.
    monkeypatch.setattr(pipeline, "_withheld", lambda *args, **kwargs: (note["id"],))
    done, sent, (_, kept) = await filed.end()
    monkeypatch.undo()
    assert done["outcome"] == "filed" and kept is True
    event = filed.events()[0]
    assert event["withheld"] == [note["id"]] and note["id"] not in event["notes"]
    assert [n["id"] for n in filed.storage.list_unfiled_notes("reader", reader.project, PAPER)] == [note["id"]]
    # The next part reads it again and files it.
    done, sent, (_, kept) = await filed.end()
    assert done["outcome"] == "filed" and kept is False and reader.sessions() == {}
    assert filed.events()[0]["notes"] == {note["id"]: filed.storage.list_notes("reader", reader.project, PAPER)[0]["updatedAt"]}
    assert filed.storage.list_unfiled_notes("reader", reader.project, PAPER) == []


@pytest.mark.anyio
async def test_an_edited_note_is_taken_to_the_pages_citing_it_even_when_the_selection_finds_nothing(tmp_path, monkeypatch):
    from delphi_core.memory_maintenance import pipeline
    from delphi_core.memory_maintenance.run import Selection

    filed = Sessions(tmp_path, monkeypatch)
    slug = await filed.filed_document()
    reader = filed.reader
    note = reader.note("This comparison ignores cache expiry.")
    await filed.end()
    first = filed.page(slug)
    assert [c["noteId"] for c in first["citations"] if c["claimType"] == "reader-note"] == [note["id"]]

    # The reader changes their mind; the selection reads the edit as nothing new.
    filed.storage.update_note("reader", reader.project, PAPER, note["id"], "Expiry turns out not to matter here.")

    async def nothing(*args, **kwargs):
        return Selection(True, "The page already discusses expiry.")

    monkeypatch.setattr(pipeline, "select_pages", nothing)
    done, sent, _ = await filed.end()
    # The agent is still given the page that cites the note as it read before.
    assert AGENT in kinds(sent) and done["outcome"] == "filed", kinds(sent)
    assert f"=== [[{slug}]] " in str(sent[0])
    assert filed.storage.list_unfiled_notes("reader", reader.project, PAPER) == []


@pytest.mark.anyio
async def test_a_turn_that_arrives_during_the_job_is_left_for_the_next_one_and_a_replayed_job_answers_reused(tmp_path, monkeypatch):
    filed = Sessions(tmp_path, monkeypatch)
    slug = await filed.filed_document()
    reader = filed.reader
    key = reader.tab()
    reader.ask(key, "request_one001", "Worth keeping: why is the prefix reused?")
    filed.storage.release_memory_jobs("reader", kind="session")
    job = reader.claim()
    result, sent = await filed.run(job)
    assert result["outcome"] == "filed" and reader.watermark(key) == "request_one001"

    # The job died before it was removed, with its conversation unsettled: the
    # same job, reading the same exchanges, answers from its own event.
    filed.storage.set_memory_filed_through("reader", reader.conversation(key), "")
    replayed, again = await filed.run(job)
    assert replayed["reused"] is True and again == [] and len(filed.events()) == 1
    assert reader.watermark(key) == "request_one001" and filed.page(slug)["revision"] == 2

    # A turn arrived while it ran: the job is kept, and that turn is not marked filed.
    reader.ask(key, "request_two002", "Worth keeping: and with a changed suffix?")
    assert filed.storage.complete_memory_job("reader", job["id"], fingerprint=result["fingerprint"]) is False
    assert reader.watermark(key) == "request_one001"
    [held] = reader.sessions().values()
    assert held["payload"]["fingerprint"] == jobs.session_change(request_id="request_two002")
    done, _, (_, kept) = await filed.end()
    assert done["outcome"] == "filed" and kept is False and filed.events()[0]["requestIds"] == ["request_two002"]
    assert reader.watermark(key) == "request_two002" and filed.page(slug)["revision"] == 3

    # A tail edit drops the filed request: the watermark moves back, and what replaces it is filed.
    filed.storage.drop_from_last_user_turn("reader", reader.project, key, "request_two002")
    assert reader.watermark(key) == "request_one001"
    reader.ask(key, "request_three3", "Good morning.")
    done, sent, _ = await filed.end()
    assert kinds(sent) == [SELECT] and filed.events()[0]["requestIds"] == ["request_three3"]


@pytest.mark.anyio
async def test_a_session_with_nothing_left_in_it_ends_without_a_trace(tmp_path, monkeypatch):
    filed = Sessions(tmp_path, monkeypatch)
    await filed.filed_document()
    reader = filed.reader
    key = reader.tab()
    reader.ask(key, "request_one001", "Worth keeping: why?")
    filed.storage.drop_from_last_user_turn("reader", reader.project, key, "request_one001")

    done, sent, (_, kept) = await filed.end()
    assert (done["outcome"], done["pages"], sent, kept) == ("nothing", [], [], False)
    assert filed.events() == [] and reader.sessions() == {}


# --- the route the window calls, and the drain ------------------------------


def test_leaving_releases_the_session_and_the_drain_takes_it_only_then(tmp_path):
    from fastapi.testclient import TestClient

    from delphi_core.config import get_settings
    from delphi_core.main import app
    from delphi_core.storage import LocalStorage

    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="test-session-secret", openai_api_key="test-key")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-123"})
            reader = Reader(LocalStorage(settings), LocalObjectStore(tmp_path))
            key, chat = reader.tab(), reader.memory_chat()
            reader.ask(key, "request_one001")
            reader.ask(chat, "request_mem001", memory=True, trace=memory_only())
            conversation = reader.conversation(chat, project=False)

            # Held: the queue shows the jobs, none of them is due, and a drain takes nothing.
            waiting = client.get("/api/memory/maintenance").json()
            assert (waiting["pending"], waiting["due"], waiting["cancellable"]) == (2, 0, 0)
            assert sorted((job["kind"], job["label"], job["context"]) for job in waiting["jobs"]) == [
                ("session", "Cache paper", "Filing a session"), ("session", "Filing a session", "")]
            assert '"claimed": false' in client.post("/api/memory/maintenance/drain").text

            release = "/api/memory/sessions/release"
            assert client.post(release, json={"paperId": PAPER, "conversationId": conversation}).status_code == 422
            assert client.post(release, json={"paperId": "ffffffffffff"}).json() == {"released": 0}
            assert client.post(release, json={"paperId": PAPER, "projectId": reader.project}).json() == {"released": 1}
            assert client.post(release, json={"paperId": PAPER, "projectId": reader.project}).json() == {"released": 0}
            assert client.get("/api/memory/maintenance").json()["due"] == 1
            # Launch: no body, every waiting session of the account.
            assert client.post(release).json() == {"released": 1}
            assert client.post(release, json={"conversationId": conversation}).json() == {"released": 0}

            # The reader retracts the turn: the drain runs the job, which finds nothing and leaves no trace.
            reader.storage.drop_from_last_user_turn("reader", reader.project, key, "request_one001")
            reader.storage.clear_memory_job("reader", f"session:conversation:{conversation}")
            drained = client.post("/api/memory/maintenance/drain")
            assert '"claimed": true' in drained.text and '"kind": "session"' in drained.text
            assert reader.storage.list_memory_jobs("reader") == []
            assert reader.storage.list_memory_events("reader", limit=5) == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_a_long_session_is_filed_in_parts_under_its_one_marker(tmp_path, monkeypatch):
    filed = Sessions(tmp_path, monkeypatch)
    await filed.filed_document()
    reader = filed.reader
    key = reader.tab()
    for number in range(MAX_EXCHANGES + 1):
        reader.ask(key, f"request_{number:06d}", "Good morning.")

    done, sent, (_, kept) = await filed.end()
    # The first part is settled, and the job is kept, due at once, for the rest.
    assert kinds(sent) == [SELECT] and done["outcome"] == "nothing" and kept is True
    assert reader.watermark(key) == f"request_{MAX_EXCHANGES - 1:06d}"
    [job] = reader.sessions().values()
    assert (job["status"], job["retryAt"]) == ("pending", None)
    done, sent, (_, kept) = await filed.end()
    assert kinds(sent) == [SELECT] and kept is False and reader.sessions() == {}
    assert reader.watermark(key) == f"request_{MAX_EXCHANGES:06d}"
    assert [len(event["requestIds"]) for event in filed.events()] == [1, MAX_EXCHANGES]
