"""Renderer boundaries without browsers; one tiny child checks daemon shutdown."""
import asyncio
import base64
import ctypes
import hashlib
from io import BytesIO
import json
from pathlib import Path
import signal
import subprocess
import sys
from types import SimpleNamespace

from PIL import Image
import pytest

import delphi_core
from delphi_core.artifacts import render
from delphi_core.artifacts.cdp import CDPCommandError
from delphi_core.artifacts.worker import SCREEN, BrowserRun, WIDTHS, chrome_command, contact_sheet, expectation_met, interaction_passed, interaction_text, prepare_profile


def assets(tmp_path):
    files = {"host.js": b"trusted host", "host.css": b"trusted css"}
    combined = hashlib.sha256()
    for name, content in files.items():
        (tmp_path / name).write_bytes(content)
        combined.update(name.encode() + b"\0" + content + b"\0")
    manifest = {"version": 1, "runtimeHash": combined.hexdigest(), "files": {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}}
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    return manifest


def test_renderer_checks_built_assets_and_combined_identity(tmp_path):
    manifest = assets(tmp_path)
    assert render.renderer_assets(tmp_path) == manifest
    manifest["runtimeHash"] = "0" * 64
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="identity"):
        render.renderer_assets(tmp_path)
    (tmp_path / "host.js").write_text("stale payload")
    with pytest.raises(ValueError, match="checksum"):
        render.renderer_assets(tmp_path)


@pytest.mark.parametrize("checks", [
    [{}], [{"action": "eval", "target": "document.body"}],
    [{"action": "click", "target": "header:reset"}],
    [{"action": "set", "target": "header:next", "value": "1"}],
    [{"action": "click", "target": "button", "javascript": "alert(1)"}],
    [{"action": "click", "target": "x" * 241}],
    [{"action": "click", "target": "button"}] * 7,
])
def test_model_checks_are_bounded_data_not_code(checks):
    with pytest.raises(ValueError):
        render.validate_checks(checks)


@pytest.mark.parametrize("check", [
    {"action": "click", "target": "#sum", "expect_target": "#total", "expect_text": ""},
    {"action": "click", "target": "#sum", "expect_target": "", "expect_text": "66"},
    {"action": "click", "target": "header:next", "expect_target": "header:next", "expect_text": "2"},
    {"action": "click", "target": "#sum", "expect_target": "#total", "expect_text": "6" * 241},
])
def test_an_expectation_names_both_an_element_and_its_text(check):
    with pytest.raises(ValueError, match="expectation"):
        render.validate_checks([check])


def test_checks_keep_expectations_and_default_them_to_none():
    checks = render.validate_checks([{"action": "click", "target": "#sum", "value": "", "expect_target": "#total", "expect_text": " 66 "},
                                     {"action": "click", "target": "header:next"}])
    assert checks == [{"action": "click", "target": "#sum", "value": "", "expect_target": "#total", "expect_text": "66"},
                      {"action": "click", "target": "header:next", "value": "", "expect_target": "", "expect_text": ""}]


def test_an_expectation_may_read_the_header_stepper():
    checks = render.validate_checks([{"action": "click", "target": "header:next", "expect_target": "header:progress", "expect_text": "2 / 4"}])
    assert checks[0]["expect_target"] == "header:progress"


def test_expectations_read_text_or_value_without_spacing_or_case():
    assert expectation_met("66", {"text": "Running total: 66 units", "value": ""})
    assert expectation_met("A = 80", {"text": "a  =  80", "value": ""})
    assert expectation_met("-2", {"text": "\u22122 °C"})
    assert expectation_met("21", {"text": "", "value": "21"})
    assert not expectation_met("66", {"text": "Running total: 61", "value": ""})
    # Whole numbers only: a running total of 166 or 66.5 is not 66.
    assert not expectation_met("66", {"text": "Running total: 166"})
    assert not expectation_met("66", {"text": "66.5 ms"})
    assert not expectation_met("1", {"text": "10 attempts"})
    assert expectation_met("66", {"text": "Total 66."})
    assert expectation_met("60%", {"text": "Recall 60% (30 / 50)"})
    assert not expectation_met("", {"text": "anything"})


def test_contact_sheet_keeps_every_width_and_puts_a_failure_first(monkeypatch):
    seen = []
    real = Image.open
    def record(stream, *args, **kwargs):
        image = real(stream, *args, **kwargs)
        seen.append(image.size[0])
        return image
    monkeypatch.setattr("delphi_core.artifacts.worker.Image.open", record)
    shots = []
    for index, label in enumerate(["Initial · 270px", "After checks · 270px", "Bottom · 270px", "Initial · 460px", "Bottom · 460px", "Initial · 800px", "Bottom · 800px", "Failure state"]):
        buffer = BytesIO()
        Image.new("RGB", (300 + index, 200), "white").save(buffer, format="PNG")
        shots.append((label, buffer.getvalue()))
    assert contact_sheet(shots) is not None
    assert seen == [307, 300, 301, 303, 305]


def test_drafts_render_at_the_rail_chat_and_expanded_widths():
    assert WIDTHS == (270, 460, 800)


def test_child_environment_preserves_home_without_backend_credentials(monkeypatch):
    monkeypatch.setenv("HOME", "/actual/home")
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-leave-parent")
    monkeypatch.setenv("SESSION_SECRET", "must-not-leave-parent")
    monkeypatch.setenv("PYTHONPATH", "/user/import/path")
    result = render._child_environment()
    assert result["HOME"] == "/actual/home"
    assert not ({"OPENAI_API_KEY", "SESSION_SECRET", "PYTHONPATH"} & result.keys())


def test_chrome_uses_only_fresh_profile_and_keeps_browser_sandbox(tmp_path):
    command = chrome_command("/test/chrome", tmp_path)
    assert f"--user-data-dir={tmp_path}" in command
    assert "--remote-debugging-port=0" in command
    assert "--proxy-bypass-list=<-loopback>" in command
    assert not any(flag in command for flag in ("--no-sandbox", "--disable-web-security", "--allow-file-access-from-files"))


def test_validator_seeds_native_webrtc_policy_before_browser_start(tmp_path):
    profile = tmp_path / "isolated"
    prepare_profile(profile)
    assert json.loads((profile / "Default" / "Preferences").read_text()) == {
        "webrtc": {"ip_handling_policy": "disable_non_proxied_udp"},
    }


def test_parent_watch_does_not_hold_buffered_stdin_lock_at_shutdown():
    package = Path(delphi_core.__file__).parent
    script = (f"import sys; sys.path.insert(0, {str(package.parent)!r}); "
              "import threading,time; from delphi_core.artifacts.worker import _parent_watch; "
              "threading.Thread(target=_parent_watch,daemon=True).start(); time.sleep(.05)")
    process = subprocess.Popen([sys.executable, "-I", "-S", str(package / "clean_exec.py"), "",
                                sys.executable, "-I", "-c", script], stdin=subprocess.PIPE,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, close_fds=False)
    try:
        assert process.wait(timeout=5) == 0
        assert b"Fatal Python error" not in process.stderr.read()
    finally:
        if process.poll() is None:
            render.kill_group(process, signal.SIGKILL)
            process.wait(timeout=2)
        process.stdin.close()
        process.stderr.close()


class FakeProcess:
    pid = 123456

    def __init__(self, command, **kwargs):
        self.command, self.kwargs = command, kwargs
        self.stdin = BytesIO()
        self.returncode = None

    def poll(self):
        return self.returncode

    def wait(self):
        self.returncode = -15 if self.returncode is None else self.returncode
        return self.returncode


def setup_process(tmp_path, monkeypatch, *, complete=False, rss=0):
    assets(tmp_path)
    chrome = tmp_path / "chrome"
    chrome.touch()
    monkeypatch.setenv("CHROME_PATH", str(chrome))
    processes, signals = [], []

    def start(command, **kwargs):
        process = FakeProcess(command, **kwargs)
        processes.append(process)
        if complete:
            Path(command[-1]).write_text(json.dumps({"passed": True, "diagnostics": [], "image": None,
                                                   "views": [], "interactions": [], "elapsed_ms": 1, "renderer_version": ""}))
            process.returncode = 0
        return process

    def kill(process, sig):
        signals.append(sig)
        process.returncode = -sig

    monkeypatch.setattr(render.subprocess, "Popen", start)
    monkeypatch.setattr(render, "kill_group", kill)
    monkeypatch.setattr(render, "_group_memory", lambda _: rss)
    return SimpleNamespace(artifact_renderer_path=str(tmp_path)), processes, signals


@pytest.mark.asyncio
async def test_completed_worker_still_has_its_group_reaped(tmp_path, monkeypatch):
    settings, processes, signals = setup_process(tmp_path, monkeypatch, complete=True)
    result = await render.render_artifact(settings, "Test", "<p>Diagram</p>", [])
    assert result.passed and result.renderer_version
    assert signals == [signal.SIGTERM, signal.SIGKILL]
    assert processes[0].stdin.closed
    assert processes[0].kwargs["stdin"] == render.subprocess.PIPE
    assert processes[0].kwargs["close_fds"] is False
    assert processes[0].command[6:9] == ["-I", "-m", "delphi_core.artifacts.worker"]
    assert Path(processes[0].command[3]).resolve() == (Path(delphi_core.__file__).parent / "clean_exec.py").resolve()
    assert not any(key in processes[0].kwargs for key in ("cwd", "preexec_fn", "start_new_session"))
    assert not Path(processes[0].command[-2]).exists()


@pytest.mark.asyncio
async def test_memory_limit_stops_owned_process_group(tmp_path, monkeypatch):
    settings, _, signals = setup_process(tmp_path, monkeypatch, rss=769 * 1024 * 1024)
    result = await render.render_artifact(settings, "Test", "<p>Diagram</p>", [])
    assert not result.passed
    assert result.diagnostics[0]["code"] == "memory_limit"
    assert signal.SIGKILL in signals


@pytest.mark.asyncio
async def test_cancelled_request_closes_parent_watch_and_releases_slot(tmp_path, monkeypatch):
    settings, processes, signals = setup_process(tmp_path, monkeypatch)
    task = asyncio.create_task(render.render_artifact(settings, "Test", "<p>Diagram</p>", []))
    while not processes:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert processes[0].stdin.closed and signal.SIGKILL in signals
    assert not render._SERIAL.locked()
    assert not Path(processes[0].command[-2]).exists()


@pytest.mark.asyncio
async def test_profile_cleanup_failure_does_not_wedge_serial_renderer(tmp_path, monkeypatch):
    settings, _, _ = setup_process(tmp_path, monkeypatch, complete=True)
    original = render.tempfile.TemporaryDirectory

    class UnremovableProfile:
        def __init__(self, **kwargs):
            self.real = original(**kwargs)
            self.name = self.real.name

        def cleanup(self):
            self.real.cleanup()
            raise OSError("profile cleanup failed")

    monkeypatch.setattr(render.tempfile, "TemporaryDirectory", UnremovableProfile)
    result = await render.render_artifact(settings, "Test", "<p>Diagram</p>", [])
    assert not result.passed and not render._SERIAL.locked()
    assert any(item["code"] == "cleanup_failed" for item in result.diagnostics)


def test_contact_sheet_is_bounded_png_feedback():
    buffer = BytesIO()
    Image.new("RGB", (920, 660), "white").save(buffer, format="PNG")
    result = contact_sheet([("Narrow", buffer.getvalue()), ("Wide", buffer.getvalue())])
    assert result["type"] == "input_image" and result["detail"] == "high"
    with Image.open(BytesIO(base64.b64decode(result["image_url"].split(",", 1)[1]))) as image:
        assert image.format == "PNG"
        assert image.width <= 1700 and image.height <= 1356


def test_set_requires_output_effect_beyond_accepting_native_value():
    check = {"action": "set", "value": "3"}
    assert not interaction_passed(check, "3", True, False)
    assert not interaction_passed(check, "2", True, True)
    assert interaction_passed(check, "3", True, True)
    assert interaction_passed({"action": "click"}, None, True, False)


def test_native_toggle_click_requires_output_beyond_checked_state():
    assert not interaction_passed({"action": "click"}, None, True, False, requires_output=True)
    assert interaction_passed({"action": "click"}, None, True, True, requires_output=True)


def test_button_accepts_graphical_effect_beyond_general_state_fingerprint():
    assert interaction_passed({"action": "click"}, None, False, True)
    assert not interaction_passed({"action": "click"}, None, False, False)


def test_action_feedback_prioritizes_changed_outputs_before_long_description():
    result = interaction_text({"textStates": ["Unchanged architecture", "Result: 1"]},
                              {"textStates": ["Unchanged architecture", "Result: 3"], "stateText": "a" * 1000})
    assert result.startswith("Result: 3 · ") and len(result) == 500


def test_initial_header_overlap_is_an_error_and_retained_in_view():
    browser = BrowserRun(FakeCDP())
    view = browser.check_view(270, {"geometry": {"headerOccludesBody": True}}, {})
    assert view["headerOccludesBody"]
    assert browser.diagnostics[0]["code"] == "header_occludes_body"


def test_a_title_the_header_cuts_off_is_an_error_except_in_the_narrow_rail():
    # A probe published a figure card whose title read "…optimal mo…" at 460px.
    browser = BrowserRun(FakeCDP())
    browser.check_view(270, {"geometry": {"titleClipped": True}}, {})
    assert browser.diagnostics == []
    browser.check_view(460, {"geometry": {"titleClipped": True}}, {})
    assert [(row["code"], row["severity"]) for row in browser.diagnostics] == [("title_clipped", "error")]
    assert "shorter title" in browser.diagnostics[0]["message"]


def test_a_diagram_taller_than_a_screen_at_the_widest_width_is_a_warning_only():
    browser = BrowserRun(FakeCDP())
    browser.check_view(270, {}, {"scrollHeight": 2000})
    browser.check_view(800, {}, {"scrollHeight": SCREEN})
    assert browser.diagnostics == []
    browser.check_view(800, {}, {"scrollHeight": 1400})
    assert [(row["code"], row["severity"]) for row in browser.diagnostics] == [("tall_diagram", "warning")]
    assert "1400px" in browser.diagnostics[0]["message"] and "never rerender a passing draft" in browser.diagnostics[0]["message"]


def test_macos_footprint_uses_complete_public_sdk_layout(monkeypatch):
    assert ctypes.sizeof(render._RusageInfoV0) == 96
    assert render._RusageInfoV0.ri_phys_footprint.offset == 72
    monkeypatch.setattr(render.sys, "platform", "darwin")

    def read(pid, flavor, buffer):
        assert pid == 123 and flavor == 0
        info = ctypes.cast(buffer, ctypes.POINTER(render._RusageInfoV0)).contents
        info.ri_resident_size = 900 * 1024 * 1024
        info.ri_phys_footprint = 80 * 1024 * 1024
        return 0

    monkeypatch.setattr(render, "_mac_rusage", lambda: read)
    assert render._process_memory(123, 900 * 1024) == 80 * 1024 * 1024


def test_memory_limit_counts_only_owned_group_and_descendants(monkeypatch):
    monkeypatch.setattr(render, "_process_rows", lambda: [(10, 1, 10, 100), (11, 10, 10, 200), (12, 11, 12, 300), (20, 1, 20, 99999)])
    monkeypatch.setattr(render, "_process_memory", lambda pid, rss: rss)
    assert render._group_memory(10) == 600


def test_signal_permission_race_is_benign_only_after_group_is_gone(monkeypatch):
    process = FakeProcess([], stdin=None)
    process.returncode = -15
    monkeypatch.setattr(render, "kill_group", lambda *_: (_ for _ in ()).throw(PermissionError("gone group")))
    monkeypatch.setattr(render, "_process_rows", lambda: [])
    render._signal_group(process, signal.SIGKILL)
    monkeypatch.setattr(render, "_process_rows", lambda: [(process.pid + 1, 1, process.pid, 10)])
    with pytest.raises(PermissionError):
        render._signal_group(process, signal.SIGKILL)


class FakeCDP:
    def __init__(self):
        self.events = asyncio.Queue()
        self.calls = []

    async def call(self, method, params=None, session=None):
        self.calls.append((method, params, session))
        return {}


@pytest.mark.asyncio
async def test_startup_targets_are_closed_without_relaxing_artifact_target_policy():
    cdp = FakeCDP()
    browser = BrowserRun(cdp)
    task = asyncio.create_task(browser.event_loop())
    for kind, url in (("browser_ui", "chrome://omnibox-popup.top-chrome/"),
                      ("background_page", "chrome-extension://component/background.html"),
                      ("service_worker", "chrome-extension://component/worker.js"),
                      ("worker", "blob:null/author-worker"), ("browser_ui", "https://example.test")):
        await cdp.events.put({"method": "Target.attachedToTarget", "params": {
            "targetInfo": {"type": kind, "url": url, "targetId": kind + url}, "sessionId": "attached"}})
    while len(cdp.calls) < 5:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert all(call[0] == "Target.closeTarget" for call in cdp.calls)
    assert [item["code"] for item in browser.diagnostics] == ["unexpected_target"]


@pytest.mark.asyncio
async def test_a_lent_page_reports_a_worker_without_closing_a_browser_target():
    """A browser host offers nothing browser-wide, so the model hears what the
    draft did, not that a call it never made was refused."""
    cdp = FakeCDP()
    browser = BrowserRun(cdp)
    browser.page_level = True
    task = asyncio.create_task(browser.event_loop())
    await cdp.events.put({"method": "Target.attachedToTarget", "params": {
        "targetInfo": {"type": "worker", "url": "blob:null/author-worker", "targetId": "w"}, "sessionId": "attached"}})
    while not browser.diagnostics:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [call[0] for call in cdp.calls if call[0] == "Target.closeTarget"] == []
    assert [item["code"] for item in browser.diagnostics] == ["unexpected_target"]


@pytest.mark.asyncio
async def test_only_initial_srcdoc_navigation_is_allowed():
    cdp = FakeCDP()
    browser = BrowserRun(cdp)
    browser.host_frame = "host"
    browser.parents["artifact"] = "host"
    task = asyncio.create_task(browser.event_loop())
    for reason, url, disposition in (("initialFrameNavigation", "about:srcdoc", "currentTab"),
                                     ("scriptInitiated", "about:srcdoc", "currentTab"),
                                     ("initialFrameNavigation", "https://example.test", "currentTab"),
                                     ("initialFrameNavigation", "about:srcdoc", "newTab")):
        await cdp.events.put({"method": "Page.frameRequestedNavigation", "sessionId": "owned", "params": {
            "reason": reason, "url": url, "disposition": disposition, "frameId": "artifact"}})
    while len(cdp.calls) < 3:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(cdp.calls) == 3 and all(call[0] == "Page.stopLoading" for call in cdp.calls)
    assert browser.diagnostics[0]["code"] == "navigation_blocked"


@pytest.mark.asyncio
@pytest.mark.parametrize("error,expected", [(CDPCommandError("Session with given id not found."), []),
                                           (RuntimeError("Session with given id not found."), ["boundary_error"]),
                                           (CDPCommandError("Another failure"), ["boundary_error"])])
async def test_remount_ignores_only_authoritative_detached_session_error(monkeypatch, error, expected):
    cdp = FakeCDP()
    browser = BrowserRun(cdp)
    configured = asyncio.Event()

    async def configure(session):
        configured.set()
        raise error

    monkeypatch.setattr(browser, "configure", configure)
    task = asyncio.create_task(browser.event_loop())
    await cdp.events.put({"method": "Target.attachedToTarget", "params": {
        "targetInfo": {"type": "iframe", "url": "about:srcdoc", "targetId": "frame"}, "sessionId": "gone"}})
    await configured.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [item["code"] for item in browser.diagnostics] == expected


@pytest.mark.asyncio
async def test_network_policy_allows_only_embedded_image_and_font_requests():
    cdp = FakeCDP()
    browser = BrowserRun(cdp)
    task = asyncio.create_task(browser.event_loop())
    for identifier, url, kind in (("font", "data:font/woff2;base64,x", "Font"), ("file", "file:///etc/passwd", "Document"), ("web", "https://example.test", "Fetch")):
        await cdp.events.put({"method": "Fetch.requestPaused", "sessionId": "owned", "params": {"requestId": identifier, "request": {"url": url}, "resourceType": kind}})
    while len(cdp.calls) < 3:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [call[0] for call in cdp.calls] == ["Fetch.continueRequest", "Fetch.failRequest", "Fetch.failRequest"]
    assert browser.diagnostics[0]["code"] == "network_blocked"


@pytest.mark.asyncio
async def test_header_probe_rejects_inert_next_even_without_model_checks(monkeypatch):
    browser = BrowserRun(FakeCDP())
    controls = {"progress": "1 / 3", "next": {"disabled": False}, "back": {"disabled": True}}
    state = {"controls": controls}

    async def host(method, argument=None):
        return state

    async def settle():
        return state, {"fingerprint": "same"}

    monkeypatch.setattr(browser, "host", host)
    monkeypatch.setattr(browser, "settle", settle)
    result = await browser.header_probe(state, {"fingerprint": "same"})
    assert not result["passed"]
    assert browser.diagnostics[0]["code"] == "dead_header_control"


@pytest.mark.asyncio
@pytest.mark.parametrize("broken,expected", [(None, None), ("back", "back_state"),
                                            ("back-inert", "dead_header_control"), ("reset", "reset_state")])
async def test_header_lifecycle_uses_output_only_changes_and_restoration(monkeypatch, broken, expected):
    browser = BrowserRun(FakeCDP())
    controls = {"next": {"disabled": False}, "back": {"disabled": False}}
    output = "initial"

    async def host(method, argument=None):
        nonlocal output
        if argument == "next":
            output = "next"
        elif argument == "back":
            output = "wrong" if broken == "back" else "next" if broken == "back-inert" else "initial"
        elif argument == "reset":
            output = "wrong" if broken == "reset" else "initial"
        return {"controls": controls}

    async def settle():
        return {"controls": controls}, {"fingerprint": "same", "effectFingerprint": output}

    monkeypatch.setattr(browser, "host", host)
    monkeypatch.setattr(browser, "settle", settle)
    result = await browser.header_probe({"controls": controls}, {"fingerprint": "same", "effectFingerprint": "initial"})
    assert result["nextChanged"]
    assert result["passed"] is (broken is None)
    assert expected is None or expected in {item["code"] for item in browser.diagnostics}


@pytest.mark.asyncio
async def test_settle_waits_for_output_shape_stability(monkeypatch):
    browser = BrowserRun(FakeCDP())
    shapes = iter(["initial", "changed", "changed"])
    calls = 0

    async def host(_):
        return {"state": "ready", "frame": {"loaded": True}, "finiteAnimations": 0}

    async def inspect():
        nonlocal calls
        calls += 1
        return {"fingerprint": "same", "effectFingerprint": next(shapes), "scrollWidth": 270, "scrollHeight": 100, "animations": 0}

    async def no_delay(_):
        pass

    monkeypatch.setattr(browser, "host", host)
    monkeypatch.setattr(browser, "inspect", inspect)
    monkeypatch.setattr(asyncio, "sleep", no_delay)
    _, inspection = await browser.settle()
    assert calls == 3 and inspection["effectFingerprint"] == "changed"


@pytest.mark.asyncio
async def test_nested_frames_are_rejected_even_when_their_url_is_srcdoc():
    cdp = FakeCDP()
    browser = BrowserRun(cdp)
    browser.host_frame = "host"
    task = asyncio.create_task(browser.event_loop())
    try:
        for frame, parent in (("artifact", "host"), ("nested", "artifact")):
            await cdp.events.put({"method": "Page.frameAttached", "sessionId": "owned", "params": {
                "frameId": frame, "parentFrameId": parent}})
            await cdp.events.put({"method": "Page.frameRequestedNavigation", "sessionId": "owned", "params": {
                "frameId": frame, "reason": "initialFrameNavigation", "url": "about:srcdoc", "disposition": "currentTab"}})
        async with asyncio.timeout(2):
            while len(cdp.calls) < 2:
                await asyncio.sleep(0)
        assert [item["code"] for item in browser.diagnostics] == ["nested_frame", "navigation_blocked"]
        assert all(call[0] == "Page.stopLoading" for call in cdp.calls)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_a_nested_realm_inside_an_out_of_process_artifact_is_rejected():
    # The order Chrome 156 sends: the artifact swaps into its own process, whose
    # session reports a child realm but no frameAttached for it.
    def context(frame, default=True):
        return {"method": "Runtime.executionContextCreated", "sessionId": "artifact-process", "params": {
            "context": {"auxData": {"frameId": frame, "isDefault": default}}}}
    cdp = FakeCDP()
    browser = BrowserRun(cdp)
    browser.host_frame = "host"
    task = asyncio.create_task(browser.event_loop())
    try:
        for event in ({"method": "Page.frameAttached", "sessionId": "page", "params": {"frameId": "artifact", "parentFrameId": "host"}},
                      context("artifact"), {"method": "Page.frameDetached", "sessionId": "page", "params": {"frameId": "artifact", "reason": "swap"}},
                      context("artifact"), context("artifact", default=False), context("host")):
            await cdp.events.put(event)
        while not cdp.events.empty():
            await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert browser.diagnostics == []
        await cdp.events.put(context("nested"))
        async with asyncio.timeout(2):
            while not browser.diagnostics:
                await asyncio.sleep(0)
        assert [item["code"] for item in browser.diagnostics] == ["nested_frame"]
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
