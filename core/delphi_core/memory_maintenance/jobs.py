"""
The jobs the maintenance pipeline runs: their kinds, markers and fingerprints.

A job is one event to file. Its **marker** names what the event is about, and
is what coalesces a burst into one job and what the event log is checked
against before anything is written twice:

    paper:<id>                   a document was imported, or its digest republished
    paper:<id>:part:<n>          a follow-up, for pages the first job had no room for
    session:paper:<id>           a session beside a document: its chat turns and note changes
    session:conversation:<id>    a session of a Memory chat
    reconcile:<hash>             pages the Memory check found to disagree, by their slugs
    domain:<slug>                a domain's page is owed: its membership, a member's summary or its name changed

A session's job is held while the session is open and is filed once, when it
ends. A domain's job waits for its domain to settle, so a burst of changes is
one composition. What a conversation still owes Memory is read off its watermark
(`unfiled_exchanges`).

Its **fingerprint** is a hash of what the job read. A job completes only when
the record still has the fingerprint the job started with
(`complete_memory_job`), so nothing is marked filed that the pass did not
read, and a republish that changed nothing files nothing.

Pure: no storage, no model. Whoever enqueues a job and whoever runs one both
build the marker and the fingerprint here, so the two cannot spell them apart.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

DOCUMENT, SESSION, RECONCILE, DOMAIN = "document", "session", "reconcile", "domain"

#: Follow-up jobs one document may lead to (§4.4 of the plan): its further
#: pages go to `paper:<id>:part:1` to `:part:3`. A session has none.
DOCUMENT_FOLLOW_UPS = 3


@dataclass(frozen=True)
class Marker:
    """What a marker names, read back from its text."""

    kind: str
    #: The document the event is about. Empty for a Memory chat's session.
    paper_id: str = ""
    #: The conversation, for a Memory chat's session.
    conversation_id: str = ""
    #: 0 for the event's first job; `n` for its nth follow-up.
    part: int = 0


def _name(value: str, what: str) -> str:
    """An id as a marker carries it. A colon would read back as another field."""
    value = str(value or "")
    if not value or ":" in value:
        raise ValueError(f"A job marker needs {what} without a colon in it, and was given {value!r}")
    return value


def document_marker(paper_id: str, part: int = 0) -> str:
    """The marker of a document's job, or of its `part`th follow-up."""
    if part < 0:
        raise ValueError(f"A follow-up is numbered from 1, and was given {part}")
    marker = f"paper:{_name(paper_id, 'a paper id')}"
    return f"{marker}:part:{part}" if part else marker


def capture_marker(paper_id: str) -> str:
    """The marker of a web page's capture job: reading whole a page added at its first window."""
    return f"capture:{_name(paper_id, 'a paper id')}"


def document_family(paper_id: str) -> tuple[str, ...]:
    """Every marker a document's jobs may carry: its own, then its follow-ups in order."""
    return tuple(document_marker(paper_id, part) for part in range(DOCUMENT_FOLLOW_UPS + 1))


def session_marker(*, paper_id: str = "", conversation_id: str = "") -> str:
    """
    The marker of a session's job: beside a document, or a Memory chat.

    Exactly one of the two is named. Every chat tab beside one document and
    every note on it share the document's marker, which is what makes them one
    job.
    """
    if bool(paper_id) == bool(conversation_id):
        raise ValueError("A session is beside a document or is a Memory chat: name exactly one of the two")
    if paper_id:
        return f"session:paper:{_name(paper_id, 'a paper id')}"
    return f"session:conversation:{_name(conversation_id, 'a conversation id')}"


def read_marker(marker: str) -> Marker | None:
    """
    What a marker names, or None when it is not one of this pipeline's.

    Other jobs have markers of their own (`domain:<slug>`, a page rewrite's,
    `reconcile:<hash>`), and none of them is read as a document or a session. Nor is a spelling
    this module does not write, such as `paper:<id>:<anything else>`.
    """
    parts = str(marker or "").split(":")
    if not all(parts):
        return None
    if parts[0] == "paper" and len(parts) == 2:
        return Marker(DOCUMENT, paper_id=parts[1])
    if parts[0] == "paper" and len(parts) == 4 and parts[2] == "part" and parts[3].isdecimal() and int(parts[3]) > 0:
        # Only the spelling `document_marker` writes: `part:01` is not a marker.
        return Marker(DOCUMENT, paper_id=parts[1], part=int(parts[3])) if str(int(parts[3])) == parts[3] else None
    if parts[0] == "session" and len(parts) == 3 and parts[1] == "paper":
        return Marker(SESSION, paper_id=parts[2])
    if parts[0] == "session" and len(parts) == 3 and parts[1] == "conversation":
        return Marker(SESSION, conversation_id=parts[2])
    return None


def follow_up_marker(marker: str) -> str | None:
    """
    The marker of the job that takes what this one had no room for, or None
    when the event has had its follow-ups (or the marker is a session's).

    A session has no numbered parts and no follow-up for pages that had no
    room: its exchanges are settled once read, so a second job would be
    handed nothing. A session longer than one event carries is continued under
    its own marker, by the pipeline.
    """
    named = read_marker(marker)
    if named is None or named.kind != DOCUMENT or named.part >= DOCUMENT_FOLLOW_UPS:
        return None
    return document_marker(named.paper_id, named.part + 1)


def _hash(value: Any) -> str:
    """A hash of a JSON value that does not depend on the order of any mapping's keys."""
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()


def document_fingerprint(digest: Mapping[str, Any]) -> str:
    """
    A document's fingerprint: the content hash of its digest.

    The same digest gives the same hash however its keys are ordered, and any
    change to its text, its evidence index or its figures gives another.
    """
    return _hash(digest)


def session_fingerprint(request_ids: Sequence[str], notes: Mapping[str, str]) -> str:
    """
    A session's fingerprint: the chat requests it covers and the notes it read.

    `request_ids` in the order they were asked; `notes` is note id to the
    update time it was read at. A turn that arrives, a note that is edited and
    a note that is deleted each move it.

    It is used twice, and the two uses are not compared with each other. A
    job's gather hashes everything it read, which names the work in the event
    log (`event.operation_id`). Each change to a session hashes itself alone
    onto the queued row (`session_change`), so the row always names the last
    change; a job completes only if the row still names the change it was
    claimed with.
    """
    return _hash({"requests": [str(item) for item in request_ids], "notes": {str(key): str(value) for key, value in notes.items()}})


def session_change(*, request_id: str = "", note_id: str = "", stamp: str = "") -> str:
    """
    The fingerprint one change to a session stores on its job: a turn that was
    answered, or a note written, edited or deleted at `stamp`.

    Two changes never store the same one, so a change that arrives while a job
    is running is always seen when the job completes.
    """
    return session_fingerprint([request_id] if request_id else [], {note_id: stamp} if note_id else {})


#: A conversation's `memoryFiledThrough` when nothing of it is filed and all of
#: it may be. Null says something else: no turn has been answered since
#: sessions were filed, so there is nothing to file (`unfiled_exchanges`).
FROM_THE_START = ""


def answered(message: Mapping[str, Any]) -> bool:
    """
    Whether a stored message is a whole answer that may be filed: not cut off,
    stopped, interrupted or failed, and not a saved plan, which says what is
    to be built and nothing Memory would hold.
    """
    return (
        message.get("role") == "assistant"
        and bool(message.get("requestId"))
        and not any(message.get(flag) for flag in ("incomplete", "cancelled", "interrupted", "error", "plan"))
    )


def watermark_before(messages: Sequence[Mapping[str, Any]], request_id: str) -> str:
    """
    Where a conversation's filing starts when its first answer since sessions
    were filed is `request_id`: after the last request before it.

    A new conversation has none, and is read from the start. One that was
    held before sessions were filed keeps its history out: old conversations
    are refiled only when a rebuild asks for it.
    """
    return next(
        (str(m["requestId"]) for m in reversed(messages) if m.get("requestId") and m["requestId"] != request_id),
        FROM_THE_START,
    )


def unfiled_exchanges(
    messages: Sequence[Mapping[str, Any]], filed_through: str | None
) -> list[tuple[Mapping[str, Any], Mapping[str, Any]]]:
    """
    Each question with its whole answer that no filing has covered, oldest first.

    `filed_through` is the conversation's watermark. Null is nothing to file,
    and so is a watermark that names a request the conversation no longer
    has: neither is ever read as "file all of it". Messages without a request
    id are in no exchange.
    """
    if filed_through is None:
        return []
    start = 0
    if filed_through != FROM_THE_START:
        at = [index for index, m in enumerate(messages) if m.get("requestId") == filed_through]
        if not at:
            return []
        start = at[-1] + 1
    later = messages[start:]
    questions = {m["requestId"]: m for m in later if m.get("role") == "user" and m.get("requestId")}
    return [(questions[m["requestId"]], m) for m in later if answered(m) and m["requestId"] in questions]


def _slugs(slugs: Iterable[str]) -> list[str]:
    return sorted({str(slug) for slug in slugs if slug})


def reconcile_marker(slugs: Iterable[str]) -> str:
    """
    The marker of the job that reconciles these pages: a hash of their slugs, sorted.

    The same pages give the same marker in whatever order they were named, so
    a disagreement that is found again is the one job, and each set of pages
    that disagree has its own.
    """
    named = _slugs(slugs)
    if len(named) < 2:
        raise ValueError("A disagreement is between at least two pages")
    return f"{RECONCILE}:{_hash(named)[:24]}"


def reconcile_fingerprint(revisions: Mapping[str, int]) -> str:
    """
    A reconcile job's fingerprint: the revision each page was at when they were found to disagree.

    Any of the pages being written again moves it, and what was said about the
    earlier text is then no longer known to be true of the page.
    """
    return _hash({str(slug): int(revision or 0) for slug, revision in revisions.items()})


#: Where a page waits until something says what field it belongs to. It is a
#: place and not a field, so it never has a page of its own.
UNSORTED_DOMAIN = "general"
#: The kinds of page that make a domain worth a page of its own, and the
#: fewest of them a domain page is written from (§6 of the plan).
DOMAIN_MEMBER_KINDS = ("concept", "source")
DOMAIN_MIN_MEMBERS = 3


def domain_marker(slug: str) -> str:
    """The marker of the job that composes one domain's page. Stable, so a burst of changes is one job."""
    return f"{DOMAIN}:{_name(slug, 'a domain slug')}"


def domain_fingerprint(title: str, summary: str, members: Mapping[str, int]) -> str:
    """
    What a domain's page was composed from: the domain's name and each member's slug and revision.

    This is the fingerprint of the job's event, and a job that finds the
    domain's newest event carrying it has nothing to compose. The name is in
    it because a rename changes no member and still owes the page a rewrite.
    """
    return _hash({
        "title": str(title or ""), "summary": str(summary or ""),
        "members": {str(slug): int(revision or 0) for slug, revision in members.items()},
    })


def domain_change(slug: str, stamp: str) -> str:
    """
    The fingerprint a domain's job row carries: the last change that queued it.

    As with a session, the row names the change and not what will be read. A
    job completes against the fingerprint it was claimed with, so a change
    that arrives while the page is being composed keeps the row, and the
    domain is composed once more when it has settled again.
    """
    return _hash({"domain": str(slug), "stamp": str(stamp)})


#: How many times in a row one drain gives back a job whose pages another job
#: moved on (`StaleRevision`) without spending an attempt. A job that keeps
#: meeting other writers past this fails like any other, so no row cycles forever.
STALE_RELEASES = 3
