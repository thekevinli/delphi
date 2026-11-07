"""
The commit that ends a maintenance job, against every store.

Each test stages pages by hand (`StagedPage`), claims a real job so the commit
has a lease to present, and reads back what the store holds afterwards.
The tests are the kit's (`delphi_core_testkit.conformance.memory_commit`), run
here on the local store.
"""

import pytest

from delphi_core_testkit.conformance.memory_commit import (
    storage,
    test_an_edit_commits_at_the_revision_it_was_read_at_and_keeps_what_it_did_not_touch,
    test_a_new_page_commits_with_its_aliases_and_the_document_it_came_from,
    test_a_session_job_names_its_cause_and_gives_a_new_page_no_document,
    test_a_stale_revision_is_its_own_error_and_writes_nothing,
    test_a_refusal_that_is_not_a_stale_revision_stays_the_stores_own,
    test_nothing_to_file_writes_an_event_and_no_page_and_settles_the_marker,
    test_nothing_is_said_in_the_words_of_whoever_found_it,
    test_a_link_to_a_page_deleted_since_staging_is_written_as_its_words,
    test_dropped_targets_are_on_the_event_beside_the_pages_that_passed,
    test_a_job_whose_every_page_was_dropped_fails_with_an_event_and_an_unsettled_marker,
    test_notes_are_stamped_filed_only_when_unchanged_since_they_were_read,
    test_a_nothing_outcome_stamps_the_notes_it_read,
    test_the_fence_refuses_a_commit_whose_lease_is_gone,
    test_a_commit_enqueues_no_document_or_session_job,
    test_an_unsorted_source_page_joins_the_domain_of_the_first_concept_written_from_it,
    test_a_page_written_into_the_unsorted_domain_moves_nothing,
    test_a_domain_a_new_page_brings_into_being_is_named_as_its_author_wrote_it,
    test_a_domain_spelled_in_lower_case_gets_a_capital_and_nothing_else,
)


#: What this module runs from the kit, named so pyflakes counts the imports
#: above as used: it cannot see pytest collect them.
__all__ = [
    "storage",
    "test_an_edit_commits_at_the_revision_it_was_read_at_and_keeps_what_it_did_not_touch",
    "test_a_new_page_commits_with_its_aliases_and_the_document_it_came_from",
    "test_a_session_job_names_its_cause_and_gives_a_new_page_no_document",
    "test_a_stale_revision_is_its_own_error_and_writes_nothing",
    "test_a_refusal_that_is_not_a_stale_revision_stays_the_stores_own",
    "test_nothing_to_file_writes_an_event_and_no_page_and_settles_the_marker",
    "test_nothing_is_said_in_the_words_of_whoever_found_it",
    "test_a_link_to_a_page_deleted_since_staging_is_written_as_its_words",
    "test_dropped_targets_are_on_the_event_beside_the_pages_that_passed",
    "test_a_job_whose_every_page_was_dropped_fails_with_an_event_and_an_unsettled_marker",
    "test_notes_are_stamped_filed_only_when_unchanged_since_they_were_read",
    "test_a_nothing_outcome_stamps_the_notes_it_read",
    "test_the_fence_refuses_a_commit_whose_lease_is_gone",
    "test_a_commit_enqueues_no_document_or_session_job",
    "test_an_unsorted_source_page_joins_the_domain_of_the_first_concept_written_from_it",
    "test_a_page_written_into_the_unsorted_domain_moves_nothing",
    "test_a_domain_a_new_page_brings_into_being_is_named_as_its_author_wrote_it",
    "test_a_domain_spelled_in_lower_case_gets_a_capital_and_nothing_else",
]


pytestmark = pytest.mark.kb_maintenance
