import json
import os
from io import BytesIO

from fastapi.testclient import TestClient

from tests.chat_keys import chat_key
from delphi_core.config import Settings, get_settings
from delphi_core.main import app
from delphi_core.research_digest import RESEARCH_DIGEST_VERSION, digest_asset_key
from delphi_core.storage import LocalObjectStore, LocalStorage, paper_key

from tests.helpers import MINIMAL_PDF, seed_paper


def test_the_annotated_export_carries_each_highlight_and_its_note(tmp_path):
    from pypdf import PdfReader, PdfWriter
    from delphi_core.routers.projects import build_annotated_pdf

    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    path = tmp_path / "paper.pdf"
    writer.write(path)
    rect = [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.02}]
    highlights = [
        {"id": "noted", "type": "pdf", "page": 1, "rects": rect, "text": "A noted passage", "color": "amber"},
        {"id": "plain", "type": "pdf", "page": 1, "rects": rect, "text": "A plain passage", "color": "dawn"},
    ]
    notes = [{"id": "n1", "highlightId": "noted", "body": "Why this **matters**"}]

    exported = PdfReader(BytesIO(build_annotated_pdf(path, highlights, notes)))
    marks = [mark.get_object() for mark in exported.pages[0]["/Annots"]]
    assert [mark["/Subtype"] for mark in marks] == ["/Highlight", "/Highlight"]
    assert [mark["/Contents"] for mark in marks] == ["Why this **matters**", "A plain passage"]


def test_both_pdf_readers_clean_metadata_titles(tmp_path):
    from pypdf import PdfWriter
    from delphi_core.routers.projects import extract_pdf_snapshot, read_pdf_pages
    from delphi_core.web_fetch import FetchedResource

    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_metadata({"/Title": "Res\x00ult\x1b[0m café"})
    path = tmp_path / "metadata.pdf"
    writer.write(path)

    _, _, title = read_pdf_pages(path, 100)
    assert title == "Result café"
    snapshot = extract_pdf_snapshot(FetchedResource(
        url="https://example.test/metadata.pdf", body=path.read_bytes(),
        content_type="application/pdf", encoding="utf-8", fetched_at="now",
    ), 100, 600000)
    assert snapshot["title"] == "Result café"


def test_download_is_named_for_the_project_and_title_not_the_upload(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project_id = client.post(
                "/api/projects",
                json={"name": "Diffusion LMs"},
            ).json()["id"]

            seed_paper(
                settings,
                "reader",
                project_id,
                {
                    "id": "paper-a",
                    "title": "MDLM (2406.07524v2)",
                    "filename": "2406.07524v2.pdf",
                },
            )

            url = f"/api/projects/{project_id}/papers/paper-a/file"
            download = client.get(url, params={"download": "true"})
            assert download.status_code == 200
            assert download.headers["content-disposition"].startswith(
                'attachment; filename="delphi_export_Diffusion_LMs_MDLM_2406.07524v2.pdf"'
            )

            # The viewer reads the same route and still needs it inline.
            inline = client.get(url)
            assert inline.status_code == 200
            assert inline.headers["content-disposition"].startswith("inline")
    finally:
        app.dependency_overrides.clear()


def test_paper_reorder_requires_and_persists_an_exact_order(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            created = client.post(
                "/api/projects",
                json={"name": "Reading list"},
            ).json()
            project_id = created["id"]

            for paper_id, title in (("paper-a", "A"), ("paper-b", "B"), ("paper-c", "C")):
                seed_paper(
                    settings,
                    "reader",
                    project_id,
                    {"id": paper_id, "title": title, "filename": f"{paper_id}.pdf"},
                )

            reordered = client.put(
                f"/api/projects/{project_id}/papers/order",
                json={"paper_ids": ["paper-c", "paper-a", "paper-b"]},
            )
            assert reordered.status_code == 200
            assert [paper["id"] for paper in reordered.json()["papers"]] == [
                "paper-c",
                "paper-a",
                "paper-b",
            ]
            assert {
                paper["id"]: paper["title"]
                for paper in reordered.json()["papers"]
            } == {
                "paper-a": "A",
                "paper-b": "B",
                "paper-c": "C",
            }
            assert [
                paper["id"]
                for paper in client.get(f"/api/projects/{project_id}").json()["papers"]
            ] == ["paper-c", "paper-a", "paper-b"]

            duplicate = client.put(
                f"/api/projects/{project_id}/papers/order",
                json={"paper_ids": ["paper-a", "paper-a", "paper-c"]},
            )
            assert duplicate.status_code == 422

            incomplete = client.put(
                f"/api/projects/{project_id}/papers/order",
                json={"paper_ids": ["paper-a", "paper-b"]},
            )
            assert incomplete.status_code == 422
    finally:
        app.dependency_overrides.clear()


def test_a_large_upload_is_stored_compressed_and_reports_the_stored_size(tmp_path):
    """The route must persist the compressed bytes and record their size, not
    the size of what arrived -- the library shows `bytes` to the reader."""
    import io
    import os

    import pikepdf
    from PIL import Image

    from delphi_core.storage import LocalObjectStore, paper_key

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        # Compress everything, so the test needs no multi-megabyte fixture.
        compress_over_mb=0,
        compress_max_image_side=400,
    )
    app.dependency_overrides[get_settings] = lambda: settings

    image = Image.frombytes("RGB", (1200, 900), os.urandom(1200 * 900 * 3))
    source = io.BytesIO()
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    stream = pikepdf.Stream(pdf, image.tobytes())
    stream.Type = pikepdf.Name("/XObject")
    stream.Subtype = pikepdf.Name("/Image")
    stream.Width, stream.Height = image.size
    stream.ColorSpace = pikepdf.Name("/DeviceRGB")
    stream.BitsPerComponent = 8
    page.Resources = pdf.make_indirect(
        pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=stream))
    )
    page.Contents = pdf.make_indirect(
        pikepdf.Stream(pdf, b"q 612 0 0 792 0 0 cm /Im0 Do Q")
    )
    pdf.save(source)
    uploaded = source.getvalue()

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project_id = client.post(
                "/api/projects", json={"name": "Diffusion LMs"}
            ).json()["id"]

            response = client.post(
                f"/api/projects/{project_id}/papers",
                files={"file": ("big.pdf", uploaded, "application/pdf")},
            )
            assert response.status_code == 201, response.text
            paper = response.json()

            objects = LocalObjectStore(settings.data_dir)
            key = paper_key("reader", project_id, paper["id"], "pdf")
            stored = objects.size(key)

            assert stored < len(uploaded), "the stored PDF was not compressed"
            assert paper["bytes"] == stored, "recorded size is not the stored size"
            # And the file still serves as a readable PDF.
            served = client.get(
                f"/api/projects/{project_id}/papers/{paper['id']}/file"
            )
            assert served.status_code == 200
            assert served.content[:5] == b"%PDF-"
    finally:
        app.dependency_overrides.clear()


def picture_pdf(pages: int = 1) -> bytes:
    """A PDF whose bulk is one raw, incompressible image -- i.e. one that
    compression can actually do something about."""
    import io
    import os

    import pikepdf
    from PIL import Image

    image = Image.frombytes("RGB", (1200, 900), os.urandom(1200 * 900 * 3))
    pdf = pikepdf.new()
    for _ in range(pages):
        page = pdf.add_blank_page(page_size=(612, 792))
        stream = pikepdf.Stream(pdf, image.tobytes())
        stream.Type = pikepdf.Name("/XObject")
        stream.Subtype = pikepdf.Name("/Image")
        stream.Width, stream.Height = image.size
        stream.ColorSpace = pikepdf.Name("/DeviceRGB")
        stream.BitsPerComponent = 8
        page.Resources = pdf.make_indirect(
            pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=stream))
        )
        page.Contents = pdf.make_indirect(
            pikepdf.Stream(pdf, b"q 612 0 0 792 0 0 cm /Im0 Do Q")
        )
    buffer = io.BytesIO()
    pdf.save(buffer)
    return buffer.getvalue()


def stored_paper_files(settings: Settings, project_id: str) -> list:
    papers = (
        settings.data_dir / "users" / "reader" / "projects" / project_id / "papers"
    )
    return sorted(papers.iterdir()) if papers.exists() else []


def reader_with_a_project(client) -> str:
    client.post(
        "/api/auth/register",
        json={"username": "reader", "password": "password-123"},
    )
    return client.post("/api/projects", json={"name": "Diffusion LMs"}).json()["id"]


def test_an_oversized_pdf_that_compresses_down_waits_for_the_reader(tmp_path):
    """Over the limit is a question, not a refusal: the bytes are stored and the
    record is not, until the reader has seen what compression cost."""
    from delphi_core.storage import LocalObjectStore, paper_key

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        max_upload_mb=1,
        compress_over_mb=0,
        compress_max_image_side=400,
    )
    app.dependency_overrides[get_settings] = lambda: settings
    uploaded = picture_pdf()
    assert len(uploaded) > 1024 * 1024, "fixture is not over the test limit"

    try:
        with TestClient(app) as client:
            project_id = reader_with_a_project(client)
            response = client.post(
                f"/api/projects/{project_id}/papers",
                files={"file": ("huge.pdf", uploaded, "application/pdf")},
            )
            assert response.status_code == 202, response.text
            staged = response.json()
            assert staged["status"] == "compressed"
            assert staged["uploadedBytes"] == len(uploaded)
            assert staged["bytes"] < 1024 * 1024
            assert staged["title"] == "huge"

            project = client.get(f"/api/projects/{project_id}").json()
            assert project["papers"] == [], "an unanswered upload joined the project"

            confirmed = client.post(
                f"/api/projects/{project_id}/papers/staged",
                json={"token": staged["token"]},
            )
            assert confirmed.status_code == 201, confirmed.text
            paper = confirmed.json()
            assert paper["bytes"] == staged["bytes"]

            objects = LocalObjectStore(settings.data_dir)
            key = paper_key("reader", project_id, paper["id"], "pdf")
            assert objects.size(key) == staged["bytes"]
            served = client.get(
                f"/api/projects/{project_id}/papers/{paper['id']}/file"
            )
            assert served.status_code == 200
            assert served.content[:5] == b"%PDF-"
    finally:
        app.dependency_overrides.clear()


def test_declining_a_compressed_upload_leaves_nothing_behind(tmp_path):
    """Bytes with no record are reachable from nowhere, so turning the paper
    down has to delete them rather than let them sit in the bucket."""
    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        max_upload_mb=1,
        compress_over_mb=0,
        compress_max_image_side=400,
    )
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            project_id = reader_with_a_project(client)
            staged = client.post(
                f"/api/projects/{project_id}/papers",
                files={"file": ("huge.pdf", picture_pdf(), "application/pdf")},
            ).json()
            assert stored_paper_files(settings, project_id), "nothing was staged"

            discarded = client.delete(
                f"/api/projects/{project_id}/papers/staged",
                params={"token": staged["token"]},
            )
            assert discarded.status_code == 204
            assert stored_paper_files(settings, project_id) == []
            assert client.get(f"/api/projects/{project_id}").json()["papers"] == []

            # And the token cannot then be used to add a paper with no bytes.
            replayed = client.post(
                f"/api/projects/{project_id}/papers/staged",
                json={"token": staged["token"]},
            )
            assert replayed.status_code == 410
    finally:
        app.dependency_overrides.clear()


def test_a_pdf_compression_cannot_rescue_is_refused_without_being_stored(tmp_path):
    """The failure case that matters: nothing reaches storage, so no cleanup is
    owed and no stale object is left for someone to reap later."""
    import io

    import pikepdf

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        max_upload_mb=1,
        compress_over_mb=0,
    )
    app.dependency_overrides[get_settings] = lambda: settings

    # Random bytes in a stream no image path touches: over the limit, and
    # nothing the compressor can do about it.
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.Root.Delphi = pdf.make_indirect(pikepdf.Stream(pdf, os.urandom(2 * 1024 * 1024)))
    buffer = io.BytesIO()
    pdf.save(buffer)

    try:
        with TestClient(app) as client:
            project_id = reader_with_a_project(client)
            response = client.post(
                f"/api/projects/{project_id}/papers",
                files={"file": ("dense.pdf", buffer.getvalue(), "application/pdf")},
            )
            assert response.status_code == 413, response.text
            assert "still over" in response.json()["detail"]
            assert stored_paper_files(settings, project_id) == []
            assert client.get(f"/api/projects/{project_id}").json()["papers"] == []
    finally:
        app.dependency_overrides.clear()


def test_a_pdf_over_the_source_ceiling_is_refused_while_it_uploads(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        max_upload_mb=1,
        max_upload_source_mb=2,
        compress_over_mb=0,
        compress_max_image_side=400,
    )
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            project_id = reader_with_a_project(client)
            response = client.post(
                f"/api/projects/{project_id}/papers",
                files={"file": ("huge.pdf", picture_pdf(pages=2), "application/pdf")},
            )
            assert response.status_code == 413, response.text
            assert "2 MB" in response.json()["detail"]
            assert stored_paper_files(settings, project_id) == []
    finally:
        app.dependency_overrides.clear()


def test_a_staged_token_is_scoped_to_its_owner_and_project(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        max_upload_mb=1,
        compress_over_mb=0,
        compress_max_image_side=400,
    )
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            project_id = reader_with_a_project(client)
            other_id = client.post(
                "/api/projects", json={"name": "Elsewhere"}
            ).json()["id"]
            staged = client.post(
                f"/api/projects/{project_id}/papers",
                files={"file": ("huge.pdf", picture_pdf(), "application/pdf")},
            ).json()

            elsewhere = client.post(
                f"/api/projects/{other_id}/papers/staged",
                json={"token": staged["token"]},
            )
            assert elsewhere.status_code == 410

            client.post("/api/auth/logout")
            client.post(
                "/api/auth/register",
                json={"username": "stranger", "password": "password-123"},
            )
            theirs = client.post(
                "/api/projects", json={"name": "Theirs"}
            ).json()["id"]
            stolen = client.post(
                f"/api/projects/{theirs}/papers/staged",
                json={"token": staged["token"]},
            )
            assert stolen.status_code == 410
    finally:
        app.dependency_overrides.clear()


def test_moving_a_paper_carries_its_bytes_and_leaves_none_behind(tmp_path):
    """
    The end-to-end half of the move: an object key names the project a paper
    sits in, so a re-parented record whose bytes stayed put is a paper that
    404s in its new home.
    """
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            source = client.post("/api/projects", json={"name": "Inbox"}).json()["id"]
            destination = client.post(
                "/api/projects", json={"name": "Diffusion"}
            ).json()["id"]
            seed_paper(
                settings,
                "reader",
                source,
                {"id": "paper-a", "title": "MDLM", "filename": "mdlm.pdf"},
                text="page one",
            )
            client.post(
                f"/api/projects/{source}/papers/paper-a/highlights",
                json={
                    "type": "pdf",
                    "page": 1,
                    "text": "a claim worth keeping",
                    "rects": [{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.05}],
                },
            )

            moved = client.post(
                f"/api/projects/{source}/papers/paper-a/move",
                json={"project_id": destination},
            )
            assert moved.status_code == 200
            assert [paper["id"] for paper in moved.json()["papers"]] == ["paper-a"]

            objects = LocalObjectStore(settings.data_dir)
            assert objects.exists(paper_key("reader", destination, "paper-a", "pdf"))
            assert not objects.exists(paper_key("reader", source, "paper-a", "pdf"))
            assert (
                objects.get_text(paper_key("reader", destination, "paper-a", "txt"))
                == "page one"
            )

            assert client.get(
                f"/api/projects/{destination}/papers/paper-a/file"
            ).status_code == 200
            assert client.get(
                f"/api/projects/{source}/papers/paper-a/file"
            ).status_code == 404
            assert len(
                client.get(
                    f"/api/projects/{destination}/papers/paper-a/highlights"
                ).json()
            ) == 1
    finally:
        app.dependency_overrides.clear()


def seed_note(client, project_id, paper_id="paper-a", body="worth checking"):
    """A stroke and the note hanging off it, the way the reader creates them."""
    stroke = client.post(
        f"/api/projects/{project_id}/papers/{paper_id}/highlights",
        json={
            "type": "pdf",
            "page": 1,
            "text": "a claim worth keeping",
            "rects": [{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.05}],
        },
    ).json()
    created = client.post(
        f"/api/projects/{project_id}/papers/{paper_id}/notes",
        json={
            "highlightId": stroke["id"],
            "page": 1,
            "anchorY": 0.1,
            "quotedText": "a claim worth keeping",
            "body": body,
        },
    )
    return stroke, created


def test_a_note_is_written_edited_and_removed_without_touching_its_stroke(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project = client.post("/api/projects", json={"name": "Inbox"}).json()["id"]
            seed_paper(
                settings,
                "reader",
                project,
                {"id": "paper-a", "title": "MDLM", "filename": "mdlm.pdf"},
            )

            stroke, created = seed_note(client, project)
            assert created.status_code == 201
            note = created.json()
            assert note["highlightId"] == stroke["id"]
            assert note["body"] == "worth checking"
            assert note["filedAt"] is None

            edited = client.patch(
                f"/api/projects/{project}/papers/paper-a/notes/{note['id']}",
                json={"body": "checked, it holds"},
            )
            assert edited.status_code == 200
            assert edited.json()["body"] == "checked, it holds"

            removed = client.delete(
                f"/api/projects/{project}/papers/paper-a/notes/{note['id']}"
            )
            assert removed.status_code == 204
            assert client.get(
                f"/api/projects/{project}/papers/paper-a/notes"
            ).json() == []
            # Emptying the editor means "no note here", not "un-highlight it".
            assert len(
                client.get(
                    f"/api/projects/{project}/papers/paper-a/highlights"
                ).json()
            ) == 1


            # And the reverse: the stroke owns where the note points, so it
            # cannot survive the stroke being removed.
            _, again = seed_note(client, project)
            assert again.status_code == 201
            client.delete(
                f"/api/projects/{project}/papers/paper-a/highlights/"
                f"{again.json()['highlightId']}"
            )
            assert client.get(
                f"/api/projects/{project}/papers/paper-a/notes"
            ).json() == []
    finally:
        app.dependency_overrides.clear()


def test_a_note_cannot_be_written_against_a_highlight_that_is_gone(tmp_path):
    """
    A note without a stroke is a note pointing nowhere. A card left open after
    its highlight was removed in another tab would otherwise recreate the orphan
    the cascade had just cleaned up.
    """
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project = client.post("/api/projects", json={"name": "Inbox"}).json()["id"]
            seed_paper(
                settings,
                "reader",
                project,
                {"id": "paper-a", "title": "MDLM", "filename": "mdlm.pdf"},
            )
            stroke, _ = seed_note(client, project)
            client.delete(
                f"/api/projects/{project}/papers/paper-a/highlights/{stroke['id']}"
            )
            assert client.get(
                f"/api/projects/{project}/papers/paper-a/notes"
            ).json() == []

            orphan = client.post(
                f"/api/projects/{project}/papers/paper-a/notes",
                json={
                    "highlightId": stroke["id"],
                    "page": 1,
                    "anchorY": 0.1,
                    "quotedText": "a claim worth keeping",
                    "body": "a thought with nowhere to point",
                },
            )
            assert orphan.status_code == 404
            assert client.get(
                f"/api/projects/{project}/papers/paper-a/notes"
            ).json() == []
    finally:
        app.dependency_overrides.clear()


def test_a_web_note_requires_an_existing_highlight(tmp_path):
    """A webpage note cannot point at a missing highlight."""
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project = client.post("/api/projects", json={"name": "Inbox"}).json()["id"]
            storage = LocalStorage(settings)
            storage.add_paper(
                "reader",
                project,
                {
                    "id": "page-a",
                    "title": "A blog post",
                    "filename": "example.com/post",
                    "kind": "web",
                    "url": "https://example.com/post",
                },
            )

            refused = client.post(
                f"/api/projects/{project}/papers/page-a/notes",
                json={
                    "highlightId": "whatever",
                    "page": 1,
                    "anchorY": 0.1,
                    "quotedText": "a sentence",
                    "body": "a thought",
                },
            )
            assert refused.status_code == 404
            assert "highlight" in refused.json()["detail"]
    finally:
        app.dependency_overrides.clear()


def test_notes_are_not_visible_to_another_account(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project = client.post("/api/projects", json={"name": "Inbox"}).json()["id"]
            seed_paper(
                settings,
                "reader",
                project,
                {"id": "paper-a", "title": "MDLM", "filename": "mdlm.pdf"},
            )
            _, created = seed_note(client, project)
            note_id = created.json()["id"]

            client.post("/api/auth/logout")
            client.post(
                "/api/auth/register",
                json={"username": "stranger", "password": "password-123"},
            )
            # 404 rather than 403 throughout: the API must not confirm that an
            # id exists to someone who cannot see it.
            assert client.get(
                f"/api/projects/{project}/papers/paper-a/notes"
            ).status_code == 404
            assert client.patch(
                f"/api/projects/{project}/papers/paper-a/notes/{note_id}",
                json={"body": "mine now"},
            ).status_code == 404
            assert client.delete(
                f"/api/projects/{project}/papers/paper-a/notes/{note_id}"
            ).status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_a_paper_cannot_be_moved_into_a_project_that_is_full(tmp_path):
    settings = Settings(
        data_dir=tmp_path, session_secret="test-session-secret", max_papers_per_project=1
    )
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            source = client.post("/api/projects", json={"name": "Inbox"}).json()["id"]
            destination = client.post("/api/projects", json={"name": "Full"}).json()["id"]
            seed_paper(
                settings,
                "reader",
                source,
                {"id": "paper-a", "title": "A", "filename": "a.pdf"},
            )
            seed_paper(
                settings,
                "reader",
                destination,
                {"id": "paper-b", "title": "B", "filename": "b.pdf"},
            )

            refused = client.post(
                f"/api/projects/{source}/papers/paper-a/move",
                json={"project_id": destination},
            )
            assert refused.status_code == 409
            # Refused before anything was copied, so the destination has not
            # quietly gained a set of orphaned objects.
            objects = LocalObjectStore(settings.data_dir)
            assert not objects.exists(paper_key("reader", destination, "paper-a", "pdf"))
            assert client.get(
                f"/api/projects/{source}/papers/paper-a/file"
            ).status_code == 200
    finally:
        app.dependency_overrides.clear()


def test_a_moved_paper_keeps_its_digest_and_chat_instead_of_rebuilding_them(tmp_path):
    """
    A digest costs a model call, so a move that quietly invalidated one would
    charge the reader for filing a paper. The claim path is the thing to assert:
    it answers "ready" — reuse, do not generate — only when the stored
    fingerprint, version and model all still match in the new project.
    """
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            source = client.post("/api/projects", json={"name": "Inbox"}).json()["id"]
            destination = client.post("/api/projects", json={"name": "Read"}).json()["id"]
            seed_paper(
                settings,
                "reader",
                source,
                {"id": "paper-a", "title": "MDLM", "filename": "mdlm.pdf"},
                text="page one",
            )

            storage = LocalStorage(settings)
            objects = LocalObjectStore(settings.data_dir)
            metadata = {
                "status": "ready",
                "version": RESEARCH_DIGEST_VERSION,
                "model": settings.digest_model,
                "sourceHash": "fingerprint",
                "updatedAt": "2026-01-01T00:00:00+00:00",
            }
            storage.set_paper_source_hash("reader", source, "paper-a", "fingerprint")
            assert (
                storage.claim_digest(
                    "reader",
                    source,
                    "paper-a",
                    claim_id="claim-1",
                    expires_at="2026-01-01T00:10:00+00:00",
                    metadata=metadata,
                    force=False,
                )
                == "claimed"
            )
            storage.complete_digest("reader", source, "paper-a", "claim-1", metadata)
            objects.put_text(
                paper_key("reader", source, "paper-a", "digest"),
                json.dumps(
                    {
                        "digest": {
                            "contentMarkdown": "The claim.",
                            "citations": [],
                            "assets": [
                                {
                                    "id": "asset-one",
                                    "mimeType": "image/webp",
                                }
                            ],
                        }
                    }
                ),
            )
            objects.put_text(
                digest_asset_key(
                    "reader", source, "paper-a", "asset-one", "image/webp"
                ),
                "asset-bytes",
            )

            key = chat_key(storage, "reader", source, "paper-paper-a")
            storage.append_message(
                "reader", source, key, {"role": "user", "content": "Why does it work?"},
            )

            moved = client.post(
                f"/api/projects/{source}/papers/paper-a/move",
                json={"project_id": destination},
            )
            assert moved.status_code == 200

            # Served whole from its new home — same body, still "ready".
            detail = client.get(
                f"/api/projects/{destination}/papers/paper-a/digest"
            ).json()
            assert detail["paper"]["digest"]["status"] == "ready"
            assert detail["digest"]["contentMarkdown"] == "The claim."
            moved_asset = digest_asset_key(
                "reader", destination, "paper-a", "asset-one", "image/webp"
            )
            assert objects.get_text(moved_asset) == "asset-bytes"
            assert not objects.exists(
                digest_asset_key(
                    "reader", source, "paper-a", "asset-one", "image/webp"
                )
            )

            # And the next request to build one is answered "already have it".
            assert (
                storage.claim_digest(
                    "reader",
                    destination,
                    "paper-a",
                    claim_id="claim-2",
                    expires_at="2026-01-01T00:20:00+00:00",
                    metadata=metadata,
                    force=False,
                )
                == "ready"
            )
            # The conversation is about the document, so it travels with it.
            history = storage.get_thread("reader", destination, key)
            assert [message["content"] for message in history["messages"]] == [
                "Why does it work?"
            ]
            assert (
                client.get(
                    f"/api/projects/{source}/chat", params={"paper_id": "paper-a"}
                ).status_code
                == 404
            )
    finally:
        app.dependency_overrides.clear()


def test_marking_a_paper_done_frees_a_slot(tmp_path):
    settings = Settings(
        data_dir=tmp_path, session_secret="test-session-secret", max_papers_per_project=1
    )
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project = client.post("/api/projects", json={"name": "Inbox"}).json()["id"]
            seed_paper(
                settings,
                "reader",
                project,
                {"id": "paper-a", "title": "A", "filename": "a.pdf"},
            )

            done = client.post(
                f"/api/projects/{project}/papers/paper-a/done",
                json={"done": True},
            )
            assert done.status_code == 200
            assert done.json()["doneAt"]

            # An 11th-equivalent upload now succeeds, because the project holds
            # zero active papers.
            seeded = seed_paper(
                settings,
                "reader",
                project,
                {"id": "paper-b", "title": "B", "filename": "b.pdf"},
            )
            assert seeded["id"] == "paper-b"

            # Un-archiving at capacity is refused with the quota message.
            refused = client.post(
                f"/api/projects/{project}/papers/paper-a/done",
                json={"done": False},
            )
            assert refused.status_code == 409
            assert "1 papers" in refused.json()["detail"]
    finally:
        app.dependency_overrides.clear()


def test_the_total_document_cap_refuses_a_new_paper(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        max_papers_per_project=50,
        max_papers_total_per_project=1,
    )
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project = client.post("/api/projects", json={"name": "Inbox"}).json()["id"]
            seed_paper(
                settings,
                "reader",
                project,
                {"id": "paper-a", "title": "A", "filename": "a.pdf"},
            )
            storage = LocalStorage(settings)
            storage.set_paper_done("reader", project, "paper-a", True)

            refused = client.post(
                f"/api/projects/{project}/papers",
                files={"file": ("b.pdf", MINIMAL_PDF, "application/pdf")},
            )
            assert refused.status_code == 409
            assert "maximum of 1 documents" in refused.json()["detail"]
    finally:
        app.dependency_overrides.clear()
