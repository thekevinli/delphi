import json
import os
from io import BytesIO
from typing import Literal

import httpx
import pytest
from fastapi import HTTPException
from pypdf import PdfWriter
from pydantic import ValidationError

from delphi_core.config import Settings
from delphi_core.deps import get_settings
from delphi_core.main import app
from delphi_core.routers.projects import extract_pdf_snapshot, remote_pdf_filename
from delphi_core.storage import LocalObjectStore, LocalStorage, paper_key
from delphi_core.web_extract import (
    PROSE_MIN_CHARS,
    extract,
    flat_markdown,
    outline,
    readable_text_length,
    slugify,
    static_document,
)
from delphi_core.web_fetch import (
    PDF_URL_DETAIL,
    FetchedResource,
    check_public_host,
    describe_failure,
    fetch_resource,
    normalise_url,
    set_shared_web_client,
)
from delphi_core.security import (
    make_navigation_token,
    make_page_token,
    read_navigation_token,
    read_page_token,
)
from delphi_core.web_proxy import (
    FRAME_ALLOW,
    bridge_source,
    frame_headers,
    is_frame_request,
    render_frame,
    sandbox_flags,
)

from tests.helpers import seed_paper

# A post shaped like the ones this feature was built for: heading ids the site's
# own table of contents links to, math left as raw LaTeX, and a `<figure>` that
# is never closed.
POST = """
<!doctype html>
<html>
  <head>
    <title>Scaling Laws, Carefully | Lil'Log</title>
    <meta property="og:title" content="Scaling Laws, Carefully">
    <meta name="author" content="Lilian Weng">
    <meta property="article:published_time" content="2026-06-24T00:00:00+00:00">
    <link rel="icon" href="/favicon_wine.ico">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'">
  </head>
  <body>
    <nav><a href="/posts">Posts</a><a href="/archive">Archive</a></nav>
    <article class="post-single">
      <p>Scaling laws relate loss $L$ to model size $N$ and data $D$.</p>
      <h1 id="early-days">Early days<a class="anchor" href="#early-days">#</a></h1>
      <p>Loss was predictable long before transformers.</p>
      <h2 id="chinchilla">Chinchilla<a class="anchor" href="#chinchilla">#</a></h2>
      <p>Fit $N_{opt}$ and $D_{opt}$ jointly. See <a href="/refs/hoffmann">Hoffmann</a>.</p>
      <figure><img src="../figures/isoflop.png" alt="IsoFLOP profiles">
      <h2>Why power law?</h2>
      <p>Because manifolds partition.</p>
    </article>
    <footer>© Lil'Log</footer>
  </body>
</html>
"""

BASE = "https://lilianweng.github.io/posts/2026-06-24-scaling-laws/"


def linked_pdf() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_metadata({"/Title": "A Linked Paper"})
    buffer = BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def document() -> dict:
    return extract(POST, BASE, 600_000)


# --- extraction ------------------------------------------------------


def test_sections_are_keyed_by_the_pages_own_heading_ids():
    sections = {item["anchor"]: item for item in document()["sections"]}

    # The page's ids win over a slug we would have generated, because those are
    # the ids the live DOM carries and therefore the ones a citation can land on.
    assert "early-days" in sections
    assert "chinchilla" in sections
    assert sections["chinchilla"]["title"] == "Chinchilla"
    # No id to borrow, so the slug has to match what the generator would emit.
    assert "why-power-law" in sections


def test_a_framework_generated_id_is_not_used_as_a_citable_anchor():
    """
    A page's own id is preferred, but only when the page chose it.

    React mints `:r2r:` at render time: a different string on the next render
    and not a legal URL fragment, so a section cited by one would be uncitable
    and, after a refresh of the same page, point at nothing. This is what a
    rendered Notion page hands back for every heading.
    """
    html = (
        "<html><body><article>"
        "<h1 id=':r2r:'>The Mismatch Problem</h1><p>Body.</p>"
        "<h2 id='real-anchor'>How to Fix It</h2><p>More.</p>"
        "</article></body></html>"
    )

    anchors = [item["anchor"] for item in extract(html, BASE, 600_000)["sections"]]

    assert "the-mismatch-problem" in anchors
    # An id the page really did choose is still the better citation target.
    assert "real-anchor" in anchors


def test_content_before_the_first_heading_becomes_its_own_section():
    top = document()["sections"][0]

    assert top["anchor"] == "top"
    assert "Scaling laws relate loss" in top["markdown"]


def test_an_unclosed_figure_does_not_swallow_the_rest_of_the_article():
    """
    `<figure>` has no implied end tag, so a browser nests every later section
    inside it. Trusting the tag to be a leaf loses two thirds of such a page.
    """
    anchors = [item["anchor"] for item in document()["sections"]]

    assert anchors.index("why-power-law") > anchors.index("chinchilla")
    assert "Because manifolds partition." in (
        next(i for i in document()["sections"] if i["anchor"] == "why-power-law")[
            "markdown"
        ]
    )


def test_permalink_glyphs_are_stripped_from_titles():
    titles = [item["title"] for item in document()["sections"]]

    assert "Early days" in titles
    assert not any(title.endswith("#") for title in titles)


def test_svg_figures_and_video_iframes_survive_as_citable_locators():
    """
    Research posts put the architecture diagram in an inline SVG and the demos
    in Vimeo iframes. Both tags are on the NOISE list (chrome), so without a
    preserve pass the snapshot kept "Figure 1. …" as text and threw away the
    diagram — which is exactly how the DVA Memory page ended up with a dead
    figure embed and no picture.
    """
    from delphi_core.web_extract import INLINE_HTML_PREFIX, extract

    html = """
    <html><body><article>
      <h1 id="intro">Intro</h1>
      <p>Opening.</p>
      <figure>
        <svg viewBox="0 0 880 340" class="w-full h-auto">
          <defs>
            <marker id="arr" markerHeight="6" markerWidth="7" refX="7" refY="3">
              <path d="M0 0 L6 3 L0 5"/>
            </marker>
          </defs>
          <text x="10" y="20">DIRECT VIDEO-ACTION MODEL</text>
        </svg>
        <figcaption>Figure 1. The loop.</figcaption>
      </figure>
      <p>Then a demo:</p>
      <iframe src="https://player.vimeo.com/video/123" title="Robot demo"></iframe>
      <video src="https://cdn.example.test/rollout.mp4" title="Rollout"></video>
      <p>Lazy chart:</p>
      <img data-src="/images/chart.webp" alt="Chart"/>
      <!-- Icons must not become figures. -->
      <svg viewBox="0 0 16 16"><path d="M0 0h16v16"/></svg>
      <!-- Diagram without a figure wrapper still counts. -->
      <svg viewBox="0 0 400 200" aria-label="Training amortisation">
        <rect width="400" height="200"/>
      </svg>
    </article></body></html>
    """
    result = extract(html, "https://example.test/post", 600_000)
    text = flat_markdown(result)

    assert len(result["svgFigures"]) == 2
    assert result["svgFigures"][0]["id"] == f"{INLINE_HTML_PREFIX}0"
    assert "Figure 1. The loop." in result["svgFigures"][0]["caption"]
    # Even a visible SVG can depend on selectors in the article stylesheet,
    # so the snapshot keeps it in inert page context.
    stored = result["svgFigures"][0]["html"]
    assert 'viewbox="0 0 880 340"' in stored
    assert "DIRECT VIDEO-ACTION MODEL" in stored
    assert f"]({INLINE_HTML_PREFIX}0)" in text
    assert f"]({INLINE_HTML_PREFIX}1)" in text
    assert "Training amortisation" in result["svgFigures"][1]["caption"]
    assert "https://player.vimeo.com/video/123" in text
    assert "Robot demo" in text
    assert "https://cdn.example.test/rollout.mp4" in text
    # Lazy-loaded raster promoted onto src, then absolutized.
    assert "https://example.test/images/chart.webp" in text
    # The raw tags must not leak into the markdown the model reads.
    assert "<svg" not in text
    assert "<iframe" not in text
    assert "<video" not in text


def test_a_compound_html_diagram_is_not_reduced_to_its_hidden_svg_layer():
    """An aria-hidden SVG is presentation, even when its viewBox is enormous."""
    from delphi_core.web_extract import INLINE_HTML_PREFIX, extract, flat_markdown

    html = """
    <html onpageshow="steal()"><head>
      <meta http-equiv="refresh" content="0;url=https://wrong.example/">
      <link rel="preload" href="/assets/noise.js">
      <link rel="stylesheet" href="/assets/diagram.css" media="print"
            onload="this.media='all'">
      <script>removeTheServerRenderedDiagram()</script>
    </head><body onload="mutate()"><main id="main" class="post"><article class="content">
      <h1>Interaction models</h1>
      <figure class="interaction-model-figure">
        <div class="interaction-model-panel">
          <div class="interaction-model-diagram" role="img"
               aria-label="A user, interaction model, and background model.">
            <svg class="interaction-model-arrows" viewBox="0 0 1600 1015"
                 aria-hidden="true" focusable="false">
              <path d="M 300 700 H 445"></path>
            </svg>
            <div class="interaction-model-node">user</div>
            <div class="interaction-model-node">interaction model</div>
            <div class="interaction-model-node">background model</div>
          </div>
        </div>
        <figcaption>The live loop and its asynchronous worker.</figcaption>
      </figure>
    </article></main></body></html>
    """

    result = extract(html, "https://example.test/post", 600_000)
    figures = result["svgFigures"]
    text = flat_markdown(result)

    assert len(figures) == 1
    assert figures[0]["id"] == f"{INLINE_HTML_PREFIX}0"
    assert "interaction-model-node" in figures[0]["html"]
    assert "interaction model" in figures[0]["html"]
    assert 'id="main"' in figures[0]["html"]
    assert 'class="content"' in figures[0]["html"]
    assert 'href="https://example.test/post"' in figures[0]["html"]
    assert 'href="/assets/diagram.css"' in figures[0]["html"]
    assert 'media="all"' in figures[0]["html"]
    assert "removeTheServerRenderedDiagram" not in figures[0]["html"]
    assert "http-equiv=\"refresh\"" not in figures[0]["html"]
    assert "nois" not in figures[0]["html"]
    assert "onload=" not in figures[0]["html"]
    assert "onpageshow=" not in figures[0]["html"]
    assert "Content-Security-Policy" in figures[0]["html"]
    assert "figcaption" not in figures[0]["html"]
    assert f"]({INLINE_HTML_PREFIX}0)" in text


def test_a_css_dependent_accessible_svg_uses_page_context():
    """A role=img SVG can still get every fill and stroke from external CSS."""
    from delphi_core.web_extract import INLINE_HTML_PREFIX, extract, flat_markdown

    result = extract(
        """
        <html><head><link rel="stylesheet" href="/article.css"></head>
        <body><article><h1>Interfacer</h1>
          <figure class="architecture">
            <svg class="interfacer-architecture-svg" role="img"
                 aria-label="Interfacer architecture" viewBox="0 52 620 482">
              <g class="node"><rect width="100" height="50"/></g>
              <path class="edge" d="M0 0L100 100"/>
            </svg>
            <figcaption>The interfacer sits between two models.</figcaption>
          </figure>
        </article></body></html>
        """,
        "https://example.test/post",
        600_000,
    )

    assert [item["id"] for item in result["svgFigures"]] == [
        f"{INLINE_HTML_PREFIX}0"
    ]
    assert "interfacer-architecture-svg" in result["svgFigures"][0]["html"]
    assert "article.css" in result["svgFigures"][0]["html"]


def test_a_real_image_wins_over_a_decorative_svg():
    from delphi_core.web_extract import extract, flat_markdown

    result = extract(
        """
        <html><body><article><h1>Results</h1><p>Enough prose for extraction.</p>
          <figure role="img" aria-label="Result chart">
            <img src="/real.png" alt="Measured result">
            <svg viewBox="0 0 500 300" aria-hidden="true"><path d="M0 0"/></svg>
            <figcaption>Measured result.</figcaption>
          </figure>
        </article></body></html>
        """,
        "https://example.test/post",
        600_000,
    )

    assert result["svgFigures"] == []
    assert "https://example.test/real.png" in flat_markdown(result)


def test_a_semantic_html_only_figure_is_capturable():
    from delphi_core.web_extract import INLINE_HTML_PREFIX, extract, flat_markdown

    result = extract(
        """
        <html><head><style>.bar{height:12px;background:skyblue}</style></head>
        <body><article><h1>Benchmark</h1><p>Detailed benchmark results follow.</p>
          <figure aria-label="Benchmark accuracy by task">
            <div class="row"><span>Time awareness</span><div class="bar"></div></div>
            <div class="row"><span>Visual counting</span><div class="bar"></div></div>
          </figure>
        </article></body></html>
        """,
        "https://example.test/post",
        600_000,
    )

    assert [item["id"] for item in result["svgFigures"]] == [
        f"{INLINE_HTML_PREFIX}0"
    ]
    assert ".bar" in result["svgFigures"][0]["html"]
    assert f"]({INLINE_HTML_PREFIX}0)" in flat_markdown(result)


def test_inline_figure_count_and_total_markup_are_bounded(monkeypatch):
    from delphi_core import web_extract

    figures = "".join(
        f'<figure><svg viewBox="0 0 400 200" aria-label="Figure {index}">'
        '<rect width="400" height="200"/></svg></figure>'
        for index in range(15)
    )
    result = web_extract.extract(
        f"<html><body><article><h1>Many</h1><p>{'x' * 240}</p>{figures}</article></body></html>",
        "https://example.test/post",
        600_000,
    )
    assert len(result["svgFigures"]) == web_extract.INLINE_FIGURE_MAX_COUNT

    monkeypatch.setattr(web_extract, "INLINE_FIGURE_MAX_COUNT", 12)
    monkeypatch.setattr(web_extract, "INLINE_FIGURE_MAX_BYTES", 1_000)
    monkeypatch.setattr(
        web_extract,
        "_standalone_html_figure",
        lambda *_args, **_kwargs: "<html>" + "x" * 590 + "</html>",
    )
    bounded = web_extract.extract(
        f"<html><body><article><h1>Many</h1><p>{'x' * 240}</p>{figures}</article></body></html>",
        "https://example.test/post",
        600_000,
    )
    assert len(bounded["svgFigures"]) == 1


def test_a_hidden_svg_without_an_accessible_compound_figure_is_not_citable():
    from delphi_core.web_extract import extract, flat_markdown

    result = extract(
        """
        <html><body><article><h1>Post</h1>
          <figure>
            <svg viewBox="0 0 1600 900" aria-hidden="true">
              <path d="M0 0h1600v900"/>
            </svg>
            <figcaption>Routing overlay.</figcaption>
          </figure>
        </article></body></html>
        """,
        "https://example.test/post",
        600_000,
    )

    assert result["svgFigures"] == []
    assert "Routing overlay." in flat_markdown(result)


def test_normalize_svg_document_restores_xml_casing_for_img_rendering():
    """
    The failure mode this pins: soup serializes `viewBox` as `viewbox`, an
    `<img>` ignores it, and a wide diagram is cropped to 300×150.
    """
    from delphi_core.web_extract import normalize_svg_document, svg_dimensions

    broken = (
        '<svg class="w-full h-auto" viewbox="0 0 880 340">'
        '<defs><marker markerheight="6" markerwidth="7" refx="7" refy="3">'
        "<path d='M0 0'/></marker></defs>"
        "<text>DIRECT VIDEO-ACTION MODEL</text></svg>"
    )
    fixed = normalize_svg_document(broken)
    assert 'viewBox="0 0 880 340"' in fixed
    assert "viewbox=" not in fixed
    assert 'markerHeight="6"' in fixed
    assert 'refX="7"' in fixed
    assert "xmlns=" in fixed
    assert 'class="w-full h-auto"' in fixed
    assert svg_dimensions(fixed) == (880, 340)

def test_navigation_and_footer_are_not_treated_as_article_text():
    text = flat_markdown(document())

    assert "Archive" not in text
    assert "© Lil'Log" not in text


def test_metadata_and_relative_urls_resolve_against_the_page():
    result = document()

    assert result["title"] == "Scaling Laws, Carefully"
    assert result["byline"] == "Lilian Weng"
    assert result["favicon"] == "https://lilianweng.github.io/favicon_wine.ico"
    assert "https://lilianweng.github.io/refs/hoffmann" in flat_markdown(result)


@pytest.mark.parametrize(
    "href", ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>"]
)
def test_a_page_cannot_choose_a_scripted_favicon(href):
    """The favicon is stored on the record and later becomes an `<img src>`."""
    hostile = POST.replace('href="/favicon_wine.ico"', f'href="{href}"')

    favicon = extract(hostile, BASE, 600_000)["favicon"]

    assert favicon == "https://lilianweng.github.io/favicon.ico"


def test_math_survives_extraction_unescaped():
    """Escaping `_` for a markdown round trip would mangle every subscript."""
    text = flat_markdown(document())

    assert "$N_{opt}$" in text
    assert "\\_" not in text


def test_katex_formulas_read_once_as_their_tex():
    """KaTeX keeps MathML, TeX and styled spans; read together they triple every formula."""
    def katex(tex, shown):
        return (f'<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>{shown}</mi></mrow>'
                f'<annotation encoding="application/x-tex">{tex}</annotation></semantics></math></span>'
                f'<span class="katex-html" aria-hidden="true"><span class="mord">{shown}</span></span></span>')
    inline, display = katex("B^* = 0.588", "B∗=0.588"), katex("\\eta = 59.3\\%", "η=59.3%")
    body = (f"<p>The tuned optimum is {inline} on this problem, reached in every run we tried.</p>"
            f'<p>Its share is <span class="katex-display">{display}</span> of the budget.</p>'
            "<p>Bare MathML keeps its own text: <math><mi>x</mi><mo>+</mo><mn>1</mn></math> here.</p>")
    text = flat_markdown(extract(f"<html><head><title>T</title></head><body><article><h1>T</h1>{body}</article></body></html>", "https://x.test/", 20_000))
    assert "$B^* = 0.588$ on this problem" in text and "B∗=0.588" not in text
    assert "$$\\eta = 59.3\\%$$" in text and "η=59.3%" not in text
    assert "$x+1$" in text


def test_a_formulas_drawn_glyphs_are_never_taken_for_figures():
    """KaTeX draws a root sign as a wide SVG and MathJax a whole formula; neither is a diagram."""
    root = ('<span class="katex"><span class="katex-mathml"><math><semantics><msqrt><mi>x</mi></msqrt>'
            '<annotation encoding="application/x-tex">\\sqrt{x}</annotation></semantics></math></span>'
            '<span class="katex-html" aria-hidden="true"><svg viewBox="0 0 400000 1080" width="400em"><path d="M95,702"/></svg></span></span>')
    mathjax = ('<mjx-container display="true"><svg viewBox="0 -750 4000 1000" aria-label="E equals m c squared"><path d="M1 1"/></svg>'
               '<mjx-assistive-mml><math alttext="E = mc^2"><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></math></mjx-assistive-mml></mjx-container>')
    spaced = "<math><mi>f</mi><mo>=</mo><mi>x</mi><mtext> if </mtext><mi>y</mi><mo>&gt;</mo><mn>0</mn><mi>sin</mi><mi>x</mi><mi>loss</mi></math>"
    label = root.replace("\\sqrt{x}", "\\alpha").replace("<msqrt><mi>x</mi></msqrt>", "<mi>α</mi>")
    diagram = (f'<figure><svg viewBox="0 0 400 200" aria-label="Pipeline stages"><rect width="400" height="200"/></svg>'
               f'<div class="overlay">{label}</div><figcaption>Figure 1. Step size {label}.</figcaption></figure>')
    priced = "<math><mtext>cost in $ at 50%</mtext></math>"
    html = (f"<html><head><title>T</title></head><body><article><h1>T</h1><p>The root {root} grows.</p>"
            f"<p>Energy {mathjax} holds.</p><p>Then {spaced}.</p><p>So {priced}.</p>{diagram}</article></body></html>")
    result = extract(html, "https://x.test/", 20_000)
    text = flat_markdown(result)
    assert [figure["caption"] for figure in result["svgFigures"]] == ["Figure 1. Step size $\\alpha$ ."]
    # The saved figure keeps its typeset labels; only the text reads them as TeX.
    assert 'class="katex"' in result["svgFigures"][0]["html"] and "$\\alpha$" not in result["svgFigures"][0]["html"]
    assert "$\\sqrt{x}$ grows" in text and "$$E = mc^2$$ holds" in text
    assert "$\\text{cost in \\$ at 50\\%}$" in text
    assert "$f=x\\text{ if }y>0\\sin x\\mathrm{loss}$" in text


def test_an_asides_readout_inside_the_article_is_kept_and_a_link_list_is_not():
    """The numbers a post points to can live in a panel beside the text."""
    filler = "<p>" + "The learning rate follows the batch size along a power law in every run. " * 4 + "</p>"
    html = ("<html><head><title>T</title></head><body><aside><a href='/a'>Home</a> <a href='/b'>About</a></aside><article><h1>T</h1>"
            f"{filler}<aside><span>Fitted learning rate exponent</span><strong>0.588</strong></aside>"
            "<aside><a href='/x'>Related post one</a> <a href='/y'>Related post two</a></aside>"
            "<math display='block'><msub><mi>W</mi><mrow><mi>t</mi><mo>+</mo><mn>1</mn></mrow></msub></math>"
            f"{filler}</article></body></html>")
    text = flat_markdown(extract(html, "https://x.test/", 20_000))
    assert "Fitted learning rate exponent" in text and "0.588" in text
    assert "Related post" not in text and "About" not in text
    assert "$$W_{t+1}$$" in text


def test_the_outline_carries_structure_and_never_prose():
    """
    The whole token argument for web documents. The outline has to stay the same
    size whether a section is one paragraph or four thousand words, which is
    only true if no body text leaks into it.
    """
    small = document()
    big = document()
    for section in big["sections"]:
        section["markdown"] += " padding" * 5_000

    assert outline(small) == outline(big)
    assert "chinchilla · Chinchilla" in outline(small)
    assert "manifolds partition" not in outline(small)
    assert len(outline(big)) < len(flat_markdown(big)) / 100


def test_slugify_matches_the_usual_generator_output():
    assert slugify("Why power law?") == "why-power-law"
    assert slugify("Method 1: Fix model sizes") == "method-1-fix-model-sizes"


# --- fetching --------------------------------------------------------


def test_bare_hosts_and_credentials_are_normalised_away():
    assert normalise_url("lilianweng.github.io") == "https://lilianweng.github.io"
    assert "secret" not in normalise_url("https://user:secret@example.com/a")
    assert normalise_url("https://example.com/a#frag") == "https://example.com/a"


@pytest.mark.parametrize("scheme", ["file:///etc/passwd", "ftp://example.com"])
def test_only_http_addresses_are_accepted(scheme):
    with pytest.raises(HTTPException) as caught:
        normalise_url(scheme)

    assert caught.value.status_code == 422


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8000/api/health",
        "http://localhost:8000/",
        "http://169.254.169.254/computeMetadata/v1/",
        "http://[::1]/",
    ],
)
def test_addresses_inside_the_deployment_are_refused(url):
    """Without this, "add a page" is a request-forgery primitive."""
    with pytest.raises(HTTPException) as caught:
        check_public_host(url)

    assert caught.value.status_code == 422
    assert "not reachable" in caught.value.detail


@pytest.mark.parametrize(("address", "carried"), [
    ("::ffff:127.0.0.1", "127.0.0.1"), ("2002:7f00:1::1", "127.0.0.1"), ("2002:a00:1::", "10.0.0.1"),
    ("64:ff9b::a9fe:a9fe", "169.254.169.254"), ("64:ff9b:1::a00:1", "10.0.0.1"),
])
def test_an_embedded_ipv4_address_is_judged_itself_on_every_python(address, carried):
    """Python before 3.12.4 and 3.11.10 calls 6to4 space global whatever it carries."""
    import ipaddress
    from delphi_core.web_fetch import _embedded_ipv4, is_public_address

    assert _embedded_ipv4(ipaddress.IPv6Address(address)) == ipaddress.IPv4Address(carried)
    assert not is_public_address(address)
    assert _embedded_ipv4(ipaddress.IPv6Address("2606:4700::1111")) is None


@pytest.mark.parametrize("address", [
    "100.64.0.0", "100.64.0.1", "100.127.255.255",
    "fec0::", "fec0::1", "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "::ffff:100.64.0.1", "224.0.0.1", "ff02::1",
    # NAT64 and 6to4 carry an IPv4 address that a gateway would dial for us.
    "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1",
])
def test_public_host_refuses_nonpublic_answers_even_alongside_a_public_one(monkeypatch, address):
    import socket
    import delphi_core.web_fetch as web_fetch

    def resolved(*_args, **_kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 80)),
            (socket.AF_INET6 if ":" in address else socket.AF_INET,
             socket.SOCK_STREAM, 6, "", (address, 80)),
        ]

    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", resolved)
    with pytest.raises(HTTPException) as caught:
        check_public_host("https://source.example/article")
    assert caught.value.status_code == 422


@pytest.mark.parametrize("address", ["8.8.8.8", "2606:4700:4700::1111"])
def test_public_host_accepts_public_ipv4_and_ipv6(monkeypatch, address):
    import socket
    import delphi_core.web_fetch as web_fetch

    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (family, socket.SOCK_STREAM, 6, "", (address, 443)),
    ])
    check_public_host("https://source.example/article")


@pytest.mark.parametrize("address, expected", [
    ("100.64.0.0", None), ("100.127.255.255", None), ("8.8.8.8", "8.8.8.8"),
])
def test_browser_pin_rechecks_its_second_dns_answer(monkeypatch, address, expected):
    import socket
    import delphi_core.browser_render as browser_render

    # The first check is public; pinning must independently refuse a later
    # nonpublic answer instead of trusting the earlier DNS result.
    answers = iter(["8.8.8.8", address])
    monkeypatch.setattr(browser_render.socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", (next(answers), 443)),
    ])
    assert browser_render._pinned_public_address("source.example", 443) == expected


@pytest.mark.parametrize("address", ["100.64.0.1", "fec0::1"])
def test_browser_pin_refuses_shared_and_site_local_hosts(monkeypatch, address):
    import socket
    import delphi_core.browser_render as browser_render

    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    monkeypatch.setattr(browser_render.socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (family, socket.SOCK_STREAM, 6, "", (address, 443)),
    ])
    with pytest.raises(HTTPException) as caught:
        browser_render._pinned_public_address("source.example", 443)
    assert caught.value.status_code == 422


def test_a_pdf_is_reported_as_a_choice_before_its_body_is_accepted(monkeypatch):
    """
    Detection is not rejection: the first request gives the UI a typed hint,
    and the explicit web-page choice accepts the same response as a resource.
    """
    import asyncio
    import delphi_core.web_fetch as web_fetch

    payload = linked_pdf()
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"Content-Type": "application/pdf"},
            content=payload,
            request=request,
        )
    )
    real_client = httpx.AsyncClient

    def mock_client(*args, **kwargs):
        return real_client(*args, **{**kwargs, "transport": transport})

    monkeypatch.setattr(web_fetch, "check_public_host", lambda url: None)
    monkeypatch.setattr(web_fetch.httpx, "AsyncClient", mock_client)

    with pytest.raises(HTTPException) as choice:
        asyncio.run(fetch_resource("https://arxiv.org/pdf/2601.16208v1", Settings()))

    assert choice.value.status_code == 409
    assert choice.value.detail == PDF_URL_DETAIL

    accepted = asyncio.run(
        fetch_resource(
            "https://arxiv.org/pdf/2601.16208v1",
            Settings(),
            include_pdf=True,
        )
    )
    assert accepted.content_type == "application/pdf"
    assert accepted.body == payload


def test_a_linked_pdf_becomes_page_addressed_chat_sections():
    resource = FetchedResource(
        url="https://arxiv.org/pdf/2601.16208v1",
        body=linked_pdf(),
        content_type="application/pdf",
        encoding="utf-8",
        fetched_at="2026-07-30T00:00:00+00:00",
    )

    snapshot = extract_pdf_snapshot(resource, max_pages=100, max_chars=600_000)

    assert snapshot["title"] == "A Linked Paper"
    assert snapshot["sections"][0]["anchor"] == "page-1"
    assert snapshot["contentType"] == "application/pdf"
    assert remote_pdf_filename(resource.url) == "2601.16208v1.pdf"


# --- the frame -------------------------------------------------------


def test_render_frame_rewrites_for_embedding():
    html = render_frame(POST, BASE)

    from bs4 import BeautifulSoup
    head = BeautifulSoup(html, "html.parser").head
    assert head.find("base")["href"] == BASE
    # Each node the frame adds is marked, so a copy serialised from the frame
    # can shed them rather than save a second set.
    assert all(node.has_attr("data-delphi-frame") for node in head.find_all(["base", "script"]))
    assert head.find("meta", attrs={"name": "referrer"}).has_attr("data-delphi-frame")
    # The page's own CSP would block the bridge, and on some sites the frame.
    assert "default-src 'none'" not in html
    assert 'content="no-referrer"' in html
    assert "delphi-page" in html


def test_the_bridge_runs_before_the_pages_own_scripts():
    """
    The shims are only useful if they are installed before a framework touches
    storage or history, so the bridge goes in the head rather than the body.
    """
    html = render_frame(POST, BASE)

    assert html.index("delphi-page") < html.index("</head>")


def test_the_bridge_shims_what_an_opaque_origin_takes_away():
    """
    Denying `allow-same-origin` makes localStorage, cookies and the History API
    throw, and every client-rendered site touches one while booting — so without
    these a React or Next page returns good HTML and dies during hydration.
    """
    source = render_frame(POST, BASE)

    for api in ("localStorage", "sessionStorage", "cookie", "pushState", "replaceState"):
        assert api in source


def test_a_document_we_served_identifies_itself_first():
    """
    Blocking link clicks only covers one escape route. A `<button>` that sets
    `location.href` — Substack's Subscribe control — takes the frame off Delphi
    without a link ever being clicked, and `window.location` is unforgeable so
    that assignment cannot be intercepted at all.

    So the invariant is checked from the other side: our documents say hello
    while they parse, a foreign one never does, and the panel restores anything
    that lands without greeting it. The greeting has to come before the page's
    own scripts, or a page could be navigating away before we know it arrived.
    """
    source = bridge_source()
    html = render_frame(POST, BASE)

    assert 'post({ type: "hello" })' in source
    assert html.index("delphi-page") < html.index("</head>")
    # Ahead of the shims, the path rewrite and every listener.
    assert source.index('post({ type: "hello" })') < source.index("memoryStorage")


def test_each_served_document_authenticates_its_bridge_messages_with_a_nonce():
    source = bridge_source()

    assert "crypto.getRandomValues" in source
    assert "message.nonce = DOCUMENT_NONCE" in source
    # Parent commands authenticate by their WindowProxy and do not reveal the
    # nonce back to page script, which could otherwise replay it.
    assert "event.source !== parent" in source
    assert 'data.nonce !== DOCUMENT_NONCE' not in source


def test_the_frame_follows_only_trusted_reading_navigation():
    """
    Scripted navigation never earns the parent's destination-mint capability,
    while a real unmodified left click and a same-document fragment stay in the
    reading surface.
    """
    source = bridge_source()

    assert "event.isTrusted" in source
    assert 'post({ type: "external-link", href: there.href })' in source
    assert 'post({ type: "navigate", href: there.href })' in source
    assert 'href.indexOf("javascript:") === 0' in source
    assert "event.userInitiated" in source
    assert "there.pathname === here.pathname" in source
    assert "there.search === here.search" in source


def test_a_file_dropped_on_a_page_is_handed_to_the_app():
    """
    Drag events do not cross a frame boundary, so while a file is held over the
    reader the app's own window-level listeners hear nothing: the drop lands in
    the page or nowhere. Unclaimed, the browser then navigates the frame to the
    file and the page is lost — so the gesture is caught here and handed up,
    state and file both, and a PDF can be dropped anywhere in the window.
    """
    source = bridge_source()

    assert '"Files"' in source
    for event in ("dragenter", "dragover", "dragleave", "drop"):
        assert 'window.addEventListener(\n    "%s"' % event in source
    # Claimed on dragover, or the browser refuses the drop and navigates instead.
    assert 'event.dataTransfer.dropEffect = "copy"' in source
    # The file itself crosses as a structured clone; the app does the vetting.
    assert 'post({ type: "file-drop", file: file })' in source
    # Overlay only for a PDF — an image over the frame must not paint it.
    assert 'post({ type: "drag", over: over && carriesPdf(event) })' in source


def test_pinching_magnifies_and_never_reflows():
    """
    The two gestures must stay apart. A pinch asks to look closer at the page as
    laid out — so it scales the rendered surface and pans, and anything that
    re-lays-out per wheel tick would both change the wrong thing and judder. The
    −/+ control is the one that reflows, and it arrives as a message.
    """
    source = bridge_source()

    assert "event.ctrlKey" in source
    # Claimed, or the browser magnifies the whole of Delphi instead.
    assert "event.preventDefault()" in source
    # Magnification is a transform; the reflowing `zoom` is never touched here.
    assert "magnifyAt(" in source
    assert "event.clientX" in source and "event.clientY" in source
    assert 'body.style.transform = scale === 1 ? "" : "scale(" + scale + ")"' in source
    # Past the floor the page gives like a rubber band, held for as long as the
    # gesture lasts and released slowly — never a bounce fired off on its own.
    assert "settleFloor" in source
    assert "PINCH_HOLD_MS" in source


def test_the_reflowing_zoom_is_only_ever_the_panels_control():
    source = bridge_source()

    zoom_writes = source.count("documentElement.style.zoom")

    assert zoom_writes == 1
    assert 'data.type === "set-zoom"' in source


def test_a_stored_dom_is_fitted_to_the_frame_without_reflowing(tmp_path):
    """
    A Notion page is laid out at 1512px and then framed at whatever the panel
    is. The baked column does not reflow, so the headline is clipped and the
    left side is empty margin. The stamp says the build width; `page-url`
    hands it to the panel so the iframe can be that wide and scaled to fit.
    Live pages have no stamp and are left to reflow as themselves.
    """
    from fastapi.testclient import TestClient

    from delphi_core.browser_render import stamp_render_width

    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id, paper_id = web_project(settings, client)
            objects = LocalObjectStore(settings.data_dir)
            objects.put_text(
                paper_key("reader", project_id, paper_id, "web"),
                json.dumps({"savedDom": stamp_render_width("<html lang='en'><body></body></html>", 1512)}),
            )
            body = client.get(
                f"/api/projects/{project_id}/papers/{paper_id}/page-url?view=cached"
            ).json()
    finally:
        app.dependency_overrides.clear()

    assert body["renderWidth"] == 1512


def test_a_notion_tab_title_is_not_the_article_title():
    from delphi_core.web_extract import clean_page_title

    assert (
        clean_page_title(
            "Your Efficient RL Framework Secretly Brings You Off-Policy RL Training | Notion"
        )
        == "Your Efficient RL Framework Secretly Brings You Off-Policy RL Training"
    )
    assert clean_page_title("Diffusion Language Models are Super Data Learners") == (
        "Diffusion Language Models are Super Data Learners"
    )
    prose = "<p>" + ("Real article text. " * 20) + "</p>"
    document = extract(
        "<html><head><title>The Article | Notion</title>"
        '<meta property="og:title" content="The Article | Notion">'
        f"</head><body><article><h1 id='t'>The Article</h1>{prose}"
        "</article></body></html>",
        "https://writer.notion.site/the-article",
        600_000,
    )
    assert document["title"] == "The Article"


@pytest.mark.parametrize("head", [
    "<title>{title}</title>",
    '<meta property="og:title" content="{title}">',
    '<meta name="twitter:title" content="{title}">',
])
@pytest.mark.parametrize("title, expected", [
    ("Rényi bo\x00und\x1b[0m | Notion", "Rényi bound"),
    ("\x00", "example.test"),
])
def test_extracted_web_titles_are_safe_even_when_the_title_fallback_is_used(head, title, expected):
    document = extract(
        "<html><head>" + head.format(title=title) + "</head>"
        "<body><article><p>" + "Real article text. " * 20
        + "</p></article></body></html>",
        "https://example.test/article", 600_000,
    )
    assert document["title"] == expected


def test_a_frozen_notion_page_is_the_article_not_the_product():
    """
    A public Notion page is the article wrapped in the product.

    The tab title ends in "| Notion", the topbar sells "Get Notion free", and
    overlay hosts sit in the markup with nothing to overlay. Framed as-is, the
    reader is a Notion window; photographed as-is, the card is the topbar.
    Scripts already come out here; the product chrome has to as well, or the
    freeze is a screenshot of the app around the page.
    """
    frozen = static_document(
        "<html><head><title>The Article | Notion</title></head><body>"
        '<header><div class="notion-topbar">Get Notion free</div></header>'
        '<div class="notion-overlay-container">modal</div>'
        '<article class="notion-page-content"><h1>The Article</h1>'
        "<p>The body the reader came for.</p></article></body></html>"
    )

    assert "Get Notion free" not in frozen
    assert "notion-topbar" not in frozen
    assert "notion-overlay-container" not in frozen
    assert "<header>" not in frozen
    assert "The Article" in frozen
    assert "| Notion" not in frozen
    assert "notion-page-content" in frozen


def test_a_blog_header_survives_freezing():
    frozen = static_document(
        "<html><head><title>Post | Lil'Log</title></head>"
        "<body><header><h1>Post</h1></header>"
        "<article><p>Hi from the post.</p></article></body></html>"
    )

    assert "<header>" in frozen
    assert "Post | Lil'Log" in frozen


def test_nothing_cuts_a_slow_page_short():
    """
    The only timing here is when to *look* at whether a page rendered, and it
    looks more than once so an animation-heavy page is not written off early.
    """
    source = bridge_source()

    assert "SETTLE_CHECKS = [1500, 4000, 9000, 20000]" in source


def test_a_page_is_announced_readable_before_it_is_finished():
    """
    Readable and finished are different moments, and the panel wants the first.

    `load` waits for everything a page pulls -- MathJax, an analytics beacon, a
    comment embed, thirty images below the fold. Announcing only then held the
    reader panel's overlay over an article that had been on screen for seconds:
    measured on a real post, `ready` moved from 3.6s (warm) or ~9s (cold) to
    ~250ms once it was announced at DOMContentLoaded instead.

    The threshold is what keeps this honest. A page still assembling itself in
    script has no text at DOMContentLoaded, so it falls through to `load` and is
    judged by the settle checks exactly as before.
    """
    source = bridge_source()

    assert "DOMContentLoaded" in source, "readiness is still tied to load alone"
    assert "READABLE_CHARS" in source
    # The load path has to remain as the fallback for a page that renders late.
    assert 'window.addEventListener("load", ready)' in source
    # Announcing twice would restart the settle checks and re-clear the notice.
    assert "if (announced) return;" in source


def test_the_bridge_and_the_panel_agree_on_what_rendered_means():
    """
    The bridge decides both when a page is readable and when one is blank, and
    says so. A bridge from before it sent that verdict reports only a count of
    characters, and the panel then judges by the same number: if the two drift
    apart, a page can be announced readable and then immediately called empty.
    This is the bridge's side; each frontend reads its panel against it in its
    own suite (the desktop's is `desktop/backend/tests/test_frontend_contracts.py`).
    """
    bridge = bridge_source()

    assert "var READABLE_CHARS = 200;" in bridge
    assert "blank: blank()," in bridge


def test_a_real_origin_is_granted_only_on_a_sandbox_origin():
    """
    `allow-same-origin` is what lets an embedded player use *its own* origin —
    sandbox flags inherit into nested frames, so without it a Vimeo or YouTube
    embed renders a dead poster. It is safe exactly when the origin it grants is
    not Delphi's: a page granted our origin can call /api with the reader's
    cookie attached, which HttpOnly does nothing to prevent.
    """
    assert "allow-same-origin" not in sandbox_flags("")
    assert "allow-same-origin" in sandbox_flags("https://sandbox.example")
    assert "allow-scripts" in sandbox_flags("")


def test_device_powers_are_delegated_to_the_frame():
    """A player cannot autoplay or decrypt without these passed through."""
    for power in ("autoplay", "fullscreen", "encrypted-media"):
        assert power in FRAME_ALLOW


def test_the_frame_adopts_the_articles_own_path():
    """
    `window.location` is unforgeable, so a proxied document reports Delphi's
    path and a client-rendered site takes that as its route — asks its own API
    for a post that does not exist, and replaces the good server-rendered
    article with its own 404. Substack does exactly this.
    """
    html = render_frame(POST, "https://example.com/p/technical-deepseek?x=1")

    assert '"path": "/p/technical-deepseek?x=1"' in html
    # replaceState is the one part of location that can be changed, and only to
    # a same-origin URL — which the sandbox origin is.
    assert "history.replaceState(history.state" in bridge_source()
    # It must run before the page's scripts, or the route is read first.
    assert html.index("__DELPHI__") < html.index("</head>")


def test_a_sandbox_origin_that_is_also_the_app_refuses_to_start():
    """
    The single value the whole design rests on. Pointing it at the app makes a
    CORS or frame-ancestors error go away and looks like it works.
    """
    with pytest.raises(ValidationError) as caught:
        Settings(
            frontend_origins="http://localhost:3000",
            web_sandbox_origin="http://localhost:3000/",
        )

    assert "never reaches" in str(caught.value)

    # A genuinely separate host is fine, including the localhost/127.0.0.1 pair.
    Settings(
        frontend_origins="http://localhost:3000",
        web_sandbox_origin="http://127.0.0.1:8000",
    )


def test_a_page_token_speaks_for_one_paper_only():
    token = make_page_token("reader", "project-one", "paper-one", "secret", 300)

    assert read_page_token(token, "project-one", "paper-one", "secret") == "reader"
    # Scope is checked rather than trusted, so a token cannot be walked sideways.
    assert read_page_token(token, "project-one", "paper-two", "secret") is None
    assert read_page_token(token, "project-two", "paper-one", "secret") is None
    assert read_page_token(token, "project-one", "paper-one", "other") is None
    assert read_page_token(token[:-2] + "xx", "project-one", "paper-one", "secret") is None


def test_a_page_token_expires():
    stale = make_page_token("reader", "p", "d", "secret", -1)

    assert read_page_token(stale, "p", "d", "secret") is None


def test_a_navigation_token_is_bound_to_every_part_of_its_destination():
    token = make_navigation_token(
        "reader",
        "project-one",
        "paper-one",
        "https://example.com/private?thread=2",
        True,
        "secret",
        300,
    )

    assert read_navigation_token(
        token,
        "project-one",
        "paper-one",
        "https://example.com/private?thread=2",
        True,
        "secret",
    ) == "reader"
    assert read_navigation_token(
        token,
        "project-one",
        "paper-one",
        "https://example.com/private?thread=3",
        True,
        "secret",
    ) is None
    assert read_navigation_token(
        token,
        "other-project",
        "paper-one",
        "https://example.com/private?thread=2",
        True,
        "secret",
    ) is None
    assert read_navigation_token(
        token,
        "project-one",
        "paper-one",
        "https://example.com/private?thread=2",
        False,
        "secret",
    ) is None


def test_a_navigation_token_expires():
    token = make_navigation_token(
        "reader", "project", "paper", "https://example.com/", False, "secret", -1
    )

    assert read_navigation_token(
        token, "project", "paper", "https://example.com/", False, "secret"
    ) is None


@pytest.mark.asyncio
async def test_the_shared_fetch_pool_never_replays_an_upstream_cookie(monkeypatch):
    """A publisher's Set-Cookie must not become another reader's credential."""
    import delphi_core.web_fetch as web_fetch

    seen_cookies = []

    def handler(request):
        seen_cookies.append(request.headers.get("cookie"))
        headers = {"Content-Type": "text/html"}
        if request.url.path == "/first":
            headers["Set-Cookie"] = "publisher_session=secret; Path=/"
        return httpx.Response(200, headers=headers, content=b"<main>Readable page</main>")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(web_fetch, "check_public_host", lambda url: None)
    set_shared_web_client(client)
    try:
        await fetch_resource("https://publisher.example/first", Settings())
        await fetch_resource("https://publisher.example/second", Settings())
    finally:
        set_shared_web_client(None)
        await client.aclose()

    assert seen_cookies == [None, None]


@pytest.mark.asyncio
async def test_a_cookie_challenge_is_answered_once_and_the_page_is_read(monkeypatch):
    """
    A 403 that hands over a cookie is a challenge, not a refusal.

    spaces.ac.cn answers the first request with a 123-byte stub carrying two
    Set-Cookie headers, and serves the article to the next request that sends
    them back. Nothing about the User-Agent changes that.
    """
    import delphi_core.web_fetch as web_fetch

    seen = []

    def handler(request):
        seen.append(request.headers.get("cookie"))
        if request.headers.get("cookie") is None:
            return httpx.Response(
                403,
                headers=[
                    ("Content-Type", "text/html"),
                    ("Set-Cookie", "challenge=abc; Path=/"),
                    ("Set-Cookie", "server_session=def; Path=/"),
                ],
                content=b"<script>window.location.href='/a'</script>",
            )
        return httpx.Response(
            200, headers={"Content-Type": "text/html"}, content=b"<main>The article</main>"
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(web_fetch, "check_public_host", lambda url: None)
    set_shared_web_client(client)
    try:
        resource = await fetch_resource("https://challenge.example/a", Settings())
    finally:
        set_shared_web_client(None)
        await client.aclose()

    assert resource.body == b"<main>The article</main>"
    assert seen == [None, "challenge=abc; server_session=def"]


@pytest.mark.asyncio
async def test_a_site_that_always_refuses_is_challenged_only_once(monkeypatch):
    """The retry is a second chance, not a loop a hostile host can drive."""
    import delphi_core.web_fetch as web_fetch

    attempts = []

    def handler(request):
        attempts.append(request.url.path)
        return httpx.Response(
            403,
            headers=[("Content-Type", "text/html"), ("Set-Cookie", "x=1; Path=/")],
            content=b"no",
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(web_fetch, "check_public_host", lambda url: None)
    set_shared_web_client(client)
    try:
        with pytest.raises(HTTPException) as refused:
            await fetch_resource("https://wall.example/a", Settings())
    finally:
        set_shared_web_client(None)
        await client.aclose()

    assert len(attempts) == 2
    assert refused.value.detail["code"] == "blocked"


@pytest.mark.asyncio
async def test_a_challenge_cookie_never_follows_a_redirect_to_another_host(monkeypatch):
    """The cookie belongs to the host that issued it and to no other."""
    import delphi_core.web_fetch as web_fetch

    seen = {}

    def handler(request):
        host = request.url.host
        seen[host] = request.headers.get("cookie")
        if host == "challenge.example":
            if request.headers.get("cookie") is None:
                return httpx.Response(
                    403,
                    headers=[
                        ("Content-Type", "text/html"),
                        ("Set-Cookie", "challenge=abc; Path=/"),
                    ],
                    content=b"no",
                )
            return httpx.Response(
                302, headers={"Location": "https://elsewhere.example/a"}
            )
        return httpx.Response(
            200, headers={"Content-Type": "text/html"}, content=b"<main>Other</main>"
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(web_fetch, "check_public_host", lambda url: None)
    set_shared_web_client(client)
    try:
        await fetch_resource("https://challenge.example/a", Settings())
    finally:
        set_shared_web_client(None)
        await client.aclose()

    assert seen["challenge.example"] == "challenge=abc"
    assert seen["elsewhere.example"] is None


@pytest.mark.parametrize(
    ("status", "code"),
    [(403, "blocked"), (429, "throttled"), (404, "missing"), (503, "unavailable")],
)
def test_a_failure_names_its_cause_rather_than_its_status_code(status, code):
    """
    What the reader does next differs between these, so the copy must too.

    Asserting the code and the host rather than the sentence: the wording is
    meant to be improved, the distinction is not.
    """
    detail = describe_failure(status, "publisher.example")

    assert detail["code"] == code
    assert "publisher.example" in detail["message"]
    assert str(status) not in detail["message"]


@pytest.mark.asyncio
async def test_a_bot_wall_that_renders_is_still_a_bot_wall(monkeypatch):
    """
    A rendered interstitial is not an article, however valid its markup.

    DataDome answers a real browser with a CAPTCHA page, so the render
    "succeeds": 772 bytes of well-formed HTML that extract to one section.
    Accepting it filed a document titled "nytimes.com" whose whole body was
    "Please enable JS and disable any ad blocker" — a worse outcome than the
    refusal it replaced, because it looks like it worked.
    """
    import delphi_core.web_fetch as web_fetch

    def handler(request):
        return httpx.Response(403, headers={"Content-Type": "text/html"}, content=b"no")

    async def captcha(url, *, asset_hosts=()):
        return FetchedResource(
            url=url,
            body=b"<html><head><title>nytimes.com</title></head><body>"
                 b"<p>Please enable JS and disable any ad blocker</p></body></html>",
            content_type="text/html",
            encoding="utf-8",
            fetched_at="2026-08-14T00:00:00Z",
            rendered=True,
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(web_fetch, "check_public_host", lambda url: None)
    monkeypatch.setattr(web_fetch, "render_page", captcha)
    set_shared_web_client(client)
    try:
        with pytest.raises(HTTPException) as refused:
            await fetch_resource(
                "https://walled.example/a", Settings(), allow_render=True
            )
    finally:
        set_shared_web_client(None)
        await client.aclose()

    assert refused.value.detail["code"] == "blocked"


@pytest.mark.asyncio
async def test_a_wall_a_browser_walks_through_yields_the_article(monkeypatch):
    """The other half: a render that returns real prose is the point of trying."""
    import delphi_core.web_fetch as web_fetch

    def handler(request):
        return httpx.Response(403, headers={"Content-Type": "text/html"}, content=b"no")

    async def article(url, *, asset_hosts=()):
        return FetchedResource(
            url=url,
            body=(
                "<html><body><article><h1 id='t'>The Article</h1><p>"
                + ("Real prose that goes on for a while. " * 12)
                + "</p></article></body></html>"
            ).encode(),
            content_type="text/html",
            encoding="utf-8",
            fetched_at="2026-08-14T00:00:00Z",
            rendered=True,
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(web_fetch, "check_public_host", lambda url: None)
    monkeypatch.setattr(web_fetch, "render_page", article)
    set_shared_web_client(client)
    try:
        resource = await fetch_resource(
            "https://soft.example/a", Settings(), allow_render=True
        )
    finally:
        set_shared_web_client(None)
        await client.aclose()

    assert resource.rendered is True
    assert b"Real prose" in resource.body


@pytest.mark.asyncio
async def test_a_page_that_builds_itself_is_built_and_then_read(monkeypatch):
    """
    A shell is indistinguishable from an empty page until parsing has run.

    Notion serves 5 KB of loading skeleton whose OG tags are Notion's own
    marketing copy, so neither the markup nor the metadata says what the page
    is. Running its scripts is the only thing that answers.
    """
    import delphi_core.web_fetch as web_fetch

    shell = FetchedResource(
        url="https://shell.example/page",
        body=b'<html><body><div id="app"></div><script src="/b.js"></script></body></html>',
        content_type="text/html",
        encoding="utf-8",
        fetched_at="2026-08-14T00:00:00Z",
    )

    async def built(url, *, asset_hosts=(), whole=True):
        assert "shell.example" in asset_hosts
        return FetchedResource(
            url=url,
            body=(
                "<html><body><article><h1 id='m'>The Mismatch Problem</h1><p>"
                "What the scripts drew. " + ("Enough prose to be an article. " * 10)
                + "</p></article></body></html>"
            ).encode(),
            content_type="text/html",
            encoding="utf-8",
            fetched_at="2026-08-14T00:00:00Z",
            rendered=True,
        )

    monkeypatch.setattr(web_fetch, "render_page", built)

    document = await web_fetch.extract_with_render_fallback(shell, 600_000)

    assert document["sections"]
    assert "What the scripts drew." in flat_markdown(document)


@pytest.mark.parametrize(
    "target",
    ["127.0.0.1", "169.254.169.254", "10.0.0.1", "metadata.google.internal"],
)
def test_the_renderer_may_reach_the_public_internet_and_nothing_else(target):
    """
    The renderer validates every host it asks for, not a list guessed up front.

    Pinning the resolver to the hosts named in the shell was safe and useless
    for a page that assembles itself: nineteen of twenty figures on a Notion
    page were refused, because the shell names none of them. Validating per
    request loads them and keeps the SSRF boundary — which is what this checks
    from the renderer's own side of it.
    """
    import socket

    import delphi_core.browser_render as browser_render

    with browser_render._public_only_proxy() as proxy:
        host, _, port = proxy.rpartition(":")
        connection = socket.create_connection((host, int(port)), timeout=5)
        try:
            connection.sendall(
                f"CONNECT {target}:80 HTTP/1.1\r\nHost: {target}\r\n\r\n".encode()
            )
            reply = connection.recv(200).split(b"\r\n")[0].decode()
        finally:
            connection.close()

    assert "200" not in reply


def test_a_stored_dom_carries_the_width_it_was_built_at():
    """
    A framework bakes pixel values into the markup, so a stored DOM is only
    correct at the width it was laid out at. The constant gets tuned — 1280
    cropped Notion's headline, 1512 did not — and photographing at the new
    number a document built at the old one is the same crop. The width is
    stamped on the way out of the renderer so the capture does not guess.

    `static_document` re-serialises through BeautifulSoup before the copy is
    stored, so the stamp has to survive that or the capture falls back to
    whatever the constant is *now*. A capture from `file://` also needs the
    base tag: Notion's figures are `/image/…`, and without one they resolve
    against the temp file.
    """
    from delphi_core.browser_render import render_width_of, stamp_render_width

    stamped = stamp_render_width(
        '<html lang="en"><body><p>article</p></body></html>', 1512
    )
    frozen = static_document(stamped)

    assert render_width_of(stamped, 960) == 1512
    assert render_width_of(frozen, 960) == 1512
    assert render_width_of("<html><body></body></html>", 960) == 960

    captured = static_document(stamped, "https://fengyao.notion.site/off-policy-rl")
    assert '<base href="https://fengyao.notion.site/off-policy-rl"' in captured
    assert render_width_of(captured, 960) == 1512


@pytest.mark.asyncio
async def test_a_wordy_security_check_is_not_mistaken_for_an_article(monkeypatch):
    """
    A wall can be longer than the article it replaces, so length cannot decide.

    Cloudflare's interstitial runs to 1,170 characters of advice about
    disabling browser extensions — past any prose threshold worth setting, and
    it extracts to a titled section. It reached the library as a document
    called "Just a moment…". What gives it away is structural: it loads the
    challenge machinery, and a page that does is not a page.
    """
    import delphi_core.web_fetch as web_fetch

    wall = (
        "<html><head><title>Just a moment...</title>"
        "<script src='https://challenges.cloudflare.com/turnstile/v0/api.js'></script>"
        "</head><body><h1>Incompatible browser extension or network configuration</h1>"
        "<p>" + ("Your browser extensions have blocked verification. " * 24) + "</p>"
        "</body></html>"
    ).encode()

    async def still_walled(url, *, asset_hosts=(), whole=True):
        return FetchedResource(
            url=url, body=wall, content_type="text/html", encoding="utf-8",
            fetched_at="2026-08-14T00:00:00Z", rendered=True,
        )

    monkeypatch.setattr(web_fetch, "render_page", still_walled)
    fetched = FetchedResource(
        url="https://walled.example/a", body=wall, content_type="text/html",
        encoding="utf-8", fetched_at="2026-08-14T00:00:00Z",
    )

    # Long enough to pass the prose floor, so only the structural test saves it.
    assert readable_text_length(wall.decode()) > PROSE_MIN_CHARS
    document = await web_fetch.extract_with_render_fallback(fetched, 600_000)

    assert document["sections"] == []


@pytest.mark.asyncio
async def test_an_interstitial_served_as_200_is_not_filed_as_a_document(monkeypatch):
    """
    Emptiness is not the only way to have nothing to read.

    Cloudflare answers 200 with a titled, well-formed "Just a moment…" page
    that extracts to a real section, so a check for no sections at all admitted
    it and Delphi filed a document whose whole body was the name of the wall in
    front of the article.
    """
    import delphi_core.web_fetch as web_fetch

    async def still_walled(url, *, asset_hosts=(), whole=True):
        return FetchedResource(
            url=url,
            body=b"<html><head><title>Just a moment...</title></head>"
                 b"<body><p>Checking your browser.</p></body></html>",
            content_type="text/html",
            encoding="utf-8",
            fetched_at="2026-08-14T00:00:00Z",
            rendered=True,
        )

    monkeypatch.setattr(web_fetch, "render_page", still_walled)
    wall = FetchedResource(
        url="https://walled.example/a",
        body=b"<html><head><title>Just a moment...</title></head>"
             b"<body><p>Checking your browser.</p></body></html>",
        content_type="text/html",
        encoding="utf-8",
        fetched_at="2026-08-14T00:00:00Z",
    )

    document = await web_fetch.extract_with_render_fallback(wall, 600_000)

    assert document["sections"] == []


@pytest.mark.asyncio
async def test_a_rendered_page_with_no_text_is_not_rendered_again(monkeypatch):
    """The ladder has a bottom: nothing below the browser is worth trying."""
    import delphi_core.web_fetch as web_fetch

    renders = []

    async def built(url, *, asset_hosts=(), whole=True):
        renders.append(url)
        return None

    monkeypatch.setattr(web_fetch, "render_page", built)
    already = FetchedResource(
        url="https://empty.example/page",
        body=b"<html><body></body></html>",
        content_type="text/html",
        encoding="utf-8",
        fetched_at="2026-08-14T00:00:00Z",
        rendered=True,
    )

    document = await web_fetch.extract_with_render_fallback(already, 600_000)

    assert document["sections"] == []
    assert renders == []


@pytest.mark.asyncio
async def test_a_page_that_cannot_be_built_fails_honestly(monkeypatch):
    """
    A container with no Chromium is not a 500.

    The last rung of the ladder is simply unavailable, and the reader is told
    the page had nothing to read. There is no operator switch that turns
    rendering off: a page that builds itself is always worth trying, and the
    only honest failure left is that this machine cannot run a browser.
    """
    import delphi_core.browser_render as browser_render
    import delphi_core.web_fetch as web_fetch

    monkeypatch.setattr(browser_render, "_chrome_executable", lambda: None)
    shell = FetchedResource(
        url="https://shell.example/page",
        body=b'<html><body><div id="app"></div></body></html>',
        content_type="text/html",
        encoding="utf-8",
        fetched_at="2026-08-14T00:00:00Z",
    )

    document = await web_fetch.extract_with_render_fallback(shell, 600_000)

    assert document["sections"] == []


@pytest.mark.asyncio
async def test_a_plain_fetch_names_delphi_and_not_chrome(monkeypatch):
    """
    Fetch is honest. Chromium has to look like Chrome or Notion serves an
    interstitial. Those are two User-Agents on purpose, and the fetch path
    must not inherit the renderer's.
    """
    from delphi_core.browser_render import RENDER_USER_AGENT

    seen = []

    def handler(request):
        seen.append(request.headers.get("user-agent"))
        return httpx.Response(
            200, headers={"Content-Type": "text/html"}, content=b"<main>The article</main>"
        )

    import delphi_core.web_fetch as web_fetch

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(web_fetch, "check_public_host", lambda url: None)
    set_shared_web_client(client)
    try:
        await fetch_resource("https://publisher.example/a", Settings())
    finally:
        set_shared_web_client(None)
        await client.aclose()

    assert seen == [Settings().web_user_agent]
    assert "DelphiReader" in seen[0]
    assert "HeadlessChrome" not in seen[0]
    assert seen[0] != RENDER_USER_AGENT


def test_chromium_names_chrome_and_not_headless_chrome(tmp_path):
    """
    Notion scores `HeadlessChrome` in the UA and `navigator.webdriver` and
    serves an interstitial instead of the page. The flags that stop that live
    in the shared list so a screenshot cannot forget them.
    """
    from delphi_core.browser_render import RENDER_USER_AGENT, base_chrome_flags

    flags = base_chrome_flags(tmp_path / "profile", tmp_path / "crashes", [])
    joined = " ".join(flags)

    assert f"--user-agent={RENDER_USER_AGENT}" in flags
    assert "Chrome/141" in RENDER_USER_AGENT
    assert "HeadlessChrome" not in joined
    assert "DelphiReader" not in RENDER_USER_AGENT
    assert "--disable-blink-features=AutomationControlled" in flags
    assert Settings().web_user_agent != RENDER_USER_AGENT


@pytest.mark.asyncio
async def test_a_page_that_already_has_an_article_is_not_built_in_a_browser(monkeypatch):
    """
    Chromium is the last rung, not the default.

    A Lilianweng post parses from the bytes fetch already has. Spending the
    Notion wait on it would be that latency on every add, and the loading
    animation does not make that acceptable for a page that was already an
    article.
    """
    import delphi_core.web_fetch as web_fetch

    renders = []

    async def built(url, *, asset_hosts=(), whole=True):
        renders.append(url)
        return None

    monkeypatch.setattr(web_fetch, "render_page", built)
    fetched = FetchedResource(
        url=BASE,
        body=POST.encode(),
        content_type="text/html",
        encoding="utf-8",
        fetched_at="2026-08-14T00:00:00Z",
    )

    document = await web_fetch.extract_with_render_fallback(fetched, 600_000)

    assert document["sections"]
    assert "Loss was predictable" in flat_markdown(document)
    assert renders == []


def test_only_delphi_may_frame_a_proxied_page():
    headers = frame_headers(["http://localhost:3000"])

    assert headers["Content-Security-Policy"] == (
        "frame-ancestors 'self' http://localhost:3000"
    )
    assert headers["Cache-Control"] == "private, no-store"


def test_frame_requests_are_told_apart_from_tab_navigations():
    assert is_frame_request({"sec-fetch-dest": "iframe"})
    assert not is_frame_request({"sec-fetch-dest": "document"})
    # Absent header is not a browser framing us, so it takes the safe path.
    assert not is_frame_request({})


# --- routes ----------------------------------------------------------


def web_project(settings: Settings, client) -> tuple[str, str]:
    client.post(
        "/api/auth/register",
        json={"username": "reader", "password": "password-123"},
    )
    project_id = client.post("/api/projects", json={"name": "Lil'Log"}).json()["id"]
    seed_paper(
        settings,
        "reader",
        project_id,
        {
            "id": "page-one",
            "kind": "web",
            "title": "Scaling Laws, Carefully",
            "filename": "lilianweng.github.io/posts/2026-06-24-scaling-laws",
            "url": BASE,
            "pages": 4,
            "tokens": 2000,
            "bytes": 8000,
        },
    )
    objects = LocalObjectStore(settings.data_dir)
    objects.put_text(
        paper_key("reader", project_id, "page-one", "web"),
        json.dumps(document()),
    )
    return project_id, "page-one"


def test_a_pdf_url_can_stay_linked_or_join_as_a_native_pdf(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    import delphi_core.routers.projects as projects_router

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        web_sandbox_origin="",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    resource = FetchedResource(
        url="https://arxiv.org/pdf/2601.16208v1",
        body=linked_pdf(),
        content_type="application/pdf",
        encoding="utf-8",
        fetched_at="2026-07-30T00:00:00+00:00",
    )

    async def fake_fetch(url, settings, *, include_pdf=False, **_kwargs):
        if not include_pdf:
            raise HTTPException(409, PDF_URL_DETAIL)
        return resource

    monkeypatch.setattr(projects_router, "fetch_resource", fake_fetch)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project_id = client.post(
                "/api/projects", json={"name": "Linked PDFs"}
            ).json()["id"]
            endpoint = f"/api/projects/{project_id}/pages"

            hint = client.post(endpoint, json={"url": resource.url})
            assert hint.status_code == 409
            assert hint.json()["detail"]["code"] == "pdf_url"

            linked_response = client.post(
                endpoint,
                json={"url": resource.url, "pdf_mode": "web"},
            )
            assert linked_response.status_code == 201, linked_response.text
            linked = linked_response.json()
            assert linked["kind"] == "web"
            assert linked["filename"] == "2601.16208v1.pdf"
            assert linked["pages"] == 1

            frame_address = client.get(
                f"/api/projects/{project_id}/papers/{linked['id']}/page-url"
            ).json()
            assert frame_address["mode"] == "pdf"

            framed = client.get(
                f"/api/projects/{project_id}/papers/{linked['id']}/page",
                headers={"Sec-Fetch-Dest": "iframe"},
            )
            assert framed.status_code == 200
            assert framed.headers["content-type"].startswith("application/pdf")
            assert framed.content == resource.body

            # Delphi's PDF.js reader fetches the same pinned route as a normal
            # credentialed resource, not as Chrome's opaque PDF iframe.
            pdfjs = client.get(
                f"/api/projects/{project_id}/papers/{linked['id']}/page"
            )
            assert pdfjs.status_code == 200
            assert pdfjs.headers["content-type"].startswith("application/pdf")
            assert pdfjs.content == resource.body

            imported_response = client.post(
                endpoint,
                json={"url": resource.url, "pdf_mode": "upload"},
            )
            assert imported_response.status_code == 201, imported_response.text
            imported = imported_response.json()
            assert "kind" not in imported
            assert imported["title"] == "A Linked Paper"
            assert imported["filename"] == "2601.16208v1.pdf"

            objects = LocalObjectStore(settings.data_dir)
            assert objects.exists(
                paper_key("reader", project_id, linked["id"], "web")
            )
            assert objects.exists(
                paper_key("reader", project_id, imported["id"], "pdf")
            )
    finally:
        app.dependency_overrides.clear()


def test_opening_a_proxied_page_as_a_tab_redirects_to_the_real_site(tmp_path):
    """
    Serving proxied HTML top-level would run someone else's script on Delphi's
    origin with the session cookie attached — an account takeover for any page
    a user adds.
    """
    from fastapi.testclient import TestClient

    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id, paper_id = web_project(settings, client)
            response = client.get(
                f"/api/projects/{project_id}/papers/{paper_id}/page",
                headers={"Sec-Fetch-Dest": "document"},
                follow_redirects=False,
            )

        assert response.status_code == 303
        assert response.headers["location"] == BASE
    finally:
        app.dependency_overrides.clear()


def test_the_route_takes_no_address_from_the_caller(tmp_path):
    """
    The frame blocks link navigation, so the proxy needs no way to be pointed
    somewhere else — and without one it cannot become an open proxy serving
    arbitrary HTML from a path under Delphi's own domain.
    """
    import inspect

    from delphi_core.routers.projects import paper_page

    from fastapi import Request, params

    # Asserted as the property rather than as a list of names, which is what
    # the rule about intent over spelling is for: a fixed set breaks the moment
    # a dependency is injected — as one was, to reach stored bytes — and says
    # nothing about the danger, while this still catches `url: str = ""` being
    # added tomorrow, whatever it ends up being called.
    caller_supplied = {
        name
        for name, parameter in inspect.signature(paper_page).parameters.items()
        if not isinstance(parameter.default, params.Depends)
        and parameter.annotation is not Request
    }

    # The two ids name a document Delphi already holds, `t` identifies the
    # caller and `view` chooses between two closed values. None of them is an
    # address, and there is nothing else to be one.
    assert caller_supplied == {"project_id", "paper_id", "t", "view"}
    assert inspect.signature(paper_page).parameters["view"].annotation == Literal["live", "cached"] | None


def test_a_page_that_needed_a_browser_is_framed_as_the_browser_built_it(tmp_path):
    """
    The reader sees the page, not a transcription of it.

    A Notion page cannot be framed live: its app boots against an origin that
    is not its own and paints nothing, so the panel showed an empty frame for a
    document Delphi had read perfectly. The DOM the browser already built at
    snapshot time is the page — its own stylesheets, its own images — so that
    is what the same proxy route serves.
    """
    from fastapi.testclient import TestClient

    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        client = TestClient(app)
        client.post(
            "/api/auth/register", json={"username": "kev", "password": "hunter2hunter2"}
        )
        project = client.post("/api/projects", json={"name": "RL"}).json()
        objects = LocalObjectStore(settings.data_dir)
        paper = seed_paper(
            settings,
            "kev",
            project["id"],
            {
                "id": "spa1",
                "title": "Built",
                "kind": "web",
                "url": "https://spa.example/doc",
                "pages": 1,
            },
        )
        objects.put_text(
            paper_key("kev", project["id"], paper["id"], "web"),
            json.dumps({"savedDom": "<html><body><article><h1>Built by the browser</h1></article></body></html>"}),
        )

        framed = client.get(
            f"/api/projects/{project['id']}/papers/{paper['id']}/page?view=cached",
            headers={"Sec-Fetch-Dest": "iframe"},
        )

        assert framed.status_code == 200
        assert "Built by the browser" in framed.text
        # Still the ordinary framing path: the bridge has to be in there, or
        # selection, clicks and citation jumps stop working in this panel only.
        assert "delphi" in framed.text.lower()
    finally:
        app.dependency_overrides.pop(get_settings, None)


def test_a_pdf_route_refuses_a_web_document(tmp_path):
    from fastapi.testclient import TestClient

    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id, _ = web_project(settings, client)
            seed_paper(
                settings,
                "reader",
                project_id,
                {"id": "pdf-one", "title": "A PDF", "filename": "a.pdf", "pages": 1},
            )
            framed = client.get(
                f"/api/projects/{project_id}/papers/pdf-one/page",
                headers={"Sec-Fetch-Dest": "iframe"},
            )

        assert framed.status_code == 409
    finally:
        app.dependency_overrides.clear()


def test_the_frame_address_carries_a_token_only_on_a_sandbox_origin(tmp_path):
    from fastapi.testclient import TestClient

    for sandbox, expect_absolute in (("", False), ("http://127.0.0.1:8000", True)):
        settings = Settings(
            data_dir=tmp_path / sandbox.replace(":", "_").replace("/", "_"),
            session_secret="test-session-secret",
            web_sandbox_origin=sandbox,
        )
        app.dependency_overrides[get_settings] = lambda: settings
        try:
            with TestClient(app) as client:
                project_id, paper_id = web_project(settings, client)
                body = client.get(
                    f"/api/projects/{project_id}/papers/{paper_id}/page-url"
                ).json()
        finally:
            app.dependency_overrides.clear()

        assert body["url"].startswith(sandbox) is expect_absolute or not sandbox
        assert ("t=" in body["url"]) is expect_absolute
        assert ("allow-same-origin" in body["sandbox"]) is expect_absolute


def test_user_navigation_is_minted_then_consumed_only_by_the_frame(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    import delphi_core.routers.projects as projects_router

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        web_sandbox_origin="",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    fetched = []

    async def fake_fetch(url, settings, **kwargs):
        fetched.append(url)
        return FetchedResource(
            url=url,
            body=b"<html><head><title>Next</title></head><body><main>" + b"word " * 60 + b"</main></body></html>",
            content_type="text/html",
            encoding="utf-8",
            fetched_at="2026-08-03T00:00:00+00:00",
        )

    monkeypatch.setattr(projects_router, "check_public_host", lambda url: None)
    monkeypatch.setattr(projects_router, "fetch_resource", fake_fetch)
    try:
        with TestClient(app) as client:
            project_id, paper_id = web_project(settings, client)
            endpoint = f"/api/projects/{project_id}/papers/{paper_id}"
            minted = client.post(
                f"{endpoint}/navigation",
                json={"url": "https://example.com/next?sensitive=yes"},
            )
            assert minted.status_code == 200
            authorization = minted.json()
            assert "sensitive" not in authorization["action"]

            top_level = client.post(
                f"{endpoint}/navigate",
                data={"url": authorization["url"], "token": authorization["token"]},
                headers={"Sec-Fetch-Dest": "document"},
            )
            assert top_level.status_code == 403

            unsigned = client.post(
                f"{endpoint}/navigate",
                data={"url": authorization["url"], "token": "unsigned"},
                headers={"Sec-Fetch-Dest": "iframe"},
            )
            assert unsigned.status_code == 401

            mismatched = client.post(
                f"{endpoint}/navigate",
                data={"url": "https://example.com/other", "token": authorization["token"]},
                headers={"Sec-Fetch-Dest": "iframe"},
            )
            assert mismatched.status_code == 401

            framed = client.post(
                f"{endpoint}/navigate",
                data={"url": authorization["url"], "token": authorization["token"]},
                headers={"Sec-Fetch-Dest": "iframe"},
            )
            assert framed.status_code == 200
            assert "Next" in framed.text
    finally:
        app.dependency_overrides.clear()

    assert fetched == ["https://example.com/next?sensitive=yes"]


def test_the_server_browsing_kill_switch_is_published_and_blocks_navigation(tmp_path):
    from fastapi.testclient import TestClient

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        web_browsing_enabled=False,
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id, paper_id = web_project(settings, client)
            config = client.get("/api/config").json()
            assert config["webBrowsingEnabled"] is False
            response = client.post(
                f"/api/projects/{project_id}/papers/{paper_id}/navigation",
                json={"url": "https://example.com/next"},
            )
            assert response.status_code == 403
            # A token minted before an operator flips the switch must not keep
            # the frame route alive until its natural expiry.
            destination = "https://example.com/next"
            old_token = make_navigation_token(
                "reader",
                project_id,
                paper_id,
                destination,
                False,
                settings.session_secret,
                300,
            )
            framed = client.post(
                f"/api/projects/{project_id}/papers/{paper_id}/navigate",
                data={"url": destination, "token": old_token},
                headers={"Sec-Fetch-Dest": "iframe"},
            )
            assert framed.status_code == 403
    finally:
        app.dependency_overrides.clear()


def test_the_page_route_accepts_a_token_where_there_is_no_cookie(tmp_path):
    """
    The sandbox origin never receives the session cookie — that is the whole
    point of it — so the token has to be what identifies the request.
    """
    from fastapi.testclient import TestClient

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        web_sandbox_origin="http://127.0.0.1:8000",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id, paper_id = web_project(settings, client)
            token = make_page_token(
                "reader", project_id, paper_id, settings.session_secret, 300
            )
            client.cookies.clear()

            without = client.get(
                f"/api/projects/{project_id}/papers/{paper_id}/page",
                headers={"Sec-Fetch-Dest": "iframe"},
            )
            wrong_paper = client.get(
                f"/api/projects/{project_id}/papers/{paper_id}/page",
                params={"t": make_page_token(
                    "reader", project_id, "other-paper", settings.session_secret, 300
                )},
                headers={"Sec-Fetch-Dest": "iframe"},
            )
            # Valid token, but a top-level visit still redirects rather than
            # serving proxied HTML.
            valid = client.get(
                f"/api/projects/{project_id}/papers/{paper_id}/page",
                params={"t": token},
                headers={"Sec-Fetch-Dest": "document"},
                follow_redirects=False,
            )
    finally:
        app.dependency_overrides.clear()

    assert without.status_code == 401
    assert wrong_paper.status_code == 401
    assert valid.status_code == 303


def test_a_sandbox_origin_that_receives_a_cookie_is_refused_at_request_time(tmp_path):
    """
    The guard a config check cannot provide. If the session cookie later gains a
    `Domain=` attribute it spreads across subdomains, the sandbox origin starts
    receiving credentials, and nothing about the configuration has changed. So
    the property itself is checked: a token *and* a cookie together mean the
    separation has collapsed.
    """
    from fastapi.testclient import TestClient

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        web_sandbox_origin="http://127.0.0.1:8000",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id, paper_id = web_project(settings, client)
            token = make_page_token(
                "reader", project_id, paper_id, settings.session_secret, 300
            )
            # The registration in `web_project` left a session cookie on the
            # client, which is exactly the collapsed state.
            collapsed = client.get(
                f"/api/projects/{project_id}/papers/{paper_id}/page",
                params={"t": token},
                headers={"Sec-Fetch-Dest": "iframe"},
            )
    finally:
        app.dependency_overrides.clear()

    assert collapsed.status_code == 500
    assert "misconfigured" in collapsed.json()["detail"]


def test_deleting_a_web_document_removes_its_snapshot(tmp_path):
    from fastapi.testclient import TestClient

    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            project_id, paper_id = web_project(settings, client)
            objects = LocalObjectStore(settings.data_dir)
            key = paper_key("reader", project_id, paper_id, "web")
            assert objects.exists(key)

            client.delete(f"/api/projects/{project_id}/papers/{paper_id}")

        assert not objects.exists(key)
        assert LocalStorage(settings).count_active_papers("reader", project_id) == 0
    finally:
        app.dependency_overrides.clear()


def test_a_linked_pdf_is_stored_in_place_so_its_annotations_survive(tmp_path, monkeypatch):
    """
    Writing a note against a document Delphi does not hold is one broken link
    away from being unreadable, so the reader is offered a stored copy first.

    The paper id must not change: a re-import would make a second document and
    orphan the highlights, notes, digest and thread already hanging off this one.
    """
    from fastapi.testclient import TestClient
    import delphi_core.routers.projects as projects_router

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        web_sandbox_origin="",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    resource = FetchedResource(
        url="https://arxiv.org/pdf/2601.16208v1",
        body=linked_pdf(),
        content_type="application/pdf",
        encoding="utf-8",
        fetched_at="2026-07-30T00:00:00+00:00",
    )

    async def fake_fetch(url, settings, *, include_pdf=False, **_kwargs):
        if not include_pdf:
            raise HTTPException(409, PDF_URL_DETAIL)
        return resource

    monkeypatch.setattr(projects_router, "fetch_resource", fake_fetch)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project_id = client.post(
                "/api/projects", json={"name": "Linked PDFs"}
            ).json()["id"]
            linked = client.post(
                f"/api/projects/{project_id}/pages",
                json={"url": resource.url, "pdf_mode": "web"},
            ).json()
            assert linked["kind"] == "web"

            stroke = client.post(
                f"/api/projects/{project_id}/papers/{linked['id']}/highlights",
                json={
                    "type": "pdf",
                    "page": 1,
                    "text": "a claim worth keeping",
                    "rects": [{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.05}],
                },
            ).json()
            client.post(
                f"/api/projects/{project_id}/papers/{linked['id']}/notes",
                json={
                    "highlightId": stroke["id"],
                    "page": 1,
                    "anchorY": 0.1,
                    "quotedText": "a claim worth keeping",
                    "body": "worth checking",
                },
            )

            stored = client.post(
                f"/api/projects/{project_id}/papers/{linked['id']}/store"
            )
            assert stored.status_code == 200, stored.text
            record = stored.json()

            # Same paper, now a PDF's record exactly.
            assert record["id"] == linked["id"]
            assert "kind" not in record
            assert "url" not in record
            assert record["filename"] == "2601.16208v1.pdf"

            objects = LocalObjectStore(settings.data_dir)
            assert objects.exists(paper_key("reader", project_id, record["id"], "pdf"))
            # The snapshot is gone, so nothing can serve a stale live page for a
            # document Delphi now holds the bytes of.
            assert not objects.exists(
                paper_key("reader", project_id, record["id"], "web")
            )

            # What was written against it is still written against it.
            assert len(
                client.get(
                    f"/api/projects/{project_id}/papers/{record['id']}/highlights"
                ).json()
            ) == 1
            assert [
                note["body"]
                for note in client.get(
                    f"/api/projects/{project_id}/papers/{record['id']}/notes"
                ).json()
            ] == ["worth checking"]

            # And the file route now serves stored bytes rather than re-fetching.
            served = client.get(
                f"/api/projects/{project_id}/papers/{record['id']}/file"
            )
            assert served.status_code == 200
            assert served.content == resource.body

            # Storing it twice is a mistake the API names rather than repeats.
            again = client.post(
                f"/api/projects/{project_id}/papers/{record['id']}/store"
            )
            assert again.status_code == 409
    finally:
        app.dependency_overrides.clear()


def test_an_oversized_linked_pdf_is_refused_before_it_is_stored(tmp_path, monkeypatch):
    """
    Nothing is written when the bytes will not fit, so the reader is left with
    the linked document exactly as it was rather than a half-promoted one.
    """
    from fastapi.testclient import TestClient
    import delphi_core.routers.projects as projects_router

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        web_sandbox_origin="",
        max_upload_mb=0,
    )
    app.dependency_overrides[get_settings] = lambda: settings
    resource = FetchedResource(
        url="https://arxiv.org/pdf/2601.16208v1",
        body=linked_pdf(),
        content_type="application/pdf",
        encoding="utf-8",
        fetched_at="2026-07-30T00:00:00+00:00",
    )

    async def fake_fetch(url, settings, *, include_pdf=False, **_kwargs):
        if not include_pdf:
            raise HTTPException(409, PDF_URL_DETAIL)
        return resource

    monkeypatch.setattr(projects_router, "fetch_resource", fake_fetch)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project_id = client.post(
                "/api/projects", json={"name": "Linked PDFs"}
            ).json()["id"]
            linked = client.post(
                f"/api/projects/{project_id}/pages",
                json={"url": resource.url, "pdf_mode": "web"},
            ).json()

            refused = client.post(
                f"/api/projects/{project_id}/papers/{linked['id']}/store"
            )
            assert refused.status_code == 413

            papers = client.get(f"/api/projects/{project_id}").json()["papers"]
            still_linked = next(item for item in papers if item["id"] == linked["id"])
            assert still_linked["kind"] == "web"
            objects = LocalObjectStore(settings.data_dir)
            assert objects.exists(paper_key("reader", project_id, linked["id"], "web"))
    finally:
        app.dependency_overrides.clear()


def test_frame_adapts_same_origin_anonymous_css_and_classic_bundles():
    from bs4 import BeautifulSoup

    html = render_frame("""<html><head>
      <link id="css" rel="stylesheet" href="/harness/style.css" crossorigin="">
      <link id="preload" rel="preload" as="script" href="/harness/app.js" crossorigin="anonymous">
      <script id="classic" src="/harness/app.js" crossorigin=""></script>
      <script id="module" type="module" src="/harness/module.js" crossorigin="anonymous"></script>
      <link id="font" rel="preload" as="font" href="/harness/font.woff2" crossorigin="anonymous">
      <link id="integrity" rel="stylesheet" href="/secure.css" crossorigin="anonymous" integrity="sha384-test">
      <link id="external" rel="stylesheet" href="https://cdn.example/style.css" crossorigin="anonymous">
      <script id="credentials" src="/private.js" crossorigin="use-credentials"></script>
    </head><body>Already rendered content</body></html>""", "https://deepseek.com/harness/en/")
    soup = BeautifulSoup(html, "html.parser")
    for identifier in ("css", "preload", "classic"):
        assert not soup.find(id=identifier).has_attr("crossorigin")
    for identifier in ("module", "font", "integrity", "external", "credentials"):
        assert soup.find(id=identifier).has_attr("crossorigin")
    assert soup.find(id="integrity")["integrity"] == "sha384-test"
    assert soup.find("base")["href"] == "https://deepseek.com/harness/en/"


def test_only_a_page_its_own_scripts_draw_is_kept_out_of_the_live_frame():
    """A shell's scripts boot on an origin that is not their own and paint
    nothing (a public Notion page framed blank); a module is not even fetched,
    being fetched with CORS. A page whose article is in its HTML is run live."""
    from delphi_core.web_extract import draws_with_same_origin_modules
    from delphi_core.web_fetch import boots_in_frame

    page = "https://z.ai/blog/glm-built-its-inference-infrastructure"
    article = "<main><h1>Title</h1><p>" + "A sentence of the article itself. " * 40 + "</p></main>"
    # z.ai: an empty body and one module from its own /blog/assets/.
    vite_shell = ('<html><head><script type="module" crossorigin src="/blog/assets/post-qEyLd6aI.js"></script>'
                  '</head><body class="min-h-screen"><div id="app"></div></body></html>')
    inline_shell = '<html><body><script type="module">import("./_app/start.js").then(m => m.start())</script></body></html>'
    assert draws_with_same_origin_modules(vite_shell, page)
    assert draws_with_same_origin_modules(inline_shell, page)
    # Notion: classic scripts, and only "JavaScript must be enabled" in the HTML.
    notion_shell = ('<html><head><script src="/_assets/app.js"></script></head><body><noscript>JavaScript must be '
                    'enabled in order to use Notion.</noscript><div id="notion-app"></div></body></html>')
    classic_shell = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'
    for shell in (vite_shell, inline_shell, notion_shell, classic_shell):
        assert not boots_in_frame(shell, page, 200_000), shell

    # A page whose article is served is framed live, whatever scripts it runs.
    for html in (
        f'<html><body>{article}<script type="module" src="/hydrate.js"></script></body></html>',  # server-drawn
        f'<html><body>{article}<script src="https://www.youtube.com/iframe_api"></script></body></html>',
        f'<html><body>{article}</body></html>',
        '<html><body><img src="/figure.png" alt="A figure"></body></html>',  # nothing a script draws
    ):
        assert boots_in_frame(html, page, 200_000), html


def test_a_page_serving_plenty_of_prose_opens_live_without_being_parsed(monkeypatch):
    """The verdict runs on every live open, so an article that is one on its
    face is not parsed again, whatever else it embeds."""
    from delphi_core import web_extract
    from delphi_core.web_fetch import boots_in_frame

    def no_parse(*_):
        raise AssertionError("a page serving its article was parsed on a live open")
    monkeypatch.setattr(web_extract, "extract", no_parse)
    prose = "<p>" + "A sentence of the article itself, as the site served it. " * 60 + "</p>"
    turnstile = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'
    big = "<html><body><main>" + prose * 400 + "</main><script src='/app.js'></script></body></html>"
    for html in (f"<html><body>{prose}{turnstile}</body></html>", big):
        assert boots_in_frame(html, "https://example.org/a", 200_000)


def test_thumbnail_static_copy_uses_the_same_stylesheet_origin_rules_as_the_reader():
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(static_document('''<!doctype html><html><head>
      <link id="css" rel="stylesheet" href="/blog/assets/site.css" crossorigin>
      <link id="integrity" rel="stylesheet" href="/secure.css" crossorigin integrity="sha384-test">
      <link id="external" rel="stylesheet" href="https://cdn.example/style.css" crossorigin>
      <link id="font" rel="preload" as="font" href="/font.woff2" crossorigin>
    </head><body>Article</body></html>''', "https://article.example/blog/post"), "html.parser")
    assert not soup.find(id="css").has_attr("crossorigin")
    for identifier in ("integrity", "external", "font"):
        assert soup.find(id=identifier).has_attr("crossorigin")
    assert soup.find("base")["href"] == "https://article.example/blog/post"


def test_saved_dom_keeps_remote_players_and_their_source_urls():
    from bs4 import BeautifulSoup

    html = '<html><body><iframe src="https://player.example/video/123" allow="autoplay; fullscreen"></iframe><video src="https://media.example/clip.mp4" controls></video><script>boot()</script></body></html>'
    soup = BeautifulSoup(static_document(html), "html.parser")
    assert soup.iframe["src"] == "https://player.example/video/123"
    assert soup.iframe["allow"] == "autoplay; fullscreen"
    assert soup.video["src"] == "https://media.example/clip.mp4"
    assert soup.video.has_attr("controls")
    assert not soup.find("script")


def test_a_rendering_page_is_done_when_its_article_has_settled_or_it_went_idle():
    """
    The renderer's decision, without a browser. Quiet alone is not done: a
    shell whose script text or served header passes for text, or that is still
    fetching its data, is also quiet. `--dump-dom` erred the other way, holding
    out for every request.
    """
    from delphi_core.browser_render import _render_verdict

    article = lambda: 900
    only_chrome = lambda: 40  # script text and a served header are not article text

    def unasked():
        raise AssertionError("the page's text is walked only once everything else says done")

    assert _render_verdict("complete", 1200, [], article) == "built"
    assert _render_verdict("complete", 1200, [], only_chrome) is None
    assert _render_verdict("complete", 400, [], unasked) is None
    assert _render_verdict("loading", 9000, [], unasked) is None
    # A request of the page's own that began moments ago is its data arriving.
    assert _render_verdict("complete", 1200, [0.8], unasked) is None
    # One pending for longer is a poll or a straggler, and does not hold the page.
    assert _render_verdict("complete", 1200, [7.0], article) == "built"
    # Nothing changing and nothing pending: a challenge or empty page, read as is.
    assert _render_verdict("complete", 5200, [], unasked) == "idle"
    # Still asking with nothing drawn is a shell waiting on its data; still
    # asking under an article that has stood unchanged that long is chatter.
    assert _render_verdict("complete", 5200, [1.0], only_chrome) is None
    assert _render_verdict("complete", 5200, [1.0], article) == "built"


class _WindowedList:
    """A page that draws only the rows in its window, as Notion's public pages do.

    Each row holds `estimate` px until it has been drawn once and `actual` after,
    and a row is drawn only while it meets the window: scrolling past one
    unmounts it. `blank_below` is padding that grows with the window, as
    Notion's does, so the scroll height never matches the content.
    """

    def __init__(self, rows, *, actual=54, estimate=20, blank_below=0.0):
        self.heights = [estimate] * rows
        self.actual, self.blank_below = actual, blank_below
        self.height = 4000
        self.windows = []
        self._draw()

    def _draw(self):
        while True:
            top, drawn = 0, []
            for index, size in enumerate(self.heights):
                if top >= self.height:
                    break
                drawn.append(index)
                top += size
            fresh = [index for index in drawn if self.heights[index] != self.actual]
            for index in fresh:
                self.heights[index] = self.actual
            if not fresh:
                self.drawn = drawn
                return

    def resize(self, height):
        self.windows.append(height)
        self.height = height
        self._draw()

    def probe(self):
        content = sum(self.heights[: len(self.drawn)])
        return {
            "scrollHeight": max(self.height, sum(self.heights) + int(self.blank_below * self.height)),
            "visibleBottom": self.height, "contentBottom": content, "drawn": len(self.drawn),
        }


def test_a_windowed_page_is_shown_a_window_tall_enough_to_draw_all_of_itself():
    """
    Notion drew 83 of 1170 blocks in the capture's window and unmounts a block
    once it leaves the view, so the copy ended where the window did. Its
    reserved space underestimates what it holds and its padding grows with the
    window; the window still ends fitted to the content, never at the cap.
    """
    from delphi_core.browser_render import RENDER_MAX_HEIGHT, _uncover_windowed

    page = _WindowedList(1170, blank_below=0.3)
    assert len(page.drawn) < 100
    height = _uncover_windowed(page.probe, page.resize, lambda: True)
    assert len(page.drawn) == 1170 and page.height == height
    assert 1170 * 54 <= height < 1170 * 54 + 2000, page.windows
    # Each window is a settle the reader waits through: the tallest at once, then the fit.
    assert page.windows == [RENDER_MAX_HEIGHT, height]

    # A fitted window that unmounts the end of the content is put back; one
    # that loses only a little of the page's window-sized chrome is kept.
    for lost_at_end, kept in ((True, False), (False, True)):
        window = [4000]

        # What Notion's page showed in each window it was given, then fitted.
        shown = {
            4000: {"scrollHeight": 23_300, "visibleBottom": 4000, "contentBottom": 5600, "drawn": 1300},
            100_000: {"scrollHeight": 100_000, "visibleBottom": 100_000, "contentBottom": 62_900, "drawn": 20_051},
            63_000: ({"scrollHeight": 81_700, "visibleBottom": 63_000, "contentBottom": 58_000, "drawn": 18_500}
                     if lost_at_end else
                     {"scrollHeight": 81_700, "visibleBottom": 63_000, "contentBottom": 62_850, "drawn": 20_040}),
        }
        probe = lambda: shown[window[-1]]

        height = _uncover_windowed(probe, window.append, lambda: True)
        assert window[1:] == ([100_000, 63_000] if kept else [100_000, 63_000, 100_000]), window
        assert height == window[-1]


def test_an_ordinary_page_is_never_resized_and_one_that_grows_with_its_window_is_put_back():
    from delphi_core.browser_render import RENDER_VIEWPORT_HEIGHT, _uncover_windowed

    resized = []
    article = {"scrollHeight": 9000, "visibleBottom": 4000, "contentBottom": 8800, "drawn": 400}
    assert _uncover_windowed(lambda: article, resized.append, lambda: True) == RENDER_VIEWPORT_HEIGHT
    short = {"scrollHeight": 4000, "visibleBottom": 4000, "contentBottom": 1200, "drawn": 40}
    assert _uncover_windowed(lambda: short, resized.append, lambda: True) == RENDER_VIEWPORT_HEIGHT
    # Blank space below a page whose content ends inside the window holds nothing back.
    footer = {"scrollHeight": 12000, "visibleBottom": 4000, "contentBottom": 2500, "drawn": 90}
    assert _uncover_windowed(lambda: footer, resized.append, lambda: True) == RENDER_VIEWPORT_HEIGHT
    assert resized == []

    # Sized to the window: taller, it is as blank below as before and draws nothing more.
    window = [RENDER_VIEWPORT_HEIGHT]
    stretched = lambda: {"scrollHeight": window[-1] + 6000, "visibleBottom": window[-1],
                         "contentBottom": window[-1], "drawn": 300}
    assert _uncover_windowed(stretched, window.append, lambda: True) == RENDER_VIEWPORT_HEIGHT
    assert len(window) == 3 and window[-1] == RENDER_VIEWPORT_HEIGHT


def test_growing_a_window_is_bounded_by_its_height_and_time():
    from delphi_core.browser_render import RENDER_MAX_HEIGHT, _uncover_windowed

    endless = _WindowedList(20_000)
    height = _uncover_windowed(endless.probe, endless.resize, lambda: True)
    assert height == RENDER_MAX_HEIGHT and endless.windows == [RENDER_MAX_HEIGHT]
    assert 1000 < len(endless.drawn) < 20_000

    # Out of time: what the tallest window drew is kept, and no fitting is tried.
    slow = _WindowedList(1170)
    height = _uncover_windowed(slow.probe, slow.resize, lambda: False)
    assert slow.windows == [RENDER_MAX_HEIGHT] == [height] and len(slow.drawn) == 1170


def test_devtools_startup_has_its_own_enforced_deadline(tmp_path, monkeypatch):
    from types import SimpleNamespace
    import delphi_core.browser_render as renderer

    clock = [0.0]
    monkeypatch.setattr(renderer.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(renderer.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    running = SimpleNamespace(poll=lambda: None)
    # A partially written announcement is not a ready browser.
    (tmp_path / "DevToolsActivePort").write_text("1234\n")
    with pytest.raises(TimeoutError, match="no DevTools port"):
        renderer._wait_for_devtools(running, tmp_path)
    assert renderer.RENDER_STARTUP_SECONDS < clock[0] <= renderer.RENDER_STARTUP_SECONDS + 0.021
    (tmp_path / "DevToolsActivePort").write_text("1234\n/devtools/browser/test\n")
    before = clock[0]
    assert renderer._wait_for_devtools(running, tmp_path) == ("1234", "/devtools/browser/test")
    assert clock[0] == before
    (tmp_path / "DevToolsActivePort").unlink()
    with pytest.raises(RuntimeError, match="chromium exited 9"):
        renderer._wait_for_devtools(SimpleNamespace(poll=lambda: 9, returncode=9), tmp_path)


@pytest.mark.skipif(bool(os.environ.get("CI")), reason=(
    "starts a real Chromium; CI runners start one cold and sandbox-less, and the "
    "decision itself is tested without a browser above"))
@pytest.mark.parametrize("shape", ["hanging request", "script text", "served chrome", "fetched rest", "live source", "live refused"])
def test_the_renderer_reads_a_page_once_its_article_is_built(tmp_path, shape, caplog):
    """
    Built means the article is there and settled — not that the network went
    quiet, and not that there is text. `--dump-dom` waited on every request (a
    request that never answers held it to the deadline); a bare one-second
    quiet read a shell whose inline script or served header and footer passed
    for text while its article was still arriving. Served from one origin, as
    a real page is: a `data:` page's requests to loopback are blocked outright.
    """
    import subprocess
    import threading
    import time
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    import delphi_core.browser_render as renderer

    browser = renderer._chrome_executable()
    if not browser:
        pytest.skip("no Chromium on this machine")
    caplog.set_level("DEBUG", logger=renderer.logger.name)
    later = ("setTimeout(() => { document.getElementById('root').innerHTML ="
             " '<article>' + 'The built article. '.repeat(40) + '</article>'; }, {delay});")
    nav = "<header><nav>" + "".join(f"<a href=/s{i}>Section number {i}</a> " for i in range(30)) + "</nav></header>"
    pages = {
        "live source": '<div id="root">Original shell</div><script>document.getElementById("root").textContent="Changed DOM";fetch("/never")</script>',
        "live refused": '<html><body>Refused</body></html>',
        "hanging request": "<div id=root></div><script>fetch('/never');" + later.replace("{delay}", "300") + "</script>",
        "script text": "<div id=root></div><script>/*" + "config " * 60 + "*/" + later.replace("{delay}", "3000") + "</script>",
        "served chrome": nav + "<main><div id=root></div></main><footer>" + "Copyright and terms. " * 20 + "</footer><script>" + later.replace("{delay}", "3000") + "</script>",
        "fetched rest": "<main><p>" + "A served teaser paragraph. " * 12 + "</p><div id=root></div></main><script>fetch('/rest').then(r => r.text())"
                        ".then(t => document.getElementById('root').innerHTML = t)</script>",

    }

    class Site(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/never":
                time.sleep(30)
                return
            if self.path == "/rest":
                time.sleep(2.5)
                body = "<article>" + "The built article. " * 40 + "</article>"
            else:
                # A page's doctype decides standards or quirks layout, so the
                # read carries it — and invents none for a page that had none.
                doctype = "" if shape == "hanging request" else "<!doctype html>"
                body = f"{doctype}<html><body>{pages[shape]}</body></html>"
            self.send_response(403 if shape == "live refused" else 200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body.encode())

        def log_message(self, *args):
            pass

    site = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    site.daemon_threads = True
    threading.Thread(target=site.serve_forever, daemon=True).start()
    (tmp_path / "crashes").mkdir()
    command = [browser, *renderer.base_chrome_flags(tmp_path / "profile", tmp_path / "crashes", []),
               "--remote-debugging-port=0", "about:blank"]
    errors = tmp_path / "chromium.log"
    with open(errors, "wb") as log:
        process = renderer.spawn_clean(command, stdout=subprocess.DEVNULL, stderr=log)
    try:
        # Exercise the production startup deadline first. The unchanged page
        # bound below includes connection, navigation, settlement and close;
        # it must not also charge Chromium's independent cold-start allowance.
        renderer._wait_for_devtools(process, tmp_path / "profile")
        started = time.monotonic()
        try:
            html = renderer._read_document(
                process, tmp_path / "profile", f"http://127.0.0.1:{site.server_address[1]}/page", 20,
                source_only=shape.startswith("live "),
            ) or ""
        except (RuntimeError, TimeoutError) as exc:
            raise AssertionError(f"{exc}\n{errors.read_text(errors='replace')[-2000:]}") from exc
        elapsed = time.monotonic() - started
    finally:
        renderer.kill_group(process, 9)
        process.wait(timeout=5)
        site.shutdown()
    trace = "\n".join(record.getMessage() for record in caplog.records if "render " in record.getMessage())
    if shape.startswith("live "):
        assert elapsed < 4, f"Live source waited for rendering: {elapsed:.1f}s"
        if shape == "live refused":
            assert not html
        else:
            assert '<div id="root">Original shell</div><script>' in html
        return
    assert "<article>The built article." in html, shape
    assert html.startswith("<!DOCTYPE html><html") != (shape == "hanging request"), html[:40]
    # A request that never answers is waited on for the patience window, not
    # to the deadline.
    assert elapsed < renderer.RENDER_REQUEST_PATIENCE_SECONDS + 4, f"{elapsed:.1f}s\n{trace[-3000:]}"


def test_a_stored_dom_gives_back_the_width_its_scripts_took_from_the_window():
    """
    Notion sizes its frame to the window and writes the number inline, so the
    stored DOM held its article at the capture width: zooming, which narrows the
    layout, cut the text off instead of rewrapping it. Only a width equal to the
    capture viewport is released; design widths and max-widths are the page's.
    """
    from bs4 import BeautifulSoup

    from delphi_core.browser_render import stamp_render_width

    stored = stamp_render_width(
        '<html><body>'
        '<main id="frame" style="display: flex; width: 1512px; transition-property: width">'
        '<div id="column" style="width: 100%; max-width: 1512px">text</div>'
        '<img id="figure" style="width: 1320px; min-width: 1512px">'
        "</main></body></html>",
        1512,
    )
    framed = BeautifulSoup(render_frame(stored, "https://example.notion.site/page"), "html.parser")
    assert framed.find(id="frame")["style"] == "display: flex; width: 100%; transition-property: width"
    assert framed.find(id="column")["style"] == "width: 100%; max-width: 1512px"
    assert framed.find(id="figure")["style"] == "width: 1320px; min-width: 1512px"

    live = '<html><body><main id="frame" style="width: 1512px"></main></body></html>'
    unstamped = BeautifulSoup(render_frame(live, "https://example.org/"), "html.parser")
    assert unstamped.find(id="frame")["style"] == "width: 1512px"


@pytest.mark.asyncio
async def test_a_second_dns_answer_cannot_move_a_fetch_inside_the_network(monkeypatch):
    """DNS rebinding: the check is shown a public answer, the connection a loopback one."""
    import asyncio
    import socket
    import delphi_core.web_fetch as web_fetch

    received = []

    async def internal(reader, writer):
        received.append(await reader.read(1024))
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 26\r\n\r\n<main>Internal page</main>")
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(internal, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    asked = []

    def resolved(host, port, *_args, **_kwargs):
        asked.append(host)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8" if len(asked) == 1 else "127.0.0.1", port or 80))]

    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", resolved)
    try:
        with pytest.raises(HTTPException) as caught:
            await fetch_resource(f"http://rebinding.example:{port}/", Settings())
    finally:
        server.close()
    assert caught.value.status_code == 422 and "not reachable" in caught.value.detail
    assert asked == ["rebinding.example", "rebinding.example"]
    assert received == []


@pytest.mark.asyncio
async def test_the_web_client_dials_the_addresses_it_validated_not_the_name(monkeypatch):
    import socket
    import httpcore
    import delphi_core.web_fetch as web_fetch

    dialed = []

    async def dial(_backend, host, port, *_args, **_kwargs):
        dialed.append((host, port))
        raise httpcore.ConnectError("unreachable in this test")

    monkeypatch.setattr(httpcore.AnyIOBackend, "connect_tcp", dial)
    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", lambda _host, port, *_args, **_kwargs: [
        (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:4700:4700::1111", port, 0, 0)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port)),
    ])
    with pytest.raises(HTTPException):
        await fetch_resource("https://source.example/article", Settings())
    assert dialed == [("2606:4700:4700::1111", 443), ("8.8.8.8", 443)]


def test_a_prepared_preview_keeps_how_the_page_drew_and_nothing_that_runs():
    from delphi_core.web_revision import inert_document

    document = inert_document(
        '<html><head><link rel="stylesheet" href="/a.css" media="print" onload="this.media=\'all\'">'
        '<meta http-equiv="refresh" content="0;url=file:///etc/hosts"></head><body>'
        '<img src="/x.png" onerror="fetch(\'file:///etc/hosts\')"><iframe srcdoc="&lt;script&gt;1&lt;/script&gt;"></iframe>'
        '<iframe src="data:text/html,&lt;script&gt;1&lt;/script&gt;"></iframe><a href="javascript:1">Link</a>'
        '<svg><animate attributeName="href" to="javascript:1"/></svg><noscript>JavaScript must be enabled</noscript>'
        '<p onclick="x()">Article</p></body></html>')
    for code in ("onerror", "onclick", "onload", "srcdoc", "javascript:", "data:text/html", "http-equiv", "<animate"):
        assert code not in document, code
    # As the page drew: the deferred stylesheet applied, the fallback still there
    # (and hidden, since scripts stay enabled), the image and the text kept.
    assert 'media="all"' in document
    assert "<noscript>JavaScript must be enabled</noscript>" in document
    assert 'src="/x.png"' in document and "Article" in document


def test_the_live_verdicts_prose_pass_stays_linear_and_reads_whole_tag_names():
    """It runs on every live open: a page of custom elements once took nine
    seconds, holding the interpreter while it did."""
    import time
    from delphi_core.web_fetch import LIVE_PROSE_CHARS, _served_prose

    for unit in ("<svg-icon></svg-icon><p>word</p>", "<svg ", "<style-x>", "<!-- open "):
        html = "<html><body>" + unit * 20000 + "</body></html>"
        started = time.perf_counter()
        _served_prose(html)
        assert time.perf_counter() - started < 0.5, unit
    # <svg-icon> is not <svg>: the words beside it are prose.
    assert _served_prose("<p>" + "<svg-icon></svg-icon>words " * 30 + "</p>") >= 150
    # What a reader never sees is not counted, a comment's ">" included.
    hidden = ("<script>var a = '<p>" + "x " * 3000 + "';</script><style>" + "p{} " * 900 + "</style>"
              "<noscript>" + "JavaScript must be enabled " * 100 + "</noscript><!-- a > b " + "y " * 2000 + "-->"
              "<svg><text>" + "z " * 2000 + "</text></svg><p>Shown</p>")
    assert _served_prose(hidden) == len("Shown")
    # Enough is enough: a long article is not read to its end.
    paragraphs = "<p>" + "A sentence of the article. " * 20 + "</p>"
    assert LIVE_PROSE_CHARS <= _served_prose(paragraphs * 20000) < 2 * LIVE_PROSE_CHARS
