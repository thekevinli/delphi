"""GET /api/export — the account as one zip, built by `delphi_core.account_export`."""

import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from ..account_export import write_export
from ..config import Settings, get_settings
from ..deps import get_current_user, get_object_store, get_storage
from ..storage import ObjectStore, Storage

router = APIRouter(prefix="/api", tags=["export"])


@router.get("/export")
def export_account(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    objects: ObjectStore = Depends(get_object_store),
    settings: Settings = Depends(get_settings),
):
    """
    Everything the reader made, as a folder with an index page.

    A plain `def`, so the build runs on the thread pool, and into a temporary
    file, as a plan's export does: a library's PDFs must never become one
    allocation in a worker. The file goes once the response has been sent.
    """
    temporary = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    path = Path(temporary.name)
    temporary.close()
    try:
        filename = write_export(storage, objects, settings, username, str(path))
        return FileResponse(path, media_type="application/zip", filename=filename,
                            headers={"Cache-Control": "no-store"},
                            background=BackgroundTask(path.unlink, missing_ok=True))
    except BaseException:
        path.unlink(missing_ok=True)
        raise
