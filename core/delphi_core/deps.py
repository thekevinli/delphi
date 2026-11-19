from fastapi import Cookie, Depends, HTTPException, Request

from .config import Settings, get_settings
from .security import read_session
from .storage import ObjectStore, Storage


# `request` is what reaches the app's `Stores` without becoming part of the API:
# FastAPI publishes a parameter of any other type as a query or body field.
def get_storage(request: Request, settings: Settings = Depends(get_settings)) -> Storage:
    return request.app.state.stores.storage(settings)


def get_object_store(request: Request, settings: Settings = Depends(get_settings)) -> ObjectStore:
    return request.app.state.stores.objects(settings)


def get_current_user(
    delphi_session: str | None = Cookie(default=None),
    settings: Settings = Depends(get_settings),
    storage: Storage = Depends(get_storage),
) -> str:
    username = read_session(delphi_session, settings.session_secret)
    if not username:
        raise HTTPException(401, "Sign in required")
    if not storage.account_exists(username):
        raise HTTPException(401, "Account no longer exists")
    return username
