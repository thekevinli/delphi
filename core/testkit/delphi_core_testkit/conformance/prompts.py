"""
What a chat request is told the reader has read, on every store the
consumer's `store_harness` opens: the `Reader:` line's "asked about", read
from a page's history, and the request that carries it.
"""

import json
import re

import httpx
import pytest

from delphi_core.config import Settings
from delphi_core.harness import profiles
from delphi_core.memory_harness import open_chosen_memory
from delphi_core.routers.chat import select_reader_memory
from delphi_core.schemas import ChatRequest
from delphi_core.storage import LocalObjectStore
from delphi_core.harness.budget import TurnBudget
from delphi_core.harness.loop import run_turn
from delphi_core.harness.provider import ResponsesClient
from delphi_core.harness.tool import ToolContext

from delphi_core_testkit.conformance._support import ProviderTransport


class CountingHistory:
    """A store that counts how often a page's history is read."""

    def __init__(self, storage):
        self._storage, self.asked = storage, []

    def __getattr__(self, name):
        return getattr(self._storage, name)

    def page_history(self, username, slugs):
        self.asked.append(list(slugs))
        return self._storage.page_history(username, slugs)


@pytest.fixture
def store(store_harness, tmp_path):
    storage = store_harness.make(tmp_path)
    storage.create_account("reader", None, "salt", "hash")
    return storage


def asked_about_library(storage):
    """Three pages: one a conversation revised, one only a document wrote, and a source page."""
    project = storage.create_project("reader", "Embeddings")
    storage.add_paper("reader", project["id"], {"id": "w2v", "title": "Word2vec", "filename": "w2v.pdf"})
    cite = [{"id": 1, "paperId": "w2v", "page": 3, "section": None, "noteId": None, "claimType": "author-claim"}]
    concept = {"kind": "concept", "domain": "ml", "summary": "An idea."}
    storage.upsert_memory_page("reader", {**concept, "title": "Skip-gram", "body": "Predict nearby words. See [[random-walks]] and [[word2vec-paper]].", "citations": cite}, max_pages=50, trigger="document")
    storage.upsert_memory_page("reader", {**concept, "title": "Skip-gram", "body": "Predict nearby words, as asked. See [[random-walks]] and [[word2vec-paper]].", "citations": cite, "expectedRevision": 1}, max_pages=50, trigger="conversation")
    storage.upsert_memory_page("reader", {**concept, "title": "Random walks", "body": "A walk is a sampled path."}, max_pages=50, trigger="document")
    storage.upsert_memory_page("reader", {**concept, "title": "Negative sampling", "body": "Sample the negatives."}, max_pages=50, trigger="conversation")
    storage.upsert_memory_page("reader", {"kind": "source", "domain": "ml", "title": "Word2vec paper", "summary": "Its digest.", "body": "Digest.", "sourcePaperId": "w2v"}, max_pages=50, trigger="conversation")
    return project


def reader_lines(text: str) -> dict[str, str]:
    return dict(re.findall(r"^=== \[\[([^\]]+)\]\][^\n]*\n(Reader: [^\n]*)", text, flags=re.M))


def test_an_opened_page_says_the_reader_asked_about_it_from_one_read_of_history(store):
    asked_about_library(store)
    settings = Settings(_env_file=None)
    asked_on = store.page_history("reader", ["skip-gram"])["skip-gram"]["asked"]["createdAt"][:10]
    assert re.fullmatch(r"\d{4}-\d\d-\d\d", asked_on)
    counting = CountingHistory(store)

    text = open_chosen_memory(["skip-gram", "random-walks", "negative-sampling", "word2vec-paper"], counting, "reader", settings)[0]

    assert reader_lines(text) == {
        "skip-gram": f'Reader: in library, not finished: "Word2vec"; asked about {asked_on}',
        "random-walks": "Reader: not drawn from a document",
        "negative-sampling": f"Reader: not drawn from a document; asked about {asked_on}",
        # A source page has no version history, whatever its writer said caused it.
        "word2vec-paper": 'Reader: in library, not finished: "Word2vec"',
    }
    # One read for the whole open, naming exactly the pages opened.
    assert counting.asked == [["skip-gram", "random-walks", "negative-sampling", "word2vec-paper"]]
    # Nothing of it is stored on the page or sent with it.
    page = store.get_memory_page("reader", "skip-gram")
    assert "asked" not in json.dumps(page).replace("as asked", "")


def test_twenty_one_later_revisions_take_the_stamp_with_them(store):
    asked_about_library(store)
    settings = Settings(_env_file=None)
    cite = store.get_memory_page("reader", "skip-gram")["citations"]

    def line() -> str:
        return open_chosen_memory(["skip-gram"], store, "reader", settings)[0].splitlines()[1]

    said = []
    for number in range(1, 22):
        store.upsert_memory_page("reader", {"kind": "concept", "domain": "ml", "title": "Skip-gram", "summary": "An idea.", "body": f"Revision {number}.", "citations": cite}, max_pages=50, trigger="document")
        said.append("asked about" in line())
    # Twenty revisions are kept, so the conversation's row is the oldest kept
    # after nineteen later ones and is dropped by the twentieth.
    assert said == [True] * 19 + [False, False]
    assert line() == 'Reader: in library, not finished: "Word2vec"'


@pytest.mark.asyncio
async def test_the_chat_request_carries_it_in_both_scopes(store, tmp_path):
    asked_about_library(store)
    settings = Settings(_env_file=None, data_dir=tmp_path, openai_api_key="test-key")
    counting = CountingHistory(store)

    # Beside a document: the chosen pages are opened into `<reader_memory>`.
    def chooser(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"output": [{"type": "message", "content": [
            {"type": "output_text", "text": json.dumps({"slugs": ["skip-gram", "negative-sampling", "random-walks"]})}]}]})

    async with httpx.AsyncClient(transport=ProviderTransport(chooser)) as client:
        memory = await select_reader_memory(
            client, counting, "reader", settings, ChatRequest(scope="document", prompt="How are negatives drawn?", paper_id="other"),
            [], open_paper={"id": "other", "title": "Other"}, held=[{"id": "other", "title": "Other"}],
            objects=LocalObjectStore(tmp_path),
        )
    given = reader_lines(memory.block["content"][0]["text"])
    assert re.fullmatch(r'Reader: in library, not finished: "Word2vec"; asked about \d{4}-\d\d-\d\d', given["skip-gram"])
    assert re.fullmatch(r"Reader: not drawn from a document; asked about \d{4}-\d\d-\d\d", given["negative-sampling"])
    assert given["random-walks"] == "Reader: not drawn from a document"
    assert len(counting.asked) == 1

    # In Memory chat: the model opens them, and the next request holds what it was shown.
    turns: list[dict] = []

    def provider(request: httpx.Request) -> httpx.Response:
        turns.append(json.loads(request.content))
        events = (
            [{"type": "response.output_item.done", "item": {"type": "function_call", "call_id": "c1", "name": "open_memory",
                                                            "arguments": json.dumps({"slugs": ["skip-gram", "random-walks"]})}}]
            if len(turns) == 1 else [{"type": "response.output_text.delta", "delta": "Answer"}]
        )
        return httpx.Response(200, content="".join("data: " + json.dumps(event) + "\n\n" for event in events).encode())

    toolset = profiles.CHAT_GENERAL.toolset(profiles.Turn(settings))
    assert "open_memory" in toolset.names
    async with httpx.AsyncClient(transport=ProviderTransport(provider)) as client:
        turn = run_turn(
            ResponsesClient(client, settings), {"model": "gpt-6.1-sol", "input": [], "tools": toolset.specs()}, toolset,
            TurnBudget.for_chat(settings), ToolContext(settings=settings, username="reader", storage=counting, offered=toolset.names),
        )
        [event async for event in turn]
    shown = reader_lines(next(item["output"] for item in turns[1]["input"] if item.get("type") == "function_call_output"))
    assert shown == {"skip-gram": given["skip-gram"], "random-walks": "Reader: not drawn from a document"}
    assert len(counting.asked) == 2
