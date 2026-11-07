"""
The format of a local store on disk, and the steps that bring an older store
to it.

Postgres changes shape through Alembic. A local store has no such runner: the
desktop app opens whatever profile is on the machine, and that profile may
have been written by an earlier release. So every account carries a marker,
`memory/format.json` (`knowledge/format.json` before format 5), and
`LocalStorage` calls `open_store` when it is constructed. An account at
`LOCAL_FORMAT` costs one small file read the first time a process sees it and
nothing afterwards; a construction otherwise costs one listing of `users/`. A
new account is written with the marker (`mark_current`), so it is never
migrated.

**Format 2** is Memory with three kinds of page and four claim types. The
step to it is the retirement that revision `b7d2f4a6c931` runs on Postgres,
and the rules between the two marked lines below are that revision's, copied
and never imported: a migration says what one release did, and must go on
saying it when the code around it moves. `test_memory_retirement.py` holds
the copies equal.

**Format 3** is Memory in which a domain has a page only when one was
composed. Format 2 deleted the interim listings ("stubs") that stood in for a
domain's page, and the release that wrote format 2 still wrote them again
whenever Memory was read, so a store opened since then has regrown them. The
step to format 3 deletes them once more, now that nothing writes one, and it
is the page half of the same rules: revision `d6f2b8e41a57` carries the third
copy of the marked lines and runs them over Postgres.

**Format 4** keeps only research plans of schema version 4. The step deletes
the older plans from `plans.json` with the receipts and grants that named only
them, by the rule between the plan lines below; revision `a3c8e5f20d61` runs
the same copy over Postgres. It keeps no copy: a plan is a saved answer the
reader can ask for again, not something only Memory holds. The captures a
deleted plan copied go with it.

**Format 5** is Memory under the name the product gives it: `knowledge/`
becomes `memory/`, `account.json`'s `knowledgeUpdate` becomes `memoryUpdate`,
and a Memory conversation's `kind` becomes `memory_chat`, as revision
`0d70a9dd6ead` renames the tables, the column and the kind on Postgres. Only those
named fields are rewritten, never a string that happens to hold the
word: a page's slug, title or body is the reader's. The marker lives inside
the directory being renamed, so the step names what it will rewrite in
`knowledge/format.json`, rewrites those files in place with a copy of each
kept in `knowledge.format-4/`, renames the directory in one `os.rename`, and
only then says format 5, leaving a file named `knowledge` in the directory's
place (`FORMER_PLACE`), so that a release before format 5 refuses the profile
instead of taking the account for format 1. Formats 1 to 4 still run in
`knowledge/`, exactly as they were written, and a store several formats behind
takes them first. An account holding both directories (a backup restored by
hand, say) is refused, not merged: only the reader can say which one is theirs.
The step renames a directory a running app may be reading, so the bulk
commands never take it (`not_current`).

Each step is destructive and runs once. It writes what it will delete into
the marker before it deletes anything, so a run that was interrupted finishes
from that record on the next open, and the marker names the new format only
after everything else is done. A copy of what the step removes is kept beside
`knowledge/` first. The step to format 2 keeps the account's whole Memory
(`knowledge.format-1`): it deletes pages a model wrote and clears the log. The
step to format 3 keeps only the page files it deletes or rewrites
(`knowledge.format-2/pages`): it deletes nothing but stubs and rewrites only
a page that linked to one or carried the appended list, and a second whole
copy would double an account's figures to save listings that were written
without a model. These are migrations, not readers: nothing
outside this module understands the retired kinds, claim types or stubs.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import unicodedata
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .base import SAFE_ID, utc_now

if TYPE_CHECKING:
    from .local import LocalStorage

logger = logging.getLogger("uvicorn.error")

#: The format this code reads and writes. A store with no marker is format 1.
LOCAL_FORMAT = 5
#: The last format whose Memory is `knowledge/`. Every step up to it writes its
#: marker there (`write_marker`).
LAST_FORMAT_IN_KNOWLEDGE = 4

# --- the retirement rules: identical in alembic revisions b7d2f4a6c931 and d6f2b8e41a57 ---
KINDS = ("domain", "concept", "source")
CLAIM_TYPES = ("author-claim", "external", "reader-note", "derived")
LOCATORS = ("paperId", "page", "section", "noteId", "evidenceId")
VERSIONED_KINDS = ("concept", "domain")
VERSIONS_KEPT = 20
RETIREMENT_NOTE = "retired page kinds and claim types removed"

#: What the interim domain page said. A stub was a list of the pages filed
#: under a domain, written without a model and replaced when one composed it.
STUB_INDEX = "Pages filed under this area"
STUB_OPENING = "Hub for the reader's"
#: The list of members that was appended to a composed domain page.
MEMBERSHIP_BLOCK = re.compile(r"<!-- delphi-members:start -->[\s\S]*?<!-- delphi-members:end -->")

_LINK = re.compile(r"\[\[([^\[\]|]{1,120})(?:\|([^\[\]]{0,120}))?\]\]")
_CODE = re.compile(r"(?ms)^ {0,3}(`{3,}|~{3,}).*?(?:^ {0,3}\1[`~]*[ \t]*\r?$|\Z)|`[^`\n]+`")
_APOSTROPHES = str.maketrans("", "", "'‘’ʼ")
_SLUG_MAX = 60


def slug_of(value: str) -> str:
    """The slug a link's target names, as the stores have always derived it."""
    decomposed = unicodedata.normalize("NFKD", value or "")
    plain = "".join(char for char in decomposed if not unicodedata.combining(char))
    cleaned = plain.translate(_APOSTROPHES).lower().encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", cleaned).strip("-")
    if len(slug) > _SLUG_MAX:
        clipped = slug[:_SLUG_MAX]
        boundary = clipped.rfind("-")
        slug = (clipped[:boundary] if boundary > 0 else clipped).rstrip("-")
    return slug


def links_of(body: str) -> list[str]:
    """Every page a body links to, in order, once each."""
    found: list[str] = []
    for link in _LINK.finditer(body or ""):
        slug = slug_of(link.group(1))
        if slug and slug not in found:
            found.append(slug)
    return found


def without_membership(body: str) -> str:
    """A domain page's body with the appended list of members taken out."""
    if not MEMBERSHIP_BLOCK.search(body or ""):
        return body or ""
    return re.sub(r"\n{3,}", "\n\n", MEMBERSHIP_BLOCK.sub("", body)).strip()


def is_stub(page: dict[str, Any]) -> bool:
    """
    Whether a domain page is the interim listing and not composed prose.

    It is one when nothing is left once the list of members is taken out, or
    when it cites nothing and either holds the stub's index heading or opens
    with the stub's first words and links nowhere.
    """
    if page.get("kind") != "domain":
        return False
    body = page.get("body") or ""
    if not without_membership(body).strip():
        return True
    if page.get("citations"):
        return False
    return STUB_INDEX in body or (body.startswith(STUB_OPENING) and not links_of(body))


def retiring(pages: list[dict[str, Any]]) -> dict[str, str]:
    """The pages the retirement deletes, as slug to title."""
    return {
        page["slug"]: page.get("title") or ""
        for page in pages
        if page.get("kind") not in KINDS or is_stub(page)
    }


def unlinked(body: str, gone: dict[str, str]) -> str:
    """
    A body with each link to a deleted page written as plain words.

    The words are the label the author wrote (`[[slug|label]]`), and the
    deleted page's title otherwise. Links to other pages, and anything inside
    code, are left as they are.
    """

    def words(link: re.Match[str]) -> str:
        slug = slug_of(link.group(1))
        if slug not in gone:
            return link.group(0)
        label = (link.group(2) or "").strip()
        return label or gone[slug] or slug.replace("-", " ")

    parts: list[str] = []
    cursor = 0
    for code in _CODE.finditer(body or ""):
        parts.append(_LINK.sub(words, body[cursor : code.start()]))
        parts.append(code.group(0))
        cursor = code.end()
    parts.append(_LINK.sub(words, (body or "")[cursor:]))
    return "".join(parts)


def current_citations(citations: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    """
    Citations in the four claim types.

    A citation of any other type (`reader-inference` and `conversation` were
    the two) becomes `derived`, and a `derived` citation names no source, so
    its locator fields are emptied.
    """
    if not citations:
        return citations
    mapped = []
    for citation in citations:
        kept = dict(citation)
        if kept.get("claimType") not in CLAIM_TYPES:
            kept["claimType"] = "derived"
        if kept["claimType"] == "derived":
            for name in LOCATORS:
                if kept.get(name) is not None:
                    kept[name] = None
        mapped.append(kept)
    return mapped


def retired_page(page: dict[str, Any], gone: dict[str, str]) -> dict[str, Any] | None:
    """What changes on a page that stays, as `{body, citations}`; None when nothing does."""
    body = page.get("body") or ""
    if page.get("kind") == "domain":
        body = without_membership(body)
    body = unlinked(body, gone)
    citations = current_citations(page.get("citations"))
    if body == (page.get("body") or "") and citations == page.get("citations"):
        return None
    return {"body": body, "citations": citations}
# --- end of the retirement rules ---


#: The job kinds of format 2. A queued job of any other kind is dropped: no
#: worker can claim it.
JOB_KINDS = ("domain", "page-rewrite", "document", "session")

#: What a page record carried for the reader's level, which Postgres lost as
#: columns in `d1a7c40e92b5`. A local record kept the keys until now.
RETIRED_PAGE_FIELDS = ("level", "observations", "lastSeenAt", "encounters")

#: Account directories this process has seen at `LOCAL_FORMAT`.
_CURRENT: set[str] = set()
#: Where an account's Memory as format 1 left it is kept, beside `knowledge/`.
BEFORE_RETIREMENT = "knowledge.format-1"
#: Where the page files the step to format 3 deleted or rewrote are kept.
BEFORE_STUB_CLEANUP = "knowledge.format-2"
#: The note of the version row a composed domain page gets when the step to
#: format 3 takes the appended list of members out of it.
STUB_CLEANUP_NOTE = "interim list of members removed"
#: Where the files the step to format 5 rewrote are kept, as format 4 left them.
BEFORE_RENAME = "knowledge.format-4"
#: The stored names the step to format 5 rewrites, each in the one field that
#: holds it: the Update run's key in `account.json`, and a Memory
#: conversation's `kind`.
RENAMED_UPDATE = ("knowledgeUpdate", "memoryUpdate")
RENAMED_KIND = ("knowledge_base_chat", "memory_chat")
#: What stands in `knowledge/`'s place once an account is at format 5: a file,
#: not a directory. A release before format 5 reads its marker at
#: `knowledge/format.json`, catches only a missing one, and so refuses to open
#: the profile rather than take the account for format 1, stamp every
#: conversation filed and start an empty Memory. It also stops such a release,
#: still running, from making the directory again.
FORMER_PLACE = {
    "movedTo": "memory",
    "localFormat": LOCAL_FORMAT,
    "note": "Local format 5 renamed this account's Memory directory to memory/. A Delphi from before format 5 cannot open this profile.",
}
#: The accounts refused this process, with why: logged once, not on every
#: request that constructs the store, since nothing changes until the reader
#: moves a directory.
_REFUSED: dict[str, str] = {}
_GUARD = threading.Lock()


def marker_path(user_dir: Path) -> Path:
    """The account's marker: in `memory/` once the step to format 5 renamed it there, in `knowledge/` before."""
    renamed = user_dir / "memory" / "format.json"
    return renamed if renamed.exists() else user_dir / "knowledge" / "format.json"


def _read(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_marker(store: LocalStorage, user_dir: Path, value: dict[str, Any] | None = None) -> None:
    """The marker of a step before the rename, in `knowledge/`: that the step reached format 4, unless `value` says more."""
    store._write_json(user_dir / "knowledge" / "format.json", value or {"format": LAST_FORMAT_IN_KNOWLEDGE})


def mark_current(store: LocalStorage, user_dir: Path) -> None:
    """The marker of an account at `LOCAL_FORMAT`, in `memory/`, then `FORMER_PLACE`. A new account is written with both first."""
    store._write_json(user_dir / "memory" / "format.json", {"format": LOCAL_FORMAT})
    _hold_former_place(store, user_dir)


def _hold_former_place(store: LocalStorage, user_dir: Path) -> None:
    """`FORMER_PLACE` where `knowledge/` was, unless something is already there."""
    if not (user_dir / "knowledge").exists():
        store._write_json(user_dir / "knowledge", FORMER_PLACE)


def _split(user_dir: Path) -> str | None:
    """
    Why an account cannot be opened as one Memory, or None when it can.

    It cannot when it holds both directories: the step to format 5 renames one
    into the other in a single call, so no run of it leaves both. A `memory/`
    without its marker is no store any release wrote either, and taking it for
    format 1 would run the retirement over an empty `knowledge/` beside it.
    Both are kept as they are, for the reader to choose between.
    """
    memory, former = user_dir / "memory", user_dir / "knowledge"
    if not memory.exists():
        if former.exists() and not former.is_dir():
            return f"{memory}/ is missing, and {former} is the note format 5 left in its place: restore memory/ from a backup"
        return None
    if former.is_dir():
        return (
            f"{user_dir} holds both knowledge/ and memory/. memory/ is the Memory this release "
            "renamed; knowledge/ came back after it, from a release before format 5 or a backup "
            f"restored by hand, and the two are not merged. Move the one you do not want out of "
            f"{user_dir}, then open the profile again"
        )
    if not (memory / "format.json").exists():
        return f"{memory}/ has no format.json, so no release wrote it; it is left as it is"
    return None


def open_store(store: LocalStorage) -> None:
    """Bring every account under this store to `LOCAL_FORMAT`, once."""
    users = store.root / "users"
    try:
        with os.scandir(users) as entries:
            unseen = [entry.path for entry in entries if entry.path not in _CURRENT and entry.is_dir()]
    except FileNotFoundError:
        return
    if not unseen:
        return
    with _GUARD:
        for found in sorted(unseen):
            user_dir = Path(found)
            if found in _CURRENT or not SAFE_ID.fullmatch(user_dir.name):
                continue
            if not (user_dir / "account.json").exists():
                # Not an account, or one still being created: look again later.
                continue
            # Before any step: a step that ran here would write into one of the
            # two and leave the other as it was.
            if said := _split(user_dir):
                if _REFUSED.get(found) != said:
                    _REFUSED[found] = said
                    logger.error("could not bring the local store of %s to format %s: %s", user_dir.name, LOCAL_FORMAT, said)
                raise RuntimeError(f"Refusing to open this local store: {said}.")
            try:
                # One step at a time. A step that finished left the marker
                # at its format and nothing else in it.
                marker = _read(marker_path(user_dir), {})
                if int(marker.get("format") or 1) < 2:
                    _retire(store, user_dir, marker)
                    marker = {"format": 2}
                if int(marker.get("format") or 1) < 3:
                    _drop_stubs(store, user_dir, marker)
                    marker = {"format": 3}
                if int(marker.get("format") or 1) < 4:
                    _retire_plans(store, user_dir)
                    marker = {"format": 4}
                if int(marker.get("format") or 1) < 5:
                    _rename(store, user_dir, marker)
                # Here too: a run cut short after its marker, before the note.
                _hold_former_place(store, user_dir)
            except Exception:
                logger.exception("could not bring the local store of %s to format %s", user_dir.name, LOCAL_FORMAT)
                raise
            _CURRENT.add(found)


def not_current(root: Path) -> dict[str, str]:
    """
    Each account under the data directory `root` that is not at `LOCAL_FORMAT`, with why, in words.

    Read only. A bulk command checks this instead of opening the store,
    because opening it would take the step to format 5, which renames the
    directory an open app may be reading at that moment: only the app brings
    a store to format 5. A store newer than this code is refused alike.
    """
    found: dict[str, str] = {}
    users = root / "users"
    for user_dir in sorted(users.iterdir()) if users.is_dir() else ():
        if not user_dir.is_dir() or not SAFE_ID.fullmatch(user_dir.name) or not (user_dir / "account.json").exists():
            continue
        if said := _split(user_dir):
            found[user_dir.name] = said
            continue
        held = int(_read(marker_path(user_dir), {}).get("format") or 1)
        if held < LOCAL_FORMAT:
            found[user_dir.name] = (
                f"at local format {held}; open it in Delphi (or start the backend on it) once, "
                f"which brings it to format {LOCAL_FORMAT}"
            )
        elif held > LOCAL_FORMAT:
            found[user_dir.name] = f"at local format {held}, newer than this release's {LOCAL_FORMAT}; use the release that wrote it"
    return found


def _page_files(directory: Path) -> list[tuple[Path, dict[str, Any]]]:
    """Each page file and its record. A file not named for its slug is not a page."""
    if not directory.is_dir():
        return []
    found = []
    for entry in sorted(directory.iterdir()):
        if entry.suffix != ".json":
            continue
        record = _read(entry, None)
        if isinstance(record, dict) and record.get("slug") == entry.stem:
            found.append((entry, record))
    return found


def _figure_file(user_dir: Path, key: str) -> Path | None:
    """Where the local object store keeps a figure's bytes, for a key of this account."""
    parts = key.split("/")
    if len(parts) != 5 or parts[:2] != ["knowledge", "u"] or parts[2] != user_dir.name or parts[3] != "figures":
        return None
    stem, dot, extension = parts[4].rpartition(".")
    if not dot or not SAFE_ID.fullmatch(stem) or not SAFE_ID.fullmatch(extension):
        return None
    return user_dir / "knowledge" / "figures" / f"{stem}.{extension}"


def _retire_pages(
    store: LocalStorage, user_dir: Path, pages: list[tuple[Path, dict[str, Any]]], plan: dict[str, Any], note: str,
    *, log_cleared: bool,
) -> None:
    """
    The page half of a step: rewrite the pages that stay, then delete the planned ones with what they held.

    `log_cleared` says the step also empties the event log, so no version row
    may go on naming an event.
    """
    knowledge = user_dir / "knowledge"
    gone = {slug: entry.get("title") or "" for slug, entry in plan.items()}
    gone_ids = {entry.get("id") for entry in plan.values()} - {None}
    now = utc_now()

    for path, page in pages:
        if page["slug"] in gone:
            continue
        versions = knowledge / "versions" / page["slug"]
        rows = sorted(versions.glob("*.json")) if versions.is_dir() else []
        for row_path in rows:
            row = _read(row_path, None)
            if not isinstance(row, dict):
                continue
            kept = {**row, "citations": current_citations(row.get("citations"))}
            if log_cleared:
                kept["eventId"] = None
            if kept != row:
                store._write_json(row_path, kept)
        bare = {name: value for name, value in page.items() if name not in RETIRED_PAGE_FIELDS}
        change = retired_page(bare, gone)
        if change is None:
            if bare != page:
                store._write_json(path, bare)
            continue
        record = {
            **bare,
            **change,
            "links": links_of(change["body"]),
            "revision": int(page.get("revision") or 0) + 1,
            "updatedAt": now,
        }
        store._write_json(path, record)
        if record.get("kind") in VERSIONED_KINDS:
            store._write_json(
                versions / f"{record['revision']:08d}.json",
                {
                    "slug": record["slug"],
                    "revision": record["revision"],
                    "title": record.get("title") or "",
                    "summary": record.get("summary") or "",
                    "body": record["body"],
                    "citations": list(record.get("citations") or ()),
                    "createdAt": now,
                    "eventId": None,
                    "trigger": None,
                    "note": note,
                },
            )
            numbered = sorted(entry for entry in versions.glob("*.json") if entry.stem.isdigit())
            for stale in numbered[:-VERSIONS_KEPT]:
                stale.unlink(missing_ok=True)

    figures_path = knowledge / "figures.json"
    figures = _read(figures_path, [])
    dropped = [figure for figure in figures if figure.get("pageId") in gone_ids]
    if dropped:
        store._write_json(figures_path, [figure for figure in figures if figure.get("pageId") not in gone_ids])
    for figure in dropped:
        # Record first, bytes after, as every other delete of a figure is ordered.
        stored = _figure_file(user_dir, str(figure.get("objectKey") or ""))
        if stored is not None:
            stored.unlink(missing_ok=True)

    for slug in gone:
        (knowledge / "pages" / f"{slug}.json").unlink(missing_ok=True)
        shutil.rmtree(knowledge / "versions" / slug, ignore_errors=True)


def _retire(store: LocalStorage, user_dir: Path, marker: dict[str, Any]) -> None:
    """Format 1 to 2 for one account. Every step is safe to repeat."""
    from .local import CONVERSATION_LOCK, MEMORY_JOB_LOCK, PERSONA_LOCK

    knowledge = user_dir / "knowledge"
    with PERSONA_LOCK, MEMORY_JOB_LOCK, CONVERSATION_LOCK:
        pages = _page_files(knowledge / "pages")
        # Decided once and written down before anything is deleted, so an
        # interrupted run repairs links to pages whose files are already gone.
        plan = marker.get("retiring")
        if plan is None:
            # The step deletes pages and clears the log, in place. What was
            # there is kept beside it, once, so a reader who wanted a deleted
            # page back can be given it; nothing reads the copy.
            kept = user_dir / BEFORE_RETIREMENT
            if knowledge.is_dir() and not kept.exists():
                shutil.copytree(knowledge, kept)
            titles = retiring([record for _, record in pages])
            plan = {
                record["slug"]: {"title": titles[record["slug"]], "id": record.get("id")}
                for _, record in pages
                if record["slug"] in titles
            }
            write_marker(store, user_dir, {"format": 1, "retiring": plan})
        _retire_pages(store, user_dir, pages, plan, RETIREMENT_NOTE, log_cleared=True)

        # Its events name pages, kinds and markers that no longer exist, and
        # every document then reads as not yet filed, which is true.
        events_path = knowledge / "events.json"
        if _read(events_path, []):
            store._write_json(events_path, [])

        jobs_path = knowledge / "jobs.json"
        jobs = _read(jobs_path, [])
        runnable = [
            job
            for job in jobs
            if job.get("kind") in JOB_KINDS
            and not (job.get("kind") == "page-rewrite" and (job.get("payload") or {}).get("pageSlug") in plan)
        ]
        if len(runnable) != len(jobs):
            store._write_json(jobs_path, runnable)

        # History is not refiled on its own: each conversation is marked as
        # filed through the last request it holds.
        conversations = user_dir / "conversations"
        for path in sorted(conversations.glob("*.json")) if conversations.is_dir() else []:
            row = _read(path, None)
            if not isinstance(row, dict) or not isinstance(row.get("messages"), list):
                continue
            last = next(
                (message["requestId"] for message in reversed(row["messages"])
                 if isinstance(message, dict) and message.get("requestId")),
                None,
            )
            if "memoryFiledThrough" not in row or row["memoryFiledThrough"] != last:
                store._write_json(path, {**row, "memoryFiledThrough": last})

        _bump_graph(store, knowledge)
        write_marker(store, user_dir, {"format": 2})


def _bump_graph(store: LocalStorage, knowledge: Path) -> None:
    graph_path = knowledge / "graph.json"
    store._write_json(graph_path, {"revision": int((_read(graph_path, {}) or {}).get("revision") or 0) + 1})


def _drop_stubs(store: LocalStorage, user_dir: Path, marker: dict[str, Any]) -> None:
    """Format 2 to 3 for one account: the stubs a format 2 store regrew. Every step is safe to repeat."""
    from .local import MEMORY_JOB_LOCK, PERSONA_LOCK

    knowledge = user_dir / "knowledge"
    with PERSONA_LOCK, MEMORY_JOB_LOCK:
        pages = _page_files(knowledge / "pages")
        plan = marker.get("retiring")
        if plan is None:
            titles = retiring([record for _, record in pages])
            touched = [
                path for path, record in pages
                if record["slug"] in titles or retired_page(record, titles) is not None
            ]
            # Whole or not at all: a copy cut short is taken again, never
            # mistaken for the files as they were.
            kept, partial = user_dir / BEFORE_STUB_CLEANUP, user_dir / f"{BEFORE_STUB_CLEANUP}.partial"
            if touched and not kept.exists():
                shutil.rmtree(partial, ignore_errors=True)
                (partial / "pages").mkdir(parents=True)
                for path in touched:
                    shutil.copy2(path, partial / "pages" / path.name)
                partial.rename(kept)
            plan = {
                record["slug"]: {"title": titles[record["slug"]], "id": record.get("id")}
                for _, record in pages
                if record["slug"] in titles
            }
            write_marker(store, user_dir, {"format": 2, "retiring": plan})
        _retire_pages(store, user_dir, pages, plan, STUB_CLEANUP_NOTE, log_cleared=False)
        _bump_graph(store, knowledge)
        write_marker(store, user_dir, {"format": 3})


# --- the plan retirement rule: identical in alembic revision a3c8e5f20d61 ---
def current_plans(state: dict) -> dict:
    plans = {k: v for k, v in state.get("plans", {}).items() if v.get("plan", {}).get("version") == 4}
    receipts = {k: r for k, r in state.get("receipts", {}).items() if r.get("status") != "saved" or r.get("planId") in plans}
    grants = {}
    for key, grant in state.get("grants", {}).items():
        named = [i for i in grant.get("planIds", []) if i in plans]
        if named:
            grants[key] = {**grant, "planIds": named}
    return {**state, "plans": plans, "receipts": receipts, "grants": grants}
# --- end of the plan retirement rule ---


def _retire_plans(store: LocalStorage, user_dir: Path) -> None:
    """Format 3 to 4 for one account: plans older than schema version 4, with their captures. Safe to repeat."""
    from .local import CONVERSATION_LOCK

    path = user_dir / "plans.json"
    with CONVERSATION_LOCK:
        state = _read(path, None)
        if state is not None and (kept := current_plans(state)) != state:
            store._write_json(path, kept)
            for plan_id in set(state.get("plans", {})) - set(kept["plans"]):
                if SAFE_ID.fullmatch(plan_id):
                    shutil.rmtree(user_dir / "plan-captures" / plan_id, ignore_errors=True)
    write_marker(store, user_dir)


def _record(path: Path) -> Any:
    """What a file holds; None when it is gone or is not JSON, and such a file is left as it is."""
    try:
        return _read(path, None)
    except ValueError:
        return None


def _renamed(name: str, record: Any) -> dict[str, Any] | None:
    """A file's record with format 5's name in the one field that held the old one; None when none does."""
    if not isinstance(record, dict):
        return None
    if name == "account.json":
        old, new = RENAMED_UPDATE
        if old not in record:
            return None
        # Renamed where it stood. Nothing before format 5 wrote the new name,
        # so a value under it is not the run's.
        return {(new if key == old else key): value for key, value in record.items() if key != new}
    old, new = RENAMED_KIND
    return {**record, "kind": new} if record.get("kind") == old else None


def _holding_old_names(user_dir: Path) -> list[str]:
    """The files of an account the step to format 5 rewrites, by their path in it."""
    names = ["account.json", *(f"conversations/{path.name}" for path in sorted((user_dir / "conversations").glob("*.json")))]
    return [name for name in names if _renamed(name, _record(user_dir / name)) is not None]


def _keep(path: Path, copy: Path) -> None:
    """A whole copy of `path`, on disk before the rewrite after it is: `_write_json` syncs, so this does too."""
    copy.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, copy)
    with open(copy, "rb+") as kept:
        os.fsync(kept.fileno())


def _rename(store: LocalStorage, user_dir: Path, marker: dict[str, Any]) -> None:
    """Format 4 to 5 for one account: `knowledge/` becomes `memory/`. Every step is safe to repeat."""
    from .local import CONVERSATION_LOCK, MEMORY_JOB_LOCK, PERSONA_LOCK

    knowledge, memory = user_dir / "knowledge", user_dir / "memory"
    with PERSONA_LOCK, MEMORY_JOB_LOCK, CONVERSATION_LOCK:
        # A `memory/` here is the one this step renamed (`_split` refused any
        # other), and only the marker is left to write.
        if not memory.exists():
            plan = marker.get("renaming")
            if plan is None:
                # Named before anything is rewritten, in the marker the rename
                # carries along, so a run cut short finishes these files.
                plan = {"files": _holding_old_names(user_dir)}
                write_marker(store, user_dir, {"format": LAST_FORMAT_IN_KNOWLEDGE, "renaming": plan})
            kept = user_dir / BEFORE_RENAME
            # The plan's files, and any that took an old name after it was
            # written: a release before format 5 that ran in between sees
            # format 4 and writes as it always did.
            for name in dict.fromkeys([*plan["files"], *_holding_old_names(user_dir)]):
                path = user_dir / name
                renamed = _renamed(name, _record(path))
                if renamed is None:
                    # Rewritten by a run that was cut short, after its copy.
                    continue
                # The copy whole first, the rewrite after it: a copy cut short
                # leaves the file as it was, and is taken again.
                _keep(path, kept / name)
                store._write_json(path, renamed)
            # One call: there is never a moment with both directories, or none.
            os.rename(knowledge, memory)
        mark_current(store, user_dir)
