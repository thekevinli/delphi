"""The loop: what one turn may spend, how a call is served, and how a turn ends."""

import asyncio
import json

import httpx
import pytest

from delphi_core.answer_trace import AnswerTrace
from delphi_core.config import Settings
from delphi_core.harness.budget import (
    DOCUMENT_CALLS_SPENT,
    MEMORY_CALLS_SPENT,
    TurnBudget,
)
from delphi_core.answer_trace import tool_entries
from delphi_core.harness.loop import DEADLINE, LAST_ROUND_NOTE, TurnResult, run_turn
from delphi_core.harness.provider import ProviderError, ResponsesClient, Terminal
from delphi_core.harness.registry import DEFAULTS, Toolset
from delphi_core.harness.tool import (
    BudgetClass,
    Tool,
    ToolArguments,
    ToolContext,
    ToolResult,
    TraceProjection,
)
from delphi_core.memory_maintenance.agent import run_loop
from delphi_core.storage import LocalStorage
from tests.helpers import replay

SETTINGS = Settings(openai_api_key="test-key")
QUESTION = {"input": [{"role": "user", "content": "A question."}], "instructions": "Answer."}


class NoArguments(ToolArguments):
    """A tool these tests invent takes nothing."""


def fake_tool(name: str, budget: BudgetClass, run) -> Tool:
    return Tool(
        name=name, arguments=NoArguments, description=f"Test tool {name}.", guidance="Use it.",
        budget=budget, label=f"Running {name}", trace=TraceProjection(), run=run,
    )


def frames(*events: dict) -> bytes:
    return "".join(f"data: {json.dumps(event)}\n\n" for event in events).encode()


def done(item: dict) -> dict:
    return {"type": "response.output_item.done", "item": item}


def call(name: str, arguments: dict | str = "{}", call_id: str = "call-1") -> dict:
    raw = arguments if isinstance(arguments, str) else json.dumps(arguments)
    return done({"type": "function_call", "id": f"fc_{call_id}", "call_id": call_id,
                 "name": name, "arguments": raw})


def searched(query: str, item_id: str, status: str = "completed") -> dict:
    return done({"type": "web_search_call", "id": item_id, "status": status,
                 "action": {"type": "search", "query": query}})


def begun(name: str, call_id: str = "call-1") -> dict:
    return {"type": "response.output_item.added", "item": {
        "type": "function_call", "id": f"fc_{call_id}", "call_id": call_id, "name": name, "arguments": ""}}


def traced(events: list[dict]) -> list[dict]:
    return [event for event in events if event["type"] == "trace"]


CUT_OFF = {"type": "response.incomplete", "response": {
    "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}}


def completed(output_tokens: int = 10) -> dict:
    return {"type": "response.completed", "response": {
        "status": "completed", "usage": {"input_tokens": 100, "output_tokens": output_tokens}}}


TEXT = {"type": "response.output_text.delta", "delta": "The answer."}


async def turn(rounds: list[bytes], toolset: Toolset, budget: TurnBudget, context: ToolContext | None = None,
               recorder: AnswerTrace | None = None, request: dict | None = None):
    """Run one turn against scripted responses. Returns its events and the requests it made."""
    sent: list[dict] = []

    def handler(request_: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request_.content))
        return httpx.Response(200, content=rounds[min(len(sent), len(rounds)) - 1])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        events = [
            event async for event in run_turn(
                ResponsesClient(http, SETTINGS), {**(request or QUESTION), "tools": toolset.specs()},
                toolset, budget, context or ToolContext(settings=SETTINGS, offered=toolset.names), recorder,
            )
        ]
    return events, sent


def budget(**limits) -> TurnBudget:
    return TurnBudget(**{"rounds": 6, "document_calls": 12, "document_chars": 96_000,
                         "memory_calls": 6, "figure_views": 2, "hosted_calls": 8, **limits})


async def note(arguments: str, ctx: ToolContext) -> ToolResult:
    return ToolResult("Noted.")


@pytest.mark.asyncio
async def test_the_hosted_allowance_is_carried_across_rounds():
    """
    The provider runs a hosted search itself, so nothing here can refuse one.
    It is told how many remain on each request, counted from what came back
    completed; and once none remain the tool is withheld, never sent a zero,
    which the provider refuses.
    """
    look = fake_tool("look", BudgetClass.MEMORY, note)
    toolset = Toolset([look, DEFAULTS["web_search"]])
    spending = budget(hosted_calls=3)
    events, sent = await turn(
        [
            frames(searched("first", "ws_1"), searched("second", "ws_2"),
                   # Past the limit: it arrives, but never as completed.
                   searched("third", "ws_3", status="searching"),
                   call("look"), completed()),
            frames(searched("fourth", "ws_4"), call("look", call_id="call-2"), completed()),
            frames(TEXT, completed()),
        ],
        toolset, spending,
    )
    assert [request.get("max_tool_calls") for request in sent] == [3, 1, None]
    assert spending.hosted_calls_made == 3 and spending.hosted_left == 0
    # The tools array is the cached prefix and never changes within a turn.
    assert sent[0]["tools"] == sent[1]["tools"] == sent[2]["tools"]
    assert "tool_choice" not in sent[0] and "tool_choice" not in sent[1]
    # Spent: the search is withheld, the tool with budget left is not.
    assert sent[2]["tool_choice"] == {
        "type": "allowed_tools", "mode": "auto", "tools": [{"type": "function", "name": "look"}],
    }
    # What ran is handed back so it is not run again; what was cut is not.
    replayed = [item for item in sent[1]["input"] if item.get("type") == "web_search_call"]
    assert [item["action"]["query"] for item in replayed] == ["first", "second"]
    assert all("id" not in item for item in replayed)
    assert events[-1] == {"type": "turn_end", "result": TurnResult(Terminal.COMPLETED)}


@pytest.mark.asyncio
async def test_a_hosted_search_is_traced_where_it_happened_while_it_happens():
    """It used to be recorded after the round, so its row landed under the text it informed."""
    record = AnswerTrace()
    events, _ = await turn(
        [frames(
            {"type": "response.output_item.added", "item": {"type": "web_search_call", "id": "ws_1", "status": "in_progress"}},
            {"type": "response.web_search_call.completed"},
            searched("mu parametrization follow-up", "ws_1"),
            TEXT, completed(),
        )],
        Toolset([DEFAULTS["web_search"]]), budget(), recorder=record,
    )
    kinds = [event["type"] for event in events]
    first_text = kinds.index("delta")
    sets = [(index, event["set"]) for index, event in enumerate(events) if event["type"] == "trace" and "set" in event]
    # Opened running, with nothing known of it yet; closed with what it asked.
    assert [(entry.get("running"), entry["args"]) for _, entry in sets] == [
        (True, {}), (None, {"query": "mu parametrization follow-up"}),
    ]
    assert all(index < first_text for index, _ in sets)
    (stored,) = [entry for entry in record.stored()[0]["entries"] if entry["kind"] == "tool"]
    assert stored["tool"] == "web_search" and stored["ok"] is True


@pytest.mark.asyncio
async def test_a_function_call_is_traced_as_the_model_begins_writing_it():
    """
    Recorded only at dispatch, a call's row waited for its whole argument —
    for a draft, its whole source — and the answer sat on a half sentence.
    """
    record = AnswerTrace()
    look = fake_tool("look", BudgetClass.MEMORY, note)
    events, _ = await turn(
        [
            frames(
                TEXT, begun("look"),
                {"type": "response.function_call_arguments.delta", "item_id": "fc_call-1", "delta": "{}"},
                call("look"), completed(),
            ),
            frames(TEXT, completed()),
        ],
        Toolset([look]), budget(), ToolContext(settings=SETTINGS, storage=object(), offered=frozenset({"look"})),
        recorder=record,
    )
    sets = [event for event in traced(events) if "set" in event]
    # Shown while it is written, then completed in place: one entry, never two.
    assert {(event["stretch"], event["entry"]) for event in sets} == {(0, 0)}
    assert [sorted({"writing", "queued", "running"} & set(event["set"])) for event in sets] == [
        ["running", "writing"], ["queued", "running"], ["running"], [],
    ]
    assert events.index(sets[0]) < next(
        index for index, event in enumerate(events) if event["type"] == "status" and event["text"] == ""
    )
    assert sets[-1]["set"]["ok"] is True
    (stretch,) = record.stored()
    # After the text that came before it, where the reader saw it begin.
    assert stretch["offset"] == len("The answer.")
    assert replay(traced(events)) == record.stored()


@pytest.mark.asyncio
async def test_parallel_calls_wait_their_turn_and_only_the_one_running_says_so():
    """Both calls are shown as they are written; Delphi runs them one at a time, in order."""
    record = AnswerTrace()
    look, peek = fake_tool("look", BudgetClass.MEMORY, note), fake_tool("peek", BudgetClass.MEMORY, note)
    events, _ = await turn(
        [
            frames(begun("look"), call("look"), begun("peek", "call-2"), call("peek", call_id="call-2"), completed()),
            frames(TEXT, completed()),
        ],
        Toolset([look, peek]), budget(),
        ToolContext(settings=SETTINGS, storage=object(), offered=frozenset({"look", "peek"})), recorder=record,
    )
    # Replayed step by step: at no point are two calls moving at once, so the
    # reader's spinner can only ever sit on the one being written or run.
    changes = traced(events)
    for step in range(1, len(changes) + 1):
        entries = replay(changes[:step])[0]["entries"]
        assert len([entry for entry in entries if entry.get("running") and not entry.get("queued")]) <= 1
    stored = record.stored()[0]["entries"]
    assert [entry["tool"] for entry in stored] == ["look", "peek"] and all(entry["ok"] for entry in stored)
    assert replay(traced(events)) == record.stored()


@pytest.mark.asyncio
async def test_text_after_a_call_in_the_same_response_leaves_the_call_to_run_where_it_was_asked():
    record = AnswerTrace()
    look = fake_tool("look", BudgetClass.MEMORY, note)
    events, _ = await turn(
        [
            frames(TEXT, begun("look"), call("look"), {"type": "response.output_text.delta", "delta": " More."},
                   completed()),
            frames(TEXT, completed()),
        ],
        Toolset([look]), budget(), ToolContext(settings=SETTINGS, storage=object(), offered=frozenset({"look"})),
        recorder=record,
    )
    first = record.stored()[0]
    (entry,) = first["entries"]
    # Run and reported in the stretch it was asked in, not marked interrupted.
    assert entry["tool"] == "look" and entry["ok"] is True and "error" not in entry
    assert replay(traced(events)) == record.stored()


@pytest.mark.asyncio
async def test_a_response_cut_off_mid_call_records_a_call_that_never_ran():
    record = AnswerTrace()
    look = fake_tool("look", BudgetClass.MEMORY, note)
    events, _ = await turn(
        [frames(TEXT, begun("look"), CUT_OFF)],
        Toolset([look]), budget(), ToolContext(settings=SETTINGS, storage=object(), offered=frozenset({"look"})),
        recorder=record,
    )
    assert events[-1]["result"] == TurnResult(Terminal.INCOMPLETE, "max_output_tokens")
    events += record.finish()
    (entry,) = record.stored()[0]["entries"]
    assert entry["error"] == "Interrupted" and entry["writing"] is True and "running" not in entry
    assert tool_entries(record.stored()) == []
    assert replay(traced(events)) == record.stored()


@pytest.mark.asyncio
async def test_a_maintenance_run_never_keeps_a_call_it_did_not_run():
    """Its event counts what the author called; a call cut off as it was written is not one."""
    look = fake_tool("look", BudgetClass.MEMORY, note)
    toolset = Toolset([look])
    rounds = [frames(begun("look"), call("look"), completed()), frames(begun("look", "call-2"), CUT_OFF)]
    sent: list[dict] = []

    def handler(request_: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request_.content))
        return httpx.Response(200, content=rounds[min(len(sent), len(rounds)) - 1])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        _, ended, calls = await run_loop(
            ResponsesClient(http, SETTINGS), {**QUESTION, "tools": toolset.specs()}, toolset, budget(),
            ToolContext(settings=SETTINGS, storage=object(), offered=toolset.names),
        )
    assert ended == "max_output_tokens"
    assert [(entry["tool"], entry["ok"]) for entry in calls] == [("look", True)]
    assert not any({"running", "writing", "queued"} & set(entry) for entry in calls)


@pytest.mark.asyncio
async def test_a_turn_keeps_what_it_cited_and_the_trace_says_what_each_web_call_did():
    """
    Three things the provider reports and Delphi used to throw away: the pages
    an answer cites, the addresses a search read, and that a hosted call may be
    a page opened or a find within one rather than a search.
    """
    arxiv = "https://arxiv.org/abs/2203.03466"
    look = fake_tool("look", BudgetClass.MEMORY, note)

    def hosted(item_id: str, action: dict) -> dict:
        return done({"type": "web_search_call", "id": item_id, "status": "completed", "action": action})

    def said(text: str, *urls: str) -> list[dict]:
        notes = [{"type": "url_citation", "url": url, "title": f"Title of {url}", "start_index": 0, "end_index": 1}
                 for url in urls]
        return [{"type": "response.output_text.delta", "delta": text},
                done({"type": "message", "status": "completed", "phase": "final_answer",
                      "content": [{"type": "output_text", "text": text, "annotations": notes}]})]

    record = AnswerTrace()
    events, sent = await turn(
        [
            frames(
                hosted("ws_1", {"type": "search", "query": "mu parametrization", "sources": [
                    {"type": "url", "url": arxiv}, {"type": "url", "url": "https://github.com/microsoft/mup"},
                    {"type": "url", "url": "javascript:alert(1)"}]}),
                hosted("ws_2", {"type": "open_page", "url": arxiv}),
                hosted("ws_3", {"type": "find_in_page", "url": arxiv, "pattern": "maximal update"}),
                *said("It was posted in 2022.", arxiv),
                call("look"), completed(),
            ),
            frames(*said("Its code is public.", "https://github.com/microsoft/mup", arxiv), completed()),
        ],
        Toolset([look, DEFAULTS["web_search"]]), budget(), recorder=record,
    )
    result = events[-1]["result"]
    # In the order cited, each once, across both rounds of the turn.
    assert result.sources == [
        {"url": arxiv, "title": f"Title of {arxiv}"},
        {"url": "https://github.com/microsoft/mup", "title": "Title of https://github.com/microsoft/mup"},
    ]
    web = [entry for stretch in record.stored() for entry in stretch["entries"]
           if entry["kind"] == "tool" and entry["tool"] == "web_search"]
    assert [entry["args"] for entry in web] == [
        {"query": "mu parametrization"},
        {"action": "open_page", "url": arxiv},
        {"action": "find_in_page", "url": arxiv, "pattern": "maximal update"},
    ]
    # A search lists where it looked: an address and its site, never a title it was not given.
    assert web[0]["results"] == [
        {"url": arxiv, "title": "arxiv.org", "kind": "web"},
        {"url": "https://github.com/microsoft/mup", "title": "github.com", "kind": "web"},
    ]
    assert web[1]["results"] == [] and all(entry["ok"] for entry in web)
    # A cited message goes back with its citation, so the next round knows where it came from.
    (replayed,) = [item for item in sent[1]["input"] if item.get("type") == "message"]
    assert replayed["content"][0]["annotations"][0]["url"] == arxiv
    assert sent[0]["max_tool_calls"] == 8 and sent[1]["max_tool_calls"] == 5


@pytest.mark.asyncio
async def test_reaching_the_output_total_makes_the_next_round_the_closing_one():
    look = fake_tool("look", BudgetClass.MEMORY, note)
    spending = budget(output_tokens=100)
    events, sent = await turn(
        [frames(call("look"), completed(output_tokens=120)), frames(TEXT, completed(output_tokens=30))],
        Toolset([look]), spending,
    )
    assert len(sent) == 2
    assert sent[1]["tool_choice"] == "none" and sent[1]["tools"] == sent[0]["tools"]
    assert sent[1]["input"][-1] == {"role": "user", "content": LAST_ROUND_NOTE}
    # Summed across the turn, and the first response kept on its own.
    assert (spending.usage.output_tokens, spending.usage.input_tokens, spending.rounds_run) == (150, 200, 2)
    assert spending.first_usage.output_tokens == 120
    assert events[-1]["result"].terminal is Terminal.COMPLETED


@pytest.mark.asyncio
async def test_a_turn_past_its_deadline_is_cut_off_and_hangs_up():
    class Stalled(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self):
            yield frames({"type": "response.output_text.delta", "delta": "It begins"})
            await asyncio.sleep(30)

        async def aclose(self) -> None:
            Stalled.closed = True

    spending = budget(deadline_seconds=0.2)
    async with httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, stream=Stalled())
    )) as http:
        events = [
            event async for event in run_turn(
                ResponsesClient(http, SETTINGS), QUESTION, Toolset(), spending,
                ToolContext(settings=SETTINGS),
            )
        ]
    # What was written is kept, the turn says why it stopped, and the provider
    # is no longer being listened to or billed.
    assert {"type": "delta", "text": "It begins"} in events
    assert events[-1] == {"type": "turn_end", "result": TurnResult(Terminal.INCOMPLETE, DEADLINE)}
    assert Stalled.closed


@pytest.mark.asyncio
async def test_a_slow_tool_cannot_outlast_the_turn():
    async def slow(arguments: str, ctx: ToolContext) -> ToolResult:
        await asyncio.sleep(30)
        return ToolResult("Too late.")

    events, sent = await turn(
        [frames(call("stall"), completed())],
        Toolset([fake_tool("stall", BudgetClass.MEMORY, slow)]), budget(deadline_seconds=0.2),
        ToolContext(settings=SETTINGS, storage=object()),
    )
    assert len(sent) == 1
    assert events[-1]["result"] == TurnResult(Terminal.INCOMPLETE, DEADLINE)


@pytest.mark.asyncio
async def test_a_response_cut_off_at_the_output_ceiling_ends_the_turn_as_cut_off():
    events, sent = await turn(
        [frames({"type": "response.output_text.delta", "delta": "Half an ans"},
                {"type": "response.incomplete", "response": {
                    "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}})],
        Toolset(), budget(),
    )
    assert len(sent) == 1
    assert {"type": "delta", "text": "Half an ans"} in events
    assert events[-1] == {"type": "turn_end", "result": TurnResult(Terminal.INCOMPLETE, "max_output_tokens")}


@pytest.mark.asyncio
async def test_a_response_that_failed_or_never_finished_is_an_error_not_an_answer():
    with pytest.raises(ProviderError) as failed:
        await turn([frames(TEXT, {"type": "response.failed", "response": {
            "status": "failed", "error": {"message": "The model overloaded."}}})], Toolset(), budget())
    assert str(failed.value) == "The model overloaded." and failed.value.terminal is Terminal.FAILED
    # A stream that just stops is not a short answer. It is no answer.
    with pytest.raises(ProviderError) as ended:
        await turn([frames(TEXT)], Toolset(), budget())
    assert ended.value.terminal is Terminal.ENDED


@pytest.mark.asyncio
async def test_a_tool_the_request_does_not_offer_never_runs(tmp_path, monkeypatch):
    """
    The offered set is the allowlist. `open_memory` exists in the catalogue
    and would read the account's pages; a request that does not offer it cannot
    be made to run it, whatever text the model read told it to. Nor can a name
    the catalogue has never held, such as the write tool chat used to carry.
    """
    from delphi_core.harness.tools import open_memory

    settings = Settings(openai_api_key="test-key", data_dir=tmp_path)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    ran: list[str] = []
    monkeypatch.setattr(open_memory, "open_chosen_memory", lambda *args: ran.append("open_memory"))

    async def look(arguments, ctx: ToolContext) -> ToolResult:
        ran.append("look")
        return ToolResult("Looked.")

    toolset = Toolset([fake_tool("look", BudgetClass.MEMORY, look)])
    assert "open_memory" in DEFAULTS and "open_memory" not in toolset.names
    assert "write_knowledge" not in DEFAULTS
    record = AnswerTrace()
    events, sent = await turn(
        [frames(call("open_memory", {"slugs": ["kv-cache"]}),
                call("write_knowledge", {"title": "Injected", "kind": "concept"}, call_id="call-2"),
                call("look", call_id="call-3"), completed()),
         frames(TEXT, completed())],
        toolset, budget(),
        ToolContext(settings=settings, username="reader", storage=storage, offered=toolset.names),
        recorder=record,
    )
    outputs = [item["output"] for item in sent[1]["input"] if item.get("type") == "function_call_output"]
    assert outputs[0].startswith("Error: 'open_memory' is not a tool this conversation offers.")
    assert "The tools you can call are: look." in outputs[0]
    assert outputs[1].startswith("Error: 'write_knowledge' is not a tool")
    assert outputs[2] == "Looked." and ran == ["look"]
    assert storage.list_memory_pages("reader") == []
    # The refused calls are on the record, as calls that failed.
    tools = [entry for entry in record.stored()[0]["entries"] if entry["kind"] == "tool"]
    assert [(entry["tool"], entry["ok"]) for entry in tools] == [
        ("open_memory", False), ("write_knowledge", False), ("look", True),
    ]
    assert events[-1]["result"].terminal is Terminal.COMPLETED


@pytest.mark.asyncio
async def test_a_runner_that_raises_is_prose_to_the_model_and_the_answer_still_arrives():
    async def broken(arguments: str, ctx: ToolContext) -> ToolResult:
        raise ValueError("a bug in a tool")

    record = AnswerTrace()
    events, sent = await turn(
        [frames(call("fragile"), completed()), frames(TEXT, completed())],
        Toolset([fake_tool("fragile", BudgetClass.MEMORY, broken)]), budget(),
        ToolContext(settings=SETTINGS, storage=object()), recorder=record,
    )
    (output,) = [item["output"] for item in sent[1]["input"] if item.get("type") == "function_call_output"]
    assert output == "Error: fragile could not be run just now. Continue with what you have."
    assert "a bug in a tool" not in output
    (entry,) = [entry for entry in record.stored()[0]["entries"] if entry["kind"] == "tool"]
    assert (entry["ok"], entry["error"]) == (False, "Failed")
    assert {"type": "delta", "text": "The answer."} in events


@pytest.mark.asyncio
async def test_a_spent_class_answers_in_prose_and_is_withheld_from_the_next_round():
    async def read(arguments: str, ctx: ToolContext) -> ToolResult:
        return ToolResult("A page of text.")

    document = fake_tool("read_it", BudgetClass.DOCUMENT, read)
    memory = fake_tool("recall", BudgetClass.MEMORY, note)
    events, sent = await turn(
        [
            # Three reads against a budget of two, and two recalls against one.
            frames(call("read_it", call_id="a"), call("read_it", call_id="b"), call("read_it", call_id="c"),
                   call("recall", call_id="d"), call("recall", call_id="e"), completed()),
            frames(TEXT, completed()),
        ],
        Toolset([document, memory]), budget(document_calls=2, memory_calls=1),
        ToolContext(settings=SETTINGS, storage=object()),
    )
    outputs = [item["output"] for item in sent[1]["input"] if item.get("type") == "function_call_output"]
    assert outputs == ["A page of text.", "A page of text.", DOCUMENT_CALLS_SPENT, "Noted.", MEMORY_CALLS_SPENT]
    # Both classes are spent, so the next round may call nothing; the tools stay.
    assert sent[1]["tool_choice"] == "none" and sent[1]["tools"] == sent[0]["tools"]


@pytest.mark.asyncio
async def test_malformed_arguments_come_back_as_prose_the_model_can_correct():
    toolset = Toolset([DEFAULTS["read_webpage"]])
    events, sent = await turn(
        [frames(call("read_webpage", "{not json"), completed()), frames(TEXT, completed())],
        toolset, budget(), ToolContext(settings=SETTINGS, offered=toolset.names),
    )
    (output,) = [item["output"] for item in sent[1]["input"] if item.get("type") == "function_call_output"]
    assert output == "Error: arguments were not valid JSON."
    assert events[-1]["result"].terminal is Terminal.COMPLETED


@pytest.mark.asyncio
async def test_a_caller_that_resumes_a_run_is_handed_the_conversation_as_the_turn_left_it():
    said = done({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "The answer."}]})
    rounds = [frames(call("note"), completed()), frames(TEXT, said, completed())]
    toolset = Toolset([fake_tool("note", BudgetClass.DOCUMENT, note)])
    kept: list = ["left over from another turn"]
    sent: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, content=rounds[len(sent) - 1])

    request = {**QUESTION, "tools": toolset.specs()}
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        events = [
            event async for event in run_turn(
                ResponsesClient(http, SETTINGS), request, toolset, budget(),
                ToolContext(settings=SETTINGS, offered=toolset.names), conversation=kept,
            )
        ]
    assert events[-1]["result"].terminal is Terminal.COMPLETED
    # Everything the last request carried, then what the last response said.
    assert kept[:-1] == sent[-1]["input"]
    assert [item.get("type") or item.get("role") for item in kept] == ["user", "function_call", "function_call_output", "message"]
    assert kept[-1] == {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "The answer."}]}
    # The request's own input is not the list that grew, and a turn given no list sends exactly the same.
    assert request["input"] == QUESTION["input"]
    _, unobserved = await turn(rounds, toolset, budget())
    assert unobserved == sent


def test_the_working_method_names_exactly_the_tools_a_request_offers():
    from delphi_core.harness import profiles
    from delphi_core.harness.prompts import working_method

    turns = [
        profiles.Turn(SETTINGS),
        profiles.Turn(SETTINGS, web=True, web_documents=True),
        profiles.Turn(SETTINGS, companion_pdfs=True),
        profiles.Turn(Settings(memory_enabled=False), web_documents=True),
    ]
    every = {name for name, tool in DEFAULTS.items()}
    for item in turns:
        toolset = profiles.CHAT_DOCUMENT.toolset(item)
        method = working_method(toolset)
        for name in every:
            # A tool's name appears in the method only when the request offers it,
            # or when an offered tool's own line names a sibling it is offered with.
            if f"`{name}" in method:
                assert name in toolset.names, (name, sorted(toolset.names))
        for name in toolset.names:
            if DEFAULTS[name].guidance:
                assert DEFAULTS[name].guidance in method


def test_a_cut_off_answer_is_shown_as_cut_off_and_an_unfinished_one_as_failed(tmp_path, monkeypatch):
    """
    The route's half of the terminal contract, through the real stream.

    Cut off at the output ceiling: what was written is stored and marked, and
    the `done` event says so. A stream that simply stopped: the existing error
    record, never a stored answer. A plan that was cut off is not a plan.
    """
    from fastapi.testclient import TestClient

    from delphi_core.config import get_settings
    from delphi_core.main import app
    from delphi_core.routers import chat as chat_router
    from tests.chat_keys import conversation_params

    settings = Settings(data_dir=tmp_path, session_secret="terminal-contract", openai_api_key="test-key")
    endings = {
        "cut": frames({"type": "response.output_text.delta", "delta": "Half an ans"},
                      {"type": "response.incomplete", "response": {
                          "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}}),
        "stopped": frames({"type": "response.output_text.delta", "delta": "It begins"}),
        "whole": frames(TEXT, completed()),
    }

    def handler(request: httpx.Request) -> httpx.Response:
        prompt = json.loads(request.content)["input"][-1]["content"]
        return httpx.Response(200, content=endings[prompt if isinstance(prompt, str) else "whole"])

    real_client = httpx.AsyncClient
    monkeypatch.setattr(chat_router.httpx, "AsyncClient", lambda *a, **k: real_client(
        *a, **{**k, "transport": httpx.MockTransport(handler)}))
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-test"})
            conversation = conversation_params(client, "general")

            def ask(prompt: str, request_id: str) -> list[dict]:
                response = client.post("/api/chat/stream", json={
                    **conversation, "prompt": prompt, "request_id": request_id})
                assert response.status_code == 200
                return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]

            cut = ask("cut", "request_cut_1")
            assert cut[-1]["type"] == "done" and cut[-1]["incomplete"] == {"reason": "max_output_tokens"}
            # How the turn ended is acted on here; it is not a frame the client reads.
            assert all(event["type"] != "turn_end" for event in cut)
            stopped = ask("stopped", "request_stop1")
            assert stopped[-1]["type"] == "error"
            whole = ask("whole", "request_whole")
            assert whole[-1]["type"] == "done" and whole[-1]["incomplete"] is None

            answers = [m for m in client.get("/api/chat", params=conversation).json()["messages"]
                       if m["role"] == "assistant"]
            assert [(m["content"], m.get("incomplete"), bool(m.get("error"))) for m in answers] == [
                ("Half an ans", {"reason": "max_output_tokens"}, False),
                ("It begins\n\nRequest failed: The model provider's response ended before it was finished.", None, True),
                ("The answer.", None, False),
            ]
    finally:
        app.dependency_overrides.clear()


def test_a_refusal_with_a_message_for_the_reader_is_shown_in_its_own_words(tmp_path, monkeypatch):
    """
    A desktop inference bridge refuses with a Responses-style JSON error whose
    message is written for the reader: a sign-in that expired, a local runtime
    that is missing. Chat shows that message, not httpx's "Client error '401
    Unauthorized' for url …". A refusal without one keeps the old wording.
    """
    from fastapi.testclient import TestClient

    from delphi_core.config import get_settings
    from delphi_core.main import app
    from delphi_core.routers import chat as chat_router
    from tests.chat_keys import conversation_params

    settings = Settings(data_dir=tmp_path, session_secret="refusal-words", openai_api_key="test-key")
    reason = ("Claude Code is not installed on this Mac. Delphi uses it to reach your Claude subscription. "
              "See Settings → Advanced → AI connection, then retry.")
    bodies = {"worded": {"json": {"error": {"message": reason, "code": "claude_reauth_required"}}},
              "plain": {"text": "unauthorized"}}
    current = {"body": "worded"}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, **bodies[current["body"]])

    real_client = httpx.AsyncClient
    monkeypatch.setattr(chat_router.httpx, "AsyncClient", lambda *a, **k: real_client(
        *a, **{**k, "transport": httpx.MockTransport(handler)}))
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-test"})
            conversation = conversation_params(client, "general")

            def ask(request_id: str) -> list[dict]:
                response = client.post("/api/chat/stream", json={
                    **conversation, "prompt": "Anything", "request_id": request_id})
                assert response.status_code == 200
                return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]

            worded = ask("request_worded")
            assert (worded[-1]["type"], worded[-1]["message"]) == ("error", reason)
            current["body"] = "plain"
            plain = ask("request_plain1")
            assert plain[-1]["type"] == "error"
            assert "Client error '401 Unauthorized'" in plain[-1]["message"]

            answers = [m["content"] for m in client.get("/api/chat", params=conversation).json()["messages"]
                       if m["role"] == "assistant"]
            assert answers[0] == f"Request failed: {reason}"
            assert "for url" not in answers[0]
    finally:
        app.dependency_overrides.clear()


def test_only_a_bounded_error_message_is_taken_from_a_refusal():
    from delphi_core.provider_errors import provider_refusal

    def refusal(**body) -> httpx.HTTPStatusError:
        response = httpx.Response(401, request=httpx.Request("POST", "https://provider.test/v1/responses"), **body)
        return httpx.HTTPStatusError("Client error '401 Unauthorized'", request=response.request, response=response)

    assert provider_refusal(refusal(json={"error": {"message": "  Sign in again.  "}})) == "Sign in again."
    assert len(provider_refusal(refusal(json={"error": {"message": "x" * 5000}}))) == 600
    # A proxy may echo the request elsewhere in its body; nothing but the message is read.
    assert provider_refusal(refusal(json={"error": {"code": "x"}, "input": "PRIVATE SOURCE"})) == "Client error '401 Unauthorized'"
    assert provider_refusal(refusal(json={"error": "flat string"})) == "Client error '401 Unauthorized'"
    assert provider_refusal(refusal(text="not json")) == "Client error '401 Unauthorized'"
    # It runs inside failure handlers: even a body that exhausts the parser falls back.
    assert provider_refusal(refusal(content=b"[" * 100_000)) == "Client error '401 Unauthorized'"
    assert provider_refusal(ValueError("other")) == "other"
