"""
One search box over the whole account.

The Memory routes used to carry a Find control in the *application's* top
bar that reached exactly one thing: wiki pages. A control whose scope is
narrower than where it sits teaches the wrong lesson about what the product can
find — the mirror image of the mistake recorded in `CLAUDE.md` about library
search living in the library rail.

So this reaches everything an account holds that a person looks for by name or
by phrase: Memory pages, places inside documents, and turns of conversation.
Records only, on both backends — no object read for any scope, which is what
lets it answer a keystroke. The collective matching rule lives in
`workspace_search`, and the reason it differs from the model's own searches is
written down there.
"""

from fastapi import APIRouter, Depends, Query

from ..config import Settings, get_settings
from ..deps import get_current_user, get_storage
from ..storage import Storage

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("")
def search_workspace(
    q: str = Query(default="", max_length=400),
    limit: int = Query(default=20, ge=1, le=50),
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    return {
        "query": q,
        "results": storage.search_workspace(
            username,
            q,
            limit=min(limit, settings.workspace_search_max_results),
        ),
    }
