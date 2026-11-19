"""
Asking where a document says a claim, when matching its words cannot tell.

`verify_recite` first looks for the passage that holds a claim its citation
lacks by matching words (`verify_locate`). A claim the document words
differently ("the gap closes mainly with model size", where the page says "the
performance gap mainly decreases due to increasing model sizes rather than
increasing the number of training tokens"), or one whose page is far from the
one cited, is found by no such match, and an author told only "unsupported"
takes a true claim out. So what words cannot place is asked of a model, in
at most `CALLS_MAX` calls for the whole check (`find`):

- each claim is shown with the checker's objection and the passages of its
  document most likely to hold it (`verify_locate.candidates`), each clipped;
- the model answers, for each claim, the passages that state it, each with a
  sentence copied from the passage (`FIND_CONTRACT`, the second task of the
  stage's contract);
- a passage is taken only when that sentence is in it, matched as
  `harness.evidence` matches any quote, and only among those shown for the
  claim; at most `FOUND_MAX` for one claim.

It decides nothing about whether a claim is true and stores nothing: the page
goes to the checker again with the passages added, and the checker decides.
An answer that cannot be read, or a call that fails or runs out of time, finds
nothing and never fails the job: the objection stands and the author's repair
answers it as before. The call runs on the checker's model task
(`memory.verify`) and is bounded in claims, passages and characters.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Hashable, Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any

from ..config import Settings
from ..harness.evidence import MIN_QUOTE_CHARS, normalise
from ..harness.provider import ProviderError, ResponsesClient, require_completed
from ..model_tasks import service_tier_field
from .verify import FIND_CONTRACT
from .verify_locate import clip_to_claim, readable

logger = logging.getLogger(__name__)

#: Passages shown for one claim, and how much of each.
CANDIDATES = 6
PASSAGE_CHARS = 4_000
#: Claims asked in one call, and calls made at most, side by side; how much of
#: all their passages one call carries, and how much of the block around a claim.
CLAIMS_MAX = 6
CALLS_MAX = 2
TOTAL_CHARS = 140_000
CONTEXT_CHARS = 1_200
#: Passages taken for one claim.
FOUND_MAX = 3

FIND_FORMAT = {
    "type": "json_schema",
    "name": "memory_claim_passages",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["claims"],
        "properties": {
            "claims": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["claim", "found"],
                    "properties": {
                        "claim": {"type": "integer"},
                        "found": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["passage", "sentence"],
                                "properties": {"passage": {"type": "integer"}, "sentence": {"type": "string"}},
                            },
                        },
                    },
                },
            }
        },
    },
}


@dataclass(frozen=True)
class Ask:
    """One claim to find, with the passages of its document it may be in."""

    claim: str
    #: The block of the page the claim is in.
    context: str
    explanation: str
    title: str
    cited: tuple[Hashable, ...]
    #: Passage text by locator (a page number or a section anchor), in document order.
    passages: Mapping[Hashable, str]


def _where(locator: Hashable) -> str:
    return f"page {locator}" if isinstance(locator, int) else f"section {locator}"


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + "\n[clipped]"


# A tag of this request's own, inside text that is only material.
_OWN_TAG = re.compile(r"<(?=/?(?:claim|passage)\b)")


def _inert(text: str) -> str:
    return _OWN_TAG.sub("&lt;", text)


def request_text(asks: Sequence[Ask], passage_chars: int) -> str:
    """The claims and their numbered passages, as the model reads them."""
    parts = []
    for number, ask in enumerate(asks, start=1):
        lines = [
            f'<claim number="{number}">',
            f"Document: {_inert(ask.title)}. Cited at {', '.join(_where(item) for item in ask.cited)}.",
            f"The claim: {_inert(ask.claim)}",
            f"Where it stands on the page:\n{_inert(_clip(ask.context, CONTEXT_CHARS))}",
            f"The checker's objection: {_inert(ask.explanation)}",
        ]
        for index, (locator, text) in enumerate(ask.passages.items(), start=1):
            # A long page is shown where the claim is on it, as the check shows one.
            shown = clip_to_claim(readable(text), passage_chars, ask.claim)
            lines.append(f'<passage number="{index}" at="{_where(locator)}">\n{_inert(shown)}\n</passage>')
        parts.append("\n".join([*lines, "</claim>"]))
    return "\n\n".join(parts)


def accepted(answer: Mapping[str, Any], asks: Sequence[Ask]) -> dict[int, tuple[Hashable, ...]]:
    """Each claim's passages whose copied sentence is in them, by the claim's index in `asks`."""
    found: dict[int, list[Hashable]] = {}
    for entry in answer.get("claims") or ():
        index = entry.get("claim") if isinstance(entry, Mapping) else None
        if not isinstance(index, int) or not 1 <= index <= len(asks):
            continue
        ask = asks[index - 1]
        located = list(ask.passages.items())
        for item in entry.get("found") or ():
            number, sentence = item.get("passage"), normalise(readable(str(item.get("sentence") or "").replace("&lt;", "<")))
            if not isinstance(number, int) or not 1 <= number <= len(located) or len(sentence) < MIN_QUOTE_CHARS:
                continue
            locator, text = located[number - 1]
            if sentence in normalise(readable(text)) and locator not in found.setdefault(index - 1, []):
                found[index - 1].append(locator)
    return {index: tuple(locators[:FOUND_MAX]) for index, locators in found.items() if locators}


async def _ask(
    client: ResponsesClient, settings: Settings, asks: Sequence[Ask], *, timeout: float, use_standard_tier: bool
) -> tuple[dict[int, tuple[Hashable, ...]], dict[str, int]]:
    """One call for at most `CLAIMS_MAX` claims: what it found, by index in `asks`, and what it used."""
    shown = sum(len(ask.passages) for ask in asks)
    request = {
        "model": settings.memory_verify_model,
        "instructions": FIND_CONTRACT,
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": request_text(asks, min(PASSAGE_CHARS, TOTAL_CHARS // max(1, shown)))}
        ]}],
        "reasoning": {"effort": settings.memory_verify_reasoning_effort},
        "text": {"format": FIND_FORMAT},
        "max_output_tokens": settings.memory_verify_max_output_tokens,
        "store": False,
        **service_tier_field(settings, use_standard_tier),
    }
    try:
        result = require_completed(await asyncio.wait_for(client.complete(request), timeout=timeout), "Finding a claim's passage")
        return accepted(json.loads("".join(result.texts())), asks), asdict(result.usage)
    except (TimeoutError, ProviderError, ValueError, AttributeError) as error:
        logger.warning("could not ask where %d claims are said: %s", len(asks), error)
        return {}, {}


async def find(
    client: ResponsesClient, settings: Settings, asks: Sequence[Ask], *, timeout: float, use_standard_tier: bool
) -> tuple[dict[int, tuple[Hashable, ...]], dict[str, int]]:
    """
    The passages that state each claim, by its index in `asks`, and what the calls used.

    At most `CALLS_MAX` calls of `CLAIMS_MAX` claims, side by side; a claim
    past them is left to the repair. Nothing found, and no usage, for every
    failure (see the module docstring).
    """
    asks = list(asks)[: CLAIMS_MAX * CALLS_MAX]
    if not asks or timeout <= 0:
        return {}, {}
    batches = [asks[start:start + CLAIMS_MAX] for start in range(0, len(asks), CLAIMS_MAX)]
    answers = await asyncio.gather(*(
        _ask(client, settings, batch, timeout=timeout, use_standard_tier=use_standard_tier) for batch in batches
    ))
    found: dict[int, tuple[Hashable, ...]] = {}
    usage: dict[str, int] = {}
    for number, (placed, used) in enumerate(answers):
        found.update({number * CLAIMS_MAX + index: locators for index, locators in placed.items()})
        usage = {name: usage.get(name, 0) + used.get(name, 0) for name in {*usage, *used}}
    return found, usage
