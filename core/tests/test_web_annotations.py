import pytest
from pydantic import ValidationError
from delphi_core.schemas import HtmlHighlight, NoteCreate


def html_payload():
    return {"type":"html", "text":"A 😀 quote", "requestId":"a"*32, "color":"amber", "anchor": {
        "version":1,"revision":"a"*64,"blockHash":"b"*64,"blockOrdinalHint":0,
        "startInBlock":0,"start":0,"end":10,"prefix":"","suffix":""}}


def test_html_offsets_use_dom_utf16_units():
    payload=html_payload()
    assert HtmlHighlight.model_validate(payload).anchor.end == 10
    payload["anchor"]["end"]=9
    with pytest.raises(ValidationError):
        HtmlHighlight.model_validate(payload)


def test_html_note_requires_explicit_null_coordinates():
    assert NoteCreate(highlightId="h",page=None,anchorY=None,quotedText="q",body="note").page is None
    with pytest.raises(ValidationError):
        NoteCreate(highlightId="h",quotedText="q",body="note")


def test_web_annotation_routes_keep_notes_outside_the_saved_copy(tmp_path):
    from fastapi.testclient import TestClient
    from delphi_core.config import Settings, get_settings
    from delphi_core.main import app
    from delphi_core.storage import LocalStorage
    settings=Settings(data_dir=tmp_path,session_secret="test-session-secret")
    app.dependency_overrides[get_settings]=lambda:settings
    try:
        with TestClient(app) as client:
            client.post('/api/auth/register',json={"username":"reader","password":"password-123"})
            project=client.post('/api/projects',json={"name":"Web"}).json()['id']
            storage=LocalStorage(settings)
            storage.add_paper('reader',project,{"id":"webpage","title":"Page","filename":"example.org","kind":"web","url":"https://example.org/article"})
            path=f'/api/projects/{project}/papers/webpage'
            payload=html_payload()
            h=client.post(path+'/highlights',json=payload)
            assert h.status_code==201,h.text
            again=client.post(path+'/highlights',json=payload)
            assert again.json()['id']==h.json()['id']
            note=client.post(path+'/notes',json={"highlightId":h.json()['id'],"page":None,"anchorY":None,"quotedText":payload['text'],"body":"Private thought"})
            assert note.status_code==201,note.text
            assert client.get(path+'/annotation-revision').json()['available'] is False
            assert client.get(path+'/notes').json()[0]['body']=='Private thought'
            client.cookies.clear()
            assert client.post(path+'/highlights?t=untrusted-read-token',json=payload).status_code==401
            assert client.get(path+'/notes').status_code==401
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_reply_uses_captured_text_without_fetching_its_url(monkeypatch):
    import hashlib
    from delphi_core.routers import chat
    from delphi_core.schemas import ChatRequest
    from delphi_core.config import Settings
    texts=['The selection-time article, before it changed.']
    viewport={"source":"captured","kind":"html","url":"https://example.org/article","title":"Article",
              "texts":texts,"revision":hashlib.sha256(('1\n'+'\n'.join(texts)).encode()).hexdigest()}
    async def forbidden(*args,**kwargs):
        pytest.fail('Captured evidence must not refetch a mutable URL')
    monkeypatch.setattr(chat,'fetch_resource',forbidden)
    body=ChatRequest(scope="document", prompt='Explain this',paper_id='p',viewport=viewport)
    document, image, evidence=await chat.prepare_viewport_context(body,'reader',Settings())
    assert document['sections'][0]['markdown']==texts[0]
    assert image is None and evidence['document']==document


@pytest.mark.parametrize("rendered", [False, True])
def test_live_view_never_publishes_and_a_refresh_leaves_the_copy_alone(tmp_path, monkeypatch, rendered):
    import json
    from fastapi.testclient import TestClient
    from delphi_core.config import Settings, get_settings
    from delphi_core.main import app
    from delphi_core.routers import projects
    from delphi_core.storage import LocalStorage, LocalObjectStore, paper_key
    from delphi_core.web_fetch import FetchedResource
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    original = "The original complete article " * 40
    source = {"text": "New introduction", "calls": 0, "extracts": 0, "renders": 0}
    article = lambda: f'<html><body><article>{original}<p>{source["text"]}</p></article></body></html>'
    async def fetched(url, _settings, **kwargs):
        source["calls"] += 1
        # A page that needs a browser serves the scripts that draw it, not its text.
        body = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>' if rendered else article()
        return FetchedResource(url=url, body=body.encode(), content_type="text/html", encoding="utf-8", fetched_at="2026-09-22T22:00:00Z")
    async def extracted(resource, _limit, *, whole=True):
        source["extracts"] += 1
        doc = {"url": resource.url, "title": "Article", "sections": [{"anchor": "old", "title": "Old", "markdown": original}, {"anchor": "new", "title": "New", "markdown": source["text"]}]}
        if rendered: doc["_rendered"] = article().replace('<html>', '<html data-delphi-render-width="1512">')
        return doc
    async def no_thumbnail(*args, **kwargs): return False
    monkeypatch.setattr(projects, "fetch_resource", fetched)
    monkeypatch.setattr(projects, "extract_with_render_fallback", extracted)
    monkeypatch.setattr(projects, "make_web_thumbnail_safely", no_thumbnail)
    try:
        with TestClient(app) as client:
            client.post('/api/auth/register', json={"username": "reader", "password": "password-123"})
            project = client.post('/api/projects', json={"name": "Pages"}).json()['id']
            storage, objects = LocalStorage(settings), LocalObjectStore(tmp_path)
            storage.add_paper('reader', project, {"id": "page", "kind": "web", "title": "Article", "url": "https://example.org/article"})
            path = f'/api/projects/{project}/papers/page'
            key = paper_key('reader', project, 'page', 'web')
            saved = {"url": "https://example.org/article", "title": "Article", "savedDom": f'<html><body>{original}</body></html>', "sections": [{"anchor": "old", "title": "Old", "markdown": original}]}
            objects.put_text(key, json.dumps(saved))
            before = objects.get_text(key)
            headers = {"Sec-Fetch-Dest": "iframe"}
            # Unnamed, every document opens live.
            assert client.get(path + '/page-url').json()['view'] == 'live'
            for fresh in ("New introduction", "Another introduction"):
                source["text"] = fresh
                descriptor = client.get(path + '/page-url?view=live').json()
                assert descriptor['view'] == 'live' and descriptor['renderWidth'] is None
                page = client.get(descriptor['url'], headers=headers)
                assert page.status_code == 200, page.text
                if rendered:
                    # Its scripts would boot on an origin not their own and
                    # paint nothing, so the reader is sent to the saved copy.
                    assert 'data-delphi-unavailable="live"' in page.text
                    assert '<script src="/app.js"></script>' not in page.text
                    assert 'data-delphi-render-width="1512"' not in page.text
                else:
                    assert fresh in page.text
                assert page.headers['cache-control'] == 'private, no-store'
                assert objects.get_text(key) == before
            # The live document boots in the reader, never in a throwaway renderer.
            assert source['extracts'] == 0
            assert source['renders'] == 0
            calls = source['calls']
            cached = client.get(path + '/page-url?view=cached').json()
            page = client.get(cached['url'], headers=headers)
            assert page.status_code == 200 and 'Another introduction' not in page.text
            assert source['calls'] == calls and objects.get_text(key) == before
            # What a reader's first annotation of a visit sends beside the page
            # copy: the text is renewed, and the copy the reader sees is not.
            updated = client.post(path + '/refresh')
            assert updated.status_code == 200, updated.text
            refreshed = json.loads(objects.get_text(key))
            assert 'Another introduction' in objects.get_text(paper_key('reader', project, 'page', 'txt'))
            assert refreshed['savedDom'] == saved['savedDom']
            assert 'Another introduction' not in client.get(cached['url'], headers=headers).text
            assert client.get(path + '/page?view=some-url', headers=headers).status_code == 422
            # A failed view is still a framed document, so the bridge can tell
            # the reader to fall back instead of the frame looking like an escape.
            async def failed(*args, **kwargs): raise RuntimeError('source unavailable')
            monkeypatch.setattr(projects, 'fetch_resource', failed)
            after = objects.get_text(key)
            page = client.get(path + '/page?view=live', headers=headers)
            assert page.status_code == 503
            assert 'data-delphi-unavailable="live"' in page.text and 'delphi-page' in page.text
            assert 'data-delphi-unavailable-reason="' not in page.text
            assert objects.get_text(key) == after
            objects.delete(key)
            page = client.get(path + '/page?view=cached', headers=headers)
            assert page.status_code == 404
            assert 'data-delphi-unavailable="cached"' in page.text
    finally:
        app.dependency_overrides.clear()


def test_a_page_only_its_own_modules_draw_falls_back_to_the_saved_copy(tmp_path, monkeypatch):
    """
    z.ai's blog is a Vite shell: framed live, its module is refused on the
    sandbox origin and the reader saw nothing. The live view now says it is
    unavailable — without rendering or storing anything — and the reader's
    existing fallback shows the saved copy.
    """
    import json
    from fastapi.testclient import TestClient
    from delphi_core.config import Settings, get_settings
    from delphi_core.main import app
    from delphi_core.routers import projects
    from delphi_core.storage import LocalStorage, LocalObjectStore, paper_key
    from delphi_core.web_fetch import FetchedResource
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    shell = '<html><head><script type="module" crossorigin src="/blog/assets/post.js"></script></head><body><div id="app"></div></body></html>'
    async def fetched(url, _settings, **kwargs):
        return FetchedResource(url=url, body=shell.encode(), content_type="text/html", encoding="utf-8", fetched_at="2026-09-29T00:00:00Z")
    async def forbidden(*args, **kwargs):
        pytest.fail("The live view must not render or extract through the snapshot pipeline")
    monkeypatch.setattr(projects, "fetch_resource", fetched)
    monkeypatch.setattr(projects, "extract_with_render_fallback", forbidden)
    try:
        with TestClient(app) as client:
            client.post('/api/auth/register', json={"username": "reader", "password": "password-123"})
            project = client.post('/api/projects', json={"name": "Pages"}).json()['id']
            storage, objects = LocalStorage(settings), LocalObjectStore(tmp_path)
            storage.add_paper('reader', project, {"id": "page", "kind": "web", "title": "Post", "url": "https://z.ai/blog/post"})
            path = f'/api/projects/{project}/papers/page'
            key = paper_key('reader', project, 'page', 'web')
            objects.put_text(key, json.dumps({"url": "https://z.ai/blog/post", "title": "Post",
                                              "savedDom": "<html><body><article>The built article</article></body></html>"}))
            before = objects.get_text(key)
            headers = {"Sec-Fetch-Dest": "iframe"}
            live = client.get(client.get(path + '/page-url?view=live').json()['url'], headers=headers)
            assert live.status_code == 200
            assert 'data-delphi-unavailable="live"' in live.text and 'delphi-page' in live.text
            # Not a failure: the reader says why over the saved copy.
            assert 'data-delphi-unavailable-reason="own-address"' in live.text
            assert '/blog/assets/post.js' not in live.text
            cached = client.get(client.get(path + '/page-url?view=cached').json()['url'], headers=headers)
            assert 'The built article' in cached.text
            assert objects.get_text(key) == before
    finally:
        app.dependency_overrides.clear()


def test_a_refresh_keeps_the_saved_text_whole(tmp_path):
    """
    Refresh is the one writer of a document's text after import, sent by a
    reader's first annotation of a visit. It refuses a page that came back
    truncated or mostly replaced, and text that changed while it ran.
    """
    import json
    from fastapi import HTTPException
    from delphi_core.storage import LocalObjectStore, paper_key
    from delphi_core.web_revision import freeze, page_fields, publish_snapshot, read_revision

    objects = LocalObjectStore(tmp_path)
    key = paper_key("reader", "project", "paper", "web")
    paragraphs = ["First complete paragraph " + "about a real article. " * 20, "Second complete paragraph " + "with details. " * 20]
    def document(texts):
        return {"url": "https://example.org/article", "title": "Article", "sections": [{"anchor": f"s{i}", "title": "S", "markdown": t} for i, t in enumerate(texts)]}
    html = lambda texts: "<html><body>" + "".join(f"<p>{t}</p>" for t in texts) + "<script>boot()</script></body></html>"
    url = "https://example.org/article"
    publish_snapshot(objects, "reader", "project", "paper", document(paragraphs), {},
                     page=page_fields(freeze(html(paragraphs), url), url, "2026-09-22T12:00:00Z"))
    saved = read_revision(objects, "reader", "project", "paper")
    assert "<script" not in saved["savedDom"] and "annotationRevision" not in saved

    for shrunk in ([paragraphs[0][:50]], ["Entirely different text " * 30]):
        with pytest.raises(HTTPException, match="incomplete or substantially changed"):
            publish_snapshot(objects, "reader", "project", "paper", document(shrunk), saved)
    assert read_revision(objects, "reader", "project", "paper") == saved
    with pytest.raises(HTTPException, match="changed during refresh"):
        publish_snapshot(objects, "reader", "project", "paper", document(paragraphs), {"stale": True})

    texts = ["New introduction", *paragraphs]
    publish_snapshot(objects, "reader", "project", "paper", document(texts), saved)
    refreshed = json.loads(objects.get_text(key))
    assert "New introduction" in refreshed["sections"][0]["markdown"]
    # The copy the reader annotated is not the refresh's to replace.
    assert refreshed["savedDom"] == saved["savedDom"] and "New introduction" not in refreshed["savedDom"]
