import asyncio
import json
from types import SimpleNamespace

import httpx

from PIL import Image, ImageDraw

import delphi_core.browser_render as browser_render
import delphi_core.dashboard as dashboard_module
from tests.chat_keys import chat_key, conversation_params
from delphi_core.config import Settings
from delphi_core.conversation_titles import clean_title, generate_conversation_title
from delphi_core.schemas import CONVERSATION_TITLE_MAX_CHARS
from delphi_core.dashboard import (
    _asset_hosts,
    _capture_webpage,
    _capture_webpage_safely,
    _html_with_static_video_posters,
    conversations_payload,
    dashboard_payload,
    make_web_thumbnail,
)
from delphi_core.storage import LocalObjectStore, paper_key
from delphi_core.storage.local import LocalStorage
from tests.helpers import ProviderTransport


def account(storage):
    storage.create_account("reader", None, "salt", "hash")


def test_a_title_of_the_full_length_can_be_renamed_to_and_the_client_is_told_the_bound(tmp_path):
    """
    The rename box offers a generated title back, so saving it unchanged must
    pass: rename and generation share one bound, and `/api/config` names it.
    """
    from delphi_core.config import get_settings
    from delphi_core.main import app
    from fastapi.testclient import TestClient

    app.dependency_overrides[get_settings] = lambda: Settings(
        data_dir=tmp_path, session_secret="test-session-secret",
    )
    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-123"})
            assert client.get("/api/config").json()["conversationTitleMaxCharacters"] == (
                CONVERSATION_TITLE_MAX_CHARS
            )
            chat = conversation_params(client, "general")
            path = f"/api/chat/conversations/{chat['conversation_id']}"
            full = "x" * CONVERSATION_TITLE_MAX_CHARS
            renamed = client.patch(path, json={"title": full, "generation": chat["generation"]})
            assert renamed.status_code == 200, renamed.text
            over = client.patch(path, json={"title": full + "x", "generation": chat["generation"]})
            assert over.status_code == 422
    finally:
        app.dependency_overrides.pop(get_settings, None)
    record = storage_for(tmp_path).get_conversation("reader", chat["conversation_id"])
    assert record["title"] == full


def test_dashboard_is_bounded_sorted_and_counts_archived_documents(tmp_path):
    storage = LocalStorage(Settings(data_dir=tmp_path))
    account(storage)
    first = storage.create_project("reader", "First")
    second = storage.create_project("reader", "Second")
    a = storage.add_paper("reader", first["id"], {
        "id": "a", "title": "A", "filename": "a.pdf",
        "createdAt": "2026-01-01T00:00:00+00:00", "doneAt": "2026-01-02T00:00:00+00:00",
    })
    storage.add_paper("reader", second["id"], {
        "id": "b", "title": "B", "filename": "b.pdf",
        "createdAt": "2026-01-03T00:00:00+00:00",
    })
    storage.append_message("reader", first["id"], chat_key(storage, "reader", first["id"], "paper-a"), {
        "role": "user", "content": "What is A?", "createdAt": "2026-01-04T00:00:00+00:00",
    })
    body = dashboard_payload(storage, "reader")
    assert body["stats"] == {"projects": 2, "documents": 2, "completed": 1, "completedPercent": 50}
    assert [row["documents"][0]["id"] for row in body["projects"]] == ["b", "a"]
    assert "recentDocuments" not in body
    assert len(body["conversations"]) == 1
    assert body["conversations"][0]["kind"] == "document_chat"


def test_empty_dashboard_and_deterministic_text_helpers(tmp_path):
    storage = LocalStorage(Settings(data_dir=tmp_path))
    account(storage)
    body = dashboard_payload(storage, "reader")
    assert body["stats"]["completedPercent"] == 0
    assert body["projects"] == []
    # A title a word over its brief is kept whole: the eleventh word used to go.
    whole = "Correction Training for Diffusion Models: Training vs Sampling, K=0 vs K=2"
    assert clean_title(f'"{whole}."') == whole
    # Past what is kept, it ends at a word, never inside one.
    long = clean_title(" ".join(["distillation"] * 20))
    assert len(long) <= CONVERSATION_TITLE_MAX_CHARS
    assert set(long.split()) == {"distillation"}
    # The opening question stands in until then, cut the same way.
    question = LocalStorage._fallback_title(" ".join(["distillation"] * 20))
    assert len(question) <= CONVERSATION_TITLE_MAX_CHARS
    assert set(question.split()) == {"distillation"}
    assert LocalStorage._fallback_title("  ") == "New conversation"


def test_thumbnail_asset_hosts_are_bounded_and_resolved_from_the_page():
    html = """
    <link rel="stylesheet" href="https://cdn.example/style.css">
    <script src="/app.js"></script>
    <img src="https://images.example/hero.webp">
    <img src="https://images.example/second.webp">
    """
    assert _asset_hosts(html, "https://article.example/read") == (
        "cdn.example",
        "article.example",
        "images.example",
    )


def test_linked_pdf_thumbnail_source_stays_a_pdf(monkeypatch, tmp_path):
    async def fetched(*_args, **kwargs):
        assert kwargs["include_pdf"] is True
        return SimpleNamespace(
            body=b"%PDF-1.7\nthumbnail fixture",
            content_type="application/pdf",
            encoding="utf-8",
            url="https://example.com/paper.pdf",
        )

    monkeypatch.setattr(dashboard_module, "fetch_resource", fetched)
    path, kind = asyncio.run(
        _capture_webpage_safely(
            "https://example.com/paper.pdf", Settings(data_dir=tmp_path)
        )
    )
    try:
        assert kind == "pdf"
        assert path is not None and path.read_bytes().startswith(b"%PDF-1.7")
    finally:
        if path:
            path.unlink(missing_ok=True)


def test_web_thumbnail_accepts_a_stable_png_when_media_keeps_chrome_alive(
    monkeypatch,
):
    class HangingChrome:
        pid = 123
        returncode = None

        def __init__(self, command, **_kwargs):
            target = next(value for value in command if value.startswith("--screenshot="))
            self.screenshot = target.split("=", 1)[1]
            with open(self.screenshot, "wb") as output:
                output.write(b"x" * 1_200)

        def poll(self):
            return None

        def wait(self, timeout=None):
            self.returncode = -15
            return self.returncode

    monkeypatch.setattr(dashboard_module, "_chrome_executable", lambda: "/chrome")
    # Patched in both modules: the capture checks the address itself, and the
    # proxy it runs checks every asset host in `browser_render`. A patch on one
    # name only is silently bypassed by the other and the test does real DNS.
    for module in (dashboard_module, browser_render):
        monkeypatch.setattr(
            module, "_pinned_public_address", lambda *_: "203.0.113.10"
        )
    monkeypatch.setattr(dashboard_module.subprocess, "Popen", HangingChrome)
    monkeypatch.setattr(dashboard_module.os, "killpg", lambda *_: None)

    path = _capture_webpage("https://article.example/read")

    try:
        assert path is not None
        assert path.stat().st_size == 1_200
    finally:
        if path:
            path.unlink(missing_ok=True)


def test_vimeo_embed_becomes_a_static_poster_in_the_thumbnail_document(
    monkeypatch,
):
    async def fetched(url, _settings, **kwargs):
        if url.startswith("https://player.vimeo.com/"):
            return SimpleNamespace(
                body=(
                    b'{"poster":"https://i.vimeocdn.com/video/poster-id-d?f=webp"}'
                ),
                content_type="text/html",
                encoding="utf-8",
                url=url,
            )
        assert url.startswith("https://i.vimeocdn.com/video/poster-id-d")
        assert kwargs["include_images"] is True
        image = dashboard_module.Image.new("RGB", (8, 6), "#c08a4b")
        encoded = dashboard_module.io.BytesIO()
        image.save(encoded, "PNG")
        return SimpleNamespace(
            body=encoded.getvalue(), content_type="image/png", encoding="utf-8", url=url
        )

    monkeypatch.setattr(dashboard_module, "fetch_resource", fetched)
    prepared = asyncio.run(_html_with_static_video_posters(
        '<html><head><script>hydrate()</script></head><body>'
        '<iframe src="https://player.vimeo.com/video/123?background=1"></iframe>'
        '</body></html>',
        "https://article.example/read",
        Settings(),
    ))

    assert prepared is not None
    assert "data:image/webp;base64," in prepared
    assert "srcdoc=" in prepared
    assert "hydrate()" not in prepared
    assert '<base href="https://article.example/read"' in prepared


def test_a_web_thumbnail_crops_the_empty_window_around_the_article():
    """
    Notion's column is ~900px in a 1512px window. Photographed whole, the
    104×78 card is white margin. The empty window is not the page.
    """
    page = Image.new("RGB", (1512, 1134), "#ffffff")
    ImageDraw.Draw(page).rectangle((306, 80, 1206, 900), fill="#2e1b0d")
    cropped = dashboard_module._trim_blank_margins(page)

    assert 850 < cropped.width < 980
    assert 780 < cropped.height < 900


def test_web_placeholder_does_not_claim_screenshot_success(monkeypatch, tmp_path):
    async def unavailable(*_args, **_kwargs):
        return None, None

    monkeypatch.setattr(dashboard_module, "_capture_webpage_safely", unavailable)
    objects = LocalObjectStore(tmp_path)
    generated = asyncio.run(make_web_thumbnail(
        "Article",
        "https://article.example/read",
        None,
        objects,
        Settings(data_dir=tmp_path),
        "reader",
        "project",
        "paper",
    ))

    assert generated is False
    assert objects.exists(paper_key("reader", "project", "paper", "thumb"))



def test_thumbnail_photographs_the_page_copy(tmp_path, monkeypatch):
    from delphi_core.web_revision import freeze, page_fields, publish_snapshot

    objects = LocalObjectStore(tmp_path)
    url = "https://article.example/read"
    html = '<html><body><article>The rendered article</article></body></html>'
    document = {"url": url, "title": "Article", "sections": [{"anchor": "article", "title": "Article", "markdown": "The rendered article"}]}
    publish_snapshot(objects, "reader", "project", "paper", document, {},
                     page=page_fields(freeze(html, url, 1512), url, "2026-09-22T12:00:00Z"))
    seen = []

    async def capture(_url, _settings, _budget, saved=None):
        seen.append(saved)
        return None, None

    monkeypatch.setattr(dashboard_module, "_capture_webpage_safely", capture)
    thumbnail = lambda: asyncio.run(make_web_thumbnail("Article", url, None, objects, Settings(data_dir=tmp_path), "reader", "project", "paper"))
    thumbnail()
    assert "The rendered article" in seen[-1]
    assert 'data-delphi-render-width="1512"' in seen[-1]
    # With nothing in `.web`, the card is photographed from a fetch.
    objects.delete(paper_key("reader", "project", "paper", "web"))
    thumbnail()
    assert seen[-1] is None


def test_a_capture_that_outlives_its_copy_leaves_the_newer_preview(tmp_path, monkeypatch):
    """
    Two annotations a moment apart store two copies, and their captures can
    finish in either order. The one that finishes after its copy was replaced
    must not write the older picture over the newer.
    """
    from delphi_core.web_revision import freeze, page_fields, publish_snapshot, read_revision

    objects = LocalObjectStore(tmp_path)
    url = "https://article.example/read"
    key = paper_key("reader", "project", "paper", "web")
    document = {"url": url, "title": "Article", "sections": [{"anchor": "a", "title": "A", "markdown": "The article"}]}
    publish_snapshot(objects, "reader", "project", "paper", document, {},
                     page=page_fields(freeze("<html><body>The article, first</body></html>", url), url, "t1"))
    thumb = paper_key("reader", "project", "paper", "thumb")
    newer = Image.new("RGB", (960, 720), "white")
    ImageDraw.Draw(newer).text((80, 80), "The newer copy", fill="black")
    dashboard_module._save_thumbnail(newer, objects, thumb)
    preview = b"".join(objects.open_range(thumb))
    screenshot = tmp_path / "older.png"

    async def slow_capture(*_args, **_kwargs):
        # The newer copy lands while this one is being photographed.
        revision = read_revision(objects, "reader", "project", "paper")
        objects.put_text(key, json.dumps({**revision, **page_fields("<html><body>The article, second</body></html>", url, "t2")}))
        page = Image.new("RGB", (960, 720), "white")
        ImageDraw.Draw(page).rectangle((80, 80, 880, 640), fill="#2e1b0d")
        page.save(screenshot)
        return screenshot, "web"

    monkeypatch.setattr(dashboard_module, "_capture_webpage_safely", slow_capture)
    assert asyncio.run(make_web_thumbnail("Article", url, None, objects, Settings(data_dir=tmp_path), "reader", "project", "paper")) is False
    assert b"".join(objects.open_range(thumb)) == preview
    assert not screenshot.exists()


def test_a_saved_page_is_photographed_without_a_second_live_fetch(tmp_path, monkeypatch):
    """
    pi.website serves the import and refuses the thumbnail's fetch seconds
    later as an automated reader. The card is a picture of the saved copy, so
    a site that stops answering cannot leave it a placeholder.
    """
    from fastapi import HTTPException
    from delphi_core.web_revision import freeze, page_fields, publish_snapshot

    objects = LocalObjectStore(tmp_path)
    url = "https://article.example/read"
    document = {"url": url, "title": "Article", "sections": [{"anchor": "article", "title": "Article", "markdown": "The saved article"}]}
    frozen = freeze("<html><body><article>The saved article</article></body></html>", url)
    publish_snapshot(objects, "reader", "project", "paper", document, {}, page=page_fields(frozen, url, "t"))
    photographed = []

    async def refused(*_args, **_kwargs):
        raise HTTPException(403, {"code": "blocked", "message": "article.example blocks automated readers."})

    def capture(page_url, _hosts, prepared_html, _budget, width, *_rest):
        photographed.append((page_url, prepared_html, width))
        shot = tmp_path / "shot.png"
        page = Image.new("RGB", (960, 720), "white")
        ImageDraw.Draw(page).rectangle((80, 80, 880, 640), fill="#2e1b0d")
        page.save(shot)
        return shot

    monkeypatch.setattr(dashboard_module, "fetch_resource", refused)
    monkeypatch.setattr(dashboard_module, "_capture_webpage", capture)
    generated = asyncio.run(make_web_thumbnail(
        "Article", url, None, objects, Settings(data_dir=tmp_path), "reader", "project", "paper",
    ))

    assert generated is True
    [(page_url, prepared_html, width)] = photographed
    assert page_url == url and width == 960
    assert "The saved article" in prepared_html
    assert f'<base href="{url}"' in prepared_html
    assert not dashboard_module._is_fallback_web_thumbnail(
        objects, paper_key("reader", "project", "paper", "thumb")
    )


def test_blank_web_capture_does_not_claim_success_or_overwrite_a_preview(tmp_path, monkeypatch):
    objects = LocalObjectStore(tmp_path)
    key = paper_key("reader", "project", "paper", "thumb")
    screenshot = tmp_path / "blank.png"

    async def capture(*_args, **_kwargs):
        Image.new("RGB", (960, 720), "white").save(screenshot)
        return screenshot, "web"

    monkeypatch.setattr(dashboard_module, "_capture_webpage_safely", capture)
    args = ("Article", "https://article.example/read", None, objects, Settings(data_dir=tmp_path), "reader", "project", "paper")
    assert asyncio.run(make_web_thumbnail(*args)) is False
    assert dashboard_module._is_fallback_web_thumbnail(objects, key)
    assert not screenshot.exists()
    prior = Image.new("RGB", (960, 720), "white")
    ImageDraw.Draw(prior).text((80, 80), "Prior article", fill="black")
    dashboard_module._save_thumbnail(prior, objects, key)
    original = b"".join(objects.open_range(key))
    assert asyncio.run(make_web_thumbnail(*args)) is False
    assert b"".join(objects.open_range(key)) == original

def test_a_placeholder_stamped_available_is_recaptured_on_engagement(tmp_path):
    """
    Reporting the fallback card as a successful screenshot froze papers like
    the Harness Engineering post: `thumbnailAvailable` was true, the bytes
    were the cream 'WEB DOCUMENT' tile, and every later open skipped capture.
    """
    import unittest.mock
    from io import BytesIO

    storage = LocalStorage(Settings(data_dir=tmp_path))
    objects = LocalObjectStore(tmp_path)
    account(storage)
    project = storage.create_project("reader", "Project")
    storage.add_paper("reader", project["id"], {
        "id": "page", "title": "Harness Engineering for Self-Improvement",
        "kind": "web", "url": "https://article.example/harness",
        "createdAt": "2026-01-01T00:00:00+00:00",
        "thumbnailAvailable": True,
        "thumbnailVersion": dashboard_module.WEB_THUMBNAIL_VERSION,
        "thumbnailAttempts": 1,
        "thumbnailAttemptedAt": "2026-08-14T23:56:08.521893+00:00",
    })

    async def unavailable(*_args, **_kwargs):
        return None, None

    with unittest.mock.patch.object(
        dashboard_module, "_capture_webpage_safely", unavailable
    ):
        asyncio.run(make_web_thumbnail(
            "Harness Engineering for Self-Improvement",
            "https://article.example/harness",
            None,
            objects,
            Settings(data_dir=tmp_path),
            "reader",
            project["id"],
            "page",
        ))
    key = paper_key("reader", project["id"], "page", "thumb")
    assert objects.exists(key)
    with Image.open(BytesIO(b"".join(objects.open_range(key)))) as image:
        assert image.size == dashboard_module._FALLBACK_THUMB_SIZE

    paper = storage.get_paper("reader", project["id"], "page")
    assert paper.get("thumbnailAvailable")
    assert not dashboard_module.thumbnail_is_due(paper)

    screenshot = tmp_path / "page.png"
    page = Image.new("RGB", (960, 720), "#f5f0e8")
    ImageDraw.Draw(page).text((80, 80), "The article", fill="black")
    page.save(screenshot)

    async def captured(*_args, **_kwargs):
        return screenshot, "web"

    async def scenario():
        try:
            with unittest.mock.patch.object(
                dashboard_module, "_capture_webpage_safely", captured
            ):
                made = await dashboard_module.capture_document_thumbnail_for_engagement(
                    storage, objects, Settings(data_dir=tmp_path),
                    "reader", project["id"], paper,
                )
            assert made is True
            refreshed = storage.get_paper("reader", project["id"], "page")
            assert refreshed.get("thumbnailAvailable") is True
            with Image.open(BytesIO(b"".join(objects.open_range(key)))) as image:
                assert image.size != dashboard_module._FALLBACK_THUMB_SIZE
        finally:
            await _finish_thumbnail_retries()

    asyncio.run(scenario())


def test_a_failed_recapture_does_not_replace_a_real_screenshot(tmp_path, monkeypatch):
    objects = LocalObjectStore(tmp_path)
    key = paper_key("reader", "project", "paper", "thumb")
    source = tmp_path / "real.webp"
    Image.new("RGB", (960, 720), "#112233").save(source, "WEBP")
    objects.put_file(key, source, "image/webp")
    original = b"".join(objects.open_range(key))

    async def unavailable(*_args, **_kwargs):
        return None, None

    monkeypatch.setattr(dashboard_module, "_capture_webpage_safely", unavailable)
    generated = asyncio.run(make_web_thumbnail(
        "Article",
        "https://article.example/read",
        None,
        objects,
        Settings(data_dir=tmp_path),
        "reader",
        "project",
        "paper",
    ))
    assert generated is False
    assert b"".join(objects.open_range(key)) == original


def test_a_failed_capture_waits_out_its_gap_before_the_same_session_runs_again(tmp_path):
    """
    A failure used to record nothing but `thumbnailAvailable = False`, which was
    the whole memory of the attempt — so the next caller ran the entire capture
    again: a fetch, a headless browser and a third-party round trip. The attempt
    is now what is remembered, and a caller that does not start a new
    engagement (backfill, a follow-up inside the same open) waits a minute.
    """
    storage = LocalStorage(Settings(data_dir=tmp_path))
    objects = LocalObjectStore(tmp_path)
    account(storage)
    project = storage.create_project("reader", "Project")
    storage.add_paper("reader", project["id"], {
        "id": "page", "title": "Article", "kind": "web",
        "url": "https://article.example/read",
        "createdAt": "2026-01-01T00:00:00+00:00",
    })
    paper = storage.get_paper("reader", project["id"], "page")

    # Never attempted at this renderer version: due immediately.
    assert dashboard_module.thumbnail_is_due(paper)

    captures: list[str] = []

    async def unavailable(*_args, **_kwargs):
        captures.append("tried")
        return None, None

    import unittest.mock

    with unittest.mock.patch.object(
        dashboard_module, "_capture_webpage_safely", unavailable
    ):
        asyncio.run(dashboard_module.ensure_document_thumbnail_safely(
            storage, objects, Settings(data_dir=tmp_path),
            "reader", project["id"], paper,
        ))
    assert captures == ["tried"]

    failed = storage.get_paper("reader", project["id"], "page")
    assert failed["thumbnailAttemptedAt"]
    assert not failed.get("thumbnailAvailable")
    # The flat card is real bytes, so the reader still sees something.
    assert objects.exists(paper_key("reader", project["id"], "page", "thumb"))

    # The same session does not pay for the same failure again — asserted
    # through the generator itself, not only the predicate, because the
    # engagement touch is not the only caller.
    assert not dashboard_module.thumbnail_is_due(failed)
    with unittest.mock.patch.object(
        dashboard_module, "_capture_webpage_safely", unavailable
    ):
        asyncio.run(dashboard_module.ensure_document_thumbnail_safely(
            storage, objects, Settings(data_dir=tmp_path),
            "reader", project["id"], failed,
        ))
    assert captures == ["tried"]

    # Once the minute has passed it retries, because a host that was down is
    # usually a host that comes back.
    from datetime import datetime, timedelta, timezone

    later = datetime.now(timezone.utc) + dashboard_module.THUMBNAIL_RETRY_AFTER
    assert dashboard_module.thumbnail_is_due(failed, now=later + timedelta(seconds=1))

    # And a renderer bump is always immediate — that is what a version is for.
    storage.update_paper_snapshot("reader", project["id"], "page", {
        "thumbnailAvailable": True,
        "thumbnailVersion": dashboard_module.WEB_THUMBNAIL_VERSION - 1,
    })
    assert dashboard_module.thumbnail_is_due(
        storage.get_paper("reader", project["id"], "page")
    )


def test_a_failed_capture_is_retried_once_a_minute_three_times_then_stops():
    """
    The regression the engagement budget exists for. A document's first capture
    is made during its own creation request, so it is the attempt most likely
    to be starved — and an escalating cooldown turned losing that one race into
    a flat card that later opens could not repair. Inside one engagement the
    retries are one minute apart, three of them, then stop.
    """
    from datetime import datetime, timedelta, timezone

    attempted = datetime(2026, 1, 1, tzinfo=timezone.utc)
    paper = {
        "id": "page", "kind": "web",
        "thumbnailVersion": dashboard_module.WEB_THUMBNAIL_VERSION,
        "thumbnailAttemptedAt": attempted.isoformat(),
        "thumbnailAttempts": 1,
    }

    def due_after(minutes: int, attempts: int) -> bool:
        return dashboard_module.thumbnail_is_due(
            {**paper, "thumbnailAttempts": attempts},
            now=attempted + timedelta(minutes=minutes),
        )

    assert not due_after(0, 1)
    assert due_after(1, 1)
    assert due_after(1, 2)
    # Three failures spent the engagement; waiting longer does not buy a fourth.
    assert not due_after(1, 3)
    assert not due_after(60, 3)

    # A record written before the count existed still has budget: absence of a
    # count is zero failures, not three.
    legacy = {key: value for key, value in paper.items() if key != "thumbnailAttempts"}
    assert dashboard_module.thumbnail_is_due(
        legacy, now=attempted + timedelta(minutes=1)
    )


async def _finish_thumbnail_retries():
    tasks = list(dashboard_module._THUMBNAIL_RETRY_TASKS.values())
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    dashboard_module._THUMBNAIL_RETRY_TASKS.clear()
    dashboard_module._THUMBNAIL_ENGAGEMENT_GEN.clear()


def test_a_new_engagement_retries_immediately_even_inside_the_gap(tmp_path):
    """
    Opening the document is a new engagement. The previous open's failure, even
    seconds ago, must not freeze this one — that was how a page opened a few
    times still drew a flat card.
    """
    import unittest.mock

    storage = LocalStorage(Settings(data_dir=tmp_path))
    objects = LocalObjectStore(tmp_path)
    account(storage)
    project = storage.create_project("reader", "Project")
    storage.add_paper("reader", project["id"], {
        "id": "page", "title": "Article", "kind": "web",
        "url": "https://article.example/read",
        "createdAt": "2026-01-01T00:00:00+00:00",
    })
    paper = storage.get_paper("reader", project["id"], "page")
    captures: list[str] = []

    async def unavailable(*_args, **_kwargs):
        captures.append("tried")
        return None, None

    async def scenario():
        try:
            with unittest.mock.patch.object(
                dashboard_module, "_capture_webpage_safely", unavailable
            ):
                await dashboard_module.capture_document_thumbnail_for_engagement(
                    storage, objects, Settings(data_dir=tmp_path),
                    "reader", project["id"], paper,
                )
                failed = storage.get_paper("reader", project["id"], "page")
                assert captures == ["tried"]
                assert not dashboard_module.thumbnail_is_due(failed)
                await dashboard_module.capture_document_thumbnail_for_engagement(
                    storage, objects, Settings(data_dir=tmp_path),
                    "reader", project["id"], failed,
                )
                assert captures == ["tried", "tried"]
                retried = storage.get_paper("reader", project["id"], "page")
                assert retried["thumbnailAttempts"] == 1
        finally:
            await _finish_thumbnail_retries()

    asyncio.run(scenario())


def test_an_engagement_retries_a_failed_capture_twice_then_stops(tmp_path, monkeypatch):
    """Stay on the page: three attempts a minute apart, then the chain ends."""
    from datetime import timedelta
    import unittest.mock

    monkeypatch.setattr(
        dashboard_module, "THUMBNAIL_RETRY_AFTER", timedelta(milliseconds=30)
    )
    storage = LocalStorage(Settings(data_dir=tmp_path))
    objects = LocalObjectStore(tmp_path)
    account(storage)
    project = storage.create_project("reader", "Project")
    storage.add_paper("reader", project["id"], {
        "id": "page", "title": "Article", "kind": "web",
        "url": "https://article.example/read",
        "createdAt": "2026-01-01T00:00:00+00:00",
    })
    paper = storage.get_paper("reader", project["id"], "page")
    captures: list[str] = []

    async def unavailable(*_args, **_kwargs):
        captures.append("tried")
        return None, None

    async def scenario():
        try:
            with unittest.mock.patch.object(
                dashboard_module, "_capture_webpage_safely", unavailable
            ):
                await dashboard_module.capture_document_thumbnail_for_engagement(
                    storage, objects, Settings(data_dir=tmp_path),
                    "reader", project["id"], paper,
                )
                for _ in range(40):
                    if len(captures) >= 3:
                        break
                    await asyncio.sleep(0.02)
                await asyncio.sleep(0.08)
                assert captures == ["tried", "tried", "tried"]
                failed = storage.get_paper("reader", project["id"], "page")
                assert failed["thumbnailAttempts"] == 3
                assert not dashboard_module.thumbnail_is_due(failed)
        finally:
            await _finish_thumbnail_retries()

    asyncio.run(scenario())


def test_a_success_clears_the_count_and_a_new_renderer_restarts_it(tmp_path):
    failing = {
        "kind": "web",
        "thumbnailVersion": dashboard_module.WEB_THUMBNAIL_VERSION,
        "thumbnailAttempts": 3,
    }
    assert dashboard_module.thumbnail_fields(failing, generated=False)[
        "thumbnailAttempts"
    ] == 4
    succeeded = dashboard_module.thumbnail_fields(failing, generated=True)
    assert succeeded["thumbnailAttempts"] == 0
    assert succeeded["thumbnailAvailable"] is True

    # A bump is a different renderer, so its first failure is the first
    # failure — otherwise improving the capture would inherit the budget the
    # old one had spent and the improvement would not reach anything.
    behind = {**failing, "thumbnailVersion": dashboard_module.WEB_THUMBNAIL_VERSION - 1}
    assert dashboard_module.thumbnail_fields(behind, generated=False)[
        "thumbnailAttempts"
    ] == 1

    # Never cleared on failure: a card showing an older preview keeps it rather
    # than falling back to the flat one because a re-capture did not land.
    assert "thumbnailAvailable" not in dashboard_module.thumbnail_fields(
        {**failing, "thumbnailAvailable": True}, generated=False
    )


def test_only_one_browser_runs_at_a_time(tmp_path):
    """
    Two chromiums on one shared vCPU is how both of them end up over the
    ceiling. The second capture declines rather than queues: nobody is watching
    a preview render, and the next engagement retry will bring it round again.
    """
    settings = Settings(data_dir=tmp_path, web_thumbnail_queue_seconds=0.05)
    granted: list[bool] = []

    async def both():
        async def one(hold: float):
            async with dashboard_module._capture_slot(settings, "https://x.test") as ok:
                granted.append(ok)
                await asyncio.sleep(hold)

        await asyncio.gather(one(0.4), one(0.0))

    dashboard_module._CAPTURE_SLOT = None
    asyncio.run(both())
    assert sorted(granted) == [False, True]


def test_a_durable_capture_can_wait_for_the_shared_browser(tmp_path):
    settings = Settings(data_dir=tmp_path, web_thumbnail_queue_seconds=0.01)
    granted: list[bool] = []

    async def both():
        async def preview():
            async with dashboard_module._capture_slot(
                settings, "https://x.test"
            ) as ok:
                granted.append(ok)
                await asyncio.sleep(0.08)

        async def durable():
            await asyncio.sleep(0.01)
            async with dashboard_module._capture_slot(
                settings, "https://x.test", wait_seconds=0.2
            ) as ok:
                granted.append(ok)

        await asyncio.gather(preview(), durable())

    dashboard_module._CAPTURE_SLOT = None
    asyncio.run(both())
    assert granted == [True, True]


def test_static_html_capture_uses_its_budget_for_queueing(tmp_path, monkeypatch):
    import contextlib

    settings = Settings(data_dir=tmp_path)
    called = {}

    @contextlib.asynccontextmanager
    async def slot(_settings, source_url, *, wait_seconds=None):
        called["slot"] = (source_url, wait_seconds)
        yield True

    def capture(source_url, asset_hosts, prepared_html, *args):
        called["capture"] = (source_url, asset_hosts, prepared_html, args)
        return None

    monkeypatch.setattr(dashboard_module, "_capture_slot", slot)
    monkeypatch.setattr(dashboard_module, "_capture_webpage", capture)

    asyncio.run(
        dashboard_module.capture_static_html(
            "https://article.test/post",
            "<html><figure>diagram</figure></html>",
            settings,
            viewport_width=1512,
            viewport_height=1512,
            budget_seconds=0.3,
        )
    )

    assert called["slot"] == ("https://article.test/post", 0.3)
    assert called["capture"][1] == ()
    assert called["capture"][3][-2:] == (1512, 1512)


def test_a_title_is_written_from_the_answer_not_only_the_question(tmp_path, monkeypatch):
    storage = LocalStorage(Settings(data_dir=tmp_path))
    account(storage)
    project = storage.create_project("reader", "Project")
    storage.add_paper("reader", project["id"], {
        "id": "paper", "title": "Paper", "filename": "paper.pdf",
        "createdAt": "2026-01-01T00:00:00+00:00",
    })
    key = chat_key(storage, "reader", project["id"], "paper-paper")
    claim = storage.claim_conversation_title(
        "reader", project_id=project["id"], thread_key=key,
        engagement_id="engagement_one", fallback_title="Give me the TLDR of this paper.",
    )
    sent = []

    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"output": [{"content": [
            {"type": "output_text", "text": "UNITE's shared encoder for tokenization and denoising"},
        ]}]})

    real_client = httpx.AsyncClient

    def mock_client(*args, **kwargs):
        return real_client(transport=ProviderTransport(handler))

    monkeypatch.setattr(httpx, "AsyncClient", mock_client)
    settings = Settings(data_dir=tmp_path, openai_api_key="k", orchestrator_model="m")
    asyncio.run(generate_conversation_title(
        claim, "Give me the TLDR of this paper.",
        "TL;DR: UNITE jointly trains an image tokenizer and a latent denoiser.",
        "reader", storage, settings, False,
    ))

    # A generic question names nothing; the answer beside it is where the
    # subject of the conversation actually is.
    assert "UNITE jointly trains" in sent[0]["input"][0]["content"]
    # Summarising text already in hand does not need the orchestrator's effort,
    # and `max_output_tokens` bounds thinking and output together: spending it
    # on reasoning returns a response with no title in it at all.
    assert sent[0]["reasoning"]["effort"] == "low"
    storage.append_message("reader", project["id"], key, {
        "role": "user", "content": "Give me the TLDR of this paper.",
        "createdAt": "2026-01-04T00:00:00+00:00",
    })
    assert dashboard_payload(storage, "reader")["conversations"][0]["title"] == (
        "UNITE's shared encoder for tokenization and denoising"
    )


def test_a_reopened_conversation_is_titled_again_from_what_it_has_become(tmp_path):
    """
    A title used to be bought once and kept for the life of the conversation,
    which left a summary that had stopped tracking its own thread — the third
    question is usually the one that says what the reader was after. Every
    mounted chat that asks something buys one title, and only one.
    """
    storage = LocalStorage(Settings(data_dir=tmp_path))
    account(storage)
    project = storage.create_project("reader", "Project")
    storage.add_paper("reader", project["id"], {
        "id": "paper", "title": "Paper", "filename": "paper.pdf",
        "createdAt": "2026-01-01T00:00:00+00:00",
    })
    key = chat_key(storage, "reader", project["id"], "paper-paper")

    def claim(engagement):
        return storage.claim_conversation_title(
            "reader", project_id=project["id"], thread_key=key,
            engagement_id=engagement, fallback_title="A question",
        )

    first = claim("engagement_one")
    assert first
    # A failed attempt writes no title, so the next mount may try again.
    assert claim("engagement_two")
    storage.set_conversation_title(
        "reader", first["id"], title="Rollout-training mismatch in RL",
        model="m", updated_at="2026-01-04T00:00:00+00:00",
    )
    # The same mount asking again shares the one title it already bought.
    assert claim("engagement_two") is None
    # A later mount buys another, because the conversation has moved on.
    assert claim("engagement_three")
    storage.set_conversation_title(
        "reader", first["id"], title="Why the KL penalty stopped helping",
        model="m", updated_at="2026-01-05T00:00:00+00:00",
    )
    assert storage.get_conversation("reader", first["id"])["title"] == (
        "Why the KL penalty stopped helping"
    )


def test_one_title_claim_per_engagement_and_a_cleared_chat_is_titled_afresh(tmp_path):
    storage = LocalStorage(Settings(data_dir=tmp_path))
    account(storage)
    project = storage.create_project("reader", "Project")
    storage.add_paper("reader", project["id"], {
        "id": "paper", "title": "Paper", "filename": "paper.pdf",
        "createdAt": "2026-01-01T00:00:00+00:00",
    })
    key = chat_key(storage, "reader", project["id"], "paper-paper")
    first = storage.claim_conversation_title(
        "reader", project_id=project["id"], thread_key=key,
        engagement_id="engagement_one", fallback_title="A first question",
    )
    assert first
    assert storage.claim_conversation_title(
        "reader", project_id=project["id"], thread_key=key,
        engagement_id="engagement_one", fallback_title="Again",
    ) is None
    # Clearing the context's only chat keeps its id under a new generation, and
    # forgets the claim with everything else.
    storage.delete_conversation("reader", first["id"], 0)
    key = chat_key(storage, "reader", project["id"], "paper-paper")
    second = storage.claim_conversation_title(
        "reader", project_id=project["id"], thread_key=key,
        engagement_id="engagement_one", fallback_title="A second question",
    )
    assert second and (second["id"], second["generation"]) == (first["id"], 1)


def test_the_streaming_route_titles_a_conversation_from_the_finished_answer(tmp_path, monkeypatch):
    """
    The unit above proves the request carries the answer; this proves the route
    actually issues it. The title call is created after the model loop and
    awaited in the generator's `finally`, which is exactly the kind of ordering
    that keeps working in a unit test and quietly never runs in the real stream.
    """
    from delphi_core.config import get_settings
    from delphi_core.main import app
    from fastapi.testclient import TestClient

    settings = Settings(
        data_dir=tmp_path, session_secret="test-session-secret", openai_api_key="test-key",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    title_requests = []

    def handler(request):
        payload = json.loads(request.content)
        # The answer streams; the title does not. That is what separates the
        # two requests, since both carry the same model and instructions.
        if not payload.get("stream"):
            title_requests.append(payload)
            return httpx.Response(200, json={"output": [{"content": [
                {"type": "output_text", "text": "UNITE's shared encoder for tokenization"},
            ]}]})
        events = [
            {"type": "response.output_text.delta", "delta": "TL;DR: UNITE shares one encoder."},
            {"type": "response.completed", "response": {"usage": {}}},
        ]
        return httpx.Response(200, content="".join(
            f"data: {json.dumps(event)}\n\n" for event in events
        ).encode())

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient",
        lambda *args, **kwargs: real_client(transport=ProviderTransport(handler)),
    )
    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-123"})
            client.post("/api/projects", json={"name": "Project"})
            with client.stream("POST", "/api/chat/stream", json={
                **conversation_params(client, "general"),
                "prompt": "Give me the TLDR of this paper.",
                "engagement_id": "engagement_one",
            }) as response:
                assert response.status_code == 200
                for _ in response.iter_lines():
                    pass
    finally:
        app.dependency_overrides.pop(get_settings, None)

    assert len(title_requests) == 1
    assert "UNITE shares one encoder" in title_requests[0]["input"][0]["content"]
    assert dashboard_payload(storage_for(tmp_path), "reader")["conversations"][0]["title"] == (
        "UNITE's shared encoder for tokenization"
    )


def test_a_failed_request_hands_its_title_claim_back_to_the_next_try(tmp_path, monkeypatch):
    """
    The claim is taken before the stream, but the title request only exists
    once there is an answer. A 429 therefore spent the mount's one claim on
    nothing: the reader asked the same question again, got their answer, and
    the Dashboard went on naming the conversation after the question it had
    opened with weeks earlier. Same engagement id throughout — that is the
    point, since the retry comes from the chat that is already open.
    """
    from delphi_core.config import get_settings
    from delphi_core.main import app
    from fastapi.testclient import TestClient

    settings = Settings(
        data_dir=tmp_path, session_secret="test-session-secret", openai_api_key="test-key",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    title_requests = []
    streams = []

    def handler(request):
        payload = json.loads(request.content)
        if not payload.get("stream"):
            title_requests.append(payload)
            return httpx.Response(200, json={"output": [{"content": [
                {"type": "output_text", "text": "Latent IDM ordering in LingBot-VA"},
            ]}]})
        streams.append(payload)
        # Twice: a rate limit is retried once before it fails the request.
        if len(streams) <= 2:
            return httpx.Response(429, headers={"retry-after": "0"},
                                  json={"error": {"message": "Rate limit reached"}})
        events = [
            {"type": "response.output_text.delta", "delta": "They train a latent IDM first."},
            {"type": "response.completed", "response": {"usage": {}}},
        ]
        return httpx.Response(200, content="".join(
            f"data: {json.dumps(event)}\n\n" for event in events
        ).encode())

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient",
        lambda *args, **kwargs: real_client(transport=ProviderTransport(handler)),
    )

    def ask(client):
        with client.stream("POST", "/api/chat/stream", json={
            **conversation_params(client, "general"),
            "prompt": "Did they train an IDM after the video model?",
            "engagement_id": "engagement_one",
        }) as response:
            assert response.status_code == 200
            for _ in response.iter_lines():
                pass

    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-123"})
            client.post("/api/projects", json={"name": "Project"})
            ask(client)
            assert not title_requests
            ask(client)
    finally:
        app.dependency_overrides.pop(get_settings, None)

    assert len(title_requests) == 1
    assert dashboard_payload(storage_for(tmp_path), "reader")["conversations"][0]["title"] == (
        "Latent IDM ordering in LingBot-VA"
    )


def storage_for(tmp_path):
    return LocalStorage(Settings(data_dir=tmp_path))


def seed_conversations(storage, username="reader"):
    """One of each scope, plus a thread nobody ever said anything in.

    The empty one is the point of the fixture: `list_recent_conversations`
    filters on having a message, and a settings sheet listing a document the
    reader has never asked about would be listing their library, not their
    chats.
    """
    project = storage.create_project(username, "Scaling Law")
    paper = storage.add_paper(username, project["id"], {
        "id": "chinchilla", "title": "Chinchilla", "filename": "chinchilla.pdf",
        "createdAt": "2026-01-01T00:00:00+00:00",
    })
    silent = storage.add_paper(username, project["id"], {
        "id": "silent", "title": "Never Asked About", "filename": "silent.pdf",
        "createdAt": "2026-01-01T00:00:00+00:00",
    })
    storage.append_message(username, project["id"], chat_key(storage, username, project["id"], f"paper-{paper['id']}"), {
        "role": "user", "content": "Why twenty tokens per parameter?",
    })
    storage.append_memory_message(username, {
        "role": "user", "content": "What do I already know about scaling?",
    }, chat_key(storage, username))
    # Touched so the thread exists with no message in it at all.
    storage.get_thread(username, project["id"], chat_key(storage, username, project["id"], f"paper-{silent['id']}"))
    return project, paper


def test_every_conversation_with_a_message_is_listed_and_named(tmp_path):
    """
    The Chats pane's whole contract in one place: both scopes, no empty
    threads, and the names a row is drawn with rather than the ids it stores.
    """
    storage = storage_for(tmp_path)
    account(storage)
    project, paper = seed_conversations(storage)

    listed = conversations_payload(storage, "reader")

    assert {item["kind"] for item in listed} == {
        "document_chat", "memory_chat",
    }
    assert all(item["id"] for item in listed)
    # The thread with no message in it never appears, however many documents
    # the project holds.
    assert not any(item.get("paperId") == "silent" for item in listed)

    document = next(item for item in listed if item["kind"] == "document_chat")
    assert document["projectName"] == "Scaling Law"
    assert document["paperTitle"] == "Chinchilla"
    assert document["paperSlug"] == paper["slug"]
    assert document["projectSlug"] == project["slug"]

    wiki = next(item for item in listed if item["kind"] == "memory_chat")
    assert wiki["projectName"] is None
    assert wiki["paperTitle"] is None


def test_the_dashboard_still_lists_a_memory_thread(tmp_path):
    """The Dashboard no longer seeds wiki chat; a Memory row still belongs on it."""
    storage = storage_for(tmp_path)
    account(storage)
    seed_conversations(storage)

    rows = dashboard_payload(storage, "reader")["conversations"]
    wiki = next(item for item in rows if item["kind"] == "memory_chat")
    assert wiki["projectName"] is None
    assert wiki["paperTitle"] is None
    assert wiki["title"]


def test_the_chats_list_is_unbounded_where_the_dashboard_shows_five(tmp_path):
    """
    The Dashboard's five is a hint on the critical path after login; this list
    is what a reader opened a sheet to search. Asserted together because the
    two reads share an enrichment and a limit is exactly the sort of thing that
    gets factored into the shared half by accident.
    """
    storage = storage_for(tmp_path)
    account(storage)
    project = storage.create_project("reader", "Many")
    for index in range(8):
        storage.add_paper("reader", project["id"], {
            "id": f"p{index}", "title": f"Paper {index}", "filename": f"p{index}.pdf",
            "createdAt": f"2026-01-0{index + 1}T00:00:00+00:00",
        })
        storage.append_message("reader", project["id"], chat_key(storage, "reader", project["id"], f"paper-p{index}"), {
            "role": "user", "content": f"Question {index}",
        })

    listed = conversations_payload(storage, "reader")
    assert len(listed) == 8
    assert len(dashboard_payload(storage, "reader")["conversations"]) == 5

    # Newest engagement first, and the same order the Dashboard's five take.
    stamps = [item["lastEngagedAt"] for item in listed]
    assert stamps == sorted(stamps, reverse=True)
    assert [item["id"] for item in listed][:5] == [
        item["id"] for item in dashboard_payload(storage, "reader")["conversations"]
    ]


def test_the_conversations_route_needs_a_session_and_sees_only_its_own(tmp_path):
    # Imported here, like the streaming test above.
    from delphi_core.config import get_settings
    from delphi_core.main import app
    from fastapi.testclient import TestClient

    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            assert client.get("/api/conversations").status_code == 401

            client.post("/api/auth/register",
                        json={"username": "reader", "password": "password-123"})
            seed_conversations(storage_for(tmp_path))
            assert len(client.get("/api/conversations").json()) == 2

            # A second account shares the store and sees none of it. Ownership
            # is enforced inside storage, so this is the assertion that the
            # route did not reach around it.
            client.post("/api/auth/logout")
            client.post("/api/auth/register",
                        json={"username": "stranger", "password": "password-123"})
            assert client.get("/api/conversations").json() == []
    finally:
        app.dependency_overrides.pop(get_settings, None)


def test_the_carousel_sorts_by_recency_while_a_project_keeps_its_colour(tmp_path):
    """
    Two orders, deliberately not the same one. The rail is sorted by what the
    reader touched last, because its cheapest position is its leftmost; the
    accent is stamped from the *unsorted* order, because a project that changed
    colour whenever it was read would not be recognisable as one project — and
    the library rail, which never reorders, would disagree with it on sight.
    """
    storage = LocalStorage(Settings(data_dir=tmp_path))
    account(storage)
    projects = {}
    for index, name in enumerate(["Oldest", "Middle", "Newest"]):
        project = storage.create_project("reader", name)
        projects[name] = project["id"]
        storage.add_paper("reader", project["id"], {
            "id": f"{name.lower()}-paper", "title": name, "filename": "a.pdf",
            "createdAt": f"2026-01-0{index + 1}T00:00:00+00:00",
            "lastEngagedAt": f"2026-01-0{index + 1}T00:00:00+00:00",
        })

    body = dashboard_payload(storage, "reader")
    accents = {row["id"]: row["accentIndex"] for row in body["projects"]}
    # Nothing engaged out of order yet, so the two orders coincide: newest
    # project first, and the accent counts down the same list.
    assert [row["name"] for row in body["projects"]] == ["Newest", "Middle", "Oldest"]
    assert [accents[row["id"]] for row in body["projects"]] == [0, 1, 2]

    storage.touch_paper("reader", projects["Oldest"], "oldest-paper")
    moved = dashboard_payload(storage, "reader")

    assert [row["name"] for row in moved["projects"]] == ["Oldest", "Newest", "Middle"]
    # The whole point: the order moved and the palette did not, so the project
    # the reader just opened is the same colour it was a moment ago.
    assert {row["id"]: row["accentIndex"] for row in moved["projects"]} == accents


def test_project_cards_include_every_document_and_preserve_preview_metadata(tmp_path):
    storage = LocalStorage(Settings(data_dir=tmp_path))
    account(storage)
    project = storage.create_project("reader", "Reading")
    for index in range(7):
        storage.add_paper("reader", project["id"], {
            "id": f"doc-{index}", "title": f"Document {index}", "filename": "paper.pdf",
            "createdAt": f"2026-01-0{index + 1}T00:00:00+00:00",
            "thumbnailAvailable": True, "thumbnailVersion": 8,
            "thumbnailAttemptedAt": "2026-02-01T00:00:00+00:00",
        })
    body = dashboard_payload(storage, "reader")
    documents = body["projects"][0]["documents"]
    assert [paper["id"] for paper in documents] == [f"doc-{i}" for i in reversed(range(7))]
    assert all(paper["thumbnailAvailable"] and paper["thumbnailVersion"] == 8 for paper in documents)
    assert all(paper["thumbnailAttemptedAt"] == "2026-02-01T00:00:00+00:00" for paper in documents)
    assert "recentDocuments" not in body and "resumeTarget" not in body


def _blank_pdf(path):
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.write(path)
    return path


def test_a_pdf_thumbnail_is_rendered_in_the_worker_and_stored(tmp_path):
    """The card is WebP bytes from `pdf_worker`; PDFium never runs in the server.

    Two PDFs uploaded together rendered on two server threads at once, and
    PDFium, which is not thread-safe, aborted the backend in
    `FPDF_RenderPageBitmap`. A native abort runs no `except`, so the render
    belongs in the child, where a crash is only a missing preview.
    """
    import io

    from delphi_core.dashboard import make_pdf_thumbnail

    objects = LocalObjectStore(tmp_path / "data")
    pdf = _blank_pdf(tmp_path / "paper.pdf")
    assert make_pdf_thumbnail(pdf, objects, "reader", "project", "paper") is True
    stored = b"".join(objects.open_range(paper_key("reader", "project", "paper", "thumb")))
    with Image.open(io.BytesIO(stored)) as image:
        assert image.format == "WEBP"
        assert image.width <= 360 and image.height <= 460


def test_a_failed_thumbnail_worker_is_no_thumbnail_and_never_an_error(monkeypatch, tmp_path):
    """Whether the child raises, crashes or hangs, the upload keeps going without a card."""
    import delphi_core.pdf_figures as pdf_figures
    from delphi_core.dashboard import make_pdf_thumbnail

    objects = LocalObjectStore(tmp_path / "data")
    key = paper_key("reader", "project", "paper", "thumb")

    # The child raises on something PDFium cannot open: an answer, not a crash.
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"%PDF-1.4\nnot really a pdf\n")
    assert make_pdf_thumbnail(broken, objects, "reader", "project", "paper") is False
    assert not objects.exists(key)

    # A child that died (SIGABRT, a timeout) is what `run_isolated` answers None for.
    monkeypatch.setattr(pdf_figures, "run_isolated", lambda *_args, **_kwargs: None)
    pdf = _blank_pdf(tmp_path / "paper.pdf")
    assert make_pdf_thumbnail(pdf, objects, "reader", "project", "paper") is False
    assert not objects.exists(key)


def test_an_upload_whose_thumbnail_worker_dies_still_succeeds(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    import delphi_core.pdf_figures as pdf_figures
    from delphi_core.config import get_settings
    from delphi_core.main import app

    monkeypatch.setattr(pdf_figures, "run_isolated", lambda *_args, **_kwargs: None)
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project_id = client.post("/api/projects", json={"name": "Papers"}).json()["id"]
            pdf = _blank_pdf(tmp_path / "paper.pdf").read_bytes()
            response = client.post(
                f"/api/projects/{project_id}/papers",
                files={"file": ("paper.pdf", pdf, "application/pdf")},
            )
            assert response.status_code == 201, response.text
            paper = LocalStorage(settings).get_project("reader", project_id)["papers"][0]
            assert not paper.get("thumbnailAvailable")
            # The attempt is recorded, so the engagement retry knows it is owed.
            assert paper["thumbnailAttempts"] == 1
    finally:
        app.dependency_overrides.clear()
