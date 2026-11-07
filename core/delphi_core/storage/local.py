"""
Filesystem implementation of the storage boundary.

The on-disk layout is unchanged from the original `LocalStorage`, so an existing
`.data/` directory keeps working. One thing is deliberately different: the
`projects.json` summary index is no longer written. It duplicated `meta.json`
and the two could drift apart if a crash landed between the two writes. The
project list is now derived, which removes that failure mode by construction.
Any `projects.json` left over from an earlier version is simply ignored.
"""

import copy
import json
import os
import shutil
import tempfile
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import ExitStack, contextmanager
from datetime import UTC, datetime, timedelta
from functools import wraps
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

from ..config import Settings
from ..memory_retrieval import lexical_score, retrieval_terms
from ..document_index import (
    build_snippet,
    locator_label,
    query_terms,
    rank_hits,
    score_section,
)
from ..workspace_search import (
    TITLE_WEIGHT,
    Match,
    collapse_matches,
    collective_terms,
    conversation_row,
    document_row,
    memory_row,
    message_text,
    score_collective,
)
from ..personas import official_detail, official_persona
from ..memory_maintenance.jobs import capture_marker, document_marker
from .domains import domain_job, domains_owed
from .sessions import note_holders, session_job, turn_to_file
from .base import (
    MEMORY_VERSION,
    PAPER_TITLE_MAX_CHARS,
    fit_conversation_title,
    initial_title,
    evidence_holders,
    external_evidence_key,
    external_evidence_record,
    MEMORY_JOB_KINDS,
    ONBOARDING_COMPLETE,
    ONBOARDING_RUNNING,
    MemoryJobGone,
    onboarding_tally,
    job_payload_is_upgradeable,
    ACCOUNT_CHAT_IMAGE_KEY,
    ObjectStore,
    Removed,
    Storage,
    abandoned_job_error,
    allocate_route_slug,
    decode_cursor,
    default_domain_record,
    encode_cursor,
    domain_job_marker,
    memory_slug,
    last_user_turn_index,
    matches_persona_query,
    parse_wiki_links,
    plan_route_slug_repairs,
    empty_plan_state,
    safe_id,
    utc_now,
    check_expected_revision,
    check_page_shape,
    valid_route_slug,
    rehome_chat_image_key,
    CAPTURE_JOB_KINDS,
    DOCUMENT_JOB_KINDS,
    LINK_REPAIR_NOTE,
    VERSIONED_KINDS,
    VERSIONS_KEPT,
    check_version_trigger,
    clean_aliases,
    job_fingerprint_moved,
    job_is_due,
    waits_for_capture,
    page_history_entry,
    page_version,
    unlink_deleted_page,
)

def persona_public(record: dict[str, Any], with_content: bool = True) -> dict[str, Any]:
    """
    A stored persona in its API shape.

    The file already holds that shape, so this only decides whether the body
    travels. A listing never carries one: a browse page is then a few hundred
    bytes a row instead of thirty kilobytes, the same argument that keeps web
    documents down to an outline.
    """
    if with_content:
        return dict(record)
    return {key: value for key, value in record.items() if key != "content"}


CHUNK = 1024 * 1024
CHAT_IMAGE_LOCK = threading.Lock()
# Persona writes are read-modify-write against one JSON file, and the marketplace
# scans across accounts. Postgres resolves both with a transaction; here one lock
# is what keeps two requests in the same process from interleaving.
PERSONA_LOCK = threading.RLock()
# One account-wide JSON queue. Re-entrant because project/chat mutations call
# the same helper exposed by the public maintenance API.
MEMORY_JOB_LOCK = threading.RLock()
CONVERSATION_LOCK = threading.RLock()

# One project is one `meta.json`, so *every* record change is a read-modify-write
# of the whole file, and two of them in flight against the same project lose one
# another. The Memory backfill files three documents at once and so put three
# of these against one project: a digest claim was written by a save that had
# read the file before the claim landed, the build that lost its claim finished
# minutes later against a record that no longer named it, and the reader saw
# "409: Digest build claim expired" for a document whose digest had in fact just
# been built — and whose `digest` field was gone entirely, which is the tell that
# a write was overwritten rather than rejected. `sql.py` resolves this with
# `SELECT … FOR UPDATE` and needs nothing; here the writers are sync methods in
# one process's threadpool, so one re-entrant lock per project file covers it.
_META_LOCKS: dict[Path, "threading.RLock"] = {}
_META_LOCKS_GUARD = threading.Lock()


def _meta_lock(path: Path) -> "threading.RLock":
    with _META_LOCKS_GUARD:
        lock = _META_LOCKS.get(path)
        if lock is None:
            lock = _META_LOCKS[path] = threading.RLock()
        return lock


def _record_attempt(job: dict[str, Any], entry: dict[str, Any], at: str) -> None:
    """Append one failed attempt to the job's last eight, dated when it failed."""
    payload = dict(job.get("payload") or {})
    payload["attemptTelemetry"] = [*list(payload.get("attemptTelemetry") or [])[-7:], {**entry, "failedAt": at}]
    job["payload"] = payload


def serialised(method: Callable[..., Any]) -> Callable[..., Any]:
    """
    Serialise one project's read-modify-write against its own `meta.json`.

    Applied to every method that reads a project record and writes it back —
    which is the shape of all of them, since the record is one file. Re-entrant
    because a mutator may call another (`move_paper` reads the paper it is about
    to re-parent), and keyed by path so two projects never wait on each other.
    The account-wide scope has no project file; its methods serialise against
    the account's own directory instead.
    """

    @wraps(method)
    def wrapper(self: "LocalStorage", username: str, project_id: str | None, *args, **kwargs):
        path = (
            self._meta_path(username, project_id)
            if project_id is not None
            else self._user_dir(username) / "meta.json"
        )
        with _meta_lock(path):
            return method(self, username, project_id, *args, **kwargs)

    return wrapper


class LocalObjectStore(ObjectStore):
    """
    Maps the abstract key `u/<user>/p/<project>/<paper>.<ext>` onto the historical
    path `users/<user>/projects/<project>/papers/<paper>.<ext>`, so keys are
    portable to a real object store while an existing `.data/` still resolves.
    Paper-scoped evidence deliberately lives outside the project directory, so
    filing a paper elsewhere cannot break a citation jump or require a copy.
    """

    _last_chat_image_sweep = 0.0
    _sweep_lock = threading.Lock()

    def __init__(self, root: Path, chat_image_retention_days: int = 30):
        self.root = root
        self._sweep_chat_images(chat_image_retention_days)

    def _sweep_chat_images(self, retention_days: int) -> None:
        now = time.time()
        if now - type(self)._last_chat_image_sweep < 6 * 60 * 60:
            return
        with type(self)._sweep_lock:
            if now - type(self)._last_chat_image_sweep < 6 * 60 * 60:
                return
            cutoff = now - retention_days * 24 * 60 * 60
            users = self.root / "users"
            if users.exists():
                swept = [
                    *users.glob("*/projects/*/chat-images/**/*.webp"),
                    # The account-wide conversation keeps its images beside the
                    # user rather than under a project, so the project glob
                    # cannot see them and they would never expire.
                    *users.glob("*/chat-images/**/*.webp"),
                ]
                for path in swept:
                    try:
                        if path.stat().st_mtime <= cutoff:
                            path.unlink(missing_ok=True)
                    except OSError:
                        # Sweep failure cannot make the application unavailable;
                        # exact expiry is still enforced at every access boundary.
                        pass
            type(self)._last_chat_image_sweep = now

    def _path(self, key: str) -> Path:
        parts = key.split("/")
        if len(parts) == 5 and parts[0:2] == ["plans", "u"]:
            stem, dot, extension = parts[4].rpartition(".")
            if not dot or extension not in {"txt", "json", "pdf", "png"}:
                raise HTTPException(400, "Invalid plan object key")
            return self.root / "users" / safe_id(parts[2]) / "plan-captures" / safe_id(parts[3]) / f"{safe_id(stem)}.{extension}"
        if (
            len(parts) == 6
            and parts[0] == "evidence"
            and parts[1] == "u"
            and parts[3] == "p"
        ):
            filename = parts[5]
            stem, dot, ext = filename.rpartition(".")
            if not dot or ext != "json":
                raise HTTPException(400, "Invalid object key")
            return (
                self.root
                / "users"
                / safe_id(parts[2])
                / "paper-evidence"
                / safe_id(parts[4])
                / f"{safe_id(stem)}.json"
            )
        if (
            len(parts) == 7
            and parts[0] == "chat-images"
            and parts[1] == "u"
            and parts[3] == "p"
        ):
            filename = parts[6]
            stem, dot, ext = filename.rpartition(".")
            if not dot:
                raise HTTPException(400, "Invalid object key")
            return (
                self.root
                / "users"
                / safe_id(parts[2])
                / "projects"
                / safe_id(parts[4])
                / "chat-images"
                / safe_id(parts[5])
                / f"{safe_id(stem)}.{safe_id(ext)}"
            )
        if (
            len(parts) == 6
            and parts[0] == "chat-images"
            and parts[1] == "u"
            and parts[3] == "account"
        ):
            # The account-wide conversation's images. One segment shorter than
            # the project form because there is no project to name, and under
            # the user rather than under a placeholder project directory that
            # every projects listing would then have to know to skip.
            filename = parts[5]
            stem, dot, ext = filename.rpartition(".")
            if not dot:
                raise HTTPException(400, "Invalid object key")
            return (
                self.root
                / "users"
                / safe_id(parts[2])
                / "chat-images"
                / safe_id(parts[4])
                / f"{safe_id(stem)}.{safe_id(ext)}"
            )
        if (
            len(parts) == 5
            and parts[0] == "knowledge"
            and parts[1] == "u"
            and parts[3] in {"figures", "evidence"}
        ):
            # Under the account, never under a project: a captured figure
            # outlives the paper it came out of and must not move when that
            # paper is filed somewhere else. Captured outside sources are kept
            # beside them for the same reason.
            filename = parts[4]
            stem, dot, ext = filename.rpartition(".")
            if not dot:
                raise HTTPException(400, "Invalid object key")
            return (
                self.root
                / "users"
                / safe_id(parts[2])
                / "memory"
                / parts[3]
                / f"{safe_id(stem)}.{safe_id(ext)}"
            )
        if len(parts) != 5 or parts[0] != "u" or parts[2] != "p":
            raise HTTPException(400, "Invalid object key")
        _, username, _, project_id, filename = parts
        stem, _, ext = filename.rpartition(".")
        return (
            self.root
            / "users"
            / safe_id(username)
            / "projects"
            / safe_id(project_id)
            / "papers"
            / f"{safe_id(stem)}.{safe_id(ext)}"
        )

    def put_file(self, key: str, path: Path, content_type: str) -> None:
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)

    def put_text(self, key: str, text: str) -> None:
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        # A saved revision is a single publication, even if the process dies.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as staged:
            staged_path = Path(staged.name)
            try:
                staged.write(text)
                staged.flush()
                os.fsync(staged.fileno())
            except BaseException:
                staged_path.unlink(missing_ok=True)
                raise
        try:
            os.replace(staged_path, target)
        finally:
            staged_path.unlink(missing_ok=True)

    def get_text(self, key: str) -> str:
        path = self._path(key)
        if not path.exists():
            raise HTTPException(404, "Extracted text is unavailable")
        return path.read_text(encoding="utf-8")

    def size(self, key: str) -> int:
        path = self._path(key)
        if not path.exists():
            raise HTTPException(404, "Paper file is unavailable")
        return path.stat().st_size

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def open_range(
        self, key: str, start: int | None = None, end: int | None = None
    ) -> Iterator[bytes]:
        # Not a generator function itself: the exists() check below must run
        # the moment the caller calls open_range, not on the first `next()`.
        # A caller wraps the return value in a StreamingResponse, and by the
        # time that response starts iterating its body, headers are already
        # on the wire — an HTTPException raised from inside the loop can no
        # longer become a 404, only a mid-stream crash.
        path = self._path(key)
        if not path.exists():
            raise HTTPException(404, "Paper file is unavailable")
        return self._read_range(path, start, end)

    def _read_range(
        self, path: Path, start: int | None, end: int | None
    ) -> Iterator[bytes]:
        # The existence check already happened before streaming began; a file
        # removed after that (a concurrent delete or move) ends the response
        # early rather than raising, since there is no way left to turn it
        # into a clean error at this point.
        try:
            with path.open("rb") as handle:
                if start:
                    handle.seek(start)
                remaining = None if end is None else end - (start or 0) + 1
                while True:
                    size = CHUNK if remaining is None else min(CHUNK, remaining)
                    if size <= 0:
                        return
                    chunk = handle.read(size)
                    if not chunk:
                        return
                    if remaining is not None:
                        remaining -= len(chunk)
                    yield chunk
        except FileNotFoundError:
            return

    def fetch_to_tempfile(self, key: str) -> Path:
        source = self._path(key)
        if not source.exists():
            raise HTTPException(404, "Paper file is unavailable")
        handle, name = tempfile.mkstemp(suffix=".pdf")
        os.close(handle)
        shutil.copyfile(source, name)
        return Path(name)

    def copy(self, source: str, destination: str) -> bool:
        origin = self._path(source)
        if not origin.exists():
            return False
        target = self._path(destination)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(origin, target)
        return True

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def delete_prefix(self, prefix: str) -> None:
        parts = prefix.strip("/").split("/")
        if len(parts) == 4 and parts[:2] == ["plans", "u"]:
            target = self.root / "users" / safe_id(parts[2]) / "plan-captures" / safe_id(parts[3])
            shutil.rmtree(target, ignore_errors=True)
            return
        if (
            len(parts) == 5
            and parts[0] == "evidence"
            and parts[1] == "u"
            and parts[3] == "p"
        ):
            target = (
                self.root
                / "users"
                / safe_id(parts[2])
                / "paper-evidence"
                / safe_id(parts[4])
            )
            shutil.rmtree(target, ignore_errors=True)
            return
        if (
            len(parts) in {5, 6}
            and parts[0] == "chat-images"
            and parts[1] == "u"
            and parts[3] == "p"
        ):
            target = (
                self.root
                / "users"
                / safe_id(parts[2])
                / "projects"
                / safe_id(parts[4])
                / "chat-images"
            )
            if len(parts) == 6:
                target /= safe_id(parts[5])
            shutil.rmtree(target, ignore_errors=True)
            return
        if (
            len(parts) in {4, 5}
            and parts[0] == "chat-images"
            and parts[1] == "u"
            and parts[3] == "account"
        ):
            target = self.root / "users" / safe_id(parts[2]) / "chat-images"
            if len(parts) == 5:
                target /= safe_id(parts[4])
            shutil.rmtree(target, ignore_errors=True)
            return
        if (
            len(parts) == 4
            and parts[0] == "knowledge"
            and parts[1] == "u"
            and parts[3] in {"figures", "evidence"}
        ):
            shutil.rmtree(
                self.root / "users" / safe_id(parts[2]) / "memory" / parts[3],
                ignore_errors=True,
            )
            return
        if len(parts) != 4 or parts[0] != "u" or parts[2] != "p":
            raise HTTPException(400, "Invalid object prefix")
        papers = (
            self.root
            / "users"
            / safe_id(parts[1])
            / "projects"
            / safe_id(parts[3])
            / "papers"
        )
        shutil.rmtree(papers, ignore_errors=True)


from . import local_format
from .conversations import KINDS, LocalConversationCatalog, check_append, require_selector



def current_page(page: dict[str, Any]) -> dict[str, Any]:
    """
    A page record without the project its document was filed in. A page names
    its document by id alone: the project changes with every move, so pages
    written before this kept one that went stale.
    """
    return {key: value for key, value in page.items() if key != "sourceProjectId"}

class LocalStorage(LocalConversationCatalog, Storage):
    """Filesystem records with user-scoped paths and atomic JSON writes."""

    kind = "local"

    def _plans_path(self, username: str) -> Path:
        return self._user_dir(username) / "plans.json"

    def plan_transaction(self, username, operation, *, conversation=None):
        # Same lock as deletion/reset: a late Plan commit cannot race generation fencing.
        with CONVERSATION_LOCK:
            if not self.account_exists(username):
                raise HTTPException(404, "Account not found")
            if conversation:
                row = self.get_conversation(username, conversation["id"])
                if row.get("generation", 0) != conversation["generation"]:
                    raise HTTPException(409, "Conversation changed; plan was not saved")
                if conversation.get("requestId"):
                    from .conversations import check_append
                    check_append(row.get("messages", []), {"role": "assistant", "requestId": conversation["requestId"]}, {})

            path = self._plans_path(username)
            state = self._read_json(path, empty_plan_state())
            result = operation(state)
            self._write_json(path, state)
            return result

    def plan_state(self, username):
        # `_write_json` replaces the file atomically, so a reader needs no lock.
        return self._read_json(self._plans_path(username), empty_plan_state())

    def __init__(self, settings: Settings):
        self.settings = settings
        self.session_idle_seconds = settings.memory_session_idle_seconds
        self.domain_settle_seconds = settings.memory_domain_settle_seconds
        self.root = settings.data_dir
        self.root.mkdir(parents=True, exist_ok=True)
        self._conversation_head_cache: dict[str, dict[str, tuple[tuple[int, int, int], dict[str, Any]]]] = {}
        # An account written by an earlier release is brought to the current
        # format before anything reads it. When every account is already
        # there this is one listing of `users/`.
        local_format.open_store(self)

    # --- primitives -----------------------------------------------------
    def _user_dir(self, username: str) -> Path:
        return self.root / "users" / safe_id(username)

    def _project_dir(self, username: str, project_id: str) -> Path:
        return self._user_dir(username) / "projects" / safe_id(project_id)

    def _read_json(self, path: Path, default: Any) -> Any:
        if not path.exists():
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise HTTPException(500, f"Stored data is unreadable: {path.name}")

    def _write_json(self, path: Path, value: Any) -> None:
        self._write_atomic(path, json.dumps(value, ensure_ascii=False, indent=2))

    def _write_atomic(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                stream.write(text)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    def _meta_path(self, username: str, project_id: str) -> Path:
        return self._project_dir(username, project_id) / "meta.json"

    def _save_meta(self, username: str, meta: dict[str, Any]) -> dict[str, Any]:
        meta["updatedAt"] = utc_now()
        self._write_json(self._meta_path(username, meta["id"]), meta)
        return meta

    def _project_metas(self, username: str) -> list[dict[str, Any]]:
        projects_dir = self._user_dir(username) / "projects"
        if not projects_dir.exists():
            return []
        metas = [
            meta
            for meta in (
                self._read_json(entry / "meta.json", None)
                for entry in projects_dir.iterdir()
                if entry.is_dir()
            )
            if meta and meta.get("owner") == username
        ]
        metas.sort(key=lambda meta: (meta.get("createdAt") or "", meta["id"]))
        return metas

    def _ensure_route_slugs(self, username: str) -> list[dict[str, Any]]:
        """
        Repair route metadata lazily.

        The name snapshot distinguishes a legitimate collision suffix from a
        route left stale by an older binary renaming the record during a rolling
        deploy. Existing valid routes otherwise stay put, so deleting a sibling
        frees its slug without renaming anything that remains.
        """
        metas = self._project_metas(username)
        project_repairs = plan_route_slug_repairs(
            [
                (
                    meta["id"],
                    meta.get("name", ""),
                    meta.get("slug"),
                    meta.get("routeName"),
                )
                for meta in metas
            ],
            "project",
        )
        for meta in metas:
            changed = meta["id"] in project_repairs
            if changed:
                meta["slug"] = project_repairs[meta["id"]]
                meta["routeName"] = meta.get("name", "")

            paper_repairs = plan_route_slug_repairs(
                [
                    (
                        paper["id"],
                        paper.get("title", ""),
                        paper.get("slug"),
                        paper.get("routeTitle"),
                    )
                    for paper in meta.get("papers", [])
                ],
                "document",
            )
            for paper in meta.get("papers", []):
                if paper["id"] not in paper_repairs:
                    continue
                paper["slug"] = paper_repairs[paper["id"]]
                paper["routeTitle"] = paper.get("title", "")
                changed = True
            if changed:
                # Route repair is metadata maintenance, not user activity; keep
                # updatedAt stable so a first read cannot reorder or age a record.
                self._write_json(self._meta_path(username, meta["id"]), meta)
        return metas

    # --- accounts -------------------------------------------------------
    def _account_path(self, username: str) -> Path:
        return self._user_dir(username) / "account.json"

    def account_exists(self, username: str) -> bool:
        return self._account_path(username).exists()

    def get_account(self, username: str) -> dict[str, Any] | None:
        return self._read_json(self._account_path(username), None)

    def create_account(
        self, username: str, email: str | None, salt: str, password_hash: str
    ) -> dict[str, Any]:
        path = self._account_path(username)
        if path.exists():
            raise HTTPException(409, "Username already exists")
        account = {
            "username": username,
            "email": email,
            "passwordSalt": salt,
            "passwordHash": password_hash,
            "useStandardTier": True,
            "createdAt": utc_now(),
        }
        # Before the account record, which is what makes the directory an
        # account: a new one is at the current format and is never migrated.
        local_format.mark_current(self, path.parent)
        self._write_json(path, account)
        return account

    def update_password(self, username: str, salt: str, password_hash: str) -> None:
        path = self._account_path(username)
        account = self._read_json(path, None)
        if account is None:
            raise HTTPException(404, "Account not found")
        account["passwordSalt"] = salt
        account["passwordHash"] = password_hash
        account["passwordUpdatedAt"] = utc_now()
        self._write_json(path, account)

    def update_account_preferences(
        self, username: str, *, use_standard_tier: bool
    ) -> dict[str, Any]:
        path = self._account_path(username)
        account = self._read_json(path, None)
        if account is None:
            raise HTTPException(404, "Account not found")
        account["useStandardTier"] = use_standard_tier
        self._write_json(path, account)
        return account

    # --- projects -------------------------------------------------------
    def list_projects(self, username: str) -> list[dict[str, Any]]:
        metas = self._ensure_route_slugs(username)
        # Newest first, matching the original insert-at-front index. Sorting on
        # createdAt rather than updatedAt keeps a rename from reordering the list.
        metas.sort(key=lambda meta: meta.get("createdAt") or "", reverse=True)
        return [
            {
                "id": meta["id"],
                "name": meta["name"],
                "slug": meta["slug"],
                "paperCount": sum(
                    1 for paper in meta.get("papers", []) if not paper.get("doneAt")
                ),
                "updatedAt": meta.get("updatedAt"),
            }
            for meta in metas
        ]

    def create_project(
        self, username: str, name: str, *, onboarding: bool = False
    ) -> dict[str, Any]:
        with PERSONA_LOCK:
            return self._create_project(username, name, onboarding=onboarding)

    def _create_project(
        self, username: str, name: str, *, onboarding: bool
    ) -> dict[str, Any]:
        used = {meta["slug"] for meta in self._ensure_route_slugs(username)}
        project_id = uuid4().hex[:12]
        now = utc_now()
        if onboarding:
            # Recorded before the project exists: a crash between the two
            # writes leaves the record naming a project that is not there,
            # which every reader of the record already skips, never a project
            # the attempt does not know it made.
            path = self._account_path(username)
            account = self._read_json(path, None)
            if account is None:
                raise HTTPException(404, "Account not found")
            record = account.get("onboarding") or {}
            if record.get("status") != ONBOARDING_RUNNING:
                record = {"status": ONBOARDING_RUNNING, "startedAt": now, "projectIds": []}
            record = {**record, "projectIds": [*record["projectIds"], project_id]}
            self._write_json(path, {**account, "onboarding": record})
        meta = {
            "id": project_id,
            "name": name.strip(),
            "slug": allocate_route_slug(name, "project", used),
            "routeName": name.strip(),
            "owner": username,
            "createdAt": now,
            "updatedAt": now,
            "papers": [],
        }
        self._write_json(self._meta_path(username, project_id), meta)
        return self._public_meta(username, meta)

    @staticmethod
    def _public_paper(paper: dict[str, Any]) -> dict[str, Any]:
        return {
            key: value
            for key, value in paper.items()
            # `sourceUrl` is where a promoted linked PDF keeps the address it
            # came from: provenance, not part of the record, and the mirror of
            # the SQL backend's `source_url` column, which `paper_record` also
            # stops serving once the paper is a PDF.
            if key not in {"routeTitle", "sourceHash", "digestClaim", "sourceUrl"}
            and not (key == "lastEngagedAt" and value == paper.get("createdAt"))
            # Zero failures is the absence of failures. Stored either way, but
            # served only when it says something, because the SQL backend omits
            # a falsy column and the two record shapes have to match.
            and not (key == "thumbnailAttempts" and not value)
            # A page read whole has nothing owed: `capture` is said only while
            # the stored copy is a first window.
            and not (key == "capture" and not value)
        }

    def _public_meta(self, username: str, meta: dict[str, Any]) -> dict[str, Any]:
        public = {
            key: value
            for key, value in meta.items()
            if key not in {"routeName", "personaKey", "personaId", "skillsUpdatedAt"}
        }
        public["papers"] = [
            self._public_paper(paper) for paper in meta.get("papers", [])
        ]
        # No `persona` and no `skills`. A project referenced a persona and served
        # its body as SKILLS.md; both are gone with the concept. The stored keys
        # are still filtered out above so a `meta.json` written by an older
        # binary reads cleanly rather than leaking them into the API shape.
        return public

    def _get_project(self, username: str, project_id: str) -> dict[str, Any]:
        self._ensure_route_slugs(username)
        meta = self._read_json(self._meta_path(username, project_id), None)
        # A project owned by someone else reads as absent rather than forbidden,
        # so the API never confirms that an id exists to someone who cannot see it.
        if not meta or meta.get("owner") != username:
            raise HTTPException(404, "Project not found")
        return meta

    def get_project(self, username: str, project_id: str) -> dict[str, Any]:
        return self._public_meta(username, self._get_project(username, project_id))

    def list_projects_with_papers(self, username: str) -> list[dict[str, Any]]:
        metas = self._ensure_route_slugs(username)
        metas.sort(key=lambda meta: meta.get("createdAt") or "", reverse=True)
        return [self._public_meta(username, meta) for meta in metas]

    def resolve_reader(
        self, username: str, project_slug: str, paper_slug: str | None = None
    ) -> dict[str, Any]:
        if not valid_route_slug(project_slug) or (
            paper_slug is not None and not valid_route_slug(paper_slug)
        ):
            raise HTTPException(404, "Document unavailable")
        project = next(
            (
                meta
                for meta in self._ensure_route_slugs(username)
                if meta.get("slug") == project_slug
            ),
            None,
        )
        if project is None:
            raise HTTPException(404, "Document unavailable")
        if paper_slug is None:
            return {"project": self._public_meta(username, project), "paperId": None}
        paper = next(
            (
                item
                for item in project.get("papers", [])
                if item.get("slug") == paper_slug
            ),
            None,
        )
        if paper is None:
            raise HTTPException(404, "Document unavailable")
        return {"project": self._public_meta(username, project), "paperId": paper["id"]}

    @serialised
    def rename_project(
        self, username: str, project_id: str, name: str
    ) -> dict[str, Any]:
        meta = self._get_project(username, project_id)
        meta["name"] = name
        used = {
            item["slug"]
            for item in self._ensure_route_slugs(username)
            if item["id"] != project_id
        }
        meta["slug"] = allocate_route_slug(name, "project", used)
        meta["routeName"] = name
        return self._public_meta(username, self._save_meta(username, meta))

    @serialised
    def delete_project(self, username: str, project_id: str) -> Removed:
        meta = self._get_project(username, project_id)
        removed = Removed(
            openai_file_ids=[
                paper["openaiFileId"]
                for paper in meta.get("papers", [])
                if paper.get("openaiFileId")
            ]
        )
        self._delete_project_jobs(username, project_id)
        with CONVERSATION_LOCK:
            for conversation in self._conversation_heads(username):
                if conversation.get("projectId") == project_id:
                    self._conversation_path(username, conversation["id"]).unlink(missing_ok=True)
        shutil.rmtree(self._project_dir(username, project_id), ignore_errors=True)
        return removed

    # --- onboarding -----------------------------------------------------
    def _onboarding_tally(
        self, username: str, project_ids: list[str], *, require_filing: bool
    ) -> tuple[list[str], dict[str, int]]:
        """The attempt's live projects and how far their documents got."""
        live, paper_ids = [], []
        for project_id in project_ids:
            if not self._meta_path(username, project_id).exists():
                continue
            live.append(project_id)
            paper_ids.extend(paper["id"] for paper in self._get_project(username, project_id).get("papers", []))
        filed = {event.get("requestId") for event in self._read_json(self._memory_events_path(username), [])}
        with MEMORY_JOB_LOCK:
            jobs = self._read_memory_jobs(username)
        pending = {job.get("marker") for job in jobs
                   if not (job.get("status") == "failed" and not job.get("retryAt"))}
        return live, onboarding_tally(paper_ids, filed, pending, require_filing=require_filing)

    def onboarding_status(self, username: str, *, require_filing: bool) -> dict[str, Any]:
        account = self.get_account(username) or {}
        record = account.get("onboarding")
        if not record:
            return {"status": None}
        if record.get("status") != ONBOARDING_RUNNING:
            return {"status": record.get("status")}
        _, tally = self._onboarding_tally(username, record.get("projectIds", []), require_filing=require_filing)
        return {"status": ONBOARDING_RUNNING, **tally}

    def settle_onboarding(
        self, username: str, *, require_filing: bool, finishing: bool = False
    ) -> dict[str, Any]:
        # PERSONA_LOCK is the lock `commit_memory_update` publishes under,
        # so a filing either committed before this looks, and counts, or
        # commits after its job row is gone here, and is refused.
        with PERSONA_LOCK:
            path = self._account_path(username)
            account = self._read_json(path, None)
            if account is None:
                raise HTTPException(404, "Account not found")
            record = account.get("onboarding")
            now = utc_now()
            if not record:
                if self.list_projects(username) or self.list_recent_conversations(username, limit=1):
                    # An account from before onboarding existed.
                    self._write_json(path, {**account, "onboarding": {"status": ONBOARDING_COMPLETE, "completedAt": now}})
                    return {"outcome": "complete", "removed": Removed(), "projectIds": []}
                return {"outcome": "fresh", "removed": Removed(), "projectIds": []}
            if record.get("status") == ONBOARDING_COMPLETE:
                return {"outcome": "complete", "removed": Removed(), "projectIds": []}
            live, tally = self._onboarding_tally(username, record.get("projectIds", []), require_filing=require_filing)
            if tally["completed"]:
                self._write_json(path, {**account, "onboarding": {**record, "status": ONBOARDING_COMPLETE, "completedAt": now}})
                return {"outcome": "complete", "removed": Removed(), "projectIds": []}
            if finishing:
                return {"outcome": "running", "removed": Removed(), "projectIds": []}
            removed = Removed()
            for project_id in live:
                gone = self.delete_project(username, project_id)
                removed.openai_file_ids.extend(gone.openai_file_ids)
            self._write_json(path, {key: value for key, value in account.items() if key != "onboarding"})
            return {"outcome": "restart", "removed": removed, "projectIds": live}

    # --- personas -------------------------------------------------------
    def _personas_dir(self, username: str) -> Path:
        return self._user_dir(username) / "personas"

    def _persona_path(self, username: str, persona_id: str) -> Path:
        return self._personas_dir(username) / f"{safe_id(persona_id)}.json"

    def _write_persona(self, username: str, record: dict[str, Any]) -> None:
        self._write_json(self._persona_path(username, record["id"]), record)

    def _own_personas(self, username: str) -> list[dict[str, Any]]:
        """
        Derived by scanning the directory rather than read from an index file.

        An index would duplicate what the files already say and could drift from
        them after a crash — the same reason `projects.json` was retired.
        """
        directory = self._personas_dir(username)
        if not directory.exists():
            return []
        records = [
            self._read_json(entry, None)
            for entry in sorted(directory.iterdir())
            if entry.is_file() and entry.suffix == ".json"
        ]
        return [record for record in records if record]

    def _require_own_persona(self, username: str, persona_id: str) -> dict[str, Any]:
        record = self._read_json(self._persona_path(username, persona_id), None)
        # Absent and not-yours read identically, so the API never confirms a
        # private persona exists to someone who cannot see it.
        if not record:
            raise HTTPException(404, "Persona not found")
        return record

    def _insert_persona(
        self, username: str, fields: dict[str, Any]
    ) -> dict[str, Any]:
        now = utc_now()
        used = {record["slug"] for record in self._own_personas(username)}
        visibility = fields.get("visibility", "private")
        record = {
            "id": uuid4().hex[:12],
            "official": False,
            "name": fields["name"],
            "element": fields["element"],
            "tagline": fields.get("tagline"),
            "content": fields["content"],
            "visibility": visibility,
            "revision": 1,
            "installs": 0,
            "author": username,
            "slug": allocate_route_slug(fields["name"], "persona", used),
            "createdAt": now,
            "updatedAt": now,
        }
        if visibility == "public":
            record["publishedAt"] = now
        if fields.get("installedFrom"):
            record["installedFrom"] = fields["installedFrom"]
        self._write_persona(username, record)
        return record

    def list_personas(self, username: str) -> list[dict[str, Any]]:
        records = self._own_personas(username)
        records.sort(key=lambda item: (item["updatedAt"], item["id"]), reverse=True)
        return [persona_public(record, with_content=False) for record in records]

    def get_persona(self, username: str, persona_id: str) -> dict[str, Any]:
        official = official_persona(persona_id)
        if official is not None:
            return official_detail(official)
        record = self._read_json(self._persona_path(username, persona_id), None)
        if record:
            return persona_public(record)
        published = self._find_published(persona_id)
        if published is None:
            raise HTTPException(404, "Persona not found")
        return persona_public(published)

    def _find_published(self, persona_id: str) -> dict[str, Any] | None:
        for record in self._all_published():
            if record["id"] == safe_id(persona_id):
                return record
        return None

    def _all_published(self) -> list[dict[str, Any]]:
        """
        Every public persona, across accounts.

        A directory scan, which is honest about what this backend is: one machine,
        one reader. It is correct, not scalable, and the deployed backend answers
        the same question from a partial index.
        """
        users = self.root / "users"
        if not users.exists():
            return []
        found: list[dict[str, Any]] = []
        for directory in sorted(users.iterdir()):
            personas = directory / "personas"
            if not directory.is_dir() or not personas.exists():
                continue
            for entry in sorted(personas.iterdir()):
                if not entry.is_file() or entry.suffix != ".json":
                    continue
                record = self._read_json(entry, None)
                if record and record.get("visibility") == "public":
                    found.append(record)
        return found

    def create_persona(self, username: str, fields: dict[str, Any]) -> dict[str, Any]:
        if not self._account_path(username).exists():
            raise HTTPException(404, "Account not found")
        with PERSONA_LOCK:
            return persona_public(self._insert_persona(username, fields))

    def update_persona(
        self,
        username: str,
        persona_id: str,
        fields: dict[str, Any],
        *,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        with PERSONA_LOCK:
            record = self._require_own_persona(username, persona_id)
            if expected_revision is not None and record["revision"] != expected_revision:
                # 409 with the current record, so the client can show what
                # changed instead of quietly discarding the other tab's save.
                raise HTTPException(
                    409,
                    {
                        "message": "This persona changed in another tab.",
                        "persona": persona_public(record),
                    },
                )
            now = utc_now()
            for field in ("name", "element", "tagline", "content"):
                if field in fields:
                    record[field] = fields[field]
            if "visibility" in fields:
                record["visibility"] = fields["visibility"]
                if record["visibility"] == "public" and not record.get("publishedAt"):
                    record["publishedAt"] = now
            if "name" in fields:
                used = {
                    other["slug"]
                    for other in self._own_personas(username)
                    if other["id"] != record["id"]
                }
                record["slug"] = allocate_route_slug(record["name"], "persona", used)
            record["revision"] += 1
            record["updatedAt"] = now
            self._write_persona(username, record)
        # Referenced, never copied: every conversation held in this persona
        # answers with the new body from its next turn on. Nothing to propagate
        # — that is the point of a reference. There used to be a mirror into
        # every project pointing here, taken outside PERSONA_LOCK because every
        # other writer takes the project lock first; with projects out of the
        # picture that lock-ordering hazard is gone too.
        return persona_public(record)

    def delete_persona(self, username: str, persona_id: str) -> None:
        """
        Always allowed.

        It used to be refused while a project still pointed at the persona,
        which would have left that project with no guidance at all. A
        conversation resolves its persona per turn, so one whose persona has
        been deleted answers as the default from its next turn — and counting
        conversations the way projects were counted would make a persona used
        for a month undeletable, which is worse than the rule it replaces.
        """
        with PERSONA_LOCK:
            record = self._require_own_persona(username, persona_id)
            self._persona_path(username, record["id"]).unlink(missing_ok=True)

    def browse_personas(
        self,
        username: str,
        *,
        query: str = "",
        cursor: str | None = None,
        limit: int = 24,
    ) -> dict[str, Any]:
        records = [
            record
            for record in self._all_published()
            if matches_persona_query(query, record["name"], record.get("tagline"))
        ]
        records.sort(
            key=lambda item: (item.get("publishedAt") or "", item["id"]), reverse=True
        )
        position = decode_cursor(cursor)
        if position is not None:
            records = [
                record
                for record in records
                if ((record.get("publishedAt") or ""), record["id"]) < position
            ]
        # One row past the page is how the client learns there is more without a
        # second pass over everything.
        page = records[:limit]
        has_more = len(records) > limit
        next_cursor = (
            encode_cursor(page[-1].get("publishedAt") or "", page[-1]["id"])
            if has_more and page
            else None
        )
        return {
            "items": [persona_public(record, with_content=False) for record in page],
            "nextCursor": next_cursor,
        }

    def install_persona(self, username: str, persona_id: str) -> dict[str, Any]:
        with PERSONA_LOCK:
            source = self._find_published(persona_id)
            if source is None:
                raise HTTPException(404, "Persona not found")
            if source["author"] == username:
                return persona_public(source)
            existing = next(
                (
                    record
                    for record in self._own_personas(username)
                    if record.get("installedFrom") == source["id"]
                ),
                None,
            )
            # Idempotent: installing twice returns the copy that already exists,
            # so a double-click or a retry cannot litter the library.
            if existing is not None:
                return persona_public(existing)
            forked = self._insert_persona(
                username,
                {
                    "name": source["name"],
                    "element": source["element"],
                    "tagline": source.get("tagline"),
                    "content": source["content"],
                    "visibility": "private",
                    "installedFrom": source["id"],
                },
            )
            # Counted after the fork is on disk: a lost count is harmless, a lost
            # install is not.
            source["installs"] = source.get("installs", 0) + 1
            self._write_persona(source["author"], source)
            return persona_public(forked)

    # --- papers ---------------------------------------------------------
    def count_active_papers(self, username: str, project_id: str) -> int:
        return sum(
            1
            for paper in self._get_project(username, project_id).get("papers", [])
            if not paper.get("doneAt")
        )

    @serialised
    def add_paper(
        self, username: str, project_id: str, paper: dict[str, Any]
    ) -> dict[str, Any]:
        meta = self._get_project(username, project_id)
        used = {item["slug"] for item in meta.get("papers", [])}
        created = paper.get("createdAt") or utc_now()
        paper = {
            **paper,
            "createdAt": created,
            "lastEngagedAt": paper.get("lastEngagedAt") or created,
            "slug": allocate_route_slug(paper.get("title", ""), "document", used),
            "routeTitle": paper.get("title", ""),
        }
        # Job first, record last: a document nobody can see yet may have a job,
        # but a visible document never lacks the job that files it, nor a
        # partial page the one that finishes it.
        if paper.get("capture") == "partial":
            self._enqueue_memory_job_unlocked(
                username,
                kind="capture",
                marker=capture_marker(paper["id"]),
                payload={"projectId": project_id, "paperId": paper["id"]},
            )
        self._enqueue_memory_job_unlocked(
            username,
            kind="document",
            marker=document_marker(paper["id"]),
            payload={"projectId": project_id, "paperId": paper["id"]},
            target_version=MEMORY_VERSION,
        )
        meta.setdefault("papers", []).append(paper)
        self._save_meta(username, meta)
        return self._public_paper(paper)

    @serialised
    def touch_paper(
        self, username: str, project_id: str, paper_id: str
    ) -> dict[str, Any]:
        meta = self._get_project(username, project_id)
        for paper in meta.get("papers", []):
            if paper["id"] == safe_id(paper_id):
                paper["lastEngagedAt"] = utc_now()
                self._save_meta(username, meta)
                return self._public_paper(paper)
        raise HTTPException(404, "Paper not found")

    def get_paper(
        self, username: str, project_id: str, paper_id: str
    ) -> dict[str, Any]:
        meta = self._get_project(username, project_id)
        paper = next(
            (item for item in meta.get("papers", []) if item["id"] == paper_id), None
        )
        if not paper:
            raise HTTPException(404, "Paper not found")
        return self._public_paper(paper)

    @serialised
    def update_paper_snapshot(
        self, username: str, project_id: str, paper_id: str, fields: dict[str, Any]
    ) -> dict[str, Any]:
        meta = self._get_project(username, project_id)
        for paper in meta.get("papers", []):
            if paper["id"] == paper_id:
                paper.update(fields)
                if "sourceHash" in fields:
                    digest = paper.get("digest") or {}
                    if (
                        digest.get("sourceHash")
                        and digest.get("sourceHash") != fields["sourceHash"]
                    ):
                        paper["digest"] = {
                            "status": "missing",
                            "updatedAt": utc_now(),
                        }
                self._save_meta(username, meta)
                return self._public_paper(paper)
        raise HTTPException(404, "Paper not found")

    @serialised
    def store_linked_pdf(
        self, username: str, project_id: str, paper_id: str, fields: dict[str, Any]
    ) -> dict[str, Any]:
        meta = self._get_project(username, project_id)
        for paper in meta.get("papers", []):
            if paper["id"] != paper_id:
                continue
            paper.update(fields)
            # Dropped rather than left behind: `kind` absent is what a PDF
            # record has always looked like on this backend, and a `favicon` is
            # a live page's chrome. The address moves to the private
            # `sourceUrl`, so the served record is a PDF's exactly.
            paper.pop("kind", None)
            paper.pop("favicon", None)
            source_url = paper.pop("url", None)
            if source_url:
                paper["sourceUrl"] = source_url
            self._save_meta(username, meta)
            return self._public_paper(paper)
        raise HTTPException(404, "Paper not found")

    @serialised
    def rename_paper(
        self, username: str, project_id: str, paper_id: str, title: str
    ) -> dict[str, Any]:
        meta = self._get_project(username, project_id)
        for paper in meta.get("papers", []):
            if paper["id"] == paper_id:
                paper["title"] = title
                used = {
                    item["slug"]
                    for item in meta.get("papers", [])
                    if item["id"] != paper_id
                }
                paper["slug"] = allocate_route_slug(title, "document", used)
                paper["routeTitle"] = title
                self._save_meta(username, meta)
                return self._public_paper(paper)
        raise HTTPException(404, "Paper not found")

    @serialised
    def adopt_paper_title(
        self, username: str, project_id: str, paper_id: str, title: str
    ) -> dict[str, Any] | None:
        wanted = " ".join(title.split())[:PAPER_TITLE_MAX_CHARS]
        meta = self._get_project(username, project_id)
        paper = next((item for item in meta.get("papers", []) if item["id"] == paper_id), None)
        if paper is None:
            raise HTTPException(404, "Paper not found")
        if not wanted or wanted == paper.get("title") or paper.get("title") != initial_title(paper):
            return None
        # The project lock is re-entrant, so the check and the rename are one write.
        return self.rename_paper(username, project_id, paper_id, wanted)

    @serialised
    def reorder_papers(
        self, username: str, project_id: str, paper_ids: list[str]
    ) -> dict[str, Any]:
        meta = self._get_project(username, project_id)
        by_id = {paper["id"]: paper for paper in meta.get("papers", [])}
        meta["papers"] = [by_id[paper_id] for paper_id in paper_ids]
        return self._public_meta(username, self._save_meta(username, meta))

    def _paper_scoped_paths(
        self, username: str, project_id: str, paper_id: str
    ) -> list[Path]:
        """
        Everything filed under one paper inside a project directory.

        Named once because a move and a delete have to agree on the list: the
        way this goes wrong is a new per-paper file that only one of them knows
        about, leaving a moved paper without its highlights or a deleted one
        with an orphaned thread.
        """
        return [
            self._highlights_path(username, project_id, paper_id),
            self._notes_path(username, project_id, paper_id),
            # Chat image sidecars are per conversation, not per paper, and move
            # and delete with each conversation in `move_paper`/`delete_paper`.
            # Derived, but still paper-scoped: left behind, a search hit would
            # name the project the paper just left, and the moved copy would be
            # unfindable until something rebuilt it.
            self._sections_path(username, project_id, paper_id),
        ]

    def move_paper(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        destination_project_id: str,
        position: int | None = None,
    ) -> dict[str, Any]:
        # The one mutation that reads and writes two projects, so it holds both
        # locks — in path order, because two moves in opposite directions taking
        # them in argument order would deadlock on each other.
        with ExitStack() as stack:
            for path in sorted(
                {
                    self._meta_path(username, project_id),
                    self._meta_path(username, destination_project_id),
                }
            ):
                stack.enter_context(_meta_lock(path))
            return self._move_paper(
                username, project_id, paper_id, destination_project_id, position
            )

    def _move_paper(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        destination_project_id: str,
        position: int | None,
    ) -> dict[str, Any]:
        source = self._get_project(username, project_id)
        destination = self._get_project(username, destination_project_id)
        if source["id"] == destination["id"]:
            raise HTTPException(409, "That paper is already in this project")
        paper = next(
            (item for item in source.get("papers", []) if item["id"] == paper_id),
            None,
        )
        if paper is None:
            raise HTTPException(404, "Paper not found")
        # A slug is only unique inside its project, so the same title arriving
        # next to an existing one has to take the "-2".
        paper = {
            **paper,
            "slug": allocate_route_slug(
                paper.get("routeTitle") or paper.get("title", ""),
                "document",
                {item["slug"] for item in destination.get("papers", [])},
            ),
        }
        # There is no transaction spanning two files here, so the order decides
        # what a crash leaves behind. Everything is written into the destination
        # before anything leaves the source: the transient state is a paper
        # visible in two projects with both copies intact, which a reader can
        # act on. The other order loses it outright.
        origins = self._paper_scoped_paths(username, project_id, paper_id)
        targets = self._paper_scoped_paths(
            username, destination_project_id, paper_id
        )
        for origin, target in zip(origins, targets):
            if not origin.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(origin, target)
        landing = destination.setdefault("papers", [])
        # First by default: a move is something the reader just did, and at the
        # end of a full project the result lands off the bottom of the list. A
        # drag overrides it, because it already showed the reader a gap.
        index = 0 if position is None else max(0, min(position, len(landing)))
        landing.insert(index, paper)
        self._update_paper_jobs(username, paper_id, project_id=destination_project_id)
        with CONVERSATION_LOCK:
            for head in self._conversation_heads(username):
                if head.get("projectId") != project_id or head.get("paperId") != paper_id:
                    continue
                conversation = self._read_json(self._conversation_path(username, head["id"]), {})
                images = self._chat_sidecar(username, conversation, "images")
                sequence = self._chat_sidecar(username, conversation, "image-sequence")
                conversation["projectId"] = destination_project_id
                # The route has already copied the bytes to the rehomed keys.
                if images.exists():
                    self._write_json(self._chat_sidecar(username, conversation, "images"), [
                        {**image,
                         "imageKey": rehome_chat_image_key(image["imageKey"], username, project_id, destination_project_id),
                         "thumbnailKey": rehome_chat_image_key(image["thumbnailKey"], username, project_id, destination_project_id)}
                        for image in self._read_json(images, [])
                    ])
                    images.unlink()
                if sequence.exists():
                    self._write_json(self._chat_sidecar(username, conversation, "image-sequence"), self._read_json(sequence, 0))
                    sequence.unlink()
                self._write_json(self._conversation_path(username, conversation["id"]), conversation)
        moved = self._save_meta(username, destination)
        source["papers"] = [
            item for item in source.get("papers", []) if item["id"] != paper_id
        ]
        self._save_meta(username, source)
        for origin in origins:
            origin.unlink(missing_ok=True)
        return self._public_meta(username, moved)

    @serialised
    def delete_paper(
        self, username: str, project_id: str, paper_id: str
    ) -> Removed:
        meta = self._get_project(username, project_id)
        paper = self.get_paper(username, project_id, paper_id)
        meta["papers"] = [
            item for item in meta.get("papers", []) if item["id"] != paper_id
        ]
        self._update_paper_jobs(username, paper_id, delete_jobs=True)
        with CONVERSATION_LOCK:
            for conversation in self._conversation_heads(username):
                if conversation.get("projectId") == project_id and conversation.get("paperId") == paper_id:
                    self._chat_sidecar(username, conversation, "images").unlink(missing_ok=True)
                    self._chat_sidecar(username, conversation, "image-sequence").unlink(missing_ok=True)
                    self._conversation_path(username, conversation["id"]).unlink(missing_ok=True)
        self._save_meta(username, meta)
        for path in self._paper_scoped_paths(username, project_id, paper_id):
            path.unlink(missing_ok=True)
        file_id = paper.get("openaiFileId")
        return Removed(openai_file_ids=[file_id] if file_id else [])

    @serialised
    def set_openai_file(
        self, username: str, project_id: str, paper_id: str, file_id: str
    ) -> None:
        meta = self._get_project(username, project_id)
        for paper in meta.get("papers", []):
            if paper["id"] == paper_id and not paper.get("openaiFileId"):
                paper["openaiFileId"] = file_id
                paper["openaiFileUploadedAt"] = utc_now()
                self._save_meta(username, meta)
                return

    @serialised
    def replace_openai_file(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        expected_file_id: str,
        file_id: str,
    ) -> bool:
        meta = self._get_project(username, project_id)
        for paper in meta.get("papers", []):
            if paper["id"] != paper_id:
                continue
            if paper.get("openaiFileId") != expected_file_id:
                return False
            paper["openaiFileId"] = file_id
            paper["openaiFileUploadedAt"] = utc_now()
            self._save_meta(username, meta)
            return True
        raise HTTPException(404, "Paper not found")

    @serialised
    def set_paper_source_hash(
        self, username: str, project_id: str, paper_id: str, source_hash: str
    ) -> None:
        meta = self._get_project(username, project_id)
        for paper in meta.get("papers", []):
            if paper["id"] == paper_id:
                if paper.get("sourceHash") != source_hash:
                    paper["sourceHash"] = source_hash
                    self._save_meta(username, meta)
                return
        raise HTTPException(404, "Paper not found")

    @serialised
    def set_paper_done(
        self, username: str, project_id: str, paper_id: str, done: bool
    ) -> dict[str, Any]:
        meta = self._get_project(username, project_id)
        for paper in meta.get("papers", []):
            if paper["id"] != paper_id:
                continue
            if done:
                if not paper.get("doneAt"):
                    paper["doneAt"] = utc_now()
            else:
                paper.pop("doneAt", None)
            self._save_meta(username, meta)
            return self._public_paper(paper)
        raise HTTPException(404, "Paper not found")

    @serialised
    def claim_digest(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        *,
        claim_id: str,
        expires_at: str,
        metadata: dict[str, Any],
        force: bool,
    ) -> str:
        meta = self._get_project(username, project_id)
        now = utc_now()
        for paper in meta.get("papers", []):
            if paper["id"] != paper_id:
                continue
            digest = paper.get("digest")
            valid = (
                digest
                and digest.get("status") == "ready"
                and digest.get("sourceHash") == metadata.get("sourceHash")
                and digest.get("version") == metadata.get("version")
                and digest.get("sourceUrl") == metadata.get("sourceUrl")
            )
            if valid and not force:
                return "ready"
            claim = paper.get("digestClaim") or {}
            if claim.get("expiresAt", "") > now:
                return "busy"
            paper["digestClaim"] = {"id": claim_id, "expiresAt": expires_at}
            # Regeneration deliberately leaves the previous card visible.
            # A stale ready digest is still a valid visible card while its
            # replacement is being built. Only a paper with no usable digest
            # should expose pending state. This keeps an interrupted v5→v6
            # regeneration atomic from the reader's point of view.
            if not digest or digest.get("status") != "ready":
                paper["digest"] = {**metadata, "status": "pending", "updatedAt": now}
            self._save_meta(username, meta)
            return "claimed"
        raise HTTPException(404, "Paper not found")

    @serialised
    def complete_digest(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        claim_id: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        meta = self._get_project(username, project_id)
        for paper in meta.get("papers", []):
            if paper["id"] != paper_id:
                continue
            if (paper.get("digestClaim") or {}).get("id") != claim_id:
                raise HTTPException(409, "Digest build claim expired")
            paper["digest"] = metadata
            paper.pop("digestClaim", None)
            self._save_meta(username, meta)
            return self._public_paper(paper)
        raise HTTPException(404, "Paper not found")

    @serialised
    def fail_digest(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        claim_id: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        meta = self._get_project(username, project_id)
        for paper in meta.get("papers", []):
            if paper["id"] != paper_id:
                continue
            if (paper.get("digestClaim") or {}).get("id") != claim_id:
                return self._public_paper(paper)
            paper.pop("digestClaim", None)
            if (paper.get("digest") or {}).get("status") != "ready":
                paper["digest"] = metadata
            self._save_meta(username, meta)
            return self._public_paper(paper)
        raise HTTPException(404, "Paper not found")

    # --- Memory ---------------------------------------------
    # One JSON file per page under the account directory, mirroring how
    # personas are held. Account-scoped by construction: there is no project
    # directory in the path a page could accidentally acquire.
    def _memory_dir(self, username: str) -> Path:
        return self._user_dir(username) / "memory"

    def _memory_graph_meta_path(self, username: str) -> Path:
        return self._memory_dir(username) / "graph.json"

    def memory_graph_revision(self, username: str) -> int:
        if not self.account_exists(username):
            raise HTTPException(404, "Account not found")
        meta = self._read_json(self._memory_graph_meta_path(username), {})
        return int(meta.get("revision") or 0)

    def _bump_memory_graph_unlocked(self, username: str) -> dict[str, Any]:
        updated = {"revision": self.memory_graph_revision(username) + 1}
        self._write_json(self._memory_graph_meta_path(username), updated)
        return updated

    def replace_memory_snapshot(
        self, username: str, snapshot: dict[str, Any], *, max_pages: int
    ) -> None:
        if not self.account_exists(username):
            raise HTTPException(404, "Account not found")
        pages = list(snapshot.get("pages") or [])
        if len(pages) > max_pages:
            raise HTTPException(409, f"Candidate contains more than {max_pages} pages")
        for page in pages:
            check_page_shape(page)
        old_pages = self._memory_pages(username)
        now = utc_now()
        paths = {
            self._domains_path(username),
            self._figures_path(username),
            self._memory_events_path(username),
            self._memory_jobs_path(username),
            self._memory_graph_meta_path(username),
            *(self._memory_path(username, page["slug"]) for page in old_pages),
            *(self._memory_path(username, page["slug"]) for page in pages),
        }
        with PERSONA_LOCK:
            before = {path: path.read_bytes() if path.exists() else None for path in paths}
            # The whole history goes with the wiki it described, as the SQL
            # store's cascade takes it; each candidate page then starts its own.
            versions_root = self._memory_dir(username) / "versions"
            versions_before = self._version_files(
                list(versions_root.iterdir()) if versions_root.is_dir() else []
            )
            try:
                shutil.rmtree(versions_root, ignore_errors=True)
                wanted = {page["slug"] for page in pages}
                for page in old_pages:
                    if page["slug"] not in wanted:
                        self._memory_path(username, page["slug"]).unlink(missing_ok=True)
                for page in pages:
                    record = {
                        key: value
                        for key, value in page.items()
                        if key not in {"figures", "linkDegree", "links", "sourceProjectId"}
                    }
                    record["slug"] = memory_slug(record.get("slug") or "")
                    record["links"] = parse_wiki_links(record.get("body") or "")
                    record["aliases"] = clean_aliases(
                        record.get("aliases"), title=record.get("title") or "", slug=record["slug"]
                    )
                    record["revision"] = max(1, int(record.get("revision") or 1))
                    record["updatedAt"] = record.get("updatedAt") or now
                    self._write_json(self._memory_path(username, page["slug"]), record)
                    self._record_page_version_unlocked(
                        username, record, event_id=None, trigger=None, note=None
                    )
                self._write_json(self._domains_path(username), snapshot.get("domains") or [])
                # Normalised rather than written through: a candidate figure
                # carries whatever the pass that captured it wrote, and the
                # listing sorts on `createdAt`, so one missing field breaks
                # every later read of the wiki rather than this write. The SQL
                # backend stamps the same default and refuses the same unknown
                # page, which is the divergence the contract suite exists for.
                page_ids = {page.get("id") for page in pages}
                figures = []
                for figure in snapshot.get("figures") or []:
                    if figure.get("pageId") not in page_ids:
                        raise HTTPException(
                            422, "Candidate figure names an unknown page"
                        )
                    figures.append({**figure, "createdAt": figure.get("createdAt") or now})
                self._write_json(self._figures_path(username), figures)
                self._write_json(self._memory_events_path(username), snapshot.get("events") or [])
                self._write_json(self._memory_jobs_path(username), [])
                self._bump_memory_graph_unlocked(username)
            except Exception:
                for path, payload in before.items():
                    if payload is None:
                        path.unlink(missing_ok=True)
                    else:
                        self._write_atomic(path, payload.decode("utf-8"))
                shutil.rmtree(versions_root, ignore_errors=True)
                self._restore_version_files([], versions_before)
                raise

    def _memory_jobs_path(self, username: str) -> Path:
        return self._memory_dir(username) / "jobs.json"

    def _read_memory_jobs(self, username: str) -> list[dict[str, Any]]:
        return self._read_json(self._memory_jobs_path(username), [])

    def _enqueue_memory_job_unlocked(
        self,
        username: str,
        *,
        kind: str,
        marker: str,
        payload: dict[str, Any],
        target_version: str | None = None,
        not_before: str | None = None,
    ) -> dict[str, Any]:
        if kind not in MEMORY_JOB_KINDS:
            raise HTTPException(422, "Unknown Memory maintenance job")
        with MEMORY_JOB_LOCK:
            path = self._memory_jobs_path(username)
            jobs = self._read_memory_jobs(username)
            now = utc_now()
            existing = next((job for job in jobs if job["marker"] == marker), None)
            if existing is not None:
                # A waiting or fingerprinted kind refreshes the row it already
                # has: the payload it sends is the current account of what the
                # job covers, and the wait starts again. Why a failed row keeps
                # its own `retryAt`: `Storage.enqueue_memory_job`.
                if not_before is not None or "fingerprint" in payload:
                    existing["payload"] = {**(existing.get("payload") or {}), **payload}
                    if not_before is not None and existing.get("status") in ("pending", "leased"):
                        existing["retryAt"] = not_before
                    existing["updatedAt"] = now
                    self._write_json(path, jobs)
                # One field, never the whole payload: `move_paper` rewrites the
                # provenance of queued work, and an enqueue that replaced the
                # payload would send the job back to the project the document
                # has just left. `kind` is not reconciled either — the marker
                # encodes the reason, so the two cannot disagree.
                if target_version is not None and job_payload_is_upgradeable(
                    existing, now
                ):
                    existing["payload"] = {**(existing.get("payload") or {}), "targetVersion": target_version}
                    existing["updatedAt"] = now
                    self._write_json(path, jobs)
                return dict(existing)
            job = {
                "id": uuid4().hex[:24],
                "kind": kind,
                "marker": marker,
                "status": "pending",
                "payload": {**payload, **({"targetVersion": target_version} if target_version is not None else {})},
                "attempts": 0,
                "leaseExpiresAt": None,
                "retryAt": not_before,
                "lastError": None,
                "createdAt": now,
                "updatedAt": now,
            }
            jobs.append(job)
            self._write_json(path, jobs)
            return dict(job)

    def _hold_session(self, username: str, **change: Any) -> None:
        """Enqueue or refresh the session job one change belongs to (`sessions.session_job`)."""
        self._enqueue_memory_job_unlocked(
            username,
            **session_job(idle_seconds=self.session_idle_seconds, **change),
            target_version=MEMORY_VERSION,
        )

    def enqueue_memory_job(
        self,
        username: str,
        *,
        kind: str,
        marker: str,
        payload: dict[str, Any],
        target_version: str | None = None,
        not_before: str | None = None,
    ) -> dict[str, Any]:
        if not self.account_exists(username):
            raise HTTPException(404, "Account not found")
        return self._enqueue_memory_job_unlocked(
            username,
            kind=kind,
            marker=marker,
            payload=payload,
            target_version=target_version,
            not_before=not_before,
        )

    def list_memory_jobs(self, username: str) -> list[dict[str, Any]]:
        if not self.account_exists(username):
            raise HTTPException(404, "Account not found")
        with MEMORY_JOB_LOCK:
            jobs = self._read_memory_jobs(username)
            return sorted(
                (dict(job) for job in jobs),
                key=lambda job: (job.get("createdAt") or "", job["id"]),
            )

    def claim_memory_job(
        self,
        username: str,
        *,
        now: str,
        lease_expires_at: str,
        max_attempts: int,
        kinds: Sequence[str] | None = None,
    ) -> dict[str, Any] | None:
        with MEMORY_JOB_LOCK:
            path = self._memory_jobs_path(username)
            jobs = self._read_memory_jobs(username)
            wanted = (
                (lambda kind: kind not in CAPTURE_JOB_KINDS) if kinds is None
                else (lambda kind: kind in kinds)
            )
            # Least-attempted first, then oldest — the same order the SQL
            # backend claims in, and the property the contract suite asserts.
            ordered = sorted(
                jobs,
                key=lambda job: (
                    0 if job.get("kind") in DOCUMENT_JOB_KINDS else 1,
                    int(job.get("attempts") or 0),
                    job.get("createdAt") or "",
                    job["id"],
                ),
            )
            claimed: dict[str, Any] | None = None
            dirty = False
            for job in ordered:
                if not wanted(job.get("kind")) or not job_is_due(job, now) or waits_for_capture(job, jobs):
                    continue
                attempts = int(job.get("attempts") or 0)
                if attempts >= max_attempts:
                    job.update(
                        status="failed",
                        retryAt=None,
                        leaseExpiresAt=None,
                        lastError=abandoned_job_error(attempts),
                        updatedAt=now,
                    )
                    _record_attempt(job, {"rejection": job["lastError"], "abandoned": True}, now)
                    dirty = True
                    continue
                job.update(
                    status="leased",
                    attempts=attempts + 1,
                    leaseExpiresAt=lease_expires_at,
                    retryAt=None,
                    updatedAt=now,
                )
                claimed = dict(job)
                dirty = True
                break
            if dirty:
                self._write_json(path, jobs)
            return claimed

    def complete_memory_job(
        self,
        username: str,
        job_id: str,
        *,
        expected_lease_expires_at: str | None = None,
        fingerprint: str | None = None,
    ) -> bool:
        with MEMORY_JOB_LOCK:
            path = self._memory_jobs_path(username)
            jobs = self._read_memory_jobs(username)
            job = next((item for item in jobs if item["id"] == safe_id(job_id)), None)
            if job is None:
                return True
            if (
                expected_lease_expires_at is not None
                and job.get("leaseExpiresAt") != expected_lease_expires_at
            ):
                return False
            if job_fingerprint_moved(job, fingerprint):
                job.update(
                    status="pending",
                    attempts=0,
                    leaseExpiresAt=None,
                    lastError=None,
                    updatedAt=utc_now(),
                )
                self._write_json(path, jobs)
                return False
            self._write_json(
                path, [item for item in jobs if item["id"] != safe_id(job_id)]
            )
            return True

    def release_memory_jobs(
        self, username: str, *, kind: str | None = None, marker: str | None = None
    ) -> int:
        if not self.account_exists(username):
            raise HTTPException(404, "Account not found")
        with MEMORY_JOB_LOCK:
            path = self._memory_jobs_path(username)
            jobs = self._read_memory_jobs(username)
            now = utc_now()
            released = 0
            for job in jobs:
                if (
                    job.get("status") in ("pending", "leased")
                    and job.get("retryAt") is not None
                    and (kind is None or job.get("kind") == kind)
                    and (marker is None or job.get("marker") == marker)
                ):
                    job.update(retryAt=None, updatedAt=now)
                    released += 1
            if released:
                self._write_json(path, jobs)
            return released

    def renew_memory_job_lease(
        self,
        username: str,
        job_id: str,
        *,
        expected_lease_expires_at: str,
        lease_expires_at: str,
    ) -> bool:
        with MEMORY_JOB_LOCK:
            path = self._memory_jobs_path(username)
            jobs = self._read_memory_jobs(username)
            job = next((item for item in jobs if item["id"] == job_id), None)
            if (
                job is None
                or job.get("status") != "leased"
                or job.get("leaseExpiresAt") != expected_lease_expires_at
            ):
                return False
            job["leaseExpiresAt"] = lease_expires_at
            job["updatedAt"] = utc_now()
            self._write_json(path, jobs)
            return True

    def fail_memory_job(
        self,
        username: str,
        job_id: str,
        *,
        error: str,
        retry_at: str | None,
        diagnostics: dict[str, Any] | None = None,
        expected_lease_expires_at: str | None = None,
    ) -> dict[str, Any]:
        with MEMORY_JOB_LOCK:
            path = self._memory_jobs_path(username)
            jobs = self._read_memory_jobs(username)
            job = next((item for item in jobs if item["id"] == safe_id(job_id)), None)
            if job is None:
                raise HTTPException(404, "Memory maintenance job not found")
            if (
                expected_lease_expires_at is not None
                and job.get("leaseExpiresAt") != expected_lease_expires_at
            ):
                return dict(job)
            now = utc_now()
            job.update(
                status="failed",
                retryAt=retry_at,
                leaseExpiresAt=None,
                lastError=error[:2000],
                updatedAt=now,
            )
            _record_attempt(job, {"rejection": error[:800], **(diagnostics or {})}, now)
            self._write_json(path, jobs)
            return dict(job)

    def release_memory_job(
        self, username: str, job_id: str, *, expected_lease_expires_at: str | None = None
    ) -> None:
        with MEMORY_JOB_LOCK:
            path = self._memory_jobs_path(username)
            jobs = self._read_memory_jobs(username)
            job = next((item for item in jobs if item["id"] == safe_id(job_id)), None)
            if job is None or job.get("status") != "leased":
                return
            if (
                expected_lease_expires_at is not None
                and job.get("leaseExpiresAt") != expected_lease_expires_at
            ):
                return
            job.update(
                status="pending",
                attempts=max(0, int(job.get("attempts") or 1) - 1),
                leaseExpiresAt=None,
                updatedAt=utc_now(),
            )
            self._write_json(path, jobs)

    def retry_memory_job(self, username: str, job_id: str) -> dict[str, Any]:
        with MEMORY_JOB_LOCK:
            path = self._memory_jobs_path(username)
            jobs = self._read_memory_jobs(username)
            job = next((item for item in jobs if item["id"] == safe_id(job_id)), None)
            if job is None:
                raise HTTPException(404, "Memory maintenance job not found")
            if job.get("status") != "failed":
                raise HTTPException(409, "Only a failed job can be retried")
            job.update(
                status="pending",
                attempts=0,
                retryAt=None,
                leaseExpiresAt=None,
                lastError=None,
                updatedAt=utc_now(),
            )
            self._write_json(path, jobs)
            return dict(job)

    def clear_memory_job(self, username: str, marker: str) -> None:
        with MEMORY_JOB_LOCK:
            path = self._memory_jobs_path(username)
            jobs = self._read_memory_jobs(username)
            self._write_json(
                path, [job for job in jobs if job["marker"] != marker]
            )

    def cancel_memory_jobs(self, username: str, *, kinds: Sequence[str]) -> int:
        if not kinds:
            return 0
        if not self.account_exists(username):
            raise HTTPException(404, "Account not found")
        wanted = set(kinds)

        def is_future_spend(job: dict[str, Any]) -> bool:
            if job["kind"] not in wanted:
                return False
            # A leased row is the document being written this second, and most
            # of its cost is still ahead of it — the drain notices the row is
            # gone at the next stage boundary and stands down before paying for
            # another call.
            if job["status"] in ("pending", "leased"):
                return True
            # Still owed, and still going to spend. A failure that has given up
            # carries no `retryAt` and is left where it is: nothing will run it
            # again, and its error is the only record of why.
            return job["status"] == "failed" and job.get("retryAt") is not None

        with MEMORY_JOB_LOCK:
            path = self._memory_jobs_path(username)
            jobs = self._read_memory_jobs(username)
            keep = [job for job in jobs if not is_future_spend(job)]
            if len(keep) != len(jobs):
                self._write_json(path, keep)
            return len(jobs) - len(keep)

    def memory_job_exists(self, username: str, job_id: str) -> bool:
        with MEMORY_JOB_LOCK:
            jobs = self._read_memory_jobs(username)
            return any(job["id"] == safe_id(job_id) for job in jobs)

    def _update_paper_jobs(
        self,
        username: str,
        paper_id: str,
        *,
        project_id: str | None = None,
        delete_jobs: bool = False,
    ) -> None:
        with MEMORY_JOB_LOCK:
            path = self._memory_jobs_path(username)
            jobs = self._read_memory_jobs(username)
            if delete_jobs:
                jobs = [
                    job
                    for job in jobs
                    if job.get("payload", {}).get("paperId") != paper_id
                ]
            elif project_id is not None:
                for job in jobs:
                    if job.get("payload", {}).get("paperId") == paper_id:
                        job["payload"] = {**job["payload"], "projectId": project_id}
            self._write_json(path, jobs)

    def _delete_project_jobs(
        self, username: str, project_id: str, *, thread_key: str | None = None,
        conversation_id: str | None = None,
    ) -> None:
        with MEMORY_JOB_LOCK:
            path = self._memory_jobs_path(username)
            jobs = self._read_memory_jobs(username)
            self._write_json(
                path,
                [
                    job
                    for job in jobs
                    if not (
                        job.get("payload", {}).get("projectId") == project_id
                        and (
                            thread_key is None
                            or job.get("payload", {}).get("threadKey") == thread_key
                            or (
                                conversation_id is not None
                                and job.get("payload", {}).get("conversationId") == conversation_id
                            )
                        )
                    )
                ],
            )

    def _memory_path(self, username: str, slug: str) -> Path:
        # A slug reaches the filesystem, so it goes through the same alphabet
        # every other route does before it names a file.
        clean = memory_slug(slug)
        if not clean:
            raise HTTPException(404, "Memory page not found")
        # Pages get their own directory rather than sharing one with the log,
        # the thread and the figure index. The alternative is a filename
        # denylist, and a denylist is one file away from reading a sidecar as
        # a page — which is a crash, not a missing row.
        return self._memory_dir(username) / "pages" / f"{clean}.json"

    def _memory_pages(self, username: str) -> list[dict[str, Any]]:
        directory = self._memory_dir(username) / "pages"
        if not directory.exists():
            return []
        # A page is named for its own slug, and the file that disagrees is
        # not a page. macOS iCloud Drive resolves a conflict on a file it is
        # mid-upload by *keeping both* under a " 2" suffix, and `os.replace`
        # in `_write_atomic` is exactly that conflict — so a staging run held
        # under a synced folder grew "slug 2.json" beside "slug.json", and the
        # directory walk read the stranded older copy as a second page with
        # the same slug and a different id. One slug, one file, one record;
        # anything else here is somebody else's copy of ours.
        pages = [
            current_page(page)
            for entry in directory.iterdir()
            if entry.suffix == ".json"
            for page in (self._read_json(entry, None),)
            if page and page.get("slug") == entry.stem
        ]
        pages.sort(
            key=lambda page: (page.get("updatedAt") or "", page["id"]), reverse=True
        )
        return pages

    def _memory_degrees(self, username: str) -> dict[str, int]:
        degrees: dict[str, int] = {}
        for page in self._memory_pages(username):
            links = page.get("links") or []
            degrees[page["slug"]] = degrees.get(page["slug"], 0) + len(links)
            for target in links:
                degrees[target] = degrees.get(target, 0) + 1
        return degrees

    @staticmethod
    def _memory_summary(page: dict[str, Any], degree: int = 0) -> dict[str, Any]:
        """A page without its body, its citations or its figures."""
        return {
            **{
                key: value
                for key, value in page.items()
                if key not in {"body", "citations", "figures", "links"}
            },
            "aliases": list(page.get("aliases") or ()),
            "linkDegree": degree,
        }

    def list_memory_pages(
        self,
        username: str,
        *,
        kinds: list[str] | None = None,
        domains: list[str] | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        degrees = self._memory_degrees(username)
        selected = [
            page
            for page in self._memory_pages(username)
            if (not kinds or page["kind"] in kinds)
            and (not domains or page["domain"] in domains)
        ]
        return [
            self._memory_summary(page, degrees.get(page["slug"], 0))
            for page in selected[:limit]
        ]

    def get_memory_page(self, username: str, slug: str) -> dict[str, Any]:
        page = self._read_json(self._memory_path(username, slug), None)
        if page is None:
            raise HTTPException(404, "Memory page not found")
        return {
            **current_page(page),
            "aliases": list(page.get("aliases") or ()),
            "linkDegree": self._memory_degrees(username).get(page["slug"], 0),
            "figures": self.list_memory_figures(username, page_id=page["id"]),
        }

    def _page_versions_dir(self, username: str, slug: str) -> Path:
        # Beside `pages/`, not inside it: `_memory_pages` reads that
        # directory as one record per file.
        return self._memory_dir(username) / "versions" / memory_slug(slug)

    @staticmethod
    def _version_files(directories: list[Path]) -> dict[Path, bytes]:
        """Every file under these version directories, for a rollback to restore."""
        return {
            entry: entry.read_bytes()
            for directory in directories
            if directory.is_dir()
            for entry in directory.iterdir()
            if entry.is_file()
        }

    def _restore_version_files(self, directories: list[Path], before: dict[Path, bytes]) -> None:
        for directory in directories:
            if directory.is_dir():
                for entry in directory.iterdir():
                    if entry.is_file() and entry not in before:
                        entry.unlink(missing_ok=True)
        for entry, payload in before.items():
            self._write_atomic(entry, payload.decode("utf-8"))

    def _page_versions(self, username: str, slug: str) -> list[dict[str, Any]]:
        directory = self._page_versions_dir(username, slug)
        if not memory_slug(slug) or not directory.is_dir():
            return []
        # A file is named for its revision, and one that is not is somebody
        # else's copy of ours: the same iCloud " 2" duplicate `_memory_pages`
        # refuses to read as a second page.
        rows = [
            row
            for entry in directory.iterdir()
            if entry.suffix == ".json" and entry.stem.isdigit()
            for row in (self._read_json(entry, None),)
            if row and row.get("revision") == int(entry.stem)
        ]
        rows.sort(key=lambda row: row["revision"], reverse=True)
        return rows

    def _record_page_version_unlocked(
        self,
        username: str,
        record: dict[str, Any],
        *,
        event_id: str | None,
        trigger: str | None,
        note: str | None,
    ) -> None:
        """Keep this revision of a concept or domain page, and the newest twenty."""
        if record.get("kind") not in VERSIONED_KINDS:
            return
        directory = self._page_versions_dir(username, record["slug"])
        row = page_version(record, event_id=event_id, trigger=trigger, note=note)
        self._write_json(directory / f"{row['revision']:08d}.json", row)
        for stale in self._page_versions(username, record["slug"])[VERSIONS_KEPT:]:
            (directory / f"{stale['revision']:08d}.json").unlink(missing_ok=True)

    def _delete_page_versions_unlocked(self, username: str, slug: str) -> None:
        shutil.rmtree(self._page_versions_dir(username, slug), ignore_errors=True)

    def list_page_versions(self, username: str, slug: str) -> list[dict[str, Any]]:
        with PERSONA_LOCK:
            return self._page_versions(username, slug)

    def page_history(
        self, username: str, slugs: Sequence[str]
    ) -> dict[str, dict[str, dict[str, Any] | None]]:
        with PERSONA_LOCK:
            return {
                slug: page_history_entry(self._page_versions(username, slug))
                for slug in slugs
            }

    def upsert_memory_page(
        self,
        username: str,
        page: dict[str, Any],
        *,
        max_pages: int,
        trigger: str | None = None,
        note: str | None = None,
    ) -> dict[str, Any]:
        return self._write_memory_page(
            username, page, max_pages=max_pages, trigger=trigger, note=note
        )

    def _write_memory_page(
        self,
        username: str,
        page: dict[str, Any],
        *,
        max_pages: int,
        trigger: str | None,
        note: str | None,
        event_id: str | None = None,
        require_revision: bool = False,
    ) -> dict[str, Any]:
        check_version_trigger(trigger)
        check_page_shape(page)
        slug = memory_slug(page.get("slug") or page.get("title", ""))
        if not slug:
            raise HTTPException(422, "A Memory page needs a title")
        if not self.account_exists(username):
            raise HTTPException(404, "Account not found")
        # The domain is written before the page that claims it, so no page can
        # exist in a domain that does not — bytes-first ordering applied to a
        # reference. The re-entrant lock also lets a complete Memory
        # publication hold one account-local boundary around every record.
        domain = memory_slug(page.get("domain", "")) or "general"
        with PERSONA_LOCK:
            path = self._memory_path(username, slug)
            existing = self._read_json(path, None)
            check_expected_revision(page, existing, required=require_revision)
            now = utc_now()
            if existing is None:
                if len(self._memory_pages(username)) >= max_pages:
                    raise HTTPException(
                        409,
                        f"Your Memory is holding its maximum of "
                        f"{max_pages} pages",
                    )
                # Only after the capacity check: a refused page must not leave
                # an empty domain or publish a graph revision.  The lock is
                # re-entrant, so the reference and page still form one local
                # critical section.
                self.upsert_memory_domain(username, {"slug": domain})
                existing = {
                    "id": uuid4().hex[:24],
                    "slug": slug,
                    "createdAt": now,
                    "revision": 0,
                }
            elif not any(
                record["slug"] == domain
                for record in self._memory_domain_records(username)
            ):
                self.upsert_memory_domain(username, {"slug": domain})
            body = page.get("body", "")
            record = {
                **existing,
                "kind": page["kind"],
                "domain": domain,
                "title": page["title"],
                "summary": page.get("summary", ""),
                "body": body,
                "tags": page.get("tags") or [],
                # Kept when the write does not name them, as provenance is: a
                # pass that never read the aliases has not decided to drop them.
                "aliases": clean_aliases(
                    page["aliases"] if "aliases" in page else existing.get("aliases"),
                    title=page["title"],
                    slug=slug,
                ),
                "citations": page.get("citations") or [],
                # Rebuilt from the body every write, so a page and its edges can
                # never disagree about what it points at.
                "links": parse_wiki_links(body),
                "revision": existing["revision"] + 1,
                "updatedAt": now,
            }
            # Provenance is kept when omitted: a lint or domain pass writes no
            # `sourcePaperId` because it has none to offer, not because the
            # page stopped being that document's — and clearing it is how a
            # source page becomes invisible to the Reader rail, which finds it
            # by `sourcePaperId`, and to the refile that reuses its slug.
            if page.get("sourcePaperId"):
                record["sourcePaperId"] = page["sourcePaperId"]
            record = current_page(record)
            # Queued before the write, so the work exists before the change
            # that needs it is visible.
            self._queue_domain_compositions_unlocked(username, domains_owed(existing, record))
            self._write_json(path, record)
            self._record_page_version_unlocked(
                username, record, event_id=event_id, trigger=trigger, note=note
            )
            self._bump_memory_graph_unlocked(username)
            return {**record, "linkDegree": 0, "figures": []}

    def delete_memory_page(self, username: str, slug: str) -> Removed:
        with PERSONA_LOCK:
            page = self._read_json(self._memory_path(username, slug), None)
            if page is None:
                raise HTTPException(404, "Memory page not found")
            now = utc_now()
            for holder in self._memory_pages(username):
                if holder["slug"] == page["slug"] or page["slug"] not in (holder.get("links") or []):
                    continue
                body = unlink_deleted_page(holder.get("body") or "", page["slug"], page["title"])
                if body == (holder.get("body") or ""):
                    continue
                record = {
                    **holder,
                    "body": body,
                    "links": parse_wiki_links(body),
                    "revision": holder["revision"] + 1,
                    "updatedAt": now,
                }
                self._write_json(self._memory_path(username, holder["slug"]), record)
                self._record_page_version_unlocked(
                    username, record, event_id=None, trigger=None, note=LINK_REPAIR_NOTE
                )
            figures = self.list_memory_figures(username, page_id=page["id"])
            remaining = [
                figure
                for figure in self._read_json(self._figures_path(username), [])
                if figure["pageId"] != page["id"]
            ]
            self._write_json(self._figures_path(username), remaining)
            # A member is gone from its domain. Deleting a domain's own page
            # owes nothing: the reader removed it, and it is not written back.
            if not (page.get("kind") == "domain" and page.get("slug") == page.get("domain")):
                self._queue_domain_compositions_unlocked(username, [page.get("domain")])
            self._memory_path(username, slug).unlink(missing_ok=True)
            self._delete_page_versions_unlocked(username, page["slug"])
            self._bump_memory_graph_unlocked(username)
            return Removed(
                object_keys=[
                    key
                    for figure in figures
                    if (key := figure.get("objectKey"))
                ]
            )

    def search_memory_pages(
        self,
        username: str,
        query: str,
        *,
        domain: str | None = None,
        limit: int = 12,
    ) -> list[dict[str, Any]]:
        terms = retrieval_terms(query)
        if not terms:
            return []
        degrees = self._memory_degrees(username)
        hits = []
        for page in self._memory_pages(username):
            if domain and page["domain"] != domain:
                continue
            score = lexical_score(terms, page)
            if score <= 0:
                continue
            hits.append(
                {
                    **self._memory_summary(page, degrees.get(page["slug"], 0)),
                    "score": score,
                }
            )
        hits.sort(key=lambda hit: (-hit["score"], hit["slug"]))
        return hits[:limit]

    def memory_page_bodies(self, username: str) -> dict[str, str]:
        return {
            page["slug"]: page.get("body") or ""
            for page in self._memory_pages(username)
        }

    def memory_backlinks(self, username: str, slug: str) -> list[dict[str, Any]]:
        target = memory_slug(slug)
        return [
            self._memory_summary(page)
            for page in sorted(
                (
                    page
                    for page in self._memory_pages(username)
                    if target in (page.get("links") or [])
                ),
                key=lambda page: page.get("updatedAt") or "",
                reverse=True,
            )
        ]

    def list_memory_links(self, username: str) -> list[dict[str, str]]:
        return [
            {"from": page["slug"], "to": target}
            for page in sorted(
                self._memory_pages(username), key=lambda item: item["slug"]
            )
            for target in sorted(page.get("links") or [])
        ]

    def _domains_path(self, username: str) -> Path:
        return self._memory_dir(username) / "domains.json"

    def _memory_domain_records(self, username: str) -> list[dict[str, Any]]:
        """
        The stored domains, healed against the pages that actually exist.

        A page whose domain has no row is not an error to raise on a read: the
        rows arrived after the pages did, and a filesystem base can be restored
        from `pages/` alone. Synthesising the missing row here means a listing
        can never omit a domain that has pages in it, which is the one way this
        table could make the wiki look emptier than it is.
        """
        stored = {
            record["slug"]: record
            for record in self._read_json(self._domains_path(username), [])
        }
        for page in self._memory_pages(username):
            slug = page["domain"]
            if slug not in stored:
                stored[slug] = default_domain_record(slug, page.get("createdAt") or utc_now())
        return list(stored.values())

    def memory_domains(self, username: str) -> list[dict[str, Any]]:
        counts: dict[str, int] = {}
        for page in self._memory_pages(username):
            counts[page["domain"]] = counts.get(page["domain"], 0) + 1
        records = self._memory_domain_records(username)
        return [
            {**record, "domain": record["slug"], "pages": counts.get(record["slug"], 0)}
            # Reader order first, then the fullest domain, then the name. Position
            # defaults to 0 for everything the model named, so an untouched base
            # sorts exactly as it did before this table existed.
            for record in sorted(
                records,
                key=lambda item: (
                    item.get("position", 0),
                    -counts.get(item["slug"], 0),
                    item["slug"],
                ),
            )
        ]

    def _queue_domain_compositions_unlocked(self, username: str, slugs: list[str]) -> None:
        """Queue one composition per domain whose membership, member summaries or name just moved."""
        for slug in dict.fromkeys(slug for slug in slugs if slug):
            self._enqueue_memory_job_unlocked(
                username, **domain_job(slug, settle_seconds=self.domain_settle_seconds)
            )

    def upsert_memory_domain(
        self, username: str, domain: dict[str, Any]
    ) -> dict[str, Any]:
        slug = memory_slug(domain.get("slug") or domain.get("title", ""))
        if not slug:
            raise HTTPException(422, "A domain needs a name")
        if not self.account_exists(username):
            raise HTTPException(404, "Account not found")
        with PERSONA_LOCK:
            records = self._memory_domain_records(username)
            by_slug = {record["slug"]: record for record in records}
            now = utc_now()
            prior = by_slug.get(slug)
            existing = prior or default_domain_record(slug, now)
            record = {
                **existing,
                "slug": slug,
                "title": domain.get("title") or existing["title"],
                "summary": domain.get("summary", existing.get("summary")) or None,
                # Never downgrades: an ingest naming a domain the reader created
                # must not take it back off them.
                "origin": (
                    "reader"
                    if "reader" in (existing.get("origin"), domain.get("origin"))
                    else "model"
                ),
                "position": (
                    domain["position"]
                    if isinstance(domain.get("position"), int)
                    else existing.get("position", 0)
                ),
                "updatedAt": now,
            }
            by_slug[slug] = record
            # A new domain has no domain page yet and a renamed one has a domain page framed
            # under the name it used to have. Queued before the write, so the
            # work exists before the change that needs it is visible.
            if prior is None or prior.get("title") != record["title"]:
                self._queue_domain_compositions_unlocked(username, [slug])
            self._write_json(self._domains_path(username), list(by_slug.values()))
            self._bump_memory_graph_unlocked(username)
            return record

    def delete_memory_domain(self, username: str, slug: str) -> None:
        target = memory_slug(slug)
        with PERSONA_LOCK:
            records = self._memory_domain_records(username)
            if not any(record["slug"] == target for record in records):
                raise HTTPException(404, "Domain not found")
            held = [
                page
                for page in self._memory_pages(username)
                if page["domain"] == target
            ]
            # A domain's own page describes pages that have all been moved
            # out, so it goes with the domain. A domain that was never
            # composed has none, and there is nothing to drop.
            non_domain = [
                page
                for page in held
                if not (
                    page.get("kind") == "domain"
                    and page.get("slug") == target
                    and page.get("domain") == target
                )
            ]
            if non_domain:
                raise HTTPException(
                    409,
                    f"{len(non_domain)} page{'' if len(non_domain) == 1 else 's'} still sit "
                    "in this domain; move them somewhere else first",
                )
            if any(page.get("slug") == target for page in held):
                domain_page = next(page for page in held if page.get("slug") == target)
                remaining = [
                    figure
                    for figure in self._read_json(self._figures_path(username), [])
                    if figure.get("pageId") != domain_page.get("id")
                ]
                self._write_json(self._figures_path(username), remaining)
                self._memory_path(username, target).unlink(missing_ok=True)
                self._delete_page_versions_unlocked(username, target)
            # Only once the delete is certain to happen: a 404 or the 409 above
            # leaves the domain standing, and its queued domain rewrite with it.
            self.clear_memory_job(username, domain_job_marker(target))
            self._write_json(
                self._domains_path(username),
                [record for record in records if record["slug"] != target],
            )
            self._bump_memory_graph_unlocked(username)

    def move_memory_pages(
        self, username: str, slugs: list[str], domain: str
    ) -> list[dict[str, Any]]:
        target = memory_slug(domain)
        if not target:
            raise HTTPException(422, "A move needs a domain to move into")
        # Outside the lock, and before anything is written: the domain has to
        # exist before a page claims it, or a failed move leaves pages pointing
        # at nothing.
        self.upsert_memory_domain(username, {"slug": target})
        moved: list[dict[str, Any]] = []
        with PERSONA_LOCK:
            degrees = self._memory_degrees(username)
            # Read every page before writing any of them. A missing slug used
            # to raise partway through, leaving the pages before it re-filed
            # and the pages after it where they were — half of one decision.
            pending: list[tuple[Path, dict[str, Any]]] = []
            for slug in slugs:
                path = self._memory_path(username, memory_slug(slug))
                page = self._read_json(path, None)
                if page is None:
                    raise HTTPException(404, f"No page at {slug}")
                pending.append((path, page))
            # Both ends of the move: the domain gaining pages and every domain
            # losing one describe a membership that is about to be wrong.
            self._queue_domain_compositions_unlocked(
                username, [target, *(page.get("domain") for _, page in pending)]
            )
            for path, page in pending:
                record = {**current_page(page), "domain": target, "updatedAt": utc_now()}
                self._write_json(path, record)
                moved.append(
                    self._memory_summary(record, degrees.get(record["slug"], 0))
                )
            if pending:
                self._bump_memory_graph_unlocked(username)
        return moved

    def _figures_path(self, username: str) -> Path:
        return self._memory_dir(username) / "figures.json"

    def _evidence_path(self, username: str) -> Path:
        return self._memory_dir(username) / "evidence.json"

    def put_external_evidence(self, username: str, record: dict[str, Any]) -> dict[str, Any]:
        with PERSONA_LOCK:
            if not self.account_exists(username):
                raise HTTPException(404, "Account not found")
            stored = self._read_json(self._evidence_path(username), [])
            kept = external_evidence_record(
                record, object_key=external_evidence_key(username, record["id"])
            )
            if any(item["id"] == kept["id"] for item in stored):
                raise HTTPException(409, "That evidence has already been captured")
            self._write_json(self._evidence_path(username), [*stored, kept])
            return kept

    def get_external_evidence(self, username: str, evidence_id: str) -> dict[str, Any]:
        for item in self._read_json(self._evidence_path(username), []):
            if item["id"] == safe_id(evidence_id):
                return item
        raise HTTPException(404, "Evidence not found")

    def external_evidence_references(self, username: str) -> dict[str, list[dict[str, str]]]:
        papers = [
            paper
            for project in self.list_projects_with_papers(username)
            for paper in project.get("papers") or ()
        ]
        return evidence_holders(papers, self._memory_pages(username))

    def note_citations(self, username: str, paper_id: str) -> dict[str, list[str]]:
        if not self.account_exists(username):
            raise HTTPException(404, "Account not found")
        return note_holders(self._memory_pages(username), paper_id)

    def delete_unreferenced_external_evidence(
        self, username: str, *, older_than_seconds: int
    ) -> list[str]:
        with PERSONA_LOCK:
            cited = self.external_evidence_references(username)
            cutoff = datetime.now(UTC) - timedelta(seconds=older_than_seconds)
            stored = self._read_json(self._evidence_path(username), [])
            gone = [
                item for item in stored
                if item["id"] not in cited and datetime.fromisoformat(item["capturedAt"]) <= cutoff
            ]
            if gone:
                removed = {item["id"] for item in gone}
                self._write_json(
                    self._evidence_path(username),
                    [item for item in stored if item["id"] not in removed],
                )
            return [item["objectKey"] for item in gone]

    def add_memory_figure(
        self, username: str, figure: dict[str, Any], *, max_per_page: int
    ) -> dict[str, Any]:
        with PERSONA_LOCK:
            page = self._read_json(
                self._memory_path(username, figure["pageSlug"]), None
            )
            if page is None:
                raise HTTPException(404, "Memory page not found")
            figures = self._read_json(self._figures_path(username), [])
            if sum(1 for item in figures if item["pageId"] == page["id"]) >= max_per_page:
                raise HTTPException(409, f"A page may hold {max_per_page} figures")
            record = {
                "id": figure["id"],
                "pageId": page["id"],
                "caption": figure.get("caption", ""),
                "alt": figure.get("alt"),
                "origin": figure.get("origin") or {},
                "width": figure.get("width", 0),
                "height": figure.get("height", 0),
                "bytes": figure.get("bytes", 0),
                "kind": figure.get("kind") or "source-figure",
                "provenance": figure.get("provenance") or figure.get("origin") or {},
                "mimeType": figure.get("mimeType") or "image/webp",
                "skillVersion": figure.get("skillVersion"),
                "createdAt": utc_now(),
                "captured": bool(figure.get("objectKey")),
            }
            if figure.get("objectKey"):
                record["objectKey"] = figure["objectKey"]
            if figure.get("sourceUrl"):
                record["sourceUrl"] = figure["sourceUrl"]
            figures.append(record)
            self._write_json(self._figures_path(username), figures)
            return record

    def _supersede_page_figures_unlocked(
        self, username: str, page_ids: list[str]
    ) -> list[str]:
        """Drop the figure rows of every page this filing rewrites.

        A page's body is replaced wholesale, so rows keyed to it cannot be
        additive. They were, and it broke two ways at once. The quiet way:
        a refile regenerates the same pictures under fresh ids, so a document
        filed twice left the first pass's rows behind pointing at prose that
        no longer embeds them -- 63 duplicate rows across one real 47-document
        library, every picture stored and paid for twice. The loud way: the
        per-page ceiling counts rows, not pictures, so a page holding four of
        its six allowed figures could never be filed again -- the second pass
        appended four more, hit 409 partway through, and every retry
        reproduced it byte for byte until the job gave up. Twenty-two of that
        library's forty-seven source pages were already past that line.

        Returns the object keys nothing references any more. The bytes are
        dropped *after* publication, never before: invariant 7 says an
        unreferenced object is reapable while a row pointing at bytes that are
        gone is a broken page, and that argument does not change direction
        just because the write is a delete.
        """
        wanted = set(page_ids)
        figures = self._read_json(self._figures_path(username), [])
        kept = [figure for figure in figures if figure["pageId"] not in wanted]
        if len(kept) == len(figures):
            return []
        dropped = [figure for figure in figures if figure["pageId"] in wanted]
        self._write_json(self._figures_path(username), kept)
        return [key for figure in dropped if (key := figure.get("objectKey"))]

    def commit_memory_update(
        self,
        username: str,
        *,
        pages: list[dict[str, Any]],
        figures: list[dict[str, Any]],
        event: dict[str, Any],
        max_pages: int,
        max_figures_per_page: int,
        fence_job: tuple[str, int] | None = None,
        require_revision: bool = False,
        trigger: str | None = None,
    ) -> dict[str, Any]:
        """Publish one filing as a rollback-safe local transaction."""
        check_version_trigger(trigger)
        for page in pages:
            check_page_shape(page)
        # Chosen before the pages are written, so each page's version row can
        # name the event that is appended after them.
        event = {**event, "id": event.get("id") or uuid4().hex}
        version_dirs = [self._page_versions_dir(username, page["slug"]) for page in pages]
        paths = {
            self._domains_path(username),
            self._figures_path(username),
            self._memory_events_path(username),
            self._memory_jobs_path(username),
            self._memory_graph_meta_path(username),
            *(self._memory_path(username, page["slug"]) for page in pages),
        }
        with PERSONA_LOCK, MEMORY_JOB_LOCK:
            if fence_job is not None:
                jobs = self._read_memory_jobs(username)
                if not any(job.get("id") == fence_job[0] and job.get("attempts") == fence_job[1]
                           and job.get("status") == "leased" for job in jobs):
                    raise MemoryJobGone(fence_job)
            before = {
                path: path.read_bytes() if path.exists() else None for path in paths
            }
            versions_before = self._version_files(version_dirs)
            try:
                protected = {page["slug"] for page in pages} if event.get("kind") == "page-rewrite" else set()
                figures = [figure for figure in figures if figure["pageSlug"] not in protected]
                written = [
                    self._write_memory_page(
                        username,
                        page,
                        max_pages=max_pages,
                        trigger=trigger,
                        note=page.get("_eventNote"),
                        event_id=event["id"],
                        require_revision=require_revision,
                    )
                    for page in pages
                ]
                superseded = self._supersede_page_figures_unlocked(
                    username, [page["id"] for page in written if page["slug"] not in protected]
                )
                stored_figures = [
                    self.add_memory_figure(
                        username,
                        figure,
                        max_per_page=max_figures_per_page,
                    )
                    for figure in figures
                ]
                notes = {page["slug"]: page.get("_eventNote") for page in pages}
                event_body = dict(event)
                event_body.setdefault(
                    "edits",
                    [
                        {
                            "slug": page["slug"],
                            "title": page["title"],
                            "kind": page["kind"],
                            "action": (
                                "created" if page.get("revision") == 1 else "revised"
                            ),
                            "note": notes.get(page["slug"]),
                        }
                        for page in written
                    ],
                )
                stored_event = self.append_memory_event(username, event_body)
                return {
                    "pages": written,
                    "figures": stored_figures,
                    "event": stored_event,
                    "supersededObjectKeys": superseded,
                }
            except Exception:
                for path, payload in before.items():
                    if payload is None:
                        path.unlink(missing_ok=True)
                    else:
                        self._write_atomic(path, payload.decode("utf-8"))
                self._restore_version_files(version_dirs, versions_before)
                raise

    def get_memory_figure(self, username: str, figure_id: str) -> dict[str, Any]:
        record = next(
            (
                figure
                for figure in self._read_json(self._figures_path(username), [])
                if figure["id"] == safe_id(figure_id)
            ),
            None,
        )
        if record is None:
            raise HTTPException(404, "Figure not found")
        return {
            "kind": "source-figure",
            "mimeType": "image/webp",
            "provenance": record.get("origin") or {},
            **record,
        }

    def list_memory_figures(
        self, username: str, *, page_id: str | None = None
    ) -> list[dict[str, Any]]:
        figures = self._read_json(self._figures_path(username), [])
        selected = [
            figure
            for figure in figures
            if page_id is None or figure["pageId"] == page_id
        ]
        selected.sort(key=lambda figure: (figure["createdAt"], figure["id"]))
        return [
            {
                "kind": "source-figure",
                "mimeType": "image/webp",
                "provenance": figure.get("origin") or {},
                **figure,
            }
            for figure in selected
        ]

    def _memory_events_path(self, username: str) -> Path:
        return self._memory_dir(username) / "events.json"

    def append_memory_event(
        self, username: str, event: dict[str, Any]
    ) -> dict[str, Any]:
        if not self.account_exists(username):
            raise HTTPException(404, "Account not found")
        with PERSONA_LOCK:
            path = self._memory_events_path(username)
            events = self._read_json(path, [])
            body = {
                **event,
                "id": event.get("id") or uuid4().hex,
                "createdAt": event.get("createdAt") or utc_now(),
            }
            events.append(body)
            self._write_json(path, events)
            return body

    def list_memory_events(
        self, username: str, *, limit: int = 50
    ) -> list[dict[str, Any]]:
        events = self._read_json(self._memory_events_path(username), [])
        # Append order breaks timestamp ties, matching SQL's increasing event id.
        events.reverse()
        events.sort(key=lambda event: event.get("createdAt") or "", reverse=True)
        return events[:limit]

    def page_events(self, username: str, slug: str) -> list[dict[str, Any]]:
        events = [
            event
            for event in self._read_json(self._memory_events_path(username), [])
            if any(edit.get("slug") == slug for edit in event.get("edits") or ())
        ]
        # A stable sort keeps append order for a tie, as SQL's event id does.
        events.sort(key=lambda event: event.get("createdAt") or "")
        return events

    def get_memory_update(self, username: str) -> dict[str, Any] | None:
        account = self._read_json(self._account_path(username), None)
        if account is None:
            raise HTTPException(404, "Account not found")
        state = account.get("memoryUpdate")
        return dict(state) if isinstance(state, dict) else None

    # Unlocked, like `update_account_preferences` beside it: one account's own
    # progress scratch, where a lost write costs one progress tick and the next
    # one corrects it.
    def set_memory_update(
        self, username: str, state: dict[str, Any] | None
    ) -> dict[str, Any] | None:
        path = self._account_path(username)
        account = self._read_json(path, None)
        if account is None:
            raise HTTPException(404, "Account not found")
        if state is None:
            account.pop("memoryUpdate", None)
        else:
            account["memoryUpdate"] = dict(state)
        self._write_json(path, account)
        return None if state is None else dict(state)

    def has_memory_event(self, username: str, request_id: str, *, operation_id: str | None = None) -> bool:
        events = self._read_json(self._memory_events_path(username), [])
        return any(event.get("requestId") == request_id
                   and (operation_id is None or event.get("operationId") == operation_id)
                   for event in events)

    def memory_event_version(self, username: str, request_id: str) -> str | None:
        return self.memory_event_versions(username, [request_id]).get(request_id)

    def latest_marker_events(
        self, username: str, markers: Sequence[str] | None = None
    ) -> dict[str, dict[str, Any]]:
        wanted = None if markers is None else set(markers)
        if wanted is not None and not wanted:
            return {}
        events = self._read_json(self._memory_events_path(username), [])
        # Append order breaks timestamp ties, matching SQL's increasing event id.
        events.reverse()
        events.sort(key=lambda event: event.get("createdAt") or "", reverse=True)
        found: dict[str, dict[str, Any]] = {}
        for event in events:
            marker = event.get("marker")
            if marker and (wanted is None or marker in wanted):
                found.setdefault(marker, dict(event))
        return found

    def memory_event_versions(
        self, username: str, request_ids: Sequence[str]
    ) -> dict[str, str | None]:
        wanted = set(request_ids)
        if not wanted:
            return {}
        # One read of the log for however many markers were asked about. The
        # singular form used to do this per marker, so a caller walking the
        # library paid a whole-file parse per document per pass.
        events = [
            event
            for event in self._read_json(self._memory_events_path(username), [])
            if event.get("requestId") in wanted
        ]
        # Newest first, so the first entry for a marker wins — the same
        # ordering the SQL backend uses, and the reason a refiled document
        # reports the pass that wrote it most recently rather than first.
        # Append order breaks timestamp ties, matching SQL's increasing event id.
        events.reverse()
        events.sort(key=lambda event: event.get("createdAt") or "", reverse=True)
        found: dict[str, str | None] = {}
        for event in events:
            # `setdefault` on the marker, and the version normalised to None:
            # an event written before the stamp existed is present-but-
            # unversioned, which is "in the wiki, written by something we have
            # replaced" and not "never filed". The key's presence carries that
            # distinction; the value cannot.
            found.setdefault(event["requestId"], event.get("version") or None)
        return found

    def latest_memory_event(
        self, username: str, *, kind: str
    ) -> dict[str, Any] | None:
        events = self._read_json(self._memory_events_path(username), [])
        matching = [event for event in events if event.get("kind") == kind]
        if not matching:
            return None
        matching.sort(key=lambda event: event.get("createdAt") or "", reverse=True)
        return matching[0]

    def append_memory_message(
        self, username: str, message: dict[str, Any], thread_key: str
    ) -> None:
        with CONVERSATION_LOCK:
            thread = self._scope_conversation(username, None, thread_key)
            closing = check_append(thread.get("messages", []), message, thread.get("answering"))
            self._write_turn(username, thread, message, closing)

    def _write_turn(self, username, thread, message, closing):
        """The write both scopes share, after `check_append` has allowed it."""
        held, thread["memoryFiledThrough"] = turn_to_file(
            thread.get("messages", []), message, thread.get("memoryFiledThrough")
        )
        if held:
            # Job first, turn last: a job with nothing to file ends without a
            # trace, and an answer the reader can see never lacks its job.
            self._hold_session(
                username, project_id=thread.get("projectId"), paper_id=thread.get("paperId"),
                conversation_id=thread["id"], request_id=str(message["requestId"]),
            )
        if not thread.get("messages") and not thread.get("manualTitle") and not thread.get("titleModel"):
            thread["title"] = self._fallback_title(message.get("content", ""))
        thread["messages"] = [*thread.get("messages", []), *([closing] if closing else []), message]
        thread["lastEngagedAt"] = message.get("createdAt") or utc_now()
        if message.get("model"):
            thread["lastChatModel"] = message["model"]
        self._write_json(self._conversation_path(username, thread["id"]), thread)

    # --- the raw-layer index --------------------------------------------
    def _sections_path(self, username: str, project_id: str, paper_id: str) -> Path:
        return (
            self._project_dir(username, project_id)
            / "sections"
            / f"{safe_id(paper_id)}.json"
        )

    def list_section_anchors(
        self, username: str, project_id: str
    ) -> dict[str, list[str]]:
        meta = self._get_project(username, project_id)
        anchors: dict[str, list[str]] = {}
        for paper in meta.get("papers", []):
            rows = self._read_json(self._sections_path(username, project_id, paper["id"]), [])
            found = [row["locator"] for row in rows if row.get("kind") == "section"]
            if found:
                anchors[paper["id"]] = found[: self.SECTION_ANCHORS_PER_DOCUMENT]
        return anchors

    @serialised
    def index_document_sections(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        sections: list[dict[str, Any]],
    ) -> int:
        self.get_paper(username, project_id, paper_id)
        path = self._sections_path(username, project_id, paper_id)
        if not sections:
            # An empty index is the absence of a file, not a file holding an
            # empty list: rebuilding then leaves the same bytes on disk whether
            # a document has sections or does not.
            path.unlink(missing_ok=True)
            return 0
        self._write_json(path, sections)
        return len(sections)

    def search_documents(
        self,
        username: str,
        query: str,
        *,
        project_id: str | None = None,
        paper_id: str | None = None,
        limit: int = 12,
    ) -> list[dict[str, Any]]:
        """
        Score every stored section in the account.

        A linear scan, and honestly so: correct for one machine, not a scalable
        query — the same admission the persona marketplace already makes. The
        deployed backend answers this from a GIN index instead, and the shared
        contract suite is what keeps the two answering alike.
        """
        terms = query_terms(query)
        if not terms:
            return []
        if project_id is not None:
            self._get_project(username, project_id)
        hits: list[dict[str, Any]] = []
        for meta in self._project_metas(username):
            if project_id is not None and meta["id"] != project_id:
                continue
            for paper in meta.get("papers", []):
                if paper_id is not None and paper["id"] != paper_id:
                    continue
                sections = self._read_json(
                    self._sections_path(username, meta["id"], paper["id"]), []
                )
                for section in sections:
                    score = score_section(
                        terms, section.get("title") or "", section["text"]
                    )
                    if score <= 0:
                        continue
                    hits.append(
                        {
                            "paperId": paper["id"],
                            "paperTitle": paper.get("title", ""),
                            # Route metadata travels with a hit so the rail can
                            # build a link without a round trip per result.
                            "paperSlug": paper.get("slug", ""),
                            "projectId": meta["id"],
                            "projectName": meta.get("name", ""),
                            "projectSlug": meta.get("slug", ""),
                            "documentKind": paper.get("kind") or "pdf",
                            "kind": section["kind"],
                            "locator": section["locator"],
                            "locatorLabel": locator_label(
                                section["kind"],
                                section["locator"],
                                section.get("title") or "",
                            ),
                            "sectionTitle": section.get("title") or "",
                            "snippet": build_snippet(section["text"], terms),
                            "score": score,
                            "ordinal": section.get("ordinal", 0),
                            "done": bool(paper.get("doneAt")),
                        }
                    )
        return rank_hits(hits, limit)

    def search_workspace(
        self, username: str, query: str, *, limit: int = 20
    ) -> dict[str, list[dict[str, Any]]]:
        """
        The same linear scan `search_documents` makes, over three scopes.

        Honest about being a scan rather than a query, for the same reason and
        with the same bound: one machine, one account, and the deployed backend
        answering the identical question from three GIN indexes. What the
        contract suite checks is that the two agree — not on scores, which come
        off two different rankers, but on what matches and in what order.
        """
        terms = collective_terms(query)
        if not terms:
            return {"memory": [], "documents": [], "conversations": []}
        return {
            "memory": self._memory_scan(username, terms, limit),
            "documents": self._document_scan(username, terms, limit),
            "conversations": self._conversation_scan(username, terms, limit),
        }

    def _memory_scan(self, username, terms, limit):
        degrees = self._memory_degrees(username)
        titles = {
            domain["slug"]: domain.get("title", "")
            for domain in self.memory_domains(username)
        }
        pages = {page["slug"]: page for page in self._memory_pages(username)}
        # One match per page: a wiki page is already the thing being searched
        # for, so it has exactly one place. It still goes through
        # `collapse_matches` rather than sorting here, so all three scopes are
        # ordered by one function and a change to the rule reaches every one.
        matches = (
            Match(
                owner=slug,
                order=0,
                score=score_collective(
                    terms,
                    page.get("title", ""),
                    # Summary and body as one haystack: the collective rule is
                    # about the *record*, so a page whose title has one term and
                    # whose body has the other is a hit, exactly as the Postgres
                    # vector — which welds all three columns together — says it
                    # is.
                    f"{page.get('summary', '')}\n{page.get('body', '')}",
                ),
                payload=page,
            )
            for slug, page in pages.items()
        )
        return [
            memory_row(
                self._memory_summary(row.payload, degrees.get(row.owner, 0)),
                row.score,
                domain_title=titles.get(row.payload.get("domain", ""), ""),
                snippet=build_snippet(
                    row.payload.get("summary") or row.payload.get("body") or "",
                    terms,
                ),
            )
            for row in collapse_matches(matches)[:limit]
        ]

    def _document_scan(self, username, terms, limit):
        matches: list[Match] = []
        places: dict[str, tuple[dict, dict]] = {}
        for meta in self._project_metas(username):
            for paper in meta.get("papers", []):
                sections = self._read_json(
                    self._sections_path(username, meta["id"], paper["id"]), []
                )
                places[paper["id"]] = (paper, meta)
                for section in sections:
                    score = score_collective(
                        terms, section.get("title") or "", section["text"]
                    )
                    if score <= 0:
                        continue
                    matches.append(Match(
                        owner=paper["id"],
                        order=section.get("ordinal", 0),
                        score=score,
                        payload=section,
                    ))
        hits = []
        for row in collapse_matches(matches)[:limit]:
            paper, meta = places[row.owner]
            section = row.payload
            hits.append(document_row(
                paper=paper,
                project=meta,
                section_kind=section["kind"],
                locator=section["locator"],
                locator_label=locator_label(
                    section["kind"], section["locator"], section.get("title") or ""
                ),
                snippet=build_snippet(section["text"], terms),
                score=row.score,
                occurrences=row.occurrences,
            ))
        return hits

    def _conversation_scan(self, username, terms, limit):
        projects = {meta["id"]: meta for meta in self._project_metas(username)}
        hits = []
        for record in self._conversation_records(username):
            messages = record.get("messages") or []
            # Per turn, not per thread: terms spread across two messages forty
            # apart is a coincidence, not a phrase. The turns are then collapsed
            # the way a document's sections are — how many turns said it ranks
            # the thread, the earliest one is quoted, because that is where the
            # reader asked the question they are now trying to find again.
            collapsed = collapse_matches(
                Match(
                    owner=record["id"],
                    order=index,
                    score=score_collective(terms, "", message_text(body)),
                    payload=body,
                )
                for index, body in enumerate(messages)
            )
            # The title is scored on its own beside them because it is written
            # from the whole exchange and can name something no single turn
            # said.
            title_score = TITLE_WEIGHT * score_collective(
                terms, record.get("title") or "", ""
            )
            body = collapsed[0].payload if collapsed else {}
            occurrences = collapsed[0].occurrences if collapsed else 1
            score = max(collapsed[0].score if collapsed else 0.0, title_score)
            if score <= 0:
                continue
            project = projects.get(record.get("projectId"))
            papers = (project or {}).get("papers", [])
            paper = next(
                (p for p in papers if p["id"] == record.get("paperId")), None
            )
            hits.append(conversation_row(
                conversation=record,
                project=project,
                paper_slug=(paper or {}).get("slug", ""),
                snippet=build_snippet(message_text(body), terms),
                score=score,
                occurrences=occurrences,
            ))
        hits.sort(key=lambda hit: (-hit["score"], hit["conversationId"]))
        return hits[:limit]

    def list_usernames(self) -> list[str]:
        users = self.root / "users"
        if not users.exists():
            return []
        return sorted(
            entry.name
            for entry in users.iterdir()
            if entry.is_dir() and (entry / "account.json").exists()
        )

    # --- chat -----------------------------------------------------------
    def _conversations_dir(self, username: str) -> Path:
        return self._user_dir(username) / "conversations"

    def _conversation_records(self, username: str) -> list[dict[str, Any]]:
        directory = self._conversations_dir(username)
        if not directory.exists():
            return []
        return [
            row
            for path in sorted(directory.glob("*.json"))
            # A file left behind by a retired kind is debris, not a record.
            if (row := self._read_json(path, {})).get("kind") in KINDS.values()
        ]

    def _conversation_heads(self, username: str) -> list[dict[str, Any]]:
        """Every conversation's record without `messages`, and `empty` in their place.

        A listing used to parse every history: ~100 ms at 300 chats and 20 MB,
        on Home, each chat-panel open (under `CONVERSATION_LOCK`) and every
        Memory question. A head is reused while its file's (inode, mtime, size)
        holds. Every conversation write is `_write_json`'s atomic replace, a new
        file, so the key moves even when the size does not, in this store or
        another on the same profile; a file rewritten in place by hand keeping
        all three would not be seen. The stat comes before the read, so a head
        is never older than the stat it is filed under. Rows are copies: a
        caller's change never reaches the next listing."""
        directory = self._conversations_dir(username)
        if not directory.exists():
            return []
        cached = self._conversation_head_cache.get(username, {})
        fresh, rows = {}, []
        for path in sorted(directory.glob("*.json")):
            try:
                stat = path.stat()
            except FileNotFoundError:
                continue
            key = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
            entry = cached.get(path.name)
            if entry is None or entry[0] != key:
                row = self._read_json(path, {})
                entry = key, {k: v for k, v in row.items() if k != "messages"} | {"empty": not row.get("messages")}
            fresh[path.name] = entry
            # A file left behind by a retired kind is debris, not a record.
            if entry[1].get("kind") in KINDS.values():
                rows.append(copy.deepcopy(entry[1]))
        self._conversation_head_cache[username] = fresh
        return rows

    def _conversation_path(self, username: str, conversation_id: str) -> Path:
        return self._conversations_dir(username) / f"{safe_id(conversation_id)}.json"

    @staticmethod
    def _fallback_title(text: str) -> str:
        return fit_conversation_title(text) or "New conversation"

    def _scope_conversation(
        self, username: str, project_id: str | None, thread_key: str | None,
    ) -> dict[str, Any]:
        """The conversation a selector names, inside the project it claims to be in.

        Conversations are created only by `create_conversation`, so nothing here
        creates one."""
        if project_id is None and not self.account_exists(username):
            raise HTTPException(404, "Account not found")
        if project_id is not None:
            self._get_project(username, project_id)
        conversation_id, generation = require_selector(thread_key)
        row = self.get_conversation(username, conversation_id)
        if row.get("projectId") != project_id:
            raise HTTPException(404, "Conversation not found")
        if row.get("generation", 0) != generation:
            raise HTTPException(409, "Conversation changed; reload it")
        return row

    def list_recent_conversations(
        self, username: str, *, limit: int = 5
    ) -> list[dict[str, Any]]:
        # A directory listing, nothing more: never a migration on the
        # Dashboard's critical read path.
        rows = [row for row in self._conversation_heads(username) if not row["empty"]]
        rows.sort(key=lambda row: (row.get("lastEngagedAt") or "", row["id"]), reverse=True)
        return [
            {"memoryFiledThrough": None, **{key: value for key, value in row.items() if key != "empty"}}
            for row in rows[:limit]
        ]

    def get_conversation(self, username: str, conversation_id: str) -> dict[str, Any]:
        if not self.account_exists(username):
            raise HTTPException(404, "Conversation not found")
        row = self._read_json(self._conversation_path(username, conversation_id), {})
        if not row:
            raise HTTPException(404, "Conversation not found")
        return {"memoryFiledThrough": None, **row}

    def set_memory_filed_through(
        self, username: str, conversation_id: str, request_id: str | None, *, if_present: bool = False
    ) -> bool:
        with CONVERSATION_LOCK:
            row = self.get_conversation(username, conversation_id)
            if if_present and not any(m.get("requestId") == request_id for m in row.get("messages") or ()):
                return False
            row["memoryFiledThrough"] = request_id
            self._write_json(self._conversation_path(username, row["id"]), row)
            return True

    def claim_conversation_title(
        self, username: str, *, project_id: str | None, thread_key: str | None,
        engagement_id: str, fallback_title: str,
    ) -> dict[str, Any] | None:
        safe_id(engagement_id)
        with CONVERSATION_LOCK:
            row = self._scope_conversation(username, project_id, thread_key)
            # See the SQL backend: the engagement id is the whole guard, so a
            # conversation reopened later is titled again from what it has
            # become, and two turns of one mount still share the one title.
            if row.get("manualTitle") or row.get("titleEngagementId") == engagement_id:
                return None
            row["titleEngagementId"] = engagement_id
            row["title"] = row.get("title") or self._fallback_title(fallback_title)
            self._write_json(self._conversation_path(username, row["id"]), row)
            return {"id": row["id"], "generation": row.get("generation", 0),
                    "messages": list(row.get("messages", [])), "title": row["title"]}

    def set_conversation_title(
        self, username: str, conversation_id: str, *, title: str, model: str, updated_at: str, generation: int | None = None,
    ) -> None:
        with CONVERSATION_LOCK:
            path = self._conversation_path(username, conversation_id)
            row = self._read_json(path, {})
            if not row:
                raise HTTPException(404, "Conversation not found")
            if row.get("manualTitle") or (generation is not None and row.get("generation", 0) != generation):
                return
            row.update({"title": title, "titleModel": model, "titleUpdatedAt": updated_at})
            self._write_json(path, row)

    def release_conversation_title_claim(
        self, username: str, conversation_id: str, *, engagement_id: str
    ) -> None:
        with CONVERSATION_LOCK:
            path = self._conversation_path(username, conversation_id)
            row = self._read_json(path, {})
            # Only the engagement still holding it may hand it back — a second
            # tab that has since claimed the same conversation keeps its turn.
            if not row or row.get("titleEngagementId") != engagement_id:
                return
            row["titleEngagementId"] = None
            self._write_json(path, row)

    def set_conversation_model(
        self, username: str, *, project_id: str | None, thread_key: str | None, model: str,
    ) -> None:
        with CONVERSATION_LOCK:
            row = self._scope_conversation(username, project_id, thread_key)
            row["lastChatModel"] = model
            self._write_json(self._conversation_path(username, row["id"]), row)

    def set_conversation_persona(
        self, username: str, *, project_id: str | None, thread_key: str | None,
        persona_id: str,
    ) -> None:
        with CONVERSATION_LOCK:
            row = self._scope_conversation(username, project_id, thread_key)
            row["personaId"] = persona_id
            self._write_json(self._conversation_path(username, row["id"]), row)

    def get_thread(
        self, username: str, project_id: str | None, thread_key: str
    ) -> dict[str, Any]:
        with CONVERSATION_LOCK:
            row = self._scope_conversation(username, project_id, thread_key)
            return {
                "conversationId": row["id"],
                "generation": row.get("generation", 0),
                # `.get`, because a conversation written before personas
                # moved onto the thread simply has no key — and an absent
                # one has to read as "never chosen", not as a KeyError.
                "personaId": row.get("personaId"),
                "messages": list(row["messages"]),
            }

    @serialised
    def append_message(
        self, username: str, project_id: str, thread_key: str, message: dict[str, Any]
    ) -> None:
        self._get_project(username, project_id)
        with CONVERSATION_LOCK:
            thread = self._scope_conversation(username, project_id, thread_key)
            closing = check_append(thread.get("messages", []), message, thread.get("answering"))
            self._write_turn(username, thread, message, closing)

    @serialised
    def drop_from_last_user_turn(
        self,
        username: str,
        project_id: str | None,
        thread_key: str,
        request_id: str,
    ) -> list[dict[str, Any]]:
        if project_id is not None:
            self._get_project(username, project_id)
        with CONVERSATION_LOCK:
            thread = self._scope_conversation(username, project_id, thread_key)
            messages = list(thread.get("messages") or [])
            index = last_user_turn_index(messages, request_id)
            dropped = messages[index:]
            thread["messages"] = messages[:index]
            # A filing that covered a retracted request covered everything
            # before it too, so the mark moves back, never to "nothing filed".
            if thread.get("memoryFiledThrough") in {m.get("requestId") for m in dropped if m.get("requestId")}:
                thread["memoryFiledThrough"] = next(
                    (m["requestId"] for m in reversed(thread["messages"]) if m.get("requestId")), None
                )
            self._write_json(self._conversation_path(username, thread["id"]), thread)
        return dropped

    def _chat_images_dir(self, username: str, project_id: str | None) -> Path:
        """
        Where one scope's image sidecars sit.

        The account-wide chat has no project directory to live in, so it gets
        one of its own under the user rather than a placeholder project that
        every project listing would then have to know to skip.
        """
        if project_id is None:
            return self._user_dir(username) / "chats"
        return self._project_dir(username, project_id) / "chats"

    def _chat_sidecar(self, username: str, row: dict[str, Any], suffix: str) -> Path:
        """One of a conversation's image sidecars, named by its stored key.

        The stored `threadKey` is opaque here: rows written before selectors
        carry `paper-…`/`project-…` (or none, for the account-wide chat), and
        their files keep those names rather than being moved."""
        key = safe_id(row.get("threadKey") or ACCOUNT_CHAT_IMAGE_KEY)
        return self._chat_images_dir(username, row.get("projectId")) / f"{key}-{suffix}.json"

    def _chat_images_path(
        self, username: str, project_id: str | None, thread_key: str | None
    ) -> Path:
        return self._chat_sidecar(username, self._scope_conversation(username, project_id, thread_key), "images")

    def _chat_image_sequence_path(
        self, username: str, project_id: str | None, thread_key: str | None
    ) -> Path:
        return self._chat_sidecar(
            username, self._scope_conversation(username, project_id, thread_key), "image-sequence"
        )

    def _chat_images(
        self, username: str, project_id: str | None, thread_key: str | None
    ) -> list[dict[str, Any]]:
        if project_id is not None:
            self._get_project(username, project_id)
        return self._read_json(self._chat_images_path(username, project_id, thread_key), [])

    def list_chat_images(
        self, username: str, project_id: str | None, thread_key: str | None, now: str
    ) -> list[dict[str, Any]]:
        images = self._chat_images(username, project_id, thread_key)
        live = [item for item in images if item["expiresAt"] > now]
        if len(live) != len(images):
            self._write_json(self._chat_images_path(username, project_id, thread_key), live)
        return live

    def add_chat_image(
        self, username: str, project_id: str | None, thread_key: str | None, image: dict[str, Any],
        *, max_count: int, max_bytes: int,
    ) -> dict[str, Any]:
        with CHAT_IMAGE_LOCK:
            images = self._chat_images(username, project_id, thread_key)
            live = [item for item in images if item["expiresAt"] > image["createdAt"]]
            if len(live) >= max_count:
                raise HTTPException(409, "This chat already has the maximum number of images")
            if sum(item["normalizedBytes"] for item in live) + image["normalizedBytes"] > max_bytes:
                raise HTTPException(413, "This chat has reached its image storage limit")
            sequence_path = self._chat_image_sequence_path(username, project_id, thread_key)
            number = int(self._read_json(sequence_path, 0)) + 1
            record = {**image, "number": number, "used": False, "firstUseExcerpt": None}
            images.append(record)
            self._write_json(sequence_path, number)
            self._write_json(self._chat_images_path(username, project_id, thread_key), images)
            return record

    def get_chat_image(
        self, username: str, project_id: str | None, thread_key: str | None, image_id: str
    ) -> dict[str, Any]:
        target = safe_id(image_id)
        for image in self._chat_images(username, project_id, thread_key):
            if image["id"] == target:
                return image
        raise HTTPException(404, "Image unavailable")

    def reference_chat_images(
        self, username: str, project_id: str | None, thread_key: str | None, image_ids: list[str],
        now: str, question_excerpt: str,
    ) -> list[dict[str, Any]]:
        if len(image_ids) != len(set(image_ids)):
            raise HTTPException(400, "An image may only be referenced once")
        with CHAT_IMAGE_LOCK:
            images = self._chat_images(username, project_id, thread_key)
            by_id = {item["id"]: item for item in images}
            selected = []
            for image_id in image_ids:
                image = by_id.get(safe_id(image_id))
                if image is None or image["expiresAt"] <= now:
                    raise HTTPException(404, "Image unavailable")
                selected.append(image)
            for image in selected:
                image["used"] = True
                if not image.get("firstUseExcerpt"):
                    image["firstUseExcerpt"] = question_excerpt[:240]
            self._write_json(self._chat_images_path(username, project_id, thread_key), images)
            return selected

    def delete_unused_chat_image(
        self, username: str, project_id: str | None, thread_key: str | None, image_id: str
    ) -> dict[str, Any]:
        with CHAT_IMAGE_LOCK:
            images = self._chat_images(username, project_id, thread_key)
            target = next((item for item in images if item["id"] == safe_id(image_id)), None)
            if target is None:
                raise HTTPException(404, "Image unavailable")
            if target.get("used"):
                raise HTTPException(409, "A sent image cannot be removed")
            self._write_json(
                self._chat_images_path(username, project_id, thread_key),
                [item for item in images if item["id"] != target["id"]],
            )
            return target

    # --- highlights -----------------------------------------------------
    def _highlights_path(self, username: str, project_id: str, paper_id: str) -> Path:
        return (
            self._project_dir(username, project_id)
            / "highlights"
            / f"{safe_id(paper_id)}.json"
        )

    @serialised
    def save_highlight_placements(self, username, project_id, paper_id, revision, placements):
        self.get_paper(username, project_id, paper_id)
        path = self._highlights_path(username, project_id, paper_id)
        marks = self._read_json(path, [])
        incoming = {item["id"]: item for item in placements}
        for mark in marks:
            place = incoming.get(mark["id"])
            if mark.get("type") == "html" and place and place["end"] - place["start"] == len(mark["text"].encode("utf-16-le"))//2:
                mark["placement"] = {"revision":revision, "start":place["start"], "end":place["end"]}
        self._write_json(path, marks)

    @contextmanager
    def annotation_revision_lock(self, username, project_id, paper_id):
        with _meta_lock(self._meta_path(username, project_id)):
            self.get_paper(username, project_id, paper_id)
            yield

    def list_highlights(
        self, username: str, project_id: str, paper_id: str
    ) -> list[dict[str, Any]]:
        self.get_paper(username, project_id, paper_id)
        return self._read_json(
            self._highlights_path(username, project_id, paper_id), []
        )

    @serialised
    def add_highlight(
        self, username: str, project_id: str, paper_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        self.get_paper(username, project_id, paper_id)
        path = self._highlights_path(username, project_id, paper_id)
        highlights = self._read_json(path, [])
        if payload.get("requestId"):
            for existing in highlights:
                if existing.get("requestId") == payload["requestId"]:
                    if any(existing.get(key) != value for key, value in payload.items()):
                        raise ValueError("Annotation request ID was already used")
                    return existing
        highlight = {"id": uuid4().hex[:12], **payload, "createdAt": utc_now()}
        highlights.append(highlight)
        self._write_json(path, highlights)
        return highlight

    @serialised
    def delete_highlight(
        self, username: str, project_id: str, paper_id: str, highlight_id: str
    ) -> None:
        self.get_paper(username, project_id, paper_id)
        path = self._highlights_path(username, project_id, paper_id)
        highlights = self._read_json(path, [])
        for note in self._read_json(self._notes_path(username, project_id, paper_id), []):
            if note.get("highlightId") == highlight_id:
                self._hold_session(
                    username, project_id=project_id, paper_id=paper_id, note_id=note["id"], stamp=f"deleted {utc_now()}"
                )
        self._write_json(
            path, [item for item in highlights if item["id"] != highlight_id]
        )
        # The SQL backend gets this from the highlight's cascade. Here the two
        # files are independent, so the note has to be dropped by hand or it
        # would outlive the stroke that says where it points.
        self._delete_notes_for_highlight(username, project_id, paper_id, highlight_id)

    # --- notes ----------------------------------------------------------
    def _notes_path(self, username: str, project_id: str, paper_id: str) -> Path:
        return (
            self._project_dir(username, project_id)
            / "notes"
            / f"{safe_id(paper_id)}.json"
        )

    def list_notes(
        self, username: str, project_id: str, paper_id: str
    ) -> list[dict[str, Any]]:
        self.get_paper(username, project_id, paper_id)
        return self._read_json(self._notes_path(username, project_id, paper_id), [])

    @serialised
    def add_note(
        self, username: str, project_id: str, paper_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        self.get_paper(username, project_id, paper_id)
        path = self._notes_path(username, project_id, paper_id)
        notes = self._read_json(path, [])
        highlight_id = payload.get("highlightId")
        # One note per anchor, which the SQL backend states as a unique
        # constraint. Re-opening an anchor edits what is there.
        existing = next(
            (item for item in notes if item.get("highlightId") == highlight_id), None
        )
        if not any(item["id"] == payload["highlightId"] for item in self.list_highlights(username, project_id, paper_id)):
            raise HTTPException(404, "That highlight no longer exists")
        now = utc_now()
        if existing is not None:
            existing.update({**payload, "updatedAt": now, "filedAt": None})
            self._hold_session(username, project_id=project_id, paper_id=paper_id, note_id=existing["id"], stamp=now)
            self._write_json(path, notes)
            return existing
        note = {
            "id": uuid4().hex[:12],
            **payload,
            "createdAt": now,
            "updatedAt": now,
            "filedAt": None,
        }
        self._hold_session(username, project_id=project_id, paper_id=paper_id, note_id=note["id"], stamp=now)
        notes.append(note)
        self._write_json(path, notes)
        return note

    @serialised
    def update_note(
        self, username: str, project_id: str, paper_id: str, note_id: str, body: str
    ) -> dict[str, Any]:
        self.get_paper(username, project_id, paper_id)
        path = self._notes_path(username, project_id, paper_id)
        notes = self._read_json(path, [])
        note = next((item for item in notes if item["id"] == note_id), None)
        if note is None:
            raise HTTPException(404, "Note not found")
        # An edited note is unfiled again: the wiki holds what the reader used
        # to think, and the next pass should be shown what they think now.
        note.update({"body": body, "updatedAt": utc_now(), "filedAt": None})
        self._hold_session(username, project_id=project_id, paper_id=paper_id, note_id=note_id, stamp=note["updatedAt"])
        self._write_json(path, notes)
        return note

    @serialised
    def delete_note(
        self, username: str, project_id: str, paper_id: str, note_id: str
    ) -> None:
        self.get_paper(username, project_id, paper_id)
        path = self._notes_path(username, project_id, paper_id)
        notes = self._read_json(path, [])
        if any(item["id"] == note_id for item in notes):
            self._hold_session(
                username, project_id=project_id, paper_id=paper_id, note_id=note_id, stamp=f"deleted {utc_now()}"
            )
        self._write_json(path, [item for item in notes if item["id"] != note_id])

    def list_unfiled_notes(
        self, username: str, project_id: str, paper_id: str
    ) -> list[dict[str, Any]]:
        return [
            note
            for note in self.list_notes(username, project_id, paper_id)
            if not note.get("filedAt")
        ]

    @serialised
    def mark_notes_filed(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        note_ids: list[str],
        now: str,
    ) -> None:
        if not note_ids:
            return
        self.get_paper(username, project_id, paper_id)
        path = self._notes_path(username, project_id, paper_id)
        notes = self._read_json(path, [])
        wanted = set(note_ids)
        for note in notes:
            if note["id"] in wanted:
                note["filedAt"] = now
        self._write_json(path, notes)

    @serialised
    def _delete_notes_for_highlight(
        self, username: str, project_id: str, paper_id: str, highlight_id: str
    ) -> None:
        path = self._notes_path(username, project_id, paper_id)
        notes = self._read_json(path, [])
        remaining = [
            item for item in notes if item.get("highlightId") != highlight_id
        ]
        if len(remaining) != len(notes):
            self._write_json(path, remaining)
