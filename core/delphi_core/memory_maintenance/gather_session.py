"""
Gather for a finished session: what the reader asked and noted, and what it rested on.

A session is what the reader did beside one document (the chats in every tab
and the note changes on it) or in one Memory chat. `gather_session` reads what
no filing has covered yet and builds the closed evidence set from it.

**The evidence rule.** An exchange is eligible only if it rests on something
other than Memory: a document the answer held or read, a passage the reader
selected, or, when `Settings.memory_web_evidence` is on, a web source. An
exchange whose record shows only Memory reads is skipped, so Memory never
feeds on itself. What an answer rested on is read from what is stored with
it, never from its prose:

- beside a document, the answer held that document whole, and every document
  the question referenced;
- in a Memory chat, the answer held the document that was open beside the
  chat, as its digest (the trace's `context.start`);
- `read_paper` and `read_webpage` calls in the trace name the documents the
  answer opened, with the pages and the anchors;
- the question's `selectedText` is the passage the reader supplied;
- the answer's `sources`, a `web_search` call, and successful `read_url`
  results are the web.

An answer is handed on without its paragraphs that link to one of its web
sources: a link is matched to a source by address, as the reader's own view
matches them. An outside claim never reaches the agent in Delphi's words,
where it could be refiled as a document's or as Delphi's own inference. While
web evidence is off that is the whole story. While it is on, the sentences
that carried a link are gathered too, with their addresses (`web_cited`, at
most `evidence.MAX_SOURCES` addresses a job), and `gather_outside.reground`
asks the research pass what those pages really say: what comes back verified
is cited as `external`, and what does not stays in the conversation.

An answer Delphi gave is never a source. The sources of the set are the
documents the eligible answers rested on, so the agent cites the page an
answer rested on, and the checker is shown that page.

**Notes are filed in a run of their own.** New and edited notes on the
session's document are evidence, and only here: a document's event reads
none. A part of the session that hands the agent exchanges leaves the notes
for the next part (`EvidenceSet.more`), so a run files exchanges or notes,
never both, and what a notes run writes rests on its notes unless a
document's page says it (`reader_notes.py` holds it to that). The exchanges
go first: what they file stands on its documents, and the notes then add only
what is theirs.

A note's citation is the only record of what a page says on its word, so the
pages that cite a note are found from the citations (`note_citations`). A note
the reader edited is filed again, and its run starts from the pages that cite
it as it read before. A note the reader deleted leaves no record of its own,
so it is found from the other side: a page that cites a note the document no
longer has. Deleted notes are retracted by the session's first part, since a
retraction only removes. The brief says what goes, because what a page says
on that note's word alone has to go.

When no exchange is eligible, no note changed and no deleted note is cited,
the set is `skipped` and the job ends without a model call.

Blocking, like the stores. No model.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from ..answer_trace import tool_entries
from ..artifacts.prose import assistant_prose
from ..config import Settings
from ..harness.budget import MAINTAIN_STAGED_PAGES
from ..harness.evidence import MAX_SOURCES
from ..memory import source_page_slug
from ..storage import ObjectStore, Storage
from . import brief as tags
from .blocks import split_blocks
from .gather import MissingEvidence, Passages, document_source, unfiled_notes, without_blocks
from .jobs import SESSION, read_marker, session_fingerprint, unfiled_exchanges
from .run import EvidenceSet
from .staging import Evidence

#: Exchanges one event carries, oldest first. A longer session is filed in
#: parts: the job is queued again for what is left (`EvidenceSet.more`).
MAX_EXCHANGES = 8
QUESTION_CHARS = 800
PASSAGE_CHARS = 800
ANSWER_CHARS = 2_400
#: Memory pages a Memory chat's answers opened that the agent starts from.
START_PAGES = 6
READS = {"read_paper", "read_webpage"}
#: How much of one web-cited sentence the research pass is handed, and how
#: many sentences of the event's answers it is handed for one address.
CITED_SENTENCE_CHARS = 600
SENTENCES_PER_ADDRESS = 4
WEB_CUT = (
    "[Its paragraphs that cite web pages are left out here. What those pages say, where it could be checked, "
    "is given as captured outside sources.]"
)
NOTHING_NEW = "Nothing in this session is new to Memory."
MEMORY_ONLY = "Every exchange of this session rested on Memory alone, and no note changed."


_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_LINK = re.compile(r"\[[^\]]*\]\([^)]*\)")


def _addresses(answer: Mapping[str, Any]) -> list[tuple[str, str]]:
    """An answer's web sources, as (address, title)."""
    sources = list(answer.get("sources") or ())
    trace = answer.get("trace") if isinstance(answer.get("trace"), list) else []
    for entry in tool_entries(trace):
        if entry.get("tool") == "read_url" and entry.get("ok") is True:
            # Results name the page actually fetched, including redirects. Args
            # are only the requested address and may be clipped in the trace.
            sources.extend(entry.get("results") or ())
    addresses: dict[str, str] = {}
    for source in sources:
        if isinstance(source, Mapping) and source.get("url"):
            url, title = str(source["url"]), str(source.get("title") or "")
            addresses[url] = addresses.get(url) or title
    return list(addresses.items())


def _sentences(text: str) -> list[str]:
    """
    A paragraph's sentences. A link standing after a full stop, as a provider
    writes a citation, belongs to the sentence before it.
    """
    found: list[str] = []
    for part in _SENTENCE_END.split(" ".join(text.split())):
        if found and not _LINK.sub("", part).strip(" ().,;:"):
            found[-1] += f" {part}"
        elif part:
            found.append(part)
    return found


def web_cited(answers: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """
    The sentences of these answers that link one of their web sources, by
    address: `{url, title, sentences}`, in the order the addresses are first
    cited, at most `MAX_SOURCES` of them, since one packet captures no more.
    """
    cited: dict[str, dict[str, Any]] = {}
    for answer in answers:
        addresses = _addresses(answer)
        for block in split_blocks(assistant_prose(str(answer.get("content") or ""))):
            for sentence in _sentences(block.text):
                for url, title in addresses:
                    if url not in sentence:
                        continue
                    if url not in cited:
                        if len(cited) >= MAX_SOURCES:
                            continue
                        cited[url] = {"url": url, "title": title, "sentences": []}
                    held = cited[url]["sentences"]
                    clipped = tags.clip(sentence, CITED_SENTENCE_CHARS)
                    if clipped not in held and len(held) < SENTENCES_PER_ADDRESS:
                        held.append(clipped)
    return list(cited.values())


@dataclass
class _Exchange:
    """One question and its whole answer, with what the answer rested on."""

    conversation_id: str
    request_id: str
    question: Mapping[str, Any]
    answer: Mapping[str, Any]
    #: Documents the answer held, then documents it opened, by paper id.
    documents: list[str] = field(default_factory=list)
    #: What it opened of each, as the trace recorded it: pages and anchors.
    opened: dict[str, list[str]] = field(default_factory=dict)
    #: Memory pages the answer was given or opened, the page beside the chat first.
    pages: list[str] = field(default_factory=list)
    web: bool = False

    @property
    def passage(self) -> str:
        return str(self.question.get("selectedText") or "").strip()

    def eligible(self, web_evidence: bool) -> bool:
        return bool(self.documents or self.passage or (self.web and web_evidence))


def _exchange(conversation: Mapping[str, Any], question: Mapping[str, Any], answer: Mapping[str, Any]) -> _Exchange:
    """Read what one answer rested on off its stored record (see the module docstring)."""
    found = _Exchange(str(conversation["id"]), str(answer["requestId"]), question, answer)
    held: list[str] = []
    if conversation.get("paperId"):
        held.append(str(conversation["paperId"]))
        held += [str(paper["id"]) for paper in question.get("referencedPapers") or () if paper.get("id")]
    trace = answer.get("trace") if isinstance(answer.get("trace"), list) else []
    context = next((s["context"] for s in trace if isinstance(s, Mapping) and isinstance(s.get("context"), Mapping)), {})
    start = context.get("start") if isinstance(context.get("start"), Mapping) else {}
    if start.get("kind") == "document" and start.get("paperId"):
        held.append(str(start["paperId"]))
    pages = [start.get("slug")] if start.get("kind") == "page" else []
    pages += [item.get("slug") for item in context.get("given") or () if isinstance(item, Mapping)]
    read: list[str] = []
    for entry in tool_entries(trace):
        tool, args = str(entry.get("tool") or ""), entry.get("args") or {}
        if tool in READS and entry.get("ok", True) and args.get("paperId"):
            paper_id = str(args["paperId"])
            read.append(paper_id)
            where = [f"page {page}" for page in args.get("pages") or ()] or ([f"§{args['anchor']}"] if args.get("anchor") else [])
            found.opened.setdefault(paper_id, []).extend(item for item in where if item not in found.opened.get(paper_id, ()))
        elif tool.startswith("web_search"):
            found.web = True
        else:
            pages += [item.get("slug") for item in entry.get("results") or () if isinstance(item, Mapping)]
    found.documents = list(dict.fromkeys((*held, *read)))
    found.pages = list(dict.fromkeys(str(slug) for slug in pages if slug))
    found.web = found.web or bool(_addresses(answer))
    return found


def _answer_text(exchange: _Exchange, web_evidence: bool) -> str:
    """
    The answer as the agent is given it: without its web-cited paragraphs.
    While web evidence is on, an answer that lost some says where they went.
    """
    whole = assistant_prose(str(exchange.answer.get("content") or ""))
    addresses = [url for url, _ in _addresses(exchange.answer)]
    if not addresses:
        return whole
    text = without_blocks(whole, lambda block: any(address in block for address in addresses))
    if web_evidence and text != whole.strip():
        text = f"{text}\n\n{WEB_CUT}".strip()
    return text


def _exchange_block(exchange: _Exchange, text: str, titles: Mapping[str, str]) -> str:
    rested = [
        f"paperId {paper_id} ({titles[paper_id]})" + (f", opened at {', '.join(exchange.opened[paper_id])}" if exchange.opened.get(paper_id) else "")
        for paper_id in exchange.documents if paper_id in titles
    ]
    lines = [f"The answer rested on: {'; '.join(rested)}." if rested else "The answer held no document of the library."]
    if exchange.passage:
        lines.append(f"Passage the reader selected: {json.dumps(tags.clip(exchange.passage, PASSAGE_CHARS), ensure_ascii=False)}")
    lines.append(f"The reader asked: {tags.clip(str(exchange.question.get('content') or ''), QUESTION_CHARS)}")
    lines.append(f"Delphi answered: {tags.clip(text, ANSWER_CHARS)}")
    return tags.fence(tags.EXCHANGE, "\n".join(lines), request_id=exchange.request_id)


def _conversations(storage: Storage, username: str, project_id: str, paper_id: str, conversation_id: str) -> list[dict[str, Any]]:
    """The session's conversations with their messages: every chat beside the document, or the one Memory chat."""
    if paper_id:
        ids = [item["id"] for item in storage.list_scope_conversations(username, "document", project_id, paper_id)["items"]]
    else:
        ids = [conversation_id]
    found = []
    for item in ids:
        try:
            found.append(storage.get_conversation(username, item))
        except Exception:
            # Deleted since the job was queued: nothing of it is left to file.
            continue
    return found


def _pages(slugs: Iterable[str]) -> str:
    return ", ".join(f"[[{slug}]]" for slug in slugs)


def _brief(
    opening: str, sources: Iterable[Evidence], where: str, blocks: list[str], paper_id: str,
    notes: list[dict[str, Any]], gone: Mapping[str, tuple[str, ...]], refiled: Mapping[str, tuple[str, ...]],
) -> str:
    parts = [
        opening,
        "What this event may be cited from, and nothing else:\n"
        + ("\n".join(tags.describe_source(source) for source in sources) or "Nothing."),
        where,
    ]
    if blocks:
        parts.append(
            "The exchanges of the session that Memory has not taken in. What Delphi answered is never a source: a "
            "claim taken from an answer is cited to the document the answer rested on, at the page or section it names."
        )
        parts.extend(blocks)
    if notes:
        parts.append(
            "The reader's notes on this document that are new or were edited. A note is evidence of what the "
            "reader thinks, cited as `reader-note` with its `noteId` and this `paperId`. What you write from a note "
            "cites it, beside any page of the document it also stands on:"
        )
        parts.extend(tags.note_blocks(paper_id, notes))
    for note_id, slugs in refiled.items():
        parts.append(
            f"The note {note_id} was filed before, and {_pages(slugs)} cite it as it read then. What those pages say "
            "on its word should say what it says now: revise it, or take out what the reader no longer says with the "
            "reason `withdrawn`."
        )
    for note_id, slugs in gone.items():
        parts.append(
            f"The reader deleted the note {note_id} that these pages cite: {_pages(slugs)}. The note is no longer "
            "evidence, and what a page says on its word goes, with the reason `withdrawn`: a passage that cites it, "
            "with Delphi's inference drawn from it (`derived`), and words of the summary that repeat it. Keep what a "
            "document's page says on its own, cited to that page, and where another source of this event supports a "
            "claim, cite that source in its place."
        )
    return f"<{tags.EVENT} kind=\"{SESSION}\">\n" + "\n\n".join(part for part in parts if part) + f"\n</{tags.EVENT}>"


def gather_session(
    storage: Storage, objects: ObjectStore, username: str, settings: Settings, job: Mapping[str, Any]
) -> EvidenceSet:
    """
    The evidence set of a `session` job (see the module docstring).

    Never raises for something that is gone: a deleted document, a deleted
    chat or a retracted turn leaves a set with nothing in it, and the job ends
    without a trace. `request_ids` are the exchanges the job covers, eligible
    and skipped alike: all are settled by it.
    """
    payload = job.get("payload") or {}
    named = read_marker(str(job.get("marker") or ""))
    paper_id = named.paper_id if named else str(payload.get("paperId") or "")
    conversation_id = named.conversation_id if named else str(payload.get("conversationId") or "")
    project_id = str(payload.get("projectId") or "") if paper_id else ""
    library = {
        paper["id"]: (project["id"], paper)
        for project in storage.list_projects_with_papers(username) for paper in project.get("papers") or ()
    }
    base = {"kind": SESSION, "marker": str(job.get("marker") or "")}
    if paper_id:
        if paper_id not in library:
            return EvidenceSet(**base, fingerprint=session_fingerprint([], {}), skipped=NOTHING_NEW)
        # The project the document is in now: it may have moved since the job was queued.
        project_id = library[paper_id][0]
    conversations = _conversations(storage, username, project_id, paper_id, conversation_id)
    owed = sorted(
        (
            _exchange(conversation, question, answer)
            for conversation in conversations
            for question, answer in unfiled_exchanges(conversation.get("messages") or (), conversation.get("memoryFiledThrough"))
        ),
        key=lambda exchange: (str(exchange.answer.get("createdAt") or ""), exchange.request_id),
    )
    read = owed[:MAX_EXCHANGES]
    for exchange in read:
        exchange.documents = [item for item in exchange.documents if item in library]
    eligible = [exchange for exchange in read if exchange.eligible(settings.memory_web_evidence)]

    texts = [(exchange, _answer_text(exchange, settings.memory_web_evidence)) for exchange in eligible]
    web = tuple(web_cited(exchange.answer for exchange in eligible)) if settings.memory_web_evidence else ()
    # A run files exchanges or notes, never both: notes wait for the next part (the module docstring).
    asking = any(text.strip() for _, text in texts) or bool(web)
    passages = Passages(objects, username)
    pending = unfiled_notes(storage, username, project_id, paper_id, passages) if paper_id else []
    notes = [] if asking else pending
    gone: dict[str, tuple[str, ...]] = {}
    refiled: dict[str, tuple[str, ...]] = {}
    if paper_id:
        kept = {note["id"] for note in storage.list_notes(username, project_id, paper_id)}
        citing = dict(sorted(storage.note_citations(username, paper_id).items()))
        gone = {note_id: tuple(slugs) for note_id, slugs in citing.items() if note_id not in kept}
        # An edited note's pages are the agent's to revise, and one run writes at
        # most MAINTAIN_STAGED_PAGES, a deleted note's pages included: a note whose
        # pages would not fit waits for the next part. The first is always taken,
        # unless the part retracts; a page it is turned away from withholds the
        # note's stamp (`pipeline._withheld`).
        taken: list[dict[str, Any]] = []
        revising: set[str] = {slug for slugs in gone.values() for slug in slugs}
        for note in notes:
            held = set(citing.get(note["id"], ()))
            if (taken or gone) and held and len(revising | held) > MAINTAIN_STAGED_PAGES:
                continue
            taken.append(note)
            revising |= held
        notes = taken
        refiled = {note["id"]: tuple(citing[note["id"]]) for note in notes if note["id"] in citing}
    sources: list[Evidence] = []
    cited = [paper_id] if paper_id and (eligible or notes or gone) else []
    for item in dict.fromkeys((*cited, *(doc for exchange in eligible for doc in exchange.documents))):
        try:
            sources.append(document_source(objects, username, library[item][0], library[item][1], notes if item == paper_id else (), passages))
        except MissingEvidence:
            continue
    titles = {source.id: source.title or "Untitled" for source in sources}
    blocks = [_exchange_block(exchange, text, titles) for exchange, text in texts if text.strip()]

    chat_generation = None
    if paper_id:
        paper = library[paper_id][1]
        source_slug = source_page_slug(storage, username, dict(paper), settings)
        title = author = str(paper.get("title") or "")
        opening = f"The reader finished a session beside the document {json.dumps(tags.clip(title, 200), ensure_ascii=False)}."
        where = f"The document's own page in Memory is [[{source_slug}]]. Delphi writes that page from the document's digest."
        starts = [source_slug, *(slug for pages in (*gone.values(), *refiled.values()) for slug in pages)]
    else:
        author = str(conversations[0].get("title") or "") if conversations else ""
        chat_generation = int(conversations[0].get("generation") or 0) if conversations else None
        title = "A Memory chat" + (f": {author}" if author else "")
        opening = "The reader finished a chat about their Memory."
        starts = list(dict.fromkeys(slug for exchange in eligible for slug in exchange.pages))[:START_PAGES]
        where = (
            "The Memory pages that were open beside the chat or that its answers opened: "
            + ", ".join(f"[[{slug}]]" for slug in starts) + "."
        ) if starts else ""
    skipped = ""
    if not (blocks or notes or gone):
        skipped = MEMORY_ONLY if read else NOTHING_NEW
    return EvidenceSet(
        **base,
        project_id=project_id,
        paper_id=paper_id,
        title=title,
        author=author,
        chat_generation=chat_generation,
        start_slugs=tuple(dict.fromkeys(starts)),
        sources=tuple(sources),
        brief=_brief(tags.defuse(opening), sources, where, blocks, paper_id, notes, gone, refiled),
        fingerprint=session_fingerprint(
            [exchange.request_id for exchange in read],
            {**{note["id"]: str(note.get("updatedAt") or "") for note in notes}, **{note_id: "deleted" for note_id in gone}},
        ),
        request_ids=tuple(exchange.request_id for exchange in read),
        notes={note["id"]: str(note.get("updatedAt") or "") for note in notes},
        filed_through={exchange.conversation_id: exchange.request_id for exchange in read},
        gone_notes=gone,
        refiled_notes=refiled,
        more=len(owed) > len(read) or len(pending) > len(notes),
        skipped=skipped,
        passage=passages,
        web_cited=web,
    )
