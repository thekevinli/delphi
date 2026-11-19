"""
A staged page's way through the check: check, re-cite, repair, strike, check what changed.

`pipeline.run_job` hands what the author staged to `checked`, which returns
the pages that passed, the record of every check and what was dropped:

1. **Is any name taken?** Jobs run side by side. A page this run means to
   create whose name another job gave a page since this run read Memory, or
   that another job's new page may explain (`still_new`), is not checked: the
   job ends `StaleRevision` and runs again at once, against the Memory that
   now has that page. The names are asked again before the repair and before
   the commit, because a repair told to write a page whose name was taken
   is refused, and the page was then lost over one sentence.
2. **The first check** reads every staged page whole (`verify.verify`).
3. **The re-cite** gives a blocked claim the passage of its document that
   holds it (`verify_recite`).
4. **The repair**: the author, resumed, answers what stands (`mend`).
5. **The strike**: a page whose repair was refused or changed nothing has the
   claims the objections quote taken out of its new text
   (`verify_again.strike`).
6. **Later checks** are shown only what changed since the first passed the
   rest (`verify_again`), and a verdict belongs to a claim: an objection to a
   claim an earlier check passed in the same words is advice
   (`verify_claims.already_passed`). What a later check still objects to is
   re-cited first, as after the first check, and what no passage holds is
   struck. The second check is followed by a third that reads what changed;
   the third, the last (`LAST_CHECK`), re-cites nothing and strikes what it
   still blocks. A page is dropped only when a strike is refused: the claim is
   in its summary, or striking it could damage what the reader sees, or
   strikes would take more than `STRIKE_MAX_SHARE` of its new text after its
   first. A job whose every page is dropped ends `failed`. (Round 5b struck
   three true claims at the second check, which then tried no re-cite; the
   Chimera paper lost a page over one clause two checks had passed, which the
   third refused with no recourse.)

Nothing is committed that a check has not passed: what a later check is not
shown, an earlier one passed, and a strike only takes text out. What the last
check strikes is not read again: a strike takes a claim whole, with the
sentences that lean on it.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Awaitable, Callable, Collection, Mapping, Sequence
from typing import Any

from ..config import Settings
from ..harness.provider import ResponsesClient
from .admit import name_problem
from .agent import stored_pages
from .reader_notes import parted
from .run import Authored, Dropped, EvidenceSet, Objection, StaleRevision, Verdicts
from .staging import MemoryDraft
from .verify import verify
from .verify_again import Refused, strike
from .verify_recite import Recited, reapply, recite

#: The most asking where a document says the claims words could not place may take.
FIND_TIMEOUT_SECONDS = 120.0
UNCHANGED_BY_REPAIR = "The agent was asked to repair this page and left it as it was."
#: How many checks a page may be given. After the last, what is still blocked is struck, not checked again.
LAST_CHECK = 3
#: The most of a page's new text that strikes may take, all told, measured
#: against the page as it stood before its first strike. A first strike is
#: bounded only by the strike's own rules, which keep a cited block; a later
#: one that takes the page past this leaves a page that is not the one the
#: author wrote, and the page is dropped instead.
STRIKE_MAX_SHARE = 1 / 3

#: How much time is left for a step, at most the second argument (`pipeline._Clock.left`).
Clock = Callable[..., float]
#: Whether another job's new page may explain a page this run creates: its slugs, or none.
StillNew = Callable[[MemoryDraft, Collection[str]], Awaitable[list[str]]]


def taken(storage: Any, username: str, settings: Settings, draft: MemoryDraft, known: Collection[str]) -> list[str]:
    """Pages this run creates whose name a page stored since `known` was read already has. Blocking."""
    since = [page for page in stored_pages(storage, username, settings) if page.slug not in known]
    return [
        page.slug for page in draft.staged
        if page.action == "create" and page.kind == "concept" and name_problem([page.title, *page.aliases], since)
    ]


async def refuse_taken(
    storage: Any, username: str, settings: Settings, draft: MemoryDraft, known: Collection[str], still_new: StillNew | None = None,
) -> None:
    """Raise `StaleRevision` when another job took a name, or wrote the idea, of a page this run creates."""
    found = await asyncio.to_thread(taken, storage, username, settings, draft, known)
    if not found and still_new is not None:
        found = await still_new(draft, known)
    if found:
        raise StaleRevision(found)


def _dropped(page: Any, objections: Sequence[Objection], unstruck: str) -> Dropped:
    first = objections[0] if objections else None
    return Dropped(
        page.slug, page.title, page.action,
        first.explanation if first else UNCHANGED_BY_REPAIR, first.quote if first else "",
        unstruck=unstruck, body=page.body, summary=page.summary,
    )


#: A claim on a page: its slug and the quote objected to.
Quoted = tuple[str, str]


class _Outcome:
    """What came of one check's blocking objections: the claims re-cited after it, and those struck."""

    def __init__(self, recited: Sequence[Recited] = ()) -> None:
        self.recited: set[Quoted] = {(item.slug, item.quote) for item in recited}
        self.struck: set[Quoted] = set()


def _blocked(verdicts: Verdicts, check: int, came: _Outcome) -> tuple[dict[str, Any], ...]:
    """
    The objections that blocked a page in one check, as the event keeps them,
    with what came of each after that check. A claim the second check objects
    to again was re-cited after the first and struck after the second: each
    record says so of its own check (round 5c's records said both of both).
    """
    return tuple(
        {"check": check, "slug": item.slug, "finding": item.finding, "quote": item.quote,
         "explanation": item.explanation, "evidenceId": item.evidence_id,
         "recited": (item.slug, item.quote) in came.recited, "struck": (item.slug, item.quote) in came.struck}
        for item in verdicts.objections if item.blocking
    )


def _merged(
    checks: Sequence[tuple[Verdicts, set[str]]], recited: Sequence[Recited], came: Mapping[int, _Outcome],
    found: Mapping[str, int],
) -> Verdicts:
    """One record of every check, the finder's tokens counted with them: each later check speaks for the pages it was asked about."""
    first = checks[0][0]
    objections = list(first.objections)
    usage = {name: first.usage.get(name, 0) + found.get(name, 0) for name in {*first.usage, *found}}
    blocked = _blocked(first, 1, came.get(1) or _Outcome())
    for number, (later, about) in enumerate(checks[1:], start=2):
        objections = [item for item in objections if item.slug not in about] + [
            item for item in later.objections if item.slug in about
        ]
        usage = {name: usage.get(name, 0) + later.usage.get(name, 0) for name in {*usage, *later.usage}}
        blocked += _blocked(later, number, came.get(number) or _Outcome())
    records = tuple(item.record() for item in recited)
    return Verdicts(
        objections=tuple(objections), usage=usage, recited=records, blocked=blocked, passed=checks[-1][0].passed,
        claims=checks[-1][0].claims,
    )


def _new_chars(page: Any) -> int:
    """How much new text a staged page has: a new page's body, or what an edit's changes write."""
    return sum(len(change.after) for change in page.changes) if page.action == "edit" else len(page.body)


def _struck(
    draft: MemoryDraft, slug: str, objections: Sequence[Objection], struck: set[Quoted], page: Any = None,
    floor: int = 0,
) -> str:
    """
    Stage the page without the claims quoted and answer "", or change nothing
    and say why it could not be done. `floor` is the new text the page must
    keep (`STRIKE_MAX_SHARE`).
    """
    page = page or draft.staged_page(slug)
    if page is None:
        return "the page was no longer staged"
    shown = draft.shown.get(slug)
    done = strike(page, objections, shown.body if shown and page.action == "edit" else "")
    if isinstance(done, Refused):
        return done.why
    if _new_chars(done) < floor:
        return f"strikes would take more than {STRIKE_MAX_SHARE:.0%} of the page's new text"
    # In a run that files notes, a strike may not part Delphi's inference from the note it rests on.
    if draft.notes and parted(page.body, page.citations, done.body, done.citations, draft.notes):
        return "striking it would part Delphi's inference from the note it rests on"
    draft.discard(slug)
    draft.stage(done)
    struck.update((slug, item.quote) for item in objections)
    return ""


async def checked(
    client: ResponsesClient, settings: Settings, left: Clock, authored: Authored, evidence: EvidenceSet, *,
    mend: Callable[[Authored, list[Objection], float], Awaitable[Authored]], storage: Any, username: str,
    known: Collection[str], use_standard_tier: bool,
) -> tuple[Authored, Verdicts, list[Dropped]]:
    """Check what was staged, and settle every page that was blocked (see the module docstring)."""
    draft = authored.draft
    common = {"evidence": evidence, "use_standard_tier": use_standard_tier}
    first = await verify(client, settings, draft=draft, timeout=left("the check"), **common)
    blocked = {page.slug: first.blocking(page.slug) for page in draft.staged if first.blocking(page.slug)}
    if not blocked:
        return authored, first, []
    # The new text each page had before its first strike, and so what its later strikes must leave.
    unstruck_chars: dict[str, int] = {}

    def floor(slug: str, page: Any = None) -> int:
        if slug not in unstruck_chars:
            unstruck_chars[slug] = _new_chars(page or draft.staged_page(slug))
            return 0
        return math.ceil(unstruck_chars[slug] * (1 - STRIKE_MAX_SHARE))

    # A true claim cited at the wrong passage of its document is given the right one, not taken out.
    objections = [item for found in blocked.values() for item in found]
    standing, recited, finding = await recite(
        client, settings, draft, evidence, objections, timeout=left("re-citing", FIND_TIMEOUT_SECONDS),
        use_standard_tier=use_standard_tier,
    )
    standing_by = {slug: tuple(item for item in standing if item.slug == slug) for slug in blocked}
    standing_by = {slug: found for slug, found in standing_by.items() if found}
    before = {slug: draft.staged_page(slug) for slug in standing_by}
    if standing_by:
        # A repair of a page whose name another job has taken would be refused: run the job again instead.
        await refuse_taken(storage, username, settings, draft, known)
        authored = await mend(authored, [item for found in standing_by.values() for item in found], left("the repair"))
    unchanged = {slug for slug in standing_by if draft.staged_page(slug) is before[slug]}
    # The repair writes a page again from the author's own operations, without
    # the passages just found: give those claims their passages again.
    await asyncio.to_thread(reapply, draft, [item for item in recited if item.slug in set(standing_by) - unchanged])
    dropped: list[Dropped] = []
    came = {1: _Outcome(recited)}
    for slug in sorted(unchanged):
        # Refused, or left as it was: take out what it was asked to mend.
        if unstruck := _struck(draft, slug, standing_by[slug], came[1].struck, before[slug], floor(slug, before[slug])):
            dropped.append(_dropped(draft.discard(slug) or before[slug], standing_by[slug], unstruck))
    checks = [(first, set())]
    asked = set(blocked) - {item.slug for item in dropped}
    while asked:
        number = len(checks) + 1
        last = number == LAST_CHECK
        later = await verify(
            client, settings, draft=draft, timeout=left("the second check" if number == 2 else "the third check"),
            again=checks[-1][0].passed, claims=checks[-1][0].claims, **common,
        )
        checks.append((later, set(asked)))
        still = {slug: later.blocking(slug) for slug in sorted(asked) if later.blocking(slug)}
        asked = set()
        standing_now = [item for found in still.values() for item in found]
        came[number] = _Outcome()
        if still and not last:
            # A claim a later check objects to is looked for in its documents
            # first, as after the first check: only what none of them holds is struck.
            # The last check re-cites nothing: no check would read the passage it found.
            standing_now, placed, used = await recite(
                client, settings, draft, evidence, standing_now,
                timeout=left("re-citing", FIND_TIMEOUT_SECONDS), use_standard_tier=use_standard_tier,
            )
            recited += placed
            came[number] = _Outcome(placed)
            finding = {name: finding.get(name, 0) + used.get(name, 0) for name in {*finding, *used}}
        for slug in still:
            left_over = tuple(item for item in standing_now if item.slug == slug)
            # The claims no passage holds are struck, at any check; the rest of the page stands.
            unstruck = _struck(draft, slug, left_over, came[number].struck, floor=floor(slug)) if left_over else ""
            if unstruck:
                dropped.append(_dropped(draft.discard(slug), left_over, unstruck))
                continue
            if not last:
                # What was re-cited or struck is read by the next check, on the units that changed.
                asked.add(slug)
    return authored, _merged(checks, recited, came, finding), dropped
