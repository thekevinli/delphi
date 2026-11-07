"""Conversation lifecycle against every store the consumer's `store_harness` opens."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from delphi_core.storage.conversations import ANSWER_STALE_SECONDS, selector, resolve_selector

from delphi_core_testkit.conformance import storage_contract as contract


# The contract suite's fixture, shared by assignment rather than
# `import storage`: an imported name is a definition the pyflakes gate sees every
# test's `storage` parameter redefine.
storage = contract.storage


def catalog(store, scope='document'):
    project = store.create_project('reader', 'Multi chat') if scope != 'general' else None
    project_id = project['id'] if project else None
    paper_id = None
    if scope == 'document':
        paper_id = 'a' * 32
        store.add_paper('reader', project_id, {'id': paper_id, 'title': 'Methods', 'filename': 'methods.pdf', 'pages': 1, 'bytes': 0})
    return scope, project_id, paper_id


def turn(store, item, project, role, request='question_123'):
    message = {'role': role, 'content': 'question' if role == 'user' else 'answer', 'requestId': request,
               'createdAt': datetime.now(timezone.utc).isoformat()}
    key = selector(item['id'], item['generation'])
    if project:
        store.append_message('reader', project, key, message)
    else:
        store.append_memory_message('reader', message, key)


@pytest.mark.parametrize('scope', ['document', 'general'])
def test_independent_history_defaults_reset_and_stale_writes(storage, scope):
    args = catalog(storage, scope)
    a = storage.create_conversation('reader', *args, 'create_first')
    assert storage.create_conversation('reader', *args, 'create_first')['id'] == a['id']
    turn(storage, a, args[1], 'user')
    turn(storage, a, args[1], 'assistant')
    b = storage.create_conversation('reader', *args, 'create_second')
    assert a['id'] != b['id']
    assert len(storage.get_conversation('reader', a['id'])['messages']) == 2
    assert not storage.get_conversation('reader', b['id'])['messages']
    assert storage.list_scope_conversations('reader', *args)['defaultId'] == a['id']
    storage.rename_conversation('reader', b['id'], 'Precision', 0)
    storage.set_conversation_title('reader', b['id'], title='Overwrite', model='test', updated_at='now', generation=0)
    assert storage.get_conversation('reader', b['id'])['title'] == 'Precision'
    assert storage.delete_conversation('reader', a['id'], 0)['action'] == 'deleted'
    assert storage.list_scope_conversations('reader', *args)['defaultId'] == b['id']
    turn(storage, b, args[1], 'user')
    assert storage.delete_conversation('reader', b['id'], 0)['action'] == 'reset'
    assert storage.get_conversation('reader', b['id'])['generation'] == 1
    with pytest.raises(HTTPException) as exc:
        turn(storage, b, args[1], 'assistant')
    assert exc.value.status_code == 409
    assert not storage.get_conversation('reader', b['id'])['messages']


def test_capacity_is_atomic(storage):
    args = catalog(storage)
    def create(index):
        try:
            return storage.create_conversation('reader', *args, f'create_{index:08}')
        except HTTPException as exc:
            assert exc.status_code == 409
            return None
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(create, range(14)))
    assert len([r for r in rows if r]) == 10
    assert len(storage.list_scope_conversations('reader', *args)['items']) == 10


def test_request_and_context_isolation(storage):
    args = catalog(storage)
    item = storage.create_conversation('reader', *args, 'create_first')
    turn(storage, item, args[1], 'user')
    for request in ['question_123', 'question_other']:
        with pytest.raises(HTTPException) as exc:
            turn(storage, item, args[1], 'user', request)
        assert exc.value.status_code == 409
    with pytest.raises(HTTPException) as exc:
        resolve_selector(storage, 'reader', 'general', None, None, item['id'])
    assert exc.value.status_code == 404
    storage.create_account('other', None, 'salt', 'hash')
    with pytest.raises(HTTPException) as exc:
        storage.get_conversation('other', item['id'])
    assert exc.value.status_code == 404


def test_a_context_key_names_no_conversation(storage):
    """Only a selector reaches a conversation; `project-…`/`paper-…` are gone."""
    args = catalog(storage)
    storage.create_conversation('reader', *args, 'create_first')
    for key in (f'project-{args[1]}', None, 'conversation-short-0'):
        with pytest.raises(HTTPException) as exc:
            storage.append_message('reader', args[1], key, {'role': 'user', 'content': 'old'})
        assert exc.value.status_code == 404


def ask(store, item, project, request, created_at):
    message = {'role': 'user', 'content': 'question', 'requestId': request, 'createdAt': created_at}
    key = selector(item['id'], item['generation'])
    if project:
        store.append_message('reader', project, key, message)
    else:
        store.append_memory_message('reader', message, key)


@pytest.mark.parametrize('scope', ['document', 'general'])
def test_a_question_whose_answer_died_is_closed_by_the_next_one(storage, scope):
    args = catalog(storage, scope)
    item = storage.create_conversation('reader', *args, 'create_first')
    long_ago = (datetime.now(timezone.utc) - timedelta(seconds=ANSWER_STALE_SECONDS + 5)).isoformat()
    ask(storage, item, args[1], 'question_dead', long_ago)
    ask(storage, item, args[1], 'question_next', datetime.now(timezone.utc).isoformat())
    messages = storage.get_conversation('reader', item['id'])['messages']
    assert [(m['role'], m['requestId'], m.get('interrupted')) for m in messages] == [
        ('user', 'question_dead', None), ('assistant', 'question_dead', True), ('user', 'question_next', None)]
    assert messages[1]['cancelled'] is True
    # The process that owned the dead question cannot land its answer late.
    with pytest.raises(HTTPException) as exc:
        turn(storage, item, args[1], 'assistant', 'question_dead')
    assert exc.value.status_code == 409


def test_a_heartbeat_keeps_an_old_question_answering(storage):
    args = catalog(storage)
    item = storage.create_conversation('reader', *args, 'create_first')
    long_ago = (datetime.now(timezone.utc) - timedelta(seconds=ANSWER_STALE_SECONDS + 5)).isoformat()
    ask(storage, item, args[1], 'question_slow', long_ago)
    assert storage.renew_answer('reader', item['id'], 0, 'question_slow') is True
    with pytest.raises(HTTPException) as exc:
        ask(storage, item, args[1], 'question_next', datetime.now(timezone.utc).isoformat())
    assert exc.value.status_code == 409


def test_a_heartbeat_learns_the_answer_is_no_longer_owed(storage):
    args = catalog(storage)
    item = storage.create_conversation('reader', *args, 'create_first')
    turn(storage, item, args[1], 'user', 'question_one')
    assert storage.renew_answer('reader', item['id'], 0, 'question_one') is True
    assert storage.renew_answer('reader', item['id'], 0, 'question_other') is False
    storage.append_message('reader', args[1], selector(item['id'], 0), {
        'role': 'assistant', 'content': 'Request cancelled.', 'cancelled': True, 'requestId': 'question_one'})
    assert storage.renew_answer('reader', item['id'], 0, 'question_one') is False
    turn(storage, item, args[1], 'user', 'question_two')
    storage.delete_conversation('reader', item['id'], 0)
    assert storage.renew_answer('reader', item['id'], 0, 'question_two') is False


def test_a_moved_paper_s_image_records_follow_their_bytes(storage):
    from delphi_core.storage import chat_image_key
    args = catalog(storage, 'document')
    destination = storage.create_project('reader', 'Destination')['id']
    keys = []
    for name in ('create_first', 'create_second'):
        item = storage.create_conversation('reader', *args, name)
        key = selector(item['id'], item['generation'])
        image_key = chat_image_key('reader', args[1], key, f'image{len(keys)}', 'image')
        storage.add_chat_image('reader', args[1], key, {
            'id': f'image{len(keys)}', 'width': 1, 'height': 1, 'sourceBytes': 1, 'normalizedBytes': 1,
            'sourceFormat': 'png', 'imageKey': image_key, 'thumbnailKey': image_key + '-thumb',
            'createdAt': '2026-01-01T00:00:00+00:00', 'expiresAt': '2999-01-01T00:00:00+00:00',
        }, max_count=5, max_bytes=100)
        keys.append(key)
    storage.move_paper('reader', args[1], args[2], destination)
    for key in keys:
        (image,) = storage.list_chat_images('reader', destination, key, '2026-01-02T00:00:00+00:00')
        assert f'/p/{destination}/' in image['imageKey'] and f'/p/{destination}/' in image['thumbnailKey']
