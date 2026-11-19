from fastapi.testclient import TestClient

from delphi_core.config import Settings, get_settings
from delphi_core.main import app
from delphi_core.storage import LocalStorage


def test_reader_routes_are_authenticated_owner_scoped_and_uniform(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="reader-route-secret")
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as reader, TestClient(app) as stranger:
            assert reader.get("/api/reader/reader/project").status_code == 401
            reader.post(
                "/api/auth/register",
                json={"username": "Reader", "password": "password-123"},
            )
            stranger.post(
                "/api/auth/register",
                json={"username": "stranger", "password": "password-123"},
            )

            reader_project = reader.post(
                "/api/projects", json={"name": "Shared Name"}
            ).json()
            stranger_project = stranger.post(
                "/api/projects", json={"name": "Shared Name"}
            ).json()
            storage = LocalStorage(settings)
            reader_paper = storage.add_paper(
                "Reader",
                reader_project["id"],
                {"id": "reader-paper", "title": "Same Paper", "filename": "r.pdf"},
            )
            stranger_paper = storage.add_paper(
                "stranger",
                stranger_project["id"],
                {
                    "id": "stranger-paper",
                    "title": "Same Paper",
                    "filename": "s.pdf",
                },
            )

            assert reader_project["slug"] == stranger_project["slug"]
            assert reader_paper["slug"] == stranger_paper["slug"]
            opened = reader.get(
                f"/api/reader/Reader/{reader_project['slug']}/{reader_paper['slug']}"
            )
            assert opened.status_code == 200
            assert opened.json()["project"]["owner"] == "Reader"
            assert opened.json()["paperId"] == "reader-paper"

            wrong_namespace = reader.get(
                f"/api/reader/stranger/{reader_project['slug']}/{reader_paper['slug']}"
            )
            absent = reader.get("/api/reader/Reader/does-not-exist")
            assert wrong_namespace.status_code == absent.status_code == 404
            assert wrong_namespace.json() == absent.json() == {
                "detail": "Document unavailable"
            }

            # The target namespace preserves the registered spelling exactly.
            assert (
                reader.get(f"/api/reader/reader/{reader_project['slug']}").status_code
                == 404
            )
            stranger_opened = stranger.get(
                f"/api/reader/stranger/{stranger_project['slug']}/{stranger_paper['slug']}"
            )
            assert stranger_opened.json()["paperId"] == "stranger-paper"

        with TestClient(app) as forged:
            forged.cookies.set("delphi_session", "modified.invalid.cookie")
            assert (
                forged.get(f"/api/reader/Reader/{reader_project['slug']}").status_code
                == 401
            )
    finally:
        app.dependency_overrides.clear()
