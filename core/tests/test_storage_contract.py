"""
The same behaviour, asserted against every Storage implementation.

The contract is the kit's (`delphi_core_testkit.conformance.storage_contract`):
a product runs it over its own stores, so a store that diverges from the local
one — key casing, ordering, 404-vs-403, what a missing record returns — fails
there rather than in production. Here it runs over the local store
(`conftest.store_harness`), and what stays here is about the local store alone.
"""

import json
import threading

import pytest

from delphi_core.config import Settings
from delphi_core.storage import LocalStorage
from delphi_core_testkit.conformance.storage_contract import (
    storage,
    test_memory_search_ranking_is_shared_unicode_and_account_scoped,
    test_page_bodies_are_read_together_and_only_the_owners,
    test_account_round_trip,
    test_password_update_replaces_only_the_credentials,
    test_account_service_tier_preference_defaults_to_standard_and_round_trips,
    test_project_list_is_newest_first_and_counts_papers,
    test_bulk_project_read_matches_get_project_for_every_project,
    test_another_users_project_is_absent_not_forbidden,
    test_papers_keep_insertion_order_then_follow_an_explicit_reorder,
    test_moving_a_paper_takes_its_digest_highlights_and_chat_with_it,
    test_a_moved_paper_lands_where_the_drag_said_it_would,
    test_a_moved_paper_takes_a_free_slug_in_its_new_project,
    test_a_paper_cannot_be_moved_into_a_project_that_is_not_yours,
    test_paper_record_shape_matches_across_backends,
    test_a_web_document_round_trips_its_kind_and_address,
    test_a_papers_derived_fields_carry_their_versions_in_both_backends,
    test_marking_a_paper_done_round_trips_and_clears,
    test_a_done_paper_survives_a_move_with_its_flag,
    test_a_pdf_record_gains_no_web_fields,
    test_reader_slugs_are_scoped_allocated_and_resolved,
    test_renames_retire_routes_and_freed_slugs_are_reused,
    test_a_document_takes_its_printed_title_only_while_it_is_still_named_after_its_file,
    test_openai_file_id_is_written_once_and_never_overwritten,
    test_a_conversation_keeps_a_title_of_the_full_length_in_both_backends,
    test_a_conversation_is_titled_once_per_engagement_in_both_backends,
    test_a_claim_the_stream_never_spent_is_handed_back_in_both_backends,
    test_chat_images_have_stable_thread_scoped_numbers_and_append_only_references,
    test_the_account_wide_chat_holds_images_of_its_own,
    test_digest_claims_are_owned_expiring_and_retain_a_valid_card,
    test_a_claim_survives_concurrent_writes_to_a_sibling_paper,
    test_a_new_project_carries_no_guidance_of_its_own,
    test_editing_a_persona_reaches_every_conversation_using_it,
    test_a_persona_read_never_carries_where_it_is_used,
    test_a_stale_revision_is_refused_rather_than_overwriting,
    test_a_persona_a_conversation_uses_can_still_be_deleted,
    test_a_private_persona_is_absent_to_everyone_else,
    test_publishing_makes_a_persona_browsable_and_unpublishing_hides_it,
    test_installing_a_persona_forks_it_so_later_edits_do_not_reach_the_installer,
    test_installing_twice_returns_the_same_copy,
    test_browse_pages_forward_without_repeating_a_row,
    test_chat_appends_do_not_overwrite_each_other,
    test_a_conversation_remembers_the_persona_it_is_held_in,
    test_choosing_a_persona_does_not_put_a_conversation_in_the_recent_list,
    test_dropping_the_last_user_turn_is_a_tail_delete_not_a_rewrite,
    test_an_answer_holds_the_documents_session_job_and_retracting_it_leaves_the_queue_alone,
    test_highlights_round_trip_both_variants,
    test_notes_round_trip,
    test_an_anchor_holds_one_note_so_writing_again_is_an_edit,
    test_removing_a_stroke_removes_its_note_but_not_the_other_way_round,
    test_a_note_is_unfiled_until_a_pass_reads_it_and_unfiled_again_when_edited,
    test_every_change_to_a_note_holds_the_one_session_job_of_its_document,
    test_storing_a_linked_pdf_keeps_the_paper_and_stops_serving_its_address,
    test_deleting_a_project_reports_provider_files_and_removes_everything,
    test_coverage_beats_repetition_however_often_one_term_is_said,
    test_library_search_reaches_across_projects_and_ranks_the_better_page_first,
    test_a_strangers_documents_never_appear_in_a_search,
    test_extracted_html_title_can_be_stored_and_found,
    test_reindexing_replaces_rather_than_accumulates,
    test_indexing_source_controls_preserves_objects_and_restores_search,
    test_deleting_a_paper_removes_its_sections,
    test_moving_a_paper_carries_its_sections_to_the_new_project,
    test_an_empty_query_returns_nothing_rather_than_the_whole_library,
    test_the_search_box_reaches_pages_documents_and_chats_alike,
    test_a_query_is_one_phrase_and_not_a_bag_of_words,
    test_a_document_appears_once_however_often_it_says_the_word,
    test_a_conversation_is_quoted_at_the_turn_that_first_said_it,
    test_the_search_box_is_scoped_to_its_account,
    test_an_empty_query_searches_nothing_rather_than_everything,
    test_each_scope_is_bounded_by_the_limit_it_was_given,
    test_every_account_is_listed_for_maintenance,
    test_a_memory_page_round_trips_and_rebuilds_its_links,
    test_graph_revision_changes_only_with_graph_state,
    test_memory_snapshot_replacement_is_complete_and_atomic,
    test_invalid_snapshot_does_not_replace_the_active_graph,
    test_a_listing_never_carries_a_page_body,
    test_a_dangling_link_stays_on_the_edge_list,
    test_a_page_belongs_to_an_account_not_a_project,
    test_the_page_count_is_bounded,
    test_domains_are_counted_and_scoped_per_project,
    test_writing_a_page_creates_the_domain_it_claims,
    test_a_domain_the_reader_named_keeps_its_title_and_is_never_downgraded,
    test_an_empty_domain_is_still_listed,
    test_domains_sort_by_reader_order_then_by_how_full_they_are,
    test_a_domain_holding_pages_refuses_to_be_deleted,
    test_moving_pages_refiles_them_in_one_write,
    test_moving_a_page_that_does_not_exist_moves_nothing,
    test_figures_are_page_scoped_owner_only_and_bounded,
    test_a_figure_that_could_not_be_captured_is_kept_as_a_link,
    test_figures_list_by_page,
    test_memory_events_and_messages_are_appended_not_rewritten,
    test_an_ingest_marker_is_still_found_under_a_pile_of_newer_entries,
    test_a_page_s_events_are_every_one_naming_it_oldest_first_past_any_window,
    test_a_marker_reports_the_pass_that_filed_it_most_recently,
    test_many_markers_are_answered_in_one_read_and_absence_means_unfiled,
    test_cancelling_removes_future_spend_and_leaves_everything_else,
    test_a_queued_job_learns_the_version_it_is_being_filed_for,
    test_the_newest_event_of_one_kind_is_found_under_a_pile_of_others,
    test_memory_jobs_are_account_scoped_deduplicated_and_leased,
    test_a_job_nobody_stayed_for_falls_behind_the_work_that_has_had_no_turn,
    test_document_jobs_run_before_any_other_kind,
    test_a_job_at_its_attempt_ceiling_leaves_the_queue_rather_than_blocking_it,
    test_every_domain_change_queues_the_domain_rewrite_it_makes_necessary,
    test_a_domain_is_owed_its_page_for_membership_a_summary_or_its_name_and_for_nothing_else,
    test_a_domains_job_waits_for_the_domain_to_settle_and_a_release_claims_it_at_once,
    test_a_refused_domain_delete_keeps_the_work_queued_against_it,
    test_a_move_that_names_a_missing_page_moves_nothing,
    test_import_queues_one_document_job_done_queues_nothing_and_an_answer_holds_its_session,
    test_thread_and_project_deletion_remove_only_the_work_they_destroy,
    test_a_cut_off_answer_is_stored_and_never_queued_for_filing,
    test_memory_update_publication_rolls_back_all_records_together,
    test_a_lapsed_worker_cannot_touch_its_successors_claim,
    test_a_cancelled_claim_is_handed_back_unspent,
    test_a_filing_supersedes_the_figures_of_the_page_it_rewrites,
    test_one_update_run_per_account_is_recorded_read_back_and_dismissed,
    test_a_live_claim_can_push_its_fence_forward_and_a_stale_one_cannot,
    test_a_pass_with_no_provenance_to_offer_does_not_erase_the_page_s,
    test_replaying_a_library_queues_work_that_one_clear_takes_back,
    test_a_page_of_a_kind_memory_does_not_hold_is_refused,
    test_a_citation_of_a_claim_type_memory_does_not_hold_is_refused,
    test_a_write_names_the_revision_it_read_or_is_last_writer_wins,
    test_stale_filing_cannot_replace_a_newer_body_or_publish_its_marker,
    test_a_target_version_upgrades_a_queued_job_without_replacing_its_provenance,
    test_page_rewrite_publication_retains_figure_rows_and_queues_no_graph_work,
    test_operation_completion_is_owner_and_marker_scoped,
    test_filing_events_with_equal_timestamps_keep_publication_order,
    test_onboarding_records_its_projects_and_a_fresh_account_starts_it,
    test_an_interrupted_attempt_with_nothing_filed_is_removed_and_starts_over,
    test_an_interrupted_attempt_with_one_document_filed_opens_the_dashboard,
    test_with_filing_off_an_uploaded_document_completes_the_attempt,
    test_failed_filing_never_completes_onboarding,
    test_an_account_from_before_onboarding_lands_on_the_dashboard,
    test_a_fenced_commit_publishes_only_while_its_job_is_leased,
    test_cleanup_and_a_running_filing_serialise_on_the_account_lock,
    test_a_reclaimed_filing_refuses_the_old_worker_at_commit,
    test_html_annotations_retry_without_losing_notes,
    test_cached_html_placements_never_rewrite_original_anchors,
    test_section_anchors_name_their_owning_documents_in_one_project,
    test_the_page_copy_and_the_text_are_written_under_one_lock_without_losing_either,
    test_external_evidence_is_owner_only_immutable_and_kept_while_something_cites_it,
    test_aliases_are_stored_cleaned_and_kept_by_a_write_that_does_not_name_them,
    test_a_search_matches_an_alias_and_a_slug_lookup_resolves_one,
    test_every_revision_of_a_concept_or_domain_page_is_kept_with_its_cause,
    test_version_history_keeps_the_newest_twenty_and_goes_with_the_page,
    test_a_refused_commit_leaves_no_version_row_behind,
    test_a_commit_told_to_require_revisions_refuses_a_concept_without_one,
    test_deleting_a_page_turns_every_link_to_it_into_plain_text,
    test_a_pending_job_waits_for_its_time_and_is_claimed_once_released,
    test_a_job_with_no_wait_is_due_at_once_and_a_failed_one_keeps_its_backoff,
    test_an_enqueue_on_a_waiting_marker_pushes_the_wait_and_replaces_the_fingerprint,
    test_a_job_whose_fingerprint_changed_during_the_work_stays_queued,
    test_a_cancelled_claim_goes_back_to_the_wait_an_enqueue_gave_it,
    test_a_document_job_is_claimed_before_a_session_job_queued_earlier,
    test_a_conversation_records_how_far_memory_filing_has_covered_it,
    test_resetting_a_conversation_clears_its_filing_mark,
    test_a_promoted_snapshot_replaces_the_history_with_the_pages,
    test_deleting_a_domain_takes_its_page_history_with_it,
    test_latest_marker_events_gives_the_newest_event_each_job_marker_left,
    test_a_partial_page_queues_its_capture_and_its_filing_waits_for_it,
)


#: What this module runs from the kit, named so pyflakes counts the imports
#: above as used: it cannot see pytest collect them.
__all__ = [
    "storage",
    "test_memory_search_ranking_is_shared_unicode_and_account_scoped",
    "test_page_bodies_are_read_together_and_only_the_owners",
    "test_account_round_trip",
    "test_password_update_replaces_only_the_credentials",
    "test_account_service_tier_preference_defaults_to_standard_and_round_trips",
    "test_project_list_is_newest_first_and_counts_papers",
    "test_bulk_project_read_matches_get_project_for_every_project",
    "test_another_users_project_is_absent_not_forbidden",
    "test_papers_keep_insertion_order_then_follow_an_explicit_reorder",
    "test_moving_a_paper_takes_its_digest_highlights_and_chat_with_it",
    "test_a_moved_paper_lands_where_the_drag_said_it_would",
    "test_a_moved_paper_takes_a_free_slug_in_its_new_project",
    "test_a_paper_cannot_be_moved_into_a_project_that_is_not_yours",
    "test_paper_record_shape_matches_across_backends",
    "test_a_web_document_round_trips_its_kind_and_address",
    "test_a_papers_derived_fields_carry_their_versions_in_both_backends",
    "test_marking_a_paper_done_round_trips_and_clears",
    "test_a_done_paper_survives_a_move_with_its_flag",
    "test_a_pdf_record_gains_no_web_fields",
    "test_reader_slugs_are_scoped_allocated_and_resolved",
    "test_renames_retire_routes_and_freed_slugs_are_reused",
    "test_a_document_takes_its_printed_title_only_while_it_is_still_named_after_its_file",
    "test_openai_file_id_is_written_once_and_never_overwritten",
    "test_a_conversation_keeps_a_title_of_the_full_length_in_both_backends",
    "test_a_conversation_is_titled_once_per_engagement_in_both_backends",
    "test_a_claim_the_stream_never_spent_is_handed_back_in_both_backends",
    "test_chat_images_have_stable_thread_scoped_numbers_and_append_only_references",
    "test_the_account_wide_chat_holds_images_of_its_own",
    "test_digest_claims_are_owned_expiring_and_retain_a_valid_card",
    "test_a_claim_survives_concurrent_writes_to_a_sibling_paper",
    "test_a_new_project_carries_no_guidance_of_its_own",
    "test_editing_a_persona_reaches_every_conversation_using_it",
    "test_a_persona_read_never_carries_where_it_is_used",
    "test_a_stale_revision_is_refused_rather_than_overwriting",
    "test_a_persona_a_conversation_uses_can_still_be_deleted",
    "test_a_private_persona_is_absent_to_everyone_else",
    "test_publishing_makes_a_persona_browsable_and_unpublishing_hides_it",
    "test_installing_a_persona_forks_it_so_later_edits_do_not_reach_the_installer",
    "test_installing_twice_returns_the_same_copy",
    "test_browse_pages_forward_without_repeating_a_row",
    "test_chat_appends_do_not_overwrite_each_other",
    "test_a_conversation_remembers_the_persona_it_is_held_in",
    "test_choosing_a_persona_does_not_put_a_conversation_in_the_recent_list",
    "test_dropping_the_last_user_turn_is_a_tail_delete_not_a_rewrite",
    "test_an_answer_holds_the_documents_session_job_and_retracting_it_leaves_the_queue_alone",
    "test_highlights_round_trip_both_variants",
    "test_notes_round_trip",
    "test_an_anchor_holds_one_note_so_writing_again_is_an_edit",
    "test_removing_a_stroke_removes_its_note_but_not_the_other_way_round",
    "test_a_note_is_unfiled_until_a_pass_reads_it_and_unfiled_again_when_edited",
    "test_every_change_to_a_note_holds_the_one_session_job_of_its_document",
    "test_storing_a_linked_pdf_keeps_the_paper_and_stops_serving_its_address",
    "test_deleting_a_project_reports_provider_files_and_removes_everything",
    "test_coverage_beats_repetition_however_often_one_term_is_said",
    "test_library_search_reaches_across_projects_and_ranks_the_better_page_first",
    "test_a_strangers_documents_never_appear_in_a_search",
    "test_extracted_html_title_can_be_stored_and_found",
    "test_reindexing_replaces_rather_than_accumulates",
    "test_indexing_source_controls_preserves_objects_and_restores_search",
    "test_deleting_a_paper_removes_its_sections",
    "test_moving_a_paper_carries_its_sections_to_the_new_project",
    "test_an_empty_query_returns_nothing_rather_than_the_whole_library",
    "test_the_search_box_reaches_pages_documents_and_chats_alike",
    "test_a_query_is_one_phrase_and_not_a_bag_of_words",
    "test_a_document_appears_once_however_often_it_says_the_word",
    "test_a_conversation_is_quoted_at_the_turn_that_first_said_it",
    "test_the_search_box_is_scoped_to_its_account",
    "test_an_empty_query_searches_nothing_rather_than_everything",
    "test_each_scope_is_bounded_by_the_limit_it_was_given",
    "test_every_account_is_listed_for_maintenance",
    "test_a_memory_page_round_trips_and_rebuilds_its_links",
    "test_graph_revision_changes_only_with_graph_state",
    "test_memory_snapshot_replacement_is_complete_and_atomic",
    "test_invalid_snapshot_does_not_replace_the_active_graph",
    "test_a_listing_never_carries_a_page_body",
    "test_a_dangling_link_stays_on_the_edge_list",
    "test_a_page_belongs_to_an_account_not_a_project",
    "test_the_page_count_is_bounded",
    "test_domains_are_counted_and_scoped_per_project",
    "test_writing_a_page_creates_the_domain_it_claims",
    "test_a_domain_the_reader_named_keeps_its_title_and_is_never_downgraded",
    "test_an_empty_domain_is_still_listed",
    "test_domains_sort_by_reader_order_then_by_how_full_they_are",
    "test_a_domain_holding_pages_refuses_to_be_deleted",
    "test_moving_pages_refiles_them_in_one_write",
    "test_moving_a_page_that_does_not_exist_moves_nothing",
    "test_figures_are_page_scoped_owner_only_and_bounded",
    "test_a_figure_that_could_not_be_captured_is_kept_as_a_link",
    "test_figures_list_by_page",
    "test_memory_events_and_messages_are_appended_not_rewritten",
    "test_an_ingest_marker_is_still_found_under_a_pile_of_newer_entries",
    "test_a_page_s_events_are_every_one_naming_it_oldest_first_past_any_window",
    "test_a_marker_reports_the_pass_that_filed_it_most_recently",
    "test_many_markers_are_answered_in_one_read_and_absence_means_unfiled",
    "test_cancelling_removes_future_spend_and_leaves_everything_else",
    "test_a_queued_job_learns_the_version_it_is_being_filed_for",
    "test_the_newest_event_of_one_kind_is_found_under_a_pile_of_others",
    "test_memory_jobs_are_account_scoped_deduplicated_and_leased",
    "test_a_job_nobody_stayed_for_falls_behind_the_work_that_has_had_no_turn",
    "test_document_jobs_run_before_any_other_kind",
    "test_a_job_at_its_attempt_ceiling_leaves_the_queue_rather_than_blocking_it",
    "test_every_domain_change_queues_the_domain_rewrite_it_makes_necessary",
    "test_a_domain_is_owed_its_page_for_membership_a_summary_or_its_name_and_for_nothing_else",
    "test_a_domains_job_waits_for_the_domain_to_settle_and_a_release_claims_it_at_once",
    "test_a_refused_domain_delete_keeps_the_work_queued_against_it",
    "test_a_move_that_names_a_missing_page_moves_nothing",
    "test_import_queues_one_document_job_done_queues_nothing_and_an_answer_holds_its_session",
    "test_thread_and_project_deletion_remove_only_the_work_they_destroy",
    "test_a_cut_off_answer_is_stored_and_never_queued_for_filing",
    "test_memory_update_publication_rolls_back_all_records_together",
    "test_a_lapsed_worker_cannot_touch_its_successors_claim",
    "test_a_cancelled_claim_is_handed_back_unspent",
    "test_a_filing_supersedes_the_figures_of_the_page_it_rewrites",
    "test_one_update_run_per_account_is_recorded_read_back_and_dismissed",
    "test_a_live_claim_can_push_its_fence_forward_and_a_stale_one_cannot",
    "test_a_pass_with_no_provenance_to_offer_does_not_erase_the_page_s",
    "test_replaying_a_library_queues_work_that_one_clear_takes_back",
    "test_a_page_of_a_kind_memory_does_not_hold_is_refused",
    "test_a_citation_of_a_claim_type_memory_does_not_hold_is_refused",
    "test_a_write_names_the_revision_it_read_or_is_last_writer_wins",
    "test_stale_filing_cannot_replace_a_newer_body_or_publish_its_marker",
    "test_a_target_version_upgrades_a_queued_job_without_replacing_its_provenance",
    "test_page_rewrite_publication_retains_figure_rows_and_queues_no_graph_work",
    "test_operation_completion_is_owner_and_marker_scoped",
    "test_filing_events_with_equal_timestamps_keep_publication_order",
    "test_onboarding_records_its_projects_and_a_fresh_account_starts_it",
    "test_an_interrupted_attempt_with_nothing_filed_is_removed_and_starts_over",
    "test_an_interrupted_attempt_with_one_document_filed_opens_the_dashboard",
    "test_with_filing_off_an_uploaded_document_completes_the_attempt",
    "test_failed_filing_never_completes_onboarding",
    "test_an_account_from_before_onboarding_lands_on_the_dashboard",
    "test_a_fenced_commit_publishes_only_while_its_job_is_leased",
    "test_cleanup_and_a_running_filing_serialise_on_the_account_lock",
    "test_a_reclaimed_filing_refuses_the_old_worker_at_commit",
    "test_html_annotations_retry_without_losing_notes",
    "test_cached_html_placements_never_rewrite_original_anchors",
    "test_section_anchors_name_their_owning_documents_in_one_project",
    "test_the_page_copy_and_the_text_are_written_under_one_lock_without_losing_either",
    "test_external_evidence_is_owner_only_immutable_and_kept_while_something_cites_it",
    "test_aliases_are_stored_cleaned_and_kept_by_a_write_that_does_not_name_them",
    "test_a_search_matches_an_alias_and_a_slug_lookup_resolves_one",
    "test_every_revision_of_a_concept_or_domain_page_is_kept_with_its_cause",
    "test_version_history_keeps_the_newest_twenty_and_goes_with_the_page",
    "test_a_refused_commit_leaves_no_version_row_behind",
    "test_a_commit_told_to_require_revisions_refuses_a_concept_without_one",
    "test_deleting_a_page_turns_every_link_to_it_into_plain_text",
    "test_a_pending_job_waits_for_its_time_and_is_claimed_once_released",
    "test_a_job_with_no_wait_is_due_at_once_and_a_failed_one_keeps_its_backoff",
    "test_an_enqueue_on_a_waiting_marker_pushes_the_wait_and_replaces_the_fingerprint",
    "test_a_job_whose_fingerprint_changed_during_the_work_stays_queued",
    "test_a_cancelled_claim_goes_back_to_the_wait_an_enqueue_gave_it",
    "test_a_document_job_is_claimed_before_a_session_job_queued_earlier",
    "test_a_conversation_records_how_far_memory_filing_has_covered_it",
    "test_resetting_a_conversation_clears_its_filing_mark",
    "test_a_promoted_snapshot_replaces_the_history_with_the_pages",
    "test_deleting_a_domain_takes_its_page_history_with_it",
    "test_latest_marker_events_gives_the_newest_event_each_job_marker_left",
    "test_a_partial_page_queues_its_capture_and_its_filing_waits_for_it",
]


pytestmark = pytest.mark.kb_maintenance


def make_local(tmp_path):
    return LocalStorage(Settings(data_dir=tmp_path))


def test_local_records_lazily_backfill_and_repair_route_metadata(tmp_path):
    storage = make_local(tmp_path)
    storage.create_account("reader", None, "salt", "hash")
    first = storage.create_project("reader", "Duplicate")
    second = storage.create_project("reader", "Duplicate")
    storage.add_paper(
        "reader",
        first["id"],
        {"id": "a", "title": "Same", "filename": "a.pdf"},
    )
    storage.add_paper(
        "reader",
        first["id"],
        {"id": "b", "title": "Same", "filename": "b.pdf"},
    )

    for project_id in (first["id"], second["id"]):
        path = (
            tmp_path
            / "users"
            / "reader"
            / "projects"
            / project_id
            / "meta.json"
        )
        meta = json.loads(path.read_text())
        meta.pop("slug", None)
        meta.pop("routeName", None)
        for paper in meta.get("papers", []):
            paper.pop("slug", None)
            paper.pop("routeTitle", None)
        path.write_text(json.dumps(meta))

    repaired = make_local(tmp_path)
    listed = {item["id"]: item for item in repaired.list_projects("reader")}
    assert listed[first["id"]]["slug"] == "duplicate"
    assert listed[second["id"]]["slug"] == "duplicate-2"
    loaded = repaired.get_project("reader", first["id"])
    assert [paper["slug"] for paper in loaded["papers"]] == ["same", "same-2"]

    # Simulate the previous binary changing only the title during a rolling
    # deploy. The stored source snapshot makes the stale mapping detectable.
    path = (
        tmp_path
        / "users"
        / "reader"
        / "projects"
        / first["id"]
        / "meta.json"
    )
    meta = json.loads(path.read_text())
    meta["papers"][0]["title"] = "Changed by old binary"
    path.write_text(json.dumps(meta))
    assert repaired.get_project("reader", first["id"])["papers"][0]["slug"] == (
        "changed-by-old-binary"
    )


def test_local_note_write_does_not_invert_onboarding_cleanup_locks(tmp_path):
    from delphi_core.storage.local import PERSONA_LOCK

    storage = make_local(tmp_path)
    storage.create_account("reader", None, "salt", "hash")
    project = storage.create_project("reader", "First", onboarding=True)
    finished = threading.Event()

    def note():
        storage.rename_project("reader", project["id"], "Renamed")
        finished.set()

    worker = threading.Thread(target=note)
    try:
        with PERSONA_LOCK:
            worker.start()
            assert finished.wait(2), "a project writer must not wait on the account lock cleanup holds"
            assert storage.settle_onboarding("reader", require_filing=True)["outcome"] == "restart"
    finally:
        worker.join(timeout=5)
    assert not worker.is_alive()


def test_a_page_without_aliases_ranks_as_it_did_before_aliases_existed():
    from delphi_core.memory_retrieval import lexical_score

    page = {"title": "Attention", "slug": "attention", "summary": "A mechanism", "body": "Attention attends."}
    terms = ["attention", "mechanism"]
    assert lexical_score(terms, page) == lexical_score(terms, {**page, "aliases": []})
    assert lexical_score(terms, {**page, "aliases": ["a mechanism"]}) > lexical_score(terms, page)
