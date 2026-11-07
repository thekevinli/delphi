"""
Turning a fetched page into something a model can read a slice of.

A PDF arrives with page numbers already in it, so the model can cite "p. 19" and
the reader can jump there. A web page has no pages — but it does have headings,
and on every static site generator worth the name those headings already carry
`id` attributes that the site's own table of contents links to. Those ids are the
web equivalent of a page number: stable, present in the live DOM, and therefore
something both the model and the browser panel can agree on.

So extraction here is not "get the text". It is "cut the article into sections,
each one labelled with an anchor that exists in the real page", which is what
makes `read_webpage` cheap and citation jumps land.
"""

import re
from typing import Any
from urllib.parse import urlsplit, urljoin, urlparse

from bs4 import BeautifulSoup, NavigableString, Tag
from markdownify import MarkdownConverter

from .document_index import strip_control_characters

HEADINGS = ("h1", "h2", "h3", "h4")
# Themes put a permalink inside the heading — "Motivation #" — which then ends up
# in the outline the model reads and in every citation label.
ANCHOR_GLYPHS = {"#", "¶", "§", "🔗", "link", ""}
# Dropped outright: none of it is the article, and nav in particular is a large
# fraction of a typical blog page's text. `iframe` and `svg` are listed here too,
# but `preserve_media` runs first and turns the ones that *are* the article —
# a Vimeo demo, an architecture diagram drawn as SVG — into markdown the model
# can cite, so the decompose below only clears chrome, not figures.
NOISE = (
    "script",
    "style",
    "noscript",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "iframe",
    "svg",
    "template",
)
# Locator for a diagram whose pixels come from HTML, CSS, and an SVG overlay
# together. Treating the overlay as a standalone SVG drops the visible nodes
# and their stylesheet, then SVG's default black fill paints a convincing but
# false diagram. The stored entry carries a frozen one-figure HTML document for
# the guarded browser capture path instead.
INLINE_HTML_PREFIX = "inline-html:"
#: Inline markup is copied from an untrusted, user-named page and stored beside
#: its text snapshot. Keep enough candidates for an article, but never let a
#: page with hundreds of diagrams multiply its whole stylesheet context without
#: bound. Ordinary ``<img>`` URLs do not consume this budget: they remain cheap
#: locators and are fetched only if the model later chooses one.
INLINE_FIGURE_MAX_COUNT = 12
INLINE_FIGURE_MAX_BYTES = 1_000_000
#: Below this, a block of markup is chrome rather than an article: a nav, a
#: cookie banner, a bot-check interstitial. One number, because "does this hold
#: prose" is one question whether it is asked of a candidate container or of a
#: whole rendered document.
PROSE_MIN_CHARS = 200
#: Notion puts the product name in the tab title — "Article | Notion" — which
#: is not the article's name. Strip that suffix so the library, the dashboard
#: and the reader chrome all say what the page is.
SITE_TITLE_SUFFIX = re.compile(r"\s*[|–—]\s*Notion\s*$", re.IGNORECASE)


def clean_page_title(title: str) -> str:
    # html.parser preserves NUL, which would reject the paper's Postgres row.
    # Clean before the fallback too, so a control-only title cannot return it.
    title = strip_control_characters(title or "")
    cleaned = SITE_TITLE_SUFFIX.sub("", title or "").strip()
    return cleaned or title


# Below this, an inline SVG is chrome (icons, chevrons), not a figure. Rhoda's
# DVA diagram is 880×340; its nav icons are 16–24. The cut sits between them.
_SVG_DIAGRAM_MIN_SIDE = 80
_SVG_DIAGRAM_MIN_AREA = 12_000
# Attributes / elements the SVG XML grammar requires in camelCase. BeautifulSoup's
# HTML parser lowercases them on the way in; an `<img src="….svg">` re-parses the
# stored bytes as XML, where `viewbox` ≠ `viewBox`. Without the real viewBox the
# browser falls back to the SVG default viewport of 300×150 and crops everything
# past that — which is how an 880×340 architecture diagram arrived as "three
# blue squares and the word DIRECT".
_SVG_ATTR_CASE = {
    "viewbox": "viewBox",
    "preserveaspectratio": "preserveAspectRatio",
    "markerunits": "markerUnits",
    "markerwidth": "markerWidth",
    "markerheight": "markerHeight",
    "refx": "refX",
    "refy": "refY",
    "gradientunits": "gradientUnits",
    "gradienttransform": "gradientTransform",
    "patternunits": "patternUnits",
    "patterncontentunits": "patternContentUnits",
    "patterntransform": "patternTransform",
    "spreadmethod": "spreadMethod",
    "basefrequency": "baseFrequency",
    "numoctaves": "numOctaves",
    "stitchtiles": "stitchTiles",
    "surfacescale": "surfaceScale",
    "specularconstant": "specularConstant",
    "specularexponent": "specularExponent",
    "limitingconeangle": "limitingConeAngle",
    "stddeviation": "stdDeviation",
    "tablevalues": "tableValues",
    "kernelmatrix": "kernelMatrix",
    "kernelunitlength": "kernelUnitLength",
    "targetx": "targetX",
    "targety": "targetY",
    "pathlength": "pathLength",
    "calcmode": "calcMode",
    "keytimes": "keyTimes",
    "keysplines": "keySplines",
    "repeatcount": "repeatCount",
    "repeatdur": "repeatDur",
    "attributename": "attributeName",
    "attributetype": "attributeType",
    "clippathunits": "clipPathUnits",
    "maskunits": "maskUnits",
    "maskcontentunits": "maskContentUnits",
    "filterunits": "filterUnits",
    "primitiveunits": "primitiveUnits",
}
_SVG_TAG_CASE = {
    "clippath": "clipPath",
    "lineargradient": "linearGradient",
    "radialgradient": "radialGradient",
    "foreignobject": "foreignObject",
    "textpath": "textPath",
    "animatemotion": "animateMotion",
    "animatetransform": "animateTransform",
    "fegaussianblur": "feGaussianBlur",
    "feblend": "feBlend",
    "fecolormatrix": "feColorMatrix",
    "fecomponenttransfer": "feComponentTransfer",
    "fecomposite": "feComposite",
    "feconvolvematrix": "feConvolveMatrix",
    "fediffuselighting": "feDiffuseLighting",
    "fedisplacementmap": "feDisplacementMap",
    "feflood": "feFlood",
    "fefunca": "feFuncA",
    "fefuncb": "feFuncB",
    "fefuncg": "feFuncG",
    "fefuncr": "feFuncR",
    "feimage": "feImage",
    "femerge": "feMerge",
    "femergenode": "feMergeNode",
    "femorphology": "feMorphology",
    "feoffset": "feOffset",
    "fepointlight": "fePointLight",
    "fespecularlighting": "feSpecularLighting",
    "fespotlight": "feSpotLight",
    "fetile": "feTile",
    "feturbulence": "feTurbulence",
}
# Tried in order; the first one that looks like prose wins.
CONTAINERS = (
    "article",
    "main",
    "[role=main]",
    "[role=feed]",
    "[role=list]",
    ".post-content",
    ".entry-content",
    ".markdown-body",
    "#content",
    ".content",
)
# A thread or feed is one reading surface, not whichever individual post happens
# to contain the most characters. Check only containers that actually contain
# multiple articles so an unrelated sidebar list cannot outrank a normal post.
THREAD_CONTAINERS = (
    "[role=feed]",
    "[role=list]",
    "[aria-label*='conversation' i]",
    "[aria-label*='timeline' i]",
)

class PlainConverter(MarkdownConverter):
    """
    markdownify escapes `_`, `*` and friends so the output survives a round trip
    back through a markdown renderer. We are feeding a model, not re-rendering,
    and every escape mangles the LaTeX that math-heavy posts carry inline —
    `x_i` becoming `x\\_i` is worse than useless.
    """

    class Options(MarkdownConverter.DefaultOptions):
        heading_style = "ATX"
        escape_asterisks = False
        escape_underscores = False
        escape_misc = False
        bullets = "-"


def strip_permalinks(container: Tag) -> None:
    """Drop the permalink glyphs themes tuck inside headings."""
    for heading in container.find_all(HEADINGS):
        for link in heading.find_all("a"):
            classes = " ".join(link.get("class") or []).lower()
            if link.get_text(strip=True).lower() in ANCHOR_GLYPHS or "anchor" in classes:
                link.decompose()


def slugify(text: str) -> str:
    """The slug Hugo, GitHub and most CMSs would have generated for a heading."""
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "section"


def usable_anchor(candidate: str) -> bool:
    """Whether a heading's own id is worth citing, or a slug should be made.

    A page's id normally beats a generated slug: it is what the site's own
    contents list links to, so a citation lands where the reader would. That
    argument fails for an id the page did not choose. React mints `:r2r:` at
    render time — a different string on the next render, and not a legal URL
    fragment either — so a section cited by one would be uncitable and, after
    a refresh, wrong. Frameworks that generate ids reach for the characters a
    fragment cannot carry, which is what makes this cheap to tell apart.
    """
    return bool(candidate) and not re.search(r"[\s:#/?]", candidate)


def normalize_svg_document(markup: str) -> str:
    """
    Make BeautifulSoup-serialized SVG valid as `image/svg+xml`.

    Memory figures are served to a browser `<img>`, which parses the bytes
    as XML. Attribute and element names are case-sensitive there; the HTML
    parser that extracted the diagram was not. Also ensure a root xmlns (inline
    SVGs often inherit it from the HTML parent). Classes stay intact: an
    external SVG may carry an embedded stylesheet whose selectors depend on
    the root class, while a layout-only class is harmless inside an `<img>`.
    """
    text = markup.strip()
    if not text:
        return text

    def fix_attr(match: re.Match[str]) -> str:
        name = match.group(1)
        return f"{_SVG_ATTR_CASE.get(name.lower(), name)}="

    def fix_tag(match: re.Match[str]) -> str:
        slash, name = match.group(1), match.group(2)
        return f"<{slash}{_SVG_TAG_CASE.get(name.lower(), name)}"

    text = re.sub(r"\b([A-Za-z][:A-Za-z0-9]*)\s*=", fix_attr, text)
    text = re.sub(r"<(/?)([A-Za-z][A-Za-z0-9]*)", fix_tag, text)
    if re.match(r"<svg\b", text, re.I) and "xmlns=" not in text[:180]:
        text = re.sub(
            r"<svg\b",
            '<svg xmlns="http://www.w3.org/2000/svg"',
            text,
            count=1,
            flags=re.I,
        )
    return text


def svg_dimensions(svg: str) -> tuple[int, int]:
    """Best-effort width/height from a viewBox or width/height attribute."""
    view = re.search(
        r'viewBox\s*=\s*["\']\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)',
        svg,
        re.I,
    )
    if view:
        return max(1, int(float(view.group(3)))), max(1, int(float(view.group(4))))
    width_match = re.search(r'\bwidth\s*=\s*["\']?(\d+(?:\.\d+)?)', svg, re.I)
    height_match = re.search(r'\bheight\s*=\s*["\']?(\d+(?:\.\d+)?)', svg, re.I)
    if width_match and height_match:
        return (
            max(1, int(float(width_match.group(1)))),
            max(1, int(float(height_match.group(1)))),
        )
    return 800, 450


def _svg_diagram_size(svg: Tag) -> tuple[float, float] | None:
    """Return (width, height) for an SVG if the markup names one."""
    view = str(svg.get("viewbox") or svg.get("viewBox") or "").replace(",", " ")
    parts = view.split()
    if len(parts) == 4:
        try:
            return float(parts[2]), float(parts[3])
        except ValueError:
            pass

    def axis(name: str) -> float | None:
        raw = svg.get(name)
        if raw is None:
            return None
        match = re.match(r"^\s*(\d+(?:\.\d+)?)", str(raw))
        return float(match.group(1)) if match else None

    width, height = axis("width"), axis("height")
    if width is not None and height is not None:
        return width, height
    return None


def _svg_is_diagram(svg: Tag) -> bool:
    """True for article figures; false for 16×16 nav icons."""
    size = _svg_diagram_size(svg)
    if size is None:
        # No declared size usually means an icon that inherits CSS dimensions.
        return False
    width, height = size
    return (
        min(width, height) >= _SVG_DIAGRAM_MIN_SIDE
        and width * height >= _SVG_DIAGRAM_MIN_AREA
    )


def _svg_is_presentation(svg: Tag) -> bool:
    """Whether this SVG explicitly says another element owns its meaning."""
    return str(svg.get("aria-hidden") or "").lower() == "true" or str(
        svg.get("role") or ""
    ).lower() in {"none", "presentation"}


def _compound_media_root(svg: Tag, boundary: Tag) -> Tag | None:
    """Find the accessible HTML/CSS figure that owns a decorative SVG layer."""
    if not _svg_is_presentation(svg):
        return None
    node = svg.parent
    while isinstance(node, Tag):
        role = str(node.get("role") or "").lower()
        label = str(node.get("aria-label") or "").strip()
        if role in {"img", "group", "figure"} and label:
            return node
        if node is boundary:
            break
        node = node.parent
    return None


def _media_link(url: str, title: str) -> Tag:
    replacement = BeautifulSoup("", "html.parser").new_tag("p")
    link = BeautifulSoup("", "html.parser").new_tag("a", href=url)
    link.string = title
    replacement.append(link)
    return replacement


def _frame_address(iframe: Tag, base_url: str) -> str | None:
    """Where a frame points, if that is somewhere a reader could be sent."""
    src = str(iframe.get("src") or "").strip()
    if not src or src.startswith("data:"):
        return None
    absolute = urljoin(base_url, src)
    return absolute if urlparse(absolute).scheme in {"http", "https"} else None


def _media_label(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _standalone_html_figure(
    figure: Tag, *, document_root: Tag | None, base_url: str
) -> str:
    """Freeze one compound figure without losing selector-bearing ancestors."""
    marker = "data-delphi-figure-root"
    figure[marker] = ""
    try:
        document = BeautifulSoup(str(document_root or figure), "html.parser")
    finally:
        del figure[marker]

    root = document.find(attrs={marker: True})
    if root is None:
        return ""
    # Source styles often say things like `#main.post article.content figure`.
    # Keep that ancestor chain while deleting every sibling, so the selector
    # context survives without photographing the rest of the article.
    child: Tag = root
    parent = child.parent
    while isinstance(parent, Tag) and parent.name not in {"body", "html"}:
        for sibling in list(parent.children):
            if sibling is not child:
                sibling.extract()
        child = parent
        parent = child.parent
    if isinstance(parent, Tag) and parent.name == "body":
        for sibling in list(parent.children):
            if sibling is not child:
                sibling.extract()

    for active in document.find_all(("script", "iframe", "object", "embed")):
        active.decompose()
    for caption in root.find_all("figcaption"):
        caption.decompose()

    # This artifact is a rendering input, not a second saved web page. Preserve
    # only inert style context from the source head and remove every executable
    # HTML attribute from the retained ancestor chain. Some sites load their
    # real stylesheet as ``media=print`` and flip it to ``all`` in ``onload``;
    # make that declarative before dropping the handler.
    for node in document.find_all(True):
        if (
            node.name == "link"
            and "stylesheet" in [str(value).lower() for value in node.get("rel", ())]
            and str(node.get("media") or "").lower() == "print"
            and "media" in str(node.get("onload") or "").lower()
            and "all" in str(node.get("onload") or "").lower()
        ):
            node["media"] = "all"
        for attribute in list(node.attrs):
            if attribute.lower().startswith("on"):
                del node[attribute]

    head = document.head
    if head is None:
        html_node = document.html or document
        head = document.new_tag("head")
        html_node.insert(0, head)
    else:
        for child in list(head.children):
            if not isinstance(child, Tag):
                child.extract()
                continue
            rel = [str(value).lower() for value in child.get("rel", ())]
            if child.name == "style" or (
                child.name == "link" and "stylesheet" in rel and child.get("href")
            ):
                continue
            child.decompose()

    policy = document.new_tag("meta")
    policy["http-equiv"] = "Content-Security-Policy"
    policy["content"] = (
        "default-src 'none'; script-src 'none'; connect-src 'none'; "
        "frame-src 'none'; object-src 'none'; media-src 'none'; "
        "style-src http: https: 'unsafe-inline'; "
        "img-src http: https: data:; font-src http: https: data:"
    )
    head.insert(0, policy)
    base = document.new_tag("base", href=base_url)
    head.insert(1, base)
    style = document.new_tag("style")
    style.string = (
        "html,body{margin:0!important;padding:0!important;background:#fff!important;"
        "overflow:hidden!important}"
        "[data-delphi-figure-root]{margin:0!important;max-width:none!important}"
    )
    head.append(style)
    return "<!doctype html>\n" + str(document)


def _promote_html_figure(
    figure: Tag,
    *,
    caption: str,
    svg_figures: list[dict[str, str]],
    document_root: Tag | None,
    base_url: str,
) -> int | None:
    if len(svg_figures) >= INLINE_FIGURE_MAX_COUNT:
        return None
    index = len(svg_figures)
    label = (
        _media_label(caption)
        or _media_label(str(figure.get("aria-label") or ""))
        or f"Figure {index + 1}"
    )
    html = _standalone_html_figure(
        figure, document_root=document_root, base_url=base_url
    )
    size = len(html.encode("utf-8"))
    used = sum(
        len(str(entry.get("html") or "").encode("utf-8"))
        for entry in svg_figures
    )
    if not html or used + size > INLINE_FIGURE_MAX_BYTES:
        return None
    svg_figures.append(
        {
            "id": f"{INLINE_HTML_PREFIX}{index}",
            "caption": label,
            "html": html,
        }
    )
    replacement = BeautifulSoup("", "html.parser").new_tag("p")
    image = BeautifulSoup("", "html.parser").new_tag(
        "img", src=f"{INLINE_HTML_PREFIX}{index}", alt=label
    )
    replacement.append(image)
    figure.replace_with(replacement)
    if caption:
        note = BeautifulSoup("", "html.parser").new_tag("p")
        note.string = caption
        replacement.insert_after(note)
    return size


def _replace_with_caption(node: Tag, caption: str) -> None:
    if caption:
        note = BeautifulSoup("", "html.parser").new_tag("p")
        note.string = caption
        node.replace_with(note)
    else:
        node.decompose()


def _figure_has_visual_content(figure: Tag) -> bool:
    """Whether a semantic figure contains anything beyond its caption."""
    clone = BeautifulSoup(str(figure), "html.parser")
    for caption in clone.find_all("figcaption"):
        caption.decompose()
    root = clone.find("figure") or clone
    return bool(root.get_text(" ", strip=True) or root.find(True))


def promote_lazy_images(container: Tag) -> None:
    """
    Lift lazy-load attributes onto `src` before absolutize / markdownify.

    Sites often ship `<img data-src="…" src="placeholder.gif">` or omit `src`
    until a script runs. The snapshot is the HTML as fetched — those scripts
    never run — so without this the figure never becomes a citable URL.
    """
    for img in container.find_all("img"):
        current = str(img.get("src") or "").strip()
        if current and not current.startswith("data:"):
            continue
        for attr in ("data-src", "data-lazy-src", "data-original", "data-url"):
            candidate = str(img.get(attr) or "").strip()
            if candidate and not candidate.startswith("data:"):
                img["src"] = candidate
                break


def preserve_media(
    container: Tag, base_url: str, *, document_root: Tag | None = None
) -> list[dict[str, str]]:
    """
    Turn media the NOISE pass would erase into markdown the snapshot can cite.

    Modern research posts (Rhoda's DVA page is the case that forced this) put
    the architecture diagram in an inline `<svg>` and the demos in Vimeo
    `<iframe>`s. Both tags are noise for *chrome* — an icon sprite, a tweet
    embed in a sidebar — so they are on the NOISE list, and without this pass
    the snapshot keeps the figcaption ("Figure 1. Simplified diagram…") while
    throwing away the diagram, then Memory ingest has nothing to capture and
    a model that still names the figure leaves a dead `figure:` embed in the
    wiki. Same shape for videos: the live reader shows them after they load;
    the snapshot never knew they existed.

    Runs *before* the NOISE decompose. Inline visuals are frozen with inert
    stylesheet context under `inline-html:N`; ordinary image URLs stay in the
    markdown.
    """
    svg_figures: list[dict[str, str]] = []
    promote_lazy_images(container)

    for iframe in list(container.find_all("iframe")):
        absolute = _frame_address(iframe, base_url)
        if absolute is None:
            iframe.decompose()
            continue
        title = (
            str(iframe.get("title") or "").strip()
            or str(iframe.get("aria-label") or "").strip()
            or "Video"
        )
        iframe.replace_with(_media_link(absolute, title))

    for video in list(container.find_all("video")):
        src = str(video.get("src") or "").strip()
        if not src:
            source = video.find("source", src=True)
            src = str(source.get("src") or "").strip() if source is not None else ""
        if not src or src.startswith("data:"):
            video.decompose()
            continue
        absolute = urljoin(base_url, src)
        if urlparse(absolute).scheme not in {"http", "https"}:
            video.decompose()
            continue
        title = (
            str(video.get("title") or "").strip()
            or str(video.get("aria-label") or "").strip()
            or "Video"
        )
        video.replace_with(_media_link(absolute, title))

    claimed: set[int] = set()
    # A formula's glyphs (KaTeX's root sign, MathJax's whole formula) are drawn
    # as SVG but are text, typeset after this pass; they are never figures.
    for svg in container.find_all("svg"):
        if svg.find_parent(class_="katex") is not None or svg.find_parent("mjx-container") is not None:
            claimed.add(id(svg))
    for figure in list(container.find_all("figure")):
        caption_node = figure.find("figcaption")
        caption = _media_label(_text_with_tex(caption_node) if caption_node is not None else "")
        # Prefer a real <img> (including ones just promoted from data-src) —
        # markdownify already turns those into `![alt](url)`.
        image = figure.find("img", src=True)
        image_url = (
            urljoin(base_url, str(image.get("src") or ""))
            if image is not None
            else ""
        )
        if image is not None and urlparse(image_url).scheme in {"http", "https"}:
            for nested in figure.find_all("svg"):
                claimed.add(id(nested))
            continue
        svg = next((node for node in figure.find_all("svg") if id(node) not in claimed), None)
        if svg is not None:
            compound = _compound_media_root(svg, figure)
            for nested in figure.find_all("svg"):
                claimed.add(id(nested))
            if compound is not None or not _svg_is_presentation(svg):
                promoted = _promote_html_figure(
                    figure,
                    caption=caption,
                    svg_figures=svg_figures,
                    document_root=document_root,
                    base_url=base_url,
                )
                if promoted is None:
                    _replace_with_caption(figure, caption)
            else:
                _replace_with_caption(figure, caption)
            continue
        if _figure_has_visual_content(figure):
            promoted = _promote_html_figure(
                figure,
                caption=caption,
                svg_figures=svg_figures,
                document_root=document_root,
                base_url=base_url,
            )
            if promoted is None:
                _replace_with_caption(figure, caption)
        else:
            _replace_with_caption(figure, caption)

    # Diagrams that never got a <figure> wrapper still beat the NOISE sweep if
    # their declared size looks like content rather than a 16px icon.
    for svg in list(container.find_all("svg")):
        if id(svg) in claimed or not _svg_is_diagram(svg):
            continue
        compound = _compound_media_root(svg, container)
        label = (
            str(svg.get("aria-label") or "").strip()
            or str(svg.get("title") or "").strip()
            or ""
        )
        title_node = svg.find("title")
        if not label and title_node is not None:
            label = title_node.get_text(" ", strip=True)
        if compound is not None:
            for nested in compound.find_all("svg"):
                claimed.add(id(nested))
            promoted = _promote_html_figure(
                compound,
                caption=label or str(compound.get("aria-label") or "").strip(),
                svg_figures=svg_figures,
                document_root=document_root,
                base_url=base_url,
            )
            if promoted is None:
                compound.decompose()
        elif not _svg_is_presentation(svg):
            promoted = _promote_html_figure(
                svg,
                caption=label,
                svg_figures=svg_figures,
                document_root=document_root,
                base_url=base_url,
            )
            if promoted is None:
                svg.decompose()
        else:
            svg.decompose()

    return svg_figures


def absolutize(container: Tag, base_url: str) -> None:
    """
    Rewrite relative links and image sources against the page they came from.

    The snapshot is read far from its origin — by a model with no base URL, and
    by a human reading the markdown in a chat answer — so a bare `/posts/foo`
    resolves to nothing useful in either place.
    """
    for node in container.find_all("a", href=True):
        destination = urljoin(base_url, node["href"])
        if urlparse(destination).scheme in {"http", "https", "mailto", "tel"}:
            node["href"] = destination
        else:
            del node["href"]
    for node in container.find_all("img", src=True):
        source = node["src"]
        if source.startswith("data:"):
            # An inline data URI is megabytes of base64 that says nothing; the
            # alt text is the only part with meaning.
            del node["src"]
        elif source.startswith(INLINE_HTML_PREFIX):
            # Locator into document["svgFigures"], not a fetchable URL — leave
            # it alone so urljoin cannot rewrite it against the page host.
            continue
        else:
            absolute = urljoin(base_url, source)
            if urlparse(absolute).scheme in {"http", "https"}:
                node["src"] = absolute
            else:
                del node["src"]


#: Hosts that serve the machinery of a bot check and nothing else, so a page
#: referencing one is a wall rather than a document. Named structurally, not by
#: their prose: the Cloudflare interstitial runs to 1,170 characters of advice
#: about disabling extensions, which is longer than plenty of real articles and
#: sails past any length test. This is the one place a vendor is named, and it
#: buys a decision — do not file this — rather than a sentence for the reader.
CHALLENGE_HOSTS = (
    "challenges.cloudflare.com",
    "captcha-delivery.com",
)


def is_interstitial(html: str) -> bool:
    """Whether this markup is a security check standing in for the page."""
    return any(host in html for host in CHALLENGE_HOSTS)


#: Product chrome a public Notion page paints around the article. Left in, the
#: reader shows "Get Notion free", the card photographs the topbar instead of
#: the page, and the tab title the bridge reads still ends in "| Notion".
NOTION_CHROME = (
    ".notion-topbar",
    ".notion-overlay-container",
    ".notion-default-overlay-container",
    ".notion-presence-container",
    ".notion-peek-renderer",
    ".notion-close-sidebar",
)


def _origin(url: str) -> tuple[str, str | None, int | None]:
    parsed = urlsplit(url)
    return parsed.scheme.lower(), parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def adapt_same_origin_assets(soup: BeautifulSoup, base_url: str) -> None:
    """Keep ordinary source-site CSS and classic scripts loadable in a frame.

    Next pages can mark their own stylesheet and classic bundles crossorigin.
    That works on their original origin without an ACAO response header, but
    our base tag makes them cross-origin and the browser rejects them (DeepSeek
    Harness rendered as bare HTML). These asset kinds support normal no-CORS
    loads, so remove only that redundant anonymous opt-in on source-origin
    URLs. Modules/fonts require CORS; integrity and credentialed loads retain
    their declared protections. This neither proxies bytes nor grants the page
    Delphi's origin.
    """
    for node in soup.find_all(["link", "script"], crossorigin=True):
        if node.get("crossorigin", "").lower() not in {"", "anonymous"} or node.has_attr("integrity"):
            continue
        if node.name == "script":
            if node.get("type", "").lower() not in {"", "text/javascript", "application/javascript"}:
                continue
            source = node.get("src")
        else:
            rel = {value.lower() for value in node.get("rel", [])}
            if not ("stylesheet" in rel or ("preload" in rel and node.get("as") in {"style", "script"})):
                continue
            source = node.get("href")
        try:
            same_origin = source and _origin(urljoin(base_url, source)) == _origin(base_url)
        except ValueError:
            continue
        if same_origin:
            del node["crossorigin"]


# A module specifier in an inline script: `import … from "x"`, `import "x"` or
# `import("x")`. Only string literals — a computed import cannot be resolved here.
_MODULE_IMPORT = re.compile(r"""\bimport\s*(?:\(\s*|[\w*{},\s]+?\bfrom\s*)?["']([^"'\n]+)["']""")


def draws_with_same_origin_modules(html: str, base_url: str) -> bool:
    """Whether the page's own module scripts are what would draw it.

    The reader frames a live page on Delphi's sandbox origin with a `<base>` at
    the source, so the page's assets are cross-origin to it. Classic scripts
    still load (`adapt_same_origin_assets` drops the crossorigin opt-in that
    would stop them); a module never can, because a module is always fetched
    with CORS and a site sends no ACAO header for its own assets. z.ai's blog is
    a Vite shell whose whole article is one `/blog/assets/*.js` module: framed
    live, the module is refused and the reader sees nothing. A module from
    another origin is not counted — the source page could only load it if that
    host already answers CORS, so it loads in the frame too.
    """
    soup = BeautifulSoup(html, "html.parser")
    for script in soup.find_all("script"):
        if script.get("type", "").strip().lower() != "module":
            continue
        sources = [script["src"]] if script.get("src") else _MODULE_IMPORT.findall(script.string or "")
        for source in sources:
            try:
                if _origin(urljoin(base_url, source.strip())) == _origin(base_url):
                    return True
            except ValueError:
                continue
    return False


def static_document_soup(html: str, base_url: str | None = None) -> BeautifulSoup:
    """A rendered page, frozen so it cannot un-draw itself.

    Framing a built DOM *with* its scripts fails: they boot again against the
    wrong origin, find no state, and React replaces everything with an empty
    root — the page arrives complete and then erases itself. Without them the
    text is in the markup and the styling is in linked CSS a `<base href>`
    resolves. Same fix as `_html_with_static_video_posters`.

    `base_url` is for a document that will be opened from `file://` — a
    thumbnail capture. Notion's figures are `/image/…` on its own host; without
    a base they resolve against the temp file and the card shows a broken-image
    glyph. The reader panel does not pass one: `render_frame` inserts its own.
    """
    soup = BeautifulSoup(html, "html.parser")
    for script in soup.find_all("script"):
        script.decompose()
    for selector in NOTION_CHROME:
        for node in soup.select(selector):
            node.decompose()
    for header in soup.find_all("header"):
        if not header.get_text(strip=True) and not header.find(("img", "svg", "canvas")):
            header.decompose()
    if soup.title is not None:
        soup.title.string = clean_page_title(soup.title.get_text())
    if base_url:
        adapt_same_origin_assets(soup, base_url)
        if soup.head is None:
            head = soup.new_tag("head")
            if soup.html is not None:
                soup.html.insert(0, head)
            else:
                soup.insert(0, head)
        if soup.head is not None and soup.head.find("base") is None:
            soup.head.insert(0, soup.new_tag("base", href=base_url))
    return soup


def static_document(html: str, base_url: str | None = None) -> str:
    return str(static_document_soup(html, base_url))


def readable_text_length(html: str) -> int:
    """How much visible text a document carries, before any container picking.

    Used to tell a page apart from an interstitial standing in for one. A
    CAPTCHA or "enable JavaScript" wall renders to a title and one sentence —
    55 characters, for the DataDome page NYTimes serves — which is
    structurally a valid document and extracts to a real section. Length is
    what separates them, and it is the same question `pick_container` asks of
    a candidate, so it is the same threshold.
    """
    return len(BeautifulSoup(html, "html.parser").get_text(" ", strip=True))


def pick_container(soup: BeautifulSoup) -> Tag:
    """Prefer a declared article container, but only if it actually holds prose."""
    thread_best: tuple[int, Tag] | None = None
    for selector in THREAD_CONTAINERS:
        for candidate in soup.select(selector):
            if len(candidate.find_all("article")) < 2:
                continue
            length = len(candidate.get_text(" ", strip=True))
            if length >= PROSE_MIN_CHARS and (
                thread_best is None or length > thread_best[0]
            ):
                thread_best = (length, candidate)
    if thread_best:
        return thread_best[1]

    best: tuple[int, Tag] | None = None
    for selector in CONTAINERS:
        for candidate in soup.select(selector):
            length = len(candidate.get_text(" ", strip=True))
            if length < PROSE_MIN_CHARS:
                continue
            if best is None or length > best[0]:
                best = (length, candidate)
        if best:
            return best[1]
    return soup.body or soup


_FRAME_TAG = re.compile(r"<iframe\b", re.IGNORECASE)


def framed_document(html: str, base_url: str) -> str | None:
    """The address of the one document a page exists to show, or None.

    Some pages are a host's chrome around a frame that holds the document
    itself: a hosted demo, a published notebook, an embedded report. Everything
    worth reading is at the frame's address, and none of it is in this HTML.

    That is a different thing from a page with something embedded *in* it — a
    post with a talk, an article with a demo — and the difference is whether
    the page has prose of its own. So the question asked here is the one
    `pick_container` asks, of the same container, at the same threshold: with
    the frame and the chrome taken out, is what remains an article? If it is,
    the frame is a figure and stays one (`preserve_media`). If it is not, and
    there is exactly one frame, the frame is the page.

    One frame, never the largest of several: which of two frames a page is
    "about" is a guess, and a wrong guess files a different document from the
    one the reader asked for. A frame inside `<noscript>` is the fallback for a
    reader who does not exist here.

    This only names a candidate. Whether the frame holds a document at all is
    for the caller to find out by reading it (`web_fetch.framed_page`).
    """
    if not _FRAME_TAG.search(html):
        return None
    container = pick_container(BeautifulSoup(html, "html.parser"))
    for fallback in container.find_all("noscript"):
        fallback.decompose()
    addresses = [
        address
        for frame in container.find_all("iframe")
        if (address := _frame_address(frame, base_url))
    ]
    if len(addresses) != 1:
        return None
    for node in container.find_all(NOISE):
        node.decompose()
    if len(container.get_text(" ", strip=True)) >= PROSE_MIN_CHARS:
        return None
    return addresses[0]


def flatten(node: Tag) -> list[Tag | NavigableString]:
    """
    Linearise the article into headings and blocks.

    Headings are rarely siblings of the paragraphs they introduce — themes wrap
    sections in divs, and some wrap every paragraph. Descending into anything
    that contains a heading, and emitting everything else whole, gives one flat
    sequence for both shapes without dismantling a table or a list into rows.

    "Anything" is deliberate rather than "any wrapper". `<figure>` has no implied
    end tag in HTML5, so a post that opens one and never closes it nests every
    later section inside it — the browser does this too, it is not a parser bug.
    Trusting a tag name to mean "this is a leaf" loses two thirds of such a page.
    """
    blocks: list[Tag | NavigableString] = []
    for child in node.children:
        if isinstance(child, NavigableString):
            if child.strip():
                blocks.append(child)
            continue
        if not isinstance(child, Tag):
            continue
        if child.name in HEADINGS:
            blocks.append(child)
        elif child.find(HEADINGS):
            blocks.extend(flatten(child))
        else:
            blocks.append(child)
    return blocks


def metadata(soup: BeautifulSoup, base_url: str) -> dict[str, str]:
    def meta(*names: str) -> str:
        for name in names:
            node = soup.find("meta", attrs={"property": name}) or soup.find(
                "meta", attrs={"name": name}
            )
            if node and node.get("content"):
                return str(node["content"]).strip()
        return ""

    title = meta("og:title", "twitter:title")
    if not title and soup.title and soup.title.string:
        title = soup.title.string.strip()
    title = clean_page_title(title)

    icon = soup.find("link", rel=lambda value: value and "icon" in value.lower())
    favicon = (
        urljoin(base_url, str(icon["href"]))
        if icon and icon.get("href")
        else urljoin(base_url, "/favicon.ico")
    )
    # `urljoin` preserves an absolute scheme, so a page can name its own —
    # including `javascript:` or a megabyte of `data:`. This value is stored on
    # the record and later becomes an `<img src>`, so pin it to real fetches
    # before it gets that far rather than relying on the browser to ignore it.
    if urlparse(favicon).scheme not in {"http", "https"}:
        favicon = urljoin(base_url, "/favicon.ico")

    published = meta("article:published_time", "date", "og:article:published_time")
    if not published:
        time_node = soup.find("time")
        if time_node:
            published = str(
                time_node.get("datetime") or time_node.get_text(strip=True)
            ).strip()

    return {
        "title": title or urlparse(base_url).netloc,
        "byline": meta("author", "article:author"),
        "published": published,
        "favicon": favicon,
    }


_ACCENTS = {"^": "\\hat", "ˆ": "\\hat", "¯": "\\bar", "‾": "\\bar", "~": "\\tilde", "˜": "\\tilde", "→": "\\vec", "˙": "\\dot"}


_FUNCTIONS = {"sin", "cos", "tan", "log", "ln", "exp", "max", "min", "lim", "sup", "inf", "det", "arg"}


def mathml_tex(node: Tag | NavigableString) -> str:
    """MathML as TeX, so a subscript reads as one: "W_{t+1}", never "Wt+1"."""
    if isinstance(node, NavigableString):
        return str(node).strip()
    name = node.name.split(":")[-1]
    parts = [child for child in node.children if isinstance(child, Tag)]
    tex = [mathml_tex(child) for child in parts]
    if name in {"annotation", "annotation-xml", "mphantom"}:
        return ""
    if name == "semantics":
        return tex[0] if tex else ""
    if name in {"mtext", "ms"}:
        text = re.sub(r"([$%&#_{}])", r"\\\1", re.sub(r"\s+", " ", node.get_text()))
        return f"\\text{{{text}}}" if text.strip() else " "
    if name == "mi" and len(node.get_text().strip()) > 1:
        word = node.get_text().strip()
        return f"\\{word} " if word in _FUNCTIONS else f"\\mathrm{{{word}}}"
    if name in {"mi", "mn", "mo"}:
        return node.get_text().strip()
    if name == "mspace":
        return " "
    if len(tex) >= 2 and name in {"msub", "munder"}:
        return f"{tex[0]}_{{{tex[1]}}}"
    if len(tex) >= 2 and name == "mover":
        accent = _ACCENTS.get(tex[1].strip())
        return f"{accent}{{{tex[0]}}}" if accent else f"{tex[0]}^{{{tex[1]}}}"
    if len(tex) >= 2 and name == "msup":
        return f"{tex[0]}^{{{tex[1]}}}"
    if len(tex) >= 3 and name in {"msubsup", "munderover"}:
        return f"{tex[0]}_{{{tex[1]}}}^{{{tex[2]}}}"
    if len(tex) >= 2 and name == "mfrac":
        return f"\\frac{{{tex[0]}}}{{{tex[1]}}}"
    if name == "msqrt":
        return f"\\sqrt{{{''.join(tex)}}}"
    if len(tex) >= 2 and name == "mroot":
        return f"\\sqrt[{tex[1]}]{{{tex[0]}}}"
    if name == "mtable":
        return " \\\\ ".join(tex)
    if name == "mtr":
        return " & ".join(tex)
    return "".join(tex) if parts else node.get_text().strip()


def _text_with_tex(node: Tag) -> str:
    """A node's text with its formulas read once, as TeX, leaving the page as it is."""
    copy = BeautifulSoup(str(node), "html.parser")
    typeset_math_as_tex(copy)
    return copy.get_text(" ", strip=True)


def link_dense(node: Tag) -> bool:
    """Mostly links: a table of contents or a list of related posts, not prose."""
    text = len(node.get_text(" ", strip=True))
    links = sum(len(link.get_text(" ", strip=True)) for link in node.find_all("a"))
    return text == 0 or links * 2 >= text


def typeset_math_as_tex(container: Tag) -> None:
    """
    A formula as TeX in dollars, read once. KaTeX writes each one three times,
    as MathML, as its TeX source and as styled spans, which plain text runs
    together ("B∗=0.588B^* = 0.588B∗=0.588"); bare MathML flattens to
    "Wt+1=(1−ηMλM)Wt", its subscripts lost. The TeX a page carries is used
    as it is; otherwise its MathML is written out as TeX.
    """
    for node in container.select(".katex, math:not(.katex math)"):
        annotation = node.find("annotation", attrs={"encoding": "application/x-tex"})
        mathml = node if node.name == "math" else node.find("math")
        # MathJax keeps its MathML beside a rendered SVG, which must go with it.
        node = node.find_parent("mjx-container") or node
        if annotation is not None:
            tex = annotation.get_text().strip()
        elif mathml is not None and str(mathml.get("alttext") or "").strip():
            tex = str(mathml["alttext"]).strip()
        elif mathml is not None:
            tex = mathml_tex(mathml).strip()
        else:
            continue
        displays = {node.get("display"), mathml.get("display") if mathml is not None else None}
        block = bool(displays & {"block", "true"}) or node.find_parent(class_="katex-display") is not None
        fence = "$$" if block else "$"
        node.replace_with(NavigableString(f"{fence}{tex}{fence}" if tex else ""))


def extract(html: str, base_url: str, max_chars: int) -> dict[str, Any]:
    """Snapshot one page as titled, anchored sections of markdown."""
    soup = BeautifulSoup(html, "html.parser")
    info = metadata(soup, base_url)

    container = pick_container(soup)
    # Before the NOISE sweep: promote article SVGs and video iframes into
    # markdown locators, otherwise the sweep deletes the diagram and keeps
    # only its caption.
    svg_figures = preserve_media(container, base_url, document_root=soup.html)
    typeset_math_as_tex(container)
    for node in container.find_all(NOISE):
        if node.name == "aside" and container is not soup.body and not link_dense(node):
            # Inside the article an aside is a callout or a readout panel, and
            # can hold the very numbers the text points to.
            continue
        node.decompose()
    strip_permalinks(container)
    absolutize(container, base_url)

    converter = PlainConverter()
    sections: list[dict[str, Any]] = []
    seen: set[str] = set()
    budget = max_chars

    def open_section(anchor: str, title: str, level: int) -> None:
        unique = anchor
        suffix = 2
        while unique in seen:
            unique = f"{anchor}-{suffix}"
            suffix += 1
        seen.add(unique)
        sections.append(
            {"anchor": unique, "title": title, "level": level, "parts": []}
        )

    # Everything above the first heading is still article text — the abstract,
    # the byline, the opening paragraph — so it gets a section of its own rather
    # than being dropped for want of a heading to hang from.
    open_section("top", info["title"], 1)

    for block in flatten(container):
        if budget <= 0:
            break
        if isinstance(block, Tag) and block.name in HEADINGS:
            heading = block.get_text(" ", strip=True).rstrip(" #¶")
            if not heading:
                continue
            own = str(block.get("id") or "").strip()
            anchor = own if usable_anchor(own) else slugify(heading)
            open_section(anchor, heading, int(block.name[1]))
            continue
        markdown = converter.convert_soup(block) if isinstance(block, Tag) else str(block)
        markdown = re.sub(r"\n{3,}", "\n\n", markdown).strip()
        if not markdown:
            continue
        markdown = markdown[:budget]
        budget -= len(markdown)
        sections[-1]["parts"].append(markdown)

    finished = []
    for section in sections:
        body = "\n\n".join(section.pop("parts")).strip()
        if not body and section["anchor"] == "top":
            continue
        section["markdown"] = body
        section["words"] = len(body.split())
        finished.append(section)

    return {
        **info,
        "url": base_url,
        "sections": finished,
        "svgFigures": svg_figures,
        "wordCount": sum(section["words"] for section in finished),
        "truncated": budget <= 0,
    }


def flat_markdown(document: dict[str, Any]) -> str:
    """
    One readable document, for the `.txt` object every paper already stores.

    Keeps the same role the `--- Page N ---` sentinels play for PDFs: the plain
    text on disk carries its own locators, so anything reading it later knows
    where a passage came from.
    """
    parts = [f"# {document['title']}", document["url"]]
    for section in document["sections"]:
        parts.append(f"\n\n--- §{section['anchor']} · {section['title']} ---\n")
        parts.append(section["markdown"])
    return "\n".join(parts).strip()


def outline(document: dict[str, Any], limit: int = 60) -> str:
    """
    The cheap map of a page: what is in it and where, without the text.

    This is the whole token argument for web documents. A 15,000-word post is
    ~20k tokens on every single turn if it is attached; as an outline it is a few
    hundred, and the model spends the rest only on the sections it decides to
    open.
    """
    lines = []
    for section in document["sections"][:limit]:
        indent = "  " * max(0, section["level"] - 1)
        lines.append(
            f"  {indent}{section['anchor']} · {section['title']} · "
            f"{section['words']}w"
        )
    if len(document["sections"]) > limit:
        lines.append(f"  …and {len(document['sections']) - limit} more sections")
    return "\n".join(lines)
