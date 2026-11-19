"""A stored PDF reaches the model whichever provider this deployment talks to."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from delphi_core.config import Settings, get_settings
from delphi_core.main import app
from delphi_core.provider_files import InlinePdf, pdf_input_block, provider_file_missing
from delphi_core.routers import chat as chat_router
from delphi_core.routers.projects import delete_openai_files
from delphi_core.storage import LocalStorage
from tests.helpers import seed_paper
from tests.helpers import ProviderTransport

PDF = b"%PDF-1.4 provider test"


def sse(*deltas: str) -> bytes:
    return "".join(
        f"data: {json.dumps({'type': 'response.output_text.delta', 'delta': delta})}\n\n"
        for delta in deltas
    ).encode()


def ask(tmp_path, monkeypatch, settings: Settings, stored_file_id: str | None, handler):
    """Ask one document question through the route; return the stream and the store."""
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
            paper = {"id": "paper-one", "title": "Paper", "filename": "paper.pdf", "pages": 1, "tokens": 10}
            if stored_file_id:
                paper["openaiFileId"] = stored_file_id
            seed_paper(settings, "reader", project, paper, pdf=PDF)
            conversation = client.post("/api/chat/conversations", json={
                "scope": "document", "project_id": project, "paper_id": "paper-one",
                "creation_key": "provider_files",
            }).json()
            streamed = client.post("/api/chat/stream", json={
                "scope": "document", "project_id": project, "paper_id": "paper-one",
                "prompt": "What does it say?", "conversation_id": conversation["id"], "generation": 0,
            })
            return streamed, storage.get_paper("reader", project, "paper-one")
    finally:
        app.dependency_overrides.clear()


def test_without_a_files_api_the_pdf_travels_inline_and_the_stored_id_is_kept(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path, session_secret="provider-files", openai_api_key="bridge-token",
                        openai_files_enabled=False)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, content=sse("Inline answer."))

    streamed, paper = ask(tmp_path, monkeypatch, settings, "file-minted-by-the-api", handler)

    assert streamed.status_code == 200 and "Inline answer." in streamed.text
    assert all(not request.url.path.endswith("/files") for request in requests)
    sent = json.loads(requests[0].content)
    blocks = [block for item in sent["input"] if isinstance(item.get("content"), list)
              for block in item["content"] if block.get("type") == "input_file"]
    assert blocks and "file_id" not in blocks[0]
    assert blocks[0]["filename"] == "paper.pdf"
    assert blocks[0]["file_data"].startswith("data:application/pdf;base64,")
    # Left for the provider that minted it: switching back costs no upload.
    assert paper["openaiFileId"] == "file-minted-by-the-api"


def test_a_file_the_provider_no_longer_has_is_uploaded_again_once(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path, session_secret="provider-files", openai_api_key="api-key")
    uploads: list[httpx.Request] = []
    answers: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/files"):
            uploads.append(request)
            return httpx.Response(200, json={"id": "file-fresh"})
        answers.append(json.loads(request.content))
        if len(answers) == 1:
            return httpx.Response(404, json={"error": {
                "message": "Files [file-delphi-0123456789abcdef01234567] were not found",
                "type": "invalid_request_error"}})
        return httpx.Response(200, content=sse("Recovered."))

    streamed, paper = ask(tmp_path, monkeypatch, settings, "file-delphi-0123456789abcdef01234567", handler)

    assert streamed.status_code == 200 and "Recovered." in streamed.text
    assert "Request failed" not in streamed.text
    assert len(uploads) == 1 and len(answers) == 2
    retried = json.dumps(answers[1])
    assert "file-fresh" in retried and "file-delphi-" not in retried
    assert paper["openaiFileId"] == "file-fresh"


def test_a_missing_file_is_repaired_only_once(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path, session_secret="provider-files", openai_api_key="api-key")
    answers = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal answers
        if request.url.path.endswith("/files"):
            return httpx.Response(200, json={"id": "file-also-gone"})
        answers += 1
        return httpx.Response(404, json={"error": {"message": "Files [file-also-gone] were not found"}})

    streamed, _ = ask(tmp_path, monkeypatch, settings, "file-gone", handler)

    assert answers == 2
    # The provider's own words, not httpx's "Client error '404 Not Found' for url …".
    assert "Files [file-also-gone] were not found" in streamed.text


def test_the_missing_file_check_needs_a_404_about_files():
    def response(status: int, message: str) -> httpx.Response:
        return httpx.Response(status, json={"error": {"message": message}})

    assert provider_file_missing(response(404, "Files [file-a] were not found"), ["file-a"])
    assert provider_file_missing(response(404, "No such File object: file-a"), ["file-a"])
    assert not provider_file_missing(response(400, "Files [file-a] were not found"), ["file-a"])
    assert not provider_file_missing(response(404, "Model not found"), ["file-a"])
    assert not provider_file_missing(response(404, "Files [file-a] were not found"), [])


def test_an_inline_pdf_is_an_input_file_with_data():
    assert pdf_input_block(InlinePdf("a.pdf", "data:application/pdf;base64,AA==")) == {
        "type": "input_file", "filename": "a.pdf",
        "file_data": "data:application/pdf;base64,AA==", "detail": "low",
    }
    assert pdf_input_block("file-a") == {"type": "input_file", "file_id": "file-a", "detail": "low"}


@pytest.mark.asyncio
async def test_without_a_files_api_nothing_is_deleted_remotely(monkeypatch):
    calls: list[str] = []

    class Recorder:
        def __init__(self, *args, **kwargs): ...
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return False
        async def delete(self, url, **kwargs):
            calls.append(url)

    from delphi_core.routers import projects
    monkeypatch.setattr(projects.httpx, "AsyncClient", Recorder)
    await delete_openai_files(["file-a"], Settings(openai_api_key="token", openai_files_enabled=False))
    assert calls == []
    await delete_openai_files(["file-a"], Settings(openai_api_key="token"))
    assert calls and calls[0].endswith("/files/file-a")


def test_shutdown_hands_back_filing_that_was_still_running(tmp_path):
    """A server stopped mid-drain (a desktop switching connections, a Cloud Run
    instance being replaced) returns the claim unspent instead of stranding it."""
    from delphi_core.routers import memory as memory_router

    settings = Settings(data_dir=tmp_path, session_secret="provider-files")
    released: list[str] = []
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app):
            memory_router._HELD_CLAIMS["reader:job-1"] = lambda: released.append("job-1")
    finally:
        app.dependency_overrides.clear()
    assert released == ["job-1"]
    assert memory_router._HELD_CLAIMS == {}


def test_a_claim_that_cannot_be_released_does_not_stop_the_others():
    from delphi_core.routers import memory as memory_router

    released: list[str] = []

    def broken() -> None:
        raise RuntimeError("store unavailable")

    memory_router._HELD_CLAIMS.update({"a:1": broken, "a:2": lambda: released.append("2")})
    assert memory_router.release_held_claims() == 1
    assert released == ["2"] and memory_router._HELD_CLAIMS == {}
