"""A side chat answers beside a conversation and leaves nothing behind (`POST /api/chat/side`)."""

import asyncio
import hashlib
import json
import threading
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from delphi_core.config import Settings, get_settings
from delphi_core.harness.prompts import SIDE_CHAT_MARKER, SIDE_CHAT_RULES
from delphi_core.main import app
from delphi_core.routers import chat as chat_router
from delphi_core.storage import LocalStorage
from tests.chat_keys import conversation_params
from tests.helpers import MINIMAL_PDF, ProviderTransport, seed_paper


def answer_events(text):
    return httpx.Response(200, content="".join(
        f"data: {json.dumps(event)}\n\n"
        for event in [{"type": "response.output_text.delta", "delta": text}]
    ).encode())


def is_side(request_body):
    return any(item.get("content") == SIDE_CHAT_MARKER for item in request_body.get("input", []))


def snapshot(root):
    """Every file under the data directory, by content."""
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def events_of(response):
    return [json.loads(line[5:]) for line in response.text.splitlines() if line.startswith("data:")]


@pytest.fixture
def reader(request, tmp_path, monkeypatch):
    """
    A signed-in client over a fake provider; each answer's `/responses` body
    lands in `sent`, each Memory selection's in `provider["selections"]`, and
    `provider["fail"]` makes the provider refuse. Files are off unless the
    test parametrizes the fixture with True.
    """
    files = getattr(request, "param", False)
    settings = Settings(data_dir=tmp_path, session_secret="side-chat", openai_api_key="test-key",
                        openai_files_enabled=files)
    sent = []
    provider = {"fail": False, "selections": [], "uploads": 0}

    def handler(request):
        if provider["fail"]:
            return httpx.Response(500, json={"error": {"message": "overloaded"}})
        if request.url.path.endswith("/files"):
            provider["uploads"] += 1
            return httpx.Response(200, json={"id": "file-side"})
        body = json.loads(request.content)
        if body.get("text", {}).get("format", {}).get("name") == "memory_selection":
            # Memory selection: choose nothing.
            provider["selections"].append(body)
            return httpx.Response(200, json={"output": [{"type": "message", "content": [
                {"type": "output_text", "text": json.dumps({"slugs": []})}]}]})
        sent.append(body)
        return answer_events("A side answer." if is_side(body) else "The main answer.")

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
            yield client, settings, sent, provider
    finally:
        app.dependency_overrides.clear()


def document_conversation(client, settings):
    storage = LocalStorage(settings)
    project = storage.create_project("reader", "Papers")["id"]
    seed_paper(settings, "reader", project,
               {"id": "paper-one", "title": "Muon", "filename": "muon.pdf", "pages": 1, "tokens": 10},
               pdf=MINIMAL_PDF)
    storage.upsert_memory_page(
        "reader",
        {"kind": "concept", "domain": "ml", "title": "Newton-Schulz", "summary": "s", "body": "An iteration."},
        max_pages=50,
    )
    return conversation_params(client, "document", project, "paper-one")


SCOPES = ["document", "general"]


def conversation_for(scope, client, settings):
    if scope == "document":
        return document_conversation(client, settings)
    return conversation_params(client, "general")


@pytest.mark.parametrize("scope", SCOPES)
def test_a_side_question_leaves_no_trace(scope, reader):
    """
    The whole store is byte-identical after a side question: no turn, title,
    persona stamp, heartbeat, trace or Memory session job, in either scope.
    """
    client, settings, sent, provider = reader
    conversation = conversation_for(scope, client, settings)
    asked = client.post("/api/chat/stream", json={
        **conversation, "prompt": "What does Muon orthogonalize?", "request_id": "main_request_1",
        "engagement_id": "engagement_1",
    })
    assert asked.status_code == 200, asked.text
    before = snapshot(settings.data_dir)
    thread_before = client.get("/api/chat", params=conversation).json()

    side = client.post("/api/chat/side", json={
        **conversation, "prompt": "Why a quintic?",
        "side_turns": [{"question": "What is Newton-Schulz?", "answer": "An iteration."}],
    })

    assert side.status_code == 200, side.text
    events = events_of(side)
    assert "".join(event["text"] for event in events if event["type"] == "delta") == "A side answer."
    done = events[-1]
    assert done["type"] == "done" and done["conversationId"] == conversation["conversation_id"]
    assert not any(event["type"] == "error" for event in events)
    assert snapshot(settings.data_dir) == before
    assert client.get("/api/chat", params=conversation).json() == thread_before
    # The snapshot sees a write: the same question asked in the main chat changes it.
    client.post("/api/chat/stream", json={**conversation, "prompt": "Why a quintic?", "request_id": "main_request_2"})
    assert snapshot(settings.data_dir) != before


@pytest.mark.parametrize("scope", SCOPES)
def test_the_side_chat_follows_the_conversation_behind_a_marker(scope, reader):
    """
    Main history, the marker, the side turns, then this turn's context and the
    question: so the model can tell the side chat from what it shares.
    """
    client, settings, sent, provider = reader
    conversation = conversation_for(scope, client, settings)
    client.post("/api/chat/stream", json={
        **conversation, "prompt": "What does Muon orthogonalize?", "request_id": "main_request_1",
    })
    main = sent[-1]

    client.post("/api/chat/side", json={
        **conversation, "prompt": "Summarize this side chat.",
        "side_turns": [
            {"question": "What is Newton-Schulz?", "answer": "An iteration."},
            {"question": "Why five steps?", "answer": "It converges."},
        ],
    })
    side = sent[-1]

    items = side["input"]
    marker = items.index({"role": "user", "content": SIDE_CHAT_MARKER})
    assert items[marker - 2:marker] == [
        {"role": "user", "content": "What does Muon orthogonalize?"},
        {"role": "assistant", "content": "The main answer."},
    ]
    assert items[marker + 1:marker + 5] == [
        {"role": "user", "content": "What is Newton-Schulz?"}, {"role": "assistant", "content": "An iteration."},
        {"role": "user", "content": "Why five steps?"}, {"role": "assistant", "content": "It converges."},
    ]
    # Ahead of the history, everything is what the main turn sent; after the
    # side turns, this turn's context, Memory second to last, then the question.
    assert marker >= 3 and items[:marker - 2] == main["input"][:marker - 2]
    assert items[marker + 5:] == main["input"][-(len(items) - marker - 5):-1] + [
        {"role": "user", "content": "Summarize this side chat."},
    ]
    if scope == "document":
        assert "<reader_memory" in json.dumps(items[-2]) and "<reader_memory" in json.dumps(main["input"][-2])
    assert SIDE_CHAT_RULES in side["instructions"]
    assert SIDE_CHAT_RULES not in main["instructions"]
    assert SIDE_CHAT_MARKER not in json.dumps(main["input"])
    # Text only: no inline artifact tools, and its own cache lineage.
    names = {tool.get("name") for tool in side.get("tools", [])}
    assert not names & {"render_artifact", "publish_artifact", "draw_display"}
    if "prompt_cache_key" in main:
        assert side["prompt_cache_key"] != main["prompt_cache_key"]


def test_an_empty_side_chat_still_carries_its_marker(reader):
    client, settings, sent, provider = reader
    conversation = conversation_for("general", client, settings)
    client.post("/api/chat/side", json={**conversation, "prompt": "Quick one?"})
    (side,) = sent
    assert side["input"][-2:] == [
        {"role": "user", "content": SIDE_CHAT_MARKER},
        {"role": "user", "content": "Quick one?"},
    ]


def test_a_side_answer_uses_the_main_composers_picks(reader):
    client, settings, sent, provider = reader
    conversation = conversation_for("general", client, settings)
    model = settings.models[-1]
    effort = settings.reasoning_efforts_for(model)[0]
    client.post("/api/chat/side", json={
        **conversation, "prompt": "Quick one?", "model": model, "reasoning_effort": effort,
    })
    assert sent[-1]["model"] == model
    assert sent[-1]["reasoning"]["effort"] == effort


@pytest.mark.parametrize("extra,status", [
    ({"mode": "plan"}, 422),
    ({"desktop_mode": "plan"}, 422),
    ({"request_id": "side_request_1"}, 422),
    ({"engagement_id": "engagement_1"}, 422),
    ({"replace_request_id": "main_request_1"}, 422),
    ({"referenced_image_ids": ["image"]}, 422),
    ({"selected_text": "a passage"}, 422),
    ({"side_turns": [{"question": "q", "answer": "a"}] * 21}, 422),
    ({"side_turns": [{"question": "q", "answer": "a", "extra": 1}]}, 422),
    ({"side_turns": [{"question": "q", "answer": ""}]}, 422),
    ({"side_turns": [{"question": "q" * 50_000, "answer": "a" * 50_000}] * 3}, 422),
    ({"generation": 7}, 409),
    ({"conversation_id": "f" * 32}, 404),
])
def test_what_a_side_question_cannot_carry_is_refused(extra, status, reader):
    client, settings, sent, provider = reader
    conversation = conversation_for("general", client, settings)
    response = client.post("/api/chat/side", json={**conversation, "prompt": "Quick one?", **extra})
    assert response.status_code == status, response.text
    assert sent == []


def test_another_readers_conversation_is_refused(reader):
    client, settings, sent, provider = reader
    conversation = conversation_for("general", client, settings)
    other = TestClient(app)
    other.post("/api/auth/register", json={"username": "someone", "password": "password-test"})
    response = other.post("/api/chat/side", json={**conversation, "prompt": "Quick one?"})
    assert response.status_code == 404, response.text
    assert sent == []


def test_a_side_question_needs_a_conversation(reader):
    client, settings, sent, provider = reader
    response = client.post("/api/chat/side", json={"scope": "general", "prompt": "Quick one?"})
    assert response.status_code == 422


def test_a_provider_failure_is_an_error_event_and_stores_nothing(reader):
    client, settings, sent, provider = reader
    conversation = conversation_for("general", client, settings)
    before = snapshot(settings.data_dir)
    provider["fail"] = True
    response = client.post("/api/chat/side", json={**conversation, "prompt": "Quick one?"})
    assert response.status_code == 200
    events = events_of(response)
    assert events[-1]["type"] == "error" and events[-1]["message"]
    assert snapshot(settings.data_dir) == before


def test_a_side_question_runs_while_the_main_answer_streams(tmp_path, monkeypatch):
    """
    No conversation lock: a side question asked while the main answer is still
    streaming is answered at once, and the main answer then finishes and is kept.
    """
    settings = Settings(data_dir=tmp_path, session_secret="side-chat", openai_api_key="test-key")
    release_main = threading.Event()

    async def handler(request):
        body = json.loads(request.content)
        if body.get("stream") is not True:
            return httpx.Response(200, json={"output": []})
        if is_side(body):
            return answer_events("A side answer.")
        deadline = time.monotonic() + 10
        while not release_main.is_set() and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        return answer_events("The main answer.")

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
            conversation = conversation_params(client, "general")
            main = {}

            def ask_main():
                main["response"] = client.post("/api/chat/stream", json={
                    **conversation, "prompt": "Main question", "request_id": "main_request_1",
                })

            asking = threading.Thread(target=ask_main)
            asking.start()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                thread = client.get("/api/chat", params=conversation).json()
                if thread["messages"]:
                    break
                time.sleep(0.01)
            side = client.post("/api/chat/side", json={**conversation, "prompt": "Quick one?"})
            assert asking.is_alive() and "response" not in main
            assert side.status_code == 200
            assert "A side answer." in side.text
            release_main.set()
            asking.join(10)
            thread = client.get("/api/chat", params=conversation).json()
    finally:
        app.dependency_overrides.clear()

    assert main["response"].status_code == 200
    assert [(m["role"], m["content"]) for m in thread["messages"]] == [
        ("user", "Main question"), ("assistant", "The main answer."),
    ]


def test_memory_is_chosen_for_the_side_question_not_the_main_thread(reader):
    """A side follow-up such as "why?" is read after its own exchanges."""
    client, settings, sent, provider = reader
    conversation = document_conversation(client, settings)
    client.post("/api/chat/stream", json={
        **conversation, "prompt": "What does Muon orthogonalize?", "request_id": "main_request_1",
    })
    client.post("/api/chat/side", json={
        **conversation, "prompt": "Why?",
        "side_turns": [{"question": "What is a quintic iteration?", "answer": "A polynomial step."}],
    })
    turn = json.dumps(provider["selections"][-1]["input"])
    assert "What is a quintic iteration?" in turn and "Why?" in turn


@pytest.mark.parametrize("reader", [True], indirect=True)
def test_the_one_shared_write_is_the_provider_file_cache(reader):
    """
    A side question that is the first to read a PDF uploads it, and records
    the upload id in the project's meta as any turn would. Nothing else moves.
    """
    client, settings, sent, provider = reader
    conversation = document_conversation(client, settings)
    before = snapshot(settings.data_dir)
    response = client.post("/api/chat/side", json={**conversation, "prompt": "Quick one?"})
    assert response.status_code == 200, response.text
    after = snapshot(settings.data_dir)
    changed = sorted(path for path in before.keys() | after.keys() if before.get(path) != after.get(path))
    assert provider["uploads"] == 1
    assert len(changed) == 1 and changed[0].endswith("meta.json") and "/projects/" in changed[0]
    assert client.get("/api/chat", params=conversation).json()["messages"] == []
