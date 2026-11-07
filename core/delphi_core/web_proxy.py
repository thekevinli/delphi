"""
Serving somebody else's page inside Delphi's reader panel.

The reason this is a proxy rather than a plain `<iframe src="https://…">` is
that a cross-origin frame is opaque: no text selection, no scroll control, no
way to point at a cited section. Serving the document ourselves makes the frame
scriptable, which is what "highlight and ask" and citation jumps need.

The reason it is *not* a rewriting proxy is `<base href>`. With a base tag the
page's own stylesheets, fonts, images, MathJax and scripts resolve against the
site they came from and load straight from it. No URL rewriting engine, no asset
proxy, no third-party bandwidth through Cloud Run — and the page keeps the
interactive parts that were the whole argument for not asking people to print it
to PDF first.

What that costs: the page runs in an opaque origin, so its own same-origin
`fetch`/XHR fails CORS and `localStorage` throws. Static sites and docs do not
notice. Anything that boots a client-side router will.
"""

import json
import re
import base64
import html as html_module
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

from .browser_render import RENDER_WIDTH_ATTRIBUTE
from .web_extract import adapt_same_origin_assets

# Scripts run so the page still behaves like itself; forms and popups so a
# search box or a footnote does not silently do nothing.
#
# Applied as the iframe element's `sandbox` attribute, by the embedder. It is
# *not* also sent as a `Content-Security-Policy: sandbox` response header:
# Chrome renders a CSP-sandboxed document fine at the top level but paints
# nothing at all when the same document is framed, which is the only way Delphi
# ever shows it. The top-level case that header was meant to cover is closed by
# `is_frame_request` instead.
SANDBOX = "allow-scripts allow-popups allow-forms allow-modals"

# Granted only when pages are served from a sandbox origin.
#
# `allow-same-origin` gives the document its real origin back, and sandbox flags
# inherit into nested frames — so without it an embedded Vimeo or YouTube player
# loads unable to use *its own* origin and renders a dead poster frame. That is
# what makes videos and 3D demos work, and it is also why the origin must not be
# Delphi's: a page granted our origin can call /api with the user's cookie
# attached, which `HttpOnly` does nothing to prevent.
SANDBOX_WITH_ORIGIN = f"{SANDBOX} allow-same-origin allow-presentation"

# Device powers are a separate mechanism from sandbox flags and also delegate
# downward, so an embedded player needs them passed through the outer frame or
# it cannot go fullscreen, autoplay, or decrypt protected media.
FRAME_ALLOW = (
    "autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write"
)


#: Marks what `render_frame` adds to a page. Named in `freeze` and in the
#: bridge's page capture, which both remove every node carrying it.
FRAME_MARK = "data-delphi-frame"


def sandbox_flags(sandbox_origin: str) -> str:
    return SANDBOX_WITH_ORIGIN if sandbox_origin else SANDBOX


@lru_cache(maxsize=1)
def bridge_source() -> str:
    """The iframe script. Cached per process; a change to the file needs a restart."""
    return Path(__file__).with_name("web_bridge.js").read_text(encoding="utf-8").replace("/* ANNOTATION_IMPLEMENTATION */", Path(__file__).with_name("web_annotation_bridge.js").read_text(encoding="utf-8"))


def render_frame(
    html: str | BeautifulSoup, base_url: str, content_kind: str = "html"
) -> str:
    """Rewrite a fetched document into one that can be framed and talked to.

    Takes a parsed document too, so a built DOM already parsed to strip its
    scripts is not parsed again: on a 4 MB Notion page each pass is a second.
    """
    soup = html if isinstance(html, BeautifulSoup) else BeautifulSoup(html, "html.parser")

    if soup.head is None:
        head = soup.new_tag("head")
        if soup.html is not None:
            soup.html.insert(0, head)
        else:
            soup.insert(0, head)
    head = soup.head

    adapt_same_origin_assets(soup, base_url)
    _release_captured_viewport_width(soup)

    # A page's own CSP is enforced by the browser against the document as we
    # serve it, so leaving it in place would block the bridge script — and, on
    # sites that set `frame-ancestors`, the frame itself.
    for node in soup.find_all("meta", attrs={"http-equiv": True}):
        if str(node["http-equiv"]).lower() in {
            "content-security-policy",
            "content-security-policy-report-only",
            "refresh",
        }:
            node.decompose()

    for node in soup.find_all("base"):
        node.decompose()

    # Everything injected below is marked, so a page copy the reader's frame
    # serialises (`freeze`) sheds it rather than saving a second set on top of
    # the one the cached view is framed with.
    base = soup.new_tag("base", href=base_url)
    base[FRAME_MARK] = ""
    head.insert(0, base)

    # The origin site still serves every subresource, so it sees the reader
    # regardless; withholding the referrer at least keeps Delphi's own URLs,
    # which carry project and paper ids, out of its logs.
    referrer = soup.new_tag("meta")
    referrer["name"] = "referrer"
    referrer["content"] = "no-referrer"
    referrer[FRAME_MARK] = ""
    head.insert(1, referrer)

    # First thing in the head, ahead of the page's own scripts. A client-rendered
    # site that throws while booting has to be caught by a listener that was
    # already installed; the storage and history shims are only useful if they
    # are in place before the framework touches either; and the path rewrite
    # below has to happen before anything reads the route.
    config = soup.new_tag("script")
    config[FRAME_MARK] = ""
    config.string = "window.__DELPHI__=" + json.dumps(
        {"path": path_of(base_url), "kind": content_kind}, ensure_ascii=False
    ) + ";"
    head.insert(2, config)

    script = soup.new_tag("script")
    script[FRAME_MARK] = ""
    script.string = bridge_source()
    head.insert(3, script)

    return str(soup)


# The `width` declaration inside an inline style, not `max-width`/`min-width`.
_INLINE_WIDTH = r"(?<![\w-])width\s*:\s*{}px"


def _release_captured_viewport_width(soup: BeautifulSoup) -> None:
    """Give a stored DOM back the one width its scripts took from the window.

    A page built in a browser is stored as its scripts left it, and a script
    that sized its frame to the window wrote that measurement inline — Notion's
    `main.notion-frame` carries `width: 1512px`, the capture viewport exactly.
    The reader zooms by narrowing the frame's layout width, so that one pixel
    value held the article at its capture width and cut the text off on the
    right, where a live page would have rewrapped. A width equal to the capture
    viewport is the viewport, so it is written back as `100%`; every other
    measurement, and every design width, is left alone.
    """
    width = str(soup.html.get(RENDER_WIDTH_ATTRIBUTE, "")) if soup.html else ""
    if not width.isdigit():
        return
    pattern = re.compile(_INLINE_WIDTH.format(width))
    for node in soup.find_all(style=pattern):
        node["style"] = pattern.sub("width: 100%", node["style"])


def render_image_frame(image: bytes, base_url: str, title: str = "Image") -> str:
    """A static normalized image with the same bridge contract as HTML pages."""
    encoded = base64.b64encode(image).decode("ascii")
    html = (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>{html_module.escape(title)}</title>"
        "<style>html,body{margin:0;min-height:100%;background:#f5f2eb}"
        "body{display:grid;place-items:center;padding:24px;box-sizing:border-box}"
        "img{max-width:100%;height:auto;box-shadow:0 8px 36px #0002}</style>"
        "</head><body>"
        f"<img src='data:image/webp;base64,{encoded}' alt='Captured image'>"
        "</body></html>"
    )
    return render_frame(html, base_url, "image")


def render_pdf_interstitial(base_url: str) -> str:
    """Keep a PDF out of the opaque browser plugin while preserving navigation."""
    html = (
        "<!doctype html><html><head><meta charset='utf-8'><title>PDF document</title>"
        "<style>body{font:16px system-ui;margin:0;min-height:100vh;display:grid;"
        "place-items:center;background:#f6f3ed;color:#292621}.card{max-width:34rem;"
        "padding:2rem;border:1px solid #d8d1c4;border-radius:16px;background:white}"
        "a,button{color:#8c4b2d}button{font:inherit;padding:.6rem .9rem;margin-right:.6rem;"
        "border:1px solid #c8b7aa;border-radius:8px;background:#fff;cursor:pointer}</style>"
        "</head><body><main class='card'>"
        "<h1>This link is a PDF</h1><p>Import it as a Delphi document for the "
        "native reader, persistent highlights, and citations, or open it externally.</p>"
        f"<p><button data-delphi-import-pdf='{html_module.escape(base_url, quote=True)}'>Import into Delphi</button>"
        f"<a href='{html_module.escape(base_url, quote=True)}' target='_blank' rel='noopener'>Open externally</a></p>"
        "</main></body></html>"
    )
    return render_frame(html, base_url, "pdf")


def path_of(url: str) -> str:
    """The article's own path, for the frame to adopt as its own."""
    parsed = urlsplit(url)
    return parsed.path + (f"?{parsed.query}" if parsed.query else "")


def is_frame_request(headers: Mapping[str, str]) -> bool:
    """
    Is this the reader panel asking, or someone opening the URL in a tab?

    This is the load-bearing check. Proxied HTML served as a *top-level*
    document would run third-party script on Delphi's own origin, with the
    session cookie attached to anything it chose to fetch — an account takeover
    for any page a user adds. In a frame the `sandbox` attribute denies it an
    origin, so the same script is harmless.

    `Sec-Fetch-Dest` is set by the browser and cannot be forged by page script,
    which is what makes it usable here. A client that omits it entirely is not a
    browser navigating, and gets the redirect too — the safe direction.
    """
    return headers.get("sec-fetch-dest", "") in {"iframe", "frame"}


def frame_headers(frame_ancestors: list[str]) -> dict[str, str]:
    """The headers that make this safe to serve from the app's own origin."""
    ancestors = " ".join(["'self'", *frame_ancestors]) or "'self'"
    return {
        # Only Delphi may frame this. Another site framing it would have to
        # arrive with the user's session cookie, which SameSite already refuses
        # cross-site — this closes the gap rather than being the only lock.
        "Content-Security-Policy": f"frame-ancestors {ancestors}",
        "X-Content-Type-Options": "nosniff",
        # The live page is fetched fresh on every open: a snapshot is what the
        # model reads, and the frame is what the human reads, and conflating the
        # two by caching would make them disagree silently.
        "Cache-Control": "private, no-store",
    }
