from contextlib import aclosing
import anyio
import asyncio
import base64
import hashlib
import json
import logging
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from ..config import Settings, get_settings
from ..model_tasks import MODEL_TASK_BY_KEY, service_tier_for
from ..chat_images import normalize_chat_image
from ..answer_heartbeat import AnswerHeartbeat
from ..conversation_titles import generate_conversation_title
from ..viewport import normalize_viewport_image
from ..deps import get_current_user, get_object_store, get_storage
from ..provider_errors import provider_refusal
from ..schemas import (
    CONVERSATION_TITLE_MAX_CHARS, ChatCancelRequest, ChatPersonaSelect, ChatRequest, ChatScope,
    ConversationCreate, ConversationRename, SideChatRequest, SideTurn,
)
from ..storage.conversations import resolve_selector, selector
from ..sse import event_stream, sse
from ..storage import (
    ObjectStore,
    Storage,
    chat_image_key,
    evidence_key,
    is_web,
    memory_slug,
    paper_key,
    utc_now,
)
from ..answer_trace import AnswerTrace, utf16_length
from ..document_reads import document_kind
from ..harness import profiles
from ..harness.budget import TurnBudget
from ..harness.loop import TurnResult, run_turn
from ..harness.prompts import SIDE_CHAT_MARKER, compose_instructions
from ..harness.provider import ResponsesClient, Terminal, Usage, require_completed
from ..harness.registry import Toolset
from ..harness.tool import ToolContext
from ..artifacts.delivery import Delivery
from ..artifacts.session import ArtifactSession
from ..memory_harness import (
    SELECT_MAX_PAGES,
    memory_index_block,
    memory_selection_request,
    memory_selection_turn,
    open_chosen_memory,
    page_results,
    provider_error_message,
    reader_memory_block,
    reader_position_block,
    selected_slugs,
    selection_index,
)
from ..provider_files import PdfSource, inline_pdf, pdf_input_block, provider_file_missing
from ..personas import (
    DEFAULT_PERSONA_KEY,
    persona_for_turn,
    resolve_persona_for_request,
)
from ..research_digest import (
    compact_digest_cards,
    digest_metadata_is_current,
    load_digest,
)
from ..web_extract import flat_markdown, outline
from ..web_fetch import (
    IMAGE_TYPES,
    PDF_TYPES,
    extract_with_render_fallback,
    fetch_resource,
)
from .projects import ensure_paper

router = APIRouter(prefix="/api", tags=["chat"])
# Uvicorn configures its own logger tree and leaves ordinary module INFO loggers
# silent. Request telemetry must share that handler or the instrumentation exists
# only in tests and never reaches an operator.
logger = logging.getLogger("uvicorn.error")
# Bumped when the persona moved off the project and onto the conversation. A
# reader scope used to compose its instructions from the project's SKILLS.md and
# a project could legitimately have none; now every conversation resolves a
# persona and the block is always there, so the prefix is a different shape for
# every existing reader and old keys must not be reused against it.
#: Bumped whenever the instructions change without the persona's id changing —
#: an official has no revision, so its body can move underneath a key that does
#: not. Sent to the provider as `prompt_cache_key` and nothing else: never
#: stored, never migrated, so a change costs one cold prefix and no more.
#:
#: The scheme restarted here. It ran `conversation-persona-v1` to `-v13`, whose
#: numbering recorded edits nobody needs to remember; those strings are retired
#: rather than reused, so no key can collide with a prefix an old one grouped.
#:
#: `harness-v1`: the tools array became the same on every turn of a scope
#: (search always offered, generated schemas, Memory tool names), which is a
#: different prefix for every reader.
#:
#: `harness-v3`: a domain page may be chosen for an answer. The selection
#: instructions say when, and the association section says what one is cited
#: for, so both prefixes moved.
#: `harness-v5-source-reads`: chat gains the bounded external URL reader and
#: its working-method guidance; Plan and maintenance retain their toolsets.
#: `harness-v6-memory-web-reads`: the Memory chat reads the library's web
#: pages (`read_webpage`), so its tools and working method moved.
PROMPT_CACHE_VERSION = "harness-v6-memory-web-reads"


@dataclass(frozen=True)
class ScopeRef:
    """
    Which conversation a request belongs to, resolved once per request.

    `project_id`/`thread_key` are None for the account-wide scope, matching the
    NULL columns on its `chat_threads` row: the general thread is not a project
    thread with a missing project, it is a differently-shaped row that the same
    `_scope_thread` already serves.
    """

    kind: ChatScope
    project_id: str | None
    thread_key: str | None


def conversation_scope(
    storage: Storage, username: str, scope: ChatScope, project_id: str | None,
    paper_id: str | None, conversation_id: str | None, generation: int | None = None,
) -> ScopeRef:
    """The one conversation a request names, checked against the context it claims."""
    project = None if scope == "general" else (project_id or "")
    paper = paper_id if scope == "document" else None
    key = resolve_selector(storage, username, scope, project, paper, conversation_id, generation)
    return ScopeRef(kind=scope, project_id=project, thread_key=key)


def read_thread(storage: Storage, username: str, ref: ScopeRef) -> dict[str, Any]:
    thread = storage.get_thread(username, ref.project_id, ref.thread_key)
    from ..plans import history
    from ..storage.conversations import require_selector
    conversation_id, generation = require_selector(ref.thread_key)
    thread["messages"] = history(storage, username, conversation_id, generation, thread["messages"])
    return thread


def append_turn(
    storage: Storage, username: str, ref: ScopeRef, message: dict[str, Any]
) -> None:
    """
    Append one turn to whichever conversation this scope names.

    **This dispatch decides which session the turn belongs to.** A whole
    answer holds a `session` job in the write that stores it: beside a
    document `append_message` holds the document's job, shared by every chat
    beside that document and by its notes; in the account-wide chat
    `append_memory_message` holds the conversation's own. Neither files
    while the reader is still in the session. A Memory chat does not feed on
    itself for another reason, decided when its job runs: an exchange that
    rested on Memory alone is skipped (`gather_session`).
    """
    if ref.kind == "general":
        storage.append_memory_message(username, message, ref.thread_key)
        return
    storage.append_message(username, ref.project_id or "", ref.thread_key or "", message)


def set_scope_persona(
    storage: Storage, username: str, ref: ScopeRef, persona_id: str
) -> None:
    """
    Record the persona this conversation is being held in.

    Unlike `append_turn` this needs no split: `set_conversation_persona` writes
    one field and enqueues nothing in either scope.
    """
    storage.set_conversation_persona(
        username,
        project_id=ref.project_id,
        thread_key=ref.thread_key,
        persona_id=persona_id,
    )


def public_chat_image(image: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in image.items()
        if key not in {"imageKey", "thumbnailKey"}
    }


def image_input_blocks(
    images: list[dict[str, Any]], objects: ObjectStore
) -> list[dict[str, Any]]:
    blocks = []
    for image in images:
        payload = b"".join(objects.open_range(image["imageKey"]))
        encoded = base64.b64encode(payload).decode("ascii")
        blocks.append(
            {
                "type": "input_image",
                "image_url": f"data:image/webp;base64,{encoded}",
                "detail": "low",
            }
        )
    return blocks


async def prepare_viewport_context(
    body: ChatRequest,
    username: str,
    settings: Settings,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None]:
    """Prepare redirected context once, only when a Document Chat question is sent."""
    viewport = body.viewport
    if viewport is None:
        return None, None, None

    if viewport.source == "captured":
        # The selection-time text is evidence. Re-fetching its URL would answer
        # a different question after an update, redirect, or a failed load.
        from ..web_fetch import normalise_url
        source_url = normalise_url(viewport.url)
        sections = [{"anchor": f"block-{index+1}", "title": f"Passage {index+1}",
                     "level": 2, "markdown": text, "words": len(text.split())}
                    for index, text in enumerate(viewport.texts) if text.strip()]
        document = {"title": viewport.title, "url": source_url, "sections": sections}
        source_hash = hashlib.sha256(flat_markdown(document).encode()).hexdigest()
        viewport.source_hash = source_hash
        return document, None, {"source":"evidence", "kind":"html", "url":source_url,
                                "title":viewport.title, "sourceHash":source_hash, "document":document}

    resource = await fetch_resource(
        viewport.url,
        settings,
        include_pdf=True,
        include_images=True,
        allow_render=True,
    )
    if resource.content_type in PDF_TYPES:
        raise HTTPException(409, "Import this PDF before asking Document Chat about it")
    if resource.content_type in IMAGE_TYPES:
        image, _, _ = await run_in_threadpool(
            normalize_viewport_image, resource.body, settings
        )
        source_hash = hashlib.sha256(image).hexdigest()
        viewport.source_hash = source_hash
        encoded = base64.b64encode(image).decode("ascii")
        title = viewport.title or resource.url.rsplit("/", 1)[-1] or "Image"
        return (
            None,
            {
                "type": "input_image",
                "image_url": f"data:image/webp;base64,{encoded}",
                "detail": "low",
            },
            {
                "source": "evidence",
                "kind": "image",
                "url": resource.url,
                "title": title,
                "sourceHash": source_hash,
                "imageData": encoded,
                "mimeType": "image/webp",
            },
        )

    document = await extract_with_render_fallback(
        resource, settings.web_max_extract_chars
    )
    if not document["sections"]:
        raise HTTPException(422, "The page being viewed has no readable content")
    markdown = flat_markdown(document)
    source_hash = hashlib.sha256(markdown.encode()).hexdigest()
    viewport.source_hash = source_hash
    title = viewport.title or document["title"]
    document["title"] = title
    return (
        document,
        None,
        {
            "source": "evidence",
            "kind": "html",
            "url": resource.url,
            "title": title,
            "sourceHash": source_hash,
            "document": document,
        },
    )


async def ready_project_digests(
    objects: ObjectStore,
    username: str,
    project_id: str,
    meta: dict[str, Any],
    attached: list[dict[str, Any]],
    settings: Settings,
) -> tuple[list[tuple[dict[str, Any], dict[str, Any]]], list[dict[str, Any]], int]:
    """
    The project around a document question: every digest that already exists.

    Returns the bounded cards, the active documents that are *not* attached
    to the question, and the cards' estimated tokens. Nothing is generated on
    this path: a document question must never wait minutes
    for a summary of some other document. Upload and the maintenance pump write
    digests on their own, so a missing card is a card that arrives by a later
    turn, and until then the library lists the document by its title only.

    A digest that cannot be read is skipped for the same reason — the question
    is about the open document, and that one reaches the request as itself.
    """
    active = [paper for paper in meta.get("papers", []) if not paper.get("doneAt")]
    cards: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for paper in active:
        if not digest_metadata_is_current(paper, settings):
            continue
        try:
            digest = await run_in_threadpool(
                load_digest, objects, username, project_id, paper["id"]
            )
        except Exception:
            logger.warning("project_digest_unreadable paper=%s", paper["id"])
            continue
        cards.append((paper, digest))
    cards, estimated = compact_digest_cards(cards, settings)
    attached_ids = {paper["id"] for paper in attached}
    # A finished document carries no digest card, and it is still a companion:
    # the reading tools may open it. Finishing a document says the reader has
    # read it, which is when an answer most wants to cite its exact page.
    companions = [paper for paper in meta.get("papers", []) if paper["id"] not in attached_ids]
    return cards, companions, estimated


async def load_companion_web_documents(
    objects: ObjectStore,
    username: str,
    project_id: str,
    companions: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Snapshots `read_webpage` may open beyond the attached ones; a missing one is skipped."""
    documents: dict[str, dict[str, Any]] = {}
    for paper in companions:
        try:
            documents.update(
                await load_web_documents(objects, username, project_id, [paper])
            )
        except Exception:
            logger.warning("companion_web_document_unreadable paper=%s", paper["id"])
    return documents


def request_was_cancelled(
    storage: Storage,
    username: str,
    project_id: str | None,
    thread_key: str,
    request_id: str,
) -> bool:
    try:
        thread = storage.get_thread(username, project_id, thread_key)
    except HTTPException as exc:
        if exc.status_code in {404, 409}:
            return True
        raise
    return any(
        message.get("requestId") == request_id and message.get("cancelled") is True
        for message in thread.get("messages", [])
    )


def request_papers(
    storage: Storage,
    username: str,
    project_id: str,
    body: ChatRequest,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    meta = storage.get_project(username, project_id)
    seen_references: set[str] = set()
    referenced_papers: list[dict[str, Any]] = []
    for paper_id in body.referenced_paper_ids:
        if paper_id in seen_references:
            continue
        referenced_paper = ensure_paper(meta, paper_id)
        # A stale client could otherwise smuggle an archived document back
        # into a request it is no longer part of.
        if referenced_paper.get("doneAt"):
            raise HTTPException(400, f"{referenced_paper['title']} is marked done and can't be referenced")
        referenced_papers.append(referenced_paper)
        seen_references.add(paper_id)

    current_paper = ensure_paper(meta, body.paper_id or "")
    if body.viewport is not None and not is_web(current_paper):
        raise HTTPException(400, "Viewport context requires the active web document")
    selected_papers = [current_paper]
    selected_ids = {current_paper["id"]}
    for referenced_paper in referenced_papers:
        if referenced_paper["id"] in selected_ids:
            continue
        selected_papers.append(referenced_paper)
        selected_ids.add(referenced_paper["id"])
    return meta, selected_papers


def request_prompt_cache_key(
    username: str,
    project_id: str,
    body: ChatRequest,
    persona: dict[str, Any] | None = None,
) -> str:
    """
    Group requests that genuinely share a prefix.

    The persona and its revision belong here: they decide the instructions, so
    switching persona and switching back would otherwise alternate two different
    prefixes under one key.
    """
    scope = f"paper:{body.paper_id}"
    persona_identity = (
        f"{persona.get('id')}:{persona.get('revision', 0)}" if persona else "none"
    )
    # A side chat's instructions and tools differ from the conversation's,
    # so it is its own prefix and must not share the conversation's key.
    side = "\0side" if body._side is not None else ""
    identity = (
        f"{username}\0{project_id}\0{scope}\0{persona_identity}{side}\0"
        f"{getattr(body.viewport, 'source_hash', '') or ''}\0"
        f"{PROMPT_CACHE_VERSION}".encode()
    )
    digest = hashlib.sha256(identity).hexdigest()[:24]
    return f"delphi:{PROMPT_CACHE_VERSION}:{digest}"


async def ensure_openai_files(
    client: httpx.AsyncClient,
    storage: Storage,
    objects: ObjectStore,
    username: str,
    project_id: str,
    papers: list[dict[str, Any]],
    settings: Settings,
    *,
    stale_file_ids: frozenset[str] = frozenset(),
) -> list[tuple[dict[str, Any], PdfSource | None]]:
    sources: list[tuple[dict[str, Any], PdfSource | None]] = []
    for paper in papers:
        if is_web(paper):
            # A web document has no bytes to upload. It travels as an outline
            # and is read through `read_webpage`, which is the entire point:
            # attaching a 15,000-word post costs a few hundred tokens instead of
            # twenty thousand, every turn.
            sources.append((paper, None))
            continue
        if not settings.openai_files_enabled:
            # No file store to reference, so the bytes travel with the request
            # and the stored id, which belongs to another provider, is kept.
            sources.append((paper, await inline_pdf(objects, username, project_id, paper)))
            continue
        file_id = paper.get("openaiFileId")
        stale = bool(file_id) and file_id in stale_file_ids
        if not file_id or stale:
            key = paper_key(username, project_id, paper["id"], "pdf")
            pdf_path = await run_in_threadpool(objects.fetch_to_tempfile, key)
            try:
                with pdf_path.open("rb") as pdf:
                    response = await client.post(
                        f"{settings.api_base_url.rstrip('/')}/files",
                        headers={"Authorization": f"Bearer {settings.api_key}"},
                        data={"purpose": "user_data"},
                        files={
                            "file": (
                                paper.get("filename") or f"{paper['id']}.pdf",
                                pdf,
                                "application/pdf",
                            )
                        },
                    )
            finally:
                pdf_path.unlink(missing_ok=True)
            response.raise_for_status()
            uploaded = response.json()["id"]
            if stale:
                # Compare-and-swap, as the digest's repair does: a concurrent
                # request that already repaired this paper wins, and this upload
                # is left as a harmless remote orphan.
                replaced = await run_in_threadpool(
                    storage.replace_openai_file,
                    username,
                    project_id,
                    paper["id"],
                    file_id,
                    uploaded,
                )
                if not replaced:
                    current = await run_in_threadpool(
                        storage.get_paper, username, project_id, paper["id"]
                    )
                    uploaded = current.get("openaiFileId") or uploaded
            else:
                # One field on one paper, not the whole project. This runs
                # mid-stream, minutes after the project was read, and a
                # whole-aggregate write would replay a stale paper list over any
                # concurrent rename or reorder. The store also ignores it if an
                # id is already set, so two concurrent first-questions cannot
                # orphan an uploaded file.
                await run_in_threadpool(
                    storage.set_openai_file, username, project_id, paper["id"], uploaded
                )
            file_id = uploaded
            paper["openaiFileId"] = file_id
        sources.append((paper, file_id))
    return sources


async def load_web_documents(
    objects: ObjectStore,
    username: str,
    project_id: str,
    papers: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Read the stored snapshot of every web document attached to this question."""
    documents: dict[str, dict[str, Any]] = {}
    for paper in papers:
        if not is_web(paper):
            continue
        key = paper_key(username, project_id, paper["id"], "web")
        raw = await run_in_threadpool(objects.get_text, key)
        documents[paper["id"]] = json.loads(raw)
    return documents


def web_outline_block(paper: dict[str, Any], document: dict[str, Any]) -> str:
    """The map of a page: titles and anchors, never the prose."""
    return (
        f'Web document "{document.get("title") or paper["title"]}" — '
        f'{document.get("url", paper.get("url", ""))}\n'
        f'doc_id={paper["id"]} · snapshot {document.get("fetchedAt", "unknown")} · '
        f'{document.get("wordCount", 0)} words\n'
        "Sections (anchor · title · words):\n"
        f"{outline(document)}\n"
        "Only the outline is attached. Call read_webpage(doc_id, anchor) to open "
        "a section before quoting or relying on it, and cite it as "
        f'("{paper["title"]}", §anchor).'
    )


def open_document_opening(paper: dict[str, Any]) -> str:
    """
    Which document "this" is, in the same words in every scope.

    The one sentence that binds the reader's deictics to a document. It is
    written once because the failure it prevents is silent: a request that
    never says which document is open lets the model pick whichever one it
    read last, and answer about that one fluently.
    """
    title = json.dumps(paper.get("title", "Untitled paper"), ensure_ascii=False)
    return (
        f'<open_document paper_id="{paper["id"]}" title={title} '
        f'kind="{document_kind(paper)}">\n'
        "The reader has this document open beside the conversation. "
        '"This document", "this paper", "this page", "this post" and "here" '
        "mean it, and never another document.\n"
    )


def open_document_block(
    paper: dict[str, Any], digest: dict[str, Any] | None
) -> dict[str, Any]:
    """
    The document open beside an account-wide conversation, for one turn.

    Its digest when one exists, because that is what the reader scopes hold for
    a document they do not attach whole; its name alone when none does. Never
    the document itself: this scope has no cached prefix to put a PDF in, and a
    question that needs the page can open it with `read_paper`.
    """
    title = json.dumps(paper.get("title", "Untitled paper"), ensure_ascii=False)
    body = (
        f'<research_digest paper_id="{paper["id"]}" title={title}>\n'
        f"{json.dumps(digest, ensure_ascii=False)}\n"
        "</research_digest>\n"
        "The digest is an index of the document, not its text."
        if digest
        else "No research digest has been written for it yet, so only its title is known here."
    )
    return {
        "role": "user",
        "content": [
            {
                "type": "input_text",
                "text": f"{open_document_opening(paper)}{body}\n</open_document>",
            }
        ],
    }


def project_library_blocks(
    documents: list[dict[str, Any]],
    digest_cards: list[tuple[dict[str, Any], dict[str, Any]]],
    tool_names: frozenset[str],
    prompt_cache_enabled: bool,
) -> list[dict[str, Any]]:
    """
    The project, the same whatever is open: an index, then each digest once.

    The index leads because it is what makes the digests addressable — a model
    handed six unlabelled summaries and a list afterwards has already decided
    what they are by the time it reaches the list. Every active document is a
    row, in project order, saying what this request holds for it; the digests
    follow in that order and nowhere else.

    Nothing here depends on which document is open or what was asked. That is
    what lets the block be one cached prefix for the whole project, and why
    the open document is named beside the question (`turn_context_block`)
    rather than marked in a row.
    """
    digest_ids = {paper["id"] for paper, _ in digest_cards}
    index = "\n".join(
        json.dumps(
            {
                "paper_id": paper["id"],
                "title": paper.get("title", "Untitled paper"),
                "kind": document_kind(paper),
                "in_context": (
                    "digest" if paper["id"] in digest_ids
                    else "finished; not attached" if paper.get("doneAt")
                    else "title only"
                ),
            },
            ensure_ascii=False,
        )
        for paper in documents
    )
    readers = [
        text
        for name, text in (
            ("read_paper", "exact PDF pages with read_paper(paper_id, pages)"),
            (
                "read_webpage",
                "a web page's sections with read_webpage(doc_id, anchor), where "
                "doc_id is the paper_id",
            ),
        )
        if name in tool_names
    ]
    header: dict[str, Any] = {
        "type": "input_text",
        "text": (
            f'<project_library documents="{len(documents)}">\n'
            "Every document in this project, in project order, one per "
            "line. `in_context` says what this request holds for it: `digest` "
            "is the research digest that follows, in this order; `title only` "
            "means no digest has been written yet; `finished; not attached` "
            "is a document the reader marked finished, which is here by name "
            "only: open it before relying on what it says.\n"
            f"{index}\n"
            "</project_library>\n"
            "A research digest is an index of its document, not its text."
            + (f" Open {' and '.join(readers)}." if readers else "")
        ),
    }
    blocks = [
        header,
        *(
            {
                "type": "input_text",
                "text": (
                    f'<research_digest paper_id="{paper["id"]}" '
                    f'title={json.dumps(paper.get("title", "Untitled paper"), ensure_ascii=False)}>\n'
                    f"{json.dumps(digest, ensure_ascii=False)}\n"
                    "</research_digest>"
                ),
            }
            for paper, digest in digest_cards
        ),
    ]
    if prompt_cache_enabled:
        blocks[-1]["prompt_cache_breakpoint"] = {"mode": "explicit"}
    return blocks


def turn_context_block(
    body: ChatRequest,
    sources: list[tuple[dict[str, Any], PdfSource | None]],
    web_documents: dict[str, dict[str, Any]],
    digest_ids: set[str],
) -> dict[str, Any] | None:
    """
    What is true of this one question: what is open, and what was @-referenced.

    Beside the question and after the history, never in the prefix. It changes
    when the reader turns to another document or names another paper, and the
    prefix is the part that must not; and identity said forty thousand tokens
    before the question is identity the model has stopped holding by the time
    it is asked what "this" means.

    Each line says only what this request really holds. A web document is an
    outline here and is called one — telling the model a page is "here whole"
    is how it stops opening sections and answers from whichever digest it read
    last.
    """
    referenced_ids = set(body.referenced_paper_ids)

    def held(paper: dict[str, Any], pdf: PdfSource | None) -> str:
        if pdf is not None:
            return "its full text is a PDF attached in this conversation"
        document = web_documents.get(paper["id"])
        if document:
            return "only its outline is in context:\n" + web_outline_block(paper, document)
        return "only its title is in context"

    referenced = [
        (paper, pdf)
        for paper, pdf in sources
        if paper.get("id") in referenced_ids and paper.get("id") != body.paper_id
    ]
    primary = next(
        ((paper, pdf) for paper, pdf in sources if paper.get("id") == body.paper_id),
        None,
    )
    if primary is None:
        return None
    paper, pdf = primary
    lines = [
        f"In this request {held(paper, pdf)}"
        + (
            " — the first attachment. Answer about this document from that "
            "text and cite its page numbers."
            if pdf is not None
            else ""
        ),
        (
            "Its research digest is in the project library under the same "
            "paper_id."
            if paper["id"] in digest_ids
            else "No research digest has been written for it yet."
        ),
    ]
    for other, other_pdf in referenced:
        lines.append(
            "For this question the reader also @-referenced "
            f'{json.dumps(other.get("title", "Referenced paper"), ensure_ascii=False)} '
            f'(paper_id {other["id"]}); {held(other, other_pdf)}'
        )
    text = f"{open_document_opening(paper)}" + "\n".join(lines) + "\n</open_document>"
    return {"role": "user", "content": [{"type": "input_text", "text": text}]}


def build_responses_input(
    sources: list[tuple[dict[str, Any], PdfSource | None]],
    previous_messages: list[dict[str, Any]],
    body: ChatRequest,
    prompt_cache_enabled: bool = True,
    web_documents: dict[str, dict[str, Any]] | None = None,
    digest_cards: list[tuple[dict[str, Any], dict[str, Any]]] | None = None,
    image_blocks: list[dict[str, Any]] | None = None,
    memory_block: dict[str, Any] | None = None,
    companions: list[dict[str, Any]] | None = None,
    tool_names: frozenset[str] = frozenset(),
    project_documents: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """
    A reader question, as the stable part and then the part that changes.

    The first item is evidence and is the cached prefix: the open document's
    PDF when it is one, the project library, then any @-referenced PDFs. After
    the history comes what is true of this turn only — which document is open
    and what this request holds for it — then the Memory block and the
    question (`tail_input`).

    `project_documents` is the library's rows in project order. Without it the
    rows are the attached documents followed by `companions`, which is the
    same set in a different order.
    """
    web_documents = web_documents or {}
    digest_cards = digest_cards or []
    documents = project_documents or [
        *(paper for paper, _ in sources),
        *(companions or []),
    ]
    library = project_library_blocks(
        documents, digest_cards, tool_names, prompt_cache_enabled
    )
    pdf_blocks = [pdf_input_block(pdf) for _, pdf in sources if pdf is not None]
    if prompt_cache_enabled and pdf_blocks:
        pdf_blocks[0]["prompt_cache_breakpoint"] = {"mode": "explicit"}
        pdf_blocks[-1]["prompt_cache_breakpoint"] = {"mode": "explicit"}
    # The open document is the first source. Its PDF stays the first and
    # largest block, ahead of the library, so a regenerated digest never costs
    # it; PDFs the reader @-referenced change per question and go last.
    open_pdf = pdf_blocks[:1] if sources and sources[0][1] is not None else []
    evidence = [*open_pdf, *library, *pdf_blocks[len(open_pdf):]]
    return [
        {"role": "user", "content": evidence},
        *tail_input(
            previous_messages,
            memory_block,
            body.prompt,
            body.selected_text,
            image_blocks,
            turn_context=turn_context_block(
                body, sources, web_documents, {paper["id"] for paper, _ in digest_cards}
            ),
            side_turns=body._side,
        ),
    ]


def tail_input(
    previous_messages: list[dict[str, Any]],
    memory_block: dict[str, Any] | None,
    prompt: str,
    selected_text: str | None = None,
    image_blocks: list[dict[str, Any]] | None = None,
    turn_context: dict[str, Any] | None = None,
    side_turns: list[SideTurn] | None = None,
) -> list[dict[str, Any]]:
    """
    Everything after the evidence: history, the Memory block, then the question.

    `turn_context` is what is true of this turn only — the document open
    beside the conversation (`turn_context_block` for a reader scope,
    `open_document_block` for the account-wide one). It goes ahead of the
    Memory block (`memory_block`: `reader_memory_block` beside a project,
    `reader_position_block` in Memory chat), which keeps that block at
    position −2 in every scope.

    Shared by both scopes, and shared on purpose. The Memory block's
    position is invariant 39 — after the documents and the history, before the
    question, and never in `instructions`. Instructions and the document blocks
    are the cached prefix and this changes almost every turn, so anywhere
    earlier means one remembered fact invalidates every PDF and digest block in
    the request. Last position is the only cheap position, which is also what
    lets the block be unconditional for every persona.

    Writing that placement once rather than once per scope is the point: three
    copies of a rule about *position* is three chances for one of them to drift
    somewhere that quietly costs a cache hit on every request.

    History is bounded to the last ten complete exchanges and projected to role/content
    alone, so a stored trace can never re-enter a request (invariant 40).

    A side chat (`side_turns`, never None for one, even when empty) follows
    the history behind `SIDE_CHAT_MARKER`, so the model can tell its own turns
    from the conversation it shares. What is true of this turn and the
    question still come last, in the same places.
    """
    selected = (
        f"\n\nQuoted passage selected by the user:\n{selected_text}"
        if selected_text
        else ""
    )
    from ..chat_history import history_input

    history = history_input(previous_messages)
    final_content: str | list[dict[str, Any]] = f"{prompt}{selected}"
    if image_blocks:
        final_content = [
            {"type": "input_text", "text": f"{prompt}{selected}"},
            *image_blocks,
        ]
    side = [] if side_turns is None else [
        {"role": "user", "content": SIDE_CHAT_MARKER},
        *(
            message
            for turn in side_turns
            for message in (
                {"role": "user", "content": turn.question},
                {"role": "assistant", "content": turn.answer},
            )
        ),
    ]
    return [
        *history,
        *side,
        *([turn_context] if turn_context else []),
        *([memory_block] if memory_block else []),
        {"role": "user", "content": final_content},
    ]


@dataclass(frozen=True)
class ReaderMemory:
    """What choosing Memory pages for a Project question came to."""

    #: The `<reader_memory>` block, or None when Memory is switched off.
    block: dict[str, Any] | None
    #: The pages opened into the request, in the order they were chosen.
    opened: list[str] = field(default_factory=list)
    #: How much there was to choose from: pages, documents, projects.
    index: dict[str, int] = field(default_factory=dict)
    #: False when Memory could not be consulted, which is not "nothing chosen".
    available: bool = True


async def select_reader_memory(
    client: httpx.AsyncClient,
    storage: Storage,
    username: str,
    settings: Settings,
    body: ChatRequest,
    previous_messages: list[dict[str, Any]],
    *,
    open_paper: dict[str, Any] | None,
    held: list[dict[str, Any]],
    objects: ObjectStore,
) -> "ReaderMemory":
    """
    The Memory pages a Project question is handed, chosen by meaning.

    One small call reads the whole Memory index and names up to four pages;
    they are opened here and ride beside the question (`reader_memory_block`).
    This replaced a block built by counting the question's words in each page,
    which is the selection Memory chat stopped using because it ranked the
    pages that mattered behind every page that shared a common word. The call
    also reads the opening of the open PDF's text: a title alone hides what
    the work builds on.

    `held` is the documents the request already carries, as a digest or as
    the document itself: their source pages would be the same text twice.
    The open document's own page is the exception, and leads what is opened
    whatever the call chose: it links to what the document builds on, and
    opening it puts the first lines of those pages in front of the answer.

    Returns the block, the slugs it opened, how much it chose from and whether
    Memory could be consulted at all. It may never fail an answer:
    whatever goes wrong — the index, the call, its time limit, opening the
    pages — the block says Memory could not be consulted, which is a different
    statement from a considered "nothing bears on this", and the model still
    has the Memory tools.
    """
    if not settings.memory_enabled:
        return ReaderMemory(None)
    started = time.monotonic()
    try:
        # No conversations in this index: they reorder on every message, and
        # the index is this call's cached prefix.
        graph, _, index_text, counts = await run_in_threadpool(
            selection_index, storage, username, settings
        )
        if not graph.pages:
            return ReaderMemory(reader_memory_block(None, "empty", max_chars=settings.memory_inline_max_chars))
        earlier = [
            str(message.get("content") or "")
            for message in previous_messages
            if message.get("role") == "user" and message.get("content")
        ]
        # A side question follows its own exchanges, not the main thread's.
        earlier = [*earlier, *(turn.question for turn in getattr(body, "_side", None) or [])][-2:]
        opening = None
        if open_paper and not is_web(open_paper):
            try:
                opening = await run_in_threadpool(
                    objects.get_text, paper_key(username, body.project_id, open_paper["id"], "txt")
                )
            except Exception:
                opening = None  # not extracted, or unreadable: the title alone
        payload = memory_selection_request(
            index_text,
            memory_selection_turn(
                body.prompt,
                body.selected_text,
                earlier,
                open_paper.get("title") if open_paper else None,
                [paper.get("title", "Untitled paper") for paper in held],
                opening[:1_500] if opening else None,
            ),
            model=settings.memory_select_model,
            effort=settings.memory_select_reasoning_effort,
            max_output_tokens=settings.memory_select_max_output_tokens,
            prompt_cache_enabled=settings.openai_prompt_cache_enabled,
        )
        # No service tier: the reader waits on this call inside a fixed limit,
        # and a queue that trades latency for price cannot meet it.
        if settings.openai_prompt_cache_enabled:
            key = hashlib.sha256(
                f"{username}\0memory-select\0{PROMPT_CACHE_VERSION}".encode()
            ).hexdigest()[:24]
            payload["prompt_cache_key"] = f"delphi:{PROMPT_CACHE_VERSION}:{key}"
            payload["prompt_cache_options"] = {"mode": "explicit", "ttl": "30m"}
        # One limit on the whole exchange. httpx's own timeout is per phase,
        # so a slow connect, a slow first byte and a slow body could each
        # spend it in turn.
        result = require_completed(
            await asyncio.wait_for(
                ResponsesClient(client, settings).complete(payload),
                settings.memory_select_timeout_seconds,
            ),
            "Memory selection",
        )
        chosen = selected_slugs(
            {"output": result.output}, graph, {paper["id"] for paper in held}
        )
        centre = graph.source_page_by_paper_id.get(open_paper["id"]) if open_paper else None
        if centre:
            # One of the chooser's slots: the document itself is already in the request.
            chosen = [centre["slug"], *(slug for slug in chosen if slug != centre["slug"])][:SELECT_MAX_PAGES]
        opened_text, opened = "", []
        if chosen:
            opened_text, opened, _ = await run_in_threadpool(
                open_chosen_memory,
                chosen,
                storage,
                username,
                settings,
                settings.memory_inline_max_chars,
            )
    except Exception as exc:
        logger.warning(
            "memory selection unavailable after %sms: %s: %s",
            round((time.monotonic() - started) * 1000), type(exc).__name__, exc,
        )
        return ReaderMemory(reader_memory_block(None, "unavailable", max_chars=settings.memory_inline_max_chars), available=False)
    logger.info(
        "memory_selection pages=%s chosen=%s ms=%s",
        len(graph.pages), opened, round((time.monotonic() - started) * 1000),
    )
    return ReaderMemory(
        reader_memory_block(opened_text if opened else None, "none", max_chars=settings.memory_inline_max_chars),
        opened,
        # No conversations were shown, so none are counted as chosen from.
        {key: value for key, value in counts.items() if key != "conversations"},
    )


def resolve_model(settings: Settings, requested: str | None) -> str:
    """Honour the client's choice only if the server offers it."""
    if requested and requested in settings.models:
        return requested
    return settings.model_default


def resolve_reasoning_effort(
    settings: Settings,
    requested: str | None,
    model: str | None = None,
) -> str:
    """Honour the choice only when the selected model supports it."""
    resolved_model = resolve_model(settings, model)
    offered = settings.reasoning_efforts_for(resolved_model)
    if requested and requested in offered:
        return requested
    if settings.reasoning_effort_default in offered:
        return settings.reasoning_effort_default
    return offered[0]


def toolset_for_scope(
    settings: Settings,
    body: ChatRequest,
    *,
    web_documents: dict[str, dict[str, Any]] | None = None,
    companions: list[dict[str, Any]] | None = None,
) -> Toolset:
    """
    What a scope may reach for: the profile's offers that apply to this turn.

    The profile (`harness.profiles`) says which tools a scope has and when;
    this says what is true of the turn. `read_paper` follows the digests: the
    attached PDFs are here whole, and the rest of the project (`companions`)
    is here only as digests.
    """
    # Web search is the task's to have and the operator's to switch off. No
    # request carries a say in it: the model decides when to search.
    web = settings.web_search_enabled and MODEL_TASK_BY_KEY["chat.answer"].web
    if body.scope == "general":
        return profiles.CHAT_GENERAL.toolset(
            profiles.Turn(
                settings,
                web=web,
                artifacts=body.mode != "plan" and not body.disable_artifacts,
                url_reads=body.mode != "plan",
            )
        )
    return profiles.CHAT_DOCUMENT.toolset(
        profiles.Turn(
            settings,
            web=web,
            artifacts=body.mode != "plan" and not body.disable_artifacts,
            url_reads=body.mode != "plan",
            web_documents=bool(web_documents),
            companion_pdfs=any(not is_web(paper) for paper in companions or ()),
        )
    )


def build_responses_payload(
    *,
    settings: Settings,
    username: str,
    project_id: str,
    project_skills: str,
    sources: list[tuple[dict[str, Any], PdfSource | None]],
    previous_messages: list[dict[str, Any]],
    body: ChatRequest,
    web_documents: dict[str, dict[str, Any]] | None = None,
    digest_cards: list[tuple[dict[str, Any], dict[str, Any]]] | None = None,
    image_blocks: list[dict[str, Any]] | None = None,
    persona: dict[str, Any] | None = None,
    memory_block: dict[str, Any] | None = None,
    use_standard_tier: bool = True,
    companions: list[dict[str, Any]] | None = None,
    turn_context: dict[str, Any] | None = None,
    memory_index: dict[str, Any] | None = None,
    project_documents: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    model = resolve_model(settings, body.model)
    general = body.scope == "general"
    toolset = toolset_for_scope(
        settings, body, web_documents=web_documents, companions=companions
    )
    tools = toolset.specs()
    payload: dict[str, Any] = {
        "model": model,
        # One order of sections for both scopes (`harness.prompts`): what a
        # claim may rest on and the evidence requirements are shared, each
        # scope has its own section on how its request is laid out, and the
        # persona comes in the one wrapper that bounds it, followed only by
        # the explanation contract, which it may not outrank.
        "instructions": compose_instructions(
            body.scope,
            toolset,
            project_skills or str((persona or {}).get("content") or ""),
            side=body._side is not None,
            # Core's Plan mode and the desktop's, which says so with its own flag.
            explain=body.mode != "plan" and not body.disable_explanation_contract,
        ),
        "input": (
            [
                # First, and alone ahead of the history: the index is the same
                # for every question, so it is the general scope's cached prefix.
                *([memory_index] if memory_index else []),
                *tail_input(previous_messages, memory_block, body.prompt,
                            body.selected_text, image_blocks=image_blocks,
                            turn_context=turn_context, side_turns=body._side),
            ]
            if general
            else build_responses_input(
                sources,
                previous_messages,
                body,
                settings.openai_prompt_cache_enabled,
                web_documents,
                digest_cards,
                image_blocks,
                memory_block,
                companions,
                toolset.names,
                project_documents,
            )
        ),
        # Summaries are the only reasoning content the API exposes, and they are
        # opt-in. Accounts without access simply stream none of them.
        "reasoning": {
            "effort": resolve_reasoning_effort(
                settings, body.reasoning_effort, model
            ),
            "summary": "auto",
        },
        # One response's ceiling, shared by reasoning and visible output, and
        # the same in both scopes (`chat.answer` in `model_tasks`).
        "max_output_tokens": settings.model_max_output_tokens,
        "store": False,
        # Nothing is stored, so the model's reasoning can only reach its next
        # round if it is handed back, and the provider releases it for that
        # only in this sealed form (`harness.replay`). A hosted tool adds what
        # the trace needs to say about its calls.
        "include": ["reasoning.encrypted_content", *toolset.include()],
        "stream": True,
    }
    if not general:
        payload["text"] = {"verbosity": "low"}
    if tools:
        # Omitted entirely when empty: an empty tools list would perturb the
        # cached prefix for every ordinary question. A question about PDFs alone
        # therefore still sends exactly what it sent before web documents existed.
        payload["tools"] = tools
    service_tier = service_tier_for(settings, use_standard_tier)
    if service_tier:
        payload["service_tier"] = service_tier
    # Two guards, because "the account-wide scope silently acquires a cached
    # prefix" is the one failure here that nothing downstream would report. It
    # has no `sources`, so the second clause already refuses it; the explicit
    # scope test is there so that a later change giving general a source block
    # cannot quietly mint a key for a prefix that is different every turn.
    if (
        settings.openai_prompt_cache_enabled
        and sources
        and body.scope != "general"
    ):
        payload["prompt_cache_key"] = request_prompt_cache_key(
            username,
            project_id,
            body,
            persona,
        )
        payload["prompt_cache_options"] = {
            "mode": "explicit",
            "ttl": "30m",
        }
    elif settings.openai_prompt_cache_enabled and general and memory_index:
        # The one prefix the general scope has: instructions, then the index.
        # Keyed by account and persona only — the index changes when Memory or
        # the library does, and a stale key then simply misses once.
        persona_identity = (
            f"{persona.get('id')}:{persona.get('revision', 0)}" if persona else "none"
        )
        side = "\0side" if body._side is not None else ""
        digest = hashlib.sha256(
            f"{username}\0memory-index\0{persona_identity}{side}\0{PROMPT_CACHE_VERSION}".encode()
        ).hexdigest()[:24]
        payload["prompt_cache_key"] = f"delphi:{PROMPT_CACHE_VERSION}:{digest}"
        payload["prompt_cache_options"] = {"mode": "explicit", "ttl": "30m"}
    if body.mode == "plan":
        if not body._plan:
            raise HTTPException(400, "Plan mode requires the unified chat endpoint")
        from ..plans import plan_fence_note, plan_instructions
        payload["instructions"] += plan_instructions()
        # The token is new every turn, so it rides on the question: in the
        # instructions it would make every Plan turn a cold prefix.
        question = payload["input"][-1]
        note = plan_fence_note(body._plan)
        payload["input"][-1] = {**question, "content": (
            question["content"] + note if isinstance(question["content"], str)
            else [*question["content"], {"type": "input_text", "text": note}]
        )}
    return payload


@router.get("/config")
def config(settings: Settings = Depends(get_settings)):
    return {
        "capabilities": {"traceVersion": 2, "planAuthoring": bool(settings.api_key), "planHandoff": True, "providerManagement": False},
        "providerConfigured": bool(settings.api_key),
        "defaultModel": settings.model_default,
        "models": settings.models,
        "defaultReasoningEffort": settings.reasoning_effort_default,
        "reasoningEfforts": settings.reasoning_efforts,
        "modelReasoningEfforts": settings.model_reasoning_efforts,
        # Whether register will refuse a blank invite code, so the form can say so.
        "signupCodeRequired": bool(settings.required_signup_code),
        "maxPapersPerProject": settings.max_papers_per_project,
        "maxPapersTotalPerProject": settings.max_papers_total_per_project,
        "maxUploadMb": settings.max_upload_mb,
        # What the client may still offer to send: between the two, an upload
        # is compressed and then offered back at its new size.
        "maxUploadSourceMb": settings.max_upload_source_mb,
        "maxPagesPerPaper": settings.max_pages_per_paper,
        "webDocumentsEnabled": settings.web_documents_enabled,
        "webBrowsingEnabled": settings.web_browsing_enabled,
        "webSavedPageMaxBytes": settings.web_saved_page_max_bytes,
        "chatImageMaxPerQuestion": settings.chat_image_max_per_question,
        "chatImageMaxPerThread": settings.chat_image_max_per_thread,
        "chatImageMaxThreadBytes": settings.chat_image_max_thread_bytes,
        "chatImageMaxSourceMb": settings.chat_image_max_source_mb,
        "chatImageMaxSourcePixels": settings.chat_image_max_source_pixels,
        "chatImageMaxSide": settings.chat_image_max_side,
        "chatImageRetentionDays": settings.chat_image_retention_days,
        # The one spelling of the default. It was written by hand as "adhd" in
        # the client and twice in this file; a default with three spellings is
        # a default that drifts the first time it changes.
        "defaultPersona": DEFAULT_PERSONA_KEY,
        "personaMarketplaceEnabled": settings.persona_marketplace_enabled,
        "personaMaxCharacters": settings.persona_max_characters,
        "personaMaxNameCharacters": settings.persona_max_name_characters,
        "personaMaxTaglineCharacters": settings.persona_max_tagline_characters,
        "conversationTitleMaxCharacters": CONVERSATION_TITLE_MAX_CHARS,
        "librarySearchEnabled": settings.library_search_enabled,
        "librarySearchMaxResults": settings.library_search_max_results,
        "memoryEnabled": settings.memory_enabled,
        "memoryMaxPages": settings.memory_max_pages,
        "memoryPageMaxCharacters": settings.memory_page_max_chars,
        "memoryRelatedHops": settings.memory_related_hops,
        "memoryRewriteNoteMaxWords": settings.memory_rewrite_note_max_words,
    }


def _store_chat_image(
    storage: Storage,
    objects: ObjectStore,
    settings: Settings,
    username: str,
    ref: ScopeRef,
    image: UploadFile,
) -> dict[str, Any]:
    """Normalize, write the bytes, then the record — invariant 7, as always."""
    normalized = normalize_chat_image(
        image,
        max_source_bytes=settings.chat_image_max_source_mb * 1024 * 1024,
        max_pixels=settings.chat_image_max_source_pixels,
        max_side=settings.chat_image_max_side,
        thumbnail_side=settings.chat_image_thumbnail_side,
    )
    image_id = uuid4().hex
    image_key = chat_image_key(
        username, ref.project_id, ref.thread_key, image_id, "image"
    )
    thumbnail_key = chat_image_key(
        username, ref.project_id, ref.thread_key, image_id, "thumb"
    )
    now = datetime.now(UTC)
    record = {
        "id": image_id,
        "width": normalized.width,
        "height": normalized.height,
        "sourceBytes": normalized.source_bytes,
        "normalizedBytes": normalized.normalized_bytes,
        "sourceFormat": normalized.source_format,
        "imageKey": image_key,
        "thumbnailKey": thumbnail_key,
        "createdAt": now.isoformat(),
        "expiresAt": (now + timedelta(days=settings.chat_image_retention_days)).isoformat(),
    }
    try:
        try:
            objects.put_file(image_key, normalized.image_path, "image/webp")
            objects.put_file(thumbnail_key, normalized.thumbnail_path, "image/webp")
            stored = storage.add_chat_image(
                username,
                ref.project_id,
                ref.thread_key,
                record,
                max_count=settings.chat_image_max_per_thread,
                max_bytes=settings.chat_image_max_thread_bytes,
            )
        except Exception:
            objects.delete(image_key)
            objects.delete(thumbnail_key)
            raise
    finally:
        normalized.cleanup()
    return public_chat_image(stored)


def _serve_chat_image(
    storage: Storage,
    objects: ObjectStore,
    username: str,
    ref: ScopeRef,
    image_id: str,
    variant: str,
) -> StreamingResponse:
    if variant not in {"image", "thumbnail"}:
        raise HTTPException(404, "Image unavailable")
    record = storage.get_chat_image(
        username, ref.project_id, ref.thread_key, image_id
    )
    if record["expiresAt"] <= utc_now():
        raise HTTPException(404, "Image unavailable")
    object_key = record["imageKey" if variant == "image" else "thumbnailKey"]
    return StreamingResponse(
        objects.open_range(object_key),
        media_type="image/webp",
        headers={"Cache-Control": "private, max-age=300"},
    )


def _drop_chat_image(
    storage: Storage,
    objects: ObjectStore,
    username: str,
    ref: ScopeRef,
    image_id: str,
) -> None:
    record = storage.delete_unused_chat_image(
        username, ref.project_id, ref.thread_key, image_id
    )
    objects.delete(record["imageKey"])
    objects.delete(record["thumbnailKey"])


@router.post("/chat/images", status_code=201)
def unified_upload_chat_image(
    image: UploadFile = File(...),
    scope: ChatScope = Query(default="document"),
    project_id: str | None = Query(default=None),
    paper_id: str | None = Query(default=None),
    conversation_id: str = Query(),
    generation: int | None = None,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    return _store_chat_image(
        storage, objects, settings, username,
        conversation_scope(storage, username, scope, project_id, paper_id, conversation_id, generation), image,
    )


@router.get("/chat/images/{image_id}/{variant}")
def unified_preview_chat_image(
    image_id: str,
    variant: str,
    scope: ChatScope = Query(default="document"),
    project_id: str | None = Query(default=None),
    paper_id: str | None = Query(default=None),
    conversation_id: str = Query(),
    generation: int | None = None,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
):
    return _serve_chat_image(
        storage, objects, username,
        conversation_scope(storage, username, scope, project_id, paper_id, conversation_id, generation), image_id, variant,
    )


@router.delete("/chat/images/{image_id}", status_code=204)
def unified_remove_chat_image(
    image_id: str,
    scope: ChatScope = Query(default="document"),
    project_id: str | None = Query(default=None),
    paper_id: str | None = Query(default=None),
    conversation_id: str = Query(),
    generation: int | None = None,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
):
    _drop_chat_image(
        storage, objects, username,
        conversation_scope(storage, username, scope, project_id, paper_id, conversation_id, generation), image_id,
    )


# --- One front door for both scopes ------------------------------------------
#
# One request body (`ChatRequest`), one stream (`chat_stream`) and one payload
# assembler (`build_responses_payload`) serve both scopes; the only branch is
# inside the stream's context preparation, where `document` gathers files,
# digests and the viewport while `general` lays out the whole Memory index
# (`build_general_payload`). Everything that decides *what the model sees* —
# how Memory is reached (`memory_harness`), the tool list (`tools_for_scope`),
# the history projection and the Memory block's position (`tail_input`) —
# is shared, so the scopes cannot drift on any of it.
#
# These routes exist so the client has one address and one wire shape. The
# account-wide scope could never live under `/api/projects/{id}/…` because it
# has no project, which is the whole reason the unified path is flat.


@router.post("/chat/stream")
def unified_chat_stream(
    body: ChatRequest,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """Ask a question against whichever evidence `scope` names."""
    if body.mode == "plan":
        if not settings.api_key:
            raise HTTPException(503, "Plan authoring needs a configured provider")
        from ..plans import reserve, release
        body._plan = reserve(storage, username, body)
        if body._plan.get("saved"):
            from ..plans import summary, visible_result
            saved = summary(body._plan["saved"])
            ref = conversation_scope(storage, username, body.scope, body.project_id, body.paper_id,
                                     body.conversation_id, body.generation)
            row = storage.get_conversation(username, body.conversation_id)
            if not any(m.get("requestId") == body.request_id and m.get("role") == "assistant" for m in row.get("messages", [])):
                try:
                    append_turn(storage, username, ref, {"role": "assistant", "content": visible_result(saved),
                        "createdAt": utc_now(), "requestId": body.request_id, "plan": saved})
                except HTTPException as exc:
                    if exc.status_code != 409:
                        raise
                    # A newer turn may already have closed the crashed request.
                    # The durable receipt remains authoritative through history.

            async def replay():
                yield sse({"type": "delta", "text": visible_result(saved), "requestId": body.request_id, "conversationId": body.conversation_id})
                yield sse({"type": "done", "plan": saved, "requestId": body.request_id, "conversationId": body.conversation_id})
            return event_stream(replay())
    try:
        return chat_stream(body, username, storage, objects, settings)
    except Exception:
        if body._plan:
            release(storage, username, body._plan)
        raise


@router.post("/chat/side")
def unified_side_chat(
    body: SideChatRequest,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """Ask a side question beside a conversation, storing nothing (`side_chat_stream`)."""
    return side_chat_stream(body, username, storage, objects, settings)


@router.post("/chat/cancel", status_code=204)
def unified_cancel_chat(
    body: ChatCancelRequest,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    """
    Mark a request cancelled, in whichever conversation it belongs to.

    The account-wide scope gains a stored cancellation here that it never had:
    its Stop used to be client-side only, so a thread reloaded after a stop
    showed the question with no answer and no explanation. It goes through
    `append_turn`, and a cancelled answer holds no session job.
    """
    ref = conversation_scope(
        storage, username, body.scope, body.project_id, body.paper_id,
        body.conversation_id, body.generation,
    )
    thread = read_thread(storage, username, ref)
    if any(
        message.get("requestId") == body.request_id
        and message.get("role") == "assistant"
        for message in thread.get("messages", [])
    ):
        return
    append_turn(
        storage,
        username,
        ref,
        {
            "role": "assistant",
            "content": "Request cancelled.",
            "cancelled": True,
            "createdAt": utc_now(),
            "requestId": body.request_id,
        },
    )


@router.get("/chat")
def unified_chat_history(
    scope: ChatScope = "document",
    project_id: str | None = None,
    paper_id: str | None = None,
    conversation_id: str = Query(),
    generation: int | None = None,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    ref = conversation_scope(
        storage, username, scope, project_id, paper_id, conversation_id, generation
    )
    thread = read_thread(storage, username, ref)
    thread["images"] = [
        public_chat_image(image)
        for image in storage.list_chat_images(
            username, ref.project_id, ref.thread_key, utc_now()
        )
    ]
    return thread


@router.put("/chat/persona", status_code=204)
def unified_set_chat_persona(
    body: ChatPersonaSelect,
    scope: ChatScope = "document",
    project_id: str | None = None,
    paper_id: str | None = None,
    conversation_id: str = Query(),
    generation: int | None = None,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    """
    Remember the persona before anything has been asked in it.

    The stream already stamps whichever persona answered, so this route exists
    only for the gap between picking one and sending: without it, choosing a
    persona and reloading loses the choice, and the pill would contradict itself
    on the reader's next visit.

    Validated through the same resolver a request goes through, so a persona
    another account owns is refused here rather than being stored and refused
    later. The conversation must already exist (`create_conversation`).
    """
    ref = conversation_scope(
        storage, username, scope, project_id, paper_id, conversation_id, generation
    )
    persona = resolve_persona_for_request(storage, username, body.persona_id)
    set_scope_persona(storage, username, ref, str(persona["id"]))


@router.delete("/chat")
def unified_clear_chat(
    scope: ChatScope = "document",
    project_id: str | None = None,
    paper_id: str | None = None,
    conversation_id: str = Query(),
    generation: int | None = None,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
):
    ref = conversation_scope(
        storage, username, scope, project_id, paper_id, conversation_id, generation
    )
    thread = read_thread(storage, username, ref)
    # Deletes it, or clears it in place when it is the context's last one.
    result = storage.delete_conversation(username, thread["conversationId"], thread["generation"])
    for image in result.pop("images"):
        for key in ("imageKey", "thumbnailKey"):
            objects.delete(image[key])
    result["catalog"] = storage.list_scope_conversations(username, scope, project_id, paper_id)
    if scope == "document" and paper_id:
        # Captured evidence is keyed by the page's hash, so a document's other
        # conversations may cite the same object: only what none of them
        # still cites goes, and only after the record that cited it (inv. 7).
        orphaned = _evidence_ids(thread)
        for item in result["catalog"]["items"]:
            if orphaned:
                orphaned -= _evidence_ids(storage.get_thread(
                    username, project_id or "", selector(item["id"], item["generation"])))
        for evidence_id in orphaned:
            objects.delete(evidence_key(username, paper_id, evidence_id))
    return result


def _evidence_ids(thread: dict[str, Any]) -> set[str]:
    return {
        str(message["viewportEvidence"]["evidenceId"])
        for message in thread.get("messages", [])
        if isinstance(message.get("viewportEvidence"), dict)
        and message["viewportEvidence"].get("evidenceId")
    }


async def build_general_payload(
    storage: Storage,
    username: str,
    settings: Settings,
    body: ChatRequest,
    previous_messages: list[dict[str, Any]],
    *,
    persona: dict[str, Any] | None = None,
    use_standard_tier: bool,
    image_blocks: list[dict[str, Any]] | None = None,
    open_paper: dict[str, Any] | None = None,
    open_digest: dict[str, Any] | None = None,
    record: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    The account-wide chat's request, which is the reader's minus every document.

    Minus every *attached* document: `open_paper` is the one the reader has
    open beside the conversation, and it arrives as its digest and as a seed
    for the block, never as a file.

    The request's `ChatRequest` is passed straight through rather than
    translated: retrieval, the tool list, the history projection and the
    Memory block's position all come from the shared `build_responses_payload`,
    so the two scopes cannot drift on any of the properties that would cost
    the most to get wrong.
    """
    # No retrieval before the model is asked: it is shown the whole index and
    # chooses by meaning (`memory_harness`). What is open beside the chat is
    # said next to the question, never in the index, which stays one prefix.
    graph, _, index_text, counts = await run_in_threadpool(
        lambda: selection_index(storage, username, settings, conversations=True)
    )
    opened = [
        slug
        for slug in (
            (graph.source_page_by_paper_id.get(open_paper["id"]) or {}).get("slug")
            if open_paper
            else None,
            graph.resolve_slug(memory_slug(body.page_slug)) if body.page_slug else None,
        )
        if slug and slug in graph.pages_by_slug
    ]
    if record is not None:
        page = graph.pages_by_slug.get(opened[0]) if opened else None
        # What the reader had open beside the chat, as the trace says it.
        record["start"] = (
            {
                "kind": "document",
                "title": open_paper.get("title") or "",
                "paperId": open_paper["id"],
                **({"slug": page["slug"]} if page else {}),
            }
            if open_paper
            else {
                "kind": "page",
                "slug": page["slug"],
                "title": page.get("title") or page["slug"],
                "pageKind": page.get("kind") or "",
            }
            if page
            else {"kind": "question"}
        )
        record["index"] = {
            "pages": counts["pages"],
            "documents": counts["documents"],
            "projects": counts["projects"],
            "chats": counts["conversations"],
        }
    block = (
        reader_position_block(graph, opened[0]) if opened and not open_paper else None
    )
    return build_responses_payload(
        settings=settings,
        username=username,
        project_id="",
        project_skills="",
        sources=[],
        previous_messages=previous_messages,
        body=body,
        persona=persona,
        memory_block=block,
        memory_index=memory_index_block(
            index_text, settings.openai_prompt_cache_enabled
        ),
        image_blocks=image_blocks,
        turn_context=(
            open_document_block(open_paper, open_digest) if open_paper else None
        ),
        use_standard_tier=use_standard_tier,
    )


@dataclass
class AnswerRun:
    """
    One answer: what it is built from, and what running it came to.

    `prepare_answer` fills the first half before the stream opens and
    `run_answer` the second while it runs. `chat_stream` stores what the run
    came to and `side_chat_stream` stores nothing, so this, and the two
    functions that fill it, are the whole of what the routes share.
    """

    body: ChatRequest
    ref: ScopeRef
    meta: dict[str, Any]
    papers: list[dict[str, Any]]
    open_paper: dict[str, Any] | None
    persona: dict[str, Any]
    thread: dict[str, Any]
    model: str
    reasoning_effort: str
    use_standard_tier: bool
    request_id: str
    previous_messages: list[dict[str, Any]] = field(default_factory=list)
    image_records: list[dict[str, Any]] = field(default_factory=list)
    started: float = 0.0
    # How the answer was reached, kept alongside it so a reader can see
    # the path a month later instead of asking the same question again.
    record: AnswerTrace = field(default_factory=lambda: AnswerTrace(time.monotonic()))
    answer: str = ""
    # What the turn spent, summed across its rounds, and how it ended.
    budget: TurnBudget | None = None
    turn: TurnResult | None = None
    estimated_context_tokens: int = 0
    first_provider_event_ms: int | None = None
    context_ready_ms: int | None = None
    model_wait_started: float | None = None
    viewport_evidence: dict[str, Any] | None = None
    #: The answer stopped because `live` said so, not because it ended.
    stopped: bool = False

    def start(self) -> None:
        self.started = time.monotonic()
        self.record = AnswerTrace(self.started)

    def elapsed_ms(self) -> int:
        return round((time.monotonic() - self.started) * 1000)


def conversation_history(
    storage: Storage, username: str, ref: ScopeRef, thread: dict[str, Any]
) -> list[dict[str, Any]]:
    """The thread's stored messages with its plans' history folded in."""
    from ..plans import history as plan_history
    from ..storage.conversations import require_selector
    history_id, history_generation = require_selector(ref.thread_key)
    return plan_history(storage, username, history_id, history_generation, thread["messages"])


def prepare_answer(
    body: ChatRequest, username: str, storage: Storage, settings: Settings
) -> AnswerRun:
    """
    Everything an answer is built from that can refuse the request.

    Run before the stream opens, so a bad scope, a conversation that is not
    the reader's, a stale generation or an unknown persona is an ordinary
    status rather than an event in a half-open stream. It reads and never
    writes.
    """
    general = body.scope == "general"
    if body.mode == "plan" and not body._plan:
        raise HTTPException(400, "Plan mode requires the unified chat endpoint")
    if general:
        if not settings.memory_enabled:
            raise HTTPException(403, "Memory is turned off on this server")
    else:
        if not body.project_id:
            raise HTTPException(400, "This scope needs a project")
        if body.viewport is not None and body.viewport.source == "anonymous" and not settings.web_browsing_enabled:
            raise HTTPException(403, "In-app browsing is turned off on this server")
    ref = conversation_scope(
        storage, username, body.scope, body.project_id, body.paper_id,
        body.conversation_id, body.generation,
    )
    if general:
        meta: dict[str, Any] = {}
        papers: list[dict[str, Any]] = []
        # The document open beside the conversation, if the client named one.
        # Looked up before the stream opens so a document that is not this
        # reader's is the storage layer's ordinary 404 rather than an event.
        open_paper = (
            storage.get_paper(username, body.project_id, body.paper_id)
            if body.project_id and body.paper_id
            else None
        )
    else:
        meta, papers = request_papers(storage, username, ref.project_id, body)
        open_paper = None
    account = storage.get_account(username) or {}
    model = resolve_model(settings, body.model)
    # Resolved once, before the stream opens, and before the user turn is even
    # appended. Two reasons it belongs here rather than inside the generator:
    # an unknown or unowned persona is a bad request and has to answer 404
    # rather than raising into a half-open event stream; and resolving once
    # means an edit landing mid-answer cannot change what this request was
    # built from, which would otherwise make one reply half of each. That
    # matters more than it used to, because the persona is now a menu the
    # reader can move *while* an answer streams rather than a project setting
    # they changed beforehand.
    #
    # The body used to come from `storage.get_skills`, which resolved the
    # project's persona. A persona belongs to the conversation now, so it is
    # either named on the request or read off the conversation, and either way
    # goes through the one resolver that establishes ownership.
    #
    # Reading the conversation is not a nicety. This used to be
    # `body.persona_id or DEFAULT_PERSONA_KEY`, which never looked at the
    # stored value at all — so a reader scope, whose client sends no
    # `persona_id`, answered as the default every turn no matter what the menu
    # said, and then `set_conversation_persona` stamped that default over
    # the pick `PUT /api/chat/persona` had just recorded. The pill said Mentor
    # and ADHD answered.
    #
    # Resolved *before* the replacement drop: a named persona that 404s must
    # refuse the edit, not arrive after the question it replaces is deleted.
    thread = storage.get_thread(username, ref.project_id, ref.thread_key)
    persona = persona_for_turn(
        storage, username, body.persona_id, thread.get("personaId")
    )
    if not settings.api_key:
        # After every check that names a fault in the request, before the
        # first write: a question nothing can answer must not drop the one it
        # replaces, or leave itself and a failure in the thread.
        raise HTTPException(503, "No model provider is configured")
    return AnswerRun(
        body=body,
        ref=ref,
        meta=meta,
        papers=papers,
        open_paper=open_paper,
        persona=persona,
        thread=thread,
        model=model,
        reasoning_effort=resolve_reasoning_effort(settings, body.reasoning_effort, model),
        use_standard_tier=bool(account.get("useStandardTier", True)),
        request_id=body.request_id or uuid4().hex,
    )


async def run_answer(
    run: AnswerRun,
    username: str,
    storage: Storage,
    objects: ObjectStore,
    settings: Settings,
    live: Callable[[], bool],
) -> AsyncIterator[dict[str, Any]]:
    """
    Build the request, run the model, and yield what the reader should see.

    Yields event payloads without the request's identity, which the caller
    stamps on. Writes nothing to the conversation: whether and how the answer
    is kept is the caller's. `live` is asked between model events; once it
    says no, the run stops with `run.stopped` set.
    """
    body = run.body
    general = body.scope == "general"
    project_id = run.ref.project_id
    papers = run.papers
    meta = run.meta
    persona = run.persona
    record = run.record
    previous_messages = run.previous_messages
    image_records = run.image_records
    use_standard_tier = run.use_standard_tier
    viewport_document: dict[str, Any] | None = None
    viewport_image: dict[str, Any] | None = None
    if not general:
        yield {
            "type": "progress",
            "stage": "context_build",
            "message": "Preparing paper context",
            "elapsedMs": 0,
            "current": 0,
            "total": len(papers),
        }
        if body.viewport is not None:
            yield {
                "type": "progress",
                "stage": "viewport_read",
                "message": "Reading the page you’re viewing",
                "elapsedMs": run.elapsed_ms(),
            }
            viewport_document, viewport_image, run.viewport_evidence = (
                await prepare_viewport_context(body, username, settings)
            )
    timeout = httpx.Timeout(
        settings.openai_request_timeout_seconds,
        connect=20,
    )
    async with httpx.AsyncClient(timeout=timeout) as client:
        if general:
            open_paper = run.open_paper
            image_blocks = (
                await run_in_threadpool(image_input_blocks, image_records, objects)
                if image_records
                else None
            )
            open_digest: dict[str, Any] | None = None
            if open_paper and digest_metadata_is_current(open_paper, settings):
                # Only a digest that already exists: this turn never waits for
                # one to be written, and a document without one is still named.
                try:
                    open_digest = await run_in_threadpool(
                        load_digest, objects, username, body.project_id, open_paper["id"]
                    )
                    cards, _ = compact_digest_cards(
                        [(open_paper, open_digest)], settings
                    )
                    open_digest = cards[0][1]
                except Exception:
                    open_digest = None
            record_context: dict[str, Any] = {}
            payload = await build_general_payload(
                storage,
                username,
                settings,
                body,
                previous_messages,
                persona=persona,
                use_standard_tier=use_standard_tier,
                image_blocks=image_blocks,
                open_paper=open_paper,
                open_digest=open_digest,
                record=record_context,
            )
            # Where the answer started and how much it was shown to choose
            # from: the half of how it got there that no call records.
            for change in record.context(
                record_context.get("start") or {"kind": "question"}, record_context.get("index") or None
            ):
                yield change
            web_documents: dict[str, dict[str, Any]] = {}
            titles: dict[str, str] = {}
            pdf_documents: dict[str, dict[str, Any]] = {}
            sources: list[tuple[dict[str, Any], PdfSource | None]] = []
            attached_pdf_ids: frozenset[str] = frozenset()
            memory_tool_max_calls = settings.memory_general_tool_max_calls
            toolset = toolset_for_scope(settings, body)
        else:
            digest_cards: list[tuple[dict[str, Any], dict[str, Any]]] | None = None
            yield {
                "type": "progress",
                "stage": "file_upload",
                "message": "Preparing complete paper inputs",
                "elapsedMs": run.elapsed_ms(),
                "current": 0,
                "total": len(papers),
            }
            sources = await ensure_openai_files(
                client,
                storage,
                objects,
                username,
                project_id,
                papers,
                settings,
            )
            web_documents = await load_web_documents(
                objects, username, project_id, papers
            )
            # Document scope is the project's chat: the open
            # document as itself, and the project library —
            # every active document as the digest it already has.
            (
                digest_cards,
                companions,
                run.estimated_context_tokens,
            ) = await ready_project_digests(
                objects, username, project_id, meta, papers, settings
            )
            web_documents.update(
                await load_companion_web_documents(
                    objects, username, project_id, companions
                )
            )
            if viewport_document is not None and body.paper_id:
                web_documents[body.paper_id] = viewport_document
            project_skills = persona["content"]
            if settings.memory_enabled:
                yield {
                    "type": "progress",
                    "stage": "context_build",
                    "message": "Choosing from your Memory",
                    "elapsedMs": run.elapsed_ms(),
                }
            # What the request already carries, as a digest or as the
            # document itself.
            held = {paper["id"]: paper for paper, _ in digest_cards or []}
            held.update({paper["id"]: paper for paper in papers})
            started_from = {
                "kind": "document",
                "title": papers[0].get("title") or "",
                "paperId": papers[0]["id"],
            }
            if settings.memory_enabled:
                # The reader waits on this call; the trace says so
                # while it runs, not only once it has returned.
                for change in record.context(started_from, memory="choosing"):
                    yield change
            memory = await select_reader_memory(
                client,
                storage,
                username,
                settings,
                body,
                previous_messages,
                open_paper=papers[0],
                held=list(held.values()),
                objects=objects,
            )
            memory_block = memory.block
            # What the answer starts from: what the reader is looking
            # at, and how much of Memory was chosen from.
            for change in record.context(
                started_from,
                memory.index,
                # These pages reached the answer and no call the model
                # made says so: they are part of what it was handed.
                given=await run_in_threadpool(
                    page_results, storage, username, settings, memory.opened
                ),
                # A considered nothing is said only where there was
                # something to consider: an empty Memory has no index.
                memory=(
                    "unavailable" if not memory.available
                    else "none" if memory.index else None
                ),
            ):
                yield change
            image_blocks = (
                await run_in_threadpool(image_input_blocks, image_records, objects)
                if image_records
                else None
            )
            if viewport_image is not None:
                image_blocks = [*(image_blocks or []), viewport_image]
            # The library's rows: the whole project in its own
            # order. A finished document is a row and nothing more,
            # so the model knows it exists and can open it.
            library_documents = list(meta.get("papers", []))

            def answer_payload() -> dict[str, Any]:
                return build_responses_payload(
                    settings=settings,
                    username=username,
                    project_id=project_id,
                    project_skills=project_skills,
                    sources=sources,
                    web_documents=web_documents,
                    previous_messages=previous_messages,
                    body=body,
                    digest_cards=digest_cards,
                    image_blocks=image_blocks,
                    persona=persona,
                    memory_block=memory_block,
                    use_standard_tier=use_standard_tier,
                    companions=companions,
                    project_documents=library_documents,
                )

            payload = answer_payload()
            # What the reading tools may open: everything attached,
            # and in document scope the rest of the project too.
            readable = [*papers, *companions]
            titles = {
                paper["id"]: paper["title"]
                for paper in readable
                if paper["id"] in web_documents
            }
            pdf_documents = {
                paper["id"]: paper for paper in readable if not is_web(paper)
            }
            attached_pdf_ids = frozenset(
                paper["id"] for paper, pdf in sources if pdf is not None
            )
            memory_tool_max_calls = None
            toolset = toolset_for_scope(
                settings, body, web_documents=web_documents, companions=companions
            )
        run.context_ready_ms = run.elapsed_ms()
        run.model_wait_started = time.monotonic()
        yield {
            "type": "progress",
            "stage": "model_wait",
            "message": (
                "Waiting for Standard capacity"
                if use_standard_tier
                else "Waiting for Flex capacity"
            ),
            "elapsedMs": run.elapsed_ms(),
        }
        repaired_files = False
        while True:
            try:
                run.budget = TurnBudget.for_chat(
                    settings, memory_calls=memory_tool_max_calls
                )
                async with aclosing(run_turn(
                    ResponsesClient(client, settings),
                    payload,
                    toolset,
                    run.budget,
                    ToolContext(
                        settings=settings,
                        username=username,
                        # No project for the account-wide scope: it is
                        # account-scoped, and `search_library` reaches
                        # every project anyway. The tools that need one
                        # are simply not offered.
                        project_id=project_id or "",
                        storage=storage,
                        objects=objects,
                        web_documents=web_documents,
                        titles=titles,
                        paper_documents=pdf_documents,
                        attached_pdf_ids=attached_pdf_ids,
                        offered=toolset.names,
                        artifacts=ArtifactSession(settings, enabled=not body.disable_artifacts) if body.mode != "plan" else None,
                    ),
                    recorder=record,
                )) as model_events:
                    async for model_event in model_events:
                        if model_event["type"] == "turn_end":
                            # How the turn ended is ours to act on, not
                            # the client's to interpret.
                            run.turn = model_event["result"]
                            continue
                        if run.first_provider_event_ms is None:
                            run.first_provider_event_ms = run.elapsed_ms()
                            yield {
                                "type": "progress",
                                "stage": "model_stream",
                                "message": "Response started",
                                "elapsedMs": run.first_provider_event_ms,
                            }
                        if not live():
                            run.stopped = True
                            return
                        if model_event["type"] == "delta":
                            if body.mode == "plan":
                                from ..plans import append_draft
                                run.answer = append_draft(run.answer, model_event["text"])
                            else:
                                run.answer += model_event["text"]
                        # `trace` events build the record that is
                        # stored below. `reasoning` and `status` say the
                        # same things for a client that only shows a
                        # waiting line, and are not kept.
                        if body.mode != "plan" or model_event["type"] not in {"delta", "trace", "reasoning", "reasoning_break"}:
                            yield model_event
                break
            except httpx.HTTPStatusError as exc:
                # A stored provider file can be gone: expired,
                # deleted, or minted by a provider this install no
                # longer uses. The PDF is still here, so upload it
                # again and ask once more, but only before anything
                # has reached the reader.
                file_ids = [pdf for _, pdf in sources if isinstance(pdf, str)]
                if (
                    repaired_files
                    or run.first_provider_event_ms is not None
                    or not provider_file_missing(exc.response, file_ids)
                ):
                    raise
                repaired_files = True
                named = [fid for fid in file_ids if fid in exc.response.text]
                yield {
                    "type": "progress",
                    "stage": "file_upload",
                    "message": "Refreshing document files",
                    "elapsedMs": run.elapsed_ms(),
                }
                sources = await ensure_openai_files(
                    client,
                    storage,
                    objects,
                    username,
                    project_id,
                    papers,
                    settings,
                    stale_file_ids=frozenset(named or file_ids),
                )
                payload = answer_payload()


def log_answer(
    name: str, run: AnswerRun, settings: Settings, outcome: str, failure_category: str
) -> None:
    """One line per answer: where its time went, what it spent, how it ended."""
    body = run.body
    budget = run.budget
    papers = run.papers
    used = budget.usage if budget else Usage()
    first = (budget.first_usage if budget else None) or Usage()
    duration_ms = run.elapsed_ms()
    first_provider_event_ms = run.first_provider_event_ms
    wait_ms = (
        round(
            (
                (run.started + (first_provider_event_ms or 0) / 1000)
                - run.model_wait_started
            )
            * 1000
        )
        if run.model_wait_started is not None and first_provider_event_ms is not None
        else None
    )
    logger.info(
        "%s request_id=%s mode=%s model=%s tier=%s "
        "paper_count=%s page_count=%s estimated_context_tokens=%s "
        "file_bytes=%s first_provider_event_ms=%s duration_ms=%s "
        "stage_durations_ms=context:%s,model_wait:%s,model_stream:%s "
        "initial_input_tokens=%s initial_cached_tokens=%s "
        "input_tokens=%s cached_tokens=%s cache_write_tokens=%s "
        "output_tokens=%s reasoning_tokens=%s rounds=%s hosted_calls=%s "
        "terminal=%s cancelled=%s outcome=%s failure_category=%s",
        name,
        run.request_id,
        body.scope,
        run.model,
        service_tier_for(settings, run.use_standard_tier),
        len(papers),
        sum(paper.get("pages", 0) for paper in papers),
        run.estimated_context_tokens,
        sum(paper.get("bytes", 0) for paper in papers if not is_web(paper)),
        first_provider_event_ms,
        duration_ms,
        run.context_ready_ms,
        wait_ms,
        (
            duration_ms - first_provider_event_ms
            if first_provider_event_ms is not None
            else None
        ),
        first.input_tokens,
        first.cached_tokens,
        # Summed across the turn's rounds, like everything after it.
        used.input_tokens,
        used.cached_tokens,
        used.cache_write_tokens,
        used.output_tokens,
        used.reasoning_tokens,
        budget.rounds_run if budget else 0,
        budget.hosted_calls_made if budget else 0,
        (
            "-" if run.turn is None
            else run.turn.terminal.value + (f":{run.turn.reason}" if run.turn.reason else "")
        ),
        outcome == "cancelled",
        outcome,
        failure_category,
    )


def chat_stream(
    body: ChatRequest,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    general = body.scope == "general"
    run = prepare_answer(body, username, storage, settings)
    ref = run.ref
    project_id = ref.project_id
    thread_key = ref.thread_key
    request_id = run.request_id
    model = run.model
    reasoning_effort = run.reasoning_effort
    persona = run.persona
    meta = run.meta
    if body.replace_request_id:
        storage.drop_from_last_user_turn(
            username, project_id, thread_key, body.replace_request_id
        )
        run.thread = storage.get_thread(username, project_id, thread_key)
    if body.referenced_image_ids:
        if len(body.referenced_image_ids) > settings.chat_image_max_per_question:
            raise HTTPException(400, "Too many images referenced in one question")
        run.image_records = storage.reference_chat_images(
            username,
            project_id,
            thread_key,
            body.referenced_image_ids,
            utc_now(),
            body.prompt,
        )
    user_message = {
        "role": "user",
        "content": body.prompt,
        "selectedText": body.selected_text,
        "referencedPapers": [
            {"id": paper["id"], "title": paper["title"]}
            for paper in meta.get("papers", [])
            if paper["id"] in set(body.referenced_paper_ids)
        ],
        "referencedImages": [
            {"id": image["id"], "number": image["number"]}
            for image in run.image_records
        ],
        "createdAt": utc_now(),
        "model": model,
        "reasoningEffort": reasoning_effort,
        "requestId": request_id,
    }
    if body.viewport is not None:
        user_message["viewportUrl"] = body.viewport.url
    from ..storage.conversations import require_selector
    _, history_generation = require_selector(thread_key)
    run.previous_messages = conversation_history(storage, username, ref, run.thread)
    title_claim = (
        storage.claim_conversation_title(
            username, project_id=project_id, thread_key=thread_key,
            engagement_id=body.engagement_id, fallback_title=body.prompt,
        )
        if body.engagement_id else None
    )
    append_turn(storage, username, ref, user_message)
    # Stamped from the request rather than from what the menu happened to show,
    # so what is stored is the persona that actually answered this turn.
    storage.set_conversation_persona(
        username,
        project_id=project_id,
        thread_key=thread_key,
        persona_id=str(persona["id"]),
    )
    current = storage.get_thread(username, project_id, thread_key)
    conversation_id = current.get("conversationId")
    heartbeat = AnswerHeartbeat(
        storage, username, conversation_id, current.get("generation", 0), request_id
    )

    async def generate() -> AsyncIterator[str]:
        heartbeat.start()
        run.start()
        record = run.record
        title_task: asyncio.Task[None] | None = None
        interrupted = False
        outcome = "failed"
        failure_category = "none"

        def event(payload: dict[str, Any]) -> str:
            return sse(
                {
                    **payload,
                    "requestId": request_id,
                    "conversationId": conversation_id,
                }
            )

        try:
            async with aclosing(
                run_answer(run, username, storage, objects, settings, lambda: heartbeat.live)
            ) as changes:
                async for change in changes:
                    yield event(change)
            if run.stopped:
                outcome = "cancelled"
                return
            answer = run.answer
            turn = run.turn
            # Appended, not written back as a whole thread: this lands up to
            # fifteen minutes after the user turn, and rewriting the thread would
            # silently drop anything a second tab added in between.
            if await run_in_threadpool(
                request_was_cancelled,
                storage,
                username,
                project_id,
                thread_key,
                request_id,
            ):
                outcome = "cancelled"
                return
            # A cut-off answer is stored as cut off: shown with what was
            # written, never filed into Memory, and never mistaken for a
            # finished one. A cut-off plan is not a plan at all.
            cut_off = turn is not None and turn.terminal is Terminal.INCOMPLETE
            if cut_off and body.mode == "plan":
                raise RuntimeError(
                    "The plan was cut off before it was complete, so nothing was saved."
                )
            saved_plan = None
            if body.mode == "plan":
                from ..plans import finish
                yield event({"type": "progress", "stage": "plan_save", "message": "Validating and saving your plan"})
                answer, saved_plan = await run_in_threadpool(finish, storage, objects, username, body, answer)
                run.answer = answer
                if saved_plan is None:
                    # Plan drafts must reach their parser intact. A clarification
                    # is ordinary assistant text, with no published artifacts.
                    delivery = Delivery(ArtifactSession(settings))
                    answer = "".join(delivery.push(answer) + delivery.finish(completed=True))
                    run.answer = answer
                yield event({"type": "delta", "text": answer})
            # Started here rather than beside the stream: the answer is what
            # names the subject, so a title written without it can only repeat
            # a generic question. It still overlaps the writes below and is
            # awaited before the request closes.
            if title_claim is not None:
                title_task = asyncio.create_task(generate_conversation_title(
                    title_claim, body.prompt, answer, username, storage,
                    settings, run.use_standard_tier,
                ))
            evidence_metadata = None
            viewport_evidence = run.viewport_evidence
            if viewport_evidence is not None and body.paper_id:
                evidence_id = viewport_evidence["sourceHash"] if body.viewport.source == "captured" else request_id
                await run_in_threadpool(
                    objects.put_text,
                    evidence_key(username, body.paper_id, evidence_id),
                    json.dumps(viewport_evidence, ensure_ascii=False),
                )
                evidence_metadata = {
                    "evidenceId": evidence_id,
                    "url": viewport_evidence["url"],
                    "title": viewport_evidence["title"],
                    "kind": viewport_evidence["kind"],
                    "sourceHash": viewport_evidence["sourceHash"],
                }
            assistant_message = {
                "role": "assistant",
                "content": answer.strip(),
                "createdAt": utc_now(),
                "model": model,
                "reasoningEffort": reasoning_effort,
                "requestId": request_id,
            }
            if cut_off:
                assistant_message["incomplete"] = {"reason": turn.reason or "unknown"}
            if turn is not None and turn.sources and body.mode != "plan":
                # The web pages the answer cites, kept with it: the links in
                # its text are matched to these by address, so a reload shows
                # the same citations the reader watched arrive.
                assistant_message["sources"] = turn.sources
            if saved_plan:
                assistant_message["plan"] = saved_plan
            if evidence_metadata is not None:
                assistant_message["viewportEvidence"] = evidence_metadata
            for change in record.finish():
                if body.mode != "plan":
                    yield event(change)
            trace = record.stored(utf16_length(answer) - utf16_length(answer.lstrip()))
            if body.mode == "plan":
                trace = [{**stretch, "offset": 0} for stretch in trace]
            if trace:
                # Stored on the message body, which is already polymorphic
                # JSONB, so no migration. `build_responses_input` projects
                # history down to role and content, so a trace never re-enters
                # a request and costs no tokens.
                assistant_message["trace"] = trace
            await run_in_threadpool(
                append_turn,
                storage,
                username,
                ref,
                assistant_message,
            )
            outcome = "completed"
            yield event(
                {
                    "type": "done",
                    "viewportEvidence": evidence_metadata,
                    "plan": saved_plan,
                    "incomplete": assistant_message.get("incomplete"),
                    "sources": assistant_message.get("sources"),
                    # Exactly what was stored, so the answer on screen and the
                    # one a reload shows are the same record.
                    "trace": trace or None,
                }
            )
        except (asyncio.CancelledError, GeneratorExit):
            # A disconnect during send closes this generator at its last yield;
            # no awaited provider operation is left to raise CancelledError.
            interrupted = True
            record.finish()
            with anyio.CancelScope(shield=True):
                was_completed = outcome == "completed"
                if not was_completed:
                    outcome = "cancelled"
                    failure_category = "cancelled"
                if not was_completed and not await run_in_threadpool(
                    request_was_cancelled,
                    storage,
                    username,
                    project_id,
                    thread_key,
                    request_id,
                ):
                    await run_in_threadpool(
                        append_turn,
                        storage,
                        username,
                        ref,
                        {
                            "role": "assistant",
                            "content": "Request cancelled.",
                            "cancelled": True,
                            "trace": [{**stretch, "offset": 0} for stretch in record.stored()],
                            "createdAt": utc_now(),
                            "model": model,
                            "reasoningEffort": reasoning_effort,
                            "requestId": request_id,
                        },
                    )
            raise
        except Exception as exc:
            failure_category = type(exc).__name__
            message = provider_error_message(exc) if general else provider_refusal(exc)
            answer = "" if body.mode == "plan" else run.answer
            record.finish()
            if await run_in_threadpool(
                request_was_cancelled,
                storage,
                username,
                project_id,
                thread_key,
                request_id,
            ):
                outcome = "cancelled"
                return
            await run_in_threadpool(
                append_turn,
                storage,
                username,
                ref,
                {
                    "role": "assistant",
                    "content": (
                        f"{answer.strip()}\n\nRequest failed: {message}".strip()
                    ),
                    "error": True,
                    "trace": [{**stretch, "offset": 0} for stretch in record.stored()] if body.mode == "plan" else record.stored(),
                    "createdAt": utc_now(),
                    "model": model,
                    "reasoningEffort": reasoning_effort,
                    "requestId": request_id,
                },
            )
            yield event({"type": "error", "message": message})
        finally:
            # A disconnected SSE request is inside a cancelled AnyIO scope.
            # Short durability cleanup must complete before returning its claim.
            with anyio.CancelScope(shield=True):
                record.finish()
                try:
                    if outcome == "cancelled" and record.stored():
                        await run_in_threadpool(storage.finish_cancelled_trace, username, conversation_id,
                            history_generation, request_id, record.stored())
                except Exception:
                    logger.exception("Could not persist cancelled answer trace")
                if body._plan:
                    from ..plans import release
                    await run_in_threadpool(release, storage, username, body._plan, objects)
                await heartbeat.stop()
                if title_task is not None:
                    if interrupted and not title_task.done():
                        title_task.cancel()
                    await asyncio.gather(title_task, return_exceptions=True)
                if title_claim is not None and (title_task is None or title_task.cancelled()):
                    # An unstarted/interrupted title must not spend this mount's claim.
                    await run_in_threadpool(
                        storage.release_conversation_title_claim, username, title_claim["id"],
                        engagement_id=body.engagement_id,
                    )
            log_answer("chat_request", run, settings, outcome, failure_category)

    return event_stream(generate())


def side_chat_stream(
    side: SideChatRequest,
    username: str,
    storage: Storage,
    objects: ObjectStore,
    settings: Settings,
):
    """
    Answer a side question, with the conversation as read-only context.

    The same preparation and the same answer as a main turn (`prepare_answer`,
    `run_answer`), and none of what `chat_stream` keeps: no turn, persona
    stamp, title, heartbeat, evidence, stored trace or cancellation record,
    and so no Memory session job, which rides on a stored turn. It takes no
    conversation lock either, so it runs beside a main answer and the main
    thread's "still answering" check never sees it.

    The one write it shares with every turn is the provider file cache
    (`ensure_openai_files`): a document's upload id in its project's meta,
    which whichever request first reads that PDF records. It is not
    conversation state.

    Stop is the client closing the stream. There is nothing to clean up.
    """
    body = side.chat_request()
    run = prepare_answer(body, username, storage, settings)
    run.previous_messages = conversation_history(storage, username, run.ref, run.thread)
    conversation_id = run.thread.get("conversationId")

    async def generate() -> AsyncIterator[str]:
        run.start()
        outcome = "failed"
        failure_category = "none"

        def event(payload: dict[str, Any]) -> str:
            return sse({**payload, "requestId": run.request_id, "conversationId": conversation_id})

        try:
            async with aclosing(
                run_answer(run, username, storage, objects, settings, lambda: True)
            ) as changes:
                async for change in changes:
                    yield event(change)
            turn = run.turn
            for change in run.record.finish():
                yield event(change)
            answer = run.answer
            trace = run.record.stored(utf16_length(answer) - utf16_length(answer.lstrip()))
            outcome = "completed"
            yield event(
                {
                    "type": "done",
                    "incomplete": (
                        {"reason": turn.reason or "unknown"}
                        if turn is not None and turn.terminal is Terminal.INCOMPLETE
                        else None
                    ),
                    "sources": (turn.sources or None) if turn is not None else None,
                    "trace": trace or None,
                }
            )
        except (asyncio.CancelledError, GeneratorExit):
            outcome = failure_category = "cancelled"
            raise
        except Exception as exc:
            failure_category = type(exc).__name__
            message = provider_error_message(exc) if body.scope == "general" else provider_refusal(exc)
            yield event({"type": "error", "message": message})
        finally:
            run.record.finish()
            log_answer("side_request", run, settings, outcome, failure_category)

    return event_stream(generate())


@router.get("/chat/conversations")
def list_chat_conversations(scope: ChatScope, project_id: str | None = None, paper_id: str | None = None,
                            username: str = Depends(get_current_user), storage: Storage = Depends(get_storage)):
    return storage.list_scope_conversations(username, scope, project_id, paper_id)


@router.post("/chat/conversations", status_code=201)
def create_chat_conversation(body: ConversationCreate, username: str = Depends(get_current_user),
                             storage: Storage = Depends(get_storage)):
    return storage.create_conversation(username, body.scope, body.project_id, body.paper_id, body.creation_key)


@router.patch("/chat/conversations/{conversation_id}")
def rename_chat_conversation(conversation_id: str, body: ConversationRename,
                             username: str = Depends(get_current_user), storage: Storage = Depends(get_storage)):
    title = " ".join(body.title.split())
    if not title:
        raise HTTPException(400, "A title cannot be empty")
    return storage.rename_conversation(username, conversation_id, title, body.generation)
