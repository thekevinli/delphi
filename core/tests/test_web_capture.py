"""
A windowed page is opened at its first window and read whole after.

The add answers with the page as its browser first built it, marked
`capture: "partial"`, and queues a `capture` job in the same write; the drain
(`routers/captures.py`) reads the page whole and republishes it. These hold the
two-step add end to end against a page that draws only its first blocks until
its window grows, as Notion's public pages do.
"""
import asyncio
import contextlib
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from delphi_core.browser_render import RENDER_PARTIAL_ATTRIBUTE, stamp_render_width
from delphi_core.config import Settings, get_settings
from delphi_core.main import app
from delphi_core.memory_maintenance.jobs import capture_marker, document_marker
from delphi_core.routers import captures, projects
from delphi_core.routers import memory as memory_router
from delphi_core.storage import LocalObjectStore, LocalStorage, paper_key
from delphi_core.storage.base import CAPTURE_JOB_KINDS
from delphi_core import web_fetch
from delphi_core.web_fetch import FetchedResource
from delphi_core.web_revision import freeze, page_text, publish_saved_page, read_revision

URL = "https://example.notion.site/book"
BLOCKS = [
    f"Chapter {number}: what a language model learns from its {number}th pass over the corpus, "
    "and why the loss keeps falling after the easy patterns are gone."
    for number in range(1, 41)
]
FIRST_WINDOW = 6


def built(blocks: list[str], *, partial: bool) -> str:
    """The page as its browser drew it: the blocks in view, the rest not yet."""
    root = f'<html {RENDER_PARTIAL_ATTRIBUTE}="">' if partial else "<html>"
    body = "".join(f'<div data-block-id="b{i}"><h2>Part {i}</h2><p>{text}</p></div>' for i, text in enumerate(blocks))
    return stamp_render_width(f"<!doctype html>{root}<head><title>The book</title></head><body><main>{body}</main></body></html>", 1512)


@pytest.fixture
def library(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret", memory_job_max_attempts=3)
    app.dependency_overrides[get_settings] = lambda: settings
    browser = SimpleNamespace(reads=[], fail=False, during=None)

    async def shell(url, _settings, **_kwargs):
        # What a plain fetch of a Notion page gets: a script shell with no text.
        return FetchedResource(url=url, body=b"<html><body><div id='notion-app'></div><script src='/app.js'></script></body></html>",
                               content_type="text/html", encoding="utf-8", fetched_at="2026-10-29T12:00:00Z")

    async def render(url, *, asset_hosts=(), source_only=False, whole=True):
        browser.reads.append("whole" if whole else "first window")
        if browser.during:
            browser.during()
        if whole and browser.fail:
            return None
        html = built(BLOCKS, partial=False) if whole else built(BLOCKS[:FIRST_WINDOW], partial=True)
        return FetchedResource(url=url, body=html.encode(), content_type="text/html", encoding="utf-8",
                               fetched_at="2026-10-29T12:00:05Z", rendered=True)

    async def thumbnail(*_args, **_kwargs):
        return True

    monkeypatch.setattr(projects, "fetch_resource", shell)
    monkeypatch.setattr(web_fetch, "render_page", render)
    monkeypatch.setattr(projects, "make_web_thumbnail_safely", thumbnail)
    # Framed copies are this process's, and these pages are the same in every test.
    projects._FRAMED.clear()
    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-123"})
            project = client.post("/api/projects", json={"name": "Books"}).json()["id"]
            storage, objects = LocalStorage(settings), LocalObjectStore(tmp_path)

            def drain():
                response = client.post("/api/captures/drain")
                assert response.status_code == 200, response.text
                return [json.loads(line[5:]) for line in response.text.splitlines() if line.startswith("data:")]

            def memory_claim():
                now = datetime.now(UTC)
                return storage.claim_memory_job("reader", now=now.isoformat(),
                                                lease_expires_at=(now + timedelta(minutes=4)).isoformat(), max_attempts=3)

            yield SimpleNamespace(
                client=client, storage=storage, objects=objects, settings=settings, project=project, browser=browser,
                drain=drain, memory_claim=memory_claim,
                add=lambda: client.post(f"/api/projects/{project}/pages", json={"url": URL}),
                text=lambda paper_id: objects.get_text(paper_key("reader", project, paper_id, "txt")),
                revision=lambda paper_id: read_revision(objects, "reader", project, paper_id),
                jobs=lambda: {job["kind"]: job for job in storage.list_memory_jobs("reader")},
            )
    finally:
        app.dependency_overrides.clear()


def test_a_windowed_page_opens_at_its_first_window_and_is_read_whole_after(library):
    added = library.add()
    assert added.status_code == 201, added.text
    paper = added.json()
    # Opened as the browser first built it, and said to be so.
    assert library.browser.reads == ["first window"]
    assert paper["capture"] == "partial"
    assert BLOCKS[FIRST_WINDOW - 1] in library.text(paper["id"]) and BLOCKS[-1] not in library.text(paper["id"])
    first_copy = library.revision(paper["id"])
    assert RENDER_PARTIAL_ATTRIBUTE not in first_copy["savedDom"] and first_copy["savedPagePartial"] is True
    # The capture is queued with the filing, and the filing waits for it.
    jobs = library.jobs()
    assert jobs["capture"]["marker"] == capture_marker(paper["id"]) and jobs["document"]["marker"] == document_marker(paper["id"])
    assert library.memory_claim() is None
    maintenance = library.client.get("/api/memory/maintenance").json()
    assert maintenance["due"] == 0 and all(job["kind"] != "capture" for job in maintenance["jobs"])

    frames = library.drain()
    assert [frame["type"] for frame in frames] == ["done"]
    done = frames[-1]
    assert done["claimed"] is True and done["paperId"] == paper["id"] and done["remaining"] == 0
    assert "capture" not in done["paper"] and done["paper"]["tokens"] > paper["tokens"]
    assert library.browser.reads == ["first window", "whole"]
    # Both halves are the whole page now.
    assert BLOCKS[-1] in library.text(paper["id"])
    whole_copy = library.revision(paper["id"])
    assert BLOCKS[-1] in whole_copy["savedDom"] and whole_copy["savedPageHash"] != first_copy["savedPageHash"]
    assert "savedPagePartial" not in whole_copy
    assert library.storage.get_paper("reader", library.project, paper["id"]).get("capture") is None
    # The filing it held goes ahead, once, on the whole text.
    assert library.memory_claim()["marker"] == document_marker(paper["id"])
    again = library.drain()[-1]
    assert (again["claimed"], again["remaining"]) == (False, 0)
    assert library.browser.reads == ["first window", "whole"]


def test_a_page_that_is_not_windowed_is_read_once_and_owes_nothing(library, monkeypatch):
    async def ordinary(url, *, asset_hosts=(), source_only=False, whole=True):
        library.browser.reads.append("whole" if whole else "first window")
        html = built(BLOCKS, partial=False)
        return FetchedResource(url=url, body=html.encode(), content_type="text/html", encoding="utf-8",
                               fetched_at="2026-10-29T12:00:05Z", rendered=True)

    monkeypatch.setattr(web_fetch, "render_page", ordinary)
    paper = library.add().json()
    assert "capture" not in paper and set(library.jobs()) == {"document"}
    assert library.memory_claim()["marker"] == document_marker(paper["id"])


def test_a_copy_the_reader_kept_meanwhile_is_theirs_and_only_the_text_is_finished(library):
    paper = library.add().json()
    # The reader annotated the live page, and their frame stored what it drew.
    theirs = freeze(built(BLOCKS[:FIRST_WINDOW], partial=False).replace("</main>", "<p>Drawn by the reader's own browser.</p></main>"), URL, 1180)
    publish_saved_page(library.objects, "reader", library.project, paper["id"], theirs, page_text(theirs), URL, library.storage)

    assert library.drain()[-1]["claimed"] is True
    revision = library.revision(paper["id"])
    assert revision["savedDom"] == theirs
    assert BLOCKS[-1] in library.text(paper["id"])


def test_a_capture_that_fails_is_retried_and_one_that_gives_up_lets_the_filing_go(library):
    paper = library.add().json()
    library.browser.fail = True
    failed = library.drain()[-1]
    assert failed["type"] == "error" and failed["retryAt"] and failed["terminal"] is False
    assert failed["remaining"] == 1
    # Still owed, so the filing still waits.
    assert library.memory_claim() is None
    # The retry is not due yet; then it is, and fails for good on the last attempt.
    assert library.drain()[-1]["claimed"] is False
    for attempt in range(2):
        job = library.jobs()["capture"]
        library.storage.fail_memory_job("reader", job["id"], error="test", retry_at=datetime.now(UTC).isoformat())
        last = library.drain()[-1]
    assert last["type"] == "error" and last["terminal"] is True and last["remaining"] == 0
    # The first window is kept, the record stops promising more, and the
    # document is filed from it.
    assert "capture" not in last["paper"] and "capture" not in library.jobs()
    assert "capture" not in library.storage.get_paper("reader", library.project, paper["id"])
    assert library.revision(paper["id"])["savedPagePartial"] is True
    assert library.memory_claim()["marker"] == document_marker(paper["id"])


def test_a_capture_the_site_throttles_waits_the_throttle_out_rather_than_spending_its_attempts(library, monkeypatch):
    """notion.site answers 429 to everything from a machine that asked too much,
    for five to thirty minutes: Memory's minute would spend every attempt inside it."""
    paper = library.add().json()

    async def throttled(url, _settings, **_kwargs):
        raise HTTPException(422, web_fetch.describe_failure(429, "example.notion.site"))

    monkeypatch.setattr(projects, "fetch_resource", throttled)
    started = datetime.now(UTC)
    failed = library.drain()[-1]
    assert failed["type"] == "error" and failed["terminal"] is False
    assert "example.notion.site" in failed["message"] and "{" not in failed["message"]
    waits = datetime.fromisoformat(failed["retryAt"]) - started
    assert timedelta(seconds=captures.THROTTLED_RETRY_DELAYS[0]) <= waits < timedelta(seconds=captures.THROTTLED_RETRY_DELAYS[0] + 60)
    assert library.storage.get_paper("reader", library.project, paper["id"])["capture"] == "partial"


def test_a_capture_abandoned_until_a_claim_fails_it_is_settled_by_the_next_drain(library):
    paper = library.add().json()
    # Every claim's window went away; the claim that finds it at the ceiling fails it.
    def claim(minute):
        return library.storage.claim_memory_job("reader", now=f"2026-01-01T00:{minute:02d}:00+00:00",
                                                lease_expires_at=f"2026-01-01T00:{minute + 4:02d}:00+00:00",
                                                max_attempts=3, kinds=CAPTURE_JOB_KINDS)

    assert all(claim(minute) for minute in (0, 5, 10))
    assert claim(15) is None
    assert library.jobs()["capture"]["status"] == "failed"

    assert library.drain()[-1] == {"type": "done", "claimed": False, "remaining": 0}
    assert "capture" not in library.jobs()
    assert "capture" not in library.storage.get_paper("reader", library.project, paper["id"])
    assert library.browser.reads == ["first window"]


def test_a_capture_a_quit_app_left_leased_is_finished_at_the_next_launch(library):
    paper = library.add().json()
    # The app was quit mid-capture: its claim is still on the row, and runs out.
    then = datetime.now(UTC) - timedelta(minutes=10)
    held = library.storage.claim_memory_job("reader", now=then.isoformat(), lease_expires_at=(then + timedelta(minutes=4)).isoformat(),
                                            max_attempts=3, kinds=CAPTURE_JOB_KINDS)
    assert held["status"] == "leased"
    assert library.memory_claim() is None

    done = library.drain()[-1]
    assert done["claimed"] is True and BLOCKS[-1] in library.text(paper["id"])
    assert library.memory_claim()["marker"] == document_marker(paper["id"])


def test_a_drain_the_window_left_hands_its_claim_back_unspent(library, monkeypatch):
    paper = library.add().json()
    started = asyncio.Event()

    async def drawing(*_args, **_kwargs):
        started.set()
        await asyncio.sleep(3600)

    monkeypatch.setattr(captures, "capture_whole", drawing)

    async def leave():
        response = captures.drain_captures(username="reader", storage=library.storage, objects=library.objects,
                                           settings=library.settings)
        frames = response.body_iterator
        pull = asyncio.ensure_future(frames.__anext__())
        await started.wait()
        pull.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pull
        await frames.aclose()

    asyncio.run(leave())
    job = library.jobs()["capture"]
    assert (job["status"], job["attempts"], job["leaseExpiresAt"]) == ("pending", 0, None)
    assert not any(key.endswith(job["id"]) for key in memory_router._HELD_CLAIMS)
    assert library.storage.get_paper("reader", library.project, paper["id"])["capture"] == "partial"


def test_the_saved_copy_is_framed_once_per_copy_and_the_capture_frames_the_whole_one_ahead(library, monkeypatch):
    framed = []
    real = projects.render_frame
    monkeypatch.setattr(projects, "render_frame", lambda html, url: framed.append(len(html)) or real(html, url))
    paper = library.add().json()
    page = f"/api/projects/{library.project}/papers/{paper['id']}/page"

    def open_cached():
        response = library.client.get(page, params={"view": "cached"}, headers={"Sec-Fetch-Dest": "iframe"})
        assert response.status_code == 200
        return response.text

    first = open_cached()
    assert open_cached() == first and len(framed) == 1
    library.drain()
    # Framed by the capture while nobody waited, so the reader's swap is not.
    assert len(framed) == 2
    whole = open_cached()
    assert BLOCKS[-1] in whole and len(framed) == 2
