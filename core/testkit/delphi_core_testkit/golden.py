"""
What every read of the golden Memory library answered, and how a library is asked.

The golden library is one account's Memory as an earlier release wrote it,
once through each store (core's `tests/build_golden.py` writes and keeps the
local one; a product keeps its own store's). `data/golden/snapshot.json` is
what every Memory, conversation and plan read answered for it then,
normalized (`normalize`); both stores answered it alike. A product opens its copy of the library through its own app and
stores, asks it everything (`signed_in`, `responses`) and compares
(`difference`, `differing`): a migration that loses, moves or renames what a
reader had fails there, on data the new code did not write for itself.

The snapshot is versioned with the kit, so a product compares against the
answers of the core it pins.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path
from typing import Any

SNAPSHOT = Path(__file__).resolve().parent / "data" / "golden" / "snapshot.json"
USERNAME = "reader"
SECRET = "golden-memory-library"


def snapshot() -> dict[str, Any]:
    """Every read's answer, as the snapshot records it."""
    return json.loads(SNAPSHOT.read_text())


# --- what a library answers ---------------------------------------------------


def golden_settings(data_dir: Path, **given: Any):
    """The settings every snapshot is read under: no provider, the shipped defaults."""
    from delphi_core.config import Settings

    return Settings(_env_file=None, data_dir=data_dir, session_secret=SECRET, openai_api_key="",
                    digest_research_enabled=False, **given)


@contextlib.contextmanager
def signed_in(settings, storage, objects, *, app=None):
    """A client of `app` over these stores, signed in as the account: the reference app unless one is given."""
    from fastapi.testclient import TestClient

    from delphi_core.config import get_settings
    from delphi_core.deps import get_object_store, get_storage
    from delphi_core.security import make_session

    if app is None:
        from delphi_core.main import app

    # A product's app may carry overrides of its own (`get_current_user`): kept, and restored.
    held = dict(app.dependency_overrides)
    app.dependency_overrides.update({
        get_settings: lambda: settings, get_storage: lambda: storage, get_object_store: lambda: objects,
    })
    try:
        with TestClient(app) as client:
            client.cookies.set("delphi_session", make_session(USERNAME, settings.session_secret, 1))
            yield client
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(held)


def _answer(response) -> Any:
    """One route's answer, as the snapshot records it."""
    kind = response.headers.get("content-type", "").split(";")[0]
    if kind == "application/json":
        return {"status": response.status_code, "json": response.json()}
    if kind.startswith("text/"):
        return {"status": response.status_code, "type": kind, "text": response.text}
    if kind in ("application/zip", "application/x-zip-compressed"):
        entries = {}
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            for name in sorted(archive.namelist()):
                data = archive.read(name)
                try:
                    # A JSON file's key order is its store's: Postgres keeps JSONB keys sorted its own way.
                    entries[name] = json.loads(data) if name.endswith(".json") else data.decode("utf-8")
                except UnicodeDecodeError:
                    entries[name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        return {"status": response.status_code, "type": kind, "entries": entries}
    return {"status": response.status_code, "type": kind, "bytes": len(response.content),
            "sha256": hashlib.sha256(response.content).hexdigest()}


def _plain(value: Any) -> Any:
    """A store's answer as JSON would carry it, the way a route serializes one."""
    return {"rows": json.loads(json.dumps(value, default=str))}


def responses(client, storage) -> dict[str, Any]:
    """
    What every read of the account's Memory, conversations and plans answers.

    The routes that name a thing (a page, a document, a conversation, a plan,
    a figure) are asked for each one the listings name, so a library that
    lost something is caught by the listing and by the read alike. A page's
    versions are served by no route, so they are read from the store, as
    chat reads them (`memory_harness.read_state`).
    """
    answers: dict[str, Any] = {}

    def ask(path: str, **params: Any) -> Any:
        query = "&".join(f"{key}={value}" for key, value in params.items())
        response = client.get(path, params=params)
        answers[f"{path}?{query}" if query else path] = _answer(response)
        return response.json() if response.headers.get("content-type", "").startswith("application/json") else None

    for path in ("/api/memory", "/api/memory/graph", "/api/memory/domains", "/api/memory/health",
                 "/api/memory/maintenance", "/api/memory/update", "/api/memory/backfill/papers",
                 "/api/export"):
        ask(path)
    pages = ask("/api/memory/pages")
    ask("/api/memory/pages", kind="concept")
    ask("/api/memory/search", q="prefix")
    slugs = sorted(page["slug"] for page in pages)
    figures: list[str] = []
    for slug in slugs:
        read = ask(f"/api/memory/pages/{slug}")
        figures += [figure["id"] for figure in read["page"].get("figures") or ()]
        ask("/api/memory/neighborhood", slug=slug)
        answers[f"Storage.list_page_versions({slug})"] = _plain(storage.list_page_versions(USERNAME, slug))
    answers["Storage.page_history"] = _plain(storage.page_history(USERNAME, slugs))
    for figure_id in sorted(set(figures)):
        ask(f"/api/memory/figures/{figure_id}")

    projects = ask("/api/projects")
    for project in projects:
        detail = ask(f"/api/projects/{project['id']}")
        for paper in sorted(detail["papers"], key=lambda paper: paper["id"]):
            where = f"/api/projects/{project['id']}/papers/{paper['id']}"
            ask(f"/api/memory/documents/{paper['id']}/filing")
            ask(f"/api/memory/documents/{paper['id']}/neighborhood")
            ask(f"{where}/highlights")
            ask(f"{where}/notes")
            scope = {"scope": "document", "project_id": project["id"], "paper_id": paper["id"]}
            for conversation in ask("/api/chat/conversations", **scope)["items"]:
                ask("/api/chat", **scope, conversation_id=conversation["id"], generation=conversation["generation"])
    for conversation in ask("/api/chat/conversations", scope="general")["items"]:
        ask("/api/chat", scope="general", conversation_id=conversation["id"], generation=conversation["generation"])
    ask("/api/conversations")

    listed = ask("/api/plans")
    ask("/api/plans/capacity")
    ask("/api/plans/grants")
    for plan in listed["plans"]:
        for suffix in ("", "/view", "/export"):
            ask(f"/api/plans/{plan['id']}{suffix}")
    return answers


# --- normalizing --------------------------------------------------------------

#: A time as either store writes one, and a date alone.
_TIME = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?")
_DATE = re.compile(r"(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)")
#: A generated id or a hash over one: twelve or more hex digits in a row.
_HEX = re.compile(r"(?<![0-9a-f])[0-9a-f]{12,}(?![0-9a-f])")
#: Milliseconds of wall clock: when each stretch of an answer's work started
#: and ended and how long Memory's choice took (`AnswerTrace`), and how long
#: a digest's calls ran (its `telemetry`).
_ELAPSED = frozenset({"at", "endedAt", "ms", "memoryMs", "durationMs", "totalDurationMs"})
#: The routes that answer the graph index's revision. Local storage counts
#: Memory's writes and Postgres hashes its state (`memory_graph_revision`),
#: so the number is each store's own.
_GRAPH = re.compile(r"/api/memory(?:/graph|/neighborhood\?.*|/documents/[^/]+/neighborhood)?")
#: Fields of `/api/conversations` only one store answers, a gap the contract
#: suite does not hold (`list_recent_conversations`): local storage answers a
#: conversation's `generation` of 0, which Postgres leaves out, and Postgres a
#: `titleModel` and `titleUpdatedAt` of null, which local storage leaves out.
#: Set aside, so the snapshot holds everything both answer alike.
_ONE_STORE = frozenset({"generation", "titleModel", "titleUpdatedAt"})
#: The hash `_answer` takes of bytes a route served. A placeholder would name
#: a hash seen once whatever it was, and pass bytes that changed.
_VERBATIM = "sha256"


def _store_neutral(route: str, answer: dict[str, Any]) -> dict[str, Any]:
    body = answer.get("json")
    if _GRAPH.fullmatch(route) and isinstance(body, dict) and "revision" in body:
        return {**answer, "json": {**body, "revision": "<graph revision>"}}
    if route == "/api/conversations":
        return {**answer, "json": [{key: value for key, value in item.items() if key not in _ONE_STORE} for item in body]}
    return answer


def normalize(answers: dict[str, Any]) -> dict[str, Any]:
    """
    The answers with what a rebuild changes named by placeholder.

    Times become `<time>`, dates `<date>` and elapsed milliseconds `<ms>`. A
    hash of bytes the snapshot took (`_answer`) is kept as it is. A
    generated id (twelve or more hex digits, alone or inside a key, a marker
    or a path) becomes `<id:N>`, numbered by where it first appears, so every
    place that names one thing still names the same placeholder and a
    reference that moved to another thing does not. Routes are read in the
    order they were asked and each object in key order, an id in a key
    sorting as any other id would, so the numbering does not depend on what
    the ids are. Route paths are normalized the same way. What only one store
    answers is set aside first (`_store_neutral`).
    """
    answers = {route: _store_neutral(route, answer) for route, answer in answers.items()}
    seen: dict[str, str] = {}

    def text(value: str) -> str:
        value = _TIME.sub("<time>", value)
        value = _DATE.sub("<date>", value)
        return _HEX.sub(lambda found: seen.setdefault(found[0], f"<id:{len(seen) + 1}>"), value)

    def field(key: str, value: Any) -> Any:
        if key in _ELAPSED and isinstance(value, int):
            return "<ms>"
        return value if key == _VERBATIM else walk(value)

    def walk(value: Any) -> Any:
        if isinstance(value, str):
            return text(value)
        if isinstance(value, list):
            return [walk(item) for item in value]
        if isinstance(value, dict):
            ordered = sorted(value.items(), key=lambda item: _HEX.sub("", item[0]))
            return {text(key): field(key, item) for key, item in ordered}
        return value

    return {text(route): walk(answer) for route, answer in answers.items()}


# --- comparing ----------------------------------------------------------------


def difference(found: Any, expected: Any, at: str = "") -> str | None:
    """Where an answer first parts from the snapshot, in words, or None."""
    if type(found) is not type(expected):
        return f"{at}: {found!r:.300} where the snapshot has {expected!r:.300}"
    if isinstance(found, dict):
        for key in sorted({*found, *expected}):
            if key not in found:
                return f"{at} › {key}: missing, where the snapshot has {expected[key]!r:.300}"
            if key not in expected:
                return f"{at} › {key}: {found[key]!r:.300}, which the snapshot does not have"
            if said := difference(found[key], expected[key], f"{at} › {key}"):
                return said
        return None
    if isinstance(found, list):
        for index, (item, held) in enumerate(zip(found, expected)):
            if said := difference(item, held, f"{at}[{index}]"):
                return said
        if len(found) != len(expected):
            return f"{at}: {len(found)} items where the snapshot has {len(expected)}"
        return None
    return None if found == expected else f"{at}: {found!r:.300} where the snapshot has {expected!r:.300}"


def differing(found: dict[str, Any], expected: dict[str, Any]) -> list[str]:
    """Every read whose answer is not the snapshot's."""
    return sorted(read for read in {*found, *expected} if found.get(read) != expected.get(read))
