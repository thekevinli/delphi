"""
Select: one cheap call over the Memory index, asked one of two questions.

It is the call chat makes before a question beside a document
(`memory_harness.memory_selection_request`): the whole index first, as the
request's cached prefix, and a short turn after it. Here the turn is not a
reader's question but one of these:

1. `select_pages`: given this event, which existing pages does it bear on,
   and is there anything worth filing at all. Most finished sessions end
   here, with `nothingToFile`, and no agent runs.
2. `same_idea`: given a page the agent is about to create, which concept
   pages already explain the same idea. `create_memory` refuses on any.

Both are judged by meaning, from titles and summaries: "rotary embeddings" and
"RoPE" share no word. Both send the same instructions (`contracts/select.md`),
the same index and the same answer format, so every call of either kind shares
one provider prefix until a commit changes the index.

What the model was told is also enforced here. A page that does not exist, the
event's own source page and a domain page are dropped from an answer whatever
it says. An answer that cannot be read **raises**: it is never taken for
"nothing to file", which would settle a job that filed nothing, and never for
"no page explains this", which would let a duplicate through.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

from ..config import Settings
from ..harness.prompts import UNTRUSTED_TEXT_RULE
from ..harness.provider import ProviderResult, ResponsesClient, require_completed
from ..memory_graph_index import MemoryGraphIndex
from ..memory_harness import fit_text, memory_index_block
from ..model_tasks import service_tier_field
from ..research_digest import DIGEST_CONTENT_SCHEMA_MAX, LONGEST_DIGEST_BUDGET
from . import brief as tags
from .jobs import DOCUMENT
from .run import EvidenceSet, Selection

logger = logging.getLogger("uvicorn.error")

#: Pages one event may be said to bear on (§5.3 of the plan), and existing
#: pages one proposed page may be said to repeat. The contract states both.
SELECT_MAX_PAGES = 8
SAME_IDEA_MAX_PAGES = 3
#: How much of an event the call reads. A standard digest is at most 16,000
#: characters, so a document's brief fits whole; a long session is cut, and
#: says so.
EVENT_MAX_CHARS = 32_000
#: A long document's digest may be up to three times that
#: (`research_digest.DigestBudget`), and its brief is still read whole: the
#: tail of a book's digest names what its later chapters bear on, and cutting
#: it would also cut the evidence index and the cross-references after it.
#: The room around the digest stays what it was.
DOCUMENT_EVENT_MAX_CHARS = EVENT_MAX_CHARS - DIGEST_CONTENT_SCHEMA_MAX + LONGEST_DIGEST_BUDGET.wall_chars
EVENT_CUT = f"\n[the event continues; it was cut here]\n</{tags.EVENT}>"
#: How much of a proposed page's title, names and summary the second question carries.
PROPOSED_TITLE_CHARS = 200
PROPOSED_SUMMARY_CHARS = 1_200
PROPOSED_MAX_ALIASES = 12
#: Raised whenever the contract or the answer format changes, so a request
#: never shares a cache slot with one whose prefix differs.
PROMPT_CACHE_VERSION = "memory-file-select-v1"

SELECT_INSTRUCTIONS = (
    (Path(__file__).with_name("contracts") / "select.md")
    .read_text(encoding="utf-8")
    .replace("{{UNTRUSTED_TEXT_RULE}}", UNTRUSTED_TEXT_RULE)
    .strip()
)

SELECT_FORMAT = {
    "type": "json_schema",
    "name": "memory_file_selection",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["nothingToFile", "reason", "pages", "needsOutside"],
        "properties": {
            "nothingToFile": {"type": "boolean"},
            "reason": {"type": "string"},
            "pages": {"type": "array", "items": {"type": "string"}},
            "needsOutside": {"type": ["string", "null"]},
        },
    },
}

QUESTION_ONE = "Question one: what does this event bear on, and is there anything to file?"
QUESTION_TWO = "Question two: does this idea already have a page?"


class SelectionUnreadable(ValueError):
    """The call's answer was not the JSON it was asked for. The caller fails; nothing is assumed."""


def selection_request(
    settings: Settings, index_text: str, turn_text: str, *, username: str, use_standard_tier: bool = True
) -> dict[str, Any]:
    """
    The request either question is asked with: the index first, then the turn.

    No tools, and nothing stored at the provider. Everything before the turn
    is the same for every call an account makes until its index changes, so
    the breakpoint on the index block is where the cached prefix ends.
    """
    payload: dict[str, Any] = {
        "model": settings.memory_file_select_model,
        "instructions": SELECT_INSTRUCTIONS,
        "input": [
            memory_index_block(index_text, settings.openai_prompt_cache_enabled),
            {"role": "user", "content": turn_text},
        ],
        "reasoning": {"effort": settings.memory_file_select_reasoning_effort},
        "text": {"format": SELECT_FORMAT},
        "max_output_tokens": settings.memory_file_select_max_output_tokens,
        "store": False,
        **service_tier_field(settings, use_standard_tier),
    }
    if settings.openai_prompt_cache_enabled:
        key = hashlib.sha256(f"{username}\0memory-file-select\0{PROMPT_CACHE_VERSION}".encode()).hexdigest()[:24]
        payload["prompt_cache_key"] = f"delphi:{PROMPT_CACHE_VERSION}:{key}"
        payload["prompt_cache_options"] = {"mode": "explicit", "ttl": "30m"}
    return payload


def event_turn(evidence: EvidenceSet) -> str:
    """Question one's turn: the event, bounded."""
    limit = DOCUMENT_EVENT_MAX_CHARS if evidence.kind == DOCUMENT else EVENT_MAX_CHARS
    return f"{QUESTION_ONE}\n\n{fit_text(evidence.brief, limit, EVENT_CUT)}"


def proposed_turn(title: str, aliases: Sequence[str], summary: str) -> str:
    """Question two's turn: the page the agent means to create."""
    names = [tags.clip(" ".join(str(alias).split()), PROPOSED_TITLE_CHARS) for alias in aliases if str(alias).strip()]
    lines = [
        f"Title: {tags.clip(' '.join((title or '').split()), PROPOSED_TITLE_CHARS)}",
        *([f"Also called: {'; '.join(names[:PROPOSED_MAX_ALIASES])}"] if names else []),
        f"Summary: {tags.clip(' '.join((summary or '').split()), PROPOSED_SUMMARY_CHARS)}",
    ]
    return f"{QUESTION_TWO}\n\n{tags.fence(tags.PROPOSED_PAGE, chr(10).join(lines))}"


async def _ask(client: ResponsesClient, payload: dict[str, Any], timeout: float, what: str) -> tuple[dict[str, Any], ProviderResult]:
    """One call inside one limit on the whole exchange, and its answer as a JSON object."""
    result = require_completed(await asyncio.wait_for(client.complete(payload), timeout), what)
    text = "".join(result.texts())
    try:
        answer = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SelectionUnreadable(f"{what} did not answer in JSON: {text[:200]!r}") from exc
    if not isinstance(answer, dict) or not isinstance(answer.get("pages"), list):
        raise SelectionUnreadable(f"{what} answered without a list of pages: {text[:200]!r}")
    if not isinstance(answer.get("nothingToFile"), bool):
        raise SelectionUnreadable(f"{what} did not say whether there is anything to file: {text[:200]!r}")
    return answer, result


def _usage(result: ProviderResult) -> dict[str, int]:
    """What the call cost, under the names the filing telemetry already uses."""
    return {
        "inputTokens": result.usage.input_tokens,
        "cacheReadTokens": result.usage.cached_tokens,
        "cacheWriteTokens": result.usage.cache_write_tokens,
        "outputTokens": result.usage.output_tokens,
        "reasoningTokens": result.usage.reasoning_tokens,
    }


def _existing(asked: Iterable[Any], graph: MemoryGraphIndex) -> list[str]:
    """The pages an answer named that exist, by their own slugs, in the order named, once each."""
    found: list[str] = []
    for raw in asked:
        slug = graph.resolve_slug(str(raw).rsplit("/", 1)[-1].strip().strip("[]"))
        if slug in graph.pages_by_slug and slug not in found:
            found.append(slug)
    return found


def own_source_pages(evidence: EvidenceSet, graph: MemoryGraphIndex) -> set[str]:
    """The source pages of the documents an event is filed from: where the agent starts, never a selection."""
    papers = {evidence.paper_id, *(source.id for source in evidence.sources if source.kind == "document")}
    return {
        page["slug"]
        for page in (graph.source_page_by_paper_id.get(paper_id) for paper_id in papers if paper_id)
        if page
    }


def _first_ideas(evidence: EvidenceSet, graph: MemoryGraphIndex, filed_before: bool) -> bool:
    """
    A document's first filing, and no concept page written from it yet: whether its ideas are in Memory is the agent's to say.

    The selection reads titles and summaries, and it has twice read a
    document's own source page as Memory having taken the document in: the
    first document into an empty Memory (0.6.3), and On-Policy Distillation
    in round 5, eighth into a Memory of eleven concept pages. A concept page
    created from a document carries its `sourcePaperId`; until one does, the
    agent, which opens pages, decides, and may still file nothing. A document
    filed before is refiled on the selection's word: one whose filing only
    edited pages never carries a concept page of its own.
    """
    return evidence.kind == DOCUMENT and not filed_before and not any(
        page.get("kind") == "concept" and page.get("sourcePaperId") == evidence.paper_id
        for page in graph.pages_by_slug.values()
    )


async def select_pages(
    client: ResponsesClient,
    settings: Settings,
    *,
    index_text: str,
    graph: MemoryGraphIndex,
    evidence: EvidenceSet,
    username: str,
    timeout: float,
    use_standard_tier: bool = True,
    filed_before: bool = False,
) -> Selection:
    """
    Which existing pages an event bears on, or that there is nothing to file.

    `index_text` and `graph` are one reading of the account
    (`memory_harness.selection_index`). `filed_before`: an earlier job of a
    document's own marker filed pages. Raises when the call fails, runs past
    `timeout` (`TimeoutError`) or answers unreadably (`SelectionUnreadable`):
    the job fails and is retried.
    """
    payload = selection_request(settings, index_text, event_turn(evidence), username=username, use_standard_tier=use_standard_tier)
    answer, result = await _ask(client, payload, timeout, "Memory selection for filing")
    reason = " ".join(str(answer.get("reason") or "").split())
    if answer["nothingToFile"] and not _first_ideas(evidence, graph, filed_before):
        # Whatever pages came with it: nothing is filed, so nothing is opened.
        return Selection(True, reason, usage=_usage(result))
    own = own_source_pages(evidence, graph)
    pages = [slug for slug in _existing(answer["pages"], graph) if slug not in own and not graph.is_domain_page(slug)]
    outside = answer.get("needsOutside")
    return Selection(
        False,
        reason,
        tuple(pages[:SELECT_MAX_PAGES]),
        " ".join(outside.split()) or None if isinstance(outside, str) else None,
        _usage(result),
    )


async def same_idea(
    client: ResponsesClient,
    settings: Settings,
    *,
    index_text: str,
    graph: MemoryGraphIndex,
    title: str,
    aliases: Sequence[str],
    summary: str,
    username: str,
    timeout: float,
    use_standard_tier: bool = True,
) -> list[str]:
    """
    The existing concept pages that already explain the idea of a proposed page.

    At most three slugs, closest first; usually none. Only concept pages that
    exist are returned: a source page is a document and a domain page a
    listing of relations, and neither explains one idea.

    Raises when the call fails, times out or answers unreadably, and never
    answers "none" in its place. The caller is `create_memory`, through
    `ToolContext.same_idea`: the dispatcher turns the failure into "could not
    be run just now", so that create stages nothing (no duplicate slips
    through) and the agent may try once more or finish without the page (the
    job is not held up).
    """
    payload = selection_request(
        settings, index_text, proposed_turn(title, aliases, summary), username=username, use_standard_tier=use_standard_tier
    )
    answer, result = await _ask(client, payload, timeout, "The same-idea check")
    pages = [
        slug for slug in _existing(answer["pages"], graph) if graph.pages_by_slug[slug].get("kind") == "concept"
    ][:SAME_IDEA_MAX_PAGES]
    logger.info("memory_same_idea title=%r pages=%s usage=%s", title[:80], pages, _usage(result))
    return pages
