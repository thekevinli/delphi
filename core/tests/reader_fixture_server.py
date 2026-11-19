"""
The real backend, serving one web document, for the browser suite's round trip.

    backend/.venv/bin/python -m tests.reader_fixture_server <page.html>

`frontend/tests/browser/saved-page.spec.ts` starts this so a page copy travels
the whole path the product takes — the frame's serialiser, `PUT saved-page`,
`freeze`, the stored `.web`, and the cached frame `paper_page` serves from it —
where every other browser test answers the API with a mock. Nothing here is
product code, and only the site is stood in for: the document's address answers
with the fixture file, as a site would, and the thumbnail is not photographed.

Prints one JSON line — the port, the ids and the session cookie — once the
server is accepting requests, then serves until its stdin closes.
"""
import json
import logging
import sys
import tempfile
import threading
from pathlib import Path

import httpx
import uvicorn

from delphi_core.app import Stores, create_app
from delphi_core.config import Settings
from delphi_core.routers import projects
from delphi_core.storage import LocalObjectStore, LocalStorage
from delphi_core.web_extract import extract, flat_markdown
from delphi_core.web_fetch import FetchedResource
from delphi_core.web_revision import freeze, page_fields, publish_snapshot

URL = "https://article.example/read"


def main() -> None:
    logging.getLogger("httpx").setLevel(logging.WARNING)
    page = Path(sys.argv[1]).read_text(encoding="utf-8")
    data = Path(tempfile.mkdtemp(prefix="delphi-reader-fixture-"))
    # Not the checkout's `.env`: that can name a database, a bucket or a
    # sandbox origin, and this must touch nothing but its own temp directory.
    # So not the reference app either, whose stores the environment chooses.
    settings = Settings(_env_file=None, data_dir=data, session_secret="reader-fixture-secret")
    app = create_app(settings, stores=Stores.local())

    async def site(url, _settings, **_kwargs):
        return FetchedResource(url=URL, body=page.encode("utf-8"), content_type="text/html",
                               encoding="utf-8", fetched_at="2026-09-22T12:00:00Z")

    async def no_thumbnail(*_args, **_kwargs):
        return False

    projects.fetch_resource = site
    projects.make_web_thumbnail_safely = no_thumbnail

    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        threading.Event().wait(0.05)
    port = server.servers[0].sockets[0].getsockname()[1]
    base = f"http://127.0.0.1:{port}"

    with httpx.Client(base_url=base) as client:
        client.post("/api/auth/register", json={"username": "reader", "password": "password-123"}).raise_for_status()
        project = client.post("/api/projects", json={"name": "Pages"}).json()["id"]
        cookie = client.cookies["delphi_session"]
    # The document as an import leaves it: the text Delphi's own fetch reads,
    # and the page copy as fetched — scripts, and so the formula, stripped.
    storage, objects = LocalStorage(settings), LocalObjectStore(data)
    document = {**extract(page, URL, settings.web_max_extract_chars), "url": URL, "fetchedAt": "2026-09-22T12:00:00Z"}
    storage.add_paper("reader", project, {"id": "page", "kind": "web", "title": "Test article", "url": URL,
                                          "filename": "article.example/read", "pages": len(document["sections"]),
                                          "tokens": 1, "bytes": len(flat_markdown(document))})
    publish_snapshot(objects, "reader", project, "page", document, {},
                     page=page_fields(freeze(page, URL), URL, "2026-09-22T12:00:00Z"))

    print(json.dumps({"base": base, "project": project, "paper": "page", "cookie": cookie}), flush=True)
    sys.stdin.read()
    server.should_exit = True
    thread.join(5)


if __name__ == "__main__":
    main()
