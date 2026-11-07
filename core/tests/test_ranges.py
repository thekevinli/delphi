import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from delphi_core.config import Settings, get_settings
from delphi_core.main import app
from delphi_core.storage import LocalObjectStore, UnsatisfiableRange, paper_key, parse_range

from tests.helpers import put_bytes, seed_paper

PDF = b"%PDF-1.4\n" + b"x" * 200 + b"\n%%EOF\n"


def test_absent_or_unusable_range_asks_for_the_whole_object():
    assert parse_range(None, 100) is None
    assert parse_range("", 100) is None
    # A unit we do not speak, and a multi-range request: both legal to answer
    # with the entire object.
    assert parse_range("items=0-10", 100) is None
    assert parse_range("bytes=0-10,20-30", 100) is None
    assert parse_range("bytes=abc", 100) is None


def test_explicit_and_open_ended_ranges():
    first = parse_range("bytes=0-99", 500)
    assert (first.start, first.end, first.length) == (0, 99, 100)

    to_end = parse_range("bytes=100-", 500)
    assert (to_end.start, to_end.end) == (100, 499)

    # An end past the object is clamped rather than rejected.
    clamped = parse_range("bytes=400-9999", 500)
    assert (clamped.start, clamped.end) == (400, 499)


def test_suffix_range_counts_back_from_the_end():
    suffix = parse_range("bytes=-120", 500)
    assert (suffix.start, suffix.end) == (380, 499)

    # A suffix larger than the object is the whole object, not an error.
    whole = parse_range("bytes=-9999", 500)
    assert (whole.start, whole.end) == (0, 499)


def test_only_a_range_outside_the_object_is_unsatisfiable():
    with pytest.raises(UnsatisfiableRange):
        parse_range("bytes=500-600", 500)
    with pytest.raises(UnsatisfiableRange):
        parse_range("bytes=-0", 500)


def test_content_range_header_reports_the_full_size():
    assert parse_range("bytes=10-19", 500).content_range(500) == "bytes 10-19/500"


def test_pdf_route_serves_partial_content_for_a_range_request(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project_id = client.post(
                "/api/projects", json={"name": "Ranges"}
            ).json()["id"]
            seed_paper(
                settings,
                "reader",
                project_id,
                {"id": "paper-a", "title": "A", "filename": "a.pdf"},
                pdf=PDF,
            )
            url = f"/api/projects/{project_id}/papers/paper-a/file"

            whole = client.get(url)
            assert whole.status_code == 200
            assert whole.content == PDF
            assert whole.headers["accept-ranges"] == "bytes"
            assert whole.headers["content-length"] == str(len(PDF))

            # pdf.js renders the first page from a range rather than pulling the
            # whole file, so this is the path the viewer actually uses.
            partial = client.get(url, headers={"Range": "bytes=0-15"})
            assert partial.status_code == 206
            assert partial.content == PDF[:16]
            assert partial.headers["content-range"] == f"bytes 0-15/{len(PDF)}"
            assert partial.headers["content-length"] == "16"

            tail = client.get(url, headers={"Range": "bytes=-10"})
            assert tail.status_code == 206
            assert tail.content == PDF[-10:]

            beyond = client.get(url, headers={"Range": f"bytes={len(PDF)}-"})
            assert beyond.status_code == 416
            assert beyond.headers["content-range"] == f"bytes */{len(PDF)}"
    finally:
        app.dependency_overrides.clear()


def test_open_range_checks_existence_before_returning_not_on_first_chunk(tmp_path):
    """
    A caller wraps open_range's return value in a StreamingResponse; by the
    time that response starts pulling chunks, headers are already on the
    wire, so a 404 raised at that point can only crash the ASGI app, not
    become a clean response (this is exactly what happened when open_range
    was a generator: the exists() check lived in the generator body, so it
    only ran on the first `next()`). The fix is that calling open_range
    itself must raise immediately for a missing key, before any iteration.
    """
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    objects = LocalObjectStore(settings.data_dir)
    key = paper_key("reader", "project-a", "paper-a", "pdf")

    with pytest.raises(HTTPException) as excinfo:
        objects.open_range(key)
    assert excinfo.value.status_code == 404

    # A file removed after that check (a concurrent delete) can no longer
    # become a clean error either way, so the stream just ends early instead
    # of raising mid-iteration.
    put_bytes(objects, key, PDF)
    iterator = objects.open_range(key)
    objects.delete(key)
    assert list(iterator) == []


def test_another_users_project_reads_as_absent(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "owner", "password": "password-123"},
            )
            project_id = client.post(
                "/api/projects", json={"name": "Private"}
            ).json()["id"]
            client.post("/api/auth/logout")

            client.post(
                "/api/auth/register",
                json={"username": "stranger", "password": "password-123"},
            )
            # 404 rather than 403: the API must not confirm that an id exists to
            # somebody who cannot see it.
            assert client.get(f"/api/projects/{project_id}").status_code == 404
            assert client.get("/api/projects").json() == []
    finally:
        app.dependency_overrides.clear()
