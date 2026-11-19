"""
Search over the raw layer.

The discovery step Delphi's reading tools never had. `read_paper` and
`read_webpage` can open an exact page or an exact anchor, but nothing could
answer *which* page, in which of thirty documents across four projects. This
route and the `search_library` tool beside it are the same query — one for the
reader, one for the model — so a hit the reader can click is a hit the model can
cite.

Account-wide by default. Scoping to a project is a filter the caller may ask
for, never the default, because reaching across projects is the whole point.
"""

from fastapi import APIRouter, Depends, Query

from ..config import Settings, get_settings
from ..deps import get_current_user, get_storage
from ..storage import Storage

router = APIRouter(prefix="/api/library", tags=["library"])


@router.get("/search")
def search_library(
    q: str = Query(default="", max_length=400),
    project_id: str | None = Query(default=None),
    limit: int = Query(default=12, ge=1, le=50),
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    return {
        "query": q,
        "results": storage.search_documents(
            username,
            q,
            project_id=project_id,
            limit=min(limit, settings.library_search_max_results),
        ),
    }
