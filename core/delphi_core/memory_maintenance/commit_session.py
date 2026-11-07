"""
What a session's commit does that a document's does not.

**A deleted note leaves nothing that rested only on it.** The agent is told
which pages cite a note the reader deleted, and is refused a page that still
cites one or keeps the words of what rested only on it (`admit.stage_edit`). A
page it did not rewrite, or whose rewrite the checker dropped, is repaired
here without a model, in the same commit as the job's other pages
(`reader_notes.without_notes`): a statement that cited only the note and
Delphi's inference goes, and the note's citation comes off what stays, which
also cites a document and is the next edit's to judge. What never stays is a
citation that opens nothing.

The one exception is a page that would be left with no statement at all: the
pipeline deletes no page, so its words stay, uncited, and a warning is logged.

**Notes are stamped filed after the commit** (`stamp_notes`), only those
still at the update time the job read; a job answered `reused` stamps what
its event recorded. **The session is settled after the commit** (`settle`). Each conversation's
watermark moves to the last request the job read there, if the conversation
still holds that request: a turn the reader retracted while the job ran is
never named by a watermark, and a turn that arrived meanwhile is past it and
is filed by the next job. This runs for `filed` and for `nothing`, since the
session was considered either way, and never for `failed`.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from typing import Any

from ..storage import Storage
from ..storage.base import utc_now
from .blocks import statements
from .reader_notes import without_notes, withdrawn
from .run import EvidenceSet
from .staging import StagedPage

logger = logging.getLogger(__name__)

UNCITED_NOTE = "Took out the citation of a note the reader deleted."
WITHDRAWN_NOTE = "Took out what rested only on a note the reader deleted, and its citation."


def without_gone_notes(
    storage: Storage, username: str, evidence: EvidenceSet, pages: Sequence[StagedPage]
) -> list[StagedPage]:
    """The pages that still cite a deleted note and are not being written, each as an edit that takes the citation off."""
    written = {page.slug for page in pages}
    repairs: list[StagedPage] = []
    for slug in dict.fromkeys(slug for slugs in evidence.gone_notes.values() for slug in slugs):
        if slug in written:
            continue
        try:
            stored: dict[str, Any] = storage.get_memory_page(username, slug)
        except Exception:
            continue
        citations = list(stored.get("citations") or ())
        if stored.get("kind") != "concept" or not any(c.get("noteId") in evidence.gone_notes for c in citations):
            continue
        before = stored.get("body") or ""
        body, kept = without_notes(before, citations, evidence.gone_notes)
        note = WITHDRAWN_NOTE if withdrawn(before, citations, evidence.gone_notes) else UNCITED_NOTE
        if not statements(body):
            logger.warning("withdrawing deleted notes would leave %s with no statement; its words stay", slug)
            body, kept = without_notes(before, citations, evidence.gone_notes, withdraw=False)
            note = UNCITED_NOTE
        repairs.append(StagedPage(
            slug=slug, action="edit", revision=int(stored.get("revision") or 0), title=stored.get("title") or slug,
            aliases=tuple(stored.get("aliases") or ()), domain=stored.get("domain") or "", summary=stored.get("summary") or "",
            body=body, citations=tuple(kept), figures=tuple(stored.get("figures") or ()), note=note,
        ))
    return repairs


def stamp_notes(
    storage: Storage, username: str, evidence: EvidenceSet, notes: Mapping[str, str] | None = None,
) -> list[str] | None:
    """
    Stamp the notes the job read that have not changed since, and return them.

    Run after the commit, and again by a job answered `reused`, whose earlier
    run may have died between its commit and this: that one passes the notes
    its event recorded (`notes`), since a second reading may take others.
    Never raises; None says the stamp could not be made, and an unstamped
    note is read again.
    """
    read = evidence.notes if notes is None else notes
    if not read or not evidence.paper_id:
        return []
    try:
        now = {
            note["id"]: note.get("updatedAt")
            for note in storage.list_notes(username, evidence.project_id, evidence.paper_id)
        }
        unchanged = [note_id for note_id, read_at in read.items() if note_id in now and now[note_id] == read_at]
        if unchanged:
            storage.mark_notes_filed(username, evidence.project_id, evidence.paper_id, unchanged, utc_now())
        return unchanged
    except Exception:
        logger.warning("could not stamp the notes of %s as filed", evidence.marker, exc_info=True)
        return None


def settle(storage: Storage, username: str, evidence: EvidenceSet) -> list[str]:
    """
    Move each conversation's watermark to the last request the job read there.

    Returns the conversations whose watermark moved. Never raises: an
    exchange left unsettled is read again by the next job of the session,
    which is the safe direction to fail in.
    """
    moved = []
    for conversation_id, request_id in evidence.filed_through.items():
        try:
            if storage.set_memory_filed_through(username, conversation_id, request_id, if_present=True):
                moved.append(conversation_id)
        except Exception:
            logger.warning("could not settle conversation %s of %s", conversation_id, evidence.marker, exc_info=True)
    return moved
