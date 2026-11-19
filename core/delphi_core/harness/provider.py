"""
The one client every model call goes through, and the one SSE parser.

There were three hand-written parsers of the Responses stream (chat, the
digest, the desktop relay) and three non-streaming callers, and each had its
own idea of when a response was finished. A response is finished when the
provider says so and not otherwise: `Terminal` is how every caller is told
which of the four ways a response ended, and what it does about each is the
caller's to decide in the open rather than by not looking.

`stream()` yields, in order of arrival:

    opened            the first frame arrived, whatever it was
    text_delta        answer text
    reasoning_delta   reasoning summary text
    reasoning_break   one summary part ended
    item_added        an output item began (a call is under way)
    call_completed    a hosted call finished
    item_done         an output item, whole
    terminal          exactly once, last, carrying a `ProviderResult`

`complete()` is the same request without streaming and returns the same
`ProviderResult`. A refused request (HTTP 4xx/5xx) raises
`httpx.HTTPStatusError` from both, with the provider's error body read.

A request is sent again once, and only while nothing of its response has
reached the caller: on a rate limit (429), a provider fault (5xx), or a stream
that closed before its first frame. Never after the first delivered event, and
never with a limit removed. A caller that waits out a busy provider itself,
and tells its reader so, asks for no retry here (`retry=False`).

A caller whose output is an artifact (a digest, a filed page, a title) passes
its result through `require_completed`: anything but a completed response is
an error there, so a cut-off response is never stored as a finished one.
"""

from __future__ import annotations

import asyncio
import enum
import json
from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass, field
from typing import Any

from urllib.parse import urlsplit

import httpx

from ..config import Settings


class Terminal(enum.Enum):
    """How a response ended."""

    COMPLETED = "completed"
    #: The provider stopped early and said why: the output ceiling, a filter.
    INCOMPLETE = "incomplete"
    FAILED = "failed"
    #: The stream closed with no terminal event. Never inferred to be complete.
    ENDED = "ended"


@dataclass(frozen=True)
class Usage:
    """What one response cost, in the provider's token counts."""

    input_tokens: int = 0
    cached_tokens: int = 0
    cache_write_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0

    @classmethod
    def from_provider(cls, usage: dict[str, Any] | None) -> "Usage":
        usage = usage or {}
        read = usage.get("input_tokens_details") or {}
        written = usage.get("output_tokens_details") or {}
        return cls(
            input_tokens=int(usage.get("input_tokens") or 0),
            cached_tokens=int(read.get("cached_tokens") or 0),
            cache_write_tokens=int(read.get("cache_write_tokens") or 0),
            output_tokens=int(usage.get("output_tokens") or 0),
            reasoning_tokens=int(written.get("reasoning_tokens") or 0),
        )

    def __add__(self, other: "Usage") -> "Usage":
        return Usage(
            self.input_tokens + other.input_tokens,
            self.cached_tokens + other.cached_tokens,
            self.cache_write_tokens + other.cache_write_tokens,
            self.output_tokens + other.output_tokens,
            self.reasoning_tokens + other.reasoning_tokens,
        )


@dataclass
class ProviderResult:
    """One response, however it ended."""

    terminal: Terminal
    #: `incomplete_details.reason`, or the failure's message.
    reason: str | None = None
    #: Every output item, in order, as the provider sent it.
    output: list[dict[str, Any]] = field(default_factory=list)
    usage: Usage = Usage()
    #: The provider's own usage object, for callers that log it as sent.
    raw_usage: dict[str, Any] = field(default_factory=dict)
    #: The queue the provider says it ran on, when it says.
    service_tier: str = ""
    #: The provider's `status` word, kept for logs.
    status: str | None = None
    #: Requests made before this response, for a call that retried.
    attempts: int = 1

    def texts(self) -> list[str]:
        """Each `output_text` block, in order."""
        return [
            block.get("text") or ""
            for item in self.output
            for block in item.get("content") or ()
            if block.get("type") == "output_text"
        ]


#: What an answer keeps of the web pages it cites. An answer cites a handful;
#: the bounds are for a response that does something else.
SOURCES_MAX = 40
SOURCE_URL_MAX_CHARS = 2_048
SOURCE_TITLE_MAX_CHARS = 200


def cited_sources(
    output: list[dict[str, Any]], known: list[dict[str, str]] | None = None
) -> list[dict[str, str]]:
    """
    The web pages a response's messages cite: in order, each address once.

    Read from the `url_citation` annotations the provider attaches to answer
    text. Their positions are not kept: the provider also writes each citation
    into the text as a link, and a link is matched to its source by address
    (ARCHITECTURE.md, "What the provider does, measured"). `known` is what
    earlier rounds of the same turn already cited; the result continues it.

    Only `http` and `https` addresses are sources. An answer's sources are
    rendered as links, and nothing else is a place a reader should be sent.
    """
    sources = list(known or ())
    seen = {source["url"] for source in sources}
    for item in output:
        if item.get("type") != "message":
            continue
        for part in item.get("content") or ():
            for note in part.get("annotations") or ():
                if len(sources) >= SOURCES_MAX:
                    return sources
                url = note.get("url") if note.get("type") == "url_citation" else None
                if not isinstance(url, str) or url in seen or len(url) > SOURCE_URL_MAX_CHARS:
                    continue
                parts = urlsplit(url)
                if parts.scheme not in {"http", "https"} or not parts.hostname or url != url.strip():
                    continue
                title = " ".join(str(note.get("title") or "").split())[:SOURCE_TITLE_MAX_CHARS]
                seen.add(url)
                sources.append({"url": url, "title": title or parts.hostname})
    return sources


class ProviderError(RuntimeError):
    """A response that did not complete, and how it ended."""

    def __init__(self, message: str, terminal: Terminal, reason: str | None = None) -> None:
        super().__init__(message)
        self.terminal = terminal
        self.reason = reason


def require_completed(result: ProviderResult, what: str) -> ProviderResult:
    """The result, or an error saying how `what` fell short of finishing."""
    if result.terminal is Terminal.COMPLETED:
        return result
    if result.terminal is Terminal.INCOMPLETE:
        message = f"{what} was cut off before it finished ({result.reason or 'no reason given'})"
    elif result.terminal is Terminal.FAILED:
        message = result.reason or f"{what} failed"
    else:
        message = f"{what} ended before the provider said it was finished"
    raise ProviderError(message, result.terminal, result.reason)


def _retryable(status_code: int) -> bool:
    return status_code == 429 or status_code >= 500


def _retry_delay(response: httpx.Response) -> float:
    """How long the provider asked us to wait, kept within a quarter second and fifteen."""
    raw = response.headers.get("retry-after")
    try:
        delay = float(raw) if raw is not None else 1.0
    except ValueError:
        delay = 1.0
    return min(15.0, max(0.25, delay))


def _terminal_of(status: str | None) -> Terminal:
    return {
        "completed": Terminal.COMPLETED,
        "incomplete": Terminal.INCOMPLETE,
        "failed": Terminal.FAILED,
    }.get(status or "", Terminal.ENDED)


def _result(response: dict[str, Any], terminal: Terminal, output: list[dict[str, Any]]) -> ProviderResult:
    reason = (response.get("incomplete_details") or {}).get("reason")
    if terminal is Terminal.FAILED:
        reason = (response.get("error") or {}).get("message") or reason
    usage = response.get("usage") or {}
    return ProviderResult(
        terminal=terminal,
        reason=reason,
        output=output,
        usage=Usage.from_provider(usage),
        raw_usage=usage,
        service_tier=response.get("service_tier") or "",
        status=response.get("status"),
    )


async def parse_stream(lines: AsyncIterator[str]) -> AsyncIterator[dict[str, Any]]:
    """The Responses SSE stream as the events above. Pure: no I/O of its own."""
    output: list[dict[str, Any]] = []
    event_name = ""
    opened = False
    async for line in lines:
        if line.startswith("event:"):
            event_name = line[6:].strip()
            continue
        if not line.startswith("data:"):
            continue
        raw = line[5:].strip()
        if not raw or raw == "[DONE]":
            continue
        if not opened:
            opened = True
            yield {"type": "opened"}
        event = json.loads(raw)
        kind = event.get("type") or event_name
        event_name = ""
        if kind == "response.output_text.delta":
            if event.get("delta"):
                yield {"type": "text_delta", "text": event["delta"]}
        elif kind == "response.reasoning_summary_text.delta":
            if event.get("delta"):
                yield {"type": "reasoning_delta", "text": event["delta"]}
        elif kind == "response.reasoning_summary_part.done":
            yield {"type": "reasoning_break"}
        elif kind == "response.output_item.added":
            yield {"type": "item_added", "item": event.get("item") or {}}
        elif kind == "response.output_item.done":
            item = event.get("item") or {}
            output.append(item)
            yield {"type": "item_done", "item": item}
        elif kind.endswith("_call.completed"):
            yield {"type": "call_completed"}
        elif kind in {"error", "response.failed"}:
            error = event.get("error") or (event.get("response") or {}).get("error") or {}
            result = _result(event.get("response") or {}, Terminal.FAILED, output)
            result.reason = error.get("message") or result.reason
            yield {"type": "terminal", "result": result}
            return
        elif kind in {"response.completed", "response.incomplete"}:
            terminal = Terminal.COMPLETED if kind == "response.completed" else Terminal.INCOMPLETE
            yield {"type": "terminal", "result": _result(event.get("response") or {}, terminal, output)}
            return
    yield {"type": "terminal", "result": ProviderResult(Terminal.ENDED, output=output)}


class ResponsesClient:
    """The Responses API over a caller's `httpx.AsyncClient`."""

    def __init__(self, http: httpx.AsyncClient, settings: Settings) -> None:
        self._http = http
        self._url = f"{settings.api_base_url.rstrip('/')}/responses"
        self._headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.api_key}",
        }

    async def stream(
        self, payload: dict[str, Any], *, retry: bool = True
    ) -> AsyncIterator[dict[str, Any]]:
        for attempt in (1, 2) if retry else (2,):
            again: float | None = None
            delivered = False
            async with self._http.stream(
                "POST", self._url, headers=self._headers, json=payload
            ) as response:
                if response.status_code >= 400:
                    # Read the body before raising: an unread streaming response
                    # gives an error with no detail from the provider in it.
                    await response.aread()
                    if attempt == 2 or not _retryable(response.status_code):
                        response.raise_for_status()
                    again = _retry_delay(response)
                else:
                    async with aclosing(parse_stream(response.aiter_lines())) as events:
                        async for event in events:
                            if (
                                attempt == 1
                                and not delivered
                                and event["type"] == "terminal"
                                and event["result"].terminal is Terminal.ENDED
                            ):
                                # Closed before its first frame: nothing has
                                # been said, so asking again repeats nothing.
                                again = 0.0
                                break
                            delivered = True
                            yield event
            if again is None:
                return
            await asyncio.sleep(again)

    async def complete(self, payload: dict[str, Any], *, attempts: int = 2) -> ProviderResult:
        """
        One request, answered whole.

        `attempts` is how many times a rate-limited or faulted request is sent
        in all, waiting as long as the provider asks between them.
        """
        attempts = max(1, attempts)
        response: httpx.Response | None = None
        made = 0
        while made < attempts:
            made += 1
            response = await self._http.post(self._url, headers=self._headers, json=payload)
            if made == attempts or not _retryable(response.status_code):
                break
            await asyncio.sleep(_retry_delay(response))
        assert response is not None
        response.raise_for_status()
        body = response.json()
        result = _result(body, _terminal_of(body.get("status")), list(body.get("output") or ()))
        result.attempts = made
        return result
