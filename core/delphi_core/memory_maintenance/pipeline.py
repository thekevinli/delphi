"""
The order of the stages of one maintenance job, and nothing else.

    gather → select → maintain → verify (one repair) → commit

While web evidence is on, gather has two more parts that ask a model
(`gather_outside.py`): a session whose answers cited the web has those pages
re-grounded before the selection, and a selection that names a question a
published source could settle has it looked up before the agent starts. Both
only add captured sources to the evidence set; while the setting is off
neither runs.

`run_job` is what the drain runs for a claimed `document`, `session`,
`reconcile` or `domain` job. Gather differs by kind, and a `domain` job has the
composer where the others have select and maintain. It is the only
module that imports the stages, and each stage is handed what the one before
returned (`run.py`). What it adds is the order, and four rules no single stage
can hold:

- **One deadline** (`Settings.memory_job_deadline_seconds`). Every stage is
  given the time that is left. A job that runs out ends `failed` with the
  reason `deadline` (`JobDeadline`) and is retried like any other failure.
- **A job that already committed is not run again.** After gather, the job's
  operation id (its id, the version it was queued for and the fingerprint it
  read) is looked up in the event log, and a job found there answers `reused`
  before any model is asked.
- **The verdict is per page.** Pages the checker passes commit together. A
  blocked page gets one repair by the same agent run and is checked again; a
  page still blocked, or one the repair left as it was, is dropped by itself
  and named in the event. A job whose every page was dropped ends `failed`.
- **A `reconcile` job asks no selection.** Its pages are the ones the Memory
  check found to disagree, already open as the agent's start pages, and the
  same-idea question is still asked if the agent creates a page.
- **What had no room goes to a follow-up job.** When the agent was turned away
  because the run had staged its pages, a document's event is queued once more
  under its next marker (`jobs.follow_up_marker`). A session has no numbered
  parts and needs none for that: its exchanges are settled once read, and a
  second run would be handed nothing. What it does continue is a session
  longer than one event carries, or one whose notes wait for a run of their
  own (`EvidenceSet.more`): the same marker is enqueued again, and the next run
  reads on from the watermarks this one left. A job answered `reused` does
  this too, since the run that committed may have died before it could.

A `session` job has three more rules:

- **It completes against the change it was claimed with**, not against what it
  read. Every change to a session stores its own fingerprint on the job's row
  (`jobs.session_change`), so a turn or a note that arrived after the claim
  keeps the row, and the next run finds it past the watermark.
- **A session with nothing left in it ends without a trace**: no event and no
  model call. The reader retracted the turn, deleted the chat or the note, or
  an earlier run already read everything.
- **A deleted note that pages still cite, or an edited one, is always given
  to the agent with those pages**, whatever the selection says: only the agent
  can remove a claim, or make a page say what the note says now.

A `domain` job composes one page, the domain's own (`domain.py`):

    gather → compose → verify (one repair) → commit

- **No selection.** The page is known before the job starts, and whether there
  is anything to compose is gather's to say. A domain with nothing owed ends
  as a session with nothing left does: no event, no model call.
- **It completes against the change it was claimed with**, like a session, so
  a change to the domain that arrives while its page is composed keeps the
  row for one more pass.
- **A page the checker still blocks after its repair is dropped**, and the
  domain keeps the page it had.

It yields `progress` events as each stage starts, which is where the drain
checks that the job is still wanted, and last of all one `_memory_result`.
The result names the `fingerprint` the job read, which is what the drain
completes the job against (`complete_memory_job`).
"""

from __future__ import annotations

import asyncio
from dataclasses import replace
import logging
import time
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

import httpx

from ..config import Settings
from ..harness.provider import ResponsesClient
from ..memory import MEMORY_VERSION
from ..memory_harness import selection_index
from ..sse import run_durable_write
from ..storage import ObjectStore, Storage
from ..storage.base import utc_now
from .commit import commit
from .commit_session import settle, stamp_notes
from .domain import compose
from .domain import repair as repair_domain
from .event import operated_on, operation_id
from .gather import gather_document
from .gather_domain import gather_domain
from .gather_outside import PASS_TIMEOUT_SECONDS, keep, look_outside, looks_outside, reground
from .gather_reconcile import gather_reconcile, neighbourhood
from .gather_session import gather_session
from .jobs import DOCUMENT, DOMAIN, RECONCILE, SESSION, follow_up_marker, session_change
from .maintain import author, repair
from .run import Authored, Dropped, JobDeadline, Objection, Selection, Verdicts
from .select import same_idea, select_pages
from .agent import stored_pages
from .verify_round import checked, refuse_taken

logger = logging.getLogger(__name__)

#: The newest events of an account read for the part of a session before this one.
WITHHELD_LOOKBACK = 200
#: The most one cheap call over the index may take, whatever the job has left.
SELECT_TIMEOUT_SECONDS = 120.0
#: Time kept back from the agent's loop for the check, the repair and the commit.
RESERVED_AFTER_AUTHORING_SECONDS = 180.0
#: The least the agent's loop is given once a job has got as far as starting it.
AUTHORING_FLOOR_SECONDS = 30.0


#: The one stage that differs by the kind of job.
_GATHER = {DOCUMENT: gather_document, SESSION: gather_session, RECONCILE: gather_reconcile, DOMAIN: gather_domain}


class EveryPageDropped(Exception):
    """Every page the job staged was dropped. The event says which and why; the job ends `failed`."""


class _Clock:
    """The job's one deadline: how long is left, and the failure when nothing is."""

    def __init__(self, seconds: float) -> None:
        self._ends = time.monotonic() + seconds if seconds > 0 else None

    def left(self, stage: str, most: float | None = None) -> float:
        if self._ends is None:
            return most if most is not None else 0.0
        remaining = self._ends - time.monotonic()
        if remaining <= 0:
            raise JobDeadline(f"deadline: the job ran out of time before {stage}")
        return min(remaining, most) if most is not None else remaining


def _continue_session(
    storage: Storage, username: str, job: Mapping[str, Any], evidence: Any, *, always: bool = False,
) -> None:
    """
    Queue the rest of a session that one run could not file (`EvidenceSet.more`).
    No wait is named: the reader has left, and the job's row is kept because
    its fingerprint moved (`complete_memory_job`).
    """
    if evidence.more or always:
        # A stamp of its own each time: a continuation that wrote the value the
        # job was claimed with would not keep the row (`complete_memory_job`).
        storage.enqueue_memory_job(
            username, kind=SESSION, marker=str(job["marker"]),
            payload={"fingerprint": session_change(note_id="more", stamp=f"{job.get('id')}:{utc_now()}")},
        )


def _withheld(
    storage: Storage, username: str, job: Mapping[str, Any], evidence: Any, authored: Authored | None,
    pages: Sequence[Any] = (), dropped: Sequence[Dropped] = (),
) -> tuple[str, ...]:
    """
    Edited notes not to stamp as filed: a page that cites one is not being
    written, because the agent was turned away from it or the check dropped
    it, so it still says what the note used to. The session is continued for
    them. A note the committed part before also withheld is stamped this time,
    so that a page that will not be written cannot keep a session going for
    ever; a failed attempt of this part is not that part.
    """
    written = {page.slug for page in pages}
    away = (set(authored.draft.turned_away if authored is not None else ()) | {item.slug for item in dropped}) - written
    held = tuple(note for note, slugs in evidence.refiled_notes.items() if away & set(slugs))
    if not held:
        return ()
    committed = next(
        (event for event in storage.list_memory_events(username, limit=WITHHELD_LOOKBACK)
         if event.get("marker") == job["marker"] and event.get("outcome") != "failed"),
        {},
    )
    again = set(committed.get("withheld") or ())
    if again & set(held):
        logger.warning("filing the edited notes %s of %s although pages citing them were turned away twice",
                       sorted(again & set(held)), job["marker"])
    return tuple(note for note in held if note not in again)


def _progress(stage: str, message: str, started: float) -> dict[str, Any]:
    return {"type": "progress", "stage": stage, "message": message, "elapsedMs": round((time.monotonic() - started) * 1000)}


async def run_job(
    job: Mapping[str, Any],
    *,
    http: httpx.AsyncClient,
    storage: Storage,
    objects: ObjectStore,
    username: str,
    settings: Settings,
    use_standard_tier: bool,
) -> AsyncIterator[dict[str, Any]]:
    """Run one claimed job of a kind the pipeline files to its commit (see the module docstring)."""
    if job["kind"] not in _GATHER:
        raise ValueError(f"The maintenance pipeline does not run {job['kind']!r} jobs")
    session, composing = job["kind"] == SESSION, job["kind"] == DOMAIN
    started = time.monotonic()
    clock = _Clock(settings.memory_job_deadline_seconds)
    client = ResponsesClient(http, settings)
    selection: Selection | None = None
    authored: Authored | None = None
    verdicts: Verdicts | None = None
    dropped: list[Dropped] = []

    yield _progress("memory_gather", "Reading what there is to file", started)
    evidence = await asyncio.to_thread(_GATHER[job["kind"]], storage, objects, username, settings, job)
    # What the drain completes the job against (see the module docstring).
    read = (job.get("payload") or {}).get("fingerprint") if session or composing else evidence.fingerprint
    if evidence.settled or (session and not (evidence.request_ids or evidence.notes or evidence.gone_notes)):
        yield {"type": "_memory_result", "pages": [], "outcome": "nothing", "reused": False, "fingerprint": read}
        return
    operation = operation_id(job, operated_on(job, evidence))
    if operation and await asyncio.to_thread(storage.has_memory_event, username, job["marker"], operation_id=operation):
        # The job committed and died before it was settled or removed: finish
        # what its commit would have done after the store.
        committed = (await asyncio.to_thread(storage.latest_marker_events, username, [job["marker"]])).get(job["marker"]) or {}
        stamped = await asyncio.to_thread(stamp_notes, storage, username, evidence, committed.get("notes") or {})
        await asyncio.to_thread(settle, storage, username, evidence)
        if stamped is None:
            # Tried again: the next claim answers `reused` again, with no model call.
            raise RuntimeError(f"the notes {job['marker']} filed could not be stamped")
        if session:
            # What its commit left for later is not read off a second reading,
            # which the commit changed: the rest is queued, and a part with
            # nothing in it ends without a trace.
            await asyncio.to_thread(_continue_session, storage, username, job, evidence, always=True)
        yield {"type": "_memory_result", "pages": [], "reused": True, "fingerprint": read}
        return

    if evidence.web_cited and not evidence.skipped:
        yield _progress("memory_outside", "Checking the web pages the answers cited", started)
        evidence = await reground(http, settings, evidence, timeout=clock.left("re-grounding", PASS_TIMEOUT_SECONDS))

    common = {"storage": storage, "objects": objects, "username": username, "use_standard_tier": use_standard_tier}
    mend: Any = None
    still_new: Any = None
    # What Memory held when this run began to read it: a page created since is another job's.
    known = frozenset(page.slug for page in await asyncio.to_thread(stored_pages, storage, username, settings))
    if composing and not evidence.skipped:
        yield _progress("memory_domain", f"Writing how the pages of {evidence.title or 'this domain'} connect", started)
        authored = await compose(
            client, settings, evidence=evidence, **common,
            deadline_seconds=max(AUTHORING_FLOOR_SECONDS, clock.left("composing") - RESERVED_AFTER_AUTHORING_SECONDS),
        )

        async def mend_page(authored: Authored, objections: list[Objection], seconds: float) -> Authored:
            return await repair_domain(
                client, settings, authored=authored, evidence=evidence, objections=objections, deadline_seconds=seconds, **common
            )

        mend = mend_page

    elif not evidence.skipped:
        graph, _, index_text, _ = await asyncio.to_thread(selection_index, storage, username, settings)
        if job["kind"] == RECONCILE:
            # The pages are the ones found to disagree, and that there is
            # something to settle is why the job exists: nothing to ask. The
            # event records no selection, since none was made.
            leads = Selection(nothing_to_file=False)
        else:
            yield _progress("memory_select", f"Deciding where {evidence.title or 'this'} belongs in Memory", started)
            last = (await asyncio.to_thread(storage.latest_marker_events, username, [job["marker"]])).get(job["marker"]) or {}
            try:
                selection = await select_pages(
                    client, settings, index_text=index_text, graph=graph, evidence=evidence, username=username,
                    timeout=clock.left("the selection", SELECT_TIMEOUT_SECONDS), use_standard_tier=use_standard_tier,
                    filed_before=last.get("outcome") == "filed",
                )
            except TimeoutError as error:
                raise JobDeadline("deadline: the selection did not answer in time") from error

            noted = (*evidence.gone_notes.values(), *evidence.refiled_notes.values())
            if selection.nothing_to_file and noted:
                selection = Selection(
                    nothing_to_file=False, reason=selection.reason, usage=selection.usage,
                    pages=tuple(dict.fromkeys(slug for slugs in noted for slug in slugs)),
                )
            leads = selection
            if not leads.nothing_to_file and leads.needs_outside and looks_outside(settings):
                yield _progress("memory_outside", "Looking outside the library for what this leaves open", started)
                evidence = await look_outside(
                    http, settings, evidence, leads.needs_outside,
                    timeout=clock.left("the research pass", PASS_TIMEOUT_SECONDS),
                )
        if not leads.nothing_to_file:
            if job["kind"] in (DOCUMENT, SESSION):
                # What the pages near the start already cite may be cited too, where they cite it.
                evidence = await asyncio.to_thread(
                    neighbourhood, storage, objects, username, settings, graph, evidence,
                    (*evidence.start_slugs, *leads.pages),
                )

            async def ask_same_idea(title: str, aliases: list[str], summary: str) -> list[str]:
                return await same_idea(
                    client, settings, index_text=index_text, graph=graph, title=title, aliases=aliases, summary=summary,
                    username=username, timeout=clock.left("the same-idea check", SELECT_TIMEOUT_SECONDS),
                    use_standard_tier=use_standard_tier,
                )

            async def mend_pages(authored: Authored, objections: list[Objection], seconds: float) -> Authored:
                return await repair(
                    client, settings, authored=authored, objections=objections, same_idea=ask_same_idea,
                    deadline_seconds=seconds, **common,
                )

            mend = mend_pages

            async def explained_since(draft: Any, known: Any) -> list[str]:
                """Pages this run creates that a concept page another job wrote meanwhile may already explain."""
                fresh = {page.slug for page in await asyncio.to_thread(stored_pages, storage, username, settings)
                         if page.slug not in known and page.kind == "concept"}
                creates = [page for page in draft.staged if page.action == "create" and page.kind == "concept"]
                if not fresh or not creates:
                    return []
                now, _, text, _ = await asyncio.to_thread(selection_index, storage, username, settings)
                found = []
                for page in creates:
                    try:
                        named = await same_idea(
                            client, settings, index_text=text, graph=now, title=page.title, aliases=list(page.aliases),
                            summary=page.summary, username=username, use_standard_tier=use_standard_tier,
                            timeout=clock.left("the same-idea check", SELECT_TIMEOUT_SECONDS),
                        )
                    except Exception:
                        # A question that cannot be answered now is "none": the
                        # commit still refuses a slug another job took (`_stale`),
                        # and a checked page is not lost to a failed courtesy call.
                        logger.warning("could not ask whether a new page of another job explains %s", page.slug, exc_info=True)
                        continue
                    found += [page.slug] if fresh & set(named) else []
                return found

            still_new = explained_since

            yield _progress("memory_maintain", "Reading Memory and writing what belongs in it", started)
            authored = await author(
                client, settings, evidence=evidence, selection=leads, same_idea=ask_same_idea, **common,
                deadline_seconds=max(AUTHORING_FLOOR_SECONDS, clock.left("authoring") - RESERVED_AFTER_AUTHORING_SECONDS),
            )
            dropped = list(authored.dropped)
            if authored.ended == "deadline" and not authored.draft.staged:
                raise JobDeadline("deadline: the agent ran out of time with nothing staged")

    if authored is not None and authored.draft.staged:
        yield _progress("memory_verify", "Checking what was written against its sources", started)
        # Another job may have created what this run means to create while it wrote.
        await refuse_taken(storage, username, settings, authored.draft, known, still_new)
        authored, verdicts, blocked = await checked(
            client, settings, clock.left, authored, evidence, mend=mend, storage=storage, username=username,
            known=known, use_standard_tier=use_standard_tier,
        )
        dropped += blocked

    pages = list(authored.draft.staged) if authored else []
    yield _progress("memory_commit", "Filing" if pages else "Recording that nothing was filed", started)
    clock.left("the commit")
    if authored is not None and pages:
        await refuse_taken(storage, username, settings, authored.draft, known, still_new)
    if evidence.captured and pages:
        await asyncio.to_thread(keep, storage, objects, username, evidence, pages)
    withheld = await asyncio.to_thread(_withheld, storage, username, job, evidence, authored, pages, dropped)
    if withheld:
        evidence = replace(
            evidence, notes={key: value for key, value in evidence.notes.items() if key not in withheld}, withheld=withheld,
        )
    done = await run_durable_write(
        commit, storage, username, settings, job=job, evidence=evidence, selection=selection, pages=pages,
        dropped=dropped, verdicts=verdicts, authored=authored,
    )
    if done["outcome"] == "failed":
        raise EveryPageDropped("; ".join(f"{item.title}: {item.reason}" for item in dropped))
    if session:
        await asyncio.to_thread(_continue_session, storage, username, job, evidence, always=bool(withheld))
    turned_away = authored.draft.turned_away if authored else []
    if turned_away and (marker := follow_up_marker(str(job["marker"]))):
        payload = job.get("payload") or {}
        await asyncio.to_thread(
            lambda: storage.enqueue_memory_job(
                username, kind=DOCUMENT, marker=marker,
                payload={key: payload[key] for key in ("projectId", "paperId") if payload.get(key)},
                target_version=payload.get("targetVersion") or MEMORY_VERSION,
            )
        )
    yield {
        "type": "_memory_result", "pages": done.get("pages", []), "figures": done.get("figures", []),
        "event": done.get("event"), "outcome": done["outcome"], "method": None, "reused": False,
        "fingerprint": read,
    }
