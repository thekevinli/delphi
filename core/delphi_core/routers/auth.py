import hmac

from fastapi import APIRouter, Depends, HTTPException, Response

from ..config import Settings, get_settings
from ..deps import get_current_user, get_storage
from ..schemas import AccountPreferencesUpdate, Credentials, PasswordChange
from ..security import hash_password, make_session, verify_password
from ..storage import Storage

router = APIRouter(prefix="/api/auth", tags=["auth"])


def set_cookie(response: Response, username: str, settings: Settings) -> None:
    response.set_cookie(
        "delphi_session",
        make_session(username, settings.session_secret, settings.session_days),
        max_age=settings.session_days * 24 * 60 * 60,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )


@router.post("/register")
def register(
    body: Credentials,
    response: Response,
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    # Both sides are stripped before the compare. A code is something a reader
    # is given in a message and pastes, and a trailing newline or space rides
    # along far more often than a wrong code is typed; `compare_digest` cannot
    # tell those apart, so the whitespace read as a refusal. Still constant
    # time, because the comparison itself is what has to be.
    expected = settings.required_signup_code
    if expected and not hmac.compare_digest((body.invite_code or "").strip(), expected):
        raise HTTPException(403, "That invite code is not valid")
    salt, password_hash = hash_password(body.password)
    storage.create_account(body.username, body.email, salt, password_hash)
    set_cookie(response, body.username, settings)
    return {"username": body.username, "email": body.email, "useStandardTier": True}


@router.post("/login")
def login(
    body: Credentials,
    response: Response,
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    account = storage.get_account(body.username)
    if not account or not verify_password(
        body.password, account["passwordSalt"], account["passwordHash"]
    ):
        raise HTTPException(401, "Invalid username or password")
    set_cookie(response, body.username, settings)
    return {
        "username": account["username"],
        "email": account.get("email"),
        "useStandardTier": bool(account.get("useStandardTier", True)),
    }


@router.post("/logout", status_code=204)
def logout(response: Response):
    response.delete_cookie("delphi_session", path="/")


@router.post("/change-password", status_code=204)
def change_password(
    body: PasswordChange,
    response: Response,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
):
    account = storage.get_account(username) or {}
    if (
        not account.get("passwordSalt")
        or not account.get("passwordHash")
        or not verify_password(
            body.current_password,
            account["passwordSalt"],
            account["passwordHash"],
        )
    ):
        raise HTTPException(400, "Current password is incorrect")
    salt, password_hash = hash_password(body.new_password)
    storage.update_password(username, salt, password_hash)
    set_cookie(response, username, settings)


@router.get("/me")
def me(
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    account = storage.get_account(username) or {}
    return {
        "username": username,
        "email": account.get("email"),
        "useStandardTier": bool(account.get("useStandardTier", True)),
    }


@router.patch("/preferences")
def update_preferences(
    body: AccountPreferencesUpdate,
    username: str = Depends(get_current_user),
    storage: Storage = Depends(get_storage),
):
    account = storage.update_account_preferences(
        username, use_standard_tier=body.use_standard_tier
    )
    return {"useStandardTier": bool(account.get("useStandardTier", True))}
