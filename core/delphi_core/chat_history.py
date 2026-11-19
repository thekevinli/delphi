"""Complete exchanges, never a message-count slice or reconstructed answers."""

import re
from typing import Any

CHAT_HISTORY_EXCHANGES = 10
#: An image an answer carries inline (an embedded figure card): the reader
#: keeps it, but replaying it would resend tens of thousands of characters a turn.
_INLINE_IMAGE = re.compile(r"(data:image/[\w.+-]+;base64,)[A-Za-z0-9+/=]{64,}")


def complete_exchanges(
    messages: list[dict[str, Any]], limit: int = CHAT_HISTORY_EXCHANGES,
) -> list[dict[str, Any]]:
    """Pair by request identity; a message without one never pairs.

    Interrupted/unanswered requests and orphan answers do not become context.
    Request IDs prevent concurrent answers from attaching to the wrong question;
    duplicate delivery counts once. Return original records so callers can keep
    selected passages while projecting away traces and provider metadata.
    """
    pending: dict[str, tuple[int, dict[str, Any]]] = {}
    pairs: dict[str, tuple[int, dict[str, Any], dict[str, Any]]] = {}
    for position, message in enumerate(messages):
        key = str(message.get("requestId") or "")
        if message.get("role") == "user":
            if key:
                pending[key] = (position, message)
        elif message.get("role") == "assistant" and key:
            question = pending.pop(key, None)
            if not question or message.get("cancelled") or not str(message.get("content") or "").strip():
                continue
            index, user = question
            pairs.setdefault(key, (index, user, message))
    kept = sorted(pairs.values(), key=lambda pair: pair[0])[-limit:] if limit > 0 else []
    return [message for _, user, answer in kept for message in (user, answer)]


def history_input(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    result = []
    for message in complete_exchanges(messages):
        content = str(message.get("content") or "")
        if message["role"] == "user" and message.get("selectedText"):
            content += f"\n\nQuoted passage selected by the user:\n{message['selectedText']}"
        elif message["role"] == "assistant":
            content = _INLINE_IMAGE.sub(r"\1[image omitted]", content)
        result.append({"role": message["role"], "content": content})
    return result
