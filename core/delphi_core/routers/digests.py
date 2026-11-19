from contextlib import aclosing
import logging
from collections.abc import AsyncIterator
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from ..config import Settings, get_settings
from ..provider_errors import provider_refusal
from ..model_tasks import service_tier_for
from ..deps import get_current_user, get_object_store, get_storage
from ..research_digest import (
    RESEARCH_DIGEST_VERSION,
    digest_asset_key,
    digest_metadata_is_current,
    generate_digest,
    load_digest,
)
from ..schemas import DigestRequest
from ..sse import event_stream, sse
from ..storage import ObjectStore, Storage

router = APIRouter(prefix="/api/projects", tags=["digests"])
logger = logging.getLogger("uvicorn.error")


@router.get("/{project_id}/papers/{paper_id}/digest")
def digest_detail(
    project_id: str,
    paper_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """Return the validated derived digest without exposing its object key."""
    paper = storage.get_paper(username, project_id, paper_id)
    metadata = paper.get("digest") or {}
    if metadata.get("status") != "ready":
        return {"paper": paper, "digest": None}
    if not digest_metadata_is_current(paper, settings):
        paper = {
            **paper,
            "digest": {
                "status": "missing",
                "version": RESEARCH_DIGEST_VERSION,
                "model": settings.digest_model,
            },
        }
        return {"paper": paper, "digest": None}
    return {
        "paper": paper,
        "digest": load_digest(objects, username, project_id, paper_id),
    }


@router.get("/{project_id}/papers/{paper_id}/digest/assets/{asset_id}")
def digest_asset(
    project_id: str,
    paper_id: str,
    asset_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
):
    """Serve only assets referenced by this owner's current digest envelope."""
    storage.get_paper(username, project_id, paper_id)
    digest = load_digest(objects, username, project_id, paper_id)
    asset = next(
        (item for item in digest.get("assets") or () if item.get("id") == asset_id),
        None,
    )
    if asset is None:
        raise HTTPException(404, "Digest asset not found")
    mime_type = asset.get("mimeType") or "image/webp"
    key = digest_asset_key(username, project_id, paper_id, asset_id, mime_type)
    return StreamingResponse(
        objects.open_range(key),
        media_type=mime_type,
        headers={
            "Cache-Control": "private, max-age=3600",
            "Content-Length": str(objects.size(key)),
        },
    )


@router.post("/{project_id}/papers/{paper_id}/digest/stream")
def digest_stream(
    project_id: str,
    paper_id: str,
    body: DigestRequest,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    # Resolve ownership before returning a 200 streaming response. A stranger and
    # a missing id remain the same storage-owned 404.
    paper = storage.get_paper(username, project_id, paper_id)
    account = storage.get_account(username) or {}
    use_standard_tier = bool(account.get("useStandardTier", True))
    request_id = uuid4().hex

    async def stream() -> AsyncIterator[str]:
        started = __import__("time").monotonic()
        outcome = "failed"
        usage: dict = {}
        first_provider_event_ms = None
        try:
            timeout = httpx.Timeout(settings.digest_timeout_seconds, connect=20)
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with aclosing(generate_digest(
                    client,
                    storage,
                    objects,
                    username,
                    project_id,
                    paper_id,
                    settings,
                    force=body.force,
                    use_standard_tier=use_standard_tier,
                )) as digest_events:
                    async for event in digest_events:
                        if event["type"] == "_digest_ready":
                            outcome = "reused" if event.get("reused") else "ready"
                            usage = event.get("usage") or {}
                            first_provider_event_ms = event.get("firstProviderEventMs")
                            yield sse(
                                {
                                    "type": "done",
                                    "requestId": request_id,
                                    "paper": event["paper"],
                                    "digest": event["digest"],
                                    "reused": event.get("reused", False),
                                }
                            )
                        else:
                            yield sse({**event, "requestId": request_id})
        except Exception as exc:
            yield sse(
                {
                    "type": "error",
                    "requestId": request_id,
                    "message": provider_refusal(exc),
                }
            )
        finally:
            logger.info(
                "digest_request request_id=%s model=%s tier=%s paper_count=1 "
                "page_count=%s file_bytes=%s first_provider_event_ms=%s "
                "duration_ms=%s input_tokens=%s cached_tokens=%s outcome=%s",
                request_id,
                settings.digest_model,
                service_tier_for(settings, use_standard_tier),
                paper.get("pages", 0),
                paper.get("bytes", 0) if paper.get("kind") != "web" else 0,
                first_provider_event_ms,
                round((__import__("time").monotonic() - started) * 1000),
                usage.get("input_tokens", 0),
                (usage.get("input_tokens_details") or {}).get("cached_tokens", 0),
                outcome,
            )

    return event_stream(stream())
