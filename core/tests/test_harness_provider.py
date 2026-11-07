"""The terminal contract: a response is finished when the provider says so, and not otherwise."""

import json

import httpx
import pytest

from delphi_core.config import Settings
from delphi_core.harness.provider import (
    ProviderError,
    ResponsesClient,
    Terminal,
    require_completed,
)

SETTINGS = Settings(openai_api_key="test-key")


def frames(*events: dict) -> bytes:
    return "".join(f"data: {json.dumps(event)}\n\n" for event in events).encode()


async def stream(handler) -> list[dict]:
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        return [event async for event in ResponsesClient(http, SETTINGS).stream({"stream": True})]


async def complete(handler, **kwargs):
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        return await ResponsesClient(http, SETTINGS).complete({}, **kwargs)


TEXT = {"type": "response.output_text.delta", "delta": "Half an ans"}
MESSAGE = {"type": "response.output_item.done", "item": {
    "type": "message", "status": "incomplete", "content": [{"type": "output_text", "text": "Half an ans"}]}}
USAGE = {"input_tokens": 900, "output_tokens": 64,
         "input_tokens_details": {"cached_tokens": 800, "cache_write_tokens": 20},
         "output_tokens_details": {"reasoning_tokens": 40}}


@pytest.mark.asyncio
async def test_a_stream_ends_exactly_one_of_four_ways():
    cases = {
        Terminal.COMPLETED: [TEXT, {"type": "response.completed", "response": {
            "status": "completed", "usage": USAGE, "service_tier": "default"}}],
        # The shape measured at the output ceiling.
        Terminal.INCOMPLETE: [TEXT, MESSAGE, {"type": "response.incomplete", "response": {
            "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "usage": USAGE}}],
        Terminal.FAILED: [TEXT, {"type": "response.failed", "response": {
            "status": "failed", "error": {"message": "The model overloaded."}}}],
        # No terminal frame at all: the connection simply stopped.
        Terminal.ENDED: [TEXT],
    }
    for expected, events in cases.items():
        got = await stream(lambda request, events=events: httpx.Response(200, content=frames(*events)))
        assert [event["type"] for event in got].count("terminal") == 1
        assert got[-1]["type"] == "terminal", expected
        result = got[-1]["result"]
        assert result.terminal is expected
        # What arrived before the end is delivered either way; the end says what to make of it.
        assert {"type": "text_delta", "text": "Half an ans"} in got

    incomplete = (await stream(lambda request: httpx.Response(200, content=frames(*cases[Terminal.INCOMPLETE]))))[-1]["result"]
    assert incomplete.reason == "max_output_tokens"
    assert incomplete.output == [MESSAGE["item"]]
    assert (incomplete.usage.input_tokens, incomplete.usage.cached_tokens, incomplete.usage.cache_write_tokens,
            incomplete.usage.output_tokens, incomplete.usage.reasoning_tokens) == (900, 800, 20, 64, 40)
    failed = (await stream(lambda request: httpx.Response(200, content=frames(*cases[Terminal.FAILED]))))[-1]["result"]
    assert failed.reason == "The model overloaded."


@pytest.mark.asyncio
async def test_an_error_frame_is_a_failure_and_nothing_after_it_is_read():
    got = await stream(lambda request: httpx.Response(200, content=frames(
        {"type": "error", "error": {"message": "Bad request shape."}}, TEXT)))
    assert [event["type"] for event in got] == ["opened", "terminal"]
    assert got[-1]["result"].terminal is Terminal.FAILED and got[-1]["result"].reason == "Bad request shape."


@pytest.mark.asyncio
async def test_a_whole_response_ends_the_same_four_ways():
    output = [{"type": "message", "content": [{"type": "output_text", "text": "{}"}]}]
    bodies = {
        Terminal.COMPLETED: {"status": "completed", "output": output, "usage": USAGE},
        Terminal.INCOMPLETE: {"status": "incomplete", "output": [], "incomplete_details": {"reason": "max_output_tokens"}},
        Terminal.FAILED: {"status": "failed", "output": [], "error": {"message": "It broke."}},
        # A body that does not say it completed is not taken to have.
        Terminal.ENDED: {"output": output},
    }
    for expected, body in bodies.items():
        result = await complete(lambda request, body=body: httpx.Response(200, json=body))
        assert result.terminal is expected
    done = await complete(lambda request: httpx.Response(200, json=bodies[Terminal.COMPLETED]))
    assert done.texts() == ["{}"] and done.usage.cached_tokens == 800


def test_an_artifact_is_only_made_from_a_completed_response():
    from delphi_core.harness.provider import ProviderResult

    assert require_completed(ProviderResult(Terminal.COMPLETED), "The digest").terminal is Terminal.COMPLETED
    for terminal, reason, said in (
        (Terminal.INCOMPLETE, "max_output_tokens", "cut off before it finished (max_output_tokens)"),
        (Terminal.FAILED, "It broke.", "It broke."),
        (Terminal.ENDED, None, "ended before the provider said it was finished"),
    ):
        with pytest.raises(ProviderError) as refused:
            require_completed(ProviderResult(terminal, reason=reason), "The digest")
        assert said in str(refused.value) and refused.value.terminal is terminal


@pytest.mark.asyncio
async def test_a_refused_request_raises_with_the_providers_own_words():
    def handler(request):
        return httpx.Response(400, json={"error": {"message": "Unknown parameter: 'tools[3]'."}})

    with pytest.raises(httpx.HTTPStatusError) as refused:
        await stream(handler)
    # Read before raising, so the reason is there to be shown.
    assert "Unknown parameter" in refused.value.response.text


@pytest.mark.asyncio
async def test_one_retry_and_only_before_anything_was_delivered(monkeypatch):
    waits: list[float] = []

    async def no_wait(seconds):
        waits.append(seconds)

    monkeypatch.setattr("delphi_core.harness.provider.asyncio.sleep", no_wait)
    done = frames(TEXT, {"type": "response.completed", "response": {"status": "completed"}})

    def flaky(first: httpx.Response):
        calls = []

        def handler(request):
            calls.append(request)
            return first if len(calls) == 1 else httpx.Response(200, content=done)

        return handler, calls

    # A rate limit waits as long as it is asked to; a provider fault and a
    # stream that closed before its first frame are asked again at once.
    for first, waited in (
        (httpx.Response(429, headers={"retry-after": "3.5"}, json={}), [3.5]),
        (httpx.Response(503, json={}), [1.0]),
        (httpx.Response(200, content=b""), [0.0]),
    ):
        waits.clear()
        handler, calls = flaky(first)
        got = await stream(handler)
        assert len(calls) == 2 and waits == waited
        assert got[-1]["result"].terminal is Terminal.COMPLETED

    # Twice is the end of it.
    calls = []
    with pytest.raises(httpx.HTTPStatusError):
        await stream(lambda request: calls.append(request) or httpx.Response(503, json={}))
    assert len(calls) == 2

    # A request the provider refused is not one to repeat.
    calls = []
    with pytest.raises(httpx.HTTPStatusError):
        await stream(lambda request: calls.append(request) or httpx.Response(400, json={}))
    assert len(calls) == 1

    # Once a frame has been delivered, a stream that then stops is not asked
    # again: the reader has already been shown part of this answer.
    calls = []
    got = await stream(lambda request: calls.append(request) or httpx.Response(200, content=frames(TEXT)))
    assert len(calls) == 1 and got[-1]["result"].terminal is Terminal.ENDED

    # A caller that waits out a busy provider itself asks for no retry here.
    calls = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(429, json={})
    )) as http:
        with pytest.raises(httpx.HTTPStatusError):
            async for _ in ResponsesClient(http, SETTINGS).stream({}, retry=False):
                pass
    assert len(calls) == 1

    # And the whole-response form retries the same faults, as many times as it is given.
    handler, calls = flaky(httpx.Response(429, headers={"retry-after": "0"}, json={}))
    waits.clear()
    result = await complete(lambda request: handler(request) if len(calls) < 1 else httpx.Response(
        200, json={"status": "completed", "output": []}))
    assert result.attempts == 2 and waits == [0.25]


def cited(*notes: dict, text: str = "An answer.") -> dict:
    return {"type": "message", "content": [{"type": "output_text", "text": text, "annotations": list(notes)}]}


def citation(url: str, title: str = "A page", **extra) -> dict:
    return {"type": "url_citation", "url": url, "title": title, "start_index": 0, "end_index": 5, **extra}


def test_an_answers_sources_are_its_citations_in_order_each_once():
    from delphi_core.harness.provider import (
        SOURCE_TITLE_MAX_CHARS,
        SOURCE_URL_MAX_CHARS,
        SOURCES_MAX,
        cited_sources,
    )

    arxiv = "https://arxiv.org/abs/2203.03466"
    output = [
        {"type": "reasoning", "summary": []},
        {"type": "web_search_call", "action": {"sources": [{"type": "url", "url": "https://consulted.example/only"}]}},
        cited(
            citation(arxiv, "  Tensor Programs V \n arXiv "),
            citation("https://github.com/microsoft/mup", ""),
            # The same page cited again is the same source.
            citation(arxiv, "A different title for the same page"),
            # Only a place a reader can be sent is a source.
            citation("javascript:alert(1)"), citation("file:///etc/passwd"), citation("ftp://example.org/x"),
            citation("mailto:someone@example.org"), citation("https:///no-host"), citation(" https://padded.example/ "),
            citation("https://example.org/" + "x" * SOURCE_URL_MAX_CHARS),
            {"type": "file_citation", "url": "https://not-a-url-citation.example/"},
            {"type": "url_citation", "url": None},
            # A character outside the BMP ahead of a citation moves its indices,
            # which are not kept, and nothing else.
            text="🧪 In 2022 ([arxiv.org](https://arxiv.org/abs/2203.03466)).",
        ),
        cited(citation("http://plain.example/page", "T" * 500)),
    ]
    sources = cited_sources(output)
    assert sources == [
        {"url": arxiv, "title": "Tensor Programs V arXiv"},
        # No title is the site's name, never an empty label.
        {"url": "https://github.com/microsoft/mup", "title": "github.com"},
        {"url": "http://plain.example/page", "title": "T" * SOURCE_TITLE_MAX_CHARS},
    ]
    # What a search consulted is not what the answer cited.
    assert all("consulted" not in source["url"] for source in sources)

    # A later round of the same turn continues the list and repeats nothing.
    later = cited_sources([cited(citation(arxiv), citation("https://openreview.net/forum?id=1"))], sources)
    assert [source["url"] for source in later] == [*(s["url"] for s in sources), "https://openreview.net/forum?id=1"]
    assert sources == cited_sources(output)  # the earlier list is not altered

    # Bounded, whatever a response does.
    many = cited(*(citation(f"https://example.org/{n}") for n in range(SOURCES_MAX + 25)))
    assert len(cited_sources([many])) == SOURCES_MAX
    assert cited_sources([]) == [] and cited_sources([{"type": "message"}]) == []
