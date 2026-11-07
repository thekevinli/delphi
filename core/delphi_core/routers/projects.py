import hashlib
from html import escape
import json
import logging
import os
import tempfile
import threading
import time
import urllib.parse
from collections import OrderedDict
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

import anyio
import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import (
    HTMLResponse,
    PlainTextResponse,
    RedirectResponse,
    Response,
    StreamingResponse,
)
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Highlight
from pypdf.generic import ArrayObject, FloatObject, NameObject, TextStringObject

from ..web_revision import (
    MAX_PAGE_WIDTH,
    MIN_PAGE_WIDTH,
    freeze,
    page_fields,
    page_text,
    publish_saved_page,
    publish_snapshot,
    read_revision,
    walled,
)
from ..config import Settings, get_settings
from ..deps import get_current_user, get_object_store, get_storage
from ..schemas import (
    PageCreate,
    NavigationMint,
    NoteCreate,
    NoteUpdate,
    PaperDone,
    PaperMove,
    PaperOrderUpdate,
    PaperUpdate,
    PdfHighlight,
    HtmlHighlight,
    PlacementCache,
    ProjectCreate,
    ProjectUpdate,
    StagedUpload,
    TextHighlight,
)
from ..document_index import (
    sections_from_pdf_text,
    sections_from_web_document,
    strip_control_characters,
)
from ..dashboard import (
    PDF_THUMBNAIL_VERSION,
    WEB_THUMBNAIL_VERSION,
    make_pdf_thumbnail,
    make_web_thumbnail_safely,
    thumbnail_fields,
)
from ..browser_render import render_is_partial, render_width_of
from ..pdf_compress import compress_pdf
from ..memory_same_document import note_deleted
from ..research_digest import digest_asset_key
from ..sse import run_durable_write
from ..storage.conversations import selector
from fastapi.concurrency import run_in_threadpool

from ..harness.evidence import reap as reap_external_evidence
from ..storage import (
    ObjectStore,
    Storage,
    UnsatisfiableRange,
    chat_image_prefix,
    evidence_key,
    evidence_prefix,
    is_web,
    paper_key,
    parse_range,
    project_prefix,
    rehome_chat_image_key,
    safe_id,
    utc_now,
)
from ..web_extract import PROSE_MIN_CHARS, flat_markdown
from ..web_fetch import (
    IMAGE_TYPES,
    PDF_TYPES,
    FetchedResource,
    boots_in_frame,
    extract_with_render_fallback,
    framed_page,
    fetch_resource,
    normalise_url,
    check_public_host,
)
from ..security import (
    make_navigation_token,
    make_page_token,
    make_staged_upload_token,
    read_page_token,
    read_navigation_token,
    read_session,
    read_staged_upload_token,
)
from ..web_proxy import (
    FRAME_ALLOW,
    frame_headers,
    is_frame_request,
    render_frame,
    render_image_frame,
    render_pdf_interstitial,
    sandbox_flags,
)
from ..viewport import normalize_viewport_image

router = APIRouter(prefix="/api/projects", tags=["projects"])
logger = logging.getLogger(__name__)

UPLOAD_CHUNK = 1024 * 1024


@contextmanager
def _discard_deleted_project_import(storage: Storage, objects: ObjectStore, username: str, project_id: str):
    """A slow import may finish after onboarding removed its project.

    Check after the producer stops, including cancellation and staged uploads,
    so its late writes cannot resurrect bytes under a deleted project.
    """
    try:
        yield
    finally:
        try:
            storage.get_project(username, project_id)
        except HTTPException as error:
            if error.status_code != 404:
                raise
            objects.delete_prefix(project_prefix(username, project_id))


async def finish_pdf_import(
    response: Response,
    project_id: str,
    filename: str,
    temp_path: Path,
    uploaded: int,
    username: str,
    storage: Storage,
    objects: ObjectStore,
    settings: Settings,
    *,
    title: str | None = None,
) -> dict[str, Any]:
    """
    Turn one complete scratch PDF into the two objects and its record.

    File uploads and PDF URLs deliberately meet here after transport. Everything
    that makes a PDF a Delphi paper — page validation, extraction, compression,
    staged confirmation, and bytes-before-record ordering — must therefore stay
    identical whichever entrance it used.
    """
    limit = settings.max_upload_mb * 1024 * 1024
    paper_id = uuid4().hex[:12]

    pages, page_text, metadata_title = await anyio.to_thread.run_sync(
        read_pdf_pages, temp_path, settings.max_pages_per_paper
    )
    extracted = join_pages(page_text)
    source_hash = hashlib.sha256(extracted.encode("utf-8")).hexdigest()

    size = uploaded
    if size > settings.compress_over_mb * 1024 * 1024:
        await anyio.to_thread.run_sync(
            compress_pdf,
            temp_path,
            settings.compress_jpeg_quality,
            settings.compress_max_image_side,
            (pages, page_text),
        )
        size = temp_path.stat().st_size

    if size > limit:
        raise HTTPException(
            413,
            f"That PDF is {uploaded / 1024 / 1024:.1f} MB and compresses to "
            f"{size / 1024 / 1024:.1f} MB, still over the "
            f"{settings.max_upload_mb} MB limit",
        )

    with _discard_deleted_project_import(storage, objects, username, project_id):
        pdf_key = paper_key(username, project_id, paper_id, "pdf")
        objects.put_file(pdf_key, temp_path, "application/pdf")
        objects.put_text(paper_key(username, project_id, paper_id, "txt"), extracted)

        paper_title = (title or metadata_title or Path(filename).stem)[:200]
        paper = {
            "id": paper_id,
            "title": paper_title,
            "filename": filename,
            "pages": pages,
            "tokens": max(1, len(extracted) // 4),
            "bytes": size,
            "sourceHash": source_hash,
            "createdAt": utc_now(),
        }

        # A thumbnail is derived, but generation still happens before the record is
        # visible so the dashboard never observes metadata ahead of its bytes.
        generated = False
        try:
            generated = await run_durable_write(
                make_pdf_thumbnail, temp_path, objects, username, project_id, paper_id
            )
        except Exception:
            logger.exception("PDF thumbnail generation failed for %s", paper_id)
        paper.update(
            thumbnail_fields(paper, generated=generated, version=PDF_THUMBNAIL_VERSION)
        )

        if uploaded > limit:
            response.status_code = 202
            return {
                "status": "compressed",
                "title": paper["title"],
                "uploadedBytes": uploaded,
                "bytes": size,
                "token": make_staged_upload_token(
                    username,
                    project_id,
                    paper,
                    settings.session_secret,
                    settings.staged_upload_seconds,
                ),
            }

        # Index after the record, never before it: an index row for a paper that no
        # record names would surface a hit the reader cannot open.
        stored = storage.add_paper(username, project_id, paper)
        index_paper_sections_safely(storage, objects, username, project_id, stored)
        return stored


def index_paper_sections(
    storage: Storage,
    objects: ObjectStore,
    username: str,
    project_id: str,
    paper: dict[str, Any],
) -> int:
    """
    Refresh the search index for one document from the objects already stored.

    Reads the durable form rather than taking the text from the caller, so an
    upload, a re-snapshot and a rebuild all produce the same rows from the same
    bytes. There is no second path that could index something the reader can't
    actually be shown.
    """
    paper_id = paper["id"]
    if is_web(paper):
        document = json.loads(
            objects.get_text(paper_key(username, project_id, paper_id, "web"))
        )
        sections = sections_from_web_document(document)
    else:
        sections = sections_from_pdf_text(
            objects.get_text(paper_key(username, project_id, paper_id, "txt"))
        )
    return storage.index_document_sections(username, project_id, paper_id, sections)


def index_paper_sections_safely(
    storage: Storage,
    objects: ObjectStore,
    username: str,
    project_id: str,
    paper: dict[str, Any],
) -> None:
    """
    Index, but never at the cost of the write that just succeeded.

    The index is derived and rebuildable, so the worst a failure here can do is
    make one document unfindable until the next rebuild. Raising instead would
    answer a completed upload with a 500 and leave the reader believing their
    paper was rejected when it is sitting in the project.
    """
    try:
        index_paper_sections(storage, objects, username, project_id, paper)
    except Exception:
        logger.warning(
            "could not index sections for paper %s in project %s",
            paper.get("id"),
            project_id,
            exc_info=True,
        )


async def delete_openai_files(file_ids: list[str], settings: Settings) -> None:
    # Without a Files API the stored ids were minted by a provider this
    # deployment is not talking to, and this one cannot delete them.
    if not settings.api_key or not file_ids or not settings.openai_files_enabled:
        return
    headers = {"Authorization": f"Bearer {settings.api_key}"}
    async with httpx.AsyncClient(timeout=10) as client:
        for file_id in file_ids:
            try:
                await client.delete(
                    f"{settings.api_base_url.rstrip('/')}/files/{file_id}",
                    headers=headers,
                )
            except httpx.HTTPError:
                # Local deletion remains authoritative. Remote cleanup is best effort.
                pass


@router.post("/{project_id}/papers/{paper_id}/annotation-placements", status_code=204)
def save_annotation_placements(project_id: str, paper_id: str, body: PlacementCache,
                               username: str = Depends(get_current_user), storage: Storage = Depends(get_storage)):
    storage.save_highlight_placements(username, project_id, paper_id, body.revision, [item.model_dump() for item in body.placements])


@router.get("/{project_id}/papers/{paper_id}/annotation-revision")
def annotation_revision(project_id: str, paper_id: str, username: str = Depends(get_current_user),
                        storage: Storage = Depends(get_storage), objects: ObjectStore = Depends(get_object_store)):
    storage.get_paper(username, project_id, paper_id)
    saved = read_revision(objects, username, project_id, paper_id)
    # The page copy as the reader's menu needs it: whether there is one, and
    # when it was kept. A copy imported before copies carried a date of their
    # own is as old as the fetch that made it.
    return {"savedAt": saved.get("savedPageAt") or saved.get("fetchedAt"),
            "available": bool(saved.get("savedDom"))}


@router.get("/annotation-worker.js")
def annotation_worker():
    source = "\n".join((Path(__file__).parent.parent / name).read_text(encoding="utf-8")
                       for name in ("web_annotations.js", "web_annotation_worker.js"))
    return Response(source, media_type="application/javascript", headers={"Cache-Control": "no-cache"})


@router.get("")
def list_projects(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    return storage.list_projects(username)


@router.post("", status_code=201)
def create_project(
    body: ProjectCreate,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    return storage.create_project(username, body.name, onboarding=body.onboarding)


@router.get("/{project_id}")
def get_project(
    project_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    return storage.get_project(username, project_id)


@router.patch("/{project_id}")
def rename_project(
    project_id: str,
    body: ProjectUpdate,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    return storage.rename_project(username, project_id, body.name.strip())


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    project_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    papers = [paper["id"] for paper in storage.get_project(username, project_id).get("papers") or ()]
    removed = storage.delete_project(username, project_id)
    note_deleted(storage, username, papers, settings)
    # Records can cascade; bytes and provider-held files cannot.
    objects.delete_prefix(project_prefix(username, project_id))
    objects.delete_prefix(chat_image_prefix(username, project_id))
    await delete_openai_files(removed.openai_file_ids, settings)
    # Outside sources only this project's digests cited go with it.
    await run_in_threadpool(reap_external_evidence, storage, objects, username, settings)


@router.post("/{project_id}/papers", status_code=201)
async def upload_paper(
    response: Response,
    project_id: str,
    file: UploadFile = File(...),
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """
    Store a PDF, compressing it first if that is what it takes to fit.

    A paper over the limit is not refused on sight: most of a heavy paper is
    figures held far above screen resolution, and re-encoding them routinely
    halves the file without touching a glyph. So it is compressed, and if that
    brings it under the limit the reader is asked whether the smaller paper is
    the one they wanted -- answered by `confirm_staged_paper` below. Until they
    answer, the bytes exist and the record does not.
    """
    if file.content_type not in {"application/pdf", "application/x-pdf"} and not (
        file.filename or ""
    ).lower().endswith(".pdf"):
        raise HTTPException(415, "Only PDF files are supported")
    if storage.count_active_papers(username, project_id) >= settings.max_papers_per_project:
        raise HTTPException(409, f"Projects currently support {settings.max_papers_per_project} papers")
    if len(storage.get_project(username, project_id)["papers"]) >= settings.max_papers_total_per_project:
        raise HTTPException(
            409,
            f"This project is holding its maximum of {settings.max_papers_total_per_project} documents",
        )

    limit = settings.max_upload_mb * 1024 * 1024
    # Land the upload on local scratch first: pypdf needs a seekable file, and a
    # PDF that turns out to be unreadable or over the page limit should never
    # reach durable storage.
    handle, temp_name = tempfile.mkstemp(suffix=".pdf")
    os.close(handle)
    temp_path = Path(temp_name)
    try:
        size = 0
        ceiling = max(settings.max_upload_source_mb * 1024 * 1024, limit)
        with temp_path.open("wb") as stream:
            while chunk := await file.read(UPLOAD_CHUNK):
                size += len(chunk)
                # Above the ceiling there is no point reading further: even a
                # halving would not get this under the limit.
                if size > ceiling:
                    raise HTTPException(
                        413,
                        f"PDF exceeds {settings.max_upload_source_mb} MB, which is "
                        f"more than compression can bring under {settings.max_upload_mb} MB",
                    )
                stream.write(chunk)

        return await finish_pdf_import(
            response,
            project_id,
            file.filename or "Untitled paper.pdf",
            temp_path,
            size,
            username,
            storage,
            objects,
            settings,
            # Preserve the upload contract: a local filename is the initial
            # title even when the PDF happens to carry different metadata.
            title=Path(file.filename or "Untitled paper").stem,
        )
    finally:
        temp_path.unlink(missing_ok=True)


@router.post("/{project_id}/papers/staged", status_code=201)
def confirm_staged_paper(
    project_id: str,
    body: StagedUpload,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """Accept a compressed paper whose bytes are already stored."""
    paper = read_staged_upload_token(
        body.token, username, project_id, settings.session_secret
    )
    # A token stays valid until it expires, so the bytes are what says whether
    # this upload is still live: a second tab, or a replayed request, must not
    # be able to add a record for a paper that was already turned down.
    if paper is not None and not objects.exists(
        paper_key(username, project_id, paper["id"], "pdf")
    ):
        paper = None
    if paper is None:
        raise HTTPException(
            410, "That upload is no longer waiting to be added. Upload it again."
        )
    # Re-checked rather than trusted from upload time: the project may have
    # filled up while the reader was deciding.
    if storage.count_active_papers(username, project_id) >= settings.max_papers_per_project:
        raise HTTPException(
            409, f"Projects currently support {settings.max_papers_per_project} papers"
        )
    if len(storage.get_project(username, project_id)["papers"]) >= settings.max_papers_total_per_project:
        raise HTTPException(
            409,
            f"This project is holding its maximum of {settings.max_papers_total_per_project} documents",
        )
    stored = storage.add_paper(username, project_id, paper)
    index_paper_sections_safely(storage, objects, username, project_id, stored)
    return stored


@router.delete("/{project_id}/papers/staged", status_code=204)
def discard_staged_paper(
    project_id: str,
    token: str,
    username: str = Depends(get_current_user),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """
    Drop a compressed paper the reader turned down.

    Bytes with no record are invisible to everyone, which is exactly why they
    have to be removed here rather than left: nothing else would ever look at
    them again. A reader who closes the tab instead of answering leaves a pair
    of objects behind; the token expiring is what makes them unreachable, not
    what removes them.
    """
    paper = read_staged_upload_token(
        token, username, project_id, settings.session_secret
    )
    if paper is None:
        # Already gone, or never ours. Either way there is nothing to delete.
        return
    objects.delete(paper_key(username, project_id, paper["id"], "pdf"))
    objects.delete(paper_key(username, project_id, paper["id"], "txt"))
    objects.delete(paper_key(username, project_id, paper["id"], "thumb"))


def read_pdf_pages(path: Path, max_pages: int) -> tuple[int, list[str], str]:
    """Page count and per-page text, in the form the compressor verifies against."""
    try:
        reader = PdfReader(str(path))
        pages = len(reader.pages)
        if pages > max_pages:
            raise HTTPException(
                413, f"This PDF has {pages} pages; the limit is {max_pages}"
            )
        page_text = [page.extract_text() or "" for page in reader.pages]
        metadata_title = (
            strip_control_characters(str(reader.metadata.title or "")).strip()
            if reader.metadata else ""
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, f"Could not read this PDF: {exc}") from exc
    return pages, page_text, metadata_title


def join_pages(page_text: list[str]) -> str:
    """The stored `.txt`: page markers are what lets an answer cite a page."""
    return "".join(
        f"\n\n--- Page {index} ---\n\n{text}"
        for index, text in enumerate(page_text, start=1)
    ).strip()


def ensure_paper(meta: dict, paper_id: str) -> dict:
    paper = next((item for item in meta.get("papers", []) if item["id"] == paper_id), None)
    if not paper:
        raise HTTPException(404, "Paper not found")
    return paper


def is_web_pdf(paper: dict[str, Any]) -> bool:
    """A remote PDF keeps web ownership but has a PDF-shaped source filename."""
    return is_web(paper) and str(paper.get("filename") or "").lower().endswith(".pdf")


def remote_pdf_filename(url: str) -> str:
    """A stable display filename even when a PDF route has no `.pdf` suffix."""
    parsed = urllib.parse.urlparse(url)
    name = Path(urllib.parse.unquote(parsed.path)).name or parsed.netloc or "document"
    return name if name.lower().endswith(".pdf") else f"{name}.pdf"


def extract_pdf_snapshot(
    resource: FetchedResource, max_pages: int, max_chars: int
) -> dict[str, Any]:
    """
    Give a linked PDF the same outline-and-sections shape as an HTML snapshot.

    Pages become addressable `page-N` sections. The original bytes remain at
    their source URL and are re-fetched for Delphi's PDF.js reader; this snapshot
    is what chat reads when the document keeps web-source semantics.
    """
    try:
        reader = PdfReader(BytesIO(resource.body))
        page_count = len(reader.pages)
        if page_count > max_pages:
            raise HTTPException(
                413, f"This PDF has {page_count} pages; the limit is {max_pages}"
            )
        metadata_title = (
            strip_control_characters(str(reader.metadata.title or "")).strip()
            if reader.metadata else ""
        )
        budget = max_chars
        truncated = False
        sections: list[dict[str, Any]] = []
        for index, page in enumerate(reader.pages, start=1):
            raw = (page.extract_text() or "").strip() if budget > 0 else ""
            if len(raw) > budget:
                truncated = True
            markdown = raw[:budget]
            budget = max(0, budget - len(markdown))
            if budget == 0 and index < page_count:
                truncated = True
            sections.append(
                {
                    "anchor": f"page-{index}",
                    "title": f"Page {index}",
                    "level": 1,
                    "markdown": markdown,
                    "words": len(markdown.split()),
                }
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, f"Could not read this PDF: {exc}") from exc

    parsed = urllib.parse.urlparse(resource.url)
    filename = remote_pdf_filename(resource.url)
    return {
        "title": metadata_title or Path(filename).stem,
        "byline": "",
        "published": "",
        "favicon": urllib.parse.urlunparse(
            (parsed.scheme, parsed.netloc, "/favicon.ico", "", "", "")
        ),
        "url": resource.url,
        "contentType": "application/pdf",
        "sections": sections,
        "wordCount": sum(section["words"] for section in sections),
        "truncated": truncated,
    }


async def snapshot_page(
    url: str,
    objects: ObjectStore,
    settings: Settings,
    username: str,
    project_id: str,
    paper_id: str,
    *,
    allow_pdf: bool = False,
    storage: Storage | None = None,
    with_page_copy: bool = False,
    follow_frame: bool = False,
    whole: bool = True,
) -> dict[str, Any]:
    """
    Fetch a page and store what a model will read of it.

    Two objects, mirroring what a PDF stores: the structured snapshot that
    `read_webpage` serves sections out of, and the flat text under the same
    `.txt` key every paper already uses, so the text route and the token
    estimate need no special case. `with_page_copy` is the import's: the page
    as fetched is the copy a document starts with, until the reader annotates.

    `follow_frame` is the import's too. A page that is only a frame around a
    document is filed as that document, exactly as a redirect is filed under
    where it leads: the returned `url` is the frame's, and it is what the reader
    opens from then on. A refresh re-reads the address a document already has.

    `whole=False` is the add's too: a windowed page is read at its first window
    and the result says `_partial`, for its capture job to finish
    (`routers.captures`), whose whole page replaces only that first window
    (`publish_snapshot`).
    """
    previous = await anyio.to_thread.run_sync(read_revision, objects, username, project_id, paper_id)
    resource = await fetch_resource(
        url, settings, include_pdf=allow_pdf, allow_render=True
    )
    if resource.content_type in PDF_TYPES:
        document = await anyio.to_thread.run_sync(
            extract_pdf_snapshot,
            resource,
            settings.max_pages_per_paper,
            settings.web_max_extract_chars,
        )
    else:
        document = await extract_with_render_fallback(
            resource, settings.web_max_extract_chars, whole=whole
        )
        # After the page's own reading, never instead of it: a page that has an
        # article is filed as it always was, whatever it embeds.
        framed = await framed_page(resource, document, settings) if follow_frame else None
        # A frame showing a wall is not a document to trade the page for.
        if framed and not walled(flat_markdown(framed[1])):
            resource, document = framed
    if not document["sections"]:
        raise HTTPException(
            422,
            # No longer "pages that build themselves are not supported": one
            # was built in a browser before this line was reached, so the
            # honest remaining causes are a page that is genuinely empty and a
            # wall standing where the article should be.
            "Delphi could not find readable text on that page, even after "
            "loading it in a browser.",
        )
    if resource.content_type not in PDF_TYPES and walled(flat_markdown(document)):
        raise HTTPException(422, "That address is showing a login, subscription, or error page. Any saved copy was kept.")
    document["fetchedAt"] = resource.fetched_at
    markdown = flat_markdown(document)
    rendered = document.pop("_rendered", None)
    partial = bool(rendered) and render_is_partial(rendered)
    page = None
    if with_page_copy and resource.content_type not in PDF_TYPES:
        # A page that needed a browser is kept as that browser built it, at the
        # width it was built at; any other is kept as served, and reflows.
        source = rendered or resource.body.decode(resource.encoding or "utf-8", errors="replace")
        width = (render_width_of(rendered, 0) or None) if rendered else None
        frozen = await anyio.to_thread.run_sync(freeze, source, document["url"], width)
        page = page_fields(frozen, document["url"], resource.fetched_at, partial=partial)
    await anyio.to_thread.run_sync(
        lambda: publish_snapshot(objects, username, project_id, paper_id, document, previous, storage, page=page)
    )
    document["_markdown"] = markdown
    document["_partial"] = partial
    return document


def snapshot_fields(document: dict[str, Any], markdown: str) -> dict[str, Any]:
    """What a paper record says of the text `snapshot_page` stored."""
    return {
        # Sections, not pages. Both answer "how many addressable pieces".
        "pages": len(document["sections"]),
        "tokens": max(1, len(markdown) // 4),
        "bytes": len(markdown.encode("utf-8")),
        # Unchanged text keeps its hash, so the digest built from it stays
        # current: only a page whose words moved regenerates one.
        "sourceHash": hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
    }


async def import_pdf_url(
    response: Response,
    url: str,
    project_id: str,
    username: str,
    storage: Storage,
    objects: ObjectStore,
    settings: Settings,
) -> dict[str, Any]:
    """Import a remote PDF through the exact same finishing path as an upload."""
    resource = await fetch_resource(url, settings, include_pdf=True)
    if resource.content_type not in PDF_TYPES:
        raise HTTPException(409, "That address no longer points to a PDF")

    filename = remote_pdf_filename(resource.url)
    handle, temp_name = tempfile.mkstemp(suffix=".pdf")
    os.close(handle)
    temp_path = Path(temp_name)
    try:
        await anyio.to_thread.run_sync(temp_path.write_bytes, resource.body)
        return await finish_pdf_import(
            response,
            project_id,
            filename,
            temp_path,
            len(resource.body),
            username,
            storage,
            objects,
            settings,
        )
    finally:
        temp_path.unlink(missing_ok=True)


@router.post("/{project_id}/pages", status_code=201)
async def add_page(
    response: Response,
    project_id: str,
    body: PageCreate,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    if not settings.web_documents_enabled:
        raise HTTPException(403, "Web documents are turned off on this server")
    if storage.count_active_papers(username, project_id) >= settings.max_papers_per_project:
        raise HTTPException(
            409, f"Projects currently support {settings.max_papers_per_project} papers"
        )
    if len(storage.get_project(username, project_id)["papers"]) >= settings.max_papers_total_per_project:
        raise HTTPException(
            409,
            f"This project is holding its maximum of {settings.max_papers_total_per_project} documents",
        )

    if body.pdf_mode == "upload":
        return await import_pdf_url(
            response,
            body.url,
            project_id,
            username,
            storage,
            objects,
            settings,
        )

    paper_id = uuid4().hex[:12]
    with _discard_deleted_project_import(storage, objects, username, project_id):
        document = await snapshot_page(
            body.url,
            objects,
            settings,
            username,
            project_id,
            paper_id,
            allow_pdf=body.pdf_mode == "web",
            with_page_copy=True,
            follow_frame=True,
            # The reader is waiting: a windowed page opens at its first window,
            # and its capture job reads the rest (`routers.captures`).
            whole=False,
        )
        markdown = document.pop("_markdown")
        partial = document.pop("_partial")
        # The reader is waiting on this request, so the capture gets the inline
        # ceiling rather than the full one. Failing here is cheap now: opening the
        # document is a new engagement and retries immediately.
        thumbnail_available = await make_web_thumbnail_safely(
            document["title"], document["url"], document.get("favicon"), objects,
            settings, username, project_id, paper_id,
            settings.web_thumbnail_inline_seconds,
        )
        parsed = urllib.parse.urlparse(document["url"])
        linked_pdf = document.get("contentType") in PDF_TYPES

        # Record last, as with an upload: an orphaned snapshot is reapable, a record
        # pointing at a snapshot that was never written is a broken document.
        stored = storage.add_paper(
            username,
            project_id,
            {
                "id": paper_id,
                "kind": "web",
                "title": document["title"][:200],
                "filename": (
                    remote_pdf_filename(document["url"])
                    if linked_pdf
                    else f"{parsed.netloc}{parsed.path}".rstrip("/") or parsed.netloc
                ),
                "url": document["url"],
                "favicon": document.get("favicon"),
                **snapshot_fields(document, markdown),
                **thumbnail_fields(
                    {}, generated=thumbnail_available, version=WEB_THUMBNAIL_VERSION
                ),
                # What is stored is the page's first window; `add_paper` queues
                # the capture that reads the rest, and the filing waits for it.
                **({"capture": "partial"} if partial else {}),
                "createdAt": utc_now(),
            },
        )
        index_paper_sections_safely(storage, objects, username, project_id, stored)
        return stored


@router.get("/{project_id}/papers/{paper_id}/evidence/{evidence_id}")
def get_viewport_evidence(
    project_id: str,
    paper_id: str,
    evidence_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
):
    """The exact page the assistant was shown, so a citation can reopen it."""
    storage.get_paper(username, project_id, paper_id)
    return json.loads(
        objects.get_text(evidence_key(username, paper_id, safe_id(evidence_id)))
    )

@router.post("/{project_id}/papers/{paper_id}/refresh")
async def refresh_page(
    project_id: str,
    paper_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """Re-fetch the text the model reads of a page, from the page as it is now.

    The reader never asks for this: their first annotation on a live page in a
    visit sends it, beside the page copy (`save_page_copy`). It writes the text
    and nothing else — never the page copy, never the thumbnail — so a site that
    refuses a second fetch costs the reader nothing they marked up.
    """
    meta = storage.get_project(username, project_id)
    paper = ensure_paper(meta, paper_id)
    if not is_web(paper):
        raise HTTPException(409, "Only web documents can be refreshed")

    document = await snapshot_page(
        paper["url"],
        objects,
        settings,
        username,
        project_id,
        paper_id,
        allow_pdf=is_web_pdf(paper),
        storage=storage,
    )
    refreshed = storage.update_paper_snapshot(
        username, project_id, paper_id, snapshot_fields(document, document.pop("_markdown"))
    )
    # A re-snapshot can drop a section, so this replaces the whole index rather
    # than adding to it — otherwise a heading the page no longer has stays
    # findable, and citing it opens nothing.
    index_paper_sections_safely(storage, objects, username, project_id, refreshed)
    return refreshed


def origin_of(url: str) -> str:
    parts = urllib.parse.urlsplit(url.strip())
    return f"{parts.scheme}://{parts.netloc}".lower()


async def _read_bounded(request: Request, limit: int) -> bytes:
    """A request body, refused the moment it passes `limit` rather than once it has all arrived."""
    refusal = HTTPException(413, f"This page is larger than the {limit // (1024 * 1024)} MB a saved copy may be")
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise refusal
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > limit:
            raise refusal
    return bytes(body)


@router.put("/{project_id}/papers/{paper_id}/saved-page")
async def save_page_copy(
    request: Request,
    project_id: str,
    paper_id: str,
    width: int = Query(ge=MIN_PAGE_WIDTH, le=MAX_PAGE_WIDTH),
    url: str = Query(max_length=2048),
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """Keep the page as the reader annotated it: the copy the cached view shows.

    Sent by the reader's tab after an annotation on the live page, carrying the
    page its frame serialised as `text/html`, the width it was laid out at and
    the address it was read at. That frame runs someone else's document, so the
    body is untrusted markup: bounded as it arrives, made inert by `freeze`,
    and refused if it is unreadable, a wall, or no longer holds the fetched
    text. Only the account's own session may send it — never a page token,
    which is all the sandboxed frame is ever given.

    The text the model reads, and the digest built from it, are not touched. A
    copy identical to the stored one writes nothing and photographs nothing.
    """
    paper = storage.get_paper(username, project_id, paper_id)
    if not is_web(paper) or is_web_pdf(paper):
        raise HTTPException(409, "Only a web page keeps a page copy")
    address = urllib.parse.urlsplit(url)
    if address.scheme not in ("http", "https") or not address.hostname:
        raise HTTPException(422, "A page copy names the web address it was read at")
    # It is framed at this address in the cached view, so it may not be one of
    # Delphi's own: a frame whose base was removed reports its own URL, which
    # is the sandbox route and carries the page token.
    own = {origin_of(origin) for origin in (*settings.origins, settings.web_sandbox_origin, str(request.base_url)) if origin}
    if origin_of(url) in own:
        raise HTTPException(422, "A page copy names the site it was read at, not Delphi")
    body = await _read_bounded(request, settings.web_saved_page_max_bytes)
    try:
        html = body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(422, "A page copy must be UTF-8") from exc
    frozen = await anyio.to_thread.run_sync(freeze, html, url, width)
    text = await anyio.to_thread.run_sync(page_text, frozen)
    if len(text) < PROSE_MIN_CHARS:
        raise HTTPException(409, "The page had no readable text, so the saved copy was kept.")
    if walled(text):
        raise HTTPException(409, "The page is showing a login, subscription, or error page, so the saved copy was kept.")
    stored = await anyio.to_thread.run_sync(
        publish_saved_page, objects, username, project_id, paper_id, frozen, text, url, storage
    )
    if stored["changed"]:
        # Photographed from the copy just stored, never from a fetch.
        made = await make_web_thumbnail_safely(
            paper["title"], url, paper.get("favicon"), objects, settings,
            username, project_id, paper_id, settings.web_thumbnail_inline_seconds,
        )
        storage.update_paper_snapshot(
            username, project_id, paper_id,
            thumbnail_fields(paper, generated=made, version=WEB_THUMBNAIL_VERSION),
        )
    return {"changed": stored["changed"], "savedAt": stored["savedAt"]}


@router.get("/{project_id}/papers/{paper_id}/page-url")
def paper_page_url(
    project_id: str,
    paper_id: str,
    view: Literal["live", "cached"] | None = None,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """
    Where to point the reader's frame, and the proof it may go there.

    Minted here, on the origin that holds the session cookie, because the
    sandbox origin deliberately never sees one.
    """
    meta = storage.get_project(username, project_id)
    paper = ensure_paper(meta, paper_id)
    if not is_web(paper):
        raise HTTPException(409, "That document is a PDF")

    path = f"/api/projects/{project_id}/papers/{paper_id}/page"
    mode = "pdf" if is_web_pdf(paper) else "page"
    view = view or "live"
    # A stored DOM is only correct at the width it was built at. The frame
    # needs that number so it can show the layout at 1512px and scale the
    # iframe to the panel, rather than pouring a baked column into 800px
    # and clipping the headline.
    # A live page reports its own width through the bridge once it is built.
    render_width = None
    if view == "cached":
        render_width = render_width_of(
            read_revision(objects, username, project_id, paper_id).get("savedDom") or "", 0
        ) or None
    if not settings.web_sandbox_origin:
        return {
            "url": f"{path}?view={view}",
            "view": view,
            "sandbox": sandbox_flags(""),
            "allow": FRAME_ALLOW,
            "mode": mode,
            "renderWidth": render_width,
        }

    token = make_page_token(
        username,
        project_id,
        paper_id,
        settings.session_secret,
        settings.web_page_token_seconds,
    )
    return {
        "url": f"{settings.web_sandbox_origin.rstrip('/')}{path}?view={view}&t={token}",
        "view": view,
        "sandbox": sandbox_flags(settings.web_sandbox_origin),
        "allow": FRAME_ALLOW,
        "mode": mode,
        "renderWidth": render_width,
    }


@router.post("/{project_id}/papers/{paper_id}/navigation")
def mint_page_navigation(
    project_id: str,
    paper_id: str,
    body: NavigationMint,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """Authorize one exact user-clicked destination without putting it in a URL."""
    if not settings.web_browsing_enabled:
        raise HTTPException(403, "In-app browsing is turned off on this server")
    paper = storage.get_paper(username, project_id, paper_id)
    if not is_web(paper) or is_web_pdf(paper):
        raise HTTPException(409, "In-app browsing starts from a web page")
    destination = normalise_url(body.url)
    check_public_host(destination)
    sandboxed = bool(settings.web_sandbox_origin)
    token = make_navigation_token(
        username,
        project_id,
        paper_id,
        destination,
        sandboxed,
        settings.session_secret,
        settings.web_page_token_seconds,
    )
    path = f"/api/projects/{project_id}/papers/{paper_id}/navigate"
    action = (
        f"{settings.web_sandbox_origin.rstrip('/')}{path}"
        if sandboxed
        else path
    )
    return {
        "action": action,
        "url": destination,
        "token": token,
        "sandbox": sandbox_flags(settings.web_sandbox_origin),
        "allow": FRAME_ALLOW,
    }


@router.post("/{project_id}/papers/{paper_id}/navigate", response_class=HTMLResponse)
async def navigate_page(
    request: Request,
    project_id: str,
    paper_id: str,
    url: str = Form(...),
    token: str = Form(...),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """Frame-only POST proxy for a destination authorized by the parent app."""
    started = time.monotonic()
    if not settings.web_browsing_enabled:
        raise HTTPException(403, "In-app browsing is turned off on this server")
    if not is_frame_request(request.headers):
        raise HTTPException(403, "This navigation is available only in the reader")
    destination = normalise_url(url)
    sandboxed = bool(settings.web_sandbox_origin)
    username = read_navigation_token(
        token,
        project_id,
        paper_id,
        destination,
        sandboxed,
        settings.session_secret,
    )
    if not username:
        raise HTTPException(401, "Navigation authorization is invalid or expired")
    if sandboxed and request.cookies.get("delphi_session"):
        logger.error(
            "Refusing frame navigation because the sandbox origin received a session cookie"
        )
        raise HTTPException(500, "Web documents are misconfigured on this server")
    paper = storage.get_paper(username, project_id, paper_id)
    if not is_web(paper):
        raise HTTPException(409, "That document is a PDF")
    check_public_host(destination)
    host = urllib.parse.urlparse(destination).hostname or "unknown"
    try:
        resource = await fetch_resource(
            destination, settings, include_pdf=True, include_images=True
        )
    except Exception as exc:
        logger.info(
            "page_navigation host=%s stage=fetch failure=%s duration_ms=%s",
            host,
            type(exc).__name__,
            round((time.monotonic() - started) * 1000),
        )
        raise
    headers = frame_headers(settings.origins)
    logger.info(
        "page_navigation host=%s stage=fetched kind=%s duration_ms=%s",
        host,
        resource.content_type,
        round((time.monotonic() - started) * 1000),
    )
    if resource.content_type in PDF_TYPES:
        return HTMLResponse(
            render_pdf_interstitial(resource.url), headers=headers
        )
    if resource.content_type in IMAGE_TYPES:
        image, _, _ = await anyio.to_thread.run_sync(
            normalize_viewport_image, resource.body, settings
        )
        return HTMLResponse(
            render_image_frame(image, resource.url, Path(urllib.parse.urlparse(resource.url).path).name or "Image"),
            headers=headers,
        )
    html = await anyio.to_thread.run_sync(render_frame, resource.body.decode(resource.encoding, errors="replace"), resource.url)
    return HTMLResponse(content=html, headers=headers)


@router.get("/{project_id}/papers/{paper_id}/page", response_class=HTMLResponse)
async def paper_page(
    request: Request,
    project_id: str,
    paper_id: str,
    t: str | None = None,
    view: Literal["live", "cached"] | None = None,
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """
    The reader panel's browser: one live page, framed and scriptable.

    It serves exactly one address — the one stored on the document — and takes
    no URL from the caller. The frame blocks link navigation, so there is
    nowhere else to go, and the route cannot be turned into an open proxy
    serving arbitrary HTML from a path under Delphi's own domain.

    Identity comes from a scoped token when one is presented, because on the
    sandbox origin there is no cookie to read; the cookie still works when no
    sandbox origin is configured.
    """
    session_cookie = request.cookies.get("delphi_session")
    username = read_page_token(t, project_id, paper_id, settings.session_secret)
    if username and session_cookie:
        # A token means this arrived on the sandbox origin, and a cookie means
        # that origin receives credentials — so the separation the whole design
        # rests on has collapsed and this page would be granted a real origin
        # next to a live session. Checks the property rather than the config, so
        # it catches the case a config check cannot: the cookie later gaining a
        # `Domain=` attribute and spreading across subdomains.
        logger.error(
            "Refusing to serve a proxied page: the sandbox origin received a "
            "session cookie, so WEB_SANDBOX_ORIGIN is not actually separate "
            "from the app. Serving here would expose the reader's account."
        )
        raise HTTPException(500, "Web documents are misconfigured on this server")
    if not username:
        username = read_session(session_cookie, settings.session_secret)
    if not username:
        raise HTTPException(401, "Not authenticated")

    meta = storage.get_project(username, project_id)
    paper = ensure_paper(meta, paper_id)
    if not is_web(paper):
        raise HTTPException(409, "That document is a PDF")

    target = paper["url"]
    view = view or "live"

    if is_web_pdf(paper):
        # Linked PDFs are fetched through the same pinned, SSRF-checked route as
        # before, but PDF.js now reads the response instead of asking Chrome's
        # opaque MIME-handler iframe to paint it. Unlike proxied HTML, PDF bytes
        # are safe as a top-level fetch and need no frame-only gate.
        resource = await fetch_resource(target, settings, include_pdf=True)
        if resource.content_type not in PDF_TYPES:
            raise HTTPException(409, "That address no longer points to a PDF")
        headers = frame_headers(settings.origins)
        headers["Content-Disposition"] = (
            f'inline; filename="{filename_slug(remote_pdf_filename(resource.url))}"'
        )
        return Response(
            content=resource.body,
            media_type="application/pdf",
            headers=headers,
        )

    if not is_frame_request(request.headers):
        # Opened as a tab rather than framed. Serving proxied HTML here would
        # run someone else's script on Delphi's origin, beside the session
        # cookie; send the reader to the real site instead, which is what they
        # wanted from a bare URL anyway.
        return RedirectResponse(target, status_code=303)

    # Live fetches the site afresh and is never stored: opening, reloading and
    # switching views must not publish over the saved copy; an annotation does.
    # Cached serves that copy — the page as imported, or as the reader last
    # annotated it — with no network. Either failure is still *framed*: a
    # JSON error in the iframe never says hello, so the parent took it for a
    # page escaping the reader and retried it into a misleading error.
    if view == "live":
        # Let the reader's browser run the original document. A server-side
        # render followed by script removal is a snapshot, even when fetched
        # moments ago: its controls have no handlers and animation delays open.
        try:
            resource = await fetch_resource(target, settings, allow_render=True, live_source=True)
            markup = resource.body.decode(resource.encoding, errors="replace")
        except Exception as exc:
            if not isinstance(exc, HTTPException):
                logger.exception("live view of %s failed", target)
            detail = exc.detail if isinstance(exc, HTTPException) and isinstance(exc.detail, str) else ""
            return await _unavailable_frame("live", detail, target, settings, 503)
        # A page only its own scripts can draw cannot be built in the reader's
        # frame (a public Notion page framed blank). Rather than frame a blank shell, or freeze a render,
        # the live view declines and the reader falls back to the saved copy.
        # Answered 200: the site is fine; the frame is the reason it cannot run.
        if not await anyio.to_thread.run_sync(boots_in_frame, markup, resource.url, settings.web_max_extract_chars):
            return await _unavailable_frame(
                "live", "This site draws the page with scripts that only run on its own address.",
                target, settings, 200, reason="own-address",
            )
        html = await anyio.to_thread.run_sync(render_frame, markup, resource.url)
        return HTMLResponse(content=html, headers=frame_headers(settings.origins))

    saved = await anyio.to_thread.run_sync(read_revision, objects, username, project_id, paper_id)
    if not saved.get("savedDom"):
        return await _unavailable_frame("cached", "", target, settings, 404)
    html = await anyio.to_thread.run_sync(framed_saved_copy, saved, target)
    return HTMLResponse(content=html, headers=frame_headers(settings.origins))


#: Saved copies as framed, by the copy and its address. Framing is a parse of
#: the whole copy, 1.75s on a 4 MB Notion page and paid on every open of it,
#: for an answer that only a new copy changes. Held in this process and never
#: stored: what framing adds (the bridge, `render_frame`'s rewrites) is this
#: build's code, which `bridge_source` already reads once per process, so an
#: update can never be served a frame an earlier build made.
_FRAMED: "OrderedDict[tuple[str, str], str]" = OrderedDict()
_FRAMED_LOCK = threading.Lock()
_FRAMED_KEPT = 4


def framed_saved_copy(saved: dict[str, Any], target: str) -> str:
    """A document's saved copy, framed at the address it was read at.

    That address is `savedPageUrl`, which a redirect may have moved since
    import, so its relative assets resolve where they did.
    """
    stored = saved["savedDom"]
    base_url = saved.get("savedPageUrl") or target
    key = (saved.get("savedPageHash") or hashlib.sha256(stored.encode("utf-8")).hexdigest(), base_url)
    with _FRAMED_LOCK:
        if key in _FRAMED:
            _FRAMED.move_to_end(key)
            return _FRAMED[key]
    html = render_frame(stored, base_url)
    with _FRAMED_LOCK:
        _FRAMED[key] = html
        while len(_FRAMED) > _FRAMED_KEPT:
            _FRAMED.popitem(last=False)
    return html


async def _unavailable_frame(
    view: Literal["live", "cached"], detail: str, target: str, settings: Settings, status: int,
    *, reason: Literal["", "own-address"] = "",
) -> HTMLResponse:
    """
    A view that could not be served, as a document the reader can talk to.

    The bridge reports `data-delphi-unavailable` in its ready message, so the
    reader falls back from live to cached, and from a missing copy to its own
    error; a client that predates the flag still shows this text rather than
    retrying. `reason` "own-address" is a site the frame cannot run, not a
    failure, and the reader says so over the saved copy.
    """
    message = (
        "The live page could not be loaded. Your cached copy is unchanged."
        if view == "live" else "No cached copy of this page is saved."
    )
    body = f"<p>{escape(message)}</p>" + (f"<p>{escape(detail)}</p>" if detail else "")
    because = f' data-delphi-unavailable-reason="{reason}"' if reason else ""
    markup = f'<!doctype html><html data-delphi-unavailable="{view}"{because}><head></head><body>{body}</body></html>'
    html = await anyio.to_thread.run_sync(render_frame, markup, target)
    return HTMLResponse(content=html, status_code=status, headers=frame_headers(settings.origins))


@router.put("/{project_id}/papers/order")
def reorder_papers(
    project_id: str,
    body: PaperOrderUpdate,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    meta = storage.get_project(username, project_id)
    current_ids = [paper["id"] for paper in meta.get("papers", [])]
    if len(set(body.paper_ids)) != len(body.paper_ids):
        raise HTTPException(422, "Paper order contains duplicate IDs")
    if set(body.paper_ids) != set(current_ids) or len(body.paper_ids) != len(current_ids):
        raise HTTPException(422, "Paper order must include every project paper exactly once")
    return storage.reorder_papers(username, project_id, body.paper_ids)


# Reader highlights are stored against the page as the browser painted it, so
# they carry /Rotate into account already. Undo that rotation to land in PDF
# user space, whose origin is the bottom-left of the unrotated page.
HIGHLIGHT_COLORS = {"amber": "f6a06b"}


def _display_to_page(
    x: float, y: float, rotation: int, width: float, height: float
) -> tuple[float, float]:
    if rotation == 90:
        return width - y, x
    if rotation == 180:
        return width - x, height - y
    if rotation == 270:
        return y, height - x
    return x, y


def build_annotated_pdf(
    source: Path, highlights: list[dict[str, Any]], notes: list[dict[str, Any]]
) -> bytes:
    writer = PdfWriter(clone_from=source)
    # A highlight's comment is the reader's note when it has one, else the passage.
    remarks = {note.get("highlightId"): note.get("body") for note in notes if note.get("body")}
    pages: dict[int, list[dict[str, Any]]] = {}
    for item in highlights:
        if item.get("type") != "pdf" or not item.get("rects"):
            continue
        page = int(item.get("page") or 0)
        if 1 <= page <= len(writer.pages):
            pages.setdefault(page, []).append(item)

    for page_number, items in pages.items():
        page = writer.pages[page_number - 1]
        box = page.mediabox
        left, bottom = float(box.left), float(box.bottom)
        width, height = float(box.width), float(box.height)
        rotation = int(page.get("/Rotate") or 0) % 360
        # What the reader actually saw, after rotation was applied.
        shown_w, shown_h = (
            (height, width) if rotation in (90, 270) else (width, height)
        )

        for item in items:
            color = HIGHLIGHT_COLORS.get(
                str(item.get("color")), HIGHLIGHT_COLORS["amber"]
            )
            for rect in item["rects"]:
                x0, x1 = rect["x"] * shown_w, (rect["x"] + rect["w"]) * shown_w
                # Stored y runs downward from the top edge; flip it.
                y0 = shown_h - (rect["y"] + rect["h"]) * shown_h
                y1 = shown_h - rect["y"] * shown_h
                corners = [
                    _display_to_page(cx, cy, rotation, width, height)
                    for cx in (x0, x1)
                    for cy in (y0, y1)
                ]
                px = [left + c[0] for c in corners]
                py = [bottom + c[1] for c in corners]
                rx0, rx1 = min(px), max(px)
                ry0, ry1 = min(py), max(py)
                annotation = Highlight(
                    rect=(rx0, ry0, rx1, ry1),
                    # Quad order is upper-left, upper-right, lower-left, lower-right.
                    quad_points=ArrayObject(
                        [
                            FloatObject(value)
                            for value in (rx0, ry1, rx1, ry1, rx0, ry0, rx1, ry0)
                        ]
                    ),
                    highlight_color=color,
                    printing=True,
                )
                remark = remarks.get(item.get("id"))
                if remark or item.get("text"):
                    annotation[NameObject("/Contents")] = TextStringObject(
                        str(remark)[:4000] if remark else str(item["text"])[:400]
                    )
                writer.add_annotation(page_number=page_number - 1, annotation=annotation)

    buffer = BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def filename_slug(value: str) -> str:
    """
    Squeeze a display name into something safe to put in a Content-Disposition
    header: spaces become underscores and anything outside a plain ASCII
    filename alphabet is dropped, so no quoting or RFC 5987 escaping is needed.
    """
    slug = "".join(
        "_" if character.isspace() else character
        for character in value
        if character.isspace()
        or (character.isascii() and (character.isalnum() or character in "._-"))
    )
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug.strip("._-")


def export_filename(project_name: str, title: str, annotated: bool) -> str:
    """
    The stored PDF is named after its upload — often an arXiv id or a hash that
    means nothing on disk. Downloads are named for what the reader sees instead,
    so the paper's Delphi title is what lands in their downloads folder.
    """
    parts = ["delphi_export"]
    parts.extend(part for part in (filename_slug(project_name), filename_slug(title)) if part)
    if annotated:
        parts.append("annotated")
    return "_".join(parts) + ".pdf"


def content_disposition(kind: str, filename: str) -> str:
    """
    Name a download safely. The ASCII form is the fallback for old clients; the
    RFC 5987 form carries the real name, which in practice contains spaces and
    parentheses.
    """
    ascii_name = filename_slug(filename) or "paper.pdf"
    encoded = urllib.parse.quote(filename, safe="")
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded}"


@router.get("/{project_id}/papers/{paper_id}/file")
def paper_file(
    request: Request,
    project_id: str,
    paper_id: str,
    annotated: bool = False,
    download: bool = False,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
):
    meta = storage.get_project(username, project_id)
    paper = ensure_paper(meta, paper_id)
    key = paper_key(username, project_id, paper_id, "pdf")

    if annotated:
        highlights = storage.list_highlights(username, project_id, paper_id)
        if any(item.get("type") == "pdf" for item in highlights):
            name = export_filename(meta.get("name", ""), paper["title"], True)
            # pypdf clones from a path, so this is one of two places that needs
            # the object as a real file.
            source = objects.fetch_to_tempfile(key)
            try:
                content = build_annotated_pdf(
                    source, highlights, storage.list_notes(username, project_id, paper_id)
                )
            finally:
                source.unlink(missing_ok=True)
            return Response(
                content=content,
                media_type="application/pdf",
                headers={"Content-Disposition": f'attachment; filename="{name}"'},
            )

    # The viewer streams from this same route and needs the PDF inline; only an
    # explicit download asks the browser to save it under the export name.
    disposition = (
        content_disposition(
            "attachment", export_filename(meta.get("name", ""), paper["title"], False)
        )
        if download
        else content_disposition("inline", paper["filename"])
    )

    size = objects.size(key)
    try:
        byte_range = parse_range(request.headers.get("range"), size)
    except UnsatisfiableRange:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": disposition,
        # The bytes behind a paper id never change, so let the browser keep them
        # rather than re-fetching a 30 MB file on every reopen.
        "Cache-Control": "private, max-age=31536000, immutable",
    }
    if byte_range is None:
        headers["Content-Length"] = str(size)
        return StreamingResponse(
            objects.open_range(key),
            media_type="application/pdf",
            headers=headers,
        )

    headers["Content-Length"] = str(byte_range.length)
    headers["Content-Range"] = byte_range.content_range(size)
    return StreamingResponse(
        objects.open_range(key, byte_range.start, byte_range.end),
        status_code=206,
        media_type="application/pdf",
        headers=headers,
    )


@router.get("/{project_id}/anchors")
def list_section_anchors(
    project_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    """
    Which web document owns each `§anchor` in this project.

    A model cites a web section as a bare `§slug`, and in a project chat that
    slug alone must say which document to open. Records only — the derived
    section index — so a citation click never waits on an object read.
    """
    return {"papers": storage.list_section_anchors(username, project_id)}


@router.get("/{project_id}/papers/{paper_id}/text", response_class=PlainTextResponse)
def paper_text(
    project_id: str,
    paper_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
):
    paper = storage.get_paper(username, project_id, paper_id)
    if is_web(paper):
        return flat_markdown(read_revision(objects, username, project_id, paper_id))
    return objects.get_text(paper_key(username, project_id, paper_id, "txt"))


@router.patch("/{project_id}/papers/{paper_id}")
def rename_paper(
    project_id: str,
    paper_id: str,
    body: PaperUpdate,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    paper = storage.rename_paper(username, project_id, paper_id, body.title.strip())
    if settings.memory_enabled:
        # Deferred: the `memory` module is the heavy one, and a rename is rare.
        from ..memory import sync_source_page_title

        sync_source_page_title(
            storage, username, paper_id=paper_id, title=paper["title"],
            max_pages=settings.memory_max_pages,
        )
    return paper


@router.post("/{project_id}/papers/{paper_id}/done")
def set_paper_done(
    project_id: str,
    paper_id: str,
    body: PaperDone,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """Toggle a paper out of (or back into) the project's working set."""
    if not body.done:
        # Re-checked rather than trusted from the toggle's initial state: the
        # project may have filled up with active papers while this one sat
        # archived.
        if storage.count_active_papers(username, project_id) >= settings.max_papers_per_project:
            raise HTTPException(
                409, f"Projects currently support {settings.max_papers_per_project} papers"
            )
    return storage.set_paper_done(username, project_id, paper_id, body.done)


#: Every extension a paper's bytes are ever written under. A paper has two of
#: `pdf`, `txt` and `web`, never all three, so both the move and the delete work
#: through the whole set and let the absent ones answer "nothing here".
PAPER_OBJECT_EXTENSIONS = ("pdf", "txt", "web", "digest", "thumb")


def _digest_asset_ids(
    objects: ObjectStore, username: str, project_id: str, paper_id: str
) -> list[tuple[str, str]]:
    """Read the published envelope before a move/delete names new object keys."""
    try:
        envelope = json.loads(
            objects.get_text(paper_key(username, project_id, paper_id, "digest"))
        )
    except (HTTPException, FileNotFoundError, json.JSONDecodeError, TypeError, ValueError):
        return []
    digest = envelope.get("digest") or {}
    return [
        (str(asset["id"]), str(asset.get("mimeType") or "image/webp"))
        for asset in digest.get("assets") or ()
        if isinstance(asset, dict) and asset.get("id")
    ]


@router.post("/{project_id}/papers/{paper_id}/move")
def move_paper(
    project_id: str,
    paper_id: str,
    body: PaperMove,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """
    File a paper into a different project, with its digest and its chat.

    An object key names the project a paper sits in, so the bytes move too, and
    they move first: the whole set is copied to the destination before the record
    is re-parented, and the source copies are dropped only once it has landed.
    Crash anywhere in that and the worst outcome is an unreferenced object —
    never a paper whose record points at bytes that are not there.
    """
    destination_id = body.project_id
    if destination_id == project_id:
        raise HTTPException(409, "That paper is already in this project")
    # Both reads 404 for a project that is not this account's, so a stranger's
    # id is answered exactly as a deleted one is.
    storage.get_paper(username, project_id, paper_id)
    digest_assets = _digest_asset_ids(
        objects, username, project_id, paper_id
    )
    if storage.count_active_papers(username, destination_id) >= settings.max_papers_per_project:
        raise HTTPException(
            409, f"Projects currently support {settings.max_papers_per_project} papers"
        )
    if len(storage.get_project(username, destination_id)["papers"]) >= settings.max_papers_total_per_project:
        raise HTTPException(
            409,
            f"This project is holding its maximum of {settings.max_papers_total_per_project} documents",
        )

    moved_keys: list[tuple[str, str]] = [
        (
            paper_key(username, project_id, paper_id, ext),
            paper_key(username, destination_id, paper_id, ext),
        )
        for ext in PAPER_OBJECT_EXTENSIONS
    ]
    moved_keys += [
        (
            digest_asset_key(
                username, project_id, paper_id, asset_id, mime_type
            ),
            digest_asset_key(
                username, destination_id, paper_id, asset_id, mime_type
            ),
        )
        for asset_id, mime_type in digest_assets
    ]
    # Images pasted into any of the paper's conversations are addressed through
    # the project too, so each conversation arrives with its attachments rather
    # than with holes. `move_paper` rewrites the records to these same keys.
    for conversation in storage.list_scope_conversations(
        username, "document", project_id, paper_id
    )["items"]:
        for image in storage.list_chat_images(
            username, project_id, selector(conversation["id"], conversation["generation"]), utc_now()
        ):
            moved_keys += [
                (key, rehome_chat_image_key(key, username, project_id, destination_id))
                for key in (image["imageKey"], image["thumbnailKey"])
            ]
    # Viewport evidence is keyed by account + paper + assistant request. Filing
    # the paper elsewhere therefore cannot interrupt old citation jumps and
    # requires no object copy; the paper's chat record moves independently.
    for source_key, destination_key in moved_keys:
        objects.copy(source_key, destination_key)

    project = storage.move_paper(
        username, project_id, paper_id, destination_id, body.position
    )
    for source_key, _ in moved_keys:
        objects.delete(source_key)
    return project


@router.delete("/{project_id}/papers/{paper_id}", status_code=204)
async def delete_paper(
    project_id: str,
    paper_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    digest_assets = _digest_asset_ids(objects, username, project_id, paper_id)
    removed = storage.delete_paper(username, project_id, paper_id)
    note_deleted(storage, username, [paper_id], settings)
    # Deleting a key that was never written is free and cheaper than branching
    # on the kind.
    for ext in PAPER_OBJECT_EXTENSIONS:
        objects.delete(paper_key(username, project_id, paper_id, ext))
    for asset_id, mime_type in digest_assets:
        objects.delete(
            digest_asset_key(
                username, project_id, paper_id, asset_id, mime_type
            )
        )
    objects.delete_prefix(evidence_prefix(username, paper_id))
    await delete_openai_files(removed.openai_file_ids, settings)
    # An outside source only this document's digest cited goes with it.
    await run_in_threadpool(reap_external_evidence, storage, objects, username, settings)


@router.get("/{project_id}/papers/{paper_id}/highlights")
def list_highlights(
    project_id: str,
    paper_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    return storage.list_highlights(username, project_id, paper_id)


@router.post("/{project_id}/papers/{paper_id}/highlights", status_code=201)
def add_highlight(
    project_id: str,
    paper_id: str,
    body: PdfHighlight | TextHighlight | HtmlHighlight,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    paper = storage.get_paper(username, project_id, paper_id)
    html_document = is_web(paper) and not is_web_pdf(paper)
    if (body.type == "html" and not html_document) or (body.type == "pdf" and html_document):
        raise HTTPException(422, "Highlight coordinates do not match the document type")
    return storage.add_highlight(
        username, project_id, paper_id, body.model_dump()
    )


@router.delete("/{project_id}/papers/{paper_id}/highlights/{highlight_id}", status_code=204)
def delete_highlight(
    project_id: str,
    paper_id: str,
    highlight_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    storage.delete_highlight(username, project_id, paper_id, highlight_id)


@router.post("/{project_id}/papers/{paper_id}/store")
async def store_linked_pdf(
    project_id: str,
    paper_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """
    Turn a linked PDF into one Delphi holds, keeping the same paper.

    A linked PDF is re-fetched from its source on every open, so an annotation
    against it is one broken link away from being unreadable — which is why
    writing a note on one offers this first. Everything after the fetch is the
    upload path's own machinery, so the page limit, the compression rescue and
    the byte-size refusal all behave identically to a file the reader dragged in.

    The paper id does not change. That is the whole point: its highlights,
    notes, digest and thread stay attached, where a re-import would have made a
    second document and orphaned all four.
    """
    paper = storage.get_paper(username, project_id, paper_id)
    if not is_web_pdf(paper):
        raise HTTPException(
            409, "Only a linked PDF can be stored; this document already is one"
        )
    url = paper.get("url")
    if not url:
        raise HTTPException(409, "That document has no source address to fetch")

    # Free, and answered before anything is downloaded: `add_page` already wrote
    # one section per PDF page, so the page count is on the record.
    pages_known = int(paper.get("pages") or 0)
    if pages_known > settings.max_pages_per_paper:
        raise HTTPException(
            413,
            f"This PDF has {pages_known} pages; the limit is "
            f"{settings.max_pages_per_paper}",
        )

    resource = await fetch_resource(url, settings, include_pdf=True)
    if resource.content_type not in PDF_TYPES:
        raise HTTPException(409, "That address no longer points to a PDF")

    handle, temp_name = tempfile.mkstemp(suffix=".pdf")
    os.close(handle)
    temp_path = Path(temp_name)
    try:
        uploaded = len(resource.body)
        await anyio.to_thread.run_sync(temp_path.write_bytes, resource.body)
        pages, page_text, _ = await anyio.to_thread.run_sync(
            read_pdf_pages, temp_path, settings.max_pages_per_paper
        )
        extracted = join_pages(page_text)

        size = uploaded
        if size > settings.compress_over_mb * 1024 * 1024:
            await anyio.to_thread.run_sync(
                compress_pdf,
                temp_path,
                settings.compress_jpeg_quality,
                settings.compress_max_image_side,
                (pages, page_text),
            )
            size = temp_path.stat().st_size

        limit = settings.max_upload_mb * 1024 * 1024
        if size > limit:
            # Refused outright rather than staged: staging exists so a reader can
            # agree to compression before a paper is added, and this one is
            # already in the library. Nothing is written, so the linked document
            # is exactly as it was.
            raise HTTPException(
                413,
                f"That PDF is {uploaded / 1024 / 1024:.1f} MB and compresses to "
                f"{size / 1024 / 1024:.1f} MB, still over the "
                f"{settings.max_upload_mb} MB limit",
            )

        # Bytes first, record second, stale object last (invariant 7). A crash
        # between the first two leaves an unreferenced object; the reverse would
        # leave a PDF record pointing at bytes that were never written.
        objects.put_file(paper_key(username, project_id, paper_id, "pdf"), temp_path, "application/pdf")
        objects.put_text(paper_key(username, project_id, paper_id, "txt"), extracted)
        thumbnail_available = False
        try:
            thumbnail_available = await anyio.to_thread.run_sync(
                make_pdf_thumbnail, temp_path, objects, username, project_id, paper_id
            )
        except Exception:
            logger.exception("PDF thumbnail generation failed for %s", paper_id)
        stored = storage.store_linked_pdf(
            username,
            project_id,
            paper_id,
            {
                "filename": remote_pdf_filename(resource.url),
                "pages": pages,
                "tokens": max(1, len(extracted) // 4),
                "bytes": size,
                "sourceHash": hashlib.sha256(extracted.encode("utf-8")).hexdigest(),
                # Promotion changes which renderer owns the preview — the web
                # capture that may already be on the card was taken by a
                # different one — so this is version PDF, attempt one.
                **thumbnail_fields(
                    {}, generated=thumbnail_available, version=PDF_THUMBNAIL_VERSION
                ),
            },
        )
        objects.delete(paper_key(username, project_id, paper_id, "web"))
    finally:
        temp_path.unlink(missing_ok=True)

    # The index branches on `is_web`, so the rows have to be rebuilt in the PDF
    # shape or a search hit would still name a section that no longer exists.
    index_paper_sections_safely(storage, objects, username, project_id, stored)
    return stored


@router.get("/{project_id}/papers/{paper_id}/notes")
def list_notes(
    project_id: str,
    paper_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    return storage.list_notes(username, project_id, paper_id)


@router.post("/{project_id}/papers/{paper_id}/notes", status_code=201)
def add_note(
    project_id: str,
    paper_id: str,
    body: NoteCreate,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    storage.get_paper(username, project_id, paper_id)  # 404 unless it is theirs
    highlight = next((item for item in storage.list_highlights(username, project_id, paper_id)
                      if item["id"] == body.highlight_id), None)
    if highlight is None:
        raise HTTPException(404, "That highlight no longer exists")
    if highlight["type"] == "html":
        if body.page is not None or body.anchor_y is not None:
            raise HTTPException(422, "Web notes do not have PDF coordinates")
    elif highlight["type"] != "pdf" or body.page != highlight.get("page") or body.anchor_y is None:
        raise HTTPException(422, "Note coordinates must belong to its highlight")
    return storage.add_note(
        username, project_id, paper_id, body.model_dump(by_alias=True)
    )


@router.patch("/{project_id}/papers/{paper_id}/notes/{note_id}")
def update_note(
    project_id: str,
    paper_id: str,
    note_id: str,
    body: NoteUpdate,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    return storage.update_note(username, project_id, paper_id, note_id, body.body)


@router.delete("/{project_id}/papers/{paper_id}/notes/{note_id}", status_code=204)
def delete_note(
    project_id: str,
    paper_id: str,
    note_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    storage.delete_note(username, project_id, paper_id, note_id)
