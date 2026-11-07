"""A web document's two saved halves, and the one sanitizer both pass through.

`.web` holds both, and each is written by one function:

  * **The text** (`sections`, and the flat `.txt` beside it) is what the model
    reads and the research digest is built from. It always comes from Delphi's
    own fetch, never from a page's scripts; `publish_snapshot` writes it at
    import, on a refresh, and when a capture reads a windowed page whole.
  * **The page copy** (`savedDom` and the `savedPage*` fields) is what the
    cached view shows, what highlights are matched against there, and what the
    thumbnail photographs. The import stores the page as fetched, through
    `publish_snapshot`, which also replaces that copy with the whole page while
    it is still a windowed page's first window (`savedPagePartial`) and never
    otherwise. After that, `publish_saved_page` stores the page as the reader's
    browser drew it when they annotated it — the MathJax, embeds and
    script-built content a second server fetch never has.

`publish_saved_page` never touches the text, and a refresh never the page
copy, so a site that refuses the text refresh cannot cost the reader the page
they marked up, and a page copy that changes cannot make the digest look stale.
"""
import hashlib
import json
import re
from collections import Counter
from contextlib import nullcontext

from bs4 import BeautifulSoup
from fastapi import HTTPException

from .browser_render import RENDER_WIDTH_ATTRIBUTE
from .storage import paper_key, utc_now
from .web_extract import flat_markdown, static_document_soup

#: The fields that make up the page copy. Everything else in `.web` is text.
#: `savedPagePartial` marks a copy that is a windowed page's first window, as
#: an add stored it, until its capture stores the whole page in its place.
PAGE_FIELDS = ("savedDom", "savedPageHash", "savedPageAt", "savedPageUrl", "savedPagePartial")

#: A layout width a page copy may claim. Kept in step with the reader's check
#: on the frame's `renderWidth` in `PageViewer.tsx`.
MIN_PAGE_WIDTH, MAX_PAGE_WIDTH = 320, 10000

#: What a page that is not the article says at its top or bottom. Kept in step
#: with `walled` in `web_annotations.js`, which asks the same question of the
#: text the reader's frame holds.
_WALL = re.compile(
    r"subscribe to (continue|read)|sign in to (continue|read)|log in to (continue|read)"
    r"|access denied|404[ :—-]*not found",
    re.I,
)


def read_revision(objects, username, project_id, paper_id):
    key = paper_key(username, project_id, paper_id, "web")
    return json.loads(objects.get_text(key)) if objects.exists(key) else {}


def walled(text: str) -> bool:
    """A login, subscription or error page standing where the article should be."""
    return bool(_WALL.search(text[:500] + "\n" + text[-800:]))


# --- The sanitizer ---------------------------------------------------------------

#: Attributes whose value a browser resolves as a URL.
_URL_ATTRIBUTES = (
    "href", "src", "action", "formaction", "xlink:href", "poster", "data",
    "background", "cite", "longdesc", "lowsrc", "dynsrc", "ping", "manifest",
    "codebase", "archive", "icon", "profile",
)
_URL_LIST_ATTRIBUTES = ("srcset", "imagesrcset")
_SAFE_SCHEMES = {"http", "https", "mailto", "tel"}
#: Where a `data:` URL can only ever be an image: nothing there is a document.
_IMAGE_CONTEXTS = {"img", "source", "picture", "image", "video", "audio", "input"}
_SCHEME = re.compile(r"([a-z][a-z0-9+.\-]*):", re.I)
_TAB_OR_NEWLINE = re.compile(r"[\t\n\r]")
_C0_OR_SPACE = "".join(map(chr, range(33)))

#: Embedded documents with no player worth keeping. Each becomes a link to what
#: it embedded, so the reader still knows something was there.
_PLACEHOLDER_EMBEDS = ("object", "embed", "applet", "portal", "fencedframe")


def _scheme(value: str) -> str | None:
    """The scheme a browser would read, after the URL standard's own clean-up.

    A browser removes every ASCII tab and newline from a URL and trims leading
    and trailing C0 controls and spaces before it looks for a scheme, so
    `java&#10;script:` is `javascript:` by the time it runs. A literal prefix
    check sees neither.
    """
    found = _SCHEME.match(_TAB_OR_NEWLINE.sub("", value).strip(_C0_OR_SPACE))
    return found.group(1).lower() if found else None


def _allowed_url(value: str, element: str) -> bool:
    scheme = _scheme(value)
    if scheme is None or scheme in _SAFE_SCHEMES:
        return True
    cleaned = _TAB_OR_NEWLINE.sub("", value).strip(_C0_OR_SPACE).lower()
    return scheme == "data" and element in _IMAGE_CONTEXTS and cleaned.startswith("data:image/")


def _allowed_srcset(value: str, element: str) -> bool:
    return all(
        _allowed_url(candidate.split()[0], element)
        for candidate in value.split(",")
        if candidate.strip()
    )


def _placeholder(soup, node, source):
    if isinstance(source, str) and source.strip() and _scheme(source) in (None, "http", "https"):
        link = soup.new_tag("a", href=source.strip())
        link.string = "Open embedded content"
        node.replace_with(link)
    else:
        node.decompose()


def disarm(soup) -> None:
    """Take from `soup` everything left in it that runs or loads code.

    `static_document_soup` has already removed every `<script>`; this is what
    survives that: inline handlers, a frame's `srcdoc`, a URL whose scheme runs
    code or loads a document of its own, an SVG animation that can set `href`
    to one later, and a `<meta http-equiv>` refresh.
    """
    for node in soup.select("meta[http-equiv]"):
        node.decompose()
    for node in soup.find_all(("animate", "set")):
        if str(node.get("attributename", "")).lower() in ("href", "xlink:href"):
            node.decompose()
    for node in soup.find_all(True):
        for key in list(node.attrs):
            if key.lower().startswith("on") or key.lower() == "srcdoc":
                del node.attrs[key]
        for key in _URL_ATTRIBUTES:
            value = node.get(key)
            if isinstance(value, str) and not _allowed_url(value, node.name):
                del node.attrs[key]
        for key in _URL_LIST_ATTRIBUTES:
            value = node.get(key)
            if isinstance(value, str) and not _allowed_srcset(value, node.name):
                del node.attrs[key]


#: The common way to load a stylesheet without blocking the page: as print
#: media, switched to all once loaded. Its handler is the page's instruction.
_DEFERRED_STYLESHEET = re.compile(r"""\bmedia\s*=\s*['"]all['"]""")


def inert_document(html: str) -> str:
    """A prepared document as a preview photographs it from `file://`.

    There Chromium lets a page read any other file, so nothing in it may run:
    not a handler, and not the worker one could start, which no request
    filter sees. Its scripts stay enabled, so `<noscript>` fallbacks stay
    hidden as they were when the page drew; a deferred stylesheet is applied
    as its handler would have applied it.
    """
    soup = BeautifulSoup(html, "html.parser")
    for link in soup.find_all("link"):
        if str(link.get("media", "")).lower() == "print" and _DEFERRED_STYLESHEET.search(str(link.get("onload", ""))):
            link["media"] = "all"
    disarm(soup)
    return str(soup)


def freeze(html: str, url: str, width: int | None = None) -> str:
    """A page as an inert document: no script, and nothing that becomes one.

    Every page copy passes through here, whether Delphi fetched it or a
    reader's frame sent it, so the rule is written for markup nobody vouches
    for. Scripts, handlers, forms and dialogs go; so does every URL whose scheme
    runs code or loads a document of its own (`javascript:`, `vbscript:`,
    `blob:`, a `data:` document), judged as a browser would parse it.

    Embedded players are kept as they were. A YouTube or Vimeo iframe plays
    from its own origin in the cached view, which is the point: a saved copy
    that held the video itself would be unbounded, and one that held a still
    of it would be useless. What is not a player — `<object>`, `<embed>` and
    their kind — becomes a link to what it embedded.

    Delphi's own markup never survives, whoever put it there: the nodes the
    reader's frame injects (`[data-delphi-frame]`, `[data-delphi-annotation]`)
    and every `data-delphi-*` attribute, including one a page wrote itself. The
    width the copy was laid out at is then stamped from `width`, which the
    caller has validated; `render_width_of` reads it from the root element.
    """
    soup = static_document_soup(html, url)
    for node in soup.select(
        'form,dialog,[role="dialog"],[aria-modal="true"],[data-delphi-annotation],'
        '[data-delphi-frame],base,meta[http-equiv],[data-ad],ins.adsbygoogle'
    ):
        node.decompose()
    for player in soup.select("lite-youtube, lite-vimeo"):
        identifier = str(player.get("videoid", ""))
        if identifier and all(c.isalnum() or c in "_-" for c in identifier):
            link = soup.new_tag("a", href=("https://www.youtube.com/watch?v=" if player.name == "lite-youtube" else "https://vimeo.com/") + identifier)
            link.string = "Open video"
            player.replace_with(link)
        else:
            player.decompose()
    for node in soup.find_all(_PLACEHOLDER_EMBEDS):
        _placeholder(soup, node, node.get("data") or node.get("src"))
    disarm(soup)
    for node in soup.find_all(True):
        for key in list(node.attrs):
            if key.lower().startswith("data-delphi-") or key.lower() in ("nonce", "integrity"):
                del node.attrs[key]
    # A frame whose address was just refused would load `about:blank` into the
    # sandbox; there is nothing to keep.
    for frame in soup.find_all(("iframe", "frame")):
        if not frame.get("src"):
            frame.decompose()
    if width is not None and soup.html is not None:
        soup.html[RENDER_WIDTH_ATTRIBUTE] = str(width)
    return str(soup)


def page_text(html: str) -> str:
    """The text a reader sees on a page copy, for the guards below."""
    soup = BeautifulSoup(html, "html.parser")
    for node in soup.find_all(("head", "style", "script", "noscript", "template")):
        node.decompose()
    return soup.get_text(" ", strip=True)


_MARKDOWN_TARGET = re.compile(r"\]\([^)]*\)|<https?://[^>]*>")
_WORD = re.compile(r"\w+")


def _words(text: str) -> Counter:
    return Counter(word.lower() for word in _WORD.findall(text))


def keeps_fetched_text(page: str, document: dict) -> bool:
    """Whether a page copy still holds at least half of the text Delphi fetched.

    An incomplete-page heuristic — a capture taken mid-load, or of a page the
    site swapped for something else — and **not** proof that the copy is the
    article. A hostile page can keep every fetched word in a hidden element and
    show something else entirely; nothing on the server can tell, and the copy
    is only ever shown in the sandboxed frame the live page already ran in.
    """
    fetched = _words(_MARKDOWN_TARGET.sub("]", flat_markdown(document)))
    total = sum(fetched.values())
    if not total:
        return True
    shown = _words(page)
    return sum(min(count, shown[word]) for word, count in fetched.items()) * 2 >= total


# --- The two writers ---------------------------------------------------------------


def _text_of(revision):
    return {key: value for key, value in revision.items() if key not in PAGE_FIELDS}


def _page_of(revision):
    return {key: revision[key] for key in PAGE_FIELDS if key in revision}


def page_fields(frozen: str, url: str, saved_at: str, *, partial: bool = False) -> dict:
    return {
        "savedDom": frozen,
        "savedPageHash": hashlib.sha256(frozen.encode("utf-8")).hexdigest(),
        "savedPageAt": saved_at,
        "savedPageUrl": url,
        **({"savedPagePartial": True} if partial else {}),
    }


def publish_snapshot(objects, username, project_id, paper_id, document, previous, storage=None, *, page=None):
    """The one writer of a web document's text: import, a refresh, and a capture.

    `page` is the copy an import starts with — the page as fetched. A refresh
    passes none and leaves the reader's copy exactly as it is. A page never
    replaces a copy already there unless that copy is still a first window
    (`savedPagePartial`), which a capture (`routers.captures`) finishes: a copy
    the reader's frame stored (`publish_saved_page`) is theirs and is kept.
    """
    lock = storage.annotation_revision_lock(username, project_id, paper_id) if storage else nullcontext()
    with lock:
        current = read_revision(objects, username, project_id, paper_id)
        # Only another text write is a conflict. A page copy stored while this
        # fetch ran is kept, below.
        if _text_of(current) != _text_of(previous):
            raise HTTPException(409, "The saved page changed during refresh. Please retry.")
        old_sections = [section.get("markdown", "") for section in previous.get("sections", [])]
        next_text = "\n".join(section.get("markdown", "") for section in document.get("sections", []))
        old_text = "\n".join(old_sections)
        retained = sum(len(text) for text in old_sections if text and text in next_text)
        if old_text and ((len(next_text) < len(old_text) and old_text.startswith(next_text)) or retained < len(old_text)/2):
            raise HTTPException(409, "The refreshed page appears incomplete or substantially changed. The saved text was kept.")
        if current.get("savedDom") and not current.get("savedPagePartial"):
            page = None
        revision = {**document, **(page if page is not None else _page_of(current))}
        objects.put_text(paper_key(username, project_id, paper_id, "web"), json.dumps(revision, ensure_ascii=False))
        objects.put_text(paper_key(username, project_id, paper_id, "txt"), flat_markdown(document))


def publish_saved_page(objects, username, project_id, paper_id, frozen, text, url, storage):
    """The one writer of a page copy the reader made: the page as they annotated it.

    `text` is `page_text(frozen)`, read before the lock is taken: on a large
    page the parse is the slow part. Returns whether anything was written, and
    the copy's date. A copy identical to the stored one — the same
    page annotated again, or a retry whose first response was lost — writes
    nothing, so it cannot retake a thumbnail either.
    """
    fields = page_fields(frozen, url, utc_now())
    with storage.annotation_revision_lock(username, project_id, paper_id):
        current = read_revision(objects, username, project_id, paper_id)
        if not current.get("sections"):
            raise HTTPException(409, "This document has no saved text to check a page copy against.")
        if current.get("savedPageHash") == fields["savedPageHash"]:
            return {"changed": False, "savedAt": current.get("savedPageAt")}
        # Judged inside the lock, so a refresh that just replaced the text is
        # the text this copy is held to.
        if not keeps_fetched_text(text, current):
            raise HTTPException(409, "The page no longer holds the document's text, so the saved copy was kept.")
        revision = {**_text_of(current), **fields}
        objects.put_text(paper_key(username, project_id, paper_id, "web"), json.dumps(revision, ensure_ascii=False))
    return {"changed": True, "savedAt": fields["savedPageAt"]}
