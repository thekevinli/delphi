"""
Every route core's own commands name is one the backend serves.

The backfill commands drive the app over HTTP. Most of those calls run in no
test, and no static check reads a path inside a string: a route renamed on the
server and missed in a caller fails only when that caller next runs, as a 404.
So each literal is read out of its source and matched against the app's own
OpenAPI, where a `{param}` segment matches anything. A product checks the routes
its own code names against its own app (the desktop's is
`desktop/backend/tests/test_routes.py`).

The chat benchmark is also run against the app itself, which checks what a
literal cannot: that each route it calls answers in the shape it reads.
"""

import ast
import json
import time
from pathlib import Path

from fastapi.testclient import TestClient

import delphi_core
from delphi_core.backfill import chat_benchmark
from delphi_core.config import get_settings
from delphi_core.deps import get_object_store, get_storage
from delphi_core.main import app
from tests.rig_library import Rig, provider

#: Where the package lives, installed or checked out: the sources are read from it.
ROOT = Path(delphi_core.__file__).resolve().parents[1]
#: Where Python names a route: the commands that drive the app over HTTP.
PYTHON_SOURCES = ("delphi_core/backfill/*.py",)


def python_routes(path: Path):
    """`(line, route)` for each string that starts with `/api/`; an f-string's fields become `{}`."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    parts = {id(value) for node in ast.walk(tree) if isinstance(node, ast.JoinedStr) for value in node.values}
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            text = "".join(value.value if isinstance(value, ast.Constant) else "{}" for value in node.values)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in parts:
            text = node.value
        else:
            continue
        if text.startswith("/api/"):
            yield node.lineno, text


def served(route: str, paths: list[str]) -> bool:
    """
    Whether a route names a path the app serves. A `{}` segment is a value the
    caller fills in; a trailing slash means the caller appends the rest.
    """
    route = route.split("?", 1)[0]
    prefix = route.endswith("/")
    wanted = route.strip("/").split("/")
    for path in paths:
        held = path.strip("/").split("/")
        if len(held) < len(wanted) if prefix else len(held) != len(wanted):
            continue
        if all(want == "{}" or have.startswith("{") or want == have for want, have in zip(wanted, held)):
            return True
    return False


def named_routes(patterns, read) -> list[tuple[str, str]]:
    named = []
    for pattern in patterns:
        files = sorted(ROOT.glob(pattern))
        assert files, f"{pattern} matches no file: the check would read nothing there"
        named += [(f"{path.relative_to(ROOT)}:{line}", route) for path in files for line, route in read(path)]
    return named


def test_every_route_a_script_names_is_served():
    paths = list(app.openapi()["paths"])
    assert served("/api/projects/{}/papers", paths) and served("/api/projects/{}/papers/", paths)
    assert not served("/api/no-such-route", paths)

    named = named_routes(PYTHON_SOURCES, python_routes)
    # The drain is the route the chat benchmark runs between its arms, in a
    # call no test makes; the reader must find both.
    assert sum(route == "/api/memory/maintenance/drain" for _, route in named) >= 2
    unserved = [f"{where} {route}" for where, route in named if not served(route, paths)]
    assert not unserved, "Routes named in source that the app does not serve:\n" + "\n".join(unserved)


def test_the_chat_benchmark_stages_and_drains_against_the_app_itself(tmp_path, monkeypatch):
    """
    Staging uploads a document, drains the queue until the backfill listing
    says it is filed and marks it finished; a maintenance thread beside a run
    then holds the next job it drains. The server is the app, over the journey
    rig's scripted provider.
    """
    rig = Rig(tmp_path / "server", monkeypatch)
    for dependency, value in ((get_settings, rig.settings), (get_storage, rig.storage), (get_object_store, rig.objects)):
        monkeypatch.setitem(app.dependency_overrides, dependency, lambda value=value: value)
    monkeypatch.setattr(chat_benchmark, "client", lambda _base_url: TestClient(app))
    library = tmp_path / "library"
    library.mkdir()
    (library / "cache.pdf").write_bytes(provider.make_pdf())
    questions = tmp_path / "questions.json"
    questions.write_text(json.dumps({
        "project": "Benchmark",
        "library": [{"key": "cache", "file": "cache.pdf", "finished": True}],
        "questions": [{"id": "d1", "class": "document", "scope": "document", "open": "cache", "prompt": "?", "facts": ["a"]}],
    }))
    out = tmp_path / "bench"

    assert chat_benchmark.main([
        "stage", "--base-url", "http://testserver", "--out", str(out), "--questions", str(questions),
        "--library", str(library), "--filing-minutes", "0",
    ]) == 0
    staged = json.loads((out / "stage.json").read_text())
    [paper_id] = staged["papers"].values()
    assert rig.storage.get_paper(chat_benchmark.USERNAME, staged["projectId"], paper_id)["doneAt"]
    assert staged["pages"][f"prefix-reuse-{paper_id}"] == ["cache"]

    with TestClient(app) as http:
        chat_benchmark.sign_in(http, create=False)
        queued = http.post(f"/api/memory/pages/prefix-reuse-{paper_id}/rewrite")
        assert queued.status_code == 200, queued.text
    maintenance = chat_benchmark.Maintenance("http://testserver", None)
    with maintenance:
        deadline = time.monotonic() + 60
        while not maintenance.jobs and time.monotonic() < deadline:
            time.sleep(0.05)
    maintenance.thread.join(timeout=60)
    assert maintenance.jobs == 1 and not maintenance.thread.is_alive()
    assert "page-rewrite" not in {job["kind"] for job in rig.storage.list_memory_jobs(chat_benchmark.USERNAME)}
