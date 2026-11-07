"""
The event one maintenance job leaves in the log, built from what its stages returned.

A job ends one of three ways, and each leaves an event:

- `filed`: at least one page is written. The event is the job's marker, so
  the same event is never filed twice.
- `nothing`: a valid run found nothing worth filing. No page is written and
  the event still carries the marker, so the job is settled.
- `failed`: pages were staged and every one was dropped. Nothing is written.
  The event lists the dropped targets for Health, and it does **not** carry
  the job's marker as its `requestId` (`request_id`): the marker says "this
  is done", and a failed job is tried again.

Every event names the job's marker as `marker`, whatever its `requestId`.

Nothing here reads storage or calls a model.
"""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Mapping, Sequence
from typing import Any

from .run import Authored, Dropped, EvidenceSet, Outcome, Selection, Verdicts
from .staging import StagedPage

SUMMARY_MAX_CHARS = 600
#: Advisory objections an event keeps in full, for the sample a person labels.
#: The count is always the whole number.
ADVISORY_KEPT = 12
QUOTE_MAX_CHARS = 400
EXPLANATION_MAX_CHARS = 400
NOTHING_WORTH_FILING = "Nothing in this event was worth filing."


def _clip(text: str, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def outcome_of(pages: Sequence[StagedPage], dropped: Sequence[Dropped]) -> Outcome:
    """How a job ended, from the pages that passed and the pages that were dropped."""
    if pages:
        return "filed"
    return "failed" if dropped else "nothing"


def trigger_of(kind: str, evidence: EvidenceSet) -> str:
    """What caused the revisions this job writes, as version history names it."""
    if kind in ("document", "reconcile", "domain"):
        return kind
    return "conversation" if evidence.request_ids else "notes"


def operated_on(job: Mapping[str, Any], evidence: EvidenceSet) -> str:
    """
    The fingerprint a job's operation names: what it read, or, for a session,
    the change it was claimed with. A session's own commit can take off the
    citations a second reading would find (a deleted note's), so a job that
    committed and died would read differently and could not be recognised.
    """
    if job.get("kind") == "session" and (job.get("payload") or {}).get("fingerprint"):
        return str(job["payload"]["fingerprint"])
    return evidence.fingerprint


def operation_id(job: Mapping[str, Any], fingerprint: str) -> str | None:
    """
    The exact request a job answers: its id, the version it was queued for and what it read.

    `has_memory_event(marker, operation_id=…)` then finds the event of a
    job that committed and died before it was removed from the queue, and the
    pipeline answers `reused` without a model call. The fingerprint is part of
    it because a job whose record changed while it ran keeps its row and its
    id (`complete_memory_job`): the next run reads something else and must
    not be taken for the one that already committed.
    """
    if not job.get("id"):
        return None
    payload = job.get("payload") or {}
    return json.dumps([job["id"], payload.get("targetVersion"), fingerprint], separators=(",", ":"))


def request_id(job: Mapping[str, Any], outcome: Outcome) -> str:
    """The event's `requestId`: the job's marker, unless the job failed (see the module docstring)."""
    if outcome == "failed":
        return f"{job['marker']}:dropped:{job.get('attempts', 0)}"
    return str(job["marker"])


def _summary(
    outcome: Outcome, evidence: EvidenceSet, selection: Selection | None, pages: Sequence[StagedPage],
    dropped: Sequence[Dropped], authored: Authored | None,
) -> str:
    closing = authored.closing if authored else ""
    if outcome == "filed":
        return closing or "; ".join(page.note for page in pages if page.note)
    if outcome == "failed":
        return "Nothing was written: " + ", ".join(f"{item.title} ({item.reason})" for item in dropped)
    if selection is not None and selection.nothing_to_file and selection.reason:
        return selection.reason
    return evidence.skipped or closing or NOTHING_WORTH_FILING


def build_event(
    *,
    job: Mapping[str, Any],
    version: str,
    evidence: EvidenceSet,
    selection: Selection | None,
    pages: Sequence[StagedPage],
    dropped: Sequence[Dropped],
    verdicts: Verdicts | None,
    authored: Authored | None,
) -> dict[str, Any]:
    """The event for one job. `pages` are the staged pages being written, as they are written."""
    outcome = outcome_of(pages, dropped)
    payload = job.get("payload") or {}
    operation = operation_id(job, operated_on(job, evidence))
    advisory = verdicts.advisory if verdicts else ()
    event: dict[str, Any] = {
        "kind": job["kind"],
        "version": version,
        "requestId": request_id(job, outcome),
        "marker": job["marker"],
        **({"operationId": operation} if operation else {}),
        "projectId": evidence.project_id or payload.get("projectId") or None,
        "paperId": evidence.paper_id or payload.get("paperId") or None,
        # Who wrote it, by the name the reader knew it by (`EvidenceSet.author`).
        **({"title": evidence.author} if evidence.author else {}),
        **({"chatGeneration": evidence.chat_generation} if evidence.chat_generation is not None else {}),
        "outcome": outcome,
        "summary": _clip(_summary(outcome, evidence, selection, pages, dropped, authored), SUMMARY_MAX_CHARS),
        "pages": [page.slug for page in pages],
        # A page the check dropped keeps why it was not struck instead, and the page as staged.
        "dropped": [
            {"slug": item.slug, "title": item.title, "action": item.action,
             "reason": _clip(item.reason, EXPLANATION_MAX_CHARS), "quote": _clip(item.quote, QUOTE_MAX_CHARS),
             **({"unstruck": item.unstruck} if item.unstruck else {}),
             **({"body": item.body} if item.body else {}),
             **({"summary": item.summary} if item.summary else {})}
            for item in dropped
        ],
        # Each new page that was let past the same-idea check on the author's word.
        "distinct": [
            {"slug": page.slug, "from": list(page.distinct_from), "reason": page.distinct_reason}
            for page in pages if page.action == "create" and page.distinct_from
        ],
        "selection": {
            "pages": list(selection.pages), "reason": _clip(selection.reason, SUMMARY_MAX_CHARS),
            "nothingToFile": selection.nothing_to_file, "needsOutside": selection.needs_outside,
        } if selection is not None else None,
        # Claims given the passages of their document that hold them, before any repair.
        "recited": [dict(item) for item in verdicts.recited] if verdicts is not None else [],
        # Every objection that blocked a page, in either check.
        "blocked": [
            {**item, "quote": _clip(item.get("quote"), QUOTE_MAX_CHARS),
             "explanation": _clip(item.get("explanation"), EXPLANATION_MAX_CHARS)}
            for item in (verdicts.blocked if verdicts is not None else ())
        ],
        "advisory": {
            "count": len(advisory),
            "objections": [
                {"slug": item.slug, "finding": item.finding, "quote": _clip(item.quote, QUOTE_MAX_CHARS),
                 "explanation": _clip(item.explanation, EXPLANATION_MAX_CHARS), "evidenceId": item.evidence_id}
                for item in advisory[:ADVISORY_KEPT]
            ],
        },
        "fingerprint": evidence.fingerprint,
        "requestIds": list(evidence.request_ids),
        # The notes the job read, at the update time read: what a `reused` answer stamps.
        "notes": dict(evidence.notes),
        **({"withheld": list(evidence.withheld)} if evidence.withheld else {}),
        "telemetry": {
            "select": dict(selection.usage) if selection is not None else {},
            "maintain": dict(authored.usage) if authored is not None else {},
            "verify": dict(verdicts.usage) if verdicts is not None else {},
            "rounds": authored.rounds if authored is not None else 0,
            "ended": authored.ended if authored is not None else None,
            # What the author called, and which pages or sections of its document it asked to read.
            "tools": dict(Counter(str(entry.get("tool")) for entry in (authored.trace if authored is not None else ()))),
            "asked": sorted({
                str(where) for entry in (authored.trace if authored is not None else ())
                for where in (
                    (entry.get("args") or {}).get("pages") or () if entry.get("tool") == "read_paper"
                    else [(entry.get("args") or {}).get("anchor")] if entry.get("tool") == "read_webpage" else ()
                ) if where
            }, key=lambda where: (not where.isdigit(), int(where) if where.isdigit() else 0, where)),
        },
    }
    if evidence.record:
        event["read"] = dict(evidence.record)
    if evidence.outside:
        # What the job's research passes did: hosted calls, captures, and what was dropped and why.
        event["outside"] = dict(evidence.outside)
    if not pages:
        # The store fills `edits` from the pages it wrote; with none, say so here.
        event["edits"] = []
    return event
