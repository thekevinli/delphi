"""
Personas: the picker, the marketplace, and what a project is pointed at.

Two shapes of read live here and they are deliberately different. A *listing* —
the picker's own tab, a marketplace page — carries no bodies, so a page costs a
few hundred bytes a row instead of thirty kilobytes; the same argument that keeps
a web document down to an outline. A *detail* read carries one body, and is what
a preview or an install asks for.

The trust boundary is the fork. Browsing shows you what other people published;
installing copies it into a persona you own. After that nothing the author does —
editing, unpublishing, deleting their account — reaches you, and no request Delphi
builds ever resolves a record another account controls.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from ..config import Settings, get_settings
from ..deps import get_current_user, get_storage
from ..personas import OFFICIAL_PERSONAS, official_persona, official_summary
from ..schemas import PersonaCreate, PersonaInstall, PersonaUpdate
from ..storage import Storage

router = APIRouter(prefix="/api/personas", tags=["personas"])


def require_marketplace(settings: Settings) -> None:
    if not settings.persona_marketplace_enabled:
        raise HTTPException(404, "The persona marketplace is not enabled")


@router.get("")
def list_personas(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    """
    Both of the picker's first two tabs in one round trip.

    `official` is a code constant, so this costs exactly one indexed query no
    matter how the four are presented.
    """
    return {
        "official": [official_summary(persona) for persona in OFFICIAL_PERSONAS],
        "mine": storage.list_personas(username),
    }


@router.get("/browse")
def browse_personas(
    response: Response,
    q: str = Query(default="", max_length=100),
    cursor: str | None = Query(default=None, max_length=200),
    limit: int | None = Query(default=None, ge=1, le=50),
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    require_marketplace(settings)
    page = storage.browse_personas(
        username,
        query=q,
        cursor=cursor,
        limit=limit or settings.persona_browse_page_size,
    )
    # The body does not depend on who asked — the client marks its own rows — so
    # a browsing reader paging back and forth is not re-querying every time.
    # Private, because it still names the authors of published personas.
    response.headers["Cache-Control"] = "private, max-age=15"
    return page


@router.get("/{persona_id}")
def get_persona(
    persona_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    """One persona with its body: yours, an official one, or a published one."""
    return storage.get_persona(username, persona_id)


@router.post("", status_code=201)
def create_persona(
    body: PersonaCreate,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    fields = body.model_dump()
    fields["content"] = fields["content"].strip()
    if not fields["content"]:
        raise HTTPException(422, "A persona needs instructions")
    fields["name"] = fields["name"].strip()
    return storage.create_persona(username, fields)


@router.patch("/{persona_id}")
def update_persona(
    persona_id: str,
    body: PersonaUpdate,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    if official_persona(persona_id) is not None:
        # The four are code. Refusing here rather than 404ing says the right
        # thing: it exists, and it is not yours to edit.
        raise HTTPException(409, "Official personas cannot be edited. Save your own.")
    fields = body.model_dump(exclude_unset=True, exclude={"expected_revision"})
    if "content" in fields:
        fields["content"] = (fields["content"] or "").strip()
        if not fields["content"]:
            raise HTTPException(422, "A persona needs instructions")
    if "name" in fields:
        fields["name"] = (fields["name"] or "").strip()
        if not fields["name"]:
            raise HTTPException(422, "A persona needs a name")
    if not fields:
        raise HTTPException(422, "Nothing to change")
    return storage.update_persona(
        username, persona_id, fields, expected_revision=body.expected_revision
    )


@router.delete("/{persona_id}", status_code=204)
def delete_persona(
    persona_id: str,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    storage.delete_persona(username, persona_id)


@router.post("/{persona_id}/install", status_code=201)
def install_persona(
    persona_id: str,
    body: PersonaInstall | None = None,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    """
    Fork a published persona into one this account owns.

    Idempotent, and it is the fork — not a permission check — that makes running
    a stranger's instructions safe: from here the text is this reader's own, and
    the author has no further reach into it. That guarantee carries more weight
    than it used to: every scope now sends a persona id on the request, so the
    fork is what stands between a stranger's mutable text and the reader's own
    chat. `resolve_persona_for_request` is where it is enforced.

    It no longer selects anything. A persona belongs to a conversation, and a
    marketplace row has none in view.
    """
    require_marketplace(settings)
    if official_persona(persona_id) is not None:
        raise HTTPException(409, "Official personas are always available")
    return storage.install_persona(username, persona_id)
