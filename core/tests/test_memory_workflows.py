"""
Memory as a reader changes it, whole after every step, on the local store.

The workflows are the kit's (`delphi_core_testkit.conformance.memory_workflows`),
so the web runs them on its own store.
"""

from delphi_core_testkit.conformance.memory_workflows import (
    library,
    storage,
    test_documents_added_filed_and_deleted_never_leave_memory_broken,
    test_deleting_pages_one_by_one_takes_a_domain_from_three_to_none,
    test_deleting_a_domain_of_any_shape_leaves_memory_whole,
    test_a_domain_that_changed_under_the_dialog_is_refused_then_deleted_as_shown_again,
    test_the_page_a_domain_would_keep_goes_where_the_reader_chose_once_they_saw_the_domain_as_it_is,
    test_update_moves_never_strand_a_domain,
    test_a_domain_the_reader_names_renames_and_deletes_stays_in_sight_throughout,
    test_a_document_waiting_to_be_filed_is_in_sight_and_never_strands,
)

#: What this module runs from the kit, named so pyflakes counts the imports
#: above as used: it cannot see pytest collect them.
__all__ = [
    "library",
    "storage",
    "test_documents_added_filed_and_deleted_never_leave_memory_broken",
    "test_deleting_pages_one_by_one_takes_a_domain_from_three_to_none",
    "test_deleting_a_domain_of_any_shape_leaves_memory_whole",
    "test_a_domain_that_changed_under_the_dialog_is_refused_then_deleted_as_shown_again",
    "test_the_page_a_domain_would_keep_goes_where_the_reader_chose_once_they_saw_the_domain_as_it_is",
    "test_update_moves_never_strand_a_domain",
    "test_a_domain_the_reader_names_renames_and_deletes_stays_in_sight_throughout",
    "test_a_document_waiting_to_be_filed_is_in_sight_and_never_strands",
]
