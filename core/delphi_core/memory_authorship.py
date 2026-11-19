"""
Who wrote a Memory page: read from the event log, never stored on the page.

A filing names its author by its marker (`jobs.read_marker`): a document's job
and its follow-ups, the chats and notes beside a document, or a Memory chat.
Reconcile, domain, rewrite and delete events are Delphi's upkeep, not
authorship, and add no row. An author the reader has since deleted stays,
marked `removed`, under the name its event kept: removing an author rewrites
no page (invariant 41).

Nothing here writes, and no model is called.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from fastapi import HTTPException

from .memory_maintenance.jobs import DOCUMENT, read_marker
from .storage import Storage


def page_authors(
    events: Sequence[Mapping[str, Any]],
    slug: str,
    *,
    papers: Mapping[str, tuple[str, str | None]],
    chats: Mapping[str, tuple[int, str | None]],
) -> list[dict[str, Any]]:
    """
    One row per author of `slug`, in the order each first wrote it.

    `events` are the page's, oldest first (`Storage.page_events`). Authorship
    starts at the last event that created the page, so a page deleted and filed
    again under the same slug does not inherit the old one's authors. `papers`
    maps each document in the library to its project and title; `chats` each
    Memory chat that still holds messages to its generation and title.
    """
    start = 0
    for index, event in enumerate(events):
        if any(edit.get("slug") == slug and edit.get("action") == "created" for edit in event.get("edits") or ()):
            start = index
    rows: dict[tuple[str, str, int | None], dict[str, Any]] = {}
    for event in events[start:]:
        named = read_marker(str(event.get("marker") or ""))
        if named is None:
            continue
        kind = "document" if named.kind == DOCUMENT else "session" if named.paper_id else "chat"
        author = named.paper_id or named.conversation_id
        # A context's only chat is reset under its id when deleted, and the
        # next question reuses it: the generation tells that chat from the one
        # that wrote.
        row = rows.setdefault((kind, author, event.get("chatGeneration")), {
            "kind": kind, "id": author, "firstAt": event.get("createdAt"), "title": None, "note": None,
        })
        note = next((edit.get("note") for edit in event.get("edits") or () if edit.get("slug") == slug), None)
        # The latest pass's note: what this author last did to the page.
        row["note"] = note or row["note"]
        row["title"] = event.get("title") or row["title"]
    for (_, _, generation), row in rows.items():
        if row["kind"] == "chat":
            held = chats.get(row["id"])
            present = held is not None and generation in (None, held[0])
            project_id, live = None, held[1] if present else None
        else:
            present = row["id"] in papers
            project_id, live = papers.get(row["id"], (None, None))
        row.update(removed=not present, projectId=project_id, title=live or row["title"])
    return list(rows.values())


def written_by(
    storage: Storage, username: str, slug: str, library: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """
    `page_authors` for one page, against the library (`list_projects_with_papers`,
    as the page read already holds it) and Memory chats as they stand.

    Only the chats that wrote this page are read, one each: a listing of
    Memory chats reads every conversation the account holds, history and all,
    and this runs each time a page is opened.
    """
    events = storage.page_events(username, slug)
    papers = {
        paper["id"]: (project["id"], paper.get("title"))
        for project in library
        for paper in project.get("papers", [])
    }
    chats: dict[str, tuple[int, str | None]] = {}
    for event in events:
        named = read_marker(str(event.get("marker") or ""))
        if named is None or not named.conversation_id or named.conversation_id in chats:
            continue
        try:
            chat = storage.get_conversation(username, named.conversation_id)
        except HTTPException as error:
            if error.status_code != 404:
                raise
            continue
        # A chat cleared of its last message is the reader's deletion of it.
        if chat.get("messages"):
            chats[named.conversation_id] = (int(chat.get("generation") or 0), chat.get("title"))
    return page_authors(events, slug, papers=papers, chats=chats)
