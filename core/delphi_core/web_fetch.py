"""
The one place Delphi reaches out to a host the user named.

Every other outbound request in this codebase goes to a URL we configured. These
go to whatever someone typed into a box, which makes this the only module where
the network itself is untrusted input: the target can redirect, can be enormous,
can be slow forever, and can resolve to an address inside our own network.
"""

import functools
import ipaddress
import re
import socket
from dataclasses import dataclass
from urllib.parse import urlparse, urlunparse

import anyio
import httpcore
import httpx
from fastapi import HTTPException

from .config import Settings
from .storage import utc_now
from .web_extract import PROSE_MIN_CHARS, extract, is_interstitial, readable_text_length

MAX_REDIRECTS = 5
HTML_TYPES = {"text/html", "application/xhtml+xml", "text/plain"}
PDF_TYPES = {"application/pdf", "application/x-pdf"}
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}
# Memory figures may cite a remote `.svg`; Pillow cannot open those, so the
# capture path stores the markup after `normalize_svg_document` instead.
SVG_TYPES = {"image/svg+xml"}
PDF_URL_DETAIL = {
    "code": "pdf_url",
    "message": "That address points to a PDF.",
}
#: Statuses worth a second attempt rather than a verdict. A cookie challenge
#: answers 403 with a `Set-Cookie` and expects the next request to carry it;
#: 401 and 429 are the other two a real browser routinely gets past.
RETRYABLE_STATUSES = {401, 403, 429}


def describe_failure(status: int, host: str) -> dict[str, str]:
    """Say what went wrong in terms of the site, not the protocol.

    Every 4xx and 5xx used to read "That page returned 403. Some sites refuse
    automated readers." — which named the number and not the cause, and said
    the same thing about a deleted page, a rate limit and a site that was
    simply down. Four buckets is the whole vocabulary: what the reader does
    next differs between them, and nothing finer changes that answer. A 429
    is its own: notion.site answers one to every request from a machine that
    asked too much in a minute, for five to thirty minutes, and then serves
    the same page again, so the answer is to wait, not to find a PDF.

    Deliberately not fingerprinted by vendor. Knowing it is DataDome rather
    than Akamai tells the reader nothing they can act on, and a detector keyed
    to one vendor's headers is a thing that silently stops matching.
    """
    if status == 429:
        return {
            "code": "throttled",
            "message": (
                f"{host} is limiting how often Delphi can read it. "
                "Try again in a few minutes."
            ),
        }
    if status in RETRYABLE_STATUSES:
        return {
            "code": "blocked",
            "message": (
                f"{host} blocks automated readers. "
                "Save the page as a PDF and add that instead."
            ),
        }
    if status == 404:
        return {
            "code": "missing",
            "message": f"{host} has no page at that address.",
        }
    if status >= 500:
        return {
            "code": "unavailable",
            "message": f"{host} is having trouble right now. Try again later.",
        }
    return {
        "code": "unreadable",
        "message": f"{host} would not serve that page to Delphi.",
    }


@dataclass
class FetchedResource:
    url: str
    body: bytes
    content_type: str
    encoding: str
    fetched_at: str
    #: Whether a browser already ran this page's own scripts to produce `body`.
    #: The escalation reads it to know there is no rung left below it, so a
    #: rendered page that still extracts to nothing fails honestly instead of
    #: being rendered a second time to the same end.
    rendered: bool = False


def normalise_url(raw: str) -> str:
    """Accept what someone pastes; reject what we cannot safely fetch."""
    candidate = raw.strip()
    if not candidate:
        raise HTTPException(422, "Enter a web address")
    if "://" not in candidate:
        candidate = f"https://{candidate}"
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(422, "Only http and https addresses can be added")
    if not parsed.hostname:
        raise HTTPException(422, "That web address has no host")
    # Credentials in the URL would be forwarded on every redirect hop and stored
    # in the paper record; drop them rather than carry them around.
    netloc = parsed.hostname + (f":{parsed.port}" if parsed.port else "")
    return urlunparse(parsed._replace(netloc=netloc, fragment=""))


#: NAT64's well-known and local-use prefixes (RFC 6052, RFC 8215): a gateway
#: dials the IPv4 address in the last 32 bits.
_NAT64 = (ipaddress.ip_network("64:ff9b::/96"), ipaddress.ip_network("64:ff9b:1::/48"))


def _embedded_ipv4(address: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """The IPv4 address an IPv6 one carries for a gateway or the kernel to dial."""
    if address.ipv4_mapped is not None:
        return address.ipv4_mapped
    if address.sixtofour is not None:
        return address.sixtofour
    if any(address in network for network in _NAT64):
        return ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
    return None


def is_public_address(value: str) -> bool:
    """Use the same address boundary for direct fetches and pinned browser hops."""
    address = ipaddress.ip_address(value)
    # An embedded IPv4 address is judged itself, not left to `is_global`: Python
    # before 3.12.4 and 3.11.10 calls 6to4 space global whatever it carries, so
    # `2002:7f00:1::1` (loopback) would pass on an unpatched 3.11, which core supports.
    if isinstance(address, ipaddress.IPv6Address):
        embedded = _embedded_ipv4(address)
        if embedded is not None and not is_public_address(str(embedded)):
            return False
    # `not is_private` admits shared CGNAT space; `is_global` alone still
    # admits multicast and deprecated IPv6 site-local space in ipaddress.
    return (
        address.is_global
        and not address.is_reserved
        and not address.is_multicast
        and not getattr(address, "is_site_local", False)
    )


def check_public_host(url: str) -> None:
    """
    Refuse addresses that resolve inside the deployment.

    Delphi runs on Cloud Run next to a metadata server and, locally, next to the
    user's whole LAN. Without this, "add a page" is a request forgery primitive:
    http://169.254.169.254/ hands out service-account tokens.

    A hostile DNS server can answer differently when the connection resolves
    again, so this is the readable refusal, not the boundary: the web client
    dials only addresses it validated itself (`_PublicOnlyBackend`).
    """
    host = urlparse(url).hostname or ""
    try:
        resolved = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise HTTPException(422, f"Could not resolve {host}") from exc
    for entry in resolved:
        if not is_public_address(entry[4][0]):
            raise HTTPException(422, "That address is not reachable from Delphi")


async def read_capped(response: httpx.Response, limit: int) -> bytes:
    """Stop reading at the cap instead of trusting Content-Length."""
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk)
        if len(body) > limit:
            raise HTTPException(
                413, f"That page is larger than {limit // (1024 * 1024)} MB"
            )
    return bytes(body)


class _PublicOnlyBackend(httpcore.AsyncNetworkBackend):
    """
    Resolve once at the connection and dial the address that passed.

    The resolve-then-connect gap `check_public_host` leaves, closed where the
    socket opens, as `browser_render._public_only_proxy` closes it for
    Chromium. TLS still names the host, so SNI and the certificate check are
    unchanged, and a pooled connection keeps the address it was opened to.
    """

    def __init__(self) -> None:
        self._dial = httpcore.AnyIOBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        try:
            resolved = await anyio.to_thread.run_sync(
                functools.partial(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM)
            )
            addresses = list(dict.fromkeys(str(entry[4][0]) for entry in resolved))
            public = bool(addresses) and all(is_public_address(address) for address in addresses)
        except (OSError, ValueError) as exc:
            raise httpcore.ConnectError(f"Could not resolve {host}") from exc
        if not public:
            raise httpcore.ConnectError("That address is not reachable from Delphi")
        failure: Exception | None = None
        for address in addresses:
            try:
                return await self._dial.connect_tcp(address, port, timeout, local_address, socket_options)
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                failure = exc
        raise failure or httpcore.ConnectError(f"Could not reach {host}")

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise httpcore.ConnectError("Web fetches use TCP only")

    async def sleep(self, seconds: float) -> None:
        await self._dial.sleep(seconds)


def create_web_client(settings: Settings) -> httpx.AsyncClient:
    """The one bounded, credential-free upstream pool owned by app lifespan."""
    limits = httpx.Limits(max_connections=100, max_keepalive_connections=20, keepalive_expiry=30)
    transport = httpx.AsyncHTTPTransport(http2=True, trust_env=False, limits=limits)
    # httpx takes no network backend, so its pool is replaced by one with the
    # same settings and the backend; a test fetches through it to hold that.
    transport._pool = httpcore.AsyncConnectionPool(
        ssl_context=httpx.create_ssl_context(trust_env=False),
        max_connections=limits.max_connections,
        max_keepalive_connections=limits.max_keepalive_connections,
        keepalive_expiry=limits.keepalive_expiry,
        http2=True,
        network_backend=_PublicOnlyBackend(),
    )
    return httpx.AsyncClient(
        timeout=httpx.Timeout(settings.web_fetch_timeout_seconds, connect=10),
        follow_redirects=False,
        trust_env=False,
        transport=transport,
    )


_shared_client: httpx.AsyncClient | None = None


def set_shared_web_client(client: httpx.AsyncClient | None) -> None:
    global _shared_client
    _shared_client = client


async def fetch_resource(
    url: str,
    settings: Settings,
    *,
    include_pdf: bool = False,
    include_images: bool = False,
    include_svg: bool = False,
    allow_render: bool = False,
    live_source: bool = False,
) -> FetchedResource:
    """
    Fetch one supported document, following redirects by hand.

    httpx follows redirects for us, but then only the final hop is checked. Each
    hop is a fresh chance to be pointed at localhost, so the loop is explicit and
    `check_public_host` runs on every one of them.

    A PDF is reported before its body is read unless the caller has explicitly
    opted in. That is what lets the add-document dialog offer a choice without
    first pulling a potentially large paper through the server.

    `allow_render` is opt-in because most callers here are fetching bytes, not
    reading a page: a figure, an image and a PDF import all want the resource
    the address names, and running a browser at one would be answering a
    different question. Only the two paths that snapshot a page for a reader
    pass it.

    `live_source` uses the browser only as transport on a retryable HTTP
    refusal. It returns the original HTML response, with its boot scripts,
    so the reader builds the page itself instead of receiving a dead snapshot.
    """
    target = normalise_url(url)
    headers = {
        "User-Agent": settings.web_user_agent,
        "Accept": (
            "text/html,application/xhtml+xml;q=0.9,"
            "application/pdf;q=0.8,*/*;q=0.5"
        ),
        "Accept-Language": "en-US,en;q=0.9",
    }
    # Direct calls in focused unit tests have no FastAPI lifespan. Production
    # always uses the shared pool installed by main.lifespan.
    client = _shared_client or create_web_client(settings)
    owns_client = client is not _shared_client
    # A challenge cookie belongs to the one exchange that was handed it. It
    # lives here, for the life of this call, and is dropped the moment the
    # target changes host — the shared client's own jar is still never merged
    # into a request, so one publisher's state cannot reach another's fetch.
    cookies: str | None = None
    cookie_host = urlparse(target).hostname
    challenged = False
    try:
        for _ in range(MAX_REDIRECTS + 2):
            check_public_host(target)
            try:
                # Build the request directly. Even if an upstream response puts
                # Set-Cookie into the client's jar, no later request merges that
                # jar, so one publisher's state cannot cross into another fetch.
                attempt = dict(headers)
                if cookies and urlparse(target).hostname == cookie_host:
                    attempt["Cookie"] = cookies
                request = httpx.Request("GET", target, headers=attempt)
                response = await client.send(request, stream=True)
                try:
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise HTTPException(422, "That page redirected nowhere")
                        target = normalise_url(str(response.url.join(location)))
                        if urlparse(target).hostname != cookie_host:
                            cookies = None
                            cookie_host = urlparse(target).hostname
                        continue
                    if response.status_code >= 400:
                        # A cookie challenge is a 403 that hands over the cookie
                        # it wants back: spaces.ac.cn answers a 123-byte stub
                        # with two `Set-Cookie` headers and a JS redirect to the
                        # same address, and serves the real article the moment
                        # one request carries them. Once per call, and only
                        # while the host is unchanged, so a site that always
                        # refuses cannot turn into a loop.
                        offered = response.headers.get_list("set-cookie")
                        if (
                            not challenged
                            and response.status_code in RETRYABLE_STATUSES
                            and offered
                        ):
                            challenged = True
                            cookies = "; ".join(
                                pair.split(";", 1)[0] for pair in offered
                            )
                            cookie_host = urlparse(target).hostname
                            continue
                        # A wall a real browser walks through is worth one
                        # browser. The ones that fingerprint TLS are not, and
                        # this is where they end.
                        #
                        # A render that "succeeds" here is not yet an article:
                        # DataDome answers a browser with a CAPTCHA page, which
                        # is structurally valid HTML and extracts to a real
                        # section, so accepting it filed a document titled
                        # "nytimes.com" whose entire body was "Please enable JS
                        # and disable any ad blocker". An interstitial is
                        # distinguished from a page the only way it can be —
                        # by how much it says (55 characters, there).
                        rendered = (
                            (await render_page(target, source_only=True) if live_source else await render_page(target))
                            if allow_render
                            and response.status_code in RETRYABLE_STATUSES
                            else None
                        )
                        if rendered is not None:
                            built = rendered.body.decode(
                                rendered.encoding, errors="replace"
                            )
                            if (
                                not is_interstitial(built)
                                and len(rendered.body) <= settings.web_max_html_bytes
                                and (live_source or readable_text_length(built) >= PROSE_MIN_CHARS)
                            ):
                                return rendered
                        raise HTTPException(
                            422,
                            describe_failure(
                                response.status_code,
                                urlparse(target).hostname or "That site",
                            ),
                        )
                    content_type = (
                        response.headers.get("content-type", "").split(";")[0].strip()
                    )
                    if content_type in PDF_TYPES and not include_pdf:
                        raise HTTPException(409, PDF_URL_DETAIL)
                    supported = HTML_TYPES | PDF_TYPES
                    if include_images:
                        supported |= IMAGE_TYPES
                    if include_svg:
                        supported |= SVG_TYPES
                    if content_type not in supported:
                        raise HTTPException(
                            415,
                            f"That address is {content_type or 'not a web page'}. "
                            "Delphi can add HTML pages and PDFs.",
                        )
                    limit = (
                        settings.max_upload_source_mb * 1024 * 1024
                        if content_type in PDF_TYPES
                        else (
                            settings.web_image_max_bytes
                            if content_type in IMAGE_TYPES | SVG_TYPES
                            else settings.web_max_html_bytes
                        )
                    )
                    body = await read_capped(response, limit)
                    encoding = response.encoding or "utf-8"
                finally:
                    await response.aclose()
            except httpx.HTTPError as exc:
                raise HTTPException(422, f"Could not reach that page: {exc}") from exc
            return FetchedResource(
                url=str(target),
                body=body,
                content_type=content_type,
                encoding=encoding,
                fetched_at=utc_now(),
            )
        raise HTTPException(422, "That page redirected too many times")
    finally:
        if owns_client:
            await client.aclose()


async def render_page(
    url: str, *, asset_hosts: tuple[str, ...] = (), source_only: bool = False, whole: bool = True
) -> FetchedResource | None:
    """Run a page's own scripts and return what they built, or None.

    The import is function-local on purpose: `browser_render` imports
    `check_public_host` from this module, so a module-level import here would
    close the cycle. The browser also blocks for its whole budget, so it runs
    in a worker thread rather than on the event loop that is serving every
    other request. A container with no Chromium returns None; the caller then
    tells the reader the page had nothing to read.
    """
    import anyio

    from .browser_render import render_dom

    html = await anyio.to_thread.run_sync(
        functools.partial(render_dom, url, asset_hosts=asset_hosts, source_only=source_only, whole=whole)
    )
    if not html:
        return None
    return FetchedResource(
        url=url,
        body=html.encode("utf-8"),
        content_type="text/html",
        encoding="utf-8",
        fetched_at=utc_now(),
        rendered=not source_only,
    )


def _is_readable(html: str, document: dict) -> bool:
    """Whether this is an article rather than something standing in for one.

    Emptiness is not the only way to have nothing to read, and it is not even
    the common one. A Cloudflare interstitial answers *200* with a titled,
    well-formed "Just a moment…" document that extracts to a real section, so
    a check for no sections at all admitted it and Delphi filed a document
    whose entire body was the name of the wall in front of the article.

    Two tests, because one does not cover it. Length catches the terse walls —
    DataDome's CAPTCHA page is 55 characters — at the same threshold
    `pick_container` uses to tell an article from a nav. The Cloudflare page
    needs the other one: at 1,170 characters of advice about disabling browser
    extensions it is longer than plenty of real articles, and only the
    challenge machinery it loads gives it away.
    """
    if is_interstitial(html):
        return False
    return sum(
        len(section["markdown"]) for section in document["sections"]
    ) >= PROSE_MIN_CHARS


#: Served prose this long is an article on its face, longer than any wall the
#: import knows (Cloudflare's "Just a moment…" is 1,170 characters).
LIVE_PROSE_CHARS = 2_000
#: Elements whose content a reader never sees as prose.
_UNSEEN = frozenset(("script", "style", "noscript", "template", "svg"))
_TAG_NAME = re.compile(r"</?([a-zA-Z][a-zA-Z0-9-]*)")


def _served_prose(html: str, enough: int = LIVE_PROSE_CHARS) -> int:
    """Characters of text a reader would see in `html`, roughly: up to `enough`.

    One forward pass, so a page of any size costs at most its first
    `enough` characters of prose. A regular expression pairing each tag with
    its close rescanned the rest of the page from every unclosed one, which
    froze a 250 KB page of custom elements for nine seconds.
    """
    count, at, size, unseen = 0, 0, len(html), ""
    while at < size and count < enough:
        tag = html.find("<", at)
        if not unseen:
            count += len(" ".join(html[at:size if tag < 0 else tag].split()))
        if tag < 0:
            break
        if html.startswith("<!--", tag):
            close = html.find("-->", tag + 4)
            at = size if close < 0 else close + 3
            continue
        end = html.find(">", tag + 1)
        if end < 0:
            break
        named = _TAG_NAME.match(html, tag)
        if named:
            name, closing = named.group(1).lower(), html[tag + 1] == "/"
            if not unseen and not closing and name in _UNSEEN and html[end - 1] != "/":
                unseen = name
            elif closing and name == unseen:
                unseen = ""
        at = end + 1
    return count


def boots_in_frame(html: str, url: str, max_chars: int) -> bool:
    """Whether the live view can hand the reader this document to run.

    Live serves the original response and lets the reader's browser build it,
    never a snapshot. That fails for one shape: a page whose article is not in
    its HTML and is left to its own scripts to draw. Those scripts boot against
    an origin that is not their own, find none of the state they expect, and
    paint nothing — a public Notion page frames blank, as z.ai's Vite blog did
    with its module scripts, which cannot even load there
    (`draws_with_same_origin_modules`). The live view then says it is
    unavailable and the reader shows the saved copy, which the import built in
    a browser. Cheapest test first, since this runs on every live open: a page
    with no script cannot be one only scripts draw, and one that serves plenty
    of prose is an article whatever it also embeds (a Turnstile widget beside
    it, say). Only what is left is parsed, by the import's own article test
    (`_is_readable`), on the HTML already fetched, never on a render.
    """
    from .web_extract import extract

    if "<script" not in html.lower() or _served_prose(html) >= LIVE_PROSE_CHARS:
        return True
    return _is_readable(html, extract(html, url, max_chars))


def _readable_or_empty(html: str, document: dict) -> dict:
    """Hand back a page, or the absence of one — callers check `sections`."""
    if _is_readable(html, document):
        return document
    return {**document, "sections": [], "wordCount": 0}


async def framed_page(
    resource: FetchedResource, document: dict, settings: Settings
) -> tuple[FetchedResource, dict] | None:
    """The document a page only frames, fetched and read — or None.

    `framed_document` says a page has no article of its own and exactly one
    frame. That makes the frame a candidate and nothing more: a page that is
    only a video player has the same shape. So the frame is read like any other
    address and judged like one (`_is_readable`), and it replaces the page only
    if it is a document by the standard every import is held to.

    The frame gets one plain fetch. No browser: a frame that needs one to have
    text is not known to be a document, and spending the render budget to find
    out would put that cost on every page that embeds a player. No second hop:
    a frame that itself only frames something is left as it is.

    `document` is the page's own extraction, used for the DOM a browser built
    when the page needed one — that is where a scripted page's frame is.
    """
    import anyio

    from .web_extract import framed_document

    html = document.get("_rendered") or resource.body.decode(
        resource.encoding, errors="replace"
    )
    address = await anyio.to_thread.run_sync(framed_document, html, resource.url)
    if address is None:
        return None
    try:
        framed = await fetch_resource(address, settings)
    except HTTPException:
        return None
    framed_html = framed.body.decode(framed.encoding, errors="replace")
    inner = await anyio.to_thread.run_sync(
        extract, framed_html, framed.url, settings.web_max_extract_chars
    )
    return (framed, inner) if _is_readable(framed_html, inner) else None


async def extract_with_render_fallback(
    resource: FetchedResource, max_chars: int, *, whole: bool = True
) -> dict:
    """Parse a page, and if there is nothing to parse, build it and parse that.

    This is the one place acquisition and extraction are coupled, and they have
    to be: "should Delphi spend a browser on this?" is answered by "did parsing
    find anything?", which is not knowable until parsing has run. A page whose
    text exists only after its scripts run — a Notion page is 5 KB of loading
    skeleton — is indistinguishable at fetch time from one that is simply
    empty, and telling them apart is the whole job.

    `whole=False` is the add's: a windowed page is read at its first window
    and its DOM says so (`render_is_partial`), for `routers.captures` to finish.
    """
    import anyio

    from .web_extract import extract, static_document

    html = resource.body.decode(resource.encoding, errors="replace")
    document = await anyio.to_thread.run_sync(extract, html, resource.url, max_chars)
    if _is_readable(html, document) or resource.rendered:
        return _readable_or_empty(html, document)

    from .browser_render import _asset_hosts

    built = await render_page(
        resource.url,
        # Taken from the shell we already hold, so the renderer can reach the
        # bundle that draws the page while every other host stays refused.
        asset_hosts=_asset_hosts(html, resource.url),
        whole=whole,
    )
    if built is None:
        return _readable_or_empty(html, document)
    built_html = built.body.decode(built.encoding, errors="replace")
    document = _readable_or_empty(
        built_html,
        await anyio.to_thread.run_sync(extract, built_html, built.url, max_chars),
    )
    if document["sections"]:
        # The DOM the browser built, kept for the reader panel. Without it the
        # panel re-fetches the address and frames the same empty shell the
        # model could not read either, so a page Delphi understands perfectly
        # still shows as blank. Private key, like `_markdown`: the caller
        # stores it and drops it before the record is written.
        document["_rendered"] = await anyio.to_thread.run_sync(
            static_document, built_html
        )
    return document
