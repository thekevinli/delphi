"""Authenticated, bounded Dashboard reads and reader engagement touches."""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from ..config import Settings, get_settings
from ..dashboard import (
    capture_document_thumbnail_for_engagement,
    conversations_payload,
    dashboard_payload,
)
from ..deps import get_current_user, get_object_store, get_storage
from ..storage import ObjectStore, Storage, paper_key

router = APIRouter(prefix="/api", tags=["dashboard"])


@router.get("/dashboard")
def dashboard(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    return dashboard_payload(storage, username)


@router.get("/conversations")
def conversations(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    """Every non-empty conversation, newest first.

    Beside `/dashboard` rather than with the chat routes because it is the same
    read: thread records joined to the project and document names a client draws
    them with. The chat router owns one thread at a time; this owns the list.
    """
    return conversations_payload(storage, username)


@router.post("/projects/{project_id}/papers/{paper_id}/engagement", status_code=204)
async def engage_document(
    project_id: str,
    paper_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    paper = storage.touch_paper(username, project_id, paper_id)
    await capture_document_thumbnail_for_engagement(
        storage, objects, settings, username, project_id, paper,
    )


@router.get("/projects/{project_id}/papers/{paper_id}/thumbnail")
def document_thumbnail(
    project_id: str,
    paper_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
):
    paper = storage.get_paper(username, project_id, paper_id)
    key = paper_key(username, project_id, paper_id, "thumb")
    if not paper.get("thumbnailAvailable") or not objects.exists(key):
        raise HTTPException(404, "Thumbnail unavailable")
    return StreamingResponse(
        objects.open_range(key), media_type="image/webp",
        # Bytes can change without `thumbnailVersion` moving (a recapture of
        # the same renderer). A day-long cache keyed only on version kept
        # serving the fallback card after a successful retry.
        headers={"Cache-Control": "private, max-age=0, must-revalidate"},
    )
