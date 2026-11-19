import pytest
from fastapi.testclient import TestClient
from delphi_core.config import Settings, get_settings
from delphi_core.main import app
from delphi_core.storage import LocalStorage
from delphi_core.storage.conversations import selector
from tests.test_chat_images import encoded_image
from tests.helpers import ProviderTransport


@pytest.mark.parametrize('scope', ['document', 'general'])
def test_catalog_history_images_and_last_reset(tmp_path, scope):
    settings = Settings(data_dir=tmp_path, session_secret='multi-chat-test', openai_api_key='')
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            assert client.post('/api/auth/register', json={'username': 'reader', 'password': 'password-test'}).status_code == 200
            storage = LocalStorage(settings)
            args = {'scope': scope}
            if scope == 'document':
                args['project_id'] = storage.create_project('reader', 'Chat')['id']
                storage.add_paper('reader', args['project_id'], {'id': 'paper', 'title': 'P', 'filename': 'p.pdf'})
                args['paper_id'] = 'paper'
            assert client.get('/api/chat/conversations', params=args).json()['items'] == []
            a = client.post('/api/chat/conversations', json={**args, 'creation_key': 'create_first'}).json()
            b = client.post('/api/chat/conversations', json={**args, 'creation_key': 'create_second'}).json()
            qa = {**args, 'conversation_id': a['id'], 'generation': 0}
            qb = {**args, 'conversation_id': b['id'], 'generation': 0}
            image = client.post('/api/chat/images', params=qa, files={'image': ('figure.png', encoded_image(), 'image/png')})
            assert image.status_code == 201, image.text
            image = image.json()
            assert len(client.get('/api/chat', params=qa).json()['images']) == 1
            assert client.get('/api/chat', params=qb).json()['images'] == []
            assert client.get(f'/api/chat/images/{image["id"]}/image', params=qb).status_code == 404
            # Every chat operation names its conversation; the context alone is refused.
            assert client.get('/api/chat', params=args).status_code == 422
            assert client.delete('/api/chat', params=args).status_code == 422
            assert client.delete('/api/chat', params=qb).json()['action'] == 'deleted'
            reset = client.delete('/api/chat', params=qa)
            assert reset.status_code == 200, reset.text
            assert reset.json()['action'] == 'reset'
            assert client.get('/api/chat', params=qa).status_code == 409
            assert client.get('/api/chat', params={**qa, 'generation': qa['generation']+1}).json()['messages'] == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize('scope', ['document', 'general'])
def test_a_question_without_a_provider_is_refused_before_it_is_saved(tmp_path, scope):
    settings = Settings(data_dir=tmp_path, session_secret='multi-chat-test', openai_api_key='')
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post('/api/auth/register', json={'username': 'reader', 'password': 'password-test'})
            storage = LocalStorage(settings)
            args = {'scope': scope}
            if scope == 'document':
                args['project_id'] = storage.create_project('reader', 'Chat')['id']
                storage.add_paper('reader', args['project_id'], {'id': 'paper', 'title': 'P', 'filename': 'p.pdf'})
                args['paper_id'] = 'paper'
            item = client.post('/api/chat/conversations', json={**args, 'creation_key': 'create_first'}).json()
            conversation = {**args, 'conversation_id': item['id'], 'generation': 0}
            refused = client.post('/api/chat/stream', json={**conversation, 'prompt': 'hello', 'request_id': 'question_nokey'})
            assert refused.status_code == 503
            assert refused.json()['detail'] == 'No model provider is configured'
            assert client.get('/api/chat', params=conversation).json()['messages'] == []
            # An edit is refused before the question it would replace is dropped.
            question = {'role': 'user', 'content': 'typo here', 'requestId': 'question_typo'}
            key = selector(item['id'], 0)
            if scope == 'general':
                storage.append_memory_message('reader', question, key)
            else:
                storage.append_message('reader', args['project_id'], key, question)
            edit = client.post('/api/chat/stream', json={
                **conversation, 'prompt': 'fixed', 'request_id': 'question_fixed', 'replace_request_id': 'question_typo'})
            assert edit.status_code == 503
            assert [m['content'] for m in client.get('/api/chat', params=conversation).json()['messages']] == ['typo here']
    finally:
        app.dependency_overrides.clear()


def test_general_chat_reads_its_conversation_a_bounded_number_of_times(tmp_path, monkeypatch):
    """A long answer costs the same storage reads as a short one: cancellation
    rides the heartbeat, not a transcript read per streamed token."""
    import json
    import httpx
    from delphi_core.routers import chat as chat_router

    settings = Settings(data_dir=tmp_path, session_secret='multi-chat-test', openai_api_key='test-key')
    app.dependency_overrides[get_settings] = lambda: settings
    reads = {'count': 0}
    original_read = LocalStorage.get_thread

    def counted(self, *args, **kwargs):
        reads['count'] += 1
        return original_read(self, *args, **kwargs)

    def handler(request):
        events = [{'type': 'response.output_text.delta', 'delta': f'word{i} '} for i in range(200)]
        return httpx.Response(200, content=''.join(f'data: {json.dumps(e)}\n\n' for e in events).encode())

    real_client = httpx.AsyncClient
    monkeypatch.setattr(chat_router.httpx, 'AsyncClient',
                        lambda *a, **k: real_client(*a, **{**k, 'transport': ProviderTransport(handler)}))
    monkeypatch.setattr(LocalStorage, 'get_thread', counted)
    try:
        with TestClient(app) as client:
            client.post('/api/auth/register', json={'username': 'reader', 'password': 'password-test'})
            item = client.post('/api/chat/conversations', json={'scope': 'general', 'creation_key': 'create_first'}).json()
            reads['count'] = 0
            streamed = client.post('/api/chat/stream', json={
                'scope': 'general', 'prompt': 'long answer', 'request_id': 'question_long',
                'conversation_id': item['id'], 'generation': 0})
            assert streamed.status_code == 200 and 'word199' in streamed.text
            assert reads['count'] < 10
            history = client.get('/api/chat', params={'scope': 'general', 'conversation_id': item['id'], 'generation': 0}).json()
            assert history['messages'][-1]['content'].strip().endswith('word199')
    finally:
        app.dependency_overrides.clear()


def test_moving_a_paper_moves_every_conversation_s_images(tmp_path):
    from delphi_core.storage import LocalObjectStore

    settings = Settings(data_dir=tmp_path, session_secret='multi-chat-test', openai_api_key='')
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post('/api/auth/register', json={'username': 'reader', 'password': 'password-test'})
            storage = LocalStorage(settings)
            source = storage.create_project('reader', 'Source')['id']
            destination = storage.create_project('reader', 'Destination')['id']
            storage.add_paper('reader', source, {'id': 'paper-a', 'title': 'A', 'filename': 'a.pdf', 'pages': 1})
            chats = []
            for name in ('first_chat', 'second_chat'):
                created = client.post('/api/chat/conversations', json={
                    'scope': 'document', 'project_id': source, 'paper_id': 'paper-a', 'creation_key': name,
                }).json()
                chats.append({'scope': 'document', 'paper_id': 'paper-a', 'conversation_id': created['id'], 'generation': 0})
                image = client.post('/api/chat/images', params={**chats[-1], 'project_id': source},
                                    files={'image': ('figure.png', encoded_image(), 'image/png')})
                assert image.status_code == 201, image.text
                chats[-1]['image'] = image.json()['id']
            old_keys = [image[key] for chat in chats
                        for image in storage.list_chat_images('reader', source, f"conversation-{chat['conversation_id']}-0", '2000')
                        for key in ('imageKey', 'thumbnailKey')]

            assert client.post(f'/api/projects/{source}/papers/paper-a/move', json={'project_id': destination}).status_code == 200

            objects = LocalObjectStore(settings.data_dir)
            assert not any(objects.exists(key) for key in old_keys)
            for chat in chats:
                image_id = chat.pop('image')
                served = client.get(f'/api/chat/images/{image_id}/thumbnail', params={**chat, 'project_id': destination})
                assert served.status_code == 200
    finally:
        app.dependency_overrides.clear()


def test_the_anchors_route_answers_for_the_owner_only(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret='multi-chat-test', openai_api_key='')
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post('/api/auth/register', json={'username': 'reader', 'password': 'password-test'})
            storage = LocalStorage(settings)
            project = storage.create_project('reader', 'Robots')['id']
            storage.add_paper('reader', project, {'id': 'pi', 'title': 'Pi', 'filename': 'pi.html', 'kind': 'web'})
            storage.index_document_sections('reader', project, 'pi', [
                {'kind': 'section', 'locator': 'leveraging-more-data', 'ordinal': 1, 'title': 'T', 'text': 'Body.'}])
            assert client.get(f'/api/projects/{project}/anchors').json() == {'papers': {'pi': ['leveraging-more-data']}}
            client.post('/api/auth/logout')
            client.post('/api/auth/register', json={'username': 'stranger', 'password': 'password-test'})
            assert client.get(f'/api/projects/{project}/anchors').status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_deleting_a_document_chat_drops_only_the_evidence_nothing_else_cites(tmp_path):
    """Captured evidence is keyed by the page's hash, so two conversations on
    one document can cite the same object. Deleting one keeps what the other
    still cites, and drops what only it did."""
    from delphi_core.storage import LocalObjectStore, evidence_key
    from delphi_core.storage.conversations import selector

    settings = Settings(data_dir=tmp_path, session_secret='multi-chat-test', openai_api_key='')
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post('/api/auth/register', json={'username': 'reader', 'password': 'password-test'})
            storage, objects = LocalStorage(settings), LocalObjectStore(settings.data_dir)
            project_id = storage.create_project('reader', 'Chat')['id']
            storage.add_paper('reader', project_id, {'id': 'paperA', 'title': 'Page', 'filename': 'page.pdf', 'pages': 1, 'bytes': 0})
            context = {'scope': 'document', 'project_id': project_id, 'paper_id': 'paperA'}
            kept, gone = (client.post('/api/chat/conversations', json={**context, 'creation_key': key}).json()
                          for key in ('create_kept', 'create_gone'))
            for row, ids in ((kept, ['shared']), (gone, ['shared', 'own'])):
                for n, evidence_id in enumerate(ids):
                    request_id = f'q_{row["id"][:6]}_{n}'
                    key = selector(row['id'], 0)
                    storage.append_message('reader', project_id, key, {'role': 'user', 'content': 'q', 'requestId': request_id})
                    storage.append_message('reader', project_id, key, {
                        'role': 'assistant', 'content': 'a', 'requestId': request_id,
                        'viewportEvidence': {'evidenceId': evidence_id}})
                    objects.put_text(evidence_key('reader', 'paperA', evidence_id), '{}')
            deleted = client.delete('/api/chat', params={**context, 'conversation_id': gone['id'], 'generation': 0})
            assert deleted.json()['action'] == 'deleted'
            assert objects.exists(evidence_key('reader', 'paperA', 'shared'))
            assert not objects.exists(evidence_key('reader', 'paperA', 'own'))
    finally:
        app.dependency_overrides.clear()
