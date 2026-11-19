"""
Delphi's one headless browser, and the hardening every use of it shares.

Two jobs, two processes, one dangerous operation. A page that builds itself
needs Chromium to dump the DOM its scripts drew — that is the 15s Notion
wait, and it only runs when a plain fetch had nothing to parse. The
Dashboard card needs a PNG of that same document. Dumping the live page and
screenshotting it in one invocation would photograph Notion's topbar and
lazy 1×1 image placeholders; the card is instead a picture of the frozen
copy, after scripts and product chrome are gone, so `/image/…` URLs are
already real and the proxy can follow them to S3. What is shared is the
check that every host reached is public, and the process defaults a
server-shaped parent would otherwise hand the child.
"""

import contextlib
import base64
import json
import re
import logging
import os
import select
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path
from collections.abc import Callable
from typing import Any

from bs4 import BeautifulSoup

from .browser_host import BrowserHost, BrowserHostError, HostPage, configured as browser_host
from .render_cache import MAX_ENTRY_BYTES, RESOURCE_TYPES, RESPONSES, as_text, is_immutable
from .web_fetch import check_public_host, is_public_address

logger = logging.getLogger("uvicorn.error")

#: A page that builds itself in the browser has to run its own bundle, fetch its
#: own data and paint before there is anything to read. Notion's public pages
#: land at 15-20s; below that the dump is a loading skeleton, which extracts to
#: nothing and looks exactly like a page with no text.
RENDER_BUDGET_SECONDS = 20.0

#: A framework bakes computed pixel values into the markup as it renders, so a
#: stored DOM is only correct at the width it was built at — anything
#: photographing it must match. 1512 is where Notion's column stops overflowing;
#: narrower cropped the headline's first word.
RENDER_VIEWPORT_WIDTH = 1512

#: Tall enough that a lazy-loading page is mostly "in view" while it builds: an
#: `IntersectionObserver` that never sees a figure never swaps its real `src`
#: in. A windowed page is grown past this once built (`_uncover_windowed`).
RENDER_VIEWPORT_HEIGHT = 4000

#: Headless Chrome puts `HeadlessChrome/141.0.0.0` in its User-Agent and sets
#: `navigator.webdriver`, and reputation services score both hard: with them,
#: notion.site served an interstitial on every render after the first two;
#: without, the same page came back whole. This is not a disguise — it is
#: Chrome, rendering a page a reader asked for, and this is what Chrome calls
#: itself. What it stops is being classed as automation for saying so.
#:
#: Kept in step with a real Chrome release. A UA far behind the current one is
#: itself a signal, so this is worth bumping when the pinned runtime moves.
RENDER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)

#: Chromium says these on every headless run in a container and none of them
#: has ever been the problem. They are dropped so the line that *is* the
#: problem is not buried under twenty of them.
BROWSER_NOISE = ("dbus", "nss_util", "gcm/engine", "UPower", "PHONE_REGISTRATION")


def _browser_errors(handle: Any, keep: int = 40) -> str:
    """Chromium's stderr, for a log line about a failed run.

    Generous, because a crash says why in the *first* lines it prints and the
    tail is whatever happened to be last. Keeping three of them cost a whole
    deploy cycle: all it showed was the crashpad handler falling over, which is
    a consequence of the browser aborting rather than the reason for it.
    """
    try:
        handle.seek(0)
        text = handle.read().decode("utf-8", errors="replace")
    except Exception:
        return ""
    finally:
        handle.close()
    rows = [
        row.strip() for row in text.splitlines()
        if row.strip() and not any(noise in row for noise in BROWSER_NOISE)
    ]
    if not rows:
        return ""
    if len(rows) > keep:
        # Head and tail, never a plain tail: the reason is at the top and the
        # last thing written is usually the wreckage.
        rows = rows[: keep - 10] + [f"…{len(rows) - keep} lines…"] + rows[-10:]
    return "; " + " | ".join(rows)


def _chrome_executable() -> str | None:
    candidates = (
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
        shutil.which("google-chrome"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    )
    return next((path for path in candidates if path and Path(path).is_file()), None)


def _pinned_public_address(hostname: str, port: int) -> str | None:
    check_public_host(f"https://{hostname}")
    addresses = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    address = next(
        (row[4][0] for row in addresses if row[0] == socket.AF_INET and row[4]),
        None,
    )
    if not address:
        return None
    if not is_public_address(address):
        return None
    return address


#: How a stored DOM records the width it was laid out at. Stamped rather than
#: assumed, because the constant is exactly the kind of thing that gets tuned:
#: a document rendered at 1280 and later photographed at 1512 is cropped just
#: as badly as the reverse, and nothing about the markup says which it was.
RENDER_WIDTH_ATTRIBUTE = "data-delphi-render-width"
_HTML_TAG = re.compile(r"<html\b", re.IGNORECASE)


def stamp_render_width(html: str, width: int) -> str:
    return _HTML_TAG.sub(
        f'<html {RENDER_WIDTH_ATTRIBUTE}="{width}"', html, count=1
    )


def render_width_of(html: str, default: int) -> int:
    """The width this DOM was built at, for anything that has to match it.

    Read from the root element's start tag and nowhere else: the same words in
    a code sample, or on an element a page stamped itself, are not a width.
    """
    found = re.search(
        rf"<html\b[^>]*?\s{RENDER_WIDTH_ATTRIBUTE}=['\"](\d{{3,5}})['\"]",
        html or "",
        re.IGNORECASE,
    )
    return int(found.group(1)) if found else default


#: How a DOM read before its page was drawn whole says so: a windowed page read
#: at the window it was built in (`render_dom(whole=False)`). Stamped on the
#: root like the width, and gone from any copy `freeze` makes of it.
RENDER_PARTIAL_ATTRIBUTE = "data-delphi-render-partial"


def render_is_partial(html: str) -> bool:
    """Whether this DOM holds only the first window of a windowed page."""
    return bool(re.search(rf"<html\b[^>]*?\s{RENDER_PARTIAL_ATTRIBUTE}=", html or "", re.IGNORECASE))


def _asset_hosts(html: str, base_url: str) -> tuple[str, ...]:
    soup = BeautifulSoup(html, "html.parser")
    hosts: list[str] = []
    for node in soup.find_all(("link", "script", "img", "source", "video")):
        for attribute in ("href", "src", "poster"):
            value = node.get(attribute)
            if not value:
                continue
            host = urllib.parse.urlparse(
                urllib.parse.urljoin(base_url, str(value))
            ).hostname
            if host and host not in hosts:
                hosts.append(host)
    return tuple(hosts[:16])


_CLEAN_EXEC = str(Path(__file__).with_name("clean_exec.py"))


def spawn_clean(
    command: list[str], *, stdout: Any, stderr: Any, cwd: str | None = None
) -> subprocess.Popen:
    """Start `command` in its own session, with the defaults a shell would give.

    Through `clean_exec.py`, which sets the child up and then execs `command`,
    so that `subprocess` can use `posix_spawn` rather than forking this
    threaded server — that module says why a fork is not safe here. The pid is
    `command`'s own once it has exec'd, and it leads its own process group.
    """
    return subprocess.Popen(
        [sys.executable, "-I", "-S", _CLEAN_EXEC, cwd or "", *command],
        stdout=stdout,
        stderr=stderr,
        close_fds=False,
    )


def kill_group(process: subprocess.Popen, sig: int) -> None:
    """Signal a `spawn_clean` child and everything it started.

    Its group exists only once `clean_exec.py` has called `setsid`; in the few
    milliseconds before that, the pid is signalled directly instead.
    """
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        with contextlib.suppress(ProcessLookupError):
            process.send_signal(sig)


def _inherited_signal_state() -> str:
    """What this process would have handed a child, for a failure log line."""
    try:
        disposition = signal.getsignal(signal.SIGCHLD)
        blocked = signal.pthread_sigmask(signal.SIG_BLOCK, set())
        return (
            f" [parent SIGCHLD={getattr(disposition, 'name', disposition)},"
            f" blocked={sorted(signal.Signals(number).name for number in blocked)}]"
        )
    except Exception:
        return ""


class _PublicOnlyProxy(socketserver.ThreadingTCPServer):
    """A loopback proxy that lets the renderer reach the public internet only.

    Pinning the resolver to a fixed host list is safe and, for anything that
    builds itself in the browser, wrong: the shell names almost no hosts, so
    the catch-all refuses whatever the page turns out to need. On a Notion page
    that is every figure — one of twenty images survived, and the reader got a
    column of "Go online to view this image" where the diagrams should be.

    Validating each request instead of guessing the list in advance is both
    more permissive and stricter. More permissive because a host nobody could
    have predicted still loads. Stricter because the check happens per
    connection and we then dial *the address we validated*, closing the
    resolve-then-connect gap `check_public_host` documents and cannot close on
    its own.
    """

    daemon_threads = True
    allow_reuse_address = True


class _ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.request.recv(65536)
            if not chunk:
                return
            head += chunk
            if len(head) > 65536:
                return
        request_line = head.split(b"\r\n", 1)[0].decode("latin-1")
        parts = request_line.split(" ")
        if len(parts) < 2:
            return
        method, target = parts[0], parts[1]

        if method.upper() == "CONNECT":
            host, _, port_text = target.rpartition(":")
            port = int(port_text) if port_text.isdigit() else 443
            rest = b""
        else:
            parsed = urllib.parse.urlparse(target)
            host = parsed.hostname or ""
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            rest = head

        address = None
        try:
            if host:
                address = _pinned_public_address(host, port)
        except Exception:
            address = None
        if not address:
            # Same answer for a private address and an unresolvable one: the
            # renderer is told the host does not exist, exactly as the
            # `~NOTFOUND` catch-all used to say, and the page draws without it.
            self.request.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return

        try:
            upstream = socket.create_connection((address, port), timeout=15)
        except OSError:
            self.request.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return

        try:
            if method.upper() == "CONNECT":
                self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            elif rest:
                upstream.sendall(rest)
            _pipe(self.request, upstream)
        finally:
            upstream.close()


def _pipe(one: socket.socket, other: socket.socket) -> None:
    """Shuttle bytes until either side is done."""
    sockets = [one, other]
    for handle in sockets:
        handle.settimeout(None)
    try:
        while True:
            ready, _, broken = select.select(sockets, [], sockets, 30)
            if broken or not ready:
                return
            for source in ready:
                target = other if source is one else one
                try:
                    data = source.recv(65536)
                except OSError:
                    return
                if not data:
                    return
                try:
                    target.sendall(data)
                except OSError:
                    return
    except (OSError, ValueError):
        return


@contextlib.contextmanager
def _public_only_proxy() -> Any:
    """Run the validating proxy on loopback for the life of one render."""
    server = _PublicOnlyProxy(("127.0.0.1", 0), _ProxyHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"{server.server_address[0]}:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def base_chrome_flags(profile: Path, crashes: Path, network: list[str]) -> list[str]:
    """The flags that make a headless run safe and survivable, minus the output.

    Shared because two of these were each paid for with a deploy cycle, and a
    second copy of the list is a second chance to omit one.

    `network` is the caller's because `--proxy-server` and
    `--host-resolver-rules` are mutually exclusive. Both current uses pass the
    validating proxy: a stored image URL can redirect to a host the markup
    never named, and pinning the ones it did named refused Notion's S3 figures.
    """
    return [
        "--headless=new",
        "--disable-background-networking",
        "--autoplay-policy=user-gesture-required",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--disable-translate",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-default-browser-check",
        "--no-first-run",
        *network,
        "--allow-file-access-from-files",
        # Chromium refuses to run without somewhere to put a crash report.
        # Its default is derived from the home directory, and in the
        # deployed service that resolved to nothing: the crashpad handler
        # was launched with an empty `--database`, refused to start, and
        # the browser aborted with SIGTRAP two to three seconds in — the
        # entire content of its stderr, and the whole reason previews
        # stopped appearing. The same image and flags work as a Cloud Run
        # job, so nothing about the container was ever the problem.
        #
        # Both halves are stated rather than inherited: the reporter is
        # switched off, because a headless renderer has no use for crash
        # uploads, and a writable directory is named anyway so the handler
        # has a valid argument if a build ignores the first flag. `HOME`
        # itself is deliberately *not* overridden — pointing it at a fresh
        # directory makes Chrome-for-Mac treat the run as a new profile and
        # start the Google Updater, which hung every local capture past its
        # ceiling. Name what this needs; inherit the rest.
        "--disable-breakpad",
        f"--crash-dumps-dir={crashes}",
        f"--user-data-dir={profile}",
        # Both halves of "this is a browser". Headless Chrome otherwise names
        # itself `HeadlessChrome` and leaves `navigator.webdriver` set, and a
        # page that scores those refuses to render for anyone — the reader gets
        # an interstitial where the article should be. Shared with the
        # screenshot path deliberately: a preview of a bot-check page is as
        # useless as a snapshot of one.
        f"--user-agent={RENDER_USER_AGENT}",
        "--disable-blink-features=AutomationControlled",
    ]


def render_dom(
    url: str,
    *,
    asset_hosts: tuple[str, ...] = (),
    budget_seconds: float = RENDER_BUDGET_SECONDS,
    source_only: bool = False,
    whole: bool = True,
) -> str | None:
    """Return a browser-built snapshot, or the original response for live reading.

    `source_only` does not run page scripts or wait for the DOM to settle. It
    uses the same browser transport when a server refuses the plain HTTP client.

    `whole=False` reads a windowed page at the window it was built in, rather
    than growing the window until all of it is drawn (`_uncover_windowed`),
    and stamps the DOM as partial (`render_is_partial`). That is the add's
    first build, which the reader is waiting on; `routers.captures` reads the page
    whole afterwards. A page that is not windowed reads the same either way.

    None for every failure — no browser, an unpinnable host, a crash, an empty
    dump — because every caller's answer to all of them is the same: fall back
    to what the plain fetch produced and tell the reader honestly. Raising here
    would turn a page we merely cannot render into a 500.
    """
    # A product's own browser, when it lends one, and then never an installed
    # one: falling back would bring back the browser it exists to replace.
    host = browser_host()
    browser = None if host else _chrome_executable()
    if not host and not browser:
        return None
    hostname = urllib.parse.urlparse(url).hostname
    if not hostname:
        return None
    try:
        # Validated up front so an unreachable or private target never starts a
        # browser at all. Every *other* host the page asks for is validated by
        # the proxy below, one request at a time.
        if not _pinned_public_address(hostname, 443):
            return None
    except Exception:
        return None
    if host:
        return _render_with_host(host, url, budget_seconds, source_only=source_only, whole=whole)

    with tempfile.TemporaryDirectory(prefix="delphi-render-") as directory, (
        _public_only_proxy()
    ) as proxy:
        root = Path(directory)
        (root / "crashes").mkdir()
        command = [
            browser,
            *base_chrome_flags(
                root / "profile",
                root / "crashes",
                # Loopback, so nothing off this machine can reach it, and it
                # outlives only this render. The DevTools port below is loopback
                # too, and the page cannot reach it: `<-loopback>` sends loopback
                # through this proxy, which refuses every non-public address.
                [f"--proxy-server={proxy}", "--proxy-bypass-list=<-loopback>"],
            ),
            f"--window-size={RENDER_VIEWPORT_WIDTH},{RENDER_VIEWPORT_HEIGHT}",
            # Stated, not inherited: a Retina host defaults to 2 and the
            # capture pins 1, so the DOM would be built at one scale and
            # photographed at another.
            "--force-device-scale-factor=1",
            # Driven over DevTools, not `--dump-dom`: that dumps once a virtual
            # time budget is spent, and virtual time stands still while any
            # request is pending — Notion's article was complete at 5.7s and
            # dumped at 16s, after its last analytics call. Here the page is
            # read once its content stops changing (`_read_document`).
            "--remote-debugging-port=0",
            "about:blank",
        ]
        errors = tempfile.TemporaryFile()
        started = time.monotonic()
        process = spawn_clean(command, stdout=subprocess.DEVNULL, stderr=errors)
        html: str | None = None
        failure = ""
        try:
            html = _read_document(process, root / "profile", url, budget_seconds, source_only=source_only, whole=whole)
        except Exception as exc:  # every failure is "no DOM"; say which
            failure = f"{type(exc).__name__}: {exc}"
        finally:
            if process.poll() is None:
                kill_group(process, signal.SIGTERM)
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    kill_group(process, signal.SIGKILL)
                    process.wait(timeout=1)

        elapsed = round(time.monotonic() - started, 1)
        if not html:
            logger.warning(
                "render: %s produced no dom after %ss — %s%s",
                url, elapsed,
                failure or f"chromium exited {process.returncode}",
                _browser_errors(errors),
            )
            return None
        errors.close()
        logger.info("render: %s rendered in %ss (%d chars)", url, elapsed, len(html))
        return html if source_only else stamp_render_width(html, RENDER_VIEWPORT_WIDTH)


def _render_with_host(
    host: BrowserHost, url: str, budget_seconds: float, *, source_only: bool, whole: bool = True
) -> str | None:
    """`render_dom` on the product's browser: the same proxy, viewport and reading.

    The host page is laid out at the width and scale the flags give a launched
    Chrome, speaks with the same User-Agent, and reaches the network only
    through this process's validating proxy. Its startup is bounded like
    Chromium's, apart from the page's own budget.
    """
    started = time.monotonic()
    html: str | None = None
    failure = ""
    with _public_only_proxy() as proxy:
        try:
            with HostPage(
                host, "page", timeout=RENDER_STARTUP_SECONDS, proxy=proxy,
                width=RENDER_VIEWPORT_WIDTH, height=RENDER_VIEWPORT_HEIGHT, userAgent=RENDER_USER_AGENT,
                # The host ends the page itself a little after this process would
                # have given up on it, so an abandoned page cannot outlive it.
                deadlineSeconds=budget_seconds + RENDER_GROW_SECONDS + 10,
            ) as page:
                html = _drive_document(
                    page, None, url, time.monotonic() + budget_seconds,
                    source_only=source_only, started=started, whole=whole,
                )
        except Exception as exc:  # every failure is "no DOM"; say which
            failure = f"{type(exc).__name__}: {exc}"
    elapsed = round(time.monotonic() - started, 1)
    if not html:
        logger.warning("render: %s produced no dom after %ss in the browser host — %s",
                       url, elapsed, failure or "empty document")
        return None
    logger.info("render: %s rendered in %ss in the browser host (%d chars)", url, elapsed, len(html))
    return html if source_only else stamp_render_width(html, RENDER_VIEWPORT_WIDTH)


#: How long a page's content must go unchanged before it counts as built. A
#: second covers a framework's late widgets (Notion adds ~110 nodes for two
#: seconds after its article is complete).
RENDER_SETTLE_SECONDS = 1.0

#: Quiet alone cannot tell "built" from "waiting on its data": a shell that is
#: still fetching its article is also still. So a page is not built while a
#: script's own request (fetch or XHR) is pending — unless it has been pending
#: this long, which is a poll, a stream or an analytics straggler, not the
#: article. Those are what kept `--dump-dom` waiting sixteen seconds on Notion.
RENDER_REQUEST_PATIENCE_SECONDS = 5.0

#: A page that has neither changed nor asked for anything in this long is not
#: going to build — a challenge page, or one that is simply empty — and is read
#: as it stands rather than held to the deadline.
RENDER_IDLE_SECONDS = 5.0

#: How long Chromium may take to start before a render is given up on. Not
#: part of the page's budget.
RENDER_STARTUP_SECONDS = 10.0

#: A windowed page draws only the part of itself in view and holds the rest as
#: reserved, blank space: Notion's public page drew 83 of its 1170 blocks in a
#: 4000px window, its scroller 23k px tall and blank below 5.6k. Scrolling does
#: not collect the rest — each block is unmounted as it leaves the view — so
#: the page is shown a window tall enough to hold it. These bound that: the
#: blank below the last thing drawn that marks a page as windowed, the tallest
#: window it is shown, and the time it may take, which is its own and not the
#: page's budget. The height is not what costs memory: Notion's renderer
#: held ~1.2 GB in a 24k and a 100k px window alike, since Chromium caps the
#: tiles it paints, and ~0.85 GB at 4000 px; what grows is the DOM drawn.
RENDER_WINDOW_BLANK_PX = 2000
RENDER_MAX_HEIGHT = 100_000
RENDER_GROW_SECONDS = 20.0

#: How far short of the window's bottom a windowed page's drawn rows may end,
#: and the margin a fitted window keeps below the content.
_WINDOW_SLACK_PX = 100

# Installed before any page script, so the page cannot build anything unseen.
# Content only — nodes and text: a lazy image swapping its `src` changes
# nothing a reader or the extractor reads.
_SETTLE_OBSERVER = """(() => {
  if (window.__delphiSettle) return;
  const settle = window.__delphiSettle = { last: performance.now() };
  const watch = () => new MutationObserver(() => { settle.last = performance.now(); })
    .observe(document, { subtree: true, childList: true, characterData: true });
  if (document.documentElement) watch();
  else document.addEventListener("readystatechange", watch, { once: true });
})()"""

_SETTLE_PROBE = """JSON.stringify({
  ready: document.readyState,
  quiet: window.__delphiSettle ? performance.now() - window.__delphiSettle.last : 0,
})"""

# Article-like text: not the page's scripts, styles or chrome. `textContent`
# counted inline script, so a shell carrying a config blob, or a served header
# and footer, looked built while its article was still on the way.
_ARTICLE_TEXT = """(() => {
  if (!document.body) return 0;
  const skip = "script,style,noscript,template,nav,header,footer,aside";
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement && node.parentElement.closest(skip)
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let length = 0;
  for (let node; (node = walker.nextNode());) length += node.data.trim().length;
  return length;
})()"""


# What a page shows of itself in the box it scrolls in: the document, or the
# element that overflows furthest (Notion scrolls `.notion-scroller`, not the
# page). In that box's own coordinates: how tall it says it is, where its view
# ends, where the last text or media drawn in it ends, and how much is drawn.
_WINDOW_PROBE = """(() => {
  const page = document.scrollingElement || document.documentElement;
  let box = page, most = page.scrollHeight - page.clientHeight;
  for (const node of document.body ? document.body.querySelectorAll("*") : []) {
    const overflow = node.scrollHeight - node.clientHeight;
    if (overflow > most && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) { box = node; most = overflow; }
  }
  const outer = box === page;
  const origin = outer ? -window.scrollY : box.getBoundingClientRect().top + box.clientTop - box.scrollTop;
  let bottom = 0, drawn = 0;
  const reach = rect => { if (rect.width && rect.height) { drawn += 1; bottom = Math.max(bottom, rect.bottom - origin); } };
  const root = outer ? document.body : box;
  if (root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node; (node = walker.nextNode());) {
      if (!node.data.trim()) continue;
      range.selectNodeContents(node);
      reach(range.getBoundingClientRect());
    }
    for (const media of root.querySelectorAll("img,video,canvas,svg,iframe")) reach(media.getBoundingClientRect());
  }
  return JSON.stringify({
    scrollHeight: box.scrollHeight, visibleBottom: box.scrollTop + box.clientHeight,
    contentBottom: Math.round(bottom), drawn,
  });
})()"""


def _windowed(shown: dict) -> bool:
    """Whether a page is holding back the part of itself out of view.

    Windowed is drawn content that runs to the bottom of the view with at least
    `RENDER_WINDOW_BLANK_PX` of reserved blank below it. An ordinary article is
    drawn to its end, and a page whose content stops inside the view has nothing
    held back: either way it is read as it stands.
    """
    return (
        shown["scrollHeight"] - shown["visibleBottom"] > _WINDOW_SLACK_PX
        and shown["contentBottom"] >= shown["visibleBottom"] - _WINDOW_SLACK_PX
        and shown["scrollHeight"] - shown["contentBottom"] >= RENDER_WINDOW_BLANK_PX
    )


def _fitted_window(shown: dict, height: int) -> int | None:
    """A shorter window that still holds everything drawn, when it is worth one.

    The copy keeps whatever height its scripts wrote from the window — Notion
    sizes its frame to it — so a window left far past the content would be
    saved as that much blank page.
    """
    fit = max(RENDER_VIEWPORT_HEIGHT, height + shown["contentBottom"] - shown["visibleBottom"] + _WINDOW_SLACK_PX)
    return fit if fit < height - RENDER_WINDOW_BLANK_PX else None


def _uncover_windowed(
    probe: Callable[[], dict], resize: Callable[[int], None], settle: Callable[[], bool]
) -> int:
    """Show a windowed page a window it fits in, and return its height.

    `RENDER_VIEWPORT_HEIGHT` for every page that is not windowed, which is never
    resized. A windowed one is shown the tallest window at once, rather than
    grown in steps: its reserved space is an estimate, and pages estimate low
    (Notion's 23k px held 63k of blocks), so each step drew more and found more
    below it, and every step is a settle the reader waits through on the add.
    The window is then fitted back to what was drawn.

    A taller window that drew nothing more is undone, so a page that sizes
    itself to the window, and looks windowed only because it grew blank with
    it, is read at the height it was built at; so is a fitting that cut the
    content short. `settle` is False once the time is spent, and what is drawn
    then is kept.
    """
    shown = probe()
    if not _windowed(shown):
        return RENDER_VIEWPORT_HEIGHT
    resize(RENDER_MAX_HEIGHT)
    settled = settle()
    seen = probe()
    logger.debug("render window: grown to %dpx, shown %s, then %s", RENDER_MAX_HEIGHT, shown, seen)
    if seen["drawn"] <= shown["drawn"]:
        resize(RENDER_VIEWPORT_HEIGHT)
        settle()
        return RENDER_VIEWPORT_HEIGHT
    fitted = _fitted_window(seen, RENDER_MAX_HEIGHT) if settled else None
    if not fitted:
        return RENDER_MAX_HEIGHT
    resize(fitted)
    settle()
    after = probe()
    logger.debug("render window: fitted to %dpx, shown %s", fitted, after)
    # A windowed page unmounts from the end the window left, which moves the
    # bottom of what is drawn. A few text nodes fewer is the page's own
    # window-sized chrome: Notion's fitted copy had 11 of 20,051 fewer.
    if (after["contentBottom"] >= seen["contentBottom"] - _WINDOW_SLACK_PX
            and after["drawn"] >= seen["drawn"] * 0.99):
        return fitted
    resize(RENDER_MAX_HEIGHT)
    settle()
    return RENDER_MAX_HEIGHT


def _render_verdict(
    ready: str, quiet_ms: float, request_ages: list[float], article_chars: Callable[[], int]
) -> str | None:
    """Whether a rendering page is done: "built", "idle", or None to keep waiting.

    Built is article-like text that has stopped changing for
    `RENDER_SETTLE_SECONDS`; idle is nothing changing for `RENDER_IDLE_SECONDS`
    — a challenge or empty page, read as it stands. Neither while the document
    is still loading, or while one of the page's own requests younger than
    `RENDER_REQUEST_PATIENCE_SECONDS` is pending: that is its data on the way —
    unless its article has already stood unchanged for `RENDER_IDLE_SECONDS`.
    Notion's analytics start a request every second or so for as long as the
    page is open, so one was always young, and its book, unchanged for twelve
    seconds, was read at the deadline without being measured for its window.
    `article_chars` walks the page, so it is asked last, and only then.
    """
    from .web_extract import PROSE_MIN_CHARS

    if ready == "loading":
        return None
    if any(age < RENDER_REQUEST_PATIENCE_SECONDS for age in request_ages):
        if quiet_ms >= RENDER_IDLE_SECONDS * 1000 and article_chars() >= PROSE_MIN_CHARS:
            return "built"
        return None
    if quiet_ms >= RENDER_IDLE_SECONDS * 1000:
        return "idle"
    if quiet_ms >= RENDER_SETTLE_SECONDS * 1000 and article_chars() >= PROSE_MIN_CHARS:
        return "built"
    return None


def _wait_for_devtools(process: subprocess.Popen, profile: Path) -> tuple[str, str]:
    """Bound browser startup separately from navigation and page settlement."""
    announced = profile / "DevToolsActivePort"
    deadline = time.monotonic() + RENDER_STARTUP_SECONDS
    while not (announced.is_file() and len(announced.read_text().split()) >= 2):
        if process.poll() is not None:
            raise RuntimeError(f"chromium exited {process.returncode} before DevTools")
        if time.monotonic() > deadline:
            raise TimeoutError("no DevTools port")
        time.sleep(0.02)
    port, path = announced.read_text().split()[:2]
    return port, path


def _read_document(
    process: subprocess.Popen, profile: Path, url: str, budget_seconds: float, *,
    source_only: bool = False, whole: bool = True,
) -> str | None:
    """Read the main document response or wait for its rendered DOM.

    Built means article-like text (`_ARTICLE_TEXT`) that has stopped changing
    for `RENDER_SETTLE_SECONDS`, with none of the page's own recent requests
    still pending (`RENDER_REQUEST_PATIENCE_SECONDS`). A page that never stops —
    a ticker, a feed — is read at the deadline as it stands, which is what
    `--dump-dom` also did.
    """
    started = time.monotonic()
    from websockets.sync.client import connect

    logger.debug("render timing: client imported after %.3fs", time.monotonic() - started)
    # Starting Chromium is not the page's time: a cold start builds font and
    # profile caches, and took fourteen seconds on a CI runner. It has its own
    # allowance, as it did under `--dump-dom`, and the page's budget begins
    # once the browser can be spoken to.
    port, path = _wait_for_devtools(process, profile)
    deadline = time.monotonic() + budget_seconds
    logger.debug("render timing: DevTools ready after %.3fs", time.monotonic() - started)

    with contextlib.ExitStack() as cleanup:
        cleanup.callback(lambda: logger.debug("render timing: DevTools closed after %.3fs", time.monotonic() - started))
        browser = cleanup.enter_context(connect(f"ws://127.0.0.1:{port}{path}", max_size=None, open_timeout=5))
        logger.debug("render timing: DevTools connected after %.3fs", time.monotonic() - started)
        return _drive_document(browser, "", url, deadline, source_only=source_only, started=started, whole=whole)


def _drive_document(
    socket: Any, page_session: str | None, url: str, deadline: float, *,
    source_only: bool, started: float, whole: bool = True,
) -> str | None:
    """Load `url` in one page and read it, over any DevTools connection.

    `page_session` is the flattened session of the page on a browser-level
    connection, found here when it is `""`; None means `socket` already speaks
    as the page, as a browser host's does.
    """
    sequence = iter(range(1, 1 << 30))
    # A script's requests still in flight, by id, with when each began.
    requests: dict[str, float] = {}
    documents: dict[str, dict] = {}
    finished: set[str] = set()
    # Calls sent without waiting, by id, with what to do with each answer.
    answers: dict[int, Callable[[dict], None]] = {}
    # Responses that may be kept for the next render (`render_cache`), by
    # request id, with the bytes received so far: what outgrows an entry is
    # never asked for, since its body could outgrow the host's line.
    keepable: dict[str, tuple[str, int, dict]] = {}
    received: dict[str, int] = {}
    site = urllib.parse.urlparse(url).hostname or ""

    def send(method: str, params: dict, session: str | None, then: Callable[[dict], None] | None = None) -> int:
        number = next(sequence)
        message: dict[str, Any] = {"id": number, "method": method, "params": params}
        if session:
            message["sessionId"] = session
        if then:
            answers[number] = then
        socket.send(json.dumps(message))
        return number

    def kept(address: str, status: int, headers: dict) -> Callable[[dict], None]:
        def keep(reply: dict) -> None:
            body = reply.get("result")
            if body and body.get("base64Encoded"):
                RESPONSES.put((site, address), status, headers, base64.b64decode(body["body"]))
            elif body:
                RESPONSES.put((site, address), status, as_text(headers), body["body"].encode())
        return keep

    def sent_on(request_id: str) -> Callable[[dict], None]:
        # A fulfil the browser refused still leaves the request paused.
        return lambda reply: "error" in reply and send("Fetch.continueRequest", {"requestId": request_id}, session)

    def observe(event: dict) -> None:
        method, params = event.get("method"), event.get("params") or {}
        if method == "Fetch.requestPaused":
            # Answered from an earlier render when its publisher allows it,
            # sent on otherwise; never waited on, so the page is not either.
            request = params["request"]
            held = RESPONSES.get((site, request["url"])) if request.get("method") == "GET" else None
            if held:
                send("Fetch.fulfillRequest", {
                    "requestId": params["requestId"], "responseCode": 200, "responseHeaders": held[0],
                    "body": base64.b64encode(held[1]).decode(),
                }, session, sent_on(params["requestId"]))
            else:
                send("Fetch.continueRequest", {"requestId": params["requestId"]}, session)
        elif method == "Network.requestWillBeSent" and params.get("type") in ("Fetch", "XHR"):
            requests[params["requestId"]] = time.monotonic()
        elif method in ("Network.loadingFinished", "Network.loadingFailed"):
            requests.pop(params.get("requestId"), None)
            if source_only and method == "Network.loadingFinished":
                finished.add(params["requestId"])
            response = keepable.pop(params.get("requestId"), None)
            size = received.pop(params.get("requestId"), 0)
            if response and method == "Network.loadingFinished" and size <= MAX_ENTRY_BYTES:
                send("Network.getResponseBody", {"requestId": params["requestId"]}, session, kept(*response))
        elif method == "Network.dataReceived" and params.get("requestId") in keepable:
            received[params["requestId"]] = received.get(params["requestId"], 0) + int(params.get("dataLength") or 0)
        elif method == "Network.responseReceived":
            response = params.get("response") or {}
            if source_only and params.get("type") == "Document":
                documents[params["requestId"]] = params
            # From the network only: a service worker's answer is the page's
            # own word for that address, and a cache's is already kept.
            elif (not source_only and params.get("type") in RESOURCE_TYPES
                    and not response.get("fromServiceWorker") and not response.get("fromDiskCache")
                    and (site, response.get("url")) not in RESPONSES
                    and is_immutable(response.get("status", 0), response.get("headers") or {})):
                keepable[params["requestId"]] = (response["url"], response["status"], response["headers"])

    def dispatch(message: dict) -> None:
        if "method" in message:
            observe(message)
        elif message.get("id") in answers:
            answers.pop(message["id"])(message)

    def call(method: str, params: dict | None = None, session: str | None = None) -> dict:
        number = send(method, params or {}, session)
        while True:
            reply = json.loads(socket.recv(timeout=max(1.0, deadline - time.monotonic() + 5)))
            if reply.get("id") != number:
                dispatch(reply)
                continue
            if "error" in reply:
                raise RuntimeError(f"{method}: {reply['error'].get('message')}")
            return reply["result"]

    def pump(seconds: float) -> None:
        """Wait, answering the page's paused requests as they come."""
        until = time.monotonic() + seconds
        while (left := until - time.monotonic()) > 0:
            try:
                message = socket.recv(timeout=left)
            except TimeoutError:
                return
            dispatch(json.loads(message))

    session = page_session
    if session == "":
        page = next(
            target for target in call("Target.getTargets")["targetInfos"]
            if target["type"] == "page"
        )
        session = call(
            "Target.attachToTarget", {"targetId": page["targetId"], "flatten": True}
        )["sessionId"]
    call("Page.enable", session=session)
    call("Network.enable", session=session)
    if not source_only:
        call("Page.addScriptToEvaluateOnNewDocument", {"source": _SETTLE_OBSERVER}, session=session)
        call("Fetch.enable", {"patterns": [{"resourceType": kind} for kind in RESOURCE_TYPES]}, session=session)
    else:
        call("Emulation.setScriptExecutionDisabled", {"value": True}, session=session)
    navigation = call("Page.navigate", {"url": url}, session=session)

    def evaluate(expression: str) -> Any:
        return call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True},
            session=session,
        )["result"].get("value")

    if source_only:
        # Live reading needs the original response and its boot scripts,
        # not a DOM whose event listeners died with this browser process.
        # Read as soon as the document arrives, before media/animation can
        # hold a snapshot's settling budget open. The same public-only
        # transport and response checks apply; this is not a challenge solver.
        while time.monotonic() < deadline:
            call("Page.getFrameTree", session=session)  # drains events without running page code
            for request_id, document in documents.items():
                if document.get("frameId") != navigation.get("frameId") or request_id not in finished:
                    continue
                response = document["response"]
                if not 200 <= response["status"] < 300 or response.get("mimeType") not in {"text/html", "application/xhtml+xml"}:
                    return None
                body = call("Network.getResponseBody", {"requestId": request_id}, session=session)
                return (base64.b64decode(body["body"]).decode("utf-8", errors="replace")
                        if body.get("base64Encoded") else body["body"])
            time.sleep(0.05)
        return None

    def settle() -> str | None:
        while time.monotonic() < deadline:
            pump(0.2)
            try:
                state = json.loads(evaluate(_SETTLE_PROBE))
            except BrowserHostError:
                raise  # the page is gone, not between documents
            except Exception:
                continue  # between documents: a redirect or a script navigation
            now = time.monotonic()
            verdict = _render_verdict(
                state["ready"], state["quiet"], [now - began for began in requests.values()],
                lambda: evaluate(_ARTICLE_TEXT) or 0,
            )
            logger.debug(
                "render settle: %.1fs to deadline, ready=%s quiet=%dms pending=%d verdict=%s",
                deadline - now, state["ready"], state["quiet"], len(requests), verdict,
            )
            if verdict:
                return verdict
        return None

    settle()
    partial = False
    if not whole:
        # Asked, not acted on: the window is left as it was built, and the
        # copy says it holds only that much. Asked of a page read at the
        # deadline too: one that never settled still draws its first window,
        # and saved as whole it would never be read again.
        try:
            partial = _windowed(json.loads(evaluate(_WINDOW_PROBE)))
        except BrowserHostError:
            raise
        except Exception as exc:  # a page that navigated away: read what is there
            logger.info("render: %s could not be measured — %s: %s", url, type(exc).__name__, exc)
        if partial:
            logger.info("render: %s is windowed; read at its first window", url)
    else:
        # Whatever the settle said, as on the add: a page read at the deadline
        # still draws its first window. A challenge or empty page draws
        # nothing held back, and one that never stopped changing is measured
        # once and read as it stands.
        deadline = time.monotonic() + RENDER_GROW_SECONDS

        def resize(height: int) -> None:
            call("Emulation.setDeviceMetricsOverride", {
                "width": RENDER_VIEWPORT_WIDTH, "height": height, "deviceScaleFactor": 1, "mobile": False,
            }, session=session)
            # What the new window draws is waited for from now, not from the
            # last change before it.
            evaluate("window.__delphiSettle && (window.__delphiSettle.last = performance.now())")

        try:
            height = _uncover_windowed(
                lambda: json.loads(evaluate(_WINDOW_PROBE)), resize, lambda: settle() is not None,
            )
        except BrowserHostError:
            raise
        except Exception as exc:  # a page that navigated away mid-round: read what is there
            logger.info("render: %s could not be grown past its window — %s: %s", url, type(exc).__name__, exc)
        else:
            if height != RENDER_VIEWPORT_HEIGHT:
                logger.info("render: %s is windowed; read in a %dpx window", url, height)
    # `outerHTML` stops at <html> and drops the doctype, and a document
    # without one is laid out in quirks mode: there `height:100%` under an
    # auto-height parent resolves against the viewport, so pi.website's
    # not-yet-loaded videos framed at 800px each and the page grew by a
    # fifth. Carry the page's own doctype, or none if it had none.
    html = evaluate(
        "(document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '')"
        " + document.documentElement.outerHTML"
    )
    logger.debug("render timing: DOM captured after %.3fs", time.monotonic() - started)
    if partial and html:
        html = _HTML_TAG.sub(f'<html {RENDER_PARTIAL_ATTRIBUTE}=""', html, count=1)
    return html


#: What `--virtual-time-budget=5000` gives a launched Chrome before its
#: `--screenshot`: after the load event, at most this long for the requests a
#: page starts late (a web font, a lazy image) before it is photographed.
CAPTURE_SETTLE_SECONDS = 5.0

#: Quiet after load this long counts as finished: nothing more is coming.
CAPTURE_QUIET_SECONDS = 0.5


def screenshot_with_host(
    host: BrowserHost, target: str, output: Path, *, proxy: str,
    width: int, height: int, budget_seconds: float,
) -> str:
    """Photograph `target` in the product's browser into `output`; "" or why not.

    The host's counterpart of a `--screenshot` run with the same flags: the
    viewport at scale 1, scrollbars hidden, the render User-Agent, and every
    request through the caller's validating proxy. A prepared document is
    loaded from its `file://` path exactly as Chrome loads it, its handlers
    running as they do there: `<noscript>` fallbacks and `onload` stylesheets
    draw as the page drew. The host refuses it every other file.
    """
    deadline = time.monotonic() + budget_seconds
    with HostPage(
        host, "page", timeout=RENDER_STARTUP_SECONDS, proxy=proxy, width=width, height=height,
        userAgent=RENDER_USER_AGENT, deadlineSeconds=budget_seconds + 10,
    ) as page:
        sequence = iter(range(1, 1 << 30))
        pending: set[str] = set()
        state = {"loaded": 0.0, "quiet": time.monotonic()}

        def observe(event: dict) -> None:
            method, params = event.get("method"), event.get("params") or {}
            if method == "Page.loadEventFired":
                state["loaded"] = time.monotonic()
            elif method == "Network.requestWillBeSent":
                pending.add(params.get("requestId", ""))
            elif method in ("Network.loadingFinished", "Network.loadingFailed"):
                pending.discard(params.get("requestId", ""))
                state["quiet"] = time.monotonic()

        def call(method: str, params: dict | None = None) -> dict:
            number = next(sequence)
            page.send(json.dumps({"id": number, "method": method, "params": params or {}}))
            while True:
                reply = json.loads(page.recv(timeout=max(1.0, deadline - time.monotonic() + 5)))
                if "method" in reply:
                    observe(reply)
                elif reply.get("id") == number:
                    if "error" in reply:
                        raise RuntimeError(f"{method}: {reply['error'].get('message')}")
                    return reply["result"]

        def drain(seconds: float) -> None:
            # Events arrive only while a reply is awaited; a cheap command
            # collects them without running anything in the page.
            time.sleep(seconds)
            call("Page.getFrameTree")

        call("Page.enable")
        call("Network.enable")
        call("Emulation.setScrollbarsHidden", {"hidden": True})
        call("Page.navigate", {"url": target})
        while not state["loaded"] and time.monotonic() < deadline:
            drain(0.1)
        if not state["loaded"]:
            return f"still loading at the {budget_seconds:g}s ceiling"
        settle_until = min(deadline, state["loaded"] + CAPTURE_SETTLE_SECONDS)
        while time.monotonic() < settle_until:
            if not pending and time.monotonic() - state["quiet"] >= CAPTURE_QUIET_SECONDS:
                break
            drain(0.1)
        shot = call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
        output.write_bytes(base64.b64decode(shot["data"], validate=True))
    return ""
