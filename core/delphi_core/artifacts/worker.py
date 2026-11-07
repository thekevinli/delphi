"""One disposable, offline Chrome run. The caller owns its process-group limit."""
from __future__ import annotations

import asyncio
import base64
import contextlib
from dataclasses import asdict
from io import BytesIO
import json
import os
import re
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

from PIL import Image, ImageDraw

from ..browser_host import AsyncHostPage, BrowserHost
from .cdp import CDP, CDPCommandError
from .display import is_display
from .types import RenderReport

# The narrow rail, the usual chat column and the expanded panel.
WIDTHS = (270, 460, 800)
# A display changes layout at display.css's container breakpoints; a chat column can be
# dragged to any width, so each layout is also walked at its narrowest card.
DISPLAY_BREAKPOINTS = (340, 440, 520, 560)


def display_edges(bare: bool) -> list[int]:
    """Each layout's narrowest card: a breakpoint + 1 for a bare card, + 3 inside a framed card's 1px border."""
    return [width + (1 if bare else 3) for width in DISPLAY_BREAKPOINTS]
# What an expanded chat on a laptop shows of a diagram without scrolling.
SCREEN = 700
INSPECT = Path(__file__).with_name("inspect.js").read_text()
SECURITY_OBSERVER = """globalThis.__delphiArtifactViolations=[];
addEventListener('securitypolicyviolation',e=>{if(globalThis.__delphiArtifactViolations.length<10)
globalThis.__delphiArtifactViolations.push({directive:e.violatedDirective,blocked:e.blockedURI.slice(0,120)})});"""
HOST_DOCUMENT = """<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
</head><body><div id="root"></div></body></html>"""


def chrome_command(executable: str, profile: Path) -> list[str]:
    return [executable, "--headless=new", f"--user-data-dir={profile}", "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
            "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
            "--disable-component-extensions-with-background-pages",
            "--disable-breakpad", "--disable-crash-reporter", "--noerrdialogs", "--metrics-recording-only",
            "--password-store=basic", "--use-mock-keychain", "--proxy-server=http://127.0.0.1:9",
            "--proxy-bypass-list=<-loopback>", "--host-resolver-rules=MAP * ~NOTFOUND",
            "--force-device-scale-factor=1", "--window-size=850,700", "--js-flags=--max-old-space-size=128",
            "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication", "about:blank"]


def _parent_watch() -> None:
    # The server keeps this pipe open but writes no input. SIGKILL/crash of the
    # server therefore kills this worker and its Chrome descendants as well.
    # A buffered stdin reader in a daemon thread holds its lock at interpreter
    # shutdown and can abort an otherwise successful worker. The raw syscall
    # leaves no Python I/O lock for shutdown to acquire.
    while os.read(0, 1):
        pass
    os.killpg(os.getpgrp(), signal.SIGKILL)


def contact_sheet(shots: list[tuple[str, bytes]]) -> dict[str, str] | None:
    if not shots:
        return None
    # Five panels at most: a failure first, then every width's first view,
    # then action feedback and tall bottoms, in the order they were taken.
    rank = {index: (0 if label.startswith("Failure") else 1 if label.startswith("Initial") else 2 if label.startswith("After") else 3, index)
            for index, (label, _) in enumerate(shots)}
    chosen = sorted(sorted(rank, key=rank.get)[:5], key=lambda index: (rank[index][0] != 0, index))
    panels = []
    for label, raw in (shots[index] for index in chosen):
        with Image.open(BytesIO(raw)) as original:
            original.load()
            panel = original.convert("RGB")
        panel.thumbnail((850, 650))
        tile = Image.new("RGB", (max(270, panel.width), panel.height + 28), "#ffffff")
        tile.paste(panel, (0, 28))
        ImageDraw.Draw(tile).text((8, 7), label[:100], fill="#222222")
        panels.append(tile)
    columns = [panels[index:index + 2] for index in range(0, len(panels), 2)]
    width = max(sum(panel.width for panel in row) for row in columns)
    height = sum(max(panel.height for panel in row) for row in columns)
    sheet = Image.new("RGB", (width, height), "#eeeeee")
    y = 0
    for row in columns:
        x = 0
        for panel in row:
            sheet.paste(panel, (x, y))
            x += panel.width
        y += max(panel.height for panel in row)
    output = BytesIO()
    sheet.save(output, format="PNG", optimize=True)
    if output.tell() > 2 * 1024 * 1024:
        output = BytesIO()
        sheet.quantize(colors=128).save(output, format="PNG", optimize=True)
    if output.tell() > 2 * 1024 * 1024:
        return None
    return {"type": "input_image", "image_url": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii"), "detail": "high"}


class BrowserRun:
    def __init__(self, cdp: CDP):
        self.cdp = cdp
        self.sessions: set[str] = set()
        self.main = ""
        self.host_frame = ""
        self.page_level = False
        self.parents: dict[str, str] = {}
        self.diagnostics: list[dict[str, Any]] = []
        self.ready: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
        self.events = None

    def issue(self, code: str, message: str, severity: str = "error", **extra: Any) -> None:
        entry = {"code": code, "severity": severity, "message": message[:400], **extra}
        if len(self.diagnostics) < 24 and entry not in self.diagnostics:
            self.diagnostics.append(entry)

    async def configure(self, session: str) -> None:
        self.sessions.add(session)
        for method, params in (
            ("Network.enable", {}), ("Network.setBlockedURLs", {"urls": ["http://*", "https://*", "file://*", "ftp://*", "ws://*", "wss://*"]}),
            ("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]}),
            ("Runtime.enable", {}), ("Page.enable", {}), ("Log.enable", {}),
            ("Page.addScriptToEvaluateOnNewDocument", {"source": SECURITY_OBSERVER, "worldName": "delphi-artifact-validator"}),
            ("Page.setInterceptFileChooserDialog", {"enabled": True}),
            ("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True}),
        ):
            await self.cdp.call(method, params, session)
        await self.cdp.call("Runtime.runIfWaitingForDebugger", {}, session)

    async def event_loop(self) -> None:
        while True:
            event = await self.cdp.events.get()
            method, params, session = event.get("method"), event.get("params", {}), event.get("sessionId")
            try:
                if method == "Target.attachedToTarget":
                    info, attached = params["targetInfo"], params["sessionId"]
                    internal = (info["type"] == "browser_ui" and info.get("url", "").startswith("chrome://")) or (
                        info["type"] in {"background_page", "service_worker"} and info.get("url", "").startswith("chrome-extension://"))
                    if internal:
                        # Branded Chrome starts component targets even with
                        # extensions disabled in a fresh profile. They are not
                        # artifact targets: close them without resuming scripts.
                        with contextlib.suppress(RuntimeError):
                            await self.cdp.call("Target.closeTarget", {"targetId": info["targetId"]})
                    elif info["type"] not in {"page", "iframe"} or (self.main and info["type"] == "page"):
                        # A lent page offers nothing browser-wide, closing a
                        # target included; the target stays paused where it
                        # attached, and the draft is refused all the same.
                        if not self.page_level:
                            await self.cdp.call("Target.closeTarget", {"targetId": info["targetId"]})
                        self.issue("unexpected_target", "The artifact attempted to create another browser target.")
                    else:
                        await self.configure(attached)
                        await self.ready.put((attached, info["type"]))
                elif method == "Target.detachedFromTarget":
                    self.sessions.discard(params.get("sessionId", ""))
                elif method == "Fetch.requestPaused":
                    if params.get("request", {}).get("url", "").startswith("data:") and params.get("resourceType") in {"Image", "Font"}:
                        await self.cdp.call("Fetch.continueRequest", {"requestId": params["requestId"]}, session)
                    else:
                        await self.cdp.call("Fetch.failRequest", {"requestId": params["requestId"], "errorReason": "BlockedByClient"}, session)
                        self.issue("network_blocked", "External resource or navigation was blocked; artifacts must be self-contained.")
                elif method == "Page.frameAttached":
                    # Never forgotten on detach: the artifact frame "detaches"
                    # from the host session when it swaps into its own process.
                    self.parents[params["frameId"]] = params["parentFrameId"]
                    if self.host_frame and params["parentFrameId"] != self.host_frame:
                        self.issue("nested_frame", "Nested frames are not supported in artifacts.")
                        await self.cdp.call("Page.stopLoading", {}, session)
                elif method == "Runtime.executionContextCreated":
                    # An out-of-process artifact reports no frameAttached for
                    # its own children, but each new realm still gets a context,
                    # including one created and removed between inspections.
                    aux = params.get("context", {}).get("auxData") or {}
                    frame = aux.get("frameId", "")
                    if (aux.get("isDefault") and self.host_frame and frame and frame != self.host_frame
                            and self.parents.get(frame) != self.host_frame):
                        self.issue("nested_frame", "Nested frames are not supported in artifacts.")
                elif method == "Page.frameRequestedNavigation":
                    # Setting the trusted iframe's srcdoc emits this exact
                    # startup event, including after Reset. Link/script/form
                    # navigations still fail even when their URL is srcdoc.
                    initial_srcdoc = (params.get("reason") == "initialFrameNavigation" and
                                      params.get("url") == "about:srcdoc" and params.get("disposition") == "currentTab" and
                                      self.parents.get(params.get("frameId")) == self.host_frame)
                    if not initial_srcdoc:
                        self.issue("navigation_blocked", "Artifact navigation is not supported.")
                        await self.cdp.call("Page.stopLoading", {}, session)
                elif method == "Page.frameNavigated":
                    url = params.get("frame", {}).get("url", "")
                    if url and url not in {"about:blank", "about:srcdoc"}:
                        self.issue("navigation_blocked", "Artifact left its sandbox document.")
                        await self.cdp.call("Page.stopLoading", {}, session)
                elif method == "Page.fileChooserOpened":
                    self.issue("file_access", "File chooser controls are not supported in artifacts.")
                elif method == "Runtime.exceptionThrown":
                    detail = params.get("exceptionDetails", {})
                    description = (detail.get("exception") or {}).get("description") or detail.get("text", "Uncaught script exception")
                    self.issue("runtime_error", str(description))
                elif method == "Runtime.consoleAPICalled" and params.get("type") in {"error", "assert"}:
                    values = [str(arg.get("value", arg.get("description", "")))[:160] for arg in params.get("args", [])[:3]]
                    self.issue("console_error", " ".join(values))
                elif method == "Log.entryAdded":
                    entry = params.get("entry", {})
                    if entry.get("level") == "error":
                        self.issue("browser_error", str(entry.get("text", "Browser error")))
            except Exception as error:
                if isinstance(error, CDPCommandError) and str(error) == "Session with given id not found.":
                    # Reset or a runtime fallback can remove an OOPIF while its
                    # queued configuration/events are still being handled.
                    # Inspect/settle must still find a current loaded frame.
                    self.sessions.discard(params.get("sessionId", "") if method == "Target.attachedToTarget" else session)
                    continue
                self.issue("boundary_error", str(error))

    async def start(self, page_level: bool = False) -> None:
        self.events = asyncio.create_task(self.event_loop())
        if page_level:
            # A browser host hands over the page itself, as the root session,
            # with downloads already refused and no other target to adopt.
            self.page_level = True
            self.main = ""
            await self.configure(self.main)
            return
        await self.cdp.call("Browser.setDownloadBehavior", {"behavior": "deny"})
        await self.cdp.call("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True})
        self.main, _ = await asyncio.wait_for(self.ready.get(), 5)

    async def close(self) -> None:
        if self.events:
            self.events.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.events

    async def host(self, method: str, argument: Any = None, timeout: float = 5) -> Any:
        args = "" if argument is None else json.dumps(argument, ensure_ascii=True)
        return await self.cdp.evaluate(f"window.__delphiArtifactValidator.{method}({args})", self.main, timeout=timeout)

    async def frame(self) -> tuple[str, int]:
        status = await self.host("status")
        name = (status.get("frame") or {}).get("name")
        for session in list(self.sessions):
            try:
                tree = await self.cdp.call("Page.getFrameTree", {}, session)
                todo = [tree["frameTree"]]
                while todo:
                    branch = todo.pop()
                    frame = branch["frame"]
                    if frame.get("name") == name and frame.get("url") == "about:srcdoc":
                        world = await self.cdp.call("Page.createIsolatedWorld", {"frameId": frame["id"], "worldName": "delphi-artifact-validator"}, session)
                        return session, world["executionContextId"]
                    todo.extend(branch.get("childFrames", []))
            except RuntimeError:
                continue
        raise RuntimeError("The sandboxed artifact frame is not available for inspection.")

    async def inspect(self, command: dict | None = None) -> dict:
        session, context = await self.frame()
        return await self.cdp.evaluate(f"({INSPECT})({json.dumps(command or {'kind': 'inspect'})})", session, context)

    async def settle(self) -> tuple[dict, dict]:
        previous = None
        for _ in range(28):
            status = await self.host("status")
            if status.get("state") == "error":
                raise RuntimeError(str(status.get("error") or "Artifact runtime failed"))
            if status.get("state") == "ready" and (status.get("frame") or {}).get("loaded"):
                inspection = await self.inspect()
                if inspection.get("fatal"):
                    raise RuntimeError("Artifact DOM exceeds 4000 elements.")
                size = (inspection.get("scrollWidth"), inspection.get("scrollHeight"), inspection_state(inspection))
                if not inspection.get("animations") and not status.get("finiteAnimations") and size == previous:
                    return status, inspection
                previous = size
            await asyncio.sleep(0.1)
        raise RuntimeError("Artifact did not settle after its finite entrance animations.")

    async def screenshot(self) -> bytes:
        capture = {"format": "png", "captureBeyondViewport": False}
        try:
            response = await self.cdp.call("Page.captureScreenshot", capture, self.main)
        except TimeoutError:
            # Headless Chrome now and then never answers a capture of an idle page; a second request does.
            response = await self.cdp.call("Page.captureScreenshot", capture, self.main)
        return base64.b64decode(response["data"], validate=True)

    async def bottom_screenshot(self, status: dict, inspection: dict) -> bytes | None:
        geometry = status.get("geometry", {})
        transcript = geometry.get("transcript") or {}
        tall_frame = inspection.get("scrollHeight", 0) > inspection.get("height", 0) + 2
        tall_chat = geometry.get("scrollHeight", 0) > transcript.get("height", 600) + 2
        if not tall_frame and not tall_chat:
            return None
        await self.inspect({"kind": "scroll-bottom"})
        await self.host("scroll", geometry.get("scrollHeight", 100000))
        status, _ = await self.settle()
        if status.get("geometry", {}).get("headerVisible") is False:
            self.issue("sticky_header", "The diagram header disappeared while its chat body scrolled.")
        image = await self.screenshot()
        await self.host("scroll", 0)
        return image

    async def header_probe(self, status: dict, inspection: dict) -> dict:
        result: dict[str, Any] = {"probe": "header_lifecycle", "passed": True}
        if not status.get("controls"):
            return {**result, "applicable": False}
        result["applicable"] = True
        initial = inspection_state(inspection)
        initial_controls = status["controls"]
        if not status["controls"]["next"]["disabled"]:
            await self.host("action", "next")
            status, inspection = await self.settle()
            after_next = inspection_state(inspection)
            result["nextChanged"] = after_next != initial
            if not result["nextChanged"]:
                self.issue("dead_header_control", "The declared Next step produced no observable diagram state change.")
                result["passed"] = False
            if status.get("controls") and not status["controls"]["back"]["disabled"]:
                await self.host("action", "back")
                status, inspection = await self.settle()
                if inspection_state(inspection) == after_next and result["nextChanged"]:
                    self.issue("dead_header_control", "The declared Back step produced no observable diagram state change.")
                    result["passed"] = False
                if inspection_state(inspection) != initial:
                    self.issue("back_state", "Back did not restore the diagram state preceding Next.")
                    result["passed"] = False
        await self.host("action", "reset")
        reset, reset_inspection = await self.settle()
        if reset.get("controls") != initial_controls or inspection_state(reset_inspection) != initial:
            self.issue("reset_state", "Reset did not restore the initial diagram, step labels, progress and disabled state.")
            result["passed"] = False
        return result

    def display_view(self, width: int, status: dict) -> dict:
        drawn = status.get("display") or {}
        if width == WIDTHS[-1] and drawn.get("height", 0) > SCREEN:
            self.issue("tall_diagram", f"At {width}px the display is {drawn['height']}px tall; a screen shows about {SCREEN}. Information only: "
                       "if a repair already changes it, make it more compact too; never redraw a passing display for height.", "warning", width=width)
        return {"width": width, "host": {"geometry": {"overflow": drawn.get("scrollWidth", 0) > drawn.get("width", 0) + 1}},
                "document": {key: drawn.get(key) for key in ("width", "height", "scrollWidth", "scrollHeight")}}

    async def display_shot(self, label: str, shots: list[tuple[str, bytes]]) -> None:
        geometry = (await self.host("status")).get("geometry", {})
        taller = geometry.get("scrollHeight", 0) > (geometry.get("transcript") or {}).get("height", 600) + 2
        # A later state changes what lies below the first view, so a card taller
        # than the window is shown from its end; the initial view shows its top.
        if taller and label.startswith("After"):
            await self.host("scroll", geometry["scrollHeight"])
            shots.append((f"{label} · end", await self.screenshot()))
            await self.host("scroll", 0)
            return
        shots.append((label, await self.screenshot()))
        if taller:
            await self.host("scroll", geometry["scrollHeight"])
            shots.append((label.replace("Initial", "Bottom"), await self.screenshot()))
            await self.host("scroll", 0)

    async def validate_display(self, request: dict, shots: list[tuple[str, bytes]]) -> tuple[list, list]:
        """A library display: every state at every width, measured by the host, which draws it from data."""
        views: list[dict] = []
        interactions: list[dict] = []
        for width in WIDTHS:
            await self.cdp.call("Emulation.setDeviceMetricsOverride", {"width": width + 120, "height": 660, "deviceScaleFactor": 1, "mobile": False}, self.main)
            await self.host("mount", {"title": request["title"], "source": request["source"], "width": width}, timeout=10)
            if (await self.host("status")).get("state") == "error":
                raise RuntimeError("The reader could not read this display; its spec and the reader's library disagree.")
            status = await self.host("displayStatus", timeout=10)
            views.append(self.display_view(width, status))
            await self.display_shot(f"Initial · {width}px", shots)
            states = await self.display_walk(width)
            if width != WIDTHS[1]:
                continue
            # Grouped by the option's position; its label names it in messages.
            labels = {state.get("index", 0): state.get("option", "") for state in states}
            order = sorted(labels)
            options = [labels[index] for index in order]
            drawn = {index: [state["fingerprint"] for state in states if state.get("index", 0) == index] for index in order}
            passed = True
            for index, row in drawn.items():
                option = labels[index]
                for at in range(1, len(row)):
                    if row[at] == row[at - 1]:
                        passed = False
                        self.issue("dead_step", f"Step {at + 1}{f' · {option}' if option else ''} looks exactly like step {at}: what it changes is never drawn (a tip, a hidden part, or a value no figure shows).")
            for first in range(len(order)):
                for second in range(first + 1, len(order)):
                    if drawn[order[first]] == drawn[order[second]]:
                        passed = False
                        self.issue("dead_control", f"The options {labels[order[first]]} and {labels[order[second]]} look the same at every step.")
            interactions.append({"probe": "display_states", "passed": passed, "stateText": f"{len(states)} state{'' if len(states) == 1 else 's'} checked at {width}px"})
            last = max(state["step"] for state in states)
            chosen = status["display"].get("option", "")
            if last > 1:
                await self.host("displaySet", {"step": last - 1})
                await self.display_shot(f"After · step {last} of {last}{f' · {chosen}' if chosen else ''} · {width}px", shots)
            other = next((at for at, option in enumerate(options) if option != chosen), None)
            if other is not None and chosen:
                await self.host("displaySet", {"option": other, **({"step": last - 1} if last > 1 else {})})
                await self.display_shot(f"After · {options[other]}{f' · step {last}' if last > 1 else ''} · {width}px", shots)
        for width in display_edges(bool(status["display"].get("bare"))):
            await self.host("displayResize", width, timeout=10)
            await self.display_walk(width)
        return views, interactions

    async def display_walk(self, width: int) -> list[dict]:
        states = await self.host("displayWalk", timeout=30)
        reported: set[tuple[str, str]] = set()
        for state in states:
            where = f"step {state['step']}" + (f" · {state['option']}" if state.get("option") else "")
            for issue in state.get("issues", []):
                # Named once per width, at the first state that shows it.
                if (issue["code"], issue.get("target", "")) not in reported:
                    reported.add((issue["code"], issue.get("target", "")))
                    self.issue(issue["code"], f"At {width}px, from {where}: {issue['message']}", width=width, target=issue.get("target", ""))
        return states

    def check_view(self, width: int, status: dict, inspection: dict) -> dict:
        for issue in inspection.get("issues", []):
            self.issue(issue["code"], issue["message"], issue.get("severity", "error"), width=width, target=issue.get("target", ""))
        for violation in inspection.get("violations", []):
            self.issue("csp_violation", f"Blocked {violation.get('directive', 'resource')}; remove external resources and unsupported capabilities.", width=width)
        geometry = status.get("geometry", {})
        for key, message in (("progressFits", "The header progress is clipped."), ("headerContained", "Header controls leave the artifact card."), ("headerVisible", "The artifact header is not visible.")):
            if geometry.get(key) is False:
                self.issue("header_layout", message, width=width)
        if geometry.get("overflow"):
            self.issue("host_overflow", "The artifact card overflows its chat width.", width=width)
        # The narrow rail shortens any title; the usual and expanded chat must show it whole.
        if geometry.get("titleClipped") and width != WIDTHS[0]:
            self.issue("title_clipped", f"At {width}px the card's title is cut off with an ellipsis; give it a shorter title.", width=width)
        if geometry.get("headerOccludesBody"):
            self.issue("header_occludes_body", "The header covers the beginning of the diagram before scrolling.", width=width)
        height = inspection.get("scrollHeight", 0)
        if width == WIDTHS[-1] and height > SCREEN:
            self.issue("tall_diagram", f"At {width}px the diagram is {height}px tall; a screen shows about {SCREEN}. Information only: "
                       "if a repair already changes the layout, make it more compact too; never rerender a passing draft for height.",
                       "warning", width=width)
        return {"width": width, "headerOccludesBody": bool(geometry.get("headerOccludesBody")), "host": status,
                "document": {key: value for key, value in inspection.items() if key not in {"fingerprint", "effectFingerprint", "textStates", "violations"}}}


def inspection_state(inspection: dict) -> tuple[str, str]:
    # General state includes controls; output evidence additionally captures
    # shape/paint changes that leave labels and bounding boxes unchanged.
    return inspection.get("fingerprint", ""), inspection.get("effectFingerprint", "")


def interaction_passed(check: dict, accepted_value: str | None, changed: bool, effect_changed: bool, requires_output: bool = False) -> bool:
    if check["action"] == "set":
        return accepted_value == check["value"] and effect_changed
    return effect_changed if requires_output else changed or effect_changed


def expectation_met(expected: str, shown: dict) -> bool:
    """
    The promised text appears in the element's visible text or value as whole
    words, ignoring spacing and case: "66" is not found in "166" or "66.5".
    """
    def plain(text: object) -> str:
        return " ".join(str(text or "").replace("\u2212", "-").split()).casefold()
    wanted = plain(expected)
    if not wanted:
        return False
    before = r"(?<![\w.])" if re.match(r"[\w]", wanted) else ""
    after = r"(?![\w]|[.,]\d)" if re.search(r"[\w]$", wanted) else ""
    return re.search(before + re.escape(wanted) + after, f"{plain(shown.get('text'))} | {plain(shown.get('value'))}") is not None


def interaction_text(before: dict, after: dict) -> str:
    previous = set(before.get("textStates", []))
    changed = [text for text in after.get("textStates", []) if text not in previous]
    return " · ".join([*changed, after.get("stateText", "")])[:500]


def prepare_profile(profile: Path) -> None:
    # Chrome reads this from profile preferences, not the similarly named
    # content-shell command-line switch. Together with the dead proxy this
    # denies both direct UDP and proxied TCP, including in new script realms.
    # Only the disposable validator profile is touched, never capture/user data.
    default = profile / "Default"
    default.mkdir(parents=True)
    (default / "Preferences").write_text(json.dumps({
        "webrtc": {"ip_handling_policy": "disable_non_proxied_udp"},
    }))


#: The validator's window, as `chrome_command` sizes a launched Chrome's.
WINDOW = (850, 700)


async def run(request: dict, profile: Path) -> RenderReport:
    if request.get("host"):
        return await run_in_host(request)
    prepare_profile(profile)
    chrome = subprocess.Popen(chrome_command(request["chrome"], profile), stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=False)
    # This already isolated worker is the group leader. Do not start another
    # session for Chrome: parent cancellation must kill the complete tree.
    port_file = profile / "DevToolsActivePort"
    try:
        for _ in range(200):
            if chrome.poll() is not None:
                raise RuntimeError("Chrome exited before its isolated DevTools endpoint was ready.")
            if port_file.is_file():
                lines = port_file.read_text().splitlines()
                if len(lines) >= 2 and lines[0].isdecimal() and lines[1].startswith("/devtools/browser/"):
                    break
            await asyncio.sleep(0.05)
        else:
            raise RuntimeError("Chrome did not start within its cold-start budget.")
        async with CDP(f"ws://127.0.0.1:{int(lines[0])}{lines[1]}") as cdp:
            return await validate(cdp, request)
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=1)
        except subprocess.TimeoutExpired:
            chrome.kill()
            chrome.wait(timeout=1)


async def run_in_host(request: dict) -> RenderReport:
    """The same validation on a page the product's browser host lends.

    The host gives an offline page: no proxy that answers, no WebRTC beyond
    a proxy, downloads, pop-ups and permissions refused, and the artifact
    frames under the reader's own navigation guard. Everything below the page
    — the checks, the widths, the screenshots — is `validate`'s, unchanged.
    """
    page = await AsyncHostPage.open(
        BrowserHost(**request["host"]), "artifact", width=WINDOW[0], height=WINDOW[1],
        deadlineSeconds=float(request["timeout"]) + 5, memoryLimitBytes=request.get("memory_limit"),
    )
    report = None
    try:
        async with CDP(page=page) as cdp:
            report = await validate(cdp, request, page_level=True)
            with contextlib.suppress(Exception):
                usage = await cdp.call("Host.usage", {}, timeout=2)
                report.renderer_peak_bytes = int(usage.get("peakBytes") or 0)
    finally:
        if page.ended_reason == "memory_limit" and report is not None:
            report.passed = False
            report.diagnostics.insert(0, {"code": "memory_limit", "severity": "error", "message": page.ended or ""})
    return report


async def validate(cdp: CDP, request: dict, page_level: bool = False) -> RenderReport:
    browser = BrowserRun(cdp)
    shots: list[tuple[str, bytes]] = []
    views, interactions = [], []
    try:
        await browser.start(page_level)
        tree = await cdp.call("Page.getFrameTree", {}, browser.main)
        browser.host_frame = tree["frameTree"]["frame"]["id"]
        await cdp.call("Page.setDocumentContent", {"frameId": browser.host_frame, "html": HOST_DOCUMENT}, browser.main)
        renderer = Path(request["renderer"])
        await cdp.evaluate("document.head.appendChild(document.createElement('style')).textContent=" + json.dumps((renderer / "host.css").read_text()), browser.main)
        await cdp.evaluate((renderer / "host.js").read_text(), browser.main)
        if is_display(request["source"]):
            views, interactions = await browser.validate_display(request, shots)
            return RenderReport(not any(item["severity"] == "error" for item in browser.diagnostics), browser.diagnostics, contact_sheet(shots), views, interactions)
        for width in WIDTHS:
            await cdp.call("Emulation.setDeviceMetricsOverride", {"width": width + 120, "height": 660, "deviceScaleFactor": 1, "mobile": False}, browser.main)
            # Outlast the host's own eight-second settle, whose error names the cause.
            await browser.host("mount", {"title": request["title"], "source": request["source"], "width": width}, timeout=10)
            status, inspection = await browser.settle()
            views.append(browser.check_view(width, status, inspection))
            shots.append((f"Initial · {width}px", await browser.screenshot()))
            if width == WIDTHS[0]:
                for check in request["checks"]:
                    before_inspection = inspection
                    before = inspection_state(inspection)
                    effect_before = inspection["effectFingerprint"]
                    confirming = False
                    if check["target"].startswith("header:"):
                        action = check["target"].split(":", 1)[1]
                        control = (status.get("controls") or {}).get(action)
                        if not control or control.get("disabled"):
                            outcome = {"error": "disabled_control", "message": "The requested header control is absent or disabled."}
                        else:
                            await browser.host("action", action)
                            outcome = {"animations": (await browser.inspect()).get("animations", 0)}
                    else:
                        # Setting the value already shown confirms it: only the expectation can then fail.
                        confirming = check["action"] == "set" and bool(check["expect_target"]) \
                            and (await browser.inspect({"kind": "read", "target": check["target"]})).get("value") == check["value"]
                        outcome = await browser.inspect({"kind": "act", **check})
                    if outcome.get("error"):
                        browser.issue(outcome["error"], outcome["message"], target=check["target"])
                        interactions.append({**check, "passed": False, "error": outcome["error"], "stateText": inspection.get("stateText", "")[:500]})
                        continue
                    status, inspection = await browser.settle()
                    changed = before != inspection_state(inspection) or bool(outcome.get("animations"))
                    effect_changed = effect_before != inspection["effectFingerprint"] or bool(outcome.get("animations"))
                    accepted_value = None
                    if check["action"] == "set":
                        accepted_value = (await browser.inspect({"kind": "read", "target": check["target"]})).get("value")
                    passed = accepted_value == check["value"] if confirming else \
                        interaction_passed(check, accepted_value, changed, effect_changed, outcome.get("requiresOutput", False))
                    if not passed:
                        browser.issue("dead_control", "The requested action produced no observable diagram output or animation change; choose a different value if already selected.", target=check["target"])
                    elif check.get("expect_target"):
                        if check["expect_target"] == "header:progress":
                            progress = (status.get("controls") or {}).get("progress")
                            shown = {"text": progress} if progress is not None else {"error": "missing_header", "message": "The artifact declares no header stepper."}
                        else:
                            shown = await browser.inspect({"kind": "read", "target": check["expect_target"]})
                        if shown.get("error"):
                            passed = False
                            browser.issue(shown["error"], f"Expectation target: {shown['message']}", target=check["expect_target"])
                        elif not expectation_met(check["expect_text"], shown):
                            passed = False
                            reads = (shown.get("text") or shown.get("value") or "")[:160]
                            browser.issue("wrong_value", f"After this action the element reads “{reads}”, not “{check['expect_text']}”. Fix the computation, or the expectation if it was wrong.", target=check["expect_target"])
                    interactions.append({**check, "passed": passed, "stateText": interaction_text(before_inspection, inspection)})
                    browser.check_view(width, status, inspection)
                if request["checks"]:
                    shots.append((f"After checks · {width}px", await browser.screenshot()))
            else:
                if status.get("controls") and width == WIDTHS[-1]:
                    interactions.append(await browser.header_probe(status, inspection))
                    status, inspection = await browser.settle()
                    browser.check_view(width, status, inspection)
                await browser.host("scroll", 180)
                status = await browser.host("status")
                geometry = status.get("geometry", {})
                if geometry.get("scrollTop", 0) > 0 and geometry.get("headerVisible") is False:
                    browser.issue("sticky_header", "The diagram header disappeared while its chat body scrolled.")
            bottom = await browser.bottom_screenshot(status, inspection)
            if bottom:
                shots.append((f"Bottom · {width}px", bottom))
        image = contact_sheet(shots)
        return RenderReport(not any(item["severity"] == "error" for item in browser.diagnostics), browser.diagnostics, image, views, interactions)
    except Exception as error:
        browser.issue("renderer_error", f"{type(error).__name__}: {error}")
        with contextlib.suppress(Exception):
            shots.append(("Failure state", await browser.screenshot()))
        return RenderReport(False, browser.diagnostics, contact_sheet(shots), views, interactions)
    finally:
        await browser.close()


def main() -> None:
    request_path, response_path = map(Path, sys.argv[1:3])
    if os.getpgrp() != os.getpid():
        raise SystemExit("Artifact workers must be started through clean_exec in their own process group.")
    threading.Thread(target=_parent_watch, daemon=True).start()
    started = time.monotonic()
    try:
        request = json.loads(request_path.read_text())
        with tempfile.TemporaryDirectory(prefix="chrome-", dir=request_path.parent) as profile:
            report = asyncio.run(asyncio.wait_for(run(request, Path(profile)), float(request["timeout"])))
    except Exception as error:
        report = RenderReport(False, [{"code": "renderer_error", "severity": "error", "message": f"{type(error).__name__}: {error}"[:400]}])
    report.elapsed_ms = round((time.monotonic() - started) * 1000)
    response_path.write_text(json.dumps(asdict(report)))
    response_path.chmod(0o600)


if __name__ == "__main__":
    main()
