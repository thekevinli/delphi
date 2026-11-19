"""Reading back a captured outside source: what a page said on the day it was read."""

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.concurrency import run_in_threadpool

from ..deps import get_current_user, get_object_store, get_storage
from ..harness.evidence import load_sections
from ..storage import ObjectStore, Storage

router = APIRouter(prefix="/api/evidence", tags=["evidence"])


@router.get("/{evidence_id}")
async def read_evidence(
    evidence_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
) -> dict[str, Any]:
    """
    One capture: where it came from, the passages cited from it, and its text.

    Account-scoped like everything a reader's library holds: another account's
    capture is the same 404 as one that does not exist. The object key is the
    store's business and is not returned.
    """
    record = await run_in_threadpool(storage.get_external_evidence, username, evidence_id)
    sections = await run_in_threadpool(load_sections, objects, record)
    return {
        **{key: value for key, value in record.items() if key != "objectKey"},
        "sections": [
            {"anchor": section["anchor"], "title": section.get("title") or "", "level": section.get("level") or 1,
             "markdown": section.get("markdown") or ""}
            for section in sections
        ],
    }
