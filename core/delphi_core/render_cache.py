"""Responses a render may reuse from an earlier one: those their publisher calls immutable.

Every render starts in an empty browser (a launched Chrome's throwaway profile,
a host page whose session is cleared before its slot is reused), so a page
split into hundreds of script chunks fetched all of them every time. One public
Notion page is 721 chunks. Adding one and then capturing it whole asked
notion.site for them twice within a minute. After that its Cloudflare answered
every request from the machine with a 429 challenge for minutes, the next add's
plain fetch included.

A real browser asks once, because the chunks say
`Cache-Control: public, max-age=31536000, immutable`. This keeps what that
header allows for the life of the process, and nothing else: a GET answered
200 by the network, not private, with a positive max-age and `immutable`,
varying on nothing but its encoding. It holds the decoded body, so it drops
the response's encoding and length (a text body is held as UTF-8 and says
so), and it drops `Set-Cookie`, which belonged to the one exchange that
carried it.

Kept per site, as Chromium partitions its own cache: an entry is answered
only to a render of the page host that was sent it. A page's service worker
can answer a CDN's address with its own script and call it immutable, so
shared across sites one added page could write itself into every later
render that loads that script. The add and its capture are the same page,
which is the reuse this exists for. Bounded in entries' size and in total,
least recently used first out.
"""

import threading
from collections import OrderedDict

#: The resource types a render's requests are checked against; an API call is
#: never immutable, so pausing it would only slow the page.
RESOURCE_TYPES = ("Script", "Stylesheet", "Font", "Image")
MAX_ENTRY_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 96 * 1024 * 1024
#: What a stored body no longer has, or never shares.
_DROPPED = frozenset((
    "set-cookie", "content-encoding", "content-length", "transfer-encoding",
    "connection", "keep-alive", "age", "date",
))
#: What a response may vary on and still be one answer: its encoding, which
#: the stored body is past.
_ENCODING_ONLY = frozenset(("accept-encoding", "available-dictionary"))


Key = tuple[str, str]  # (the rendered page's host, the resource's URL)


def _header(headers: dict[str, str], name: str) -> str:
    return next((str(value) for key, value in headers.items() if key.lower() == name), "")


def is_immutable(status: int, headers: dict[str, str]) -> bool:
    """Whether a response may be served again, to any page, without asking."""
    if status != 200:
        return False
    directives = {part.strip().split("=", 1)[0].lower(): part.strip() for part in _header(headers, "cache-control").split(",")}
    if "immutable" not in directives or {"no-store", "no-cache", "private"} & directives.keys():
        return False
    try:
        if int(directives.get("max-age", "max-age=0").split("=", 1)[1].strip('"')) <= 0:
            return False
    except (IndexError, ValueError):
        return False
    vary = {part.strip().lower() for part in _header(headers, "vary").split(",") if part.strip()}
    return vary <= _ENCODING_ONLY


def as_text(headers: dict[str, str]) -> dict[str, str]:
    """A text body's headers once it is held as UTF-8: it is decoded from
    whatever it was sent in, so its stated charset no longer describes it."""
    kind = next((key for key in headers if key.lower() == "content-type"), "content-type")
    media = str(headers.get(kind, "")).split(";", 1)[0].strip() or "text/plain"
    return {**headers, kind: f"{media}; charset=utf-8"}


class ImmutableResponses:
    """(site, URL) → the headers and body to fulfil a request with; safe across render threads."""

    def __init__(self, max_entry: int = MAX_ENTRY_BYTES, max_total: int = MAX_TOTAL_BYTES):
        self._entries: OrderedDict[Key, tuple[list[dict[str, str]], bytes]] = OrderedDict()
        self._lock = threading.Lock()
        self._total = 0
        self.max_entry, self.max_total = max_entry, max_total

    def __contains__(self, key: Key) -> bool:
        with self._lock:
            return key in self._entries

    def get(self, key: Key) -> tuple[list[dict[str, str]], bytes] | None:
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                self._entries.move_to_end(key)
            return entry

    def put(self, key: Key, status: int, headers: dict[str, str], body: bytes) -> bool:
        """Keep a response if the rules allow it; whether it was kept."""
        if not is_immutable(status, headers) or len(body) > self.max_entry:
            return False
        # DevTools joins a repeated header's values with a newline, which a
        # fulfilled response may not carry: one header each, as sent.
        kept = [{"name": key_, "value": value} for key_, values in headers.items() if key_.lower() not in _DROPPED
                for value in str(values).split("\n")]
        with self._lock:
            previous = self._entries.pop(key, None)
            if previous is not None:
                self._total -= len(previous[1])
            self._entries[key] = (kept, body)
            self._total += len(body)
            while self._total > self.max_total:
                _, (_, dropped) = self._entries.popitem(last=False)
                self._total -= len(dropped)
        return True

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._total = 0


RESPONSES = ImmutableResponses()
