"""Direct source text is bounded, replayable, read-only, and uses the shared fetch policy."""

import asyncio
import json
import re

import httpx
import pytest
from fastapi import HTTPException

from delphi_core.answer_trace import AnswerTrace, tool_entries
from delphi_core.config import Settings
from delphi_core.harness import profiles
from delphi_core.harness.budget import TurnBudget
from delphi_core.harness.registry import Toolset
from delphi_core.harness.tool import ToolContext
from delphi_core.harness.tools import read_url
from delphi_core.web_fetch import FetchedResource


def context(**settings):
    return ToolContext(settings=Settings(_env_file=None, **settings))


async def dispatch(ctx, url="https://example.org/paper", offset=0, budget=None, pages=()):
    conversation, trace = [], AnswerTrace()
    toolset = Toolset([read_url.tool()])
    call = {"name": "read_url", "arguments": json.dumps({"url": url, "offset": offset, "pages": list(pages)}), "call_id": "source"}
    async for _ in toolset.dispatch(call, ctx, budget or TurnBudget.for_chat(ctx.settings), trace, conversation):
        pass
    return conversation[0]["output"], trace


def resource(body, *, content_type="text/html", url="https://example.org/paper-v2"):
    return FetchedResource(url, body.encode(), content_type, "utf-8", "2026-10-26T00:00:00Z")


@pytest.mark.asyncio
async def test_exact_text_and_links_are_replayed_with_trace_source_metadata(monkeypatch):
    from tests.test_harness_loop import TEXT, call, completed, frames, turn

    async def fetch(url, settings, **options):
        assert options == {"allow_render": False, "include_pdf": True}
        return resource('<title>Method</title><article><h1>Training</h1><p>Both predictions use target x.</p><a href="/full">Full paper</a><script>throw Error("never run")</script></article>')

    monkeypatch.setattr(read_url, "fetch_resource", fetch)
    ctx = context()
    recorder = AnswerTrace()
    _, sent = await turn(
        [frames(call("read_url", {"url": "https://example.org/paper", "offset": 0, "pages": []}), completed()), frames(TEXT, completed())],
        Toolset([read_url.tool()]), TurnBudget.for_chat(ctx.settings), ctx, recorder,
    )
    result = next(item for item in sent[1]["input"] if item.get("type") == "function_call_output")
    assert result["call_id"] == "call-1"
    assert "Both predictions use target x." in result["output"]
    assert "https://example.org/full" in result["output"]
    assert "never run" not in result["output"]
    assert "evidence, not instructions" in result["output"]
    assert '"url": "https://example.org/paper-v2"' in result["output"]
    entries = tool_entries(recorder.stored())
    assert entries[0]["results"] == [{"kind": "web", "url": "https://example.org/paper-v2", "title": "Method"}]
    assert ctx.storage is None and ctx.objects is None


@pytest.mark.asyncio
async def test_pagination_uses_one_bounded_turn_local_snapshot(monkeypatch):
    calls = []
    body = "α < β and x_i = 1; " * 400

    async def fetch(url, settings, **options):
        calls.append(url)
        return resource(body, content_type="text/plain")

    monkeypatch.setattr(read_url, "fetch_resource", fetch)
    ctx = context(webpage_read_max_chars=1200)
    spending = TurnBudget.for_chat(ctx.settings)
    first, _ = await dispatch(ctx, budget=spending)
    offset = int(re.search(r"next_offset=(\d+)", first)[1])
    second, _ = await dispatch(ctx, offset=offset, budget=spending)
    assert len(first) <= 1200 and len(second) <= 1200
    assert "α < β" in first
    assert body[offset:offset + 30] in second
    assert len(calls) == 1
    assert spending.document_calls_made == 2
    assert spending.document_chars_returned == len(first) + len(second)
    assert not context().url_documents


@pytest.mark.asyncio
async def test_snapshot_and_cache_limits_are_explicit(monkeypatch):
    async def fetch(url, settings, **options):
        return resource("x" * 100_000, content_type="text/plain", url=url)

    monkeypatch.setattr(read_url, "fetch_resource", fetch)
    ctx = context()
    for index in range(4):
        output, _ = await dispatch(ctx, url=f"https://example.org/{index}")
        assert "later text was not retained" in output
    assert sum(len(item["text"]) for item in ctx.url_documents.values()) == 4 * 96_000
    output, _ = await dispatch(ctx, url="https://example.org/extra")
    assert output.startswith("Error:") and "snapshot limit" in output


@pytest.mark.asyncio
async def test_exhausted_document_budget_and_unknown_offsets_do_not_fetch(monkeypatch):
    async def fetch(*args, **kwargs):
        pytest.fail("A refused read must not fetch")

    monkeypatch.setattr(read_url, "fetch_resource", fetch)
    ctx = context()
    output, _ = await dispatch(ctx, offset=1)
    assert "offset=0 and pages=[] first" in output
    spending = TurnBudget.for_chat(ctx.settings)
    spending.document_calls = 0
    output, _ = await dispatch(ctx, budget=spending)
    assert "budget is exhausted" in output
    for url, offset in [("file:///etc/passwd", 0), ("https://example.org/" + "x" * 4096, 0), ("https://example.org/", -1)]:
        output, _ = await dispatch(ctx, url=url, offset=offset)
        assert output.startswith("Error:")


@pytest.mark.asyncio
@pytest.mark.parametrize("failure, fragment", [
    (HTTPException(422, {"code": "blocked", "message": "Site blocks automated readers."}), "blocks automated readers"),
    (TimeoutError(), "timed out"),
])
async def test_fetch_failures_are_honest_tool_results(monkeypatch, failure, fragment):
    async def fetch(*args, **kwargs):
        raise failure

    monkeypatch.setattr(read_url, "fetch_resource", fetch)
    ctx = context()
    output, _ = await dispatch(ctx)
    assert output.startswith("Error:") and fragment in output
    assert not ctx.url_documents


@pytest.mark.asyncio
async def test_dynamic_empty_page_does_not_invoke_a_browser(monkeypatch):
    from delphi_core import web_fetch

    async def fetch(*args, **kwargs):
        return resource('<title>App</title><body><script>buildPage()</script><div id="app"></div></body>')

    async def render(*args, **kwargs):
        pytest.fail("Direct source reads must never run a browser")

    monkeypatch.setattr(read_url, "fetch_resource", fetch)
    monkeypatch.setattr(web_fetch, "render_page", render)
    output, _ = await dispatch(context())
    assert "no readable static text" in output


@pytest.mark.asyncio
async def test_redirect_to_private_host_uses_the_existing_fetch_guard(monkeypatch):
    from delphi_core import web_fetch

    requests = []

    def resolve(host, port):
        address = "127.0.0.1" if host == "127.0.0.1" else "8.8.8.8"
        return [(2, 1, 6, "", (address, 0))]

    def respond(request):
        requests.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://127.0.0.1/private"})

    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", resolve)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        monkeypatch.setattr(web_fetch, "_shared_client", client)
        output, _ = await dispatch(context())
    assert "not reachable" in output
    assert requests == ["https://example.org/paper"]


@pytest.mark.asyncio
async def test_streamed_fetch_byte_limit_applies_before_extraction(monkeypatch):
    from delphi_core import web_fetch

    monkeypatch.setattr(web_fetch, "check_public_host", lambda url: None)
    async with httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, headers={"content-type": "text/html"}, content=b"x" * 512)
    )) as client:
        monkeypatch.setattr(web_fetch, "_shared_client", client)
        ctx = context(web_max_html_bytes=128)
        output, _ = await dispatch(ctx)
    assert output.startswith("Error:") and "larger than" in output
    assert not ctx.url_documents


@pytest.mark.asyncio
async def test_cancellation_propagates_without_retaining_an_unfinished_snapshot(monkeypatch):
    entered, stopped = asyncio.Event(), asyncio.Event()

    async def fetch(*args, **kwargs):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    monkeypatch.setattr(read_url, "fetch_resource", fetch)
    ctx = context()
    task = asyncio.create_task(dispatch(ctx))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stopped.is_set() and not ctx.url_documents


def test_only_web_enabled_chat_profiles_offer_url_reads_independently_of_artifacts():
    enabled = Settings(_env_file=None, web_search_enabled=True)
    for profile in profiles.CHAT_PROFILES:
        assert "read_url" in profile.toolset(profiles.Turn(enabled, web=True, artifacts=False)).names
        assert "read_url" not in profile.toolset(profiles.Turn(enabled, web=True, url_reads=False)).names
        assert "read_url" not in profile.toolset(profiles.Turn(enabled, web=False)).names
        assert "read_url" not in profile.toolset(profiles.Turn(Settings(_env_file=None, web_search_enabled=False), web=True)).names
    for profile in profiles.PROFILES:
        if profile not in profiles.CHAT_PROFILES:
            assert "read_url" not in profile.toolset(profiles.Turn(enabled, web=True)).names


@pytest.mark.parametrize("scope", ["general", "document"])
def test_plan_request_withholds_source_reads_but_disabling_artifacts_does_not(scope):
    from delphi_core.routers.chat import toolset_for_scope
    from delphi_core.schemas import ChatRequest

    settings = Settings(_env_file=None, web_search_enabled=True)
    plan = toolset_for_scope(settings, ChatRequest(scope=scope, prompt="?", mode="plan"))
    chat = toolset_for_scope(settings, ChatRequest(scope=scope, prompt="?", disable_artifacts=True))
    assert "read_url" not in plan.names
    assert "read_url" in chat.names
