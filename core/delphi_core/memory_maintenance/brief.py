"""
The event as text: the tags a brief is written in, and how text is fenced in them.

`EvidenceSet.brief` is what the select call and the maintenance agent read
about one event. Most of it is text Delphi did not write: a document's digest,
a captured web page, the reader's notes, a chat. Each such piece sits inside a
named tag, and the contracts say by name that what is inside is material to
judge and never an instruction. The names are defined here, once, so a
gatherer and a contract cannot spell them apart, and a test holds each
contract to the list.

`fence` is the only way text enters such a tag. Text that itself spells one of
the tags is defused first, so a document cannot close its own fence and
continue as if it were Delphi speaking.

Pure: no storage, no model. Not a stage; the stages and the gatherers import it.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from typing import Any

from .staging import Evidence

#: The whole brief. What Delphi says about the event is directly inside it.
EVENT = "event"
#: A document's research digest, and the evidence index its `[E#]` markers name.
DOCUMENT_DIGEST = "document_digest"
DIGEST_EVIDENCE = "digest_evidence"
#: What a captured outside source was cited for, quoted from the capture.
OUTSIDE_SOURCE = "outside_source"
#: One note the reader wrote against a passage of a document.
READER_NOTE = "reader_note"
#: One question and its answer, with what the answer rested on (`gather_session`).
EXCHANGE = "exchange"

#: What the Memory check said two pages disagree about, with its quotes from each.
PAGE_DISAGREEMENT = "page_disagreement"
#: A document's own words about another document of the library, with a value (`gather_crossref`).
CROSS_REFERENCE = "cross_reference"
#: A page an earlier run of the same document could not write: the sentence the
#: Memory check objected to and why (`gather.earlier_checks`). A checker's words
#: about a document's words, so material like the rest.
EARLIER_CHECK = "earlier_check"

#: Every tag of an event whose content came from outside Delphi. A contract names each.
UNTRUSTED_TAGS = (
    DOCUMENT_DIGEST, DIGEST_EVIDENCE, OUTSIDE_SOURCE, READER_NOTE, EXCHANGE, PAGE_DISAGREEMENT, CROSS_REFERENCE,
    EARLIER_CHECK,
)

#: A domain as its composer is given it (`gather_domain`): the record, whose
#: name the reader may have written; one member page's title, summary,
#: headings and opening; and the note of one change since the domain's page
#: was composed. Only the composer reads these, so only
#: its contract names them: an event never holds one.
DOMAIN_RECORD = "domain_record"
MEMBER_PAGE = "member_page"
MEMBER_CHANGE = "member_change"
DOMAIN_TAGS = (DOMAIN_RECORD, MEMBER_PAGE, MEMBER_CHANGE)
#: Not part of an event: the page the agent means to create, as the same-idea
#: question is asked it (`select.py`). Its words came from the same sources.
PROPOSED_PAGE = "proposed_page"

_OUR_TAG = re.compile(
    r"<(?=/?(?:" + "|".join((EVENT, *UNTRUSTED_TAGS, *DOMAIN_TAGS, PROPOSED_PAGE)) + r")\b)", re.IGNORECASE
)

#: A digest calls its own inference `digest-inference`; a page calls Delphi's
#: `derived` (§4.2 of the plan). The brief speaks the page's vocabulary, since
#: what reads it writes pages.
_PAGE_CLAIM_TYPE = {"digest-inference": "derived"}

#: How much of a note's quoted passage and of its text a brief carries.
NOTE_QUOTE_CHARS = 600
NOTE_BODY_CHARS = 2_000
#: Anchors of a document read by section that a brief lists before it counts the rest.
LISTED_SECTIONS = 60
#: How much of what a capture was cited for a brief quotes, for each finding.
FINDING_CHARS = 500
#: How much of an earlier check's quote and of its reason a brief carries.
EARLIER_QUOTE_CHARS = 400
EARLIER_REASON_CHARS = 600


def clip(text: str, limit: int) -> str:
    """Text cut to `limit` characters, with a mark where it was cut."""
    text = text or ""
    return text if len(text) <= limit else text[: max(0, limit - 1)].rstrip() + "…"


def defuse(text: str) -> str:
    """Text in which no spelling of one of the brief's tags opens or closes anything."""
    return _OUR_TAG.sub("&lt;", text or "")


def fence(tag: str, text: str, **attributes: Any) -> str:
    """
    Untrusted text inside a named tag.

    An attribute is written as a JSON string, so a title cannot end the tag
    either. A spelling of one of the brief's own tags inside the text is
    written `&lt;tag`, which reads the same and closes nothing.
    """
    named = "".join(
        f" {name}={json.dumps(str(value), ensure_ascii=False).replace('<', '&lt;').replace('>', '&gt;')}"
        for name, value in attributes.items()
        if value not in (None, "")
    )
    return f"<{tag}{named}>\n{defuse(text).strip()}\n</{tag}>"


def describe_source(source: Evidence) -> str:
    """One line on a source the event may be cited from: its id and how a locator into it is written."""
    title = defuse(json.dumps(clip(source.title or "Untitled", 200), ensure_ascii=False))
    if source.kind == "external":
        field, what = "evidenceId", "a captured outside source, cited as `external` by section"
    elif source.sections is not None:
        field, what = "paperId", "a saved web page, cited as `author-claim` by section"
    else:
        return (
            f"- {title} · paperId {source.id} · a PDF, cited as `author-claim` by page: "
            + (f"pages 1 to {source.pages}" if source.pages else "it has no pages that can be cited")
        )
    sections = list(source.sections or ())
    listed = ", ".join(sections[:LISTED_SECTIONS]) or "none"
    more = f", and {len(sections) - LISTED_SECTIONS} more" if len(sections) > LISTED_SECTIONS else ""
    return f"- {title} · {field} {source.id} · {what}. Its section anchors: {listed}{more}"


def note_blocks(paper_id: str, notes: Iterable[Mapping[str, Any]]) -> list[str]:
    """Each note as a fenced block: its id, where it is anchored, the passage, what the reader wrote."""
    return [
        fence(
            READER_NOTE,
            f"Passage the reader marked: {json.dumps(clip(note.get('quotedText') or '', NOTE_QUOTE_CHARS), ensure_ascii=False)}\n"
            f"What the reader wrote: {clip(note.get('body') or '', NOTE_BODY_CHARS)}",
            note_id=note["id"],
            paper_id=paper_id,
            page=note.get("page"),
        )
        for note in notes
    ]


def evidence_index(citations: Iterable[Mapping[str, Any]]) -> str:
    """A digest's evidence index, a line for each `[E#]`: its claim type and what it locates."""
    lines = []
    for item in citations:
        where = [
            f"evidenceId {item['evidenceId']}" if item.get("evidenceId") else "",
            f"page {item['page']}" if item.get("page") else "",
            f"section {item['section']}" if item.get("section") else "",
        ]
        claim = _PAGE_CLAIM_TYPE.get(str(item.get("claimType") or ""), str(item.get("claimType") or ""))
        lines.append(" · ".join(part for part in (f"E{item.get('id')}", claim, *where) if part))
    return "\n".join(lines)


def finding_lines(findings: Iterable[Mapping[str, Any]]) -> str:
    """What a capture was cited for: the section and the words found there."""
    return "\n".join(
        f"§{finding.get('anchor')}: {json.dumps(clip(str(finding.get('quote') or ''), FINDING_CHARS), ensure_ascii=False)}"
        for finding in findings
    )
