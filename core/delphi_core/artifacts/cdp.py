"""Small request/event transport for our disposable Chromium process only."""
from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

import websockets

from ..browser_host import BrowserHostError


class CDPCommandError(RuntimeError):
    """An authoritative protocol error, distinct from authored JS exceptions."""


class CDP:
    """Over a browser's DevTools WebSocket at `url`, or over an open `page`
    that already speaks as one page (`browser_host.AsyncHostPage`)."""

    def __init__(self, url: str = "", page: Any = None):
        self.url = url
        self.events: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=4096)
        self.pending: dict[int, asyncio.Future] = {}
        self.sequence = 0
        self.socket = page
        self.reader = None

    async def __aenter__(self):
        if self.socket is None:
            self.socket = await websockets.connect(self.url, max_size=8 * 1024 * 1024, open_timeout=3, close_timeout=1)
        self.reader = asyncio.create_task(self._read())
        return self

    async def __aexit__(self, *exc):
        if self.reader:
            self.reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.reader
        if self.socket:
            await self.socket.close()

    async def _read(self):
        try:
            async for raw in self.socket:
                message = json.loads(raw)
                if "id" in message:
                    future = self.pending.get(message["id"])
                    if future and not future.done():
                        if "error" in message:
                            future.set_exception(CDPCommandError(str(message["error"].get("message", "CDP command failed"))[:400]))
                        else:
                            future.set_result(message.get("result", {}))
                else:
                    self.events.put_nowait(message)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(RuntimeError(f"Renderer connection ended: {type(error).__name__}"
                                                      + (f": {error}" if isinstance(error, BrowserHostError) else "")))

    async def call(self, method: str, params: dict | None = None, session: str | None = None, timeout: float = 5) -> dict:
        self.sequence += 1
        identifier = self.sequence
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        message: dict[str, Any] = {"id": identifier, "method": method, "params": params or {}}
        if session:
            message["sessionId"] = session
        try:
            await self.socket.send(json.dumps(message))
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(identifier, None)

    async def evaluate(self, expression: str, session: str, context: int | None = None, timeout: float = 5) -> Any:
        params: dict[str, Any] = {"expression": expression, "returnByValue": True, "awaitPromise": True}
        if context is not None:
            params["contextId"] = context
        result = await self.call("Runtime.evaluate", params, session, timeout)
        if result.get("exceptionDetails"):
            detail = result["exceptionDetails"]
            raise RuntimeError(str((detail.get("exception") or {}).get("description") or detail.get("text") or "Script failed")[:400])
        return result.get("result", {}).get("value")
