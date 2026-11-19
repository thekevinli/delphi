import base64
import hashlib
import hmac
import json
import secrets
import time


def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=2**14,
        r=8,
        p=1,
        dklen=32,
    )
    return base64.urlsafe_b64encode(salt).decode(), base64.urlsafe_b64encode(digest).decode()


def verify_password(password: str, salt_text: str, expected_text: str) -> bool:
    salt = base64.urlsafe_b64decode(salt_text.encode())
    _, actual = hash_password(password, salt)
    return hmac.compare_digest(actual, expected_text)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def make_session(username: str, secret: str, days: int) -> str:
    payload = {
        "sub": username,
        "exp": int(time.time()) + days * 24 * 60 * 60,
        "nonce": secrets.token_hex(8),
    }
    encoded = _b64(json.dumps(payload, separators=(",", ":")).encode())
    signature = _b64(hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def make_page_token(
    username: str, project_id: str, paper_id: str, secret: str, seconds: int
) -> str:
    """
    Prove one request for one page, on a host that has no session cookie.

    The proxy is served from a sandbox origin precisely so that the session
    cookie never reaches it, which leaves the request with nothing to identify
    it. This is that proof, and it is deliberately the narrowest one that works:
    bound to a single paper, valid for minutes, and accepted by no other route.
    The proxied page can read it out of its own URL, so it must be worth as
    little as possible if it does.
    """
    payload = {
        "sub": username,
        "prj": project_id,
        "ppr": paper_id,
        "exp": int(time.time()) + seconds,
    }
    encoded = _b64(json.dumps(payload, separators=(",", ":")).encode())
    signature = _b64(hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def read_page_token(
    token: str | None, project_id: str, paper_id: str, secret: str
) -> str | None:
    """The username this token speaks for, or None. Scope is checked, not trusted."""
    if not token or "." not in token:
        return None
    encoded, signature = token.split(".", 1)
    expected = _b64(hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        payload = json.loads(_unb64(encoded))
        if payload["exp"] < time.time():
            return None
        if payload["prj"] != project_id or payload["ppr"] != paper_id:
            return None
        return str(payload["sub"])
    except (KeyError, ValueError, json.JSONDecodeError):
        return None


def _signed_payload(payload: dict, secret: str) -> str:
    encoded = _b64(json.dumps(payload, separators=(",", ":")).encode())
    signature = _b64(hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def _read_signed_payload(token: str | None, secret: str) -> dict | None:
    if not token or "." not in token:
        return None
    encoded, signature = token.split(".", 1)
    expected = _b64(hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        payload = json.loads(_unb64(encoded))
        if payload["exp"] < time.time():
            return None
        return payload
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def make_navigation_token(
    username: str,
    project_id: str,
    paper_id: str,
    normalized_url: str,
    sandboxed: bool,
    secret: str,
    seconds: int,
) -> str:
    """Bind one short-lived frame POST to one exact normalized destination."""
    return _signed_payload(
        {
            "typ": "navigation",
            "sub": username,
            "prj": project_id,
            "ppr": paper_id,
            "url": hashlib.sha256(normalized_url.encode()).hexdigest(),
            "sbx": sandboxed,
            "exp": int(time.time()) + seconds,
        },
        secret,
    )


def read_navigation_token(
    token: str | None,
    project_id: str,
    paper_id: str,
    normalized_url: str,
    sandboxed: bool,
    secret: str,
) -> str | None:
    payload = _read_signed_payload(token, secret)
    expected_url = hashlib.sha256(normalized_url.encode()).hexdigest()
    if not payload:
        return None
    if (
        payload.get("typ") != "navigation"
        or payload.get("prj") != project_id
        or payload.get("ppr") != paper_id
        or payload.get("url") != expected_url
        or payload.get("sbx") is not sandboxed
    ):
        return None
    return str(payload.get("sub"))


def make_staged_upload_token(
    username: str, project_id: str, paper: dict, secret: str, seconds: int
) -> str:
    """
    Carry a compressed-but-unconfirmed upload across the two requests it takes.

    The bytes are already in the object store under this paper's key; only the
    record is outstanding. Rather than keep server-side pending state -- which
    would have to be reaped, and would pin the reader to one instance -- the
    facts the record needs travel signed through the browser. Signed, because
    the reader would otherwise be free to claim any page count or size they
    liked for bytes the server has already stored.
    """
    payload = {
        "sub": username,
        "prj": project_id,
        "ppr": paper["id"],
        "paper": paper,
        "exp": int(time.time()) + seconds,
    }
    encoded = _b64(json.dumps(payload, separators=(",", ":")).encode())
    signature = _b64(hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def read_staged_upload_token(
    token: str | None, username: str, project_id: str, secret: str
) -> dict | None:
    """The paper record this token vouches for, or None. Scope is checked, not trusted."""
    if not token or "." not in token:
        return None
    encoded, signature = token.split(".", 1)
    expected = _b64(hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        payload = json.loads(_unb64(encoded))
        if payload["exp"] < time.time():
            return None
        if payload["sub"] != username or payload["prj"] != project_id:
            return None
        paper = payload["paper"]
        if paper["id"] != payload["ppr"]:
            return None
        return dict(paper)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def read_session(token: str | None, secret: str) -> str | None:
    if not token or "." not in token:
        return None
    encoded, signature = token.split(".", 1)
    expected = _b64(hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        payload = json.loads(_unb64(encoded))
        if payload["exp"] < time.time():
            return None
        return str(payload["sub"])
    except (KeyError, ValueError, json.JSONDecodeError):
        return None
