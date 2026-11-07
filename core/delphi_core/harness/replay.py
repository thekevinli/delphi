"""
What a stateless next round is handed back.

`store: False` means the provider keeps nothing, so a round knows only what
the request carries. Handing back the calls alone left the model without its
own reasoning and without anything it had already told the reader: it
re-derived its reading of the request every round, and announced its plan
again each time it did.

`REPLAY_POLICY` is the one place this is decided: one entry per output item
type, each giving the item as the next request must carry it, or None to leave
it out. It was filled in from a measurement, not from documentation
(ARCHITECTURE.md, "What the provider does, measured"): the provider accepts
every form below, and it accepts a hosted search being left out too — after
which the next round runs the same search again and reads twice the input. So
a completed hosted call is handed back.

Ids are dropped because they name records the provider never kept. An item of
a type this table does not know is left out and logged: leaving an item out is
accepted in every case that was measured, and a shape nobody tested may not be.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

logger = logging.getLogger("uvicorn.error")


def _reasoning(item: dict[str, Any]) -> dict[str, Any] | None:
    # Reasoning travels as the sealed `encrypted_content` the request asks
    # for; an item without it cannot be handed back.
    if not item.get("encrypted_content"):
        return None
    return {
        "type": "reasoning",
        "summary": item.get("summary") or [],
        "encrypted_content": item["encrypted_content"],
    }


def _message(item: dict[str, Any]) -> dict[str, Any] | None:
    content: list[dict[str, Any]] = []
    for part in item.get("content") or []:
        if part.get("type") != "output_text" or not part.get("text"):
            continue
        block: dict[str, Any] = {"type": "output_text", "text": part["text"]}
        # A citation is part of what the model said. Without it a later round
        # sees its own sentence and not where the sentence came from.
        if part.get("annotations"):
            block["annotations"] = part["annotations"]
        content.append(block)
    if not content:
        return None
    message = {"type": "message", "role": "assistant", "content": content}
    if item.get("phase"):
        message["phase"] = item["phase"]
    return message


def _function_call(item: dict[str, Any]) -> dict[str, Any] | None:
    return {
        "type": "function_call",
        "call_id": item.get("call_id"),
        "name": item.get("name"),
        "arguments": item.get("arguments") or "{}",
    }


def _hosted_call(item: dict[str, Any]) -> dict[str, Any] | None:
    # A call the allowance cut arrives as an item that never completed. It
    # found nothing, so there is nothing for a later round to know about it.
    if item.get("status") != "completed":
        return None
    return {key: value for key, value in item.items() if key != "id"}


REPLAY_POLICY: dict[str, Callable[[dict[str, Any]], dict[str, Any] | None]] = {
    "reasoning": _reasoning,
    "message": _message,
    "function_call": _function_call,
    "web_search_call": _hosted_call,
}


def replay_item(item: dict[str, Any]) -> dict[str, Any] | None:
    """One output item as the model's next round must be handed it, or None."""
    kind = item.get("type") or ""
    policy = REPLAY_POLICY.get(kind)
    if policy is None:
        logger.warning("replay: an output item of unknown type %r was left out", kind)
        return None
    return policy(item)


def replay_items(output: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """A round's output as the next request carries it, in order."""
    return [replayed for item in output if (replayed := replay_item(item))]
