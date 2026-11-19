"""
A page that is only a frame around a document is filed as that document.

The cases here are the two sides of one line. On one side, a hosted demo: a
host's chrome around a frame, with everything worth reading at the frame's
address. On the other, every page that merely has something embedded in it —
and those must be filed exactly as they were before any of this existed.
"""

import pytest
from fastapi import HTTPException

from delphi_core.config import Settings
from delphi_core.deps import get_settings
from delphi_core.main import app
from delphi_core.web_extract import PROSE_MIN_CHARS, framed_document
from delphi_core.web_fetch import FetchedResource

HOST = "https://host.example/spaces/lab/guide"
FRAME = "https://lab-guide.apps.example/"
PLAYER = "https://video.example/embed/abc123"

PROSE = (
    "An agent harness runs the loop around a model: it chooses the tools, "
    "writes the context, reads what comes back and decides when to stop. "
) * 4
assert len(PROSE) >= PROSE_MIN_CHARS

GUIDE = (
    "<html><head><title>The guide</title></head><body><main>"
    f"<h1>The guide</h1><p>{PROSE}</p><h2>Inside a harness</h2><p>{PROSE}</p>"
    "</main></body></html>"
)


def hosting(frame: str, chrome: str = "") -> str:
    """A host's page: an owner, a name, a like count, and the frame."""
    return (
        "<html><head><title>The guide - a Space by lab</title></head><body><main>"
        '<a href="https://host.example/lab">lab</a> / '
        f'<a href="{HOST}">guide</a> <button>Like 143</button>{chrome}'
        f'<iframe src="{frame}" title="space app"></iframe>'
        "</main></body></html>"
    )


def post_with(embed: str) -> str:
    return (
        "<html><head><title>Notes on harnesses</title></head><body><article>"
        f"<h1>Notes on harnesses</h1><p>{PROSE}</p>{embed}<p>{PROSE}</p>"
        "</article></body></html>"
    )


def page(url: str, html: str) -> FetchedResource:
    return FetchedResource(
        url=url,
        body=html.encode("utf-8"),
        content_type="text/html",
        encoding="utf-8",
        fetched_at="2026-10-05T00:00:00+00:00",
    )


def test_a_page_with_nothing_of_its_own_names_the_frame_it_shows():
    assert framed_document(hosting(FRAME), HOST) == FRAME
    # Relative, as a host on the same site would write it.
    assert framed_document(hosting("/embed/guide"), HOST) == "https://host.example/embed/guide"


def test_an_article_keeps_what_is_embedded_in_it_as_a_figure():
    video = f'<iframe src="{PLAYER}" title="The talk"></iframe>'

    assert framed_document(post_with(video), "https://blog.example/notes") is None


def test_two_frames_are_never_guessed_between():
    both = hosting(FRAME, chrome=f'<iframe src="{PLAYER}"></iframe>')

    assert framed_document(both, HOST) is None


@pytest.mark.parametrize(
    "frame",
    [
        # What a tag manager leaves for a reader with scripts off.
        '<noscript><iframe src="https://tags.example/ns.html?id=1"></iframe></noscript>',
        '<iframe src="data:text/html,hello"></iframe>',
        '<iframe src="javascript:void(0)"></iframe>',
        "<iframe></iframe>",
    ],
)
def test_a_frame_no_reader_could_be_sent_to_is_not_a_document(frame):
    shell = f"<html><body><div id='root'></div>{frame}</body></html>"

    assert framed_document(shell, "https://app.example/") is None


def serve(monkeypatch, pages: dict[str, str]) -> list[str]:
    """Answer fetches from `pages`, and record every address that was asked for."""
    import delphi_core.routers.projects as projects_router
    import delphi_core.web_fetch as web_fetch

    asked: list[str] = []

    async def fake_fetch(url, settings, **_kwargs):
        asked.append(url)
        if url not in pages:
            raise HTTPException(422, "Could not reach that page")
        return page(url, pages[url])

    async def no_browser(url, **_kwargs):
        return None

    # Both names: the router fetches the page, `framed_page` fetches its frame.
    monkeypatch.setattr(projects_router, "fetch_resource", fake_fetch)
    monkeypatch.setattr(web_fetch, "fetch_resource", fake_fetch)
    monkeypatch.setattr(web_fetch, "render_page", no_browser)
    return asked


@pytest.fixture
def library(tmp_path):
    from fastapi.testclient import TestClient

    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project_id = client.post("/api/projects", json={"name": "Harnesses"}).json()["id"]
            yield client, f"/api/projects/{project_id}"
    finally:
        app.dependency_overrides.clear()


def test_a_page_that_only_frames_a_document_is_filed_as_that_document(library, monkeypatch):
    """
    As a redirect is filed under where it leads. The reader then opens the
    frame's own address, which is the only place its text can be selected.
    """
    client, project = library
    asked = serve(monkeypatch, {HOST: hosting(FRAME), FRAME: GUIDE})

    added = client.post(f"{project}/pages", json={"url": HOST})

    assert added.status_code == 201, added.text
    paper = added.json()
    assert paper["url"] == FRAME
    assert paper["title"] == "The guide"
    text = client.get(f"{project}/papers/{paper['id']}/text").text
    assert "Inside a harness" in text and "Like 143" not in text

    # A refresh re-reads the address the document has, which is now the frame's.
    del asked[:]
    assert client.post(f"{project}/papers/{paper['id']}/refresh").status_code == 200
    assert asked == [FRAME]


def test_an_article_with_an_embed_is_filed_as_itself_and_its_frame_is_never_fetched(
    library, monkeypatch
):
    client, project = library
    address = "https://blog.example/notes"
    video = f'<iframe src="{PLAYER}" title="The talk"></iframe>'
    asked = serve(monkeypatch, {address: post_with(video), PLAYER: GUIDE})

    paper = client.post(f"{project}/pages", json={"url": address}).json()

    assert paper["url"] == address
    assert asked == [address]
    # Still the figure it always was: a link the model can cite.
    assert f"[The talk]({PLAYER})" in client.get(f"{project}/papers/{paper['id']}/text").text


@pytest.mark.parametrize(
    "frame",
    [
        pytest.param("<html><body><video></video><p>Watch later</p></body></html>", id="a player"),
        pytest.param(
            f"<html><body><main><p>Sign in to continue reading.</p><p>{PROSE}</p></main></body></html>",
            id="a wall",
        ),
        pytest.param(None, id="unreachable"),
    ],
)
def test_a_frame_that_is_not_a_document_leaves_the_page_as_it_was(library, monkeypatch, frame):
    """The frame is a candidate until it is read; a page is never traded for less."""
    client, project = library
    # Long addresses, short words: enough markdown to be filed, as a real host's is.
    links = "".join(
        f'<a href="https://host.example/{"collections/" * 6}{n}">more</a> ' for n in range(4)
    )
    pages = {HOST: hosting(FRAME, chrome=links)}
    if frame is not None:
        pages[FRAME] = frame
    asked = serve(monkeypatch, pages)

    added = client.post(f"{project}/pages", json={"url": HOST})

    assert added.status_code == 201, added.text
    assert added.json()["url"] == HOST
    assert asked == [HOST, FRAME]


def test_a_frame_is_followed_once(library, monkeypatch):
    """A frame that itself only frames something is as far as the import goes."""
    client, project = library
    deeper = "https://deeper.example/"
    serve(monkeypatch, {HOST: hosting(FRAME), FRAME: hosting(deeper), deeper: GUIDE})

    added = client.post(f"{project}/pages", json={"url": HOST})

    # Neither the host nor its frame holds an article, and the import says so.
    assert added.status_code == 422
