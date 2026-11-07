"""A browser page a product lends core, instead of a Chrome core starts itself.

Core drives every browser it uses — page capture (`browser_render.render_dom`),
previews (`dashboard._capture_webpage`) and artifact validation
(`artifacts.worker`) — over the DevTools protocol, and by default it launches a
Chrome-compatible executable to have something to drive. A product that
already ships a browser engine can offer one instead: it sets
`BROWSER_HOST_SOCKET` and `BROWSER_HOST_TOKEN`, and core then asks that host
for one disposable page per job and never looks for a browser of its own. The
desktop app answers with a hidden, offscreen window of the Chromium inside
Electron (`desktop/main/browser-host.ts`), so a capture or a draft never opens
the user's Chrome. With the host configured and unreachable, a job fails; it
does not fall back to an installed browser, because that fallback is exactly
the second application the host exists to remove.

The wire is one Unix-domain stream per page, newline-delimited JSON:

    → {"token": …, "open": {"purpose": "page" | "artifact", "width": …, "height": …,
                            "proxy": "127.0.0.1:port", "userAgent": …,
                            "deadlineSeconds": …, "memoryLimitBytes": …}}
    ← {"opened": {"engine": "Chromium/…"}}   or   {"error": "…"}

then DevTools commands and events exactly as a page target speaks them, where
no `sessionId` means the page itself. The host owns the page's lifetime:
closing the stream disposes of it, and the host ends it on its own at its
deadline or memory limit, saying why in a `Host.ended` event first. Network
policy stays here: a `page` job names this process's validating proxy
(`browser_render._public_only_proxy`), and an `artifact` job has none at all.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import socket
import time
from dataclasses import dataclass
from typing import Any

SOCKET_ENV = "BROWSER_HOST_SOCKET"
TOKEN_ENV = "BROWSER_HOST_TOKEN"

#: A screenshot of a tall page, base64-encoded, is the longest line either side
#: writes; the host holds itself to the same ceiling.
MAX_LINE_BYTES = 48 * 1024 * 1024
#: How long one message to the host may take to write, however large.
SEND_TIMEOUT_SECONDS = 30.0

#: The event the host sends once, just before it ends a page on its own.
ENDED = "Host.ended"


class BrowserHostError(RuntimeError):
    """The host refused, ended or lost the page."""


@dataclass(frozen=True)
class BrowserHost:
    socket: str
    token: str

    def as_request(self) -> dict[str, str]:
        """For a child process, which reads it from its request file, not its environment."""
        return {"socket": self.socket, "token": self.token}


def configured(environ: Any = None) -> BrowserHost | None:
    """The product's browser host, or None to launch a browser as before."""
    environ = os.environ if environ is None else environ
    path, token = environ.get(SOCKET_ENV, ""), environ.get(TOKEN_ENV, "")
    return BrowserHost(path, token) if path and token else None


def _opening(host: BrowserHost, purpose: str, options: dict[str, Any]) -> bytes:
    if purpose not in {"page", "artifact"}:
        raise ValueError(f"unknown browser job {purpose!r}")
    if purpose == "page" and not options.get("proxy"):
        # A page job reaches the network only through the validating proxy.
        raise ValueError("a page job needs the validating proxy")
    request = {"purpose": purpose, **{key: value for key, value in options.items() if value is not None}}
    return (json.dumps({"token": host.token, "open": request}) + "\n").encode()


def _opened(line: bytes) -> dict[str, Any]:
    if not line:
        raise BrowserHostError("the browser host closed the page before opening it")
    reply = json.loads(line)
    if "opened" not in reply:
        raise BrowserHostError(str(reply.get("error") or "the browser host refused the page")[:400])
    return reply["opened"]


def ended_message(message: dict[str, Any]) -> str | None:
    """The host's reason, when this frame is its notice that the page is over."""
    if message.get("method") != ENDED:
        return None
    params = message.get("params") or {}
    return str(params.get("message") or params.get("reason") or "the browser host ended the page")[:400]


def _queue_wait(timeout: float, options: dict[str, Any]) -> float:
    """How long to wait for `opened`: as long as the host may queue the job.

    A busy host holds a job for a free page until the job's own deadline and
    answers then either way, so giving up at the connect timeout would turn a
    few captures at once into "no page". A little past it, for the answer.
    """
    return max(timeout, float(options.get("deadlineSeconds") or 0) + 2.0)


class HostPage:
    """One page over a blocking socket, for code that runs in a worker thread.

    `send` and `recv(timeout=)` are the two calls `render_dom` makes of a
    DevTools WebSocket, so the same loop drives a launched Chrome or this.
    """

    def __init__(self, host: BrowserHost, purpose: str, *, timeout: float = 15.0, **options: Any):
        opening = _opening(host, purpose, options)
        self._socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._buffer = b""
        try:
            self._socket.settimeout(timeout)
            self._socket.connect(host.socket)
            self._socket.sendall(opening)
            self.opened = _opened(self._line(time.monotonic() + _queue_wait(timeout, options)))
        except BaseException:
            self._socket.close()
            raise

    def _line(self, deadline: float) -> bytes:
        while b"\n" not in self._buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("the browser host did not answer in time")
            self._socket.settimeout(remaining)
            chunk = self._socket.recv(1 << 20)
            if not chunk:
                return b""
            self._buffer += chunk
            if len(self._buffer) > MAX_LINE_BYTES:
                raise BrowserHostError("the browser host sent an unbounded message")
        line, _, self._buffer = self._buffer.partition(b"\n")
        return line

    def send(self, text: str) -> None:
        # Its own bound, never the last `recv`'s: a render waiting a few
        # milliseconds for an event, then answering a paused request with a
        # script of megabytes, timed out mid-line, and the host ended the page
        # on the half message it got.
        self._socket.settimeout(SEND_TIMEOUT_SECONDS)
        self._socket.sendall(text.encode() + b"\n")

    def recv(self, timeout: float) -> str:
        line = self._line(time.monotonic() + timeout)
        if not line:
            raise BrowserHostError("the browser host closed the page")
        ended = ended_message(json.loads(line))
        if ended:
            raise BrowserHostError(ended)
        return line.decode()

    def close(self) -> None:
        with contextlib.suppress(OSError):
            self._socket.shutdown(socket.SHUT_RDWR)
        self._socket.close()

    def __enter__(self) -> "HostPage":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class AsyncHostPage:
    """The same page for asyncio code: `send`, async iteration and `close`,
    which is all `artifacts.cdp.CDP` asks of its WebSocket."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, opened: dict[str, Any]):
        self._reader, self._writer, self.opened = reader, writer, opened
        self.ended: str | None = None
        self.ended_reason = ""

    @classmethod
    async def open(cls, host: BrowserHost, purpose: str, *, timeout: float = 15.0, **options: Any) -> "AsyncHostPage":
        opening = _opening(host, purpose, options)
        reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(host.socket, limit=MAX_LINE_BYTES), timeout)
        try:
            writer.write(opening)
            await writer.drain()
            opened = _opened(await asyncio.wait_for(reader.readline(), _queue_wait(timeout, options)))
        except BaseException:
            writer.close()
            raise
        return cls(reader, writer, opened)

    async def send(self, text: str) -> None:
        self._writer.write(text.encode() + b"\n")
        await self._writer.drain()

    def __aiter__(self) -> "AsyncHostPage":
        return self

    async def __anext__(self) -> str:
        line = await self._reader.readline()
        if not line:
            # A page that vanishes is a failure for whatever was waiting on it.
            raise BrowserHostError("the browser host closed the page")
        message = json.loads(line)
        ended = ended_message(message)
        if ended:
            # Kept so a caller can say why its page went away, not just that it did.
            self.ended, self.ended_reason = ended, str((message.get("params") or {}).get("reason") or "")
            raise BrowserHostError(ended)
        return line.decode()

    async def close(self) -> None:
        self._writer.close()
        with contextlib.suppress(OSError, ConnectionError):
            await self._writer.wait_closed()
