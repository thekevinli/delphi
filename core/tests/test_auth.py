import json

from fastapi.testclient import TestClient

from delphi_core.config import Settings, get_settings
from delphi_core.main import app
from delphi_core.storage import LocalStorage


def test_change_password_replaces_hash_and_login_credentials(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            registered = client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "old-password"},
            )
            assert registered.status_code == 200

            storage = LocalStorage(settings)
            before = storage.get_account("reader")

            changed = client.post(
                "/api/auth/change-password",
                json={
                    "current_password": "old-password",
                    "new_password": "new-password",
                },
            )
            assert changed.status_code == 204
            assert "delphi_session=" in changed.headers["set-cookie"]

            # Rotating credentials must not strand the active browser. The
            # change endpoint refreshes its signed first-party session cookie.
            assert client.get("/api/auth/me").status_code == 200

            after = storage.get_account("reader")
            assert after["passwordHash"] != before["passwordHash"]
            assert after["passwordSalt"] != before["passwordSalt"]
            # Neither password may be recoverable from what was stored.
            stored = json.dumps(after)
            assert "old-password" not in stored
            assert "new-password" not in stored

            assert client.post("/api/auth/logout").status_code == 204
            assert (
                client.post(
                    "/api/auth/login",
                    json={"username": "reader", "password": "old-password"},
                ).status_code
                == 401
            )
            assert (
                client.post(
                    "/api/auth/login",
                    json={"username": "reader", "password": "new-password"},
                ).status_code
                == 200
            )
    finally:
        app.dependency_overrides.clear()


def test_registration_is_open_when_no_signup_code_is_configured(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            assert client.get("/api/config").json()["signupCodeRequired"] is False
            opened = client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "a-password"},
            )
            assert opened.status_code == 200
    finally:
        app.dependency_overrides.clear()


def test_account_can_choose_standard_tier_without_exposing_storage_location(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "a-password"},
            )

            initial = client.get("/api/auth/me").json()
            assert initial["useStandardTier"] is True
            assert "storage" not in initial

            changed = client.patch(
                "/api/auth/preferences",
                json={"use_standard_tier": False},
            )
            assert changed.status_code == 200
            assert changed.json() == {"useStandardTier": False}
            assert client.get("/api/auth/me").json()["useStandardTier"] is False
    finally:
        app.dependency_overrides.clear()


def test_signup_code_gates_registration_without_blocking_login(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        signup_code="let-me-in",
    )
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        with TestClient(app) as client:
            # Asked before anyone is signed in: the register form reads it.
            assert client.get("/api/config").json()["signupCodeRequired"] is True
            missing = client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "a-password"},
            )
            assert missing.status_code == 403

            wrong = client.post(
                "/api/auth/register",
                json={
                    "username": "reader",
                    "password": "a-password",
                    "invite_code": "guess",
                },
            )
            assert wrong.status_code == 403

            # A rejected registration must not leave a half-made account behind.
            assert not (tmp_path / "users" / "reader" / "account.json").exists()

            accepted = client.post(
                "/api/auth/register",
                json={
                    "username": "reader",
                    "password": "a-password",
                    "invite_code": "let-me-in",
                },
            )
            assert accepted.status_code == 200

            # A code arrives in a message and is pasted, so it routinely
            # carries a newline or a trailing space. That is the same code,
            # and `compare_digest` is the one thing that cannot see it that
            # way — so both sides are stripped before the compare.
            padded = client.post(
                "/api/auth/register",
                json={
                    "username": "second-reader",
                    "password": "a-password",
                    "invite_code": "  let-me-in\n",
                },
            )
            assert padded.status_code == 200

            # The gate is on registration only; returning users never see it.
            client.post("/api/auth/logout")
            assert (
                client.post(
                    "/api/auth/login",
                    json={"username": "reader", "password": "a-password"},
                ).status_code
                == 200
            )
    finally:
        app.dependency_overrides.clear()
