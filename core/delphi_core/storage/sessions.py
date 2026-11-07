"""
A session's job, as both stores hold it.

A session is what the reader did beside one document (its chat turns in every
tab and the note changes on it) or in one Memory chat. It is filed once, by
one `session` job, when the session ends. Until then every answered turn and
every note change enqueues that job again, in the write that stores the change,
and each enqueue pushes the job's wait forward (`Storage.enqueue_memory_job`).

What is written here is the same in both stores, so the two cannot hold a
session differently: the enqueue itself, where a conversation's filing starts,
and which pages cite a note.
"""

from collections.abc import Iterable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from ..memory_maintenance.jobs import SESSION, answered, session_change, session_marker, watermark_before

#: `Storage.session_idle_seconds` where nothing sets it: `Settings.memory_session_idle_seconds`.
SESSION_IDLE_SECONDS = 1_800.0


def session_job(
    *, idle_seconds: float, project_id: str | None = None, paper_id: str | None = None,
    conversation_id: str | None = None, request_id: str = "", note_id: str = "", stamp: str = "",
) -> dict[str, Any]:
    """
    The arguments of the enqueue one change to a session makes.

    Beside a document the job is the document's (`paper_id` with its project);
    otherwise it is the Memory chat's. The payload's fingerprint names this
    change alone (`session_change`), and the job may not be claimed until the
    idle limit has passed with no further change, unless the session is
    released first (`release_memory_jobs`).
    """
    if paper_id:
        marker = session_marker(paper_id=paper_id)
        about = {"projectId": project_id, "paperId": paper_id}
    else:
        marker = session_marker(conversation_id=conversation_id or "")
        about = {"conversationId": conversation_id}
    return {
        "kind": SESSION,
        "marker": marker,
        "payload": {**about, "fingerprint": session_change(request_id=request_id, note_id=note_id, stamp=stamp)},
        "not_before": (datetime.now(UTC) + timedelta(seconds=max(0.0, idle_seconds))).isoformat(),
    }


def turn_to_file(
    messages: Iterable[Mapping[str, Any]], message: Mapping[str, Any], filed_through: str | None
) -> tuple[bool, str | None]:
    """
    Whether appending `message` holds the session's job, and the conversation's watermark after it.

    Only a whole answer does: a cut-off, stopped or failed one enqueues
    nothing. The first whole answer of a conversation that has no usable
    watermark gives it one that keeps everything before that exchange out
    (`watermark_before`), so a conversation held before sessions were filed
    never has its history filed by a later turn.
    """
    if not answered(message):
        return False, filed_through
    messages = list(messages)
    known = filed_through is not None and (
        not filed_through or any(m.get("requestId") == filed_through for m in messages)
    )
    return True, filed_through if known else watermark_before(messages, str(message["requestId"]))


def note_holders(pages: Iterable[Mapping[str, Any]], paper_id: str) -> dict[str, list[str]]:
    """Which pages cite each note of one document: `{note id: [slug, ...]}`, read off the pages' citations."""
    holders: dict[str, list[str]] = {}
    for page in pages:
        cited = {
            str(c["noteId"]) for c in page.get("citations") or ()
            if c.get("noteId") and c.get("paperId") == paper_id
        }
        for note_id in sorted(cited):
            holders.setdefault(note_id, []).append(page["slug"])
    return {note_id: sorted(slugs) for note_id, slugs in holders.items()}
