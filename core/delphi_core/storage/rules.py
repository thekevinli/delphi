"""The rules every store applies identically, for a store that lives outside core.

A store implements `Storage` and `ObjectStore` (`delphi_core.storage`), and
whatever it must decide the way the local store decides comes from here: the
Memory version it stamps, the job kinds and which are held, the onboarding
states, the cursor encoding, the page-version and history format, route-slug
allocation, the conversation selectors and limits, which jobs a session's or a
domain's change queues, and the search, retrieval and persona rules both stores
rank and answer by.

Re-exports only. Each name is defined where core uses it, and a store imports
it from here, so a store outside core names `delphi_core.storage` and this
module and nothing else of core's. A rule a store needs that is not here is
added here; it is never imported from the module that defines it.
"""
from ..document_index import build_snippet, locator_label, query_terms, tsquery_term
from ..memory_maintenance.jobs import capture_marker, document_marker
from ..memory_retrieval import lexical_score, retrieval_terms
from ..personas import official_detail, official_persona
from ..workspace_search import (
    COLLAPSE_FANOUT,
    TITLE_WEIGHT,
    collapsed_score,
    collective_terms,
    conversation_row,
    document_row,
    memory_row,
    message_text,
    tsquery_all,
)
from .base import (
    CAPTURE_JOB_KINDS,
    CONVERSATION_TITLE_MAX_CHARS,
    DOCUMENT_JOB_KINDS,
    HELD_JOB_KINDS,
    LINK_REPAIR_NOTE,
    MEMORY_JOB_KINDS,
    MEMORY_VERSION,
    ONBOARDING_COMPLETE,
    ONBOARDING_RUNNING,
    PAPER_TITLE_MAX_CHARS,
    VERSIONED_KINDS,
    VERSIONS_KEPT,
    abandoned_job_error,
    allocate_route_slug,
    check_expected_revision,
    check_page_shape,
    check_version_trigger,
    clean_aliases,
    decode_cursor,
    default_domain_record,
    domain_job_marker,
    empty_plan_state,
    encode_cursor,
    evidence_holders,
    external_evidence_record,
    fit_conversation_title,
    initial_title,
    job_fingerprint_moved,
    waits_for_capture,
    last_user_turn_index,
    onboarding_tally,
    page_history_entry,
    page_version,
    plan_route_slug_repairs,
    unlink_deleted_page,
    valid_route_slug,
)
from .conversations import KINDS, LIMIT, check_append, require_selector, selector, summary, validate_scope
from .domains import domain_job, domains_owed
from .sessions import note_holders, session_job, turn_to_file

__all__ = [
    # storage.base: the shared constants
    "CAPTURE_JOB_KINDS",
    "CONVERSATION_TITLE_MAX_CHARS",
    "DOCUMENT_JOB_KINDS",
    "HELD_JOB_KINDS",
    "LINK_REPAIR_NOTE",
    "MEMORY_JOB_KINDS",
    "MEMORY_VERSION",
    "ONBOARDING_COMPLETE",
    "ONBOARDING_RUNNING",
    "PAPER_TITLE_MAX_CHARS",
    "VERSIONED_KINDS",
    "VERSIONS_KEPT",
    # storage.base: the shared checks and records
    "abandoned_job_error",
    "allocate_route_slug",
    "check_expected_revision",
    "check_page_shape",
    "check_version_trigger",
    "clean_aliases",
    "decode_cursor",
    "default_domain_record",
    "domain_job_marker",
    "empty_plan_state",
    "encode_cursor",
    "evidence_holders",
    "external_evidence_record",
    "fit_conversation_title",
    "initial_title",
    "job_fingerprint_moved",
    "last_user_turn_index",
    "onboarding_tally",
    "page_history_entry",
    "page_version",
    "plan_route_slug_repairs",
    "unlink_deleted_page",
    "valid_route_slug",
    "waits_for_capture",
    # storage.conversations
    "KINDS",
    "LIMIT",
    "check_append",
    "require_selector",
    "selector",
    "summary",
    "validate_scope",
    # storage.domains and storage.sessions
    "domain_job",
    "domains_owed",
    "note_holders",
    "session_job",
    "turn_to_file",
    # document_index
    "build_snippet",
    "locator_label",
    "query_terms",
    "tsquery_term",
    # memory_retrieval
    "lexical_score",
    "retrieval_terms",
    # workspace_search
    "COLLAPSE_FANOUT",
    "TITLE_WEIGHT",
    "collapsed_score",
    "collective_terms",
    "conversation_row",
    "document_row",
    "memory_row",
    "message_text",
    "tsquery_all",
    # personas
    "official_detail",
    "official_persona",
    # memory_maintenance.jobs
    "capture_marker",
    "document_marker",
]
