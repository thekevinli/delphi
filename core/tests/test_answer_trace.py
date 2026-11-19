"""The one record of how an answer was reached, and the events that build it."""

import json
import time

from delphi_core.answer_trace import (
    ENTRIES_MAX,
    RESULTS_MAX,
    THOUGHT_MAX_CHARS,
    AnswerTrace,
    call_outcome,
    tool_entries,
)
from delphi_core.harness.registry import trace_arguments
from tests.helpers import ProviderTransport, replay


def test_choosing_memory_is_said_while_it_runs_and_again_with_what_came_of_it():
    """The reader waits on the selection call, so the record shows it under way and then when it ended."""
    start = {"kind": "document", "title": "A paper", "paperId": "p"}
    page = {"slug": "reverse-kl", "title": "Reverse KL", "kind": "concept"}
    for outcome, expected in (
        ({"given": [page]}, {"given": [page]}),
        ({"memory": "none"}, {"memory": "none"}),
        ({"memory": "unavailable"}, {"memory": "unavailable"}),
        # Pages that were given are the statement; a state beside them would be a second one.
        ({"given": [page], "memory": "none"}, {"given": [page]}),
    ):
        record = AnswerTrace(started=time.monotonic() - 4)
        events = record.context(start, memory="choosing")
        assert replay(events)[0]["context"] == {"start": start, "memory": "choosing"}
        events += record.context(start, {"pages": 3}, **outcome)
        events += record.tool("open_memory", results=[page])
        events += record.finish()
        stored = record.stored()
        assert replay(events) == stored and len(stored) == 1
        context = stored[0]["context"]
        assert context.pop("memoryMs") >= 4000
        assert context == {"start": start, "index": {"pages": 3}, **expected}
    # Said once, with nothing under way before it, it carries no time: nothing was waited on.
    assert "memoryMs" not in AnswerTrace().context(start, memory="unavailable")[0]["open"]["context"]


def test_the_stream_and_the_stored_record_are_the_same_thing():
    """
    The whole design: a client that applies the events holds what is stored,
    so the answer on screen and the one a reload shows cannot disagree.
    """
    record = AnswerTrace()
    events = []
    events += record.context({"kind": "question"}, {"pages": 97, "documents": 26, "projects": 7, "chats": 22})
    events += record.thought("Looking for Memory pages ")
    events += record.thought("on speculative decoding")
    events += record.thought_break()
    handle, started = record.tool_started("grep_memory", trace_arguments("grep_memory", json.dumps({"pattern": "draft[ -]models?", "glob": ""})))
    events += started
    events += record.tool_finished(
        handle,
        results=[{"slug": "reverse-kl", "title": "Reverse KL", "kind": "concept"}],
        found=1,
    )
    events += record.answered("The graph lookup lists the domain page. ")
    events += record.thought("Checking the domain page")
    events += record.tool("open_memory", results=[{"slug": "ai", "title": "AI Infrastructure", "kind": "domain"}])
    events += record.answered("Source: AI Infrastructure.")
    events += record.finish()

    stored = record.stored()
    assert replay(events) == stored
    first, second = stored
    # Where each stretch happened in the answer, and that the first carries
    # what the answer was handed. Context is not an entry: it is not a step.
    assert first["offset"] == 0 and second["offset"] == len("The graph lookup lists the domain page. ")
    assert first["context"]["index"]["pages"] == 97 and "context" not in second
    assert [entry["kind"] for entry in first["entries"]] == ["thought", "tool"]
    assert first["entries"][0]["text"] == "Looking for Memory pages on speculative decoding"
    call = first["entries"][1]
    assert call["tool"] == "grep_memory" and call["ok"] is True
    # Only the argument a row shows is kept, under one name, and never a blank.
    assert call["args"] == {"pattern": "draft[ -]models?"}
    assert call["results"] == [{"slug": "reverse-kl", "title": "Reverse KL", "kind": "concept"}]
    assert "running" not in call and first["startedAt"] == 0
    assert first["endedAt"] <= second["startedAt"] <= second["endedAt"]


def test_a_call_is_shown_while_it_runs_and_completed_in_place():
    record = AnswerTrace()
    handle, started = record.tool_started("memory_links", trace_arguments("memory_links", {"slug": "vllm-omni", "hops": 2}))
    running = started[-1]["set"]
    assert running["running"] is True and running["args"] == {"slug": "vllm-omni", "hops": 2}
    (finished,) = record.tool_finished(handle, ok=False, error="Not found")
    # The same entry, not a second one: a failed call stays where it happened.
    assert finished["entry"] == started[-1]["entry"]
    assert finished["set"]["ok"] is False and finished["set"]["error"] == "Not found"
    assert "running" not in finished["set"]


def test_a_stream_that_ends_mid_call_does_not_claim_the_call_succeeded():
    record = AnswerTrace()
    _, events = record.tool_started("read_paper", trace_arguments("read_paper", {"paper_id": "p", "pages": [3]}))
    events += record.finish()
    (entry,) = record.stored()[0]["entries"]
    assert entry["ok"] is False and entry["error"] == "Interrupted" and "running" not in entry
    # Said on the stream as well, so the answer on screen does not end with a
    # call that runs for ever while the stored one says it was interrupted.
    assert replay(events) == record.stored()


def test_a_call_is_one_entry_from_the_models_first_word_to_its_result():
    """A draft's source is its argument: the row waited on it, and the answer looked stalled."""
    record = AnswerTrace()
    handle, events = record.call_begun("embed_figure")
    begun = events[-1]["set"]
    assert begun["running"] is True and begun["writing"] is True and begun["args"] == {}
    events += record.call_written(handle, trace_arguments("embed_figure", {"title": "IsoFLOP", "figure_id": "f1"}))
    written = events[-1]["set"]
    # Written, and waiting for Delphi: not yet the call being run.
    assert "writing" not in written and written["queued"] is True and written["args"] == {"figureId": "f1", "title": "IsoFLOP"}
    same, started = record.tool_started("embed_figure", {"figureId": "f1", "title": "IsoFLOP"}, begun=handle)
    assert same == handle and [event["entry"] for event in started] == [handle[1]]
    assert started[-1]["set"]["running"] is True and "queued" not in started[-1]["set"]
    events += started + record.tool_finished(handle, ok=True)
    (entry,) = record.stored()[0]["entries"]
    assert entry["ok"] is True and not {"running", "writing", "queued"} & set(entry)
    assert replay(events) == record.stored()


def test_answer_text_after_a_call_it_owes_does_not_interrupt_the_call():
    record = AnswerTrace()
    handle, events = record.call_begun("search_library")
    events += record.call_written(handle, {"query": "isoflop"})
    # The same response goes on writing; the call is still Delphi's to run.
    events += record.answered("Meanwhile, ")
    _, started = record.tool_started("search_library", {"query": "isoflop"}, begun=handle)
    events += started + record.tool_finished(handle, ok=True)
    events += record.finish()
    (entry,) = record.stored()[0]["entries"]
    assert entry["ok"] is True and "error" not in entry
    assert replay(events) == record.stored()


def test_a_call_owed_when_the_answer_ends_was_interrupted_wherever_it_sits():
    record = AnswerTrace()
    _, events = record.call_begun("render_artifact")
    events += record.answered("Text after it. ")
    events += record.tool_started("search_library", {"query": "later"})[1]
    events += record.finish()
    first, second = record.stored()
    assert first["entries"][0]["error"] == "Interrupted" and "running" not in first["entries"][0]
    assert second["entries"][0]["error"] == "Interrupted"
    assert replay(events) == record.stored()
    assert record.finish() == []
    # Cut off as it was written, the draft is said as never run, and is no
    # evidence of anything; the search Delphi started still is.
    assert first["entries"][0]["writing"] is True
    assert [entry["tool"] for entry in tool_entries(record.stored())] == ["search_library"]


def test_a_stretch_sits_where_a_browser_would_slice_the_answer():
    record = AnswerTrace()
    # One emoji is one character and two UTF-16 units; a browser counts two.
    record.answered("Done 🎉 ")
    record.thought("next")
    record.finish()
    assert record.stored()[0]["offset"] == len("Done 🎉 ".encode("utf-16-le")) // 2 == 8


def test_the_record_is_bounded_and_says_when_it_stopped():
    record = AnswerTrace()
    record.thought("x" * (THOUGHT_MAX_CHARS + 500))
    for _ in range(ENTRIES_MAX + 5):
        record.tool("open_memory", results=[
            {"slug": f"p{n}", "title": f"P{n}", "kind": "concept"} for n in range(RESULTS_MAX + 4)
        ])
    record.finish()
    (stretch,) = record.stored()
    assert len(stretch["entries"]) == ENTRIES_MAX and stretch["truncated"] is True
    assert len(stretch["entries"][0]["text"]) == THOUGHT_MAX_CHARS
    assert len(stretch["entries"][1]["results"]) == RESULTS_MAX


def test_a_paragraph_break_is_not_the_answer_resuming():
    record = AnswerTrace()
    record.thought("first")
    # Counted where the next stretch will sit, but the work is still one stretch.
    assert record.answered("\n\n") == []
    record.thought_break()
    record.thought("second")
    record.answered("Text.")
    (stretch,) = record.stored()
    assert [entry["text"] for entry in stretch["entries"]] == ["first", "second"]
    # An answer that did no work has no trace at all.
    quiet = AnswerTrace()
    quiet.answered("Just text.")
    quiet.finish()
    assert quiet.stored() == []
    # Nothing is tidied between the stream and storage, not even a blank thought.
    blank = AnswerTrace()
    sent = blank.thought("  ") + blank.finish()
    assert replay(sent) == blank.stored() and blank.stored()[0]["entries"][0]["text"] == "  "


def test_a_trimmed_answer_keeps_each_stretch_where_it_happened():
    record = AnswerTrace()
    record.answered("  Lead. ")
    record.thought("then")
    record.finish()
    assert record.stored(shift=2)[0]["offset"] == len("Lead. ")


def test_a_tools_own_prose_says_how_the_call_went():
    assert call_outcome("From \"Paper\" (paper_id p · PDF):\n\n…") == (True, None)
    assert call_outcome("Error: no web document with doc_id 'x' is attached") == (False, "Not found")
    assert call_outcome("No page exists at 'nowhere', and nothing links to it.") == (False, "Not found")
    assert call_outcome("Error: arguments were not valid JSON.") == (False, "Bad arguments")
    assert call_outcome("Error: something unforeseen.") == (False, "Failed")
    assert call_outcome("Error: a source was read in or after the round that rendered this draft.") == (False, "Read after draft")
    assert call_outcome("Error: the exact-document read budget is exhausted.") == (False, "Limit reached")
    assert call_outcome("The per-answer budget for consulting the knowledge base is spent.") == (False, "Limit reached")
    # A read refused by the turn's source cap says so, not "Failed".
    assert call_outcome("Error: this turn's external source snapshot limit is reached. Use the sources already read.") == (False, "Limit reached")
    assert call_outcome("Error: source retrieval timed out. Continue with other evidence.") == (False, "Timed out")
    assert call_outcome("Error: This PDF has 860 pages; Delphi reads PDFs of up to 100 pages. Find a shorter version.") == (False, "PDF too long")
    assert call_outcome("Error: The source returned an access challenge, not readable text.") == (False, "Site blocked")
    # A draft the renderer sent back for repair says what needs fixing.
    assert call_outcome("Error: artifact validation failed (control did nothing).\n{}") == (False, "Control did nothing")
    assert call_outcome("Error: artifact validation failed.\n{}") == (False, "Failed")


def test_only_the_argument_a_row_shows_is_kept():
    assert trace_arguments("read_paper", json.dumps({"paper_id": "p1", "pages": [3, 4, "x"]})) == {
        "paperId": "p1", "pages": [3, 4],
    }
    # A hosted call keeps what its action was pointed at, whichever it was.
    assert trace_arguments("web_search", {"query": "mu parametrization", "sources": ["x"]}) == {
        "query": "mu parametrization"
    }
    assert trace_arguments("web_search", {"action": "open_page", "url": "https://arxiv.org/abs/2203.03466"}) == {
        "action": "open_page", "url": "https://arxiv.org/abs/2203.03466",
    }
    assert trace_arguments("grep_memory", "{not json") == {}
    assert trace_arguments("unknown_tool", {"anything": "x"}) == {}


def test_what_is_read_back_as_evidence_is_the_calls_and_never_the_thoughts():
    record = AnswerTrace()
    record.thought("I think the paper is wrong")
    record.tool("read_paper", trace_arguments("read_paper", {"paper_id": "p", "pages": [3]}))
    record.finish()
    calls = tool_entries(record.stored())
    assert [call["tool"] for call in calls] == ["read_paper"]
    # Only the stretch-list shape is a trace; anything else is no evidence at all.
    assert tool_entries({"turns": 1, "calls": [{"name": "read_paper"}]}) == []
    assert tool_entries(None) == [] and tool_entries("nonsense") == []


def test_a_project_answer_keeps_what_it_was_given_thought_and_did(tmp_path, monkeypatch):
    """
    Through the route: the record on the stored message is the one the stream
    built, it begins with what the answer was handed, and the model's thinking
    is kept beside the calls instead of being thrown away.
    """
    import httpx
    from fastapi.testclient import TestClient

    from delphi_core.config import Settings, get_settings
    from delphi_core.main import app
    from delphi_core.routers import chat as chat_router
    from delphi_core.storage import LocalStorage
    from tests.helpers import MINIMAL_PDF, seed_paper

    settings = Settings(data_dir=tmp_path, session_secret="answer-trace", openai_api_key="test-key",
                        openai_files_enabled=False)

    def handler(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        if "text" in sent and sent["text"].get("format", {}).get("name") == "memory_selection":
            return httpx.Response(200, json={"output": [{"type": "message", "content": [
                {"type": "output_text", "text": json.dumps({"slugs": ["kv-cache"]})}]}]})
        events = [
            {"type": "response.reasoning_summary_text.delta", "delta": "Checking what the paper claims"},
            {"type": "response.reasoning_summary_part.done"},
            {"type": "response.output_text.delta", "delta": "It claims a speedup."},
        ]
        return httpx.Response(
            200, content="".join(f"data: {json.dumps(event)}\n\n" for event in events).encode()
        )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        chat_router.httpx,
        "AsyncClient",
        lambda *a, **k: real_client(*a, **{**k, "transport": ProviderTransport(handler)}),
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-test"})
            storage = LocalStorage(settings)
            project = storage.create_project("reader", "Papers")["id"]
            seed_paper(settings, "reader", project,
                       {"id": "paper-one", "title": "Paper", "filename": "paper.pdf", "pages": 1, "tokens": 10},
                       pdf=MINIMAL_PDF)
            storage.upsert_memory_page(
                "reader",
                {"kind": "concept", "domain": "ml", "title": "KV cache", "summary": "s", "body": "Prefix reuse."},
                max_pages=50,
            )
            scope = {"scope": "document", "project_id": project, "paper_id": "paper-one"}
            conversation = client.post(
                "/api/chat/conversations", json={**scope, "creation_key": "answer_trace"}
            ).json()
            streamed = client.post("/api/chat/stream", json={
                **scope, "prompt": "What does it claim?",
                "conversation_id": conversation["id"], "generation": 0,
            })
            assert streamed.status_code == 200
            sent = [json.loads(line[5:]) for line in streamed.text.splitlines() if line.startswith("data:")]
            thread = client.get(
                "/api/chat", params={**scope, "conversation_id": conversation["id"]}
            ).json()
    finally:
        app.dependency_overrides.clear()

    answer = thread["messages"][-1]
    assert answer["content"] == "It claims a speedup."
    (stretch,) = answer["trace"]
    assert stretch["context"]["start"] == {"kind": "document", "title": "Paper", "paperId": "paper-one"}
    assert stretch["context"]["index"]["pages"] == 1
    # The pages Delphi chose and put in the request are what the answer was
    # handed, not a call the model made: context, and never a step.
    assert stretch["context"]["given"] == [{"slug": "kv-cache", "title": "KV cache", "kind": "concept"}]
    # Choosing them is a call the reader waited on: the stream said so while it
    # ran, before anything else, and the record keeps when it ended.
    first = next(event for event in sent if event["type"] == "trace")
    assert first["open"]["context"] == {"start": stretch["context"]["start"], "memory": "choosing"}
    assert "memory" not in stretch["context"] and stretch["context"]["memoryMs"] >= 0
    (thought,) = stretch["entries"]
    assert thought == {"kind": "thought", "at": thought["at"], "text": "Checking what the paper claims"}
    # The stream built this record, event by event, and `done` hands it over whole.
    assert replay([event for event in sent if event["type"] == "trace"]) == [
        {key: value for key, value in stretch.items()}
    ]
    done = next(event for event in sent if event["type"] == "done")
    assert done["trace"] == answer["trace"]


def test_only_a_cancelled_answer_writes_its_trace_back(tmp_path, monkeypatch):
    """
    Attaching a trace to a stored cancellation reads the whole conversation, so
    it is paid by a cancelled answer and never by one that finished normally.
    """
    import httpx
    from fastapi.testclient import TestClient

    from delphi_core.config import Settings, get_settings
    from delphi_core.main import app
    from delphi_core.routers import chat as chat_router
    from delphi_core.storage import LocalStorage
    from tests.chat_keys import conversation_params

    settings = Settings(data_dir=tmp_path, session_secret="answer-trace", openai_api_key="test-key")
    events = [{"type": "response.output_text.delta", "delta": "An answer."}]
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        chat_router.httpx,
        "AsyncClient",
        lambda *a, **k: real_client(*a, **{**k, "transport": ProviderTransport(lambda request: httpx.Response(
            200, content="".join(f"data: {json.dumps(event)}\n\n" for event in events).encode()))}),
    )
    written = []
    monkeypatch.setattr(LocalStorage, "finish_cancelled_trace", lambda self, *args: written.append(args))
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-test"})
            finished = conversation_params(client, "general", name="finished")
            assert client.post("/api/chat/stream", json={
                **finished, "prompt": "A question", "request_id": "req_finished",
            }).status_code == 200
            assert written == []

            monkeypatch.setattr(chat_router, "request_was_cancelled", lambda *args: True)
            stopped = conversation_params(client, "general", name="stopped")
            client.post("/api/chat/stream", json={
                **stopped, "prompt": "A question", "request_id": "req_stopped",
            })
    finally:
        app.dependency_overrides.clear()

    ((_, conversation_id, _, request_id, trace),) = written
    assert (conversation_id, request_id) == (stopped["conversation_id"], "req_stopped")
    assert trace and trace[0]["context"]["start"] == {"kind": "question"}
