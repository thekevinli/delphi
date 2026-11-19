"""Every place Delphi asks a model to do one job, in one table.

The answer to "what model does X use, at what effort" used to be spread across
twenty loose `Settings` fields filled in by a chain of fallbacks, so nobody
could read the mapping without tracing the chain — and two of the numbers in it
were wrong for a year without anything noticing.

Worse, the settings that expressed it were invisible where they mattered most.
`scripts/deploy.sh` passes `--set-env-vars`, which *replaces* the whole set, and
it ships no model configuration at all: the deployed service has never once read
`MODEL_DEFAULT`, `DIGEST_MODEL` or `MEMORY_REVIEW_REASONING_EFFORT`. A line in a
local `.env` therefore changes a laptop and nothing else, which is the "it worked
on my machine and I forgot to deploy it" failure with no way to see it. **The
table is the delivery mechanism**: a default in code reaches Cloud Run, and
`test_deployment.py` refuses a deploy script that sets a model variable at all.

Each row names the `Settings` fields it fills, so the settings stay the thing
call sites read and this stays the thing that decides what they hold. Two rows
may share a field, and the import-time check below refuses a table where they
disagree about its value.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Wire values the Responses API accepts, strongest first.
REASONING_EFFORTS = ("max", "xhigh", "high", "medium", "low")

# The provider does not expose the same reasoning ladder for every model. Keep
# the matrix beside the table so the API, both composers, request validation and
# every row below read one contract rather than parallel lists.
MODEL_REASONING_EFFORTS = {
    # https://developers.openai.com/api/docs/models/gpt-6.1-sol
    "gpt-6.1-sol": ("max", "xhigh", "high", "medium", "low"),
    "gpt-6-luna": ("max", "xhigh", "high", "medium", "low"),
    "gpt-6-sol": ("high", "medium", "low"),
    # Offered where a provider does not serve the gpt-6 pair yet (a ChatGPT
    # plan during a rollout), on the same ladders.
    "gpt-5.6-luna": ("max", "xhigh", "high", "medium", "low"),
    "gpt-5.6-sol": ("high", "medium", "low"),
}


@dataclass(frozen=True)
class ModelTask:
    """One job, and the settings that carry it to the call site."""

    key: str
    purpose: str
    model: str
    effort: str
    max_output_tokens: int
    #: Is a person watching this call finish? Documentation today, and the
    #: honest place to hang a latency policy when one is wanted.
    waited_on: bool
    model_setting: str
    effort_setting: str
    tokens_setting: str
    #: Whether the task may search the web. A property of the job, decided
    #: here, never a switch a request carries: the reader does not choose when
    #: to search, the model does (`harness.profiles`).
    web: bool = False


MODEL_TASKS: tuple[ModelTask, ...] = (
    ModelTask(
        "chat.answer",
        "A reader's question, on every turn, in both scopes — the highest-frequency call there is",
        "gpt-6.1-sol",
        "medium",
        # One response's ceiling, reasoning included. Headroom for thinking at
        # a high effort, not a request for length: at 10,000 the thinking could
        # spend it all and cut the answer off mid-citation. A whole turn is
        # bounded separately (`turn_max_output_tokens`).
        32_000,
        True,
        "model_default",
        "reasoning_effort_default",
        "model_max_output_tokens",
        web=True,
    ),
    ModelTask(
        "chat.title",
        "One title per conversation engagement",
        "gpt-6-luna",
        "low",
        1_000,
        False,
        "conversation_title_model",
        "conversation_title_reasoning_effort",
        "conversation_title_max_output_tokens",
    ),
    ModelTask(
        "memory.same-document",
        "Whether a document just added is one the reader deleted, whose page was kept; asked only when the titles differ",
        "gpt-6-luna",
        "low",
        2_000,
        False,
        "memory_same_document_model",
        "memory_same_document_reasoning_effort",
        "memory_same_document_max_output_tokens",
    ),
    ModelTask(
        "chat.select",
        "Which Memory pages a Project question is handed, before it is answered",
        "gpt-6-luna",
        # The reader waits on this before the answer starts: medium, inside
        # `memory_select_timeout_seconds`. Low was not trusted to choose well.
        "medium",
        # Reasoning shares this ceiling with the handful of slugs it produces.
        6_000,
        True,
        "memory_select_model",
        "memory_select_reasoning_effort",
        "memory_select_max_output_tokens",
    ),
    ModelTask(
        "digest.author",
        "The research digest for one document",
        "gpt-6.1-sol",
        "medium",
        16_000,
        False,
        "digest_model",
        "digest_reasoning_effort",
        "digest_max_output_tokens",
    ),
    ModelTask(
        "research.gather",
        "What outside sources bear on one document before its digest is written, and on a Memory job while web evidence is on",
        "gpt-6.1-sol",
        "medium",
        # Findings are a handful of short quotes; the rest is reasoning.
        12_000,
        False,
        "research_model",
        "research_reasoning_effort",
        "research_max_output_tokens",
        web=True,
    ),
    ModelTask(
        "memory.review",
        "Lint, re-filing proposals and domain composition",
        "gpt-6.1-sol",
        "medium",
        36_000,
        False,
        "memory_review_model",
        "memory_review_reasoning_effort",
        "memory_review_max_output_tokens",
    ),
    ModelTask(
        "memory.select",
        "Maintenance: which Memory pages an event bears on, and whether there is anything to file",
        "gpt-6-luna",
        "medium",
        4_000,
        False,
        "memory_file_select_model",
        "memory_file_select_reasoning_effort",
        "memory_file_select_max_output_tokens",
    ),
    ModelTask(
        "memory.maintain",
        "Maintenance: the agent that reads Memory and stages edits to its concept pages, and the rewrite of one page",
        "gpt-6.1-sol",
        "medium",
        32_000,
        False,
        "memory_maintain_model",
        "memory_maintain_reasoning_effort",
        "memory_maintain_max_output_tokens",
    ),
    ModelTask(
        "memory.verify",
        "Maintenance: the checker that reads each staged page against its evidence, and a rewritten page against its "
        "sources; and the call that finds where a document says a claim its citation lacks",
        "gpt-6.1-sol",
        "high",
        8_000,
        False,
        "memory_verify_model",
        "memory_verify_reasoning_effort",
        "memory_verify_max_output_tokens",
    ),
    ModelTask(
        "memory.domain",
        "Maintenance: the composer that writes how a domain's pages connect",
        "gpt-6.1-sol",
        "medium",
        32_000,
        False,
        "memory_domain_model",
        "memory_domain_reasoning_effort",
        "memory_domain_max_output_tokens",
    ),
)

MODEL_TASK_BY_KEY: dict[str, ModelTask] = {task.key: task for task in MODEL_TASKS}


def _validate_table() -> None:
    """Refuse a table that asks a model for an effort it does not offer.

    Nothing checked this before, and it is the exact mistake a per-artifact
    override invites: `gpt-6-sol` is offered no `xhigh` rung, so pinning one would
    have been accepted here and refused by the provider, mid-filing, on every
    document.
    """
    seen: dict[str, tuple[str, str]] = {}
    for task in MODEL_TASKS:
        offered = MODEL_REASONING_EFFORTS.get(task.model)
        if offered is None:
            raise ValueError(f"{task.key} names unknown model {task.model!r}")
        if task.effort not in offered:
            raise ValueError(
                f"{task.key} asks {task.model!r} for {task.effort!r}, which it "
                f"does not offer — pick one of {list(offered)}"
            )
        # Two tasks may share a setting; they may not disagree about it.
        for field, value in (
            (task.model_setting, task.model),
            (task.effort_setting, task.effort),
        ):
            held = seen.get(field)
            if held is not None and held[1] != value:
                raise ValueError(
                    f"{task.key} and {held[0]} both fill {field!r} and disagree: "
                    f"{value!r} vs {held[1]!r}"
                )
            seen[field] = (task.key, value)


_validate_table()


def describe_model_tasks(settings: Any = None) -> str:
    """One line per task, for the startup log.

    A running instance can be asked what it is using, rather than having it
    inferred from whichever branch somebody has checked out. Given the
    instance's `Settings` it reads the fields each row fills, not the row's
    defaults: a desktop connected to Claude logged every task as a gpt model.
    """
    def chosen(task: ModelTask) -> tuple[str, str]:
        if settings is None:
            return task.model, task.effort
        return (
            getattr(settings, task.model_setting, None) or task.model,
            getattr(settings, task.effort_setting, None) or task.effort,
        )

    return "; ".join(
        "{}={}/{}".format(task.key, *chosen(task)) for task in MODEL_TASKS
    )


def service_tier_for(settings: Any, use_standard_tier: bool) -> str:
    """The provider queue one request goes into — decided in one place.

    Six call sites spelled this inline and *two of them disagreed*: four
    hardcoded `"flex"` for the non-standard case while chat read
    `OPENAI_SERVICE_TIER`, so an operator who set that variable moved their
    reader's questions and left every digest and every filing on the old queue.
    Nothing failed; the setting simply meant two different things depending on
    which call you looked at.

    Standard is what an account gets by default (`useStandardTier` is `True` on
    every account), because flex is a slower queue whose latency is nobody's
    to predict — it confounds every measurement taken while it is on. Flex is
    what the Settings toggle *selects*, so it stays reachable and stays the
    off-position value rather than being deleted.

    An empty `OPENAI_SERVICE_TIER` still means "this provider has no tiers", and
    it wins over the account's preference: a name the provider does not know is
    worse than no key at all. That is the porting escape hatch CLAUDE.md §7
    promises, and `service_tier_field` is how a payload omits the key entirely
    rather than sending it blank — the same habit invariant 12 already applies
    to an empty `tools`.
    """
    if not settings.openai_service_tier:
        return ""
    return "default" if use_standard_tier else settings.openai_service_tier


def service_tier_field(settings: Any, use_standard_tier: bool) -> dict[str, str]:
    """`**`-splat into a payload literal: the key, or nothing at all."""
    tier = service_tier_for(settings, use_standard_tier)
    return {"service_tier": tier} if tier else {}
