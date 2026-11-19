"""How a model provider's refusal reads to the person who caused it.

Below the harness and the Memory code, which both report refusals.
"""

from __future__ import annotations

import httpx


def provider_refusal(exc: Exception) -> str:
    """
    What a refusing provider said, or the exception's own text.

    httpx words every refusal as "Client error '401 Unauthorized' for url …",
    which tells a reader nothing. A Responses-style JSON error body carries a
    message meant for them (a desktop sign-in that expired, a missing local
    runtime), so prefer that, bounded. Only `error.message` is read: a proxy
    may echo request content elsewhere in its body.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        try:
            error = exc.response.json().get("error")
        except Exception:
            # This runs inside callers' failure handlers, so it may never raise:
            # an unread body, non-JSON, a list, or nesting deep enough to exhaust
            # the parser all fall back to the exception's text.
            error = None
        if isinstance(error, dict) and isinstance(error.get("message"), str) and error["message"].strip():
            return error["message"].strip()[:600]
    return str(exc)
