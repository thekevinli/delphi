"""
A store outside core reaches core through two modules: `storage` and `storage.rules`.

Core holds one store, the local one. A product's store (records in a database,
bytes in a bucket) lives in the product, and takes from core the interface and
its types (`delphi_core.storage`) and whatever it must decide as the local
store decides (`delphi_core.storage.rules`). Nothing in core imports that store,
so nothing here would notice a rule it needs going missing: the names it takes
are pinned below. Dropping one breaks a store core cannot see; adding one is a
change to core's surface, made on purpose. `rules` defines nothing of its own.
"""
import ast
from pathlib import Path

import delphi_core.storage as storage
import delphi_core.storage.rules as rules

#: Every name a store outside core takes from `storage.rules`: the SQL store's,
#: when it moved out of core, by its import statements.
RULES = {
    "COLLAPSE_FANOUT", "CONVERSATION_TITLE_MAX_CHARS", "DOCUMENT_JOB_KINDS", "HELD_JOB_KINDS", "KINDS", "LIMIT",
    "LINK_REPAIR_NOTE",
    "MEMORY_JOB_KINDS", "MEMORY_VERSION", "ONBOARDING_COMPLETE", "ONBOARDING_RUNNING", "PAPER_TITLE_MAX_CHARS",
    "TITLE_WEIGHT", "VERSIONED_KINDS", "VERSIONS_KEPT", "abandoned_job_error", "allocate_route_slug",
    "build_snippet", "check_append", "check_expected_revision", "check_page_shape", "check_version_trigger",
    "clean_aliases", "collapsed_score", "collective_terms", "conversation_row", "decode_cursor",
    "default_domain_record", "document_marker", "document_row", "domain_job", "domain_job_marker", "domains_owed",
    "empty_plan_state", "encode_cursor", "evidence_holders", "external_evidence_record", "fit_conversation_title",
    "initial_title",
    "job_fingerprint_moved", "last_user_turn_index", "lexical_score", "locator_label", "memory_row",
    "message_text", "note_holders", "official_detail", "official_persona", "onboarding_tally",
    "page_history_entry", "page_version", "plan_route_slug_repairs", "query_terms", "require_selector",
    "retrieval_terms", "selector", "session_job", "summary", "tsquery_all", "tsquery_term", "turn_to_file",
    "unlink_deleted_page", "valid_route_slug", "validate_scope",
    # The capture queue: the kind no Memory claim takes, its marker, and the
    # rule that holds a document's filing until its page is read whole.
    "CAPTURE_JOB_KINDS", "capture_marker", "waits_for_capture",
}
#: And what it takes from `storage` itself, the interface and its types.
INTERFACE = {
    "MemoryJobGone", "ObjectStore", "Removed", "Storage", "external_evidence_key", "job_payload_is_upgradeable",
    "memory_slug", "parse_wiki_links", "rehome_chat_image_key", "safe_id", "utc_now",
}


def test_a_store_outside_core_finds_every_rule_and_type_it_takes_where_it_takes_it():
    assert set(rules.__all__) == RULES, (
        f"exported, never taken: {sorted(set(rules.__all__) - RULES)}; "
        f"taken, no longer exported: {sorted(RULES - set(rules.__all__))}"
    )
    assert INTERFACE <= set(storage.__all__), sorted(INTERFACE - set(storage.__all__))
    for name in (*RULES, *INTERFACE):
        assert hasattr(rules if name in RULES else storage, name), name


def test_the_rules_are_re_exports_and_repeat_nothing_storage_exports():
    assert len(rules.__all__) == len(set(rules.__all__))
    assert not set(rules.__all__) & set(storage.__all__)
    tree = ast.parse(Path(rules.__file__).read_text())
    statements = [type(node).__name__ for node in tree.body[1:]]
    assert set(statements) == {"ImportFrom", "Assign"} and statements.count("Assign") == 1
    imported = {alias.asname or alias.name for node in tree.body if isinstance(node, ast.ImportFrom) for alias in node.names}
    assert imported == set(rules.__all__)
