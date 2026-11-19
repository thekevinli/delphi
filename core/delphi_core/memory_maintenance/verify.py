"""
The checker: one call that reads what a job staged against the passages it cites.

When the agent's loop ends, every staged page is shown to a second model in
one request with no tools (`verify`). For an edit it sees each change before
and after; for a new page, the whole body. Beside them it sees the citations
the changed text uses, each with the exact passage its locator names, read
from the job's closed evidence set. It answers with objections, in strict
JSON (`contracts/verify.md` is what it is told).

**Delphi decides what blocks, not the checker** (`is_blocking`). A checker
that is believed costs the reader a correct page for every objection it
invents, so an objection blocks its page only when Delphi can find it in what
the checker was shown:

1. it names a staged page and one of the four findings;
2. its quote occurs in that page's changed text as shown, after the
   normalisation `harness.evidence.normalise` applies to any quote. A claim
   about new text must quote new text. A removal must quote what was taken
   out, and what it quotes must be gone from the resulting page;
3. for an unsupported claim, it names a source of the closed evidence set, and
   one whose passage the checker was shown for that page: nobody can say what
   an unread passage does not support;
4. it touches a claim no earlier check passed in the same words: a verdict
   belongs to a claim, and a sentence shown again only because the block
   around it changed is not judged a second time (`verify_claims.already_passed`).

Every other objection is advisory: kept on `Verdicts`, logged and counted,
and never a reason to drop a page.

An answer that cannot be read raises. It is never taken to mean "no
objections": the job fails and is tried again.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Collection, Mapping
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..config import Settings
from ..harness.evidence import MIN_QUOTE_CHARS, normalise
from ..harness.prompts import UNTRUSTED_TEXT_RULE
from ..harness.provider import ProviderError, ResponsesClient, Terminal, require_completed
from ..model_tasks import service_tier_field
from .blocks import split_blocks
from .run import EvidenceSet, JobDeadline, Objection, Verdicts
from .staging import MemoryDraft, StagedPage
from .verify_again import passed_units, units_of
from .verify_claims import already_passed, marker_signatures, passed_claims
from .verify_locate import clip_to_claim, readable

logger = logging.getLogger(__name__)

FINDINGS = ("unsupported", "differs", "removed", "overwritten")
#: The most of one passage the checker is shown, and the most of all of them.
#: A passage over its share is clipped and marked; a citation is never left out.
PASSAGE_MAX_CHARS = 12_000
PASSAGES_TOTAL_CHARS = 120_000
PASSAGE_FLOOR_CHARS = 1_500
UNAVAILABLE = "passage unavailable"

#: The stage's contract holds two tasks: the check, and finding where a
#: document says a claim its citation lacks (`verify_find`). Each is sent alone.
FIND_HEADING = "# Finding where a document says a claim"
CONTRACT, FIND_CONTRACT = (
    part.strip()
    for part in (Path(__file__).parent / "contracts" / "verify.md")
    .read_text(encoding="utf-8")
    .replace("{{UNTRUSTED_TEXT_RULE}}", UNTRUSTED_TEXT_RULE)
    .replace("{{QUOTE_MIN_CHARS}}", str(MIN_QUOTE_CHARS))
    .split(f"\n{FIND_HEADING}\n")
)
FIND_CONTRACT = f"{FIND_HEADING}\n\n{FIND_CONTRACT}"

VERDICTS_FORMAT = {
    "type": "json_schema",
    "name": "memory_verdicts",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["objections"],
        "properties": {
            "objections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["slug", "finding", "quote", "explanation", "evidenceId"],
                    "properties": {
                        "slug": {"type": "string"},
                        "finding": {"type": "string", "enum": list(FINDINGS)},
                        "quote": {"type": "string"},
                        "explanation": {"type": "string"},
                        "evidenceId": {"type": ["string", "null"]},
                    },
                },
            }
        },
    },
}

_NEW_MARKER = re.compile(r"\[(N\d+)\]")
_MARKER = re.compile(r"\[E(\d+)\]")
# A tag of this request's own, inside text that is only material.
_OWN_TAG = re.compile(r"<(?=/?(?:page|change|before|after|body|summary|passage)\b)")
_LOCATOR = (("page", "page"), ("section", "section"), ("noteId", "note"))


class UnreadableVerdicts(ProviderError):
    """The checker's answer could not be read as objections."""

    def __init__(self, why: str) -> None:
        super().__init__(f"The Memory check returned an answer that cannot be read: {why}", Terminal.FAILED)


@dataclass(frozen=True)
class Shown:
    """One staged page as the checker was shown it: what a quote is held to."""

    #: The text an edit takes out, each change's `before`.
    before: str
    #: The text that would be stored: each change's `after`, or a new page whole.
    after: str
    #: The whole resulting page.
    body: str
    #: Sources of which the checker was shown a passage for this page.
    readable: frozenset[str] = frozenset()
    #: What was shown of the page, unit by unit, each with its key (`verify_again.unit_key`).
    units: tuple[tuple[str, str], ...] = ()
    #: Each marker of the page read as the locator it cites, which a claim is kept by.
    signatures: Mapping[str, str] = field(default_factory=dict)


def is_blocking(objection: Objection, shown: Mapping[str, Shown], evidence_ids: Collection[str]) -> bool:
    """Whether an objection blocks its page (the three conditions in the module docstring)."""
    page = shown.get(objection.slug)
    if page is None or objection.finding not in FINDINGS:
        return False
    quote = normalise(objection.quote.replace("&lt;", "<"))
    if len(quote) < MIN_QUOTE_CHARS:
        return False
    taken_out, written = quote in normalise(page.before), quote in normalise(page.after)
    if objection.finding == "removed":
        return taken_out and quote not in normalise(page.body)
    if objection.finding == "overwritten":
        return taken_out or written
    if not written:
        return False
    if objection.finding == "unsupported":
        return objection.evidence_id in evidence_ids and objection.evidence_id in page.readable
    return True


def _inert(text: str) -> str:
    return _OWN_TAG.sub("&lt;", text)


def _source_id(citation: Mapping[str, Any]) -> str:
    return str(citation.get("evidenceId") or citation.get("paperId") or "")


def _changes(page: StagedPage, draft: MemoryDraft) -> list[dict[str, Any]]:
    """Each change of an edit as shown: whole blocks, with new citations by their stored ids."""
    seen = draft.shown.get(page.slug)
    blocks = {block.id: block.content for block in split_blocks(seen.body)} if seen else {}

    def numbered(text: str) -> str:
        return _NEW_MARKER.sub(
            lambda found: f"[E{page.refs[found.group(1)]}]" if found.group(1) in page.refs else found.group(0), text
        )

    shown: list[dict[str, Any]] = []
    for change in page.changes:
        before, after = change.before, numbered(change.after)
        whole = blocks.get(change.blocks[0], "") if change.op == "replace_text" and change.blocks else ""
        if whole and before in whole:
            # A fragment cannot be judged apart from its block.
            before, after = whole, whole.replace(before, after)
        shown.append({
            "op": change.op, "blocks": ", ".join(change.blocks), "before": before, "after": after,
            "reason": change.reason, "evidence": tuple(change.evidence),
        })
    if seen and page.summary != seen.summary:
        shown.append({"op": "summary", "blocks": "", "before": seen.summary, "after": page.summary, "reason": None, "evidence": ()})
    return shown


def _cited(page: StagedPage, changes: list[dict[str, Any]], written: str) -> list[tuple[str, dict[str, Any]]]:
    """The citations the changed text uses, and any a removal named, each under the name shown."""
    by_id = {int(citation["id"]): dict(citation) for citation in page.citations}
    listed: dict[str, dict[str, Any]] = {}
    for number in dict.fromkeys(int(found) for found in _MARKER.findall(written)):
        if number in by_id:
            listed[f"E{number}"] = by_id[number]
    for change in changes:
        for name in change["evidence"]:
            number = page.refs.get(name) or (int(name[1:]) if re.fullmatch(r"E\d+", name) else 0)
            if number in by_id:
                listed.setdefault(f"E{number}", by_id[number])
            elif name in page.evidence:
                # Evidence for a removal is cited by no marker, so it is on no page.
                listed.setdefault(name, dict(page.evidence[name]))
    return list(listed.items())


def _read_passages(evidence: EvidenceSet, citations: list[dict[str, Any]]) -> list[str | None]:
    """Each citation's passage, or None. Blocking: it reads the stores."""
    read: list[str | None] = []
    for citation in citations:
        try:
            text = evidence.passage(citation) if citation.get("claimType") != "derived" else None
        except Exception:
            logger.warning("could not read the passage of a citation of %s", _source_id(citation), exc_info=True)
            text = None
        read.append(text.strip() if isinstance(text, str) and text.strip() else None)
    return read


def _citation_text(
    name: str, citation: Mapping[str, Any], passage: str | None, titles: Mapping[str, str], limit: int, claim: str = "",
) -> str:
    kind = citation.get("claimType")
    if kind == "derived":
        return f"[{name}] derived: the author's own inference, marked as one. It has no passage."
    source = _source_id(citation)
    where = [f"{label} {citation[key]}" for key, label in _LOCATOR if citation.get(key)]
    head = f"[{name}] {kind} · source id {source}" + (f" ({titles[source]})" if titles.get(source) else "")
    head += "".join(f" · {part}" for part in where)
    if passage is None:
        return f"{head}\n{UNAVAILABLE}"
    # A decimal point the PDF's font lost is shown as the point it was (`verify_locate.readable`).
    return f"{head}\n<passage>\n{_inert(clip_to_claim(readable(passage), limit, claim))}\n</passage>"


def _page_text(
    page: StagedPage, changes: list[dict[str, Any]], citations: str, *, summary: str | None = None, body: str | None = None,
    again: bool = False,
) -> str:
    """One page as the checker reads it. Checked again, a new page shows only the summary and blocks not yet passed."""
    head = f'<page slug="{page.slug}" action="{page.action}"' + (' again="true"' if again else "") + ">"
    parts = [head, f"title: {_inert(page.title)}", f"author's note: {_inert(page.note)}"]
    if page.action == "create":
        summary, body = (page.summary, page.body) if summary is None and body is None else (summary or "", body or "")
        if summary:
            parts.append(f"<summary>\n{_inert(summary)}\n</summary>")
        parts.append(f"<body>\n{_inert(body)}\n</body>")
    for number, change in enumerate(changes, start=1):
        head = f'<change number="{number}" op="{change["op"]}"' + (f' blocks="{change["blocks"]}"' if change["blocks"] else "") + ">"
        parts.append(head)
        if change["before"] and change["op"] != "summary":
            reason = f"reason stated for removing text: {change['reason']}" if change["reason"] else "no reason stated"
            named = ", ".join(f"E{page.refs[name]}" if name in page.refs else name for name in change["evidence"])
            parts.append(reason + (f" · evidence stated: {named}" if named else ""))
        parts.append(f"<before>\n{_inert(change['before'])}\n</before>" if change["before"] else "<before>\n</before> (nothing: this text is inserted)")
        parts.append(f"<after>\n{_inert(change['after'])}\n</after>" if change["after"] else "<after>\n</after> (nothing: the text is deleted)")
        parts.append("</change>")
    parts.append("Citations the changed text uses:\n" + citations if citations else "The changed text uses no citation.")
    if page.calculations:
        parts.append(
            "Calculations, already recomputed by Delphi:\n"
            + "\n".join(_inert(json.dumps(entry, ensure_ascii=False, sort_keys=True)) for entry in page.calculations)
        )
    parts.append("</page>")
    return "\n".join(parts)


async def _show(
    draft: MemoryDraft, evidence: EvidenceSet, again: Mapping[str, frozenset[str]] | None = None
) -> tuple[str, dict[str, Shown]]:
    """The request's text, and each page as it shows it. A page with nothing left to check is not shown."""
    titles = {source.id: source.title for source in evidence.sources}
    drafted = []
    for page in draft.staged:
        changes = _changes(page, draft) if page.action == "edit" else []
        units = units_of(page, changes)
        passed = (again or {}).get(page.slug)
        if passed is not None:
            left = [unit[0] not in passed for unit in units]
            if not any(left):
                continue
            units = [unit for unit, keep in zip(units, left) if keep]
            changes = [change for change, keep in zip(changes, left) if keep] if page.action == "edit" else changes
        if page.action == "edit":
            written, fragment = "\n\n".join(change["after"] for change in changes), {}
        elif passed is None:
            written, fragment = f"{page.summary}\n\n{page.body}", {}
        else:
            summary = next((text for key, text in units if key.startswith("summary")), "")
            body = "\n\n[…]\n\n".join(text.strip() for key, text in units if not key.startswith("summary"))
            written, fragment = f"{summary}\n\n{body}", {"summary": summary, "body": body}
        drafted.append((page, changes, written, _cited(page, changes, written), units, fragment, passed is not None))
    wanted = [citation for _, _, _, cited, *_ in drafted for _, citation in cited]
    read = await asyncio.to_thread(_read_passages, evidence, wanted)
    share = PASSAGES_TOTAL_CHARS // max(1, sum(text is not None for text in read))
    limit = max(PASSAGE_FLOOR_CHARS, min(PASSAGE_MAX_CHARS, share))
    passages = iter(read)
    sections: list[str] = []
    shown: dict[str, Shown] = {}
    for page, changes, written, cited, units, fragment, is_again in drafted:
        lines, readable = [], set()
        for name, citation in cited:
            passage = next(passages)
            if passage is not None:
                readable.add(_source_id(citation))
            # What cites it: the paragraphs of the written text that carry its marker.
            claim = " ".join(block for block in written.split("\n\n") if f"[{name}]" in block)
            lines.append(_citation_text(name, citation, passage, titles, limit, claim))
        sections.append(_page_text(page, changes, "\n".join(lines), again=is_again, **fragment))
        shown[page.slug] = Shown(
            before="\n\n".join(change["before"] for change in changes), after=written, body=page.body,
            readable=frozenset(readable), units=tuple(units), signatures=marker_signatures(page),
        )
    about = f"What these pages were written from: {evidence.title or evidence.marker} ({evidence.kind})."
    return about + "\n\n" + "\n\n".join(sections), shown


def parse_verdicts(text: str) -> list[dict[str, Any]]:
    """The checker's answer as objections, or `UnreadableVerdicts`."""
    try:
        answer = json.loads(text)
    except json.JSONDecodeError as error:
        raise UnreadableVerdicts(str(error)) from error
    items = answer.get("objections") if isinstance(answer, dict) else None
    if not isinstance(items, list):
        raise UnreadableVerdicts("it has no list of objections")
    for item in items:
        if not isinstance(item, dict) or not all(isinstance(item.get(key), str) for key in ("slug", "finding", "quote", "explanation")):
            raise UnreadableVerdicts("an objection lacks its page, finding, quote or explanation")
    return items


def verify_request(settings: Settings, text: str, *, use_standard_tier: bool) -> dict[str, Any]:
    """The one request: the contract, the pages, strict JSON back, and no tools."""
    return {
        "model": settings.memory_verify_model,
        "instructions": CONTRACT,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": text}]}],
        "reasoning": {"effort": settings.memory_verify_reasoning_effort},
        "text": {"format": VERDICTS_FORMAT},
        "max_output_tokens": settings.memory_verify_max_output_tokens,
        "store": False,
        **service_tier_field(settings, use_standard_tier),
    }


async def verify(
    client: ResponsesClient,
    settings: Settings,
    *,
    draft: MemoryDraft,
    evidence: EvidenceSet,
    timeout: float,
    use_standard_tier: bool,
    again: Mapping[str, frozenset[str]] | None = None,
    claims: Mapping[str, Mapping[str, frozenset[str]]] | None = None,
) -> Verdicts:
    """
    Check every page the draft has staged, in one call, within `timeout` seconds.

    Returns each objection with `blocking` decided here, and what each page
    has passed (`Verdicts.passed`). With `again`, what an earlier check
    passed, a page is shown only what it has not passed, and one with nothing
    left is not shown (`verify_again.py`). Raises `JobDeadline` when the time
    runs out, `ProviderError` when the call does not complete, and
    `UnreadableVerdicts` when its answer cannot be read. With nothing to show
    there is nothing to check and no call is made.

    With `claims`, what earlier checks passed claim by claim, an objection
    that touches only claims passed in the same words is advice: a verdict
    belongs to a claim and stands while its words do (`verify_claims.claims`).
    """
    earlier = dict(claims or {})
    if not draft.staged:
        return Verdicts(passed=dict(again or {}), claims=earlier)

    async def ask() -> Verdicts:
        text, shown = await _show(draft, evidence, again)
        if not shown:
            return Verdicts(passed=dict(again or {}), claims=earlier)
        result = require_completed(
            await client.complete(verify_request(settings, text, use_standard_tier=use_standard_tier)),
            "The Memory check",
        )
        known = {source.id for source in evidence.sources}
        objections = []
        for item in parse_verdicts("".join(result.texts())):
            found = Objection(
                slug=item["slug"].strip().strip("[]").rsplit("/", 1)[-1],
                finding=item["finding"].strip(),
                quote=item["quote"],
                explanation=item["explanation"],
                evidence_id=(item.get("evidenceId") or "").strip() or None,
            )
            # A claim an earlier check passed in the same words keeps its verdict: this is advice.
            blocking = is_blocking(found, shown, known) and not already_passed(found, shown[found.slug], earlier)
            found = Objection(**{**asdict(found), "blocking": blocking})
            if not found.blocking:
                logger.info("advisory objection on %s (%s): %s", found.slug, found.finding, found.explanation[:300])
            objections.append(found)
        units = {slug: page.units for slug, page in shown.items()}
        passed, claimed = passed_units(units, objections, again or {}), passed_claims(shown, objections, earlier)
        return Verdicts(objections=tuple(objections), usage=asdict(result.usage), passed=passed, claims=claimed)

    try:
        return await asyncio.wait_for(ask(), timeout=max(0.0, timeout))
    except TimeoutError as error:
        raise JobDeadline("verify") from error
