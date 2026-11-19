"""Conversation lifecycle against every real storage implementation.

The store cases are the kit's (`delphi_core_testkit.conformance.multiple_conversations`),
run here on the local store.
"""

import asyncio

from delphi_core.answer_heartbeat import AnswerHeartbeat

from delphi_core_testkit.conformance.multiple_conversations import (
    catalog,
    turn,
    storage,
    test_independent_history_defaults_reset_and_stale_writes,
    test_capacity_is_atomic,
    test_request_and_context_isolation,
    test_a_context_key_names_no_conversation,
    test_a_question_whose_answer_died_is_closed_by_the_next_one,
    test_a_heartbeat_keeps_an_old_question_answering,
    test_a_heartbeat_learns_the_answer_is_no_longer_owed,
    test_a_moved_paper_s_image_records_follow_their_bytes,
)


#: What this module runs from the kit, named so pyflakes counts the imports
#: above as used: it cannot see pytest collect them.
__all__ = [
    "storage",
    "test_independent_history_defaults_reset_and_stale_writes",
    "test_capacity_is_atomic",
    "test_request_and_context_isolation",
    "test_a_context_key_names_no_conversation",
    "test_a_question_whose_answer_died_is_closed_by_the_next_one",
    "test_a_heartbeat_keeps_an_old_question_answering",
    "test_a_heartbeat_learns_the_answer_is_no_longer_owed",
    "test_a_moved_paper_s_image_records_follow_their_bytes",
]


def test_the_stream_reads_cancellation_from_the_heartbeat_not_from_storage():
    class Store:
        calls = 0
        def renew_answer(self, *args):
            self.calls += 1
            return self.calls < 3

    async def run():
        store = Store()
        heartbeat = AnswerHeartbeat(store, 'reader', 'a' * 32, 0, 'question_one', every=0.01)
        heartbeat.start()
        for _ in range(200):
            if not heartbeat.live:
                break
            await asyncio.sleep(0.01)
        await heartbeat.stop()
        return heartbeat.live, store.calls

    assert asyncio.run(run()) == (False, 3)


def test_a_listing_never_serves_a_head_older_than_its_file(storage, store_harness, tmp_path):
    """`_conversation_heads` reuses a parsed head while its file's stat holds;
    every write must still show in the next listing, as an uncached one would."""
    args = catalog(storage)
    def listings():
        return (storage.list_scope_conversations('reader', *args),
                storage.list_recent_conversations('reader', limit=10))
    def uncached():
        storage._conversation_head_cache.clear()
        return listings()
    a = storage.create_conversation('reader', *args, 'create_first')
    b = storage.create_conversation('reader', *args, 'create_second')
    assert listings() == uncached()
    turn(storage, a, args[1], 'user')
    scope, recent = listings()
    assert [row['empty'] for row in scope['items']] == [False, True]
    assert [row['id'] for row in recent] == [a['id']] and 'empty' not in recent[0]
    storage.rename_conversation('reader', b['id'], 'Precision', 0)
    assert listings()[0]['items'][1]['title'] == 'Precision'
    assert listings() == uncached()
    # Rewrites that keep the file's size: a title of the same length, and the
    # heartbeat's fixed-width stamp.
    storage.rename_conversation('reader', b['id'], 'Precisely', 0)
    assert listings()[0]['items'][1]['title'] == 'Precisely'
    assert storage.renew_answer('reader', a['id'], 0, 'question_123')
    stamped = listings()[1][0]['answering']['at']
    assert storage.renew_answer('reader', a['id'], 0, 'question_123')
    renewed = storage.get_conversation('reader', a['id'])['answering']['at']
    assert renewed != stamped and listings()[1][0]['answering']['at'] == renewed
    assert listings() == uncached()
    # A row is the caller's to change; the next listing still reads the file.
    listings()[1][0]['answering']['requestId'] = 'changed'
    assert listings()[1][0]['answering']['requestId'] == 'question_123'
    # Another store on the same profile writes; this one's next listing sees it.
    store_harness.make(tmp_path).rename_conversation('reader', b['id'], 'Elsewhere', 0)
    assert listings()[0]['items'][1]['title'] == 'Elsewhere'
    storage.delete_conversation('reader', a['id'], 0)
    assert [row['id'] for row in listings()[0]['items']] == [b['id']]
    assert listings() == uncached()
    # The scope's one empty chat, reset and then asked for again, is reused.
    turn(storage, b, args[1], 'user')
    storage.delete_conversation('reader', b['id'], 0)
    again = storage.create_conversation('reader', *args, 'create_again')
    assert (again['id'], again['generation'], again['empty']) == (b['id'], 1, True)
    assert listings() == uncached()
