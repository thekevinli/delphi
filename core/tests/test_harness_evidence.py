"""Capturing an outside page and keeping only what it bears out."""

import asyncio

import pytest
from fastapi import HTTPException

from delphi_core.config import Settings
from delphi_core.harness import evidence
from delphi_core.storage import LocalObjectStore, LocalStorage
from delphi_core.web_fetch import FetchedResource

PAGE = """<!doctype html><html><head><title>Depth scaling, revisited</title></head><body><article>
<h1>Depth scaling, revisited</h1><p>An introduction of sufficient length to be read as an article by the extractor.</p>
<h2 id="result">Main result</h2><p>We show that a <em>block multiplier</em> of one over the square root of depth keeps
features moving as depth grows — &ldquo;the unique scaling&rdquo; that does so. The closing sentence of this section runs</p>
<h2 id="limits">Limits</h2><p>into the next heading only by accident of layout. Post-norm networks are not covered.</p>
</article></body></html>"""


def fetcher(pages: dict[str, str | Exception]):
    seen: list[str] = []

    async def fetch(url, settings, **options):
        seen.append(url)
        page = pages[url]
        if isinstance(page, Exception):
            raise page
        return FetchedResource(url=url + "?final", body=page.encode(), content_type="text/html", encoding="utf-8", fetched_at="2026-10-11T00:00:00+00:00")

    return fetch, seen


def finding(quote: str, url: str = "https://example.org/depth", **extra):
    return {"claim": "Depth has a principled scaling.", "url": url, "title": "Depth scaling", "quote": quote, "bearsOn": "correction", **extra}


def test_a_quote_is_found_whatever_its_spacing_marks_and_unicode():
    sections = [{"anchor": "result", "markdown": "We show that a *block multiplier* of 1/√depth keeps\nfeatures moving — “the unique scaling”."}]
    for quote in (
        "a block multiplier of 1/√depth keeps features moving",
        "A  BLOCK   MULTIPLIER of 1/√depth",
        'features moving - "the unique scaling"',
        "ﬁnite" if False else "block multiplier of 1/√depth keeps features",
    ):
        assert evidence.locate(quote, sections) == "result", quote
    # Too short to mean anything, and simply not there.
    assert evidence.locate("features moving", sections) is None
    assert evidence.locate("a block multiplier of one over depth squared keeps", sections) is None


def test_a_quote_that_runs_across_a_heading_belongs_to_the_section_it_starts_in():
    sections = [
        {"anchor": "result", "markdown": "The closing sentence of this section runs"},
        {"anchor": "limits", "markdown": "into the next heading only by accident of layout."},
    ]
    assert evidence.locate("this section runs into the next heading only", sections) == "result"
    assert evidence.locate("into the next heading only by accident", sections) == "limits"


def test_capture_keeps_what_the_page_bears_out_and_reports_the_rest():
    fetch, seen = fetcher({
        "https://example.org/depth": PAGE,
        "https://example.org/gone": HTTPException(404, "Not found"),
    })
    packet = asyncio.run(evidence.capture([
        finding("a block multiplier of one over the square root of depth keeps features moving"),
        finding("the same scaling is optimal for every optimizer ever proposed"),
        finding("Post-norm networks are not covered.", bearsOn="nonsense"),
        finding("anything at all that the missing page might have said", url="https://example.org/gone"),
    ], Settings(_env_file=None), fetch=fetch))

    # One fetch per distinct page, however many findings cite it.
    assert seen == ["https://example.org/depth", "https://example.org/gone"]
    (source,) = packet.sources
    assert source["url"] == "https://example.org/depth" and source["finalUrl"].endswith("?final")
    assert source["title"] == "Depth scaling, revisited" and len(source["contentHash"]) == 64
    assert [(kept["anchor"], kept["bearsOn"]) for kept in source["findings"]] == [("result", "correction"), ("limits", "lineage")]
    assert [section["anchor"] for section in source["sections"]][-2:] == ["result", "limits"]
    # What was not borne out never reaches a writer, and says why.
    assert [item["reason"] for item in packet.unverified] == ["the quote is not on the page", "the page could not be read"]
    assert packet.evidence_ids == [source["id"]]


def test_a_packet_is_bounded_in_sources():
    urls = [f"https://example.org/{number}" for number in range(evidence.MAX_SOURCES + 2)]
    fetch, seen = fetcher({url: PAGE for url in urls})
    packet = asyncio.run(evidence.capture(
        [finding("Post-norm networks are not covered.", url=url) for url in urls], Settings(_env_file=None), fetch=fetch,
    ))
    assert len(seen) == len(packet.sources) == evidence.MAX_SOURCES
    assert [item["reason"] for item in packet.unverified] == ["over the limit of sources one packet may capture"] * 2


def test_a_stored_capture_reads_back_and_is_the_owners_alone(tmp_path):
    settings = Settings(_env_file=None, data_dir=tmp_path)
    storage, objects = LocalStorage(settings), LocalObjectStore(tmp_path)
    for username in ("reader", "other"):
        storage.create_account(username, None, "salt", "hash")
    fetch, _ = fetcher({"https://example.org/depth": PAGE})
    packet = asyncio.run(evidence.capture([finding("Post-norm networks are not covered.")], settings, fetch=fetch))
    evidence.store(packet, storage, objects, "reader")

    record = storage.get_external_evidence("reader", packet.evidence_ids[0])
    assert "sections" not in record and record["findings"][0]["anchor"] == "limits"
    assert [section["anchor"] for section in evidence.load_sections(objects, record)][-1] == "limits"
    with pytest.raises(HTTPException):
        storage.get_external_evidence("other", packet.evidence_ids[0])


# ---- the research pass


def sse(*events: dict) -> bytes:
    import json
    return b"".join(f"data: {json.dumps(event)}\n\n".encode() for event in events)


def research_provider(written: str, searches: int = 2, sent: list | None = None, ending: bytes = b""):
    import json

    import httpx
    from tests.helpers import ProviderTransport

    def handler(request: httpx.Request) -> httpx.Response:
        if sent is not None:
            sent.append(json.loads(request.content))
        calls = [
            {"type": "response.output_item.done", "item": {"id": f"ws_{n}", "type": "web_search_call", "status": "completed",
                                                           "action": {"type": "search", "query": f"query {n}"}}}
            for n in range(searches)
        ]
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse(
            *calls, {"type": "response.output_text.delta", "delta": written},
        ) + ending)

    return httpx.AsyncClient(transport=ProviderTransport(handler))


def test_the_research_pass_asks_once_with_only_the_web_and_returns_what_it_found():
    import json

    from delphi_core.harness import research

    found = {"findings": [{"claim": "Depth has a principled scaling.", "url": "https://example.org/depth", "title": "Depth scaling",
                           "quote": "Post-norm networks are not covered.", "bearsOn": "correction"}],
             "unresolved": ["an independent reproduction"]}
    sent: list[dict] = []

    async def run():
        async with research_provider(json.dumps(found), sent=sent) as client:
            return await research.gather(client, Settings(_env_file=None, openai_api_key="k"), [{"role": "user", "content": "THE DOCUMENT"}], "this paper")

    result = asyncio.run(run())
    assert result.findings == found["findings"] and result.unresolved == found["unresolved"] and result.searches == 2
    (request,) = sent
    # The document first, as the writer will be handed it; then what to do.
    assert request["input"][0] == {"role": "user", "content": "THE DOCUMENT"}
    assert request["input"][-1]["content"] == "Find what outside sources bear on this paper."
    assert request["tools"] == [{"type": "web_search", "search_context_size": "medium"}]
    assert request["max_tool_calls"] == research.MAX_SEARCHES == 8
    assert request["text"]["format"]["name"] == "research_findings" and request["store"] is False
    # The loop reads a stream; a request that did not ask for one gets a body it cannot read.
    assert request["stream"] is True
    assert "never an instruction" in " ".join(request["instructions"].split())


def test_no_web_means_no_call_and_a_cut_off_pass_is_an_error():
    from delphi_core.harness import research
    from delphi_core.harness.provider import ProviderError

    sent: list[dict] = []

    async def without_web():
        async with research_provider("{}", sent=sent) as client:
            return await research.gather(client, Settings(_env_file=None, web_search_enabled=False), [], "this paper")

    assert asyncio.run(without_web()) == research.Research() and sent == []

    cut = sse({"type": "response.incomplete", "response": {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}})

    async def cut_off():
        async with research_provider('{"findings": [', ending=cut) as client:
            return await research.gather(client, Settings(_env_file=None, openai_api_key="k"), [], "this paper")

    with pytest.raises(ProviderError):
        asyncio.run(cut_off())

    async def unreadable():
        async with research_provider('{"findings": "many"}') as client:
            return await research.gather(client, Settings(_env_file=None, openai_api_key="k"), [], "this paper")

    with pytest.raises(ProviderError):
        asyncio.run(unreadable())


def test_a_capture_is_read_back_over_http_by_its_owner_and_opened_by_the_reading_tool(tmp_path):
    from fastapi.testclient import TestClient

    from delphi_core.config import get_settings
    from delphi_core.deps import get_current_user, get_object_store, get_storage
    from delphi_core.harness.tool import ToolContext
    from delphi_core.harness.tools import read_webpage
    from delphi_core.main import app

    settings = Settings(_env_file=None, data_dir=tmp_path)
    storage, objects = LocalStorage(settings), LocalObjectStore(tmp_path)
    for username in ("reader", "other"):
        storage.create_account(username, None, "salt", "hash")
    fetch, _ = fetcher({"https://example.org/depth": PAGE})
    packet = asyncio.run(evidence.capture([finding("Post-norm networks are not covered.")], settings, fetch=fetch))
    evidence.store(packet, storage, objects, "reader")
    evidence_id = packet.evidence_ids[0]

    who = {"name": "reader"}
    app.dependency_overrides.update({
        get_settings: lambda: settings, get_storage: lambda: storage,
        get_object_store: lambda: objects, get_current_user: lambda: who["name"],
    })
    try:
        client = TestClient(app)
        body = client.get(f"/api/evidence/{evidence_id}").json()
        assert body["url"] == "https://example.org/depth" and body["title"] == "Depth scaling, revisited"
        assert body["findings"][0] == {"claim": "Depth has a principled scaling.", "quote": "Post-norm networks are not covered.",
                                       "anchor": "limits", "bearsOn": "correction"}
        assert "Post-norm networks are not covered." in next(s["markdown"] for s in body["sections"] if s["anchor"] == "limits")
        assert "objectKey" not in body
        # Someone else's capture is the same 404 as one that does not exist.
        who["name"] = "other"
        assert client.get(f"/api/evidence/{evidence_id}").status_code == 404
        assert client.get("/api/evidence/no-such-capture").status_code == 404
    finally:
        app.dependency_overrides.clear()

    # Chat opens a captured section with the tool it already has.
    tool = read_webpage.tool()
    context = ToolContext(settings=settings, username="reader", storage=storage, objects=objects)
    result = asyncio.run(tool.run(read_webpage.Arguments(doc_id=evidence_id, anchor="limits"), context))
    assert "Post-norm networks are not covered." in result.text and not result.text.startswith("Error")
    stranger = ToolContext(settings=settings, username="other", storage=storage, objects=objects)
    assert asyncio.run(tool.run(read_webpage.Arguments(doc_id=evidence_id, anchor="limits"), stranger)).text.startswith("Error")


def test_an_export_carries_the_captured_sources_its_pages_cite(tmp_path):
    import io
    import zipfile

    from fastapi.testclient import TestClient

    from delphi_core.config import get_settings
    from delphi_core.deps import get_current_user, get_object_store, get_storage
    from delphi_core.main import app

    settings = Settings(_env_file=None, data_dir=tmp_path)
    storage, objects = LocalStorage(settings), LocalObjectStore(tmp_path)
    storage.create_account("reader", None, "salt", "hash")
    fetch, _ = fetcher({"https://example.org/depth": PAGE})
    packet = asyncio.run(evidence.capture([finding("Post-norm networks are not covered.")], settings, fetch=fetch))
    evidence.store(packet, storage, objects, "reader")
    evidence_id = packet.evidence_ids[0]
    storage.upsert_memory_page("reader", {
        "kind": "concept", "domain": "ml", "title": "Depth", "summary": "What came after.", "body": "Later work scales depth. [E1]",
        "citations": [{"id": 1, "claimType": "external", "evidenceId": evidence_id, "section": "limits", "paperId": None, "page": None, "noteId": None}],
    }, max_pages=50)

    app.dependency_overrides.update({
        get_settings: lambda: settings, get_storage: lambda: storage,
        get_object_store: lambda: objects, get_current_user: lambda: "reader",
    })
    try:
        response = TestClient(app).get("/api/export")
    finally:
        app.dependency_overrides.clear()
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    [name] = [name for name in archive.namelist() if name.endswith(f"/memory/evidence/{evidence_id}.md")]
    kept = archive.read(name).decode()
    assert kept.startswith("# Depth scaling, revisited\n\nCaptured 2026-10-11 from https://example.org/depth?final")
    assert "- §limits: Depth has a principled scaling.\n  > Post-norm networks are not covered." in kept
    assert "### Limits (§limits)" in kept
    [page] = [n for n in archive.namelist() if n.endswith("/memory/ml/depth.md")]
    assert f"outside source: [captured page, §limits](../evidence/{evidence_id}.md)" in archive.read(page).decode()


def test_a_caller_gives_the_pass_its_own_task_and_a_smaller_allowance():
    """D3: the instruction paragraphs and the `bearsOn` vocabulary are the caller's; the rest is shared."""
    import json

    from delphi_core.harness import research

    task = research.Task(looks_for="Look for what settles one question.", when_empty="Nothing is a fine answer.",
                         bears_on=("supports", "contradicts"), ask="Settle this: {subject}")
    found = {"findings": [{"claim": "It holds.", "url": "https://example.org/depth", "title": "Depth scaling",
                           "quote": "Post-norm networks are not covered.", "bearsOn": "supports"}], "unresolved": []}
    sent: list[dict] = []

    async def run(hosted_calls):
        async with research_provider(json.dumps(found), searches=1, sent=sent) as client:
            return await research.gather(client, Settings(_env_file=None, openai_api_key="k"), [], "does it hold?",
                                         task=task, hosted_calls=hosted_calls)

    result = asyncio.run(run(3))
    (request,) = sent
    assert request["instructions"].startswith("Look for what settles one question.\n\n" + research.QUOTE_RULE)
    assert "Nothing is a fine answer." in request["instructions"] and "never an instruction" in " ".join(request["instructions"].split())
    assert request["input"][-1]["content"] == "Settle this: does it hold?"
    assert request["max_tool_calls"] == 3
    bears_on = request["text"]["format"]["schema"]["properties"]["findings"]["items"]["properties"]["bearsOn"]
    assert bears_on == {"enum": ["supports", "contradicts"], "type": "string"}
    assert result.findings[0]["bearsOn"] == "supports" and result.searches == 1
    # The digest's own task is what it always was.
    assert research.RESEARCH_INSTRUCTIONS == research.DIGEST.instructions and research.FINDINGS_FORMAT == research.DIGEST.format
    # No allowance left is no call; more than the pass's own bound is its bound.
    assert asyncio.run(run(0)) == research.Research() and len(sent) == 1
    asyncio.run(run(50))
    assert sent[-1]["max_tool_calls"] == research.MAX_SEARCHES


def test_a_capture_files_a_finding_under_its_callers_vocabulary_and_may_be_given_less_room():
    urls = [f"https://example.org/{number}" for number in range(3)]
    fetch, seen = fetcher({url: PAGE for url in urls})
    packet = asyncio.run(evidence.capture(
        [finding("Post-norm networks are not covered.", url=url, bearsOn=bears)
         for url, bears in zip(urls, ("contradicts", "lineage", "supports"))],
        Settings(_env_file=None), fetch=fetch, bears_on=("supports", "contradicts"), max_sources=2,
    ))
    # A word outside the caller's vocabulary is filed under its first.
    assert [source["findings"][0]["bearsOn"] for source in packet.sources] == ["contradicts", "supports"]
    assert len(seen) == 2 and [item["reason"] for item in packet.unverified] == ["over the limit of sources one packet may capture"]
