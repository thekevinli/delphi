"""First-run onboarding: where an account should land, and finishing it.

The Dashboard used to decide by whether the account had any projects, so a
reader who closed the window partway through onboarding came back to a
library whose documents had never finished filing, and one who closed it
before any project existed started again. What decides now is whether the
attempt produced a usable document: uploaded and, where Memory is on,
filed. See `Storage.settle_onboarding` for the rule and the lock it holds.
"""

from typing import Any

from fastapi import APIRouter, Depends

from ..config import Settings, get_settings
from ..deps import get_current_user, get_object_store, get_storage
from ..storage import ObjectStore, Storage, chat_image_prefix, project_prefix
from .projects import delete_openai_files

router = APIRouter(prefix="/api/onboarding", tags=["onboarding"])


def filing_required(settings: Settings) -> bool:
    """Filing counts only where it can happen: Memory on and a provider to
    run it. Otherwise uploaded is complete, or onboarding could never end."""
    return bool(settings.memory_enabled and settings.api_key)


@router.post("/resolve")
async def resolve_onboarding(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Called as the Dashboard opens: show onboarding, or the Dashboard.

    An interrupted attempt with no completed document is deleted here and
    onboarding starts over; one with a completed document is kept and marked
    complete, whether or not the reader reached the last screen.
    """
    settled = storage.settle_onboarding(username, require_filing=filing_required(settings))
    # Records are gone under the lock; bytes and provider files cannot cascade.
    for project_id in settled["projectIds"]:
        objects.delete_prefix(project_prefix(username, project_id))
        objects.delete_prefix(chat_image_prefix(username, project_id))
    await delete_openai_files(settled["removed"].openai_file_ids, settings)
    return {"onboarding": settled["outcome"] in ("fresh", "restart"), "outcome": settled["outcome"]}


@router.get("")
def onboarding_status(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """The running attempt's tally, which the last screen waits on."""
    required = filing_required(settings)
    return {**storage.onboarding_status(username, require_filing=required), "filingRequired": required}


@router.post("/finish")
def finish_onboarding(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """"Enter Delphi": complete the attempt once a document has completed.

    Refused (`complete: false`) while nothing has completed and filing is
    still under way, which is what the last screen waits out.
    """
    settled = storage.settle_onboarding(
        username, require_filing=filing_required(settings), finishing=True
    )
    return {"complete": settled["outcome"] == "complete"}
