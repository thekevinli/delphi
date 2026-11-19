"""
Authenticated resolution of visible reader addresses.

This is intentionally separate from the id-based project APIs. The visible
namespace selects a target but never authorizes access; future sharing policy
belongs here without changing storage identity or canonical URLs.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..deps import get_current_user, get_storage
from ..storage import Storage

router = APIRouter(prefix="/api/reader", tags=["reader"])


def resolve_route(
    route_username: str,
    project_slug: str,
    paper_slug: str | None,
    authenticated_username: str,
    storage: Storage,
) -> dict[str, Any]:
    if route_username != authenticated_username:
        raise HTTPException(404, "Document unavailable")
    try:
        return storage.resolve_reader(
            authenticated_username, project_slug, paper_slug
        )
    except HTTPException as error:
        if error.status_code == 404:
            raise HTTPException(404, "Document unavailable")
        raise


@router.get("/{route_username}/{project_slug}/{paper_slug}")
def resolve_paper_reader(
    route_username: str,
    project_slug: str,
    paper_slug: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    return resolve_route(route_username, project_slug, paper_slug, username, storage)


@router.get("/{route_username}/{project_slug}")
def resolve_project_reader(
    route_username: str,
    project_slug: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    return resolve_route(route_username, project_slug, None, username, storage)
