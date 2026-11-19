"""
The page copy: what the reader's frame sends after an annotation, what the
server keeps of it, and how that stays independent of the text the model reads.
"""
import hashlib
import json
from types import SimpleNamespace

import pytest
from bs4 import BeautifulSoup
from fastapi import HTTPException
from fastapi.testclient import TestClient

from delphi_core.browser_render import render_width_of
from delphi_core.config import Settings, get_settings
from delphi_core.main import app
from delphi_core.routers import projects
from delphi_core.security import make_page_token
from delphi_core.storage import LocalObjectStore, LocalStorage, paper_key
from delphi_core.web_fetch import FetchedResource
from delphi_core.web_proxy import render_frame
from delphi_core.web_revision import (
    freeze,
    keeps_fetched_text,
    page_fields,
    page_text,
    publish_saved_page,
    publish_snapshot,
    read_revision,
)

URL = "https://example.org/article"
ARTICLE = [
    "Diffusion models learn the score of a distribution blurred by noise, one level at a time. " * 3,
    "The sampler walks back down those levels, and its step size decides what survives. " * 3,
]


def document(texts=ARTICLE):
    return {"url": URL, "title": "Article", "fetchedAt": "2026-09-22T12:00:00Z",
            "sections": [{"anchor": f"s{i}", "title": "S", "markdown": text} for i, text in enumerate(texts)]}


def fetched_html(texts=ARTICLE):
    """The page as a server fetch sees it: the formula is still its script source."""
    return ("<html><body><article>" + "".join(f"<p>{text}</p>" for text in texts)
            + '<script type="math/tex">x^2</script></article></body></html>')


def framed_page(texts=ARTICLE, extra=""):
    """The page as the reader's frame serialises it once MathJax has typeset it.

    Carries everything `render_frame` and the bridge put there, which the
    bridge's own capture removes and `freeze` must remove again regardless.
    """
    return (
        '<!DOCTYPE html><html data-delphi-annotation-hover="" data-delphi-render-width="99999">'
        f'<head><base data-delphi-frame="" href="{URL}"><meta content="no-referrer" data-delphi-frame="" name="referrer">'
        '<script data-delphi-frame="">window.__DELPHI__={};</script><script data-delphi-frame="">/* bridge */</script>'
        '<style data-delphi-annotation="true">::highlight(delphi-annotations){}</style>'
        '<style data-emotion="css">.css-1{color:rgb(40, 20, 10)}</style></head><body><article>'
        f"<p>{texts[0]}</p>"
        '<p>where <mjx-container class="MathJax" jax="SVG"><svg><use href="#MJX-1-TEX-I-1D465"></use></svg>'
        "<mjx-assistive-mml><math><msup><mi>x</mi><mn>2</mn></msup></math></mjx-assistive-mml></mjx-container> is the energy</p>"
        + "".join(f"<p>{text}</p>" for text in texts[1:])
        + extra
        + '</article><svg id="MJX-SVG-global-cache" style="display: none"><defs><path d="M52 289Q59 331" id="MJX-1-TEX-I-1D465"></path></defs></svg>'
        "</body></html>"
    )


@pytest.fixture
def reader(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    photographed = []

    async def thumbnail(*args, **_kwargs):
        # Which copy the card is taken from, at the moment it is taken.
        photographed.append(read_revision(args[3], args[5], args[6], args[7]).get("savedPageHash"))
        return True

    monkeypatch.setattr(projects, "make_web_thumbnail_safely", thumbnail)
    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-123"})
            project = client.post("/api/projects", json={"name": "Pages"}).json()["id"]
            storage, objects = LocalStorage(settings), LocalObjectStore(tmp_path)
            storage.add_paper("reader", project, {"id": "page", "kind": "web", "title": "Article", "url": URL})
            publish_snapshot(objects, "reader", project, "page", document(), {},
                             page=page_fields(freeze(fetched_html(), URL), URL, "2026-09-22T12:00:00Z"))
            path = f"/api/projects/{project}/papers/page"

            def put(body, width=1180, url=URL, **kwargs):
                content = body.encode("utf-8") if isinstance(body, str) else body
                return client.put(path + "/saved-page", params={"width": width, "url": url}, content=content,
                                  headers={"Content-Type": "text/html; charset=utf-8"}, **kwargs)

            yield SimpleNamespace(client=client, storage=storage, objects=objects, settings=settings, project=project,
                                  path=path, put=put, photographed=photographed,
                                  revision=lambda: read_revision(objects, "reader", project, "page"),
                                  text=lambda: objects.get_text(paper_key("reader", project, "page", "txt")))
    finally:
        app.dependency_overrides.clear()


# --- the route ---------------------------------------------------------------------


def test_the_annotated_page_is_kept_inert_at_its_width_and_is_what_the_cached_view_shows(reader):
    stored = reader.put(framed_page())
    assert stored.status_code == 200, stored.text
    assert stored.json()["changed"] is True
    revision = reader.revision()
    saved = revision["savedDom"]
    soup = BeautifulSoup(saved, "html.parser")
    # Delphi's own markup is shed, however it arrived; the page's is kept.
    assert not soup.find_all(["script", "base"]) and not soup.select("[data-delphi-frame], [data-delphi-annotation]")
    assert soup.html["data-delphi-render-width"] == "1180"
    assert "data-delphi-annotation-hover" not in saved and "99999" not in saved
    assert ".css-1{color:rgb(40, 20, 10)}" in saved
    # The typeset formula, and the glyph it draws from, both survive.
    assert soup.find("use")["href"] == "#MJX-1-TEX-I-1D465" and soup.find(id="MJX-1-TEX-I-1D465")
    assert revision["savedPageHash"] == hashlib.sha256(saved.encode("utf-8")).hexdigest()
    assert revision["savedPageUrl"] == URL and revision["savedPageAt"] == stored.json()["savedAt"]
    assert reader.photographed == [revision["savedPageHash"]]

    descriptor = reader.client.get(reader.path + "/page-url?view=cached").json()
    assert descriptor["renderWidth"] == 1180
    framed = reader.client.get(descriptor["url"], headers={"Sec-Fetch-Dest": "iframe"})
    assert framed.status_code == 200 and "mjx-container" in framed.text
    # Framed once: the copy did not bring a second base or bridge with it.
    shown = BeautifulSoup(framed.text, "html.parser")
    assert len(shown.find_all("base")) == 1 and len(shown.find_all("script")) == 2

    menu = reader.client.get(reader.path + "/annotation-revision").json()
    assert menu == {"available": True, "savedAt": revision["savedPageAt"]}


def test_a_page_copy_leaves_the_text_and_the_digest_alone(reader):
    before, text = reader.revision(), reader.text()
    paper = reader.storage.get_paper("reader", reader.project, "page")
    assert reader.put(framed_page()).status_code == 200
    after = reader.revision()
    assert after["sections"] == before["sections"] and after["fetchedAt"] == before["fetchedAt"]
    assert reader.text() == text
    # Nothing a digest is judged current against moves: only the card does.
    unthumbed = lambda record: {key: value for key, value in record.items() if not key.startswith("thumbnail")}
    assert unthumbed(reader.storage.get_paper("reader", reader.project, "page")) == unthumbed(paper)


def test_an_identical_copy_writes_nothing_and_photographs_nothing(reader):
    first = reader.put(framed_page())
    web = reader.objects.get_text(paper_key("reader", reader.project, "page", "web"))
    # The same page annotated again, or a retry after a lost response.
    again = reader.put(framed_page())
    assert again.status_code == 200 and again.json() == {"changed": False, "savedAt": first.json()["savedAt"]}
    assert reader.objects.get_text(paper_key("reader", reader.project, "page", "web")) == web
    assert len(reader.photographed) == 1
    # A page that changed since is a new copy.
    assert reader.put(framed_page(extra="<p>A reply added below the article.</p>")).json()["changed"] is True
    assert len(reader.photographed) == 2


@pytest.mark.parametrize("case", ["login wall", "unrelated page", "no text", "half loaded"])
def test_a_page_that_is_not_the_document_keeps_the_saved_copy(reader, case):
    body = {
        "login wall": framed_page(texts=["Subscribe to continue reading. " + ARTICLE[0], ARTICLE[1]]),
        "unrelated page": framed_page(texts=["A cooking blog about sourdough starters and the flour they want. " * 6, "Nothing else."]),
        "no text": "<html><body><article><p>Loading…</p></article></body></html>",
        "half loaded": framed_page(texts=[ARTICLE[0][:120], ""]),
    }[case]
    before = reader.revision()
    refused = reader.put(body)
    assert refused.status_code == 409, refused.text
    assert reader.revision() == before and reader.photographed == []


def test_the_overlap_guard_is_a_completeness_check_not_proof_of_authenticity():
    """A hostile page can hide the fetched text and show something else; nothing
    server-side can tell, which is why the copy is only ever shown sandboxed."""
    hidden = framed_page(extra='<div style="display:none">' + " ".join(ARTICLE) + "</div>")
    assert keeps_fetched_text(page_text(freeze(hidden, URL)), document())
    assert not keeps_fetched_text("Something else entirely", document())


def test_a_copy_is_refused_before_it_is_stored_when_it_is_too_large(reader):
    reader.settings.web_saved_page_max_bytes = 4096
    before = reader.revision()
    # Under the limit in characters, over it in UTF-8 bytes.
    body = "<html><body><p>" + "😀" * 1500 + "</p></body></html>"
    assert len(body) < 4096 < len(body.encode("utf-8"))
    assert reader.put(body).status_code == 413
    # Streamed with no length to judge it by: refused once it passes the limit.
    chunks = (("<p>" + "x" * 1000 + "</p>").encode() for _ in range(64))
    assert reader.put(chunks).status_code == 413
    assert reader.revision() == before and reader.photographed == []


@pytest.mark.parametrize("params", [
    {"width": 100}, {"width": 20000}, {"width": "wide"},
    {"url": "javascript:alert(1)"}, {"url": "ftp://example.org/article"}, {"url": "/relative"},
    # The frame's own address, which is what a page that removed its base reports.
    {"url": "http://testserver/api/projects/p/papers/page/page?view=live&t=token"}, {"url": "http://localhost:3000/"},
])
def test_a_copy_must_name_a_real_width_and_web_address(reader, params):
    before = reader.revision()
    assert reader.put(framed_page(), **{"width": 1180, "url": URL, **params}).status_code == 422
    assert reader.revision() == before


def test_a_copy_must_be_utf8(reader):
    assert reader.put(framed_page().encode("utf-8") + b"\xff\xfe").status_code == 422


def test_only_the_account_itself_may_store_a_copy(reader):
    # The sandboxed frame holds a page token and never the session cookie.
    token = make_page_token("reader", reader.project, "page", reader.settings.session_secret, 60)
    cookies = dict(reader.client.cookies)
    reader.client.cookies.clear()
    anonymous = reader.client.put(reader.path + f"/saved-page?width=1180&url={URL}&t={token}", content=framed_page().encode())
    assert anonymous.status_code == 401
    reader.client.post("/api/auth/register", json={"username": "other", "password": "password-123"})
    assert reader.put(framed_page()).status_code == 404
    reader.client.cookies.clear()
    reader.client.cookies.update(cookies)
    reader.storage.add_paper("reader", reader.project, {"id": "pdf", "kind": "pdf", "title": "Paper", "filename": "paper.pdf"})
    assert reader.client.put(f"/api/projects/{reader.project}/papers/pdf/saved-page?width=1180&url={URL}",
                             content=framed_page().encode()).status_code == 409


# --- the text refresh, beside it ---------------------------------------------------


def refresh_fetches(monkeypatch, texts, *, during=None, refuse=False):
    async def fetched(url, _settings, **_kwargs):
        if refuse:
            raise HTTPException(403, {"code": "blocked", "message": "example.org blocks automated readers."})
        if during:
            during()
        return FetchedResource(url=url, body=fetched_html(texts).encode(), content_type="text/html",
                               encoding="utf-8", fetched_at="2026-09-23T09:00:00Z")

    async def extracted(resource, _limit, *, whole=True):
        return {**document(texts), "url": resource.url}

    monkeypatch.setattr(projects, "fetch_resource", fetched)
    monkeypatch.setattr(projects, "extract_with_render_fallback", extracted)


def test_a_refresh_renews_the_text_and_leaves_the_page_copy_and_its_thumbnail(reader, monkeypatch):
    reader.put(framed_page())
    copy, photographed = reader.revision()["savedDom"], list(reader.photographed)
    texts = [*ARTICLE, "A paragraph the site has added since."]
    refresh_fetches(monkeypatch, texts)
    assert reader.client.post(reader.path + "/refresh").status_code == 200
    assert "added since" in reader.text() and reader.revision()["savedDom"] == copy
    assert reader.photographed == photographed
    assert reader.storage.get_paper("reader", reader.project, "page")["bytes"] == len(reader.text().encode("utf-8"))


def test_a_refused_refresh_keeps_both_halves(reader, monkeypatch):
    reader.put(framed_page())
    before, text = reader.revision(), reader.text()
    refresh_fetches(monkeypatch, ARTICLE, refuse=True)
    assert reader.client.post(reader.path + "/refresh").status_code == 403
    assert reader.revision() == before and reader.text() == text


def test_a_page_copy_stored_while_a_refresh_fetches_is_kept_by_it(reader, monkeypatch):
    frozen = freeze(framed_page(), URL, 1180)

    def upload_lands():
        publish_saved_page(reader.objects, "reader", reader.project, "page", frozen, page_text(frozen), URL, reader.storage)

    texts = [*ARTICLE, "A paragraph the site has added since."]
    refresh_fetches(monkeypatch, texts, during=upload_lands)
    refreshed = reader.client.post(reader.path + "/refresh")
    assert refreshed.status_code == 200, refreshed.text
    revision = reader.revision()
    assert revision["savedDom"] == frozen and "added since" in revision["sections"][-1]["markdown"]


# --- the sanitizer -----------------------------------------------------------------


@pytest.mark.parametrize("href", [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "java&#10;script:alert(1)", "java&#9;script:alert(1)",
    "&#1;javascript:alert(1)", "  javascript:alert(1)", "vbscript:msgbox(1)", "blob:https://example.org/uuid",
    "data:text/html,<script>alert(1)</script>",
])
def test_no_url_that_runs_code_survives_however_it_is_spelled(href):
    frozen = freeze(f'<html><body><a id="a" href="{href}">link</a><img id="i" src="{href}">'
                    f'<svg><a id="s" xlink:href="{href}"><text>t</text></a></svg><button id="b" formaction="{href}">b</button>'
                    f'<img id="set" srcset="/ok.png 1x, {href} 2x"></body></html>', URL)
    soup = BeautifulSoup(frozen, "html.parser")
    for identifier, attribute in [("a", "href"), ("i", "src"), ("s", "xlink:href"), ("b", "formaction"), ("set", "srcset")]:
        # In a srcset a tab or newline ends the URL, as a browser splits it:
        # `java` and a descriptor, which loads nothing.
        if identifier == "set" and ("&#10;" in href or "&#9;" in href):
            continue
        assert not soup.find(id=identifier).has_attr(attribute), (identifier, frozen)


def test_ordinary_and_image_urls_are_kept():
    frozen = freeze('<html><body><a id="rel" href="/next">n</a><a id="frag" href="#s2">f</a><a id="mail" href="mailto:a@b.c">m</a>'
                    '<img id="data" src="data:image/png;base64,iVBOR"><img id="set" srcset="/a.png 1x, https://cdn.example/b.png 2x">'
                    "</body></html>", URL)
    soup = BeautifulSoup(frozen, "html.parser")
    assert [soup.find(id=i).get(a) for i, a in [("rel", "href"), ("frag", "href"), ("mail", "href"), ("data", "src"), ("set", "srcset")]] == [
        "/next", "#s2", "mailto:a@b.c", "data:image/png;base64,iVBOR", "/a.png 1x, https://cdn.example/b.png 2x"]


def test_players_stay_players_and_other_embeds_become_links():
    frozen = freeze(
        '<html><body><iframe id="yt" src="https://www.youtube-nocookie.com/embed/abc" allow="autoplay; fullscreen"></iframe>'
        '<iframe id="vimeo" src="https://player.vimeo.com/video/123"></iframe>'
        '<iframe id="doc" src="data:text/html,<script>parent.postMessage(1,`*`)</script>"></iframe>'
        '<iframe id="js" src="java&#10;script:alert(1)"></iframe><iframe id="inline" srcdoc="<script>alert(1)</script>"></iframe>'
        '<object data="https://example.org/figure.svg" type="image/svg+xml"></object><embed src="javascript:alert(1)">'
        '<svg><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="xlink:href" to="javascript:alert(1)"/>'
        '<animate attributeName="opacity" to="1"/></svg></body></html>', URL)
    soup = BeautifulSoup(frozen, "html.parser")
    assert soup.find(id="yt")["src"] == "https://www.youtube-nocookie.com/embed/abc" and soup.find(id="yt")["allow"] == "autoplay; fullscreen"
    assert soup.find(id="vimeo")["src"] == "https://player.vimeo.com/video/123"
    assert [frame.get("id") for frame in soup.find_all("iframe")] == ["yt", "vimeo"]
    assert not soup.find_all(["object", "embed"])
    assert [a["href"] for a in soup.find_all("a")] == ["https://example.org/figure.svg"]
    assert [node["attributename"] for node in soup.find_all(["animate", "set"])] == ["opacity"]


def test_delphis_own_markup_never_survives_and_a_width_is_only_ever_stamped():
    page = ('<html data-delphi-unavailable="cached" data-delphi-render-width="1512"><head></head><body>'
            '<p data-delphi-annotation-hover="">Text</p><code>&lt;html data-delphi-render-width="640"&gt;</code>'
            '<div data-delphi-render-width="777">x</div></body></html>')
    assert render_width_of(freeze(page, URL), 0) == 0
    frozen = freeze(page, URL, 1180)
    assert render_width_of(frozen, 0) == 1180 and "data-delphi-unavailable" not in frozen and "777" not in frozen


def test_freezing_a_framed_page_again_accumulates_nothing():
    once = freeze(render_frame(freeze(fetched_html(), URL), URL), URL)
    assert freeze(render_frame(once, URL), URL) == once
    assert "no-referrer" not in once and "<base" not in once
