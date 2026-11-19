"""
Outside evidence for one maintenance job: the on path of `Settings.memory_web_evidence`.

Part of gather. What a job may cite is still decided before the agent starts,
and nothing after this stage looks at the web: the agent and the checker see
captured passages, never a page or a search. While the setting is off nothing
here runs and no model is asked anything.

Two passes, each the research pass of a digest (`harness.research.gather`)
with Memory's own task, and each followed by `harness.evidence.capture`, which
fetches every page a finding names and keeps only the findings whose quote is
really on it:

- **`reground`**, before the selection, for a session whose answers cited the
  web. A stored answer keeps its sources' addresses and no quote, so the pass
  is handed the sentences that cited each address (`EvidenceSet.web_cited`)
  and asked what each page says on those points. A finding on a page the
  answers did not cite is dropped: this pass checks, it does not search.
- **`look_outside`**, after the selection, when it names a question a
  published source could settle (`Selection.needs_outside`). It is asked once
  for a job, and only if the selection still names something missing after
  any re-grounding.

**Bounds.** Both passes of one job share `research.MAX_SEARCHES` hosted calls,
and zero searches is a valid pass; a pass that fails counts as having spent
them all. A job holds at most `evidence.MAX_SOURCES` captures of its own. A
pass that fails, times out or finds nothing leaves the evidence set as it was:
a job is never failed for want of the web.

**Frozen passes**, for evaluation only. With `Settings.memory_web_frozen_dir`
set, a pass is kept there the first time it runs (what it captured, with the
captured text, and the calls it made) and replayed after with no call and no
fetch, so a `new+web` arm can be filed again from the same evidence
(`memory_rebuild --web-frozen`). A pass is known by its job's marker, its
task and, for a re-grounding, the addresses: the question a selection asks is
worded anew each run, and the job asks one.

**What a capture becomes.** Each verified page joins the set as an `external`
source (`EvidenceSet.sources`), its sections readable by the checker
(`Passages`), and the brief gains an `<outside_source>` block quoting only
what the page was verified to say. The claims the research model wrote are
not shown to the agent: a verified quote is the page's own words, and a claim
is not. Nothing is stored here. `keep` stores, just before the commit, the
captures a committed page cites, and only those.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from urllib.parse import urldefrag

import httpx

from ..config import Settings
from ..harness.evidence import MAX_SOURCES, Packet, capture, store
from ..harness.research import MAX_SEARCHES, Task
from ..harness.research import gather as research
from ..storage import ObjectStore, Storage
from . import brief as tags
from .gather import Passages
from .run import EvidenceSet
from .staging import Evidence, StagedPage

logger = logging.getLogger("uvicorn.error")

#: The most one pass may take, whatever the job has left.
PASS_TIMEOUT_SECONDS = 240.0
#: How much of the event the question's pass is handed.
FOCAL_EVENT_CHARS = 16_000
NOTHING_BORNE_OUT = "The web pages the answers cited did not bear out what they were cited for, and nothing else is new."

#: What a finding of either Memory pass may bear on.
BEARS_ON = ("supports", "qualifies", "contradicts", "defines")

REGROUND = Task(
    looks_for="""
You check what web pages say. A reader asked Delphi questions, and its
answers cited the pages listed below. For each page you are given its address
and the sentences of the answers that cite it. Open each page at its address
and, for each sentence, report what the page says on that point:

- supports: the page says what the sentence says;
- qualifies: it says it with a condition or a limit the sentence left out;
- contradicts: it says otherwise;
- defines: it defines a term the sentence relies on.

The claim of a finding is what the page says, never what the sentence said.
Search only to reach a listed page you cannot open at its address. Do not
look for other pages, and report nothing from a page that is not listed.
""".strip(),
    when_empty="""
A sentence on whose point its page says nothing gives no finding: leave it
out and name it under `unresolved`, as you do a page you could not open. Zero
findings is a correct answer. Report nothing a page says that no sentence
asked about.
""".strip(),
    bears_on=BEARS_ON,
    ask="Check what the cited pages say: {subject}.",
)

QUESTION = Task(
    looks_for="""
You look outside one reader's library for the answer to one question their
Memory has left open. You are given what happened (a document was added, or
the reader finished a session) and the question. Search the web for the
published source that settles it, and report what it says:

- supports: a page that states the answer;
- qualifies: one that states it with a condition or a limit;
- contradicts: one that states the opposite of what the event says;
- defines: one that defines a term or method the question turns on.
""".strip(),
    when_empty="""
Return no findings when no page you opened settles the question: an empty
list is a correct answer, and better than a weak source. List under
`unresolved` what you looked for and could not find. A few well-aimed
searches are better than many broad ones.
""".strip(),
    bears_on=BEARS_ON,
    ask="Find what settles this question: {subject}",
)


def looks_outside(settings: Settings) -> bool:
    """Whether a job may look outside the library at all. The one switch, read here and in the gatherers."""
    return settings.memory_web_evidence


def _address(url: str) -> str:
    """An address as two of them are compared: without its fragment or a trailing slash."""
    return urldefrag(str(url or "").strip())[0].rstrip("/")


def _spent(evidence: EvidenceSet) -> int:
    return int(evidence.outside.get("searches") or 0)


def _frozen(settings: Settings, evidence: EvidenceSet, what: str, cited: Sequence[str]) -> Path | None:
    """Where this pass is kept while passes are frozen (see the module docstring), or None."""
    if not settings.memory_web_frozen_dir:
        return None
    known = json.dumps([evidence.marker, what, sorted(_address(url) for url in cited)])
    return Path(settings.memory_web_frozen_dir) / f"{hashlib.sha256(known.encode()).hexdigest()[:32]}.json"


async def _pass(
    http: httpx.AsyncClient, settings: Settings, evidence: EvidenceSet, task: Task, what: str, focal: str, subject: str,
    *, timeout: float, cited: Sequence[str] = (),
) -> tuple[Packet, int, list[dict[str, str]], bool]:
    """
    One research pass and the capture of what it found: the packet, the hosted
    calls it made, what was dropped, and whether it was replayed. Never
    raises; a pass that failed made every call it was allowed.
    """
    allowed = MAX_SEARCHES - _spent(evidence)
    room = MAX_SOURCES - len(evidence.captured)
    if allowed <= 0 or room <= 0:
        return Packet(), 0, [], False
    frozen = _frozen(settings, evidence, what, cited)
    if frozen is not None and frozen.exists():
        kept = json.loads(frozen.read_text(encoding="utf-8"))
        return Packet(sources=kept["sources"][:room]), min(int(kept["searches"]), allowed), kept["dropped"], True

    async def run() -> tuple[Packet, int, list[dict[str, str]]]:
        found = await research(
            http, settings, [{"role": "user", "content": focal}], subject, task=task, hosted_calls=allowed,
        )
        dropped: list[dict[str, str]] = []
        findings = []
        listed = {_address(url) for url in cited}
        for finding in found.findings:
            if listed and _address(finding.get("url")) not in listed:
                dropped.append({"claim": str(finding.get("claim") or ""), "url": str(finding.get("url") or ""),
                                "reason": "not a page the answers cited"})
            else:
                findings.append(finding)
        packet = await capture(findings, settings, bears_on=task.bears_on, max_sources=room) if findings else Packet()
        return packet, found.searches, dropped + packet.unverified

    try:
        packet, searches, dropped = await asyncio.wait_for(run(), timeout)
    except Exception as error:
        logger.warning("memory_outside_unavailable job=%s error=%s", evidence.marker, type(error).__name__)
        # Not frozen: a pass that did not finish is run again next time.
        return Packet(), allowed, [{"claim": "", "url": "", "reason": f"the research pass did not finish: {type(error).__name__}"}], False
    if frozen is not None:
        frozen.parent.mkdir(parents=True, exist_ok=True)
        frozen.write_text(json.dumps({
            "marker": evidence.marker, "task": what, "cited": list(cited),
            "searches": searches, "sources": packet.sources, "dropped": dropped,
        }, ensure_ascii=False), encoding="utf-8")
    return packet, searches, dropped, False


def _with(
    evidence: EvidenceSet, packet: Packet, searches: int, dropped: list[dict[str, str]], replayed: bool, what: str, said: str,
) -> EvidenceSet:
    """The evidence set with a pass's captures in it: as sources, as passages, and in the brief."""
    sources = [
        Evidence(source["id"], kind="external", title=str(source.get("title") or ""),
                 sections=tuple(str(section["anchor"]) for section in source["sections"] if section.get("anchor")))
        for source in packet.sources
    ]
    if isinstance(evidence.passage, Passages):
        for source in packet.sources:
            evidence.passage.add_sections(source["id"], source["sections"])
    outside = dict(evidence.outside)
    outside["searches"] = _spent(evidence) + searches
    outside["passes"] = [*outside.get("passes", ()), {
        "task": what,
        "searches": searches,
        **({"replayed": True} if replayed else {}),
        "captured": [{"id": source["id"], "url": source["url"], "title": source.get("title") or ""} for source in packet.sources],
        "dropped": [{key: tags.clip(value, 300) for key, value in item.items()} for item in dropped],
    }]
    brief = evidence.brief
    if sources:
        blocks = [said, "\n".join(tags.describe_source(source) for source in sources)]
        blocks += [
            tags.fence(
                tags.OUTSIDE_SOURCE,
                "What the page says, in its own words, as captured:\n" + tags.finding_lines(source.get("findings") or ()),
                evidence_id=source["id"], title=tags.clip(str(source.get("title") or ""), 200),
            )
            for source in packet.sources
        ]
        closing = f"\n</{tags.EVENT}>"
        cut = brief.rindex(closing) if closing in brief else len(brief)
        brief = brief[:cut] + "\n\n" + "\n\n".join(blocks) + brief[cut:]
    return replace(
        evidence,
        sources=(*evidence.sources, *sources),
        captured=(*evidence.captured, *packet.sources),
        outside=outside,
        brief=brief,
    )


async def reground(http: httpx.AsyncClient, settings: Settings, evidence: EvidenceSet, *, timeout: float) -> EvidenceSet:
    """
    A session's evidence set with the web pages its answers cited, captured
    where they bear out the sentences that cited them (see the module docstring).

    A session that rested on the web alone, none of whose pages bore out
    anything, is `skipped`: there is nothing left that could be cited.
    """
    if not looks_outside(settings) or not evidence.web_cited:
        return evidence
    cited = list(evidence.web_cited)
    focal = "The pages Delphi's answers cited, each with the sentences that cite it:\n\n" + "\n\n".join(
        f"Address: {item['url']}\nTitle: {json.dumps(tags.clip(str(item.get('title') or ''), 200), ensure_ascii=False)}\n"
        "Sentences:\n" + "\n".join(f"- {json.dumps(sentence, ensure_ascii=False)}" for sentence in item.get("sentences") or ())
        for item in cited
    )
    packet, searches, dropped, replayed = await _pass(
        http, settings, evidence, REGROUND, "reground", focal, f"the {len(cited)} listed page{'s' if len(cited) != 1 else ''}",
        timeout=timeout, cited=[str(item["url"]) for item in cited],
    )
    found = _with(
        evidence, packet, searches, dropped, replayed, "reground",
        "The web pages the session's answers cited, as Delphi captured them. Only what a page was found to say is "
        "here: a sentence of an answer that its page did not bear out is not, and cannot be filed. Each may be "
        "cited as `external` by section:",
    )
    logger.info(
        "memory_outside job=%s task=reground addresses=%d searches=%d captured=%d dropped=%d",
        evidence.marker, len(cited), searches, len(packet.sources), len(dropped),
    )
    if not found.sources and not (found.notes or found.gone_notes):
        return replace(found, skipped=NOTHING_BORNE_OUT)
    return found


async def look_outside(
    http: httpx.AsyncClient, settings: Settings, evidence: EvidenceSet, question: str | None, *, timeout: float
) -> EvidenceSet:
    """The evidence set with what the web says on the selection's open question, captured and verified."""
    question = " ".join(str(question or "").split())
    if not looks_outside(settings) or not question:
        return evidence
    focal = tags.clip(evidence.brief, FOCAL_EVENT_CHARS) + "\n\nThe question this event leaves open: " + json.dumps(
        tags.clip(question, 600), ensure_ascii=False
    )
    packet, searches, dropped, replayed = await _pass(
        http, settings, evidence, QUESTION, "question", focal, question, timeout=timeout,
    )
    found = _with(
        evidence, packet, searches, dropped, replayed, "question",
        f"Pages Delphi found on a question this event leaves open, {json.dumps(tags.clip(question, 600), ensure_ascii=False)}, "
        "as captured. An outside source adds to a page under its own attribution, and never replaces what a "
        "document says. Each may be cited as `external` by section:",
    )
    found = replace(found, outside={**found.outside, "question": tags.clip(question, 600)})
    logger.info(
        "memory_outside job=%s task=question searches=%d captured=%d dropped=%d",
        evidence.marker, searches, len(packet.sources), len(dropped),
    )
    return found


def keep(storage: Storage, objects: ObjectStore, username: str, evidence: EvidenceSet, pages: Sequence[StagedPage]) -> list[str]:
    """
    Store the captures of this job that these pages cite, bytes before record,
    before the pages are committed. Blocking. A commit that then fails leaves
    them cited by nothing, and `evidence.reap` removes them like any other.
    Returns the ids the pages cite.
    """
    cited = {str(c.get("evidenceId")) for page in pages for c in page.citations if c.get("evidenceId")}
    kept = [dict(source) for source in evidence.captured if source["id"] in cited]
    # A capture is immutable, so one already kept under its id is this one:
    # a frozen pass replayed, or a job retried after its commit failed.
    fresh = [source for source in kept if not _stored(storage, username, source["id"])]
    if fresh:
        store(Packet(sources=fresh), storage, objects, username)
    return [source["id"] for source in kept]


def _stored(storage: Storage, username: str, evidence_id: str) -> bool:
    try:
        storage.get_external_evidence(username, evidence_id)
    except Exception:
        return False
    return True
