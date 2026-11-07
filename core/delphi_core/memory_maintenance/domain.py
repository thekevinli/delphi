"""
The domain composer: one model, a bounded read-only loop, and a page returned as its answer.

A domain's page says how the pages filed under the domain relate. The
composer is handed the domain as `gather_domain` built it, with the page as it
stands when there is one, and may open member pages before it states how two
of them relate (`harness.profiles.MEMORY_DOMAIN`: `open_memory`, `grep_memory`
and `memory_links`, and neither tool that writes). It writes one page, known
before it starts, so there is nothing for a write tool to find or refuse:
**its answer is the write**.

**The loop and the answer are one request.** Every round carries the read
tools and a strict output format (`ANSWER_FORMAT`). A round that calls a tool
is served and asked again; the message the model ends on is the answer, read
as an `Answer`. No second request is made to turn what was read into a page.

The answer is addressed operations against the page as it was shown, or a
whole page when the domain has none. It passes the checks a concept write
passes (`admit.py`, with a domain page's limits) and is staged in the run's
`MemoryDraft`, so the checker and the commit read it as they read any staged
page. Nothing here stores anything.

- `compose` runs the loop once. An answer that is refused goes back to the
  model once, with the refusal as the write tools word one; an answer refused
  again fails the job (`AnswerRefused`).
- `repair` resumes the same conversation with what the checker objected to.
  The answer that comes back replaces the staged page. One that is refused, or
  that changes nothing, leaves the page as it was staged, and the pipeline
  drops it: the domain keeps the page it had.

The stage owns its contract, `contracts/domain.md`.
"""

from __future__ import annotations

import dataclasses
import hashlib
import re
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from pydantic import Field, ValidationError

from ..config import Settings
from ..harness.budget import TurnBudget
from ..harness.page_arguments import Calculation, Citation, Operation, stored
from ..harness.profiles import MEMORY_DOMAIN, Turn
from ..harness.prompts import EVIDENCE_REQUIREMENTS, UNTRUSTED_TEXT_RULE, working_method
from ..harness.provider import ProviderError, ResponsesClient, Terminal
from ..harness.registry import Toolset
from ..harness.tool import ToolArguments, ToolContext
from ..model_tasks import service_tier_for
from ..storage.base import memory_slug
from .admit import stage_edit, stage_page
from .agent import NO_TIME_LEFT, added, citable, event_turn, objection_lines, open_pages, run_loop, stored_pages
from .run import Authored, EvidenceSet, JobDeadline, Objection
from .staging import MemoryDraft
from .validate import DOMAIN_LIMITS, REASONS, REMOVAL_FLOOR_CHARS, REMOVAL_MAX

#: Moved when the shape of the request's cached prefix changes.
PROMPT_CACHE_VERSION = "memory-domain-v1"
#: Rounds that may call a tool, and the Memory calls they may make between
#: them (§6 of the plan: the composer may open member pages, at most 8).
DOMAIN_ROUNDS = 4
DOMAIN_MEMORY_CALLS = 8
WRITTEN_KIND = "domain"
_PLACEHOLDER = re.compile(r"\{\{([A-Z_]+)\}\}")


def _load_contract() -> str:
    """The domain contract, with the shared blocks and the enforced numbers put in."""
    text = (Path(__file__).with_name("contracts") / "domain.md").read_text(encoding="utf-8")
    values = {
        "EVIDENCE_REQUIREMENTS": EVIDENCE_REQUIREMENTS,
        "UNTRUSTED_TEXT_RULE": UNTRUSTED_TEXT_RULE,
        "PAGE_CHARS": f"{DOMAIN_LIMITS.target:,}",
        "REASONS": ", ".join(f"`{reason}`" for reason in REASONS),
        "REMOVAL_SHARE": f"{REMOVAL_MAX:.0%}",
        "REMOVAL_FLOOR": f"{REMOVAL_FLOOR_CHARS:,}",
    }
    return _PLACEHOLDER.sub(lambda found: values[found.group(1)], text).strip()


CONTRACT = _load_contract()


class Answer(ToolArguments):
    """The composer's whole answer: a new page, or operations on the page it was shown."""

    note: str = Field(description="One clause in the past tense on what this answer did to the page.")
    summary: str = Field(
        description="What the page explains, in a sentence or two. Empty to keep the summary the page has."
    )
    body: str = Field(description="The whole page in Markdown when the domain has no page yet; otherwise empty.")
    operations: list[Operation] = Field(
        description="Changes to the page as it was shown, by block label; empty when the whole page is in `body`."
    )
    citations: list[Citation] = Field(description="The new evidence the new text cites, each defined once.")
    calculations: list[Calculation] = Field(description="Numbers you derived, or an empty list.")


ANSWER_FORMAT = {"type": "json_schema", "name": "memory_domain_compose", "strict": True, "schema": Answer.parameters()}


class AnswerRefused(ProviderError):
    """The composer's answer was refused, and so was its one correction."""

    def __init__(self, why: str) -> None:
        super().__init__(f"The domain page could not be composed: {why}", Terminal.FAILED)


def instructions(toolset: Toolset) -> str:
    """The request's instructions: the contract, then how to use the tools it offers."""
    return "\n\n".join(part for part in (CONTRACT, working_method(toolset)) if part)


def _task(evidence: EvidenceSet, has_page: bool) -> str:
    slug = evidence.record["domain"]
    said = [
        f"Bring [[{slug}]] up to date for what changed, with operations on its blocks as shown in <current_page>."
        if has_page else f"Write the page of the domain `{slug}`, whole. It will be stored as [[{slug}]].",
        citable(evidence.sources),
        f"You may make at most {DOMAIN_MEMORY_CALLS} calls to Memory before you answer. Your answer is the JSON object.",
    ]
    return "<composing_task>\n" + "\n".join(said) + "\n</composing_task>"


def _last_message(conversation: Sequence[Any]) -> str:
    """The message the model ended on, which is its answer."""
    for item in reversed(conversation):
        if item.get("type") == "message" and item.get("role") == "assistant":
            return "".join(part.get("text") or "" for part in item.get("content") or ())
        if item.get("type") != "reasoning":
            break
    return ""


def without_title(body: str, title: str) -> str:
    """
    The body without a first heading that only repeats the page's title.

    The page is shown under its title, and a body that opens with it shows the
    name twice. Asked not to, a model still often does; this is cheaper than a
    refusal and a second request. Any other first heading is the author's.
    """
    first, _, rest = body.lstrip().partition("\n")
    heading = first.lstrip("#").strip() if first.startswith("#") else None
    if heading is None or memory_slug(heading) != memory_slug(title):
        return body
    return rest.lstrip("\n")


def _admit(draft: MemoryDraft, evidence: EvidenceSet, text: str, pages: Sequence[Any]) -> tuple[str, str]:
    """Read an answer and stage what it writes. Returns the result as a write tool words one, and the note."""
    slug, title = evidence.record["domain"], evidence.record["title"]
    try:
        answer = Answer.model_validate_json(text)
    except ValidationError as error:
        problem = "; ".join(f"{'.'.join(map(str, item['loc']))}: {item['msg']}" for item in error.errors()[:4])
        return f"Error: the answer could not be read as the JSON object asked for ({problem}). Answer with that object alone.", ""
    operations, shown = stored(answer.operations), draft.shown.get(slug)
    given = {"citations": stored(answer.citations), "calculations": stored(answer.calculations), "note": answer.note}
    if shown is None:
        if operations:
            return (
                "Error: the domain has no page yet, so there is no block to address. Give the whole page in "
                "`body` and leave `operations` empty."
            ), ""
        said = stage_page(
            draft, {page.slug for page in pages}, slug=slug, title=title, domain=slug, summary=answer.summary,
            body=without_title(answer.body, title), kind=WRITTEN_KIND, limits=DOMAIN_LIMITS, **given,
        )
    elif answer.body.strip():
        return (
            f"Error: [[{slug}]] already exists and is edited, not written again. Leave `body` empty and give "
            "`operations` on its blocks as <current_page> shows them."
        ), ""
    elif not operations and not answer.summary.strip():
        return "", " ".join(answer.note.split())
    else:
        said = stage_edit(
            draft, pages, slug=slug, operations=operations, summary=answer.summary, kind=WRITTEN_KIND,
            limits=DOMAIN_LIMITS, **given,
        )
    staged = draft.staged_page(slug)
    if staged is not None and staged.title != title:
        # The domain's name is the reader's, and the page is called by it.
        draft.stage(dataclasses.replace(staged, title=title))
    return said, " ".join(answer.note.split())


def _request(
    settings: Settings, toolset: Toolset, username: str, evidence: EvidenceSet, given: list[Any], *, use_standard_tier: bool
) -> dict[str, Any]:
    request: dict[str, Any] = {
        "model": settings.memory_domain_model,
        "instructions": instructions(toolset),
        "input": given,
        "tools": toolset.specs(),
        "reasoning": {"effort": settings.memory_domain_reasoning_effort},
        # The tools and the format travel together: the message the loop ends on is the answer.
        "text": {"format": ANSWER_FORMAT},
        "max_output_tokens": settings.memory_domain_max_output_tokens,
        "store": False,
        "include": ["reasoning.encrypted_content", *toolset.include()],
        "stream": True,
    }
    if tier := service_tier_for(settings, use_standard_tier):
        request["service_tier"] = tier
    if settings.openai_prompt_cache_enabled:
        key = hashlib.sha256(f"{username}\0{evidence.marker}\0{PROMPT_CACHE_VERSION}".encode()).hexdigest()[:24]
        request["prompt_cache_key"] = f"delphi:{PROMPT_CACHE_VERSION}:{key}"
        request["prompt_cache_options"] = {"mode": "explicit", "ttl": "30m"}
    return request


async def _answered(
    client: ResponsesClient, settings: Settings, authored: Authored, context: ToolContext, toolset: Toolset,
    evidence: EvidenceSet, pages: Sequence[Any], *, rounds: int, memory_calls: int, deadline_seconds: float,
) -> tuple[Authored, str]:
    """Run the conversation on from where it stands, and stage the answer it ends on. Returns what staging said."""
    budget = TurnBudget.for_maintenance(
        settings, rounds=rounds, memory_calls=memory_calls, staged_pages=1,
        deadline_seconds=max(deadline_seconds, NO_TIME_LEFT),
    )
    conversation, ended, trace = await run_loop(client, authored.request, toolset, budget, context)
    if ended == "deadline":
        raise JobDeadline("deadline: the domain composer ran out of time before it answered")
    if ended != "completed":
        raise ProviderError(f"The domain composer's answer was cut off: {ended}", Terminal.INCOMPLETE, ended)
    said, note = _admit(authored.draft, evidence, _last_message(conversation), pages)
    return Authored(
        draft=authored.draft, request={**authored.request, "input": conversation}, closing=note or authored.closing,
        ended=ended, rounds=authored.rounds + budget.rounds_run,
        usage=added(authored.usage, dataclasses.asdict(budget.usage)), trace=[*authored.trace, *trace],
    ), said


def _told(authored: Authored, message: str) -> Authored:
    request = {**authored.request, "input": [*authored.request["input"], {"role": "user", "content": message}]}
    return dataclasses.replace(authored, request=request)


async def compose(
    client: ResponsesClient,
    settings: Settings,
    *,
    storage: Any,
    objects: Any,
    username: str,
    evidence: EvidenceSet,
    deadline_seconds: float,
    use_standard_tier: bool,
) -> Authored:
    """
    Compose one domain's page and return what was staged: the page, or nothing.

    Nothing staged is a correct outcome: the page already says what is true.
    Raises `AnswerRefused` when the answer and its one correction were both
    refused, `JobDeadline` when the time ran out, and `ProviderError` when the
    provider did not finish.
    """
    draft = MemoryDraft(evidence.sources, max_pages=1)
    toolset = MEMORY_DOMAIN.toolset(Turn(settings=settings))
    context = ToolContext(
        settings=settings, username=username, storage=storage, objects=objects, offered=toolset.names, draft=draft,
    )
    pages = await context.in_thread(stored_pages, storage, username, settings)
    shown, opened = await open_pages(toolset, context, list(evidence.start_slugs)) if evidence.start_slugs else ("", [])
    given = [event_turn(evidence.brief, settings.openai_prompt_cache_enabled)]
    if shown:
        given.append({"role": "user", "content": (
            "<current_page>\nThe domain's page as it stands, exactly as open_memory shows a page. Address its "
            f"blocks by the labels below.\n\n{shown}\n</current_page>"
        )})
    given.append({"role": "user", "content": _task(evidence, bool(opened))})
    authored = Authored(
        draft=draft, request=_request(settings, toolset, username, evidence, given, use_standard_tier=use_standard_tier),
    )
    started = time.monotonic()
    authored, said = await _answered(
        client, settings, authored, context, toolset, evidence, pages,
        rounds=DOMAIN_ROUNDS, memory_calls=DOMAIN_MEMORY_CALLS, deadline_seconds=deadline_seconds,
    )
    if said.startswith("Error:"):
        # One correction, with no tool left to call: what was read is in the conversation.
        authored, said = await _answered(
            client, settings, _told(authored, f"{said}\n\nNothing was stored. Answer again with the whole answer, corrected."),
            context, toolset, evidence, pages, rounds=0, memory_calls=0,
            deadline_seconds=deadline_seconds - (time.monotonic() - started),
        )
        if said.startswith("Error:"):
            raise AnswerRefused(said.removeprefix("Error:").strip())
    return authored


def _repair_message(objections: Sequence[Objection], page: Any) -> str:
    again = (
        "give the whole page again in `body`" if page.action == "create"
        else "give every operation you still want, corrected, against the page's blocks as <current_page> shows them"
    )
    return (
        "A checker read what you wrote against the evidence and blocked the page. Nothing has been stored.\n\n"
        + objection_lines(page, objections)
        + f"\n\nFix exactly these objections and answer again with the whole answer: {again}. Correct a statement to "
        "what its cited passage says, or take it out; restore what was removed without a reason. Change nothing "
        "else. If an objection cannot be met from the evidence, take the statement out."
    )


async def repair(
    client: ResponsesClient,
    settings: Settings,
    *,
    storage: Any,
    objects: Any,
    username: str,
    authored: Authored,
    evidence: EvidenceSet,
    objections: Sequence[Objection],
    deadline_seconds: float,
    use_standard_tier: bool,
) -> Authored:
    """
    Resume the run once, to answer the objections that blocked the staged page.

    The answer replaces what was staged. When it is refused, cannot be read or
    changes nothing, the page is left exactly as it was staged, which the
    pipeline reads as a page the repair did not change.
    """
    draft = authored.draft
    before = draft.staged
    blocked = [item for item in objections if draft.staged_page(item.slug) is not None]
    if not blocked or not before:
        return authored
    toolset = MEMORY_DOMAIN.toolset(Turn(settings=settings))
    context = ToolContext(
        settings=settings, username=username, storage=storage, objects=objects, offered=toolset.names, draft=draft,
    )
    pages = await context.in_thread(stored_pages, storage, username, settings)
    resumed = _told(authored, _repair_message(blocked, before[0]))
    resumed.request.pop("service_tier", None)
    if tier := service_tier_for(settings, use_standard_tier):
        resumed.request["service_tier"] = tier
    repaired, said = await _answered(
        client, settings, resumed, context, toolset, evidence, pages, rounds=0, memory_calls=0,
        deadline_seconds=deadline_seconds,
    )
    after = draft.staged_page(before[0].slug)
    if said.startswith("Error:") or after is None or after == before[0]:
        # Held in code: a refused or unchanged repair leaves the very page that was blocked.
        draft.discard(before[0].slug)
        draft.stage(before[0])
    # The event says what the composition wrote; the repair's note describes the correction.
    return dataclasses.replace(repaired, closing=authored.closing or repaired.closing)
