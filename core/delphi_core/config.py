from functools import lru_cache
from pathlib import Path
from typing import TypeVar

import os

from dotenv import dotenv_values
from fastapi import Request
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict

from .model_tasks import (  # noqa: F401  (re-exported for existing importers)
    MODEL_REASONING_EFFORTS,
    MODEL_TASKS,
    REASONING_EFFORTS,
    describe_model_tasks,
)
from .schemas import REWRITE_NOTE_MAX_WORDS

#: The environment names 0.7.0 retired when Knowledge became Memory, each with the
#: name that replaced it. Settings ignore a name they do not know (`extra="ignore"`),
#: so an old `.env` or deployment would otherwise run on defaults without a word.
RETIRED_ENV = {
    "KNOWLEDGE_BASE_ENABLED": "MEMORY_ENABLED",
    "KNOWLEDGE_MODEL": "MEMORY_REVIEW_MODEL",
    "KNOWLEDGE_REASONING_EFFORT": "MEMORY_REVIEW_REASONING_EFFORT",
    "KNOWLEDGE_TIMEOUT_SECONDS": "MEMORY_REVIEW_TIMEOUT_SECONDS",
    "KNOWLEDGE_MAX_OUTPUT_TOKENS": "MEMORY_REVIEW_MAX_OUTPUT_TOKENS",
    "KNOWLEDGE_MAX_PAGES": "MEMORY_MAX_PAGES",
    "KNOWLEDGE_DRAIN_WORKERS": "MEMORY_DRAIN_WORKERS",
    "KNOWLEDGE_JOB_MAX_ATTEMPTS": "MEMORY_JOB_MAX_ATTEMPTS",
    "KNOWLEDGE_JOB_LEASE_RENEW_SECONDS": "MEMORY_JOB_LEASE_RENEW_SECONDS",
    "KNOWLEDGE_JOB_LEASE_SECONDS": "MEMORY_JOB_LEASE_SECONDS",
    "KNOWLEDGE_PAGE_MAX_CHARS": "MEMORY_PAGE_MAX_CHARS",
    "KNOWLEDGE_SUMMARY_MAX_CHARS": "MEMORY_SUMMARY_MAX_CHARS",
    "KNOWLEDGE_RELATED_HOPS": "MEMORY_RELATED_HOPS",
    "KNOWLEDGE_TOOL_MAX_CALLS": "MEMORY_TOOL_MAX_CALLS",
    "KNOWLEDGE_GENERAL_TOOL_MAX_CALLS": "MEMORY_GENERAL_TOOL_MAX_CALLS",
    "KNOWLEDGE_FIGURE_MAX_PER_PAGE": "MEMORY_FIGURE_MAX_PER_PAGE",
    "KNOWLEDGE_FIGURE_MAX_SIDE": "MEMORY_FIGURE_MAX_SIDE",
    "KNOWLEDGE_FIGURE_MAX_VIEWS": "MEMORY_FIGURE_MAX_VIEWS",
    "KNOWLEDGE_REWRITE_NOTE_MAX_WORDS": "MEMORY_REWRITE_NOTE_MAX_WORDS",
}


class RetiredEnvironment(PydanticBaseSettingsSource):
    """Refuse to start on a retired name, set in the environment or in the env file."""

    def __init__(self, settings_cls: type[BaseSettings], dotenv: PydanticBaseSettingsSource) -> None:
        super().__init__(settings_cls)
        self.dotenv = dotenv

    def get_field_value(self, field, field_name):  # a check, never a value
        return None, field_name, False

    def __call__(self) -> dict:
        names = {name.upper() for name in os.environ}
        files = getattr(self.dotenv, "env_file", None)
        for file in [] if files is None else [files] if isinstance(files, (str, Path)) else files:
            path = Path(file).expanduser()
            if path.is_file():
                names |= {name.upper() for name in dotenv_values(path)}
        retired = sorted(names & RETIRED_ENV.keys())
        if retired:
            renamed = "; ".join(f"{old} is now {RETIRED_ENV[old]}" for old in retired)
            raise ValueError(f"Retired settings are set: {renamed}. Set the new names; the old ones are not read.")
        return {}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file="../.env", extra="ignore")

    @classmethod
    def settings_customise_sources(cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings):
        return (RetiredEnvironment(settings_cls, dotenv_settings), init_settings, env_settings, dotenv_settings,
                file_secret_settings)

    app_name: str = "Delphi"
    #: Root log level, applied at app assembly. INFO because the lines this
    #: application chooses to write are few and each one names an event worth
    #: seeing in a container's log; raise it to WARNING to quieten a noisy host.
    log_level: str = "INFO"
    data_dir: Path = Path(".data")
    session_secret: str = "change-me-in-production"
    session_days: int = 30
    # HTTPS-only cookies break plain-http localhost, so this stays off by
    # default and is turned on for any deployed environment.
    cookie_secure: bool = False
    # When set, registration requires this code. Empty means open signup for a
    # local filesystem install; cloud-backed deployments refuse to start open.
    # The deployed value is a plain env var in `deploy.sh` rather than a Secret
    # Manager binding: while the app is private the code is a speed bump, not
    # a secret, and a value nothing in the repo seeds is a value that can only
    # drift — which is how a correct code came back "not valid".
    signup_code: str = ""
    frontend_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    # What a stored paper may weigh.
    max_upload_mb: int = 30
    # What may be read off the wire while trying to get under that. A paper
    # between the two is compressed and then offered to the reader at its new
    # size; one above it is refused without being written anywhere.
    #
    # Deployed, this only holds because the container serves h2c: Cloud Run
    # rejects an HTTP/1 request body over 32 MiB before the app sees a byte of
    # it, and over HTTP/2 it does not. Anything that puts a plain HTTP/1 server
    # back in front of this silently drops the ceiling to 32.
    max_upload_source_mb: int = 60
    # How long a compressed-but-unconfirmed upload waits for its reader. It is
    # already sitting in the bucket, so this is the window in which "yes" still
    # works, not a queue.
    staged_upload_seconds: int = 900
    max_pages_per_paper: int = 100
    max_papers_per_project: int = 10
    # Bounds the archive: an unbounded done set would grow project_meta, the
    # reorder payload and the account modal without limit.
    max_papers_total_per_project: int = 50

    # Temporary chat images are deliberately much smaller than document uploads:
    # they are carried inline through every provider tool round.
    chat_image_max_per_question: int = 2
    chat_image_max_per_thread: int = 50
    chat_image_max_thread_bytes: int = 32 * 1024 * 1024
    chat_image_max_source_mb: int = 20
    chat_image_max_source_pixels: int = 40_000_000
    chat_image_max_side: int = 512
    chat_image_thumbnail_side: int = 96
    chat_image_retention_days: int = 30

    # Personas. The character cap is the one limit the composer already showed
    # the reader, so it is published rather than duplicated in the client.
    persona_marketplace_enabled: bool = True
    persona_max_characters: int = 30_000
    persona_max_name_characters: int = 40
    persona_max_tagline_characters: int = 140
    persona_browse_page_size: int = 24

    # Papers above this size are recompressed before they are stored. The bulk
    # of a large paper is embedded figures held well above screen resolution,
    # so capping the long side and re-encoding removes detail that was never
    # visible. Text, vectors, and page geometry are untouched.
    compress_over_mb: int = 10
    compress_jpeg_quality: int = 80
    compress_max_image_side: int = 1800

    # Web documents. A page is snapshotted once when it is added and read back
    # section by section through a tool call, so these bound two different
    # things: what one fetch may cost, and what one question may pull.
    web_documents_enabled: bool = True
    # Browsing is a reader capability, not an account preference. Operators can
    # turn it off globally without changing any stored document or user record.
    web_browsing_enabled: bool = True
    web_fetch_timeout_seconds: float = 25.0
    web_max_html_bytes: int = 8 * 1024 * 1024
    # A page copy the reader's frame sends after an annotation, in UTF-8 bytes.
    # The fetch cap, because a copy is that same page with its scripts' work
    # in it; published so the frame can refuse before it serialises the page.
    web_saved_page_max_bytes: int = 8 * 1024 * 1024
    web_max_extract_chars: int = 600_000
    # What one `read_webpage` call may return. The total a turn may read is
    # `document_tool_max_chars`.
    webpage_read_max_chars: int = 24_000
    web_user_agent: str = (
        "Mozilla/5.0 (compatible; DelphiReader/1.0; +https://github.com/delphi)"
    )
    # How long one preview capture may take. A *ceiling*, not a wait: the
    # capture returns the moment its PNG stops changing, so raising this costs
    # a fast host nothing and only buys a slow one the time it needs. It was a
    # hardcoded 10 seconds, which is comfortable on a developer's machine and
    # marginal on one shared vCPU also serving the request that asked for it —
    # so the deployed instance silently produced flat cards for pages that
    # capture in three seconds locally.
    web_thumbnail_capture_seconds: float = 30.0
    # What a capture may take while a reader is waiting on the request that
    # started it — adding a page, or refreshing one. Deliberately shorter than
    # the ceiling above: this attempt is made on an instance already fetching
    # and extracting the same document, so it is the one most likely to be
    # starved, and since opening the document retries immediately, it is also
    # the one that can afford to give up.
    web_thumbnail_inline_seconds: float = 12.0
    # Chromium is the most expensive thing this process starts, and two at once
    # on a 1 vCPU / 1 GiB container is how both of them end up too slow or
    # dead. One at a time, and a capture that cannot get the slot in this long
    # gives up cheaply and is retried on the next Reader open rather than
    # queueing behind work the reader is not waiting for.
    web_thumbnail_queue_seconds: float = 20.0

    # Where proxied pages are served from. This must be an origin the session
    # cookie never reaches, because pages served from it are granted a real
    # origin — which is what embedded players and 3D demos need, and what would
    # otherwise let any page a user adds call /api with their credentials.
    #
    # Locally, `127.0.0.1` and `localhost` are different hosts and so different
    # origins, and a host-only cookie set on one is never sent to the other:
    # one uvicorn serves both. Deployed, the Cloud Run URL is already separate
    # from the Worker the browser talks to.
    #
    # Left empty, pages are served from the API itself without a real origin.
    # Everything still reads; embedded media does not play.
    web_sandbox_origin: str = ""
    web_page_token_seconds: int = 300
    # Bounds for an image the reader navigates the frame to, or sends to Paper
    # Chat. Both are re-encoded, so these cap the decode rather than the fetch.
    web_image_max_bytes: int = 3 * 1024 * 1024
    web_image_max_pixels: int = 40_000_000
    web_image_max_side: int = 2048

    # The raw layer, made searchable. A hit is a pointer — paper, locator,
    # snippet — so these bound what one query returns, not what it may read:
    # the reading tools still enforce their own budgets afterwards.
    library_search_enabled: bool = True
    library_search_max_results: int = 20
    # The account-wide search box, which returns up to this many of each kind
    # rather than this many in total: the three scopes are drawn as three
    # sections, and one prolific scope crowding the others out of a shared
    # ceiling would hide the very thing a reader switched scope to find.
    workspace_search_max_results: int = 20
    library_tool_max_results: int = 8
    library_tool_snippet_chars: int = 320

    openai_api_base_url: str = "https://api.openai.com/v1"
    openai_api_key: str = ""
    model_default: str = ""
    model_choices: str = "gpt-6-luna,gpt-6.1-sol"
    # Composer default when the client omits reasoning_effort. Published through
    # /api/config so the pill does not carry its own hardcoded fallback.
    #
    # `high` rather than `xhigh`, and this is the highest-frequency model call
    # in the product — every reader question, on every turn — so it is the
    # largest steady-state line item and the least visible one, spread across
    # turns rather than concentrated in a run anybody watches. The same trade
    # `memory_review_reasoning_effort` makes just below, for the same reason: at
    # `xhigh` the thinking also shares `model_max_output_tokens` with the
    # visible answer. A reader who wants more still picks it in the composer.
    reasoning_effort_default: str = ""
    model_max_output_tokens: int = 0
    # Whether the provider has hosted web search. Chat offers it on every turn
    # and the model decides when to use it (`ModelTask.web`), so this is not a
    # per-request choice: it is off only for a provider that has no such tool.
    web_search_enabled: bool = True
    openai_prompt_cache_enabled: bool = True
    # Whether the provider offers a Files API. Off, every PDF is sent inline on
    # each request and stored provider file ids are neither used nor replaced, so
    # an installation that alternates providers keeps its ids valid for the one
    # that minted them (see `provider_files`).
    openai_files_enabled: bool = True
    openai_service_tier: str = "flex"
    openai_request_timeout_seconds: float = 900.0
    # One model orchestrates every derived artifact — digests today, Memory
    # ingest and lint next. Named once so changing it is a single env var rather
    # than a search across four settings that have to stay in step.
    orchestrator_model: str = "gpt-6-luna"
    orchestrator_reasoning_effort: str = "xhigh"
    orchestrator_timeout_seconds: float = 900.0
    conversation_title_model: str = ""
    conversation_title_reasoning_effort: str = ""
    conversation_title_timeout_seconds: float = 0.0
    conversation_title_recent_input_tokens: int = 2_000
    conversation_title_answer_input_tokens: int = 700
    conversation_title_max_output_tokens: int = 0
    # The call that chooses Memory pages for a Project question
    # (`memory_harness.memory_selection_request`). The reader waits on it, so
    # it gets its own short timeout: late is worth less than absent.
    memory_select_model: str = ""
    memory_select_reasoning_effort: str = ""
    memory_select_max_output_tokens: int = 0
    memory_select_timeout_seconds: float = 20.0
    # Whether a re-added document is one whose page was kept
    # (`memory_same_document`); bounded by the select timeout. Filled from `model_tasks`.
    memory_same_document_model: str = ""
    memory_same_document_reasoning_effort: str = ""
    memory_same_document_max_output_tokens: int = 0

    # The maintenance pipeline (`memory_maintenance`), which writes Memory in
    # the background: the cheap call over the index, the agent that edits
    # pages, the checker, and the domain composer. Filled from `model_tasks`.
    memory_file_select_model: str = ""
    memory_file_select_reasoning_effort: str = ""
    memory_file_select_max_output_tokens: int = 0
    memory_maintain_model: str = ""
    memory_maintain_reasoning_effort: str = ""
    memory_maintain_max_output_tokens: int = 0
    memory_verify_model: str = ""
    memory_verify_reasoning_effort: str = ""
    memory_verify_max_output_tokens: int = 0
    memory_domain_model: str = ""
    memory_domain_reasoning_effort: str = ""
    memory_domain_max_output_tokens: int = 0
    # One deadline for a whole job, owned by the pipeline: each stage is given
    # the time that is left, and at the deadline the job fails and is retried.
    memory_job_deadline_seconds: float = 900.0
    # How long a session's job waits after the last turn or note change when
    # nothing reports that the reader left, and how long a domain's job waits
    # for its domain to stop changing. The journey rig sets both to zero.
    memory_session_idle_seconds: float = 1_800.0
    memory_domain_settle_seconds: float = 600.0
    # Whether maintenance may gather and cite sources from the web. Off: no
    # research call is made and an `external` citation is refused on a concept
    # or domain page. On: a job may look outside (`gather_outside.py`).
    memory_web_evidence: bool = False
    # Evaluation only (`memory_rebuild --web-frozen`): a directory where each
    # research pass of maintenance is kept, captures and all, the first time it
    # runs, and replayed after without a call or a fetch. Empty in the product.
    memory_web_frozen_dir: str = ""

    # Stored research digests are code-owned derived artifacts. Project SKILLS.md
    # never enters this request, or changing response style would silently change
    # the evidence index shared by every later project question.
    #
    # The model still follows the orchestrator unless explicitly pinned. The
    # effort does not: digest authoring is a single high-effort call (plus at
    # most one validation retry), with a bounded output sized for the compact
    # evidence index below.
    digest_model: str = ""
    digest_reasoning_effort: str = ""
    digest_max_output_tokens: int = 0
    # The research pass that runs before a digest is written (`harness.research`).
    #: Look outside a document before writing its digest (`harness.research`).
    #: Off, every digest is written from the document alone, as before.
    digest_research_enabled: bool = True
    #: How long a capture nothing cites yet is left alone before it is reaped.
    external_evidence_reap_grace_seconds: int = 600
    research_model: str = ""
    research_reasoning_effort: str = ""
    research_max_output_tokens: int = 0
    digest_timeout_seconds: float = 0.0
    digest_claim_seconds: int = 900
    # The whole digest block of one request, not one digest. It rides on every
    # turn of document chat, beside the open document, so it is a ceiling on
    # the project's share of the prefix.
    #
    # The ceiling is kept where a digest is *written*, not where it is read:
    # `digest_document_max_tokens` is one document's share of it, the author is
    # told that number and a digest well over it is refused and rewritten.
    # A long document's share is larger, by its bounded length factor
    # (`research_digest.DigestBudget`), and the block grows by what it adds.
    # `compact_digest_cards` still shortens the digest furthest over its own
    # share when a block runs over — ten at the top of what is accepted — but
    # that is the exception it was always meant to be.
    digest_context_max_tokens: int = 30_000

    # Memory: an account-scoped wiki the model maintains.
    #
    # Two kinds of bound, and the distinction matters. `memory_max_pages` and
    # `memory_page_max_chars` bound what is *stored*; the rest bound what
    # reaches one model request. Only the second kind can make a question
    # expensive, which is why the injected block has its own budget rather than
    # inheriting from the page count.
    memory_enabled: bool = True
    memory_review_model: str = ""
    # Lint, re-filing proposals and domain composition (`memory.review`).
    # `xhigh` squeezes the shared reasoning-plus-output budget: one measured
    # call spent 269 seconds and came back as JSON truncated at 54,639
    # characters. MEMORY_REVIEW_REASONING_EFFORT overrides the table.
    memory_review_reasoning_effort: str = ""
    # Bounds every Memory maintenance call, the drain's included, not only review.
    memory_review_timeout_seconds: float = 0.0
    # Same coupling as `digest_max_output_tokens`: reasoning shares this
    # ceiling with the answer. Too low and the response contains only
    # reasoning, with no output block at all, which reads as the provider
    # having returned nothing and not as a budget that was too small.
    memory_review_max_output_tokens: int = 0
    # The graph and listings are designed and benchmarked for this account-wide
    # ceiling.  Prompt cost remains governed by `memory_index_max_chars`;
    # raising the stored-page ceiling must never raise model context cost.
    memory_max_pages: int = 1_000
    # How many claims one maintenance job gets before it stops being work.
    #
    # `attempts` counts *claims*, not failures, so it also counts the drains
    # nobody stayed for: a reader who navigates away mid-pass leaves the job
    # leased, the lease expires, and the next mount claims it again. Without a
    # ceiling that is a job which is retried forever, and — under the strict
    # `createdAt` order the claim used to run — one that every job behind it
    # waits on. At the cap it is failed with that reason on the record, so it
    # is inspectable and retryable from Settings rather than silently stuck.
    # Three, not six. Six was sized as "a generous ceiling on a cheap retry",
    # and a filing is neither: an abandoned claim is minutes of model calls
    # thrown away, and six of them for one document is most of the cost of
    # filing six. It is also now the *same* number the drain's own retry
    # schedule works to, which it was not — the route hardcoded three while
    # this said six, so a job that reported its failures gave up at three and
    # one that was merely abandoned went on being reclaimed until six.
    # How many jobs one drain runs at once. Three, matching the browser's own
    # drain, because that number is already load-bearing in the product and two
    # different answers to "how parallel is a drain" is a difference nobody
    # would think to look for. A filing is ~65s of waiting on a model call and
    # almost no local work, so lanes buy wall clock rather than CPU: what they
    # cost is concurrent provider requests, which is why there is a ceiling at
    # all.
    memory_drain_workers: int = 3
    memory_job_max_attempts: int = 3
    # How often a live worker pushes its lease fence forward. Two renewals fit
    # inside one lease, so a single missed beat -- a slow query, a paused
    # event loop -- does not drop a claim that is still being worked.
    memory_job_lease_renew_seconds: float = 60.0
    # How long a claim is held **without a renewal**, which is a fence and no
    # longer a budget for the work. It was the budget once — sized to outlast a
    # whole filing, 3,900 seconds — and a dead drain then held a reader's
    # document for sixty-five minutes with nothing running and no way to release
    # it, because `retry_memory_job` refuses anything not already failed.
    #
    # A live worker calls `renew_memory_job_lease` on a timer instead, so the
    # lease only has to outlive the gap between renewals, and a worker that dies
    # frees the row within one lease. That also unpicks the old coupling to the
    # Cloud Run request timeout: a severed request stops renewing, which is the
    # signal the queue actually needed.
    #
    # Below is the reasoning that made the old number necessary, kept because it
    # is why the coupling existed at all and what breaks if the renewal is ever
    # removed:
    # documents: the request is severed at the wall with no exception, so
    # `complete_memory_job` never runs, no `error` frame is sent, and the
    # pass is restarted from nothing. One observed filing had its plan, render
    # and verification all accepted and was cut four seconds later. A lease
    # shorter than the request would add a second worker to that; a lease
    # longer than the request is what lets the survivor finish alone.
    # `test_deployment.py` fails if the two drift apart.
    memory_job_lease_seconds: float = 240.0
    memory_page_max_chars: int = 12_000
    memory_summary_max_chars: int = 400
    # The page view renders only the local graph a reader can act on. Keep the
    # traversal depth in one server-published setting so every client agrees on
    # what "related" means without growing the chat prompt or adding a second
    # graph endpoint.
    memory_related_hops: int = Field(default=2, ge=0, le=4)
    memory_tool_max_calls: int = 6
    # The account-wide chat has no document to answer from, so looking things up
    # *is* its work: one batched turn of a grep, a walk and two reads is already
    # four calls. The reader scope keeps the tighter budget above.
    memory_general_tool_max_calls: int = 12
    # The Memory chat reads the whole index and chooses for itself. The index's
    # ceiling is where summaries start to shorten (no page is ever dropped);
    # about 30,000 tokens, cached across questions. One `open_memory` call
    # returns up to eight chosen pages within the second number.
    memory_index_max_chars: int = 120_000
    memory_open_max_chars: int = 60_000
    # What the pages chosen for a Project question may take in its request.
    memory_inline_max_chars: int = 48_000
    # Figures are the one thing here that costs image tokens, so they are capped
    # separately and far lower: a page may hold several, a single answer may
    # look at two.
    memory_figure_max_per_page: int = 6
    memory_figure_max_side: int = 1024
    memory_figure_max_views: int = 2
    # Published so the rewrite note's counter and the schema that refuses it
    # cannot disagree (invariant 17). The schema owns the number.
    memory_rewrite_note_max_words: int = REWRITE_NOTE_MAX_WORDS
    # What one turn may spend (`harness.budget.TurnBudget`). `store: False`
    # makes the growing request the model's only memory, so each of these is a
    # bound on how large that request, and how long that turn, can get. The
    # last four are proposed values, to be confirmed by the chat benchmark.
    #
    # Rounds that may call a tool; one more follows in which none may.
    model_tool_max_rounds: int = 6
    # Hosted web calls across the whole turn: a search, a page opened and a
    # find within a page are one each.
    web_search_max_calls: int = 8
    # Output tokens across the whole turn, reasoning included. Reaching it
    # makes the next round the closing one.
    turn_max_output_tokens: int = 96_000
    # Wall time for the whole turn. Past it the answer is stored as cut off.
    turn_deadline_seconds: float = 900
    document_tool_max_calls: int = 12
    # A product supplies the trusted validation host built from its own UI.
    # Empty disables authoring; generated code is never accepted unchecked.
    artifact_renderer_path: str = ""
    artifact_max_artifacts: int = Field(default=2, ge=1, le=2)
    artifact_max_attempts: int = Field(default=3, ge=1, le=3)
    artifact_render_timeout_seconds: float = Field(default=45, ge=5, le=45)
    artifact_render_memory_mb: int = Field(default=768, ge=256, le=768)
    paper_tool_max_pages: int = 4
    paper_tool_max_chars: int = 12_000
    document_tool_max_chars: int = 96_000
    # The verified compact-input experiment is intentionally dark by default.
    # Until a bundle passes the image/equation/table gates, paper chat continues
    # to use the provider's complete low-detail PDF input.
    paper_chat_compact_input_enabled: bool = False
    @model_validator(mode="after")
    def model_tasks_fill_every_unset_setting(self) -> "Settings":
        """Fill each per-task model setting from `MODEL_TASKS`.

        The table is the single statement of what every model call is for, and
        these fields stay the thing call sites read — so a value is looked up
        once, here, and forty call sites keep working unchanged. Empty (or
        zero) means "unset", not "empty string": no caller ever sees a blank
        model name when constructing a provider request.

        `ORCHESTRATOR_MODEL` keeps its documented job of moving every unpinned
        task at once, and it has to be checked with `model_fields_set` rather
        than against a default — the table now holds the defaults, so "did the
        operator ask for this" is no longer answerable by comparison.
        """
        orchestrator_pinned = "orchestrator_model" in self.model_fields_set
        for task in MODEL_TASKS:
            if task.model_setting and not getattr(self, task.model_setting):
                setattr(
                    self,
                    task.model_setting,
                    self.orchestrator_model if orchestrator_pinned else task.model,
                )
            if task.effort_setting and not getattr(self, task.effort_setting):
                setattr(self, task.effort_setting, task.effort)
            if task.tokens_setting and not getattr(self, task.tokens_setting):
                setattr(self, task.tokens_setting, task.max_output_tokens)

        # Timeouts are not per-task interesting — every derived artifact wants
        # the same generous ceiling, and the one that differs would be a
        # deliberate act rather than a table row.
        if not self.digest_timeout_seconds:
            self.digest_timeout_seconds = self.orchestrator_timeout_seconds
        if not self.memory_review_timeout_seconds:
            self.memory_review_timeout_seconds = self.orchestrator_timeout_seconds
        if not self.conversation_title_timeout_seconds:
            self.conversation_title_timeout_seconds = self.orchestrator_timeout_seconds
        return self

    @model_validator(mode="after")
    def every_model_offers_the_effort_it_is_asked_for(self) -> "Settings":
        """An effort has to be real, *and* the model has to offer it.

        The second half is what was missing. `MODEL_REASONING_EFFORTS` existed
        only to build the composer's dropdown, so a per-task override could ask
        `gpt-6-sol` for `xhigh` — a rung it is not offered — and be accepted
        here, then refused by the provider mid-filing on every document.
        """
        for task in MODEL_TASKS:
            if not task.effort_setting:
                continue
            effort = getattr(self, task.effort_setting)
            if effort not in REASONING_EFFORTS:
                raise ValueError(
                    f"{task.effort_setting.upper()}={effort!r} must be one of "
                    f"{list(REASONING_EFFORTS)}"
                )
            model = getattr(self, task.model_setting) if task.model_setting else ""
            offered = MODEL_REASONING_EFFORTS.get(model)
            if offered is not None and effort not in offered:
                raise ValueError(
                    f"{task.key}: {model!r} does not offer {effort!r} — "
                    f"pick one of {list(offered)}"
                )
        return self

    @model_validator(mode="after")
    def sandbox_origin_is_not_the_app(self) -> "Settings":
        """
        Refuse to start if the sandbox origin is one the app is served from.

        This is the single value that carries the whole web-document security
        story. Pages served from it are granted a real origin; if that origin is
        also the app's, a proxied page can call /api with the reader's cookie
        attached and read their entire library. `HttpOnly` does not help — it
        stops the page reading the cookie, not the browser sending it.

        The realistic way this happens is someone pointing it at the app to make
        a CORS or frame-ancestors error go away, at which point everything looks
        like it works. Fail loudly instead.
        """
        if not self.web_sandbox_origin:
            return self
        sandbox = self.web_sandbox_origin.rstrip("/").lower()
        if sandbox in {origin.rstrip("/").lower() for origin in self.origins}:
            raise ValueError(
                f"WEB_SANDBOX_ORIGIN ({self.web_sandbox_origin}) is also a "
                "frontend origin. Proxied pages are granted a real origin there, "
                "so this would let any page a reader adds call /api as them. Use "
                "a host the session cookie never reaches."
            )
        return self

    @property
    def required_signup_code(self) -> str:
        """The code registration asks for, stripped as a pasted one is; empty when signup is open."""
        return self.signup_code.strip()

    @property
    def digest_document_max_tokens(self) -> int:
        """A standard document's share of the digest block; a long one's is scaled (`DigestBudget`)."""
        return self.digest_context_max_tokens // max(1, self.max_papers_per_project)

    @property
    def origins(self) -> list[str]:
        return [item.strip() for item in self.frontend_origins.split(",") if item.strip()]

    @property
    def models(self) -> list[str]:
        choices = [item.strip() for item in self.model_choices.split(",") if item.strip()]
        if self.model_default not in choices:
            choices.insert(0, self.model_default)
        return choices

    @property
    def reasoning_efforts(self) -> list[str]:
        return list(REASONING_EFFORTS)

    def reasoning_efforts_for(self, model: str) -> list[str]:
        """Return the reasoning ladder supported by one offered model."""
        return list(MODEL_REASONING_EFFORTS.get(model, REASONING_EFFORTS))

    @property
    def model_reasoning_efforts(self) -> dict[str, list[str]]:
        return {model: self.reasoning_efforts_for(model) for model in self.models}

    @property
    def api_key(self) -> str:
        return self.openai_api_key

    @property
    def api_base_url(self) -> str:
        return self.openai_api_base_url


#: A product's subclass of `Settings`, which adds keys and never changes a core one.
S = TypeVar("S", bound=Settings)


def load_settings(cls: type[S] = Settings) -> S:
    """A product's settings, read once from the environment and its env file.

    One instance per class, so the app, Alembic and a backfill that ask for the
    same class agree. Only process entry points call this; a route reads the
    settings its app was created with (`get_settings`).
    """
    return _loaded(cls)


@lru_cache
def _loaded(cls: type[S]) -> S:
    settings = cls()
    if not settings.data_dir.is_absolute():
        repository_root = Path(__file__).resolve().parents[2]
        settings.data_dir = (repository_root / settings.data_dir).resolve()
    else:
        settings.data_dir = settings.data_dir.resolve()
    return settings


def get_settings(request: Request) -> Settings:
    """The settings the request's app was created with (`create_app`).

    The dependency every route and test override is keyed on. It never falls
    back to the environment: an app built with `Settings(data_dir=…)` that
    quietly read `DATA_DIR` instead would open another library.
    """
    return request.app.state.settings
