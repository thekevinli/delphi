"""One bounded, best-effort title request per mounted chat engagement."""

import logging
import re
from typing import Any

import httpx
from starlette.concurrency import run_in_threadpool

from .artifacts.prose import assistant_prose
from .config import Settings
from .harness.provider import ResponsesClient, require_completed
from .model_tasks import service_tier_field, service_tier_for
from .storage import Storage, utc_now
from .schemas import CONVERSATION_TITLE_MAX_CHARS
from .storage.base import fit_conversation_title

logger = logging.getLogger("uvicorn.error")

# What the model is asked for sits under what is kept, so a title a word over
# its brief is kept whole rather than cut mid-phrase.
TITLE_BRIEF_CHARS = CONVERSATION_TITLE_MAX_CHARS - 20
TITLE_BRIEF_WORDS = 16


def clean_title(value: str) -> str:
    title = re.sub(r"\s+", " ", value).strip().strip('"“”')
    return fit_conversation_title(title).strip(" .,:;-")


async def generate_conversation_title(
    claim: dict[str, Any], prompt: str, answer: str, username: str, storage: Storage,
    settings: Settings, use_standard_tier: bool,
) -> None:
    if not settings.api_key:
        return
    history = [
        f"{message.get('role', 'user')}: " + (
            assistant_prose(str(message['content'])) if message.get("role") == "assistant" else str(message['content'])
        )
        for message in claim.get("messages", [])
        if message.get("role") in {"user", "assistant"} and message.get("content")
    ]
    history.append(f"user: {prompt}")
    ceiling = settings.conversation_title_recent_input_tokens * 4
    recent = "\n".join(history)[-ceiling:]
    # The answer is the half that carries the subject. "Give me the TLDR" names
    # nothing, and a title written from the prompt alone repeats it back; the
    # answer that followed named the method, the dataset and the result. It is
    # head-truncated because an answer states its thesis first, and it is kept
    # out of `recent`'s tail budget so a long one cannot push the question out.
    answer = assistant_prose(answer).strip()
    if answer:
        answer_ceiling = settings.conversation_title_answer_input_tokens * 4
        recent = f"{recent}\nassistant: {answer[:answer_ceiling]}"
    payload = {
        "model": settings.conversation_title_model,
        "instructions": (
            "Write only a title for this research conversation: the specific "
            "question it is really pursuing. Name the concrete subject — the "
            "method, model, dataset or result the exchange is about — taking it "
            "from the assistant's answer when the question is generic "
            "(\"TLDR\", \"what is this about\"). Never echo a generic question "
            f"back. Use at most {TITLE_BRIEF_WORDS} words and {TITLE_BRIEF_CHARS} "
            "characters. No quotation marks or punctuation-only prefix."
        ),
        "input": [{"role": "user", "content": recent}],
        "reasoning": {"effort": settings.conversation_title_reasoning_effort},
        "max_output_tokens": settings.conversation_title_max_output_tokens,
        **service_tier_field(settings, use_standard_tier),
        "store": False,
    }
    try:
        timeout = httpx.Timeout(settings.conversation_title_timeout_seconds, connect=20)
        async with httpx.AsyncClient(timeout=timeout) as client:
            result = require_completed(
                await ResponsesClient(client, settings).complete(payload), "The title"
            )
            title = clean_title("".join(result.texts()))
            if not title:
                # A response that completed with no output text is the shape
                # this failure takes: the reader sees a conversation still
                # named after its opening question and nothing anywhere says
                # why. It stays best-effort; it no longer stays invisible.
                logger.info(
                    "conversation title empty (status=%s incomplete=%s)",
                    result.status, result.reason,
                )
            if title:
                await run_in_threadpool(
                    storage.set_conversation_title,
                    username, claim["id"], title=title,
                    model=settings.conversation_title_model, updated_at=utc_now(),
                    **({"generation": claim["generation"]} if "generation" in claim else {}),
                )
    except Exception as exc:
        # A title is decorative metadata; it may never fail or cancel the answer.
        logger.info("conversation title failed: %s: %s", type(exc).__name__, exc)
        return
