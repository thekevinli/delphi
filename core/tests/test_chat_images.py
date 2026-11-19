import io
import json
import httpx
import pytest
from fastapi import UploadFile
from fastapi.testclient import TestClient
from PIL import Image

from delphi_core.storage.conversations import selector
from tests.chat_keys import conversation_params
from delphi_core.chat_images import normalize_chat_image
from delphi_core.config import Settings, get_settings
from delphi_core.main import app
from delphi_core.routers.chat import build_responses_input, build_responses_payload
from tests.helpers import run_model_turns
from delphi_core.schemas import MAX_REFERENCED_IMAGES, ChatRequest
from delphi_core.storage import LocalObjectStore, LocalStorage
from tests.helpers import ProviderTransport


def encoded_image(fmt: str = "PNG", size: tuple[int, int] = (800, 400), mode: str = "RGBA") -> bytes:
    source = io.BytesIO()
    color = (255, 0, 0, 100) if mode == "RGBA" else (255, 0, 0)
    Image.new(mode, size, color).save(source, fmt)
    return source.getvalue()


def damaged_png() -> bytes:
    """A PNG that opens and reports its size, with one byte of its pixels wrong."""
    payload = bytearray(encoded_image())
    payload[payload.index(b"IDAT") + 6] ^= 0xFF
    return bytes(payload)


def upload(payload: bytes, filename: str, content_type: str) -> UploadFile:
    return UploadFile(io.BytesIO(payload), filename=filename, headers={"content-type": content_type})


def test_normalization_bounds_pixels_flattens_alpha_and_strips_metadata():
    normalized = normalize_chat_image(
        upload(encoded_image(), "figure.png", "image/png"),
        max_source_bytes=20 * 1024 * 1024,
        max_pixels=40_000_000,
        max_side=512,
        thumbnail_side=96,
    )
    try:
        with Image.open(normalized.image_path) as image:
            assert image.size == (512, 256)
            assert image.mode == "RGB"
            assert not image.info.get("exif")
        with Image.open(normalized.thumbnail_path) as thumbnail:
            assert max(thumbnail.size) == 96
    finally:
        normalized.cleanup()


@pytest.mark.parametrize(
    ("payload", "filename", "content_type"),
    [
        (encoded_image(), "figure.jpg", "image/jpeg"),
        (b"%PDF-1.7\n", "figure.png", "image/png"),
        (b"<svg xmlns='http://www.w3.org/2000/svg'/>", "figure.svg", "image/svg+xml"),
        # Recognised as a PNG, and refused only once its bytes are checked.
        (damaged_png(), "figure.png", "image/png"),
    ],
)
def test_spoofed_or_unsupported_images_are_415(payload, filename, content_type):
    with pytest.raises(Exception) as exc:
        normalize_chat_image(
            upload(payload, filename, content_type),
            max_source_bytes=20 * 1024 * 1024,
            max_pixels=40_000_000,
            max_side=512,
            thumbnail_side=96,
        )
    assert getattr(exc.value, "status_code", None) == 415


def test_image_free_input_shape_is_unchanged_and_images_only_touch_final_turn():
    body = ChatRequest(scope="document", prompt="Compare this chart.", paper_id="paper")
    sources = [({"id": "paper", "title": "Paper", "filename": "paper.pdf"}, "file-1")]
    plain = build_responses_input(sources, [], body)
    with_image = build_responses_input(
        sources,
        [],
        body,
        image_blocks=[{"type": "input_image", "image_url": "data:image/webp;base64,AA==", "detail": "low"}],
    )
    assert plain[:-1] == with_image[:-1]
    assert plain[-1] == {"role": "user", "content": "Compare this chart."}
    assert with_image[-1]["content"][1]["type"] == "input_image"


@pytest.mark.asyncio
async def test_image_questions_allow_one_document_tool_round_then_no_more_calls():
    settings = Settings(openai_api_key="test-key")
    turns: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        turns.append(json.loads(request.content))
        call = {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": f"call-{len(turns)}",
                "name": "read_webpage",
                "arguments": '{"doc_id":"page","anchor":"top"}',
            },
        }
        return httpx.Response(200, content=f"data: {json.dumps(call)}\n\n".encode())

    body = ChatRequest(scope="document", prompt="Read it.", paper_id="page", referenced_image_ids=["image"])
    payload = build_responses_payload(
        settings=settings,
        username="reader",
        project_id="project",
        project_skills="",
        sources=[({"id": "page", "title": "Page", "kind": "web"}, None)],
        web_documents={"page": {"title": "Page", "url": "https://example.test", "sections": []}},
        previous_messages=[],
        body=body,
        image_blocks=[{"type": "input_image", "image_url": "data:image/webp;base64,AA==", "detail": "low"}],
    )
    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        async for _ in run_model_turns(
            client,
            payload,
            {"page": {"title": "Page", "url": "https://example.test", "sections": []}},
            {"page": "Page"},
            settings,
        ):
            pass
    assert len(turns) == 2
    assert "tool_choice" not in turns[0]
    assert turns[1]["tools"] == turns[0]["tools"] and turns[1]["tool_choice"] == "none"


def test_the_published_image_limit_stays_under_the_schemas_ceiling():
    """
    Two numbers bound the same list, and only one of them is published. Raise
    the setting above the type's ceiling and the client is told it may send
    three images, then gets a 422 that names no limit at all — a failure no
    other test would see, because both halves are individually correct.
    """
    settings = Settings()
    assert settings.chat_image_max_per_question <= MAX_REFERENCED_IMAGES


def test_more_images_than_the_limit_are_refused_before_anything_is_read(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        openai_api_key="test-key",
        chat_image_max_per_question=1,
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-123"})
            project_id = client.post("/api/projects", json={"name": "Images"}).json()["id"]
            LocalStorage(settings).add_paper(
                "reader", project_id, {"id": "paper", "title": "P", "filename": "p.pdf"}
            )
            conv = conversation_params(client, "document", project_id, "paper")
            endpoint = "/api/chat/images"
            ids = [
                client.post(
                    endpoint,
                    params=conv,
                    files={"image": ("figure.png", encoded_image(), "image/png")},
                ).json()["id"]
                for _ in range(2)
            ]

            refused = client.post(
                "/api/chat/stream",
                json={
                    "prompt": "Both, please.",
                    **conv,
                    "referenced_image_ids": ids,
                },
            )
            assert refused.status_code == 400
            # Refused before use, so neither image is spent.
            listed = client.get(
                "/api/chat",
                params=conv,
            ).json()["images"]
            assert [item["used"] for item in listed] == [False, False]

            duplicated = client.post(
                "/api/chat/stream",
                json={
                    "prompt": "Twice over.",
                    **conv,
                    "referenced_image_ids": [ids[0], ids[0]],
                },
            )
            assert duplicated.status_code == 400
    finally:
        app.dependency_overrides.clear()


def test_upload_reference_history_preview_and_clear_are_thread_scoped(tmp_path, monkeypatch):
    from delphi_core.routers import chat as chat_router

    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret", openai_api_key="test-key")
    real_client = httpx.AsyncClient
    monkeypatch.setattr(chat_router.httpx, "AsyncClient", lambda *args, **kwargs: real_client(
        *args, **{**kwargs, "transport": ProviderTransport(lambda request: httpx.Response(
            200, content=b'data: {"type": "response.output_text.delta", "delta": "A figure."}\n\n'))}))
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-123"})
            project_id = client.post("/api/projects", json={"name": "Images"}).json()["id"]
            LocalStorage(settings).add_paper(
                "reader", project_id, {"id": "paper", "title": "P", "filename": "p.pdf"}
            )
            conv = conversation_params(client, "document", project_id, "paper")
            endpoint = "/api/chat/images"
            created = client.post(
                endpoint,
                params=conv,
                files={"image": ("figure.png", encoded_image(), "image/png")},
            )
            assert created.status_code == 201
            image = created.json()
            assert image["number"] == 1
            assert image["width"] == 512

            preview = client.get(
                f"{endpoint}/{image['id']}/thumbnail",
                params=conv,
            )
            assert preview.status_code == 200
            assert preview.headers["content-type"] == "image/webp"

            streamed = client.post(
                "/api/chat/stream",
                json={
                    "prompt": "What is shown?",
                    **conv,
                    "referenced_image_ids": [image["id"]],
                    "request_id": "request_123",
                },
            )
            assert streamed.status_code == 200
            history = client.get(
                "/api/chat",
                params=conv,
            ).json()
            assert history["messages"][0]["referencedImages"] == [
                {"id": image["id"], "number": 1}
            ]
            assert history["images"][0]["firstUseExcerpt"] == "What is shown?"
            assert client.delete(
                f"{endpoint}/{image['id']}", params=conv
            ).status_code == 409

            cleared = client.delete("/api/chat", params=conv)
            assert cleared.json()["action"] == "reset"
            assert client.get(
                f"{endpoint}/{image['id']}/thumbnail",
                params={**conv, "generation": conv["generation"] + 1},
            ).status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_a_thumbnail_whose_bytes_are_gone_404s_instead_of_crashing_the_stream(tmp_path):
    """
    preview_chat_image streams straight from open_range with no preceding
    exists()/size() check (unlike the paper file route), so it depended
    entirely on open_range raising before StreamingResponse sent headers.
    Deletes only the object bytes, leaving the (unexpired) record in place,
    to reproduce a thumbnail whose file is missing for any reason other than
    expiry.
    """
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-123"})
            project_id = client.post("/api/projects", json={"name": "Images"}).json()["id"]
            LocalStorage(settings).add_paper(
                "reader", project_id, {"id": "paper", "title": "P", "filename": "p.pdf"}
            )
            conv = conversation_params(client, "document", project_id, "paper")
            endpoint = "/api/chat/images"
            created = client.post(
                endpoint,
                params=conv,
                files={"image": ("figure.png", encoded_image(), "image/png")},
            )
            assert created.status_code == 201
            image_id = created.json()["id"]

            record = client.get(f"{endpoint}/{image_id}/thumbnail", params=conv)
            assert record.status_code == 200

            objects = LocalObjectStore(settings.data_dir)
            storage = LocalStorage(settings)
            stored = storage.get_chat_image(
                "reader", project_id, selector(conv["conversation_id"], conv["generation"]), image_id
            )
            objects.delete(stored["thumbnailKey"])

            response = client.get(
                f"{endpoint}/{image_id}/thumbnail", params=conv
            )
            assert response.status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_the_unified_door_serves_every_scope_and_the_wiki_can_hold_an_image(tmp_path):
    """
    One address, both scopes — including the one that could not attach before.

    The account-wide chat's images were blocked by an object key that assumed a
    project, never by the record: `ChatImage` has always hung off a thread. This
    walks the whole round trip through the unified routes, and checks that the
    two conversations number their images independently, because `@[Image #1]`
    has to mean one thing inside each of them.
    """
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project_id = client.post(
                "/api/projects", json={"name": "Images"}
            ).json()["id"]
            LocalStorage(settings).add_paper(
                "reader", project_id, {"id": "paper", "title": "P", "filename": "p.pdf"}
            )

            general_chat = conversation_params(client, "general")
            document_chat = conversation_params(client, "document", project_id, "paper")
            general = client.post(
                "/api/chat/images",
                params=general_chat,
                files={"image": ("figure.png", encoded_image(), "image/png")},
            )
            assert general.status_code == 201
            assert general.json()["number"] == 1

            # Same address, a different scope: its own thread, its own count.
            document = client.post(
                "/api/chat/images",
                params=document_chat,
                files={"image": ("figure.png", encoded_image(), "image/png")},
            )
            assert document.status_code == 201
            assert document.json()["number"] == 1

            listed = client.get("/api/chat", params=general_chat).json()
            assert [image["id"] for image in listed["images"]] == [
                general.json()["id"]
            ]
            assert client.get(
                f"/api/chat/images/{general.json()['id']}/thumbnail",
                params=general_chat,
            ).status_code == 200

            # Clearing one conversation must not reach into the other.
            assert client.delete("/api/chat", params=general_chat).json()["action"] == "reset"
            assert client.get(
                "/api/chat", params={**general_chat, "generation": 1}
            ).json()["images"] == []
            assert client.get("/api/chat", params=document_chat).json()["images"] != []
    finally:
        app.dependency_overrides.clear()


def test_the_general_scope_refuses_a_project_it_has_no_business_with(tmp_path):
    """
    Not ignored — refused. A project id on an account-wide question would
    silently widen what `read_paper` may reach, and a viewport is a claim about
    a reader panel this scope does not have.
    """
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            refused = client.post(
                "/api/chat/stream",
                json={"prompt": "hi", "scope": "general", "project_id": "abc"},
            )
            assert refused.status_code == 422
    finally:
        app.dependency_overrides.clear()
