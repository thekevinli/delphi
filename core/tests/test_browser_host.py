"""A browser host a product lends core: the wire, and that no browser is launched beside it."""
import base64
import hashlib
import json
import os
import socket
import tempfile
import threading
import time
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest

from delphi_core import browser_host, browser_render, dashboard
from delphi_core.artifacts import render
from delphi_core.browser_host import AsyncHostPage, BrowserHost, BrowserHostError, HostPage


class FakeHost:
    """One page per connection, answering DevTools calls from `answer`."""

    def __init__(self, answer, *, token="secret", refuse=None, end_after=None, delay_open=0.0):
        # macOS caps a socket path near 104 bytes, so not pytest's tmp_path.
        self.directory = tempfile.mkdtemp(prefix="bh-", dir="/tmp")
        self.path = os.path.join(self.directory, "s")
        self.answer, self.token, self.refuse, self.end_after = answer, token, refuse, end_after
        self.delay_open = delay_open
        self.openings, self.calls = [], []
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        self.server.listen()
        threading.Thread(target=self._serve, daemon=True).start()

    @property
    def host(self):
        return BrowserHost(self.path, self.token)

    def _serve(self):
        while True:
            try:
                connection, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._page, args=(connection,), daemon=True).start()

    def _page(self, connection):
        stream = connection.makefile("rwb")
        try:
            opening = json.loads(stream.readline())
            self.openings.append(opening)
            if self.refuse or opening["token"] != self.token:
                stream.write((json.dumps({"error": self.refuse or "not authorised"}) + "\n").encode())
                return
            time.sleep(self.delay_open)  # every page busy: the job waits its turn
            stream.write(b'{"opened": {"engine": "Chromium/test"}}\n')
            stream.flush()
            for line in stream:
                message = json.loads(line)
                self.calls.append(message)
                if self.end_after is not None and len(self.calls) > self.end_after:
                    stream.write(b'{"method": "Host.ended", "params": {"reason": "memory_limit", "message": "Renderer exceeded its 256 MiB memory limit."}}\n')
                    return
                for event in self.answer.get("events", {}).get(message["method"], []):
                    stream.write((json.dumps(event) + "\n").encode())
                result = self.answer["call"](message)
                if isinstance(result, Exception):
                    stream.write((json.dumps({"id": message["id"], "error": {"message": str(result)}}) + "\n").encode())
                else:
                    stream.write((json.dumps({"id": message["id"], "result": result}) + "\n").encode())
                stream.flush()
        except (OSError, ValueError):
            pass
        finally:
            stream.close()
            connection.close()

    def close(self):
        self.server.close()
        Path(self.path).unlink(missing_ok=True)
        os.rmdir(self.directory)


@pytest.fixture
def no_installed_browser(monkeypatch):
    def refuse(*_):
        raise AssertionError("an installed browser was looked for while a host is configured")
    for module in (browser_render, dashboard, render):
        monkeypatch.setattr(module, "_chrome_executable", refuse)
    monkeypatch.setattr(browser_render, "spawn_clean", refuse)
    monkeypatch.setattr(dashboard, "spawn_clean", refuse)


def test_a_host_needs_both_its_socket_and_its_token():
    assert browser_host.configured({}) is None
    assert browser_host.configured({"BROWSER_HOST_SOCKET": "/tmp/s"}) is None
    assert browser_host.configured({"BROWSER_HOST_SOCKET": "/tmp/s", "BROWSER_HOST_TOKEN": "t"}) == BrowserHost("/tmp/s", "t")


def test_a_page_job_cannot_be_asked_for_without_the_validating_proxy():
    with pytest.raises(ValueError, match="validating proxy"):
        HostPage(BrowserHost("/nonexistent", "t"), "page", width=800, height=600, deadlineSeconds=5)


def test_a_message_is_written_whole_however_short_the_wait_before_it():
    """A render answers a paused request with a script of megabytes between
    waits of a few milliseconds; a send bounded by that wait was cut off mid-line."""
    host = FakeHost({"call": lambda _: {}})
    try:
        with HostPage(host.host, "page", proxy="127.0.0.1:1", width=800, height=600, deadlineSeconds=5) as page:
            with pytest.raises(TimeoutError):
                page.recv(timeout=0.001)
            body = "x" * (24 * 1024 * 1024)
            page.send(json.dumps({"id": 1, "method": "Fetch.fulfillRequest", "params": {"body": body}}))
            assert json.loads(page.recv(timeout=10))["id"] == 1
        assert host.calls[0]["params"]["body"] == body
    finally:
        host.close()


def test_a_refused_page_says_why():
    busy = FakeHost({"call": lambda _: {}}, refuse="no browser page became free before the job's deadline")
    open_ = FakeHost({"call": lambda _: {}})
    try:
        with pytest.raises(BrowserHostError, match="no browser page became free"):
            HostPage(busy.host, "artifact", width=850, height=700, deadlineSeconds=5)
        with pytest.raises(BrowserHostError, match="not authorised"):
            HostPage(BrowserHost(open_.path, "wrong"), "artifact", width=850, height=700, deadlineSeconds=5)
    finally:
        busy.close()
        open_.close()


def test_render_dom_reads_the_built_page_from_the_host_through_the_validating_proxy(monkeypatch, no_installed_browser):
    built = "<!doctype html><html><body><h1>Built</h1></body></html>"

    def call(message):
        expression = message.get("params", {}).get("expression", "")
        if message["method"] == "Page.navigate":
            return {"frameId": "main"}
        if "readyState" in expression:
            return {"result": {"value": json.dumps({"ready": "complete", "quiet": 6000})}}
        if "TreeWalker(document.body" in expression:
            return {"result": {"value": 900}}
        if "contentBottom" in expression:
            # An article drawn to its end: nothing below the view is held back.
            return {"result": {"value": json.dumps({"scrollHeight": 9000, "visibleBottom": 4000, "contentBottom": 8800, "drawn": 400})}}
        if "outerHTML" in expression:
            return {"result": {"value": built}}
        return {}

    host = FakeHost({"call": call})
    monkeypatch.setenv("BROWSER_HOST_SOCKET", host.path)
    monkeypatch.setenv("BROWSER_HOST_TOKEN", host.token)
    monkeypatch.setattr(browser_render, "_pinned_public_address", lambda *_: "93.184.216.34")
    try:
        html = browser_render.render_dom("https://example.org/notes", budget_seconds=5)
    finally:
        host.close()
    assert browser_render.render_width_of(html, 0) == browser_render.RENDER_VIEWPORT_WIDTH and "<h1>Built</h1>" in html
    opening = host.openings[0]["open"]
    assert opening["purpose"] == "page" and opening["proxy"].startswith("127.0.0.1:")
    assert (opening["width"], opening["height"], opening["userAgent"]) == (browser_render.RENDER_VIEWPORT_WIDTH, 4000, browser_render.RENDER_USER_AGENT)
    # The host's connection already is the page: nothing browser-wide is asked for.
    methods = [call["method"] for call in host.calls]
    assert "Target.getTargets" not in methods and "Target.attachToTarget" not in methods
    assert not any("sessionId" in call for call in host.calls)
    # An ordinary page is read at the window it was built in.
    assert "Emulation.setDeviceMetricsOverride" not in methods
    assert opening["deadlineSeconds"] == 5 + browser_render.RENDER_GROW_SECONDS + 10
    assert {"method": "Page.navigate", "params": {"url": "https://example.org/notes"}}.items() <= next(
        call for call in host.calls if call["method"] == "Page.navigate").items()


def test_a_windowed_page_read_for_the_add_keeps_its_window_and_says_it_is_partial(monkeypatch, no_installed_browser):
    """The add reads a windowed page as it was built, and its capture reads it whole."""
    built = "<!doctype html><html><body><h1>Book</h1><p>The first blocks.</p></body></html>"

    def call(message):
        expression = message.get("params", {}).get("expression", "")
        if message["method"] == "Page.navigate":
            return {"frameId": "main"}
        if "readyState" in expression:
            return {"result": {"value": json.dumps({"ready": "complete", "quiet": 6000})}}
        if "TreeWalker(document.body" in expression:
            return {"result": {"value": 900}}
        if "contentBottom" in expression:
            # Notion's first window: drawn to the bottom of the view, reserved blank below.
            return {"result": {"value": json.dumps({"scrollHeight": 23000, "visibleBottom": 4000, "contentBottom": 3990, "drawn": 83})}}
        if "outerHTML" in expression:
            return {"result": {"value": built}}
        return {}

    monkeypatch.setattr(browser_render, "_pinned_public_address", lambda *_: "93.184.216.34")
    read = {}
    for whole in (False, True):
        host = FakeHost({"call": call})
        monkeypatch.setenv("BROWSER_HOST_SOCKET", host.path)
        monkeypatch.setenv("BROWSER_HOST_TOKEN", host.token)
        try:
            html = browser_render.render_dom("https://example.notion.site/book", budget_seconds=5, whole=whole)
        finally:
            host.close()
        read[whole] = (html, [call["method"] for call in host.calls])
    (first, first_calls), (grown, grown_calls) = read[False], read[True]
    assert browser_render.render_is_partial(first) and "<h1>Book</h1>" in first
    assert browser_render.render_width_of(first, 0) == browser_render.RENDER_VIEWPORT_WIDTH
    assert "Emulation.setDeviceMetricsOverride" not in first_calls
    assert "Emulation.setDeviceMetricsOverride" in grown_calls and not browser_render.render_is_partial(grown)


@pytest.mark.parametrize("whole", [False, True])
def test_a_windowed_page_that_never_settled_is_still_measured_for_its_window(monkeypatch, no_installed_browser, whole):
    """Read at the deadline, Notion's book was stored at its first window as
    the whole page: the add never said it was partial, so no capture read the
    rest, and the capture itself never grew it."""
    built = "<!doctype html><html><body><h1>Book</h1><p>Every block.</p></body></html>"
    grown = []

    def call(message):
        expression = message.get("params", {}).get("expression", "")
        if message["method"] == "Page.navigate":
            return {"frameId": "main"}
        if message["method"] == "Emulation.setDeviceMetricsOverride":
            grown.append(message["params"]["height"])
            return {}
        if "readyState" in expression:
            # Never quiet: its analytics keep changing the page.
            return {"result": {"value": json.dumps({"ready": "complete", "quiet": 0})}}
        if "contentBottom" in expression:
            if grown:
                return {"result": {"value": json.dumps({"scrollHeight": 63000, "visibleBottom": 100000, "contentBottom": 62900, "drawn": 1170})}}
            return {"result": {"value": json.dumps({"scrollHeight": 23000, "visibleBottom": 4000, "contentBottom": 3990, "drawn": 83})}}
        if "outerHTML" in expression:
            return {"result": {"value": built}}
        return {}

    monkeypatch.setattr(browser_render, "_pinned_public_address", lambda *_: "93.184.216.34")
    monkeypatch.setattr(browser_render, "RENDER_GROW_SECONDS", 1.0)
    host = FakeHost({"call": call})
    monkeypatch.setenv("BROWSER_HOST_SOCKET", host.path)
    monkeypatch.setenv("BROWSER_HOST_TOKEN", host.token)
    try:
        html = browser_render.render_dom("https://example.notion.site/book", budget_seconds=1, whole=whole)
    finally:
        host.close()
    assert "Every block." in html
    if whole:
        # Still changing when its time for growing ran out too: kept at the tallest window.
        assert grown == [browser_render.RENDER_MAX_HEIGHT]
        assert not browser_render.render_is_partial(html)
    else:
        assert grown == [] and browser_render.render_is_partial(html)


def test_a_render_answers_what_an_earlier_one_was_told_is_immutable_and_asks_for_the_rest(monkeypatch, no_installed_browser):
    """One Notion page is 721 script chunks; adding then capturing it asked
    notion.site for all of them twice in a minute, and it throttled the machine."""
    from delphi_core.render_cache import MAX_ENTRY_BYTES as RENDER_CACHE_ENTRY, RESPONSES

    chunk, fresh = "https://example.notion.site/_assets/app-1.js", "https://example.notion.site/live.js"
    built = "<!doctype html><html><body><h1>Built</h1></body></html>"
    immutable = {"cache-control": "public,max-age=31536000,immutable", "content-type": "text/javascript",
                 "set-cookie": "__cf_bm=x"}

    def response(request_id, url, headers, *, worker=False, size=100):
        return [{"method": "Network.responseReceived", "params": {"requestId": request_id, "type": "Script",
                 "response": {"url": url, "status": 200, "headers": headers, "fromServiceWorker": worker}}},
                {"method": "Network.dataReceived", "params": {"requestId": request_id, "dataLength": size}},
                {"method": "Network.loadingFinished", "params": {"requestId": request_id}}]

    def call(message):
        expression = message.get("params", {}).get("expression", "")
        if message["method"] == "Page.navigate":
            return {"frameId": "main"}
        if message["method"] == "Network.getResponseBody":
            return {"body": "window.app = 1", "base64Encoded": False}
        if message["method"] == "Fetch.fulfillRequest" and refuse_fulfil:
            return RuntimeError("Invalid header")
        if "readyState" in expression:
            return {"result": {"value": json.dumps({"ready": "complete", "quiet": 6000})}}
        if "TreeWalker(document.body" in expression:
            return {"result": {"value": 900}}
        if "contentBottom" in expression:
            return {"result": {"value": json.dumps({"scrollHeight": 9000, "visibleBottom": 4000, "contentBottom": 8800, "drawn": 400})}}
        if "outerHTML" in expression:
            return {"result": {"value": built}}
        return {}

    planted, huge = "https://cdn.example/react.js", "https://example.notion.site/_assets/video.js"
    paused = [{"method": "Fetch.requestPaused", "params": {"requestId": f"f{n}", "resourceType": "Script",
               "request": {"url": url, "method": "GET"}}} for n, url in enumerate((chunk, fresh, planted, huge))]
    events = {"Page.navigate": paused + response("1", chunk, immutable)
              + response("2", fresh, {"cache-control": "max-age=60"})
              # A service worker's word for a CDN's script, and a body past an entry's limit.
              + response("3", planted, immutable, worker=True)
              + response("4", huge, immutable, size=RENDER_CACHE_ENTRY + 1)}
    monkeypatch.setattr(browser_render, "_pinned_public_address", lambda *_: "93.184.216.34")
    RESPONSES.clear()
    calls = []
    refuse_fulfil = False
    try:
        for page, refuse_fulfil in (("https://example.notion.site/book", False), ("https://example.notion.site/book", False),
                                    ("https://example.notion.site/book", True), ("https://other.example/notes", False)):
            host = FakeHost({"call": call, "events": events})
            monkeypatch.setenv("BROWSER_HOST_SOCKET", host.path)
            monkeypatch.setenv("BROWSER_HOST_TOKEN", host.token)
            try:
                assert "<h1>Built</h1>" in browser_render.render_dom(page, budget_seconds=5)
            finally:
                host.close()
            calls.append(host.calls)
    finally:
        RESPONSES.clear()
    first, second, refused, elsewhere = calls
    enabled = next(call for call in first if call["method"] == "Fetch.enable")["params"]["patterns"]
    assert {pattern["resourceType"] for pattern in enabled} == {"Script", "Stylesheet", "Font", "Image"}
    # The first render asks for all of them and keeps only the chunk: not the
    # live script, the service worker's answer, or what outgrew an entry.
    assert [call["params"]["requestId"] for call in first if call["method"] == "Fetch.continueRequest"] == ["f0", "f1", "f2", "f3"]
    assert [call["params"]["requestId"] for call in first if call["method"] == "Network.getResponseBody"] == ["1"]
    # The second answers the chunk itself, without the cookie it came with, and asks for the rest.
    fulfilled = [call["params"] for call in second if call["method"] == "Fetch.fulfillRequest"]
    assert [(params["requestId"], base64.b64decode(params["body"])) for params in fulfilled] == [("f0", b"window.app = 1")]
    assert "set-cookie" not in {header["name"] for header in fulfilled[0]["responseHeaders"]}
    assert [call["params"]["requestId"] for call in second if call["method"] == "Fetch.continueRequest"] == ["f1", "f2", "f3"]
    # A fulfil the browser refuses is sent on rather than left paused.
    assert [call["params"]["requestId"] for call in refused if call["method"] == "Fetch.continueRequest"] == ["f1", "f2", "f3", "f0"]
    # Another site's render is never answered what this one was sent.
    assert not any(call["method"] == "Fetch.fulfillRequest" for call in elsewhere)


def test_a_preview_is_the_hosts_screenshot_of_the_viewport(monkeypatch, no_installed_browser):
    png = __import__("base64").b64encode(b"\x89PNG" + b"\0" * 2000).decode()
    answer = {
        "call": lambda message: {"data": png} if message["method"] == "Page.captureScreenshot" else {},
        "events": {"Page.navigate": [{"method": "Page.loadEventFired", "params": {}}]},
    }
    host = FakeHost(answer)
    monkeypatch.setenv("BROWSER_HOST_SOCKET", host.path)
    monkeypatch.setenv("BROWSER_HOST_TOKEN", host.token)
    monkeypatch.setattr(dashboard, "_pinned_public_address", lambda *_: "93.184.216.34")
    try:
        path = dashboard._capture_webpage("https://example.org/notes", (), "<p>Frozen</p>", 5, 640, 480)
    finally:
        host.close()
    try:
        assert path and path.read_bytes().startswith(b"\x89PNG")
    finally:
        path.unlink()
    opening = host.openings[0]["open"]
    assert (opening["width"], opening["height"], opening["purpose"]) == (640, 480, "page")
    navigate = next(call for call in host.calls if call["method"] == "Page.navigate")
    assert navigate["params"]["url"].startswith("file://")
    # Scripts stay on, so a <noscript> banner ("JavaScript must be enabled")
    # stays hidden as it was when the page drew.
    assert "Emulation.setScriptExecutionDisabled" not in [call["method"] for call in host.calls]


def test_a_preview_is_handed_a_document_with_nothing_in_it_that_runs(monkeypatch, no_installed_browser):
    """From file:// Chromium lets a page read any other file, and a worker a
    handler starts is seen by no request filter: nothing in it may run. This
    is the document both the host and a launched Chrome are given."""
    from urllib.parse import unquote, urlparse
    png = __import__("base64").b64encode(b"\x89PNG" + b"\0" * 2000).decode()
    handed = []

    def call(message):
        if message["method"] == "Page.navigate":
            handed.append(Path(unquote(urlparse(message["params"]["url"]).path)).read_text())
        return {"data": png} if message["method"] == "Page.captureScreenshot" else {}

    host = FakeHost({"call": call, "events": {"Page.navigate": [{"method": "Page.loadEventFired", "params": {}}]}})
    monkeypatch.setenv("BROWSER_HOST_SOCKET", host.path)
    monkeypatch.setenv("BROWSER_HOST_TOKEN", host.token)
    monkeypatch.setattr(dashboard, "_pinned_public_address", lambda *_: "93.184.216.34")
    hostile = ('<p>Frozen</p><img src="x" onerror="new Worker(window.URL.createObjectURL(new Blob([1])))">'
               '<iframe srcdoc="&lt;script&gt;1&lt;/script&gt;"></iframe><a href="javascript:1">j</a>')
    try:
        path = dashboard._capture_webpage("https://example.org/notes", (), hostile, 5, 640, 480)
    finally:
        host.close()
    path.unlink()
    (document,) = handed
    assert "Frozen" in document
    for code in ("onerror", "srcdoc", "javascript:", "Worker"):
        assert code not in document, document


def test_a_job_waits_for_a_page_as_long_as_the_host_may_queue_it():
    host = FakeHost({"call": lambda _: {}}, delay_open=1.5)
    try:
        page = HostPage(host.host, "artifact", timeout=0.5, width=850, height=700, deadlineSeconds=5)
        assert page.opened["engine"] == "Chromium/test"
        page.close()
    finally:
        host.close()


@pytest.mark.asyncio
async def test_an_async_job_waits_for_a_page_as_long_as_the_host_may_queue_it():
    host = FakeHost({"call": lambda _: {}}, delay_open=1.5)
    try:
        page = await AsyncHostPage.open(host.host, "artifact", timeout=0.5, width=850, height=700, deadlineSeconds=5)
        assert page.opened["engine"] == "Chromium/test"
        await page.close()
    finally:
        host.close()


@pytest.mark.asyncio
async def test_a_page_the_host_ends_fails_whatever_waits_on_it_with_the_hosts_reason():
    host = FakeHost({"call": lambda _: {}}, end_after=0)
    try:
        page = await AsyncHostPage.open(host.host, "artifact", width=850, height=700, deadlineSeconds=5)
        from delphi_core.artifacts.cdp import CDP
        async with CDP(page=page) as cdp:
            with pytest.raises(RuntimeError, match="256 MiB memory limit"):
                await cdp.call("Runtime.evaluate", {"expression": "1"})
        assert page.ended_reason == "memory_limit"
    finally:
        host.close()


@pytest.mark.asyncio
async def test_artifact_validation_hands_the_worker_the_host_never_a_chrome(tmp_path, monkeypatch, no_installed_browser):
    files = {"host.js": b"trusted host", "host.css": b"trusted css"}
    combined = hashlib.sha256()
    for name, content in files.items():
        (tmp_path / name).write_bytes(content)
        combined.update(name.encode() + b"\0" + content + b"\0")
    (tmp_path / "manifest.json").write_text(json.dumps({"version": 1, "runtimeHash": combined.hexdigest(),
                                                        "files": {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}}))
    monkeypatch.delenv("CHROME_PATH", raising=False)
    monkeypatch.setenv("BROWSER_HOST_SOCKET", "/tmp/delphi-browser-test/host.sock")
    monkeypatch.setenv("BROWSER_HOST_TOKEN", "per-launch")
    requests = []

    class Finished:
        pid, returncode, stdin = 123456, 0, BytesIO()

        def poll(self):
            return 0

        def wait(self):
            return 0

    def start(command, **_):
        requests.append(json.loads(Path(command[-2]).read_text()))
        Path(command[-1]).write_text(json.dumps({"passed": True, "renderer_peak_bytes": 300 * 1024 * 1024}))
        return Finished()

    monkeypatch.setattr(render.subprocess, "Popen", start)
    monkeypatch.setattr(render, "kill_group", lambda *_: None)
    monkeypatch.setattr(render, "_group_memory", lambda _: 0)
    report = await render.render_artifact(SimpleNamespace(artifact_renderer_path=str(tmp_path)), "Test", "<p>Diagram</p>", [])
    assert report.passed
    assert "chrome" not in requests[0]
    assert requests[0]["host"] == {"socket": "/tmp/delphi-browser-test/host.sock", "token": "per-launch"}
    assert requests[0]["memory_limit"] == 768 * 1024 * 1024
    # The host measured the page's renderers; that is the figure reported.
    assert report.diagnostics[-1]["message"] == "Peak observed renderer resident memory: 300 MiB."
