"""Plan durability, capability authority and immutable evidence on every store.

The store cases are the kit's (`delphi_core_testkit.conformance.plans`), run
here on the local store.
"""

import io
import json
from uuid import uuid4
import zipfile

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from delphi_core import plans
from delphi_core.plan_page import render_plan
from delphi_core.deps import get_current_user, get_object_store, get_storage
from delphi_core.main import app
from delphi_core.schemas import ChatRequest
from delphi_core.storage import LocalObjectStore, paper_key
from delphi_core.storage.conversations import selector

from delphi_core_testkit.conformance.plans import (
    store,
    objects,
    draft,
    request,
    start,
    answer,
    save,
    test_saved_receipt_replays_without_a_second_plan,
    test_capacity_reservations_are_atomic,
    test_generation_and_cancel_fence_publication,
    test_interruption_releases_capacity_and_old_worker_cannot_commit,
    test_clarification_releases_reservation_malformed_command_never_saves,
    test_captures_survive_live_changes_and_reject_forged_sources,
    test_literature_needs_captured_reference,
    test_object_failure_does_not_publish,
    test_archive_atomic_and_account_owned,
    test_grants_narrow_revocable_hash_only,
    test_mcp_http_protocol_and_ownership,
    test_http_sessions_cannot_cross_owners_and_mcp_grants_do_not_expand,
    test_saved_receipt_repairs_interrupted_history_without_mutating_question,
    test_history_reads_receipts_without_locking_or_writing_plan_state,
    test_pdf_capture_image_export_and_source_limits,
    test_expired_receipt_cannot_publish_and_expired_grant_cannot_read,
    test_cancelled_trace_is_owned_generation_fenced_and_never_appends,
    test_a_source_setting_is_checked_against_its_captured_source,
    test_a_source_value_in_a_bar_chart_is_checked_and_cited,
)


#: What this module runs from the kit, named so pyflakes counts the imports
#: above as used: it cannot see pytest collect them.
__all__ = [
    "store",
    "objects",
    "draft",
    "request",
    "start",
    "answer",
    "save",
    "test_saved_receipt_replays_without_a_second_plan",
    "test_capacity_reservations_are_atomic",
    "test_generation_and_cancel_fence_publication",
    "test_interruption_releases_capacity_and_old_worker_cannot_commit",
    "test_clarification_releases_reservation_malformed_command_never_saves",
    "test_captures_survive_live_changes_and_reject_forged_sources",
    "test_literature_needs_captured_reference",
    "test_object_failure_does_not_publish",
    "test_archive_atomic_and_account_owned",
    "test_grants_narrow_revocable_hash_only",
    "test_mcp_http_protocol_and_ownership",
    "test_http_sessions_cannot_cross_owners_and_mcp_grants_do_not_expand",
    "test_saved_receipt_repairs_interrupted_history_without_mutating_question",
    "test_history_reads_receipts_without_locking_or_writing_plan_state",
    "test_pdf_capture_image_export_and_source_limits",
    "test_expired_receipt_cannot_publish_and_expired_grant_cannot_read",
    "test_cancelled_trace_is_owned_generation_fenced_and_never_appends",
    "test_a_source_setting_is_checked_against_its_captured_source",
    "test_a_source_value_in_a_bar_chart_is_checked_and_cited",
]


def test_plan_html_escapes_model_content():
    rendered = render_plan({"id": "abc", "plan": draft(title="<script>alert(1)</script>")})
    assert '<script>' not in rendered and '&lt;script&gt;' in rendered
    assert '/api/plans/abc/export' in rendered


def test_plan_stream_hides_draft_persists_original_question_and_replays(tmp_path, monkeypatch):
    import re
    from delphi_core.config import Settings, get_settings
    from delphi_core.storage import LocalStorage
    from delphi_core.routers import chat
    from delphi_core.deps import get_current_user
    settings = Settings(_env_file=None, data_dir=tmp_path, openai_api_key="test", web_sandbox_origin="http://sandbox.test")
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    objects = LocalObjectStore(tmp_path)
    body = request(storage)
    calls = []
    async def generate(client, payload, *args, **kwargs):
        calls.append(payload)
        # The turn's token rides on the question; the instructions stay a stable prefix.
        assert 'delphi_plan_' not in payload['instructions']
        marker = re.search(r'(delphi_plan_[a-f0-9]{32})', json.dumps(payload['input'][-1])).group(1)
        yield {"type": "delta", "text": '```'+marker+'\n'+json.dumps({"action": "create_plan", "plan": draft()})+'\n```'}
    monkeypatch.setattr(chat, "run_turn", generate)
    app.dependency_overrides.update({get_settings: lambda: settings, get_storage: lambda: storage,
                                    get_object_store: lambda: objects, get_current_user: lambda: "reader"})
    try:
        with TestClient(app) as client:
            first = client.post('/api/chat/stream', json=body.model_dump())
            assert first.status_code == 200
            assert 'create_plan' not in first.text and 'delphi_plan_' not in first.text
            events = [json.loads(line[6:]) for line in first.text.splitlines() if line.startswith('data: ')]
            done = next(e for e in events if e['type'] == 'done')
            assert done['plan']['title'] == draft()['title']
            assert len(calls) == 1
            second = client.post('/api/chat/stream', json=body.model_dump())
            assert second.status_code == 200 and len(calls) == 1
            row = storage.get_conversation("reader", body.conversation_id)
            assert row['messages'][0]['content'] == body.prompt
            assert 'create_plan' not in row['messages'][-1]['content']
            assert row['messages'][-1]['plan']['id'] == done['plan']['id']
            assert not storage.list_memory_jobs("reader")
            html = client.get(done['plan']['url'])
            assert html.status_code == 200 and "default-src 'none'" in html.headers['content-security-policy']
            archive = client.get('/api/plans/'+done['plan']['id']+'/export')
            assert archive.status_code == 200 and archive.content[:2] == b'PK'
    finally:
        app.dependency_overrides.clear()


def test_conversation_capture_is_valid_json_and_explicitly_truncated():
    value, clipped = plans.capture_conversation([{'role': 'user', 'content': '古'*200000}])
    assert len(value.encode()) <= plans.CONVERSATION_BYTES
    assert clipped and json.loads(value)[0]['content'].startswith('古')


def a_plan_on_a_captured_pdf(store, objects, tmp_path):
    """A saved plan whose one source is a PDF and its text, both changed in the library after the save."""
    project = store.create_project("reader", "Sources")
    store.add_paper("reader", project["id"], {"id": "src", "title": "Source", "filename": "s.pdf", "pages": 1})
    txt_key, pdf_key = (paper_key("reader", project["id"], "src", kind) for kind in ("txt", "pdf"))
    objects.put_text(txt_key, "Exact immutable passage")
    path = tmp_path / "s.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.write(path)
    objects.put_file(pdf_key, path, "application/pdf")
    _, saved = save(store, objects, reference=[{"sourceId": "src", "summary": "Baseline", "target": "Page 1", "pages": [1], "passages": []}])
    objects.delete(pdf_key)
    objects.put_text(txt_key, "Changed")
    return plans.get_plan(store, "reader", saved["id"]), path.read_bytes()


def test_an_export_holds_each_source_as_it_was_captured_not_as_the_library_holds_it_now(store, objects, tmp_path):
    record, pdf = a_plan_on_a_captured_pdf(store, objects, tmp_path)
    app.dependency_overrides.update({get_storage: lambda: store, get_object_store: lambda: objects,
                                     get_current_user: lambda: "reader"})
    try:
        with TestClient(app) as client:
            response = client.get(f"/api/plans/{record['id']}/export")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.read("sources/0.pdf") == pdf
        assert archive.read("sources/0.txt") == b"Exact immutable passage"
        assert archive.read("images/src-1.png").startswith(b"\x89PNG")
        assert json.loads(archive.read("conversation.json"))[0]["content"] == "Plan the experiment"


def test_releasing_an_unsaved_plan_deletes_its_objects_and_leaves_a_saved_plans_alone(store, objects, tmp_path):
    record, _ = a_plan_on_a_captured_pdf(store, objects, tmp_path)
    abandoned = start(store, request(store))
    prefix = f"plans/u/reader/{abandoned._plan['planId']}/"
    objects.put_text(prefix + "conversation.json", "unfinished")
    assert objects.exists(prefix + "conversation.json")
    plans.release(store, "reader", abandoned._plan, objects)
    assert not objects.exists(prefix + "conversation.json")
    [document] = record["documents"]
    assert objects.exists(document["pdfKey"]) and objects.get_text(document["textKey"]) == "Exact immutable passage"


def test_recognizable_locators_are_checked_against_captured_source_facts():
    pdf = {'kind':'pdf', 'pages':4, 'text':'Figure 1. Measured improvement. Table 2. Results.'}
    for location in ('pp. 999', 'p. 1–999', 'pages 1, 2; 5', 'Figure 99', 'Table 999'):
        with pytest.raises(ValueError): plans.validate_location(location, pdf)
    for location in ('pp. 1–4', 'p. 1, 3', 'Figure 1', 'Table 2', 'Method'):
        plans.validate_location(location, pdf)
    web = {'kind':'web', 'anchors':['method', 'results']}
    plans.validate_location('#method', web)
    with pytest.raises(ValueError): plans.validate_location('#fabricated', web)
    with pytest.raises(ValueError): plans.validate_location('section: fabricated', web)


def test_draft_schema_failure_and_buffer_limit_do_not_reveal_raw_fields():
    value = draft(title='PRIVATE_UNSAVED_DRAFT'*20)
    body = type('Body', (), {'_plan':{'token':'token'}})()
    with pytest.raises(ValueError) as error: plans.parse_draft(answer(body, value), body._plan)
    assert 'PRIVATE_UNSAVED_DRAFT' not in str(error.value)
    with pytest.raises(ValueError, match='size limit'): plans.append_draft('x'*plans.MAX_DRAFT_BYTES, '古')


def test_receipt_link_escapes_model_title_without_changing_saved_target():
    result=plans.visible_result({'title':'\\](/evil)\n[x','url':'/api/plans/owned/view'})
    assert result.startswith('Saved [\\\\\\](/evil) \\[x](/api/plans/owned/view).')


def test_config_capabilities_and_explicit_model_effort_contract():
    from delphi_core.routers.chat import config
    from delphi_core.config import Settings
    value=config(Settings(_env_file=None,openai_api_key=''))
    assert value['capabilities']=={'traceVersion':2,'planAuthoring':False,'planHandoff':True,'providerManagement':False}
    value=config(Settings(_env_file=None,openai_api_key='test'))
    assert value['capabilities']['planAuthoring'] is True
    assert value['defaultModel']=='gpt-6.1-sol' and value['defaultReasoningEffort']=='medium'
    assert value['modelReasoningEfforts']['gpt-6.1-sol']==['max','xhigh','high','medium','low']


@pytest.mark.parametrize('mode',['chat','plan'])
def test_provider_failure_finishes_stored_trace_without_exposing_plan_draft(tmp_path, monkeypatch, mode):
    from delphi_core.config import Settings,get_settings
    from delphi_core.storage import LocalStorage
    from delphi_core.routers import chat
    from delphi_core.deps import get_current_user
    settings=Settings(_env_file=None,data_dir=tmp_path,openai_api_key='test')
    storage=LocalStorage(settings);storage.create_account('reader',None,'salt','hash')
    objects=LocalObjectStore(tmp_path)
    body=request(storage);body.mode=mode
    async def fail(client,payload,*args,**kwargs):
        record=kwargs['recorder']
        for event in record.answered('PRIVATE_DRAFT 🎉'):
            yield event
        yield {'type':'delta','text':'PRIVATE_DRAFT 🎉'}
        _, changes=record.tool_started('read_paper',{'paperId':'p','pages':[1]})
        for event in changes: yield event
        raise RuntimeError('Provider unavailable')
    monkeypatch.setattr(chat,'run_turn',fail)
    app.dependency_overrides.update({get_settings:lambda:settings,get_storage:lambda:storage,get_object_store:lambda:objects,get_current_user:lambda:'reader'})
    try:
        with TestClient(app) as client:
            response=client.post('/api/chat/stream',json=body.model_dump())
            assert 'Provider unavailable' in response.text
            stored=storage.get_conversation('reader',body.conversation_id)['messages'][-1]
            assert stored['error']
            assert all('endedAt' in stretch for stretch in stored['trace'])
            entry=stored['trace'][-1]['entries'][-1]
            assert entry['error']=='Interrupted' and 'running' not in entry
            if mode=='plan':
                assert 'PRIVATE_DRAFT' not in response.text and 'PRIVATE_DRAFT' not in stored['content']
                assert all(s['offset']==0 for s in stored['trace'])
                assert plans.capacity(storage,'reader')['pending']==0
    finally:
        app.dependency_overrides.clear()


def test_plan_json_schema_does_not_coerce_boolean_pages_or_revisions():
    from pydantic import ValidationError
    from delphi_core.routers.plans import Selection
    with pytest.raises(ValidationError):
        Selection(id='abc', revision=True)
    body = type('Body', (), {'_plan':{'token':'token'}})()
    with pytest.raises(ValueError, match='required schema'):
        plans.parse_draft(answer(body, draft(reference=[{'sourceId':'paper','summary':'Summary','target':'Page','pages':[True],'passages':[]}])), body._plan)


@pytest.mark.asyncio
@pytest.mark.parametrize('scope',['document','general'])
@pytest.mark.parametrize('mode',['chat','plan'])
@pytest.mark.parametrize('disconnect',['close','send-failure','cancelled-scope'])
@pytest.mark.parametrize('boundary',['active','done'])
async def test_chat_frame_boundary_closes_provider_and_releases_owned_work(tmp_path, monkeypatch, scope, mode, disconnect, boundary):
    import asyncio
    from delphi_core.config import Settings
    from delphi_core.storage import LocalStorage
    from delphi_core.routers import chat
    settings=Settings(_env_file=None,data_dir=tmp_path,openai_api_key='test',openai_files_enabled=False)
    storage=LocalStorage(settings);storage.create_account('reader',None,'salt','hash')
    objects=LocalObjectStore(tmp_path)
    project_id=paper_id=None
    if scope=='document':
        project_id=storage.create_project('reader','Sources')['id'];paper_id='paper'
        from tests.helpers import seed_paper
        seed_paper(settings,'reader',project_id,{'id':paper_id,'title':'Paper','filename':'paper.pdf','pages':1},text='--- Page 1 ---\nExact evidence.')
    row=storage.create_conversation('reader',scope,project_id,paper_id,uuid4().hex)
    body=ChatRequest(scope=scope,mode=mode,prompt='Explain it',project_id=project_id,paper_id=paper_id,
        conversation_id=row['id'],generation=row['generation'],request_id=uuid4().hex,engagement_id=uuid4().hex)
    provider_closed=False
    title_closed=False
    async def title(*args,**kwargs):
        nonlocal title_closed
        try:
            await asyncio.Event().wait()
        finally:
            title_closed=True
    heartbeats=[]
    original=chat.AnswerHeartbeat
    class TrackedHeartbeat(original):
        def __init__(self,*args,**kwargs):
            super().__init__(*args,**kwargs);heartbeats.append(self)
    async def generate(client,payload,*args,**kwargs):
        nonlocal provider_closed
        record=kwargs['recorder']
        try:
            if boundary=='done':
                text=answer(body) if mode=='plan' else 'Completed answer.'
                for event in record.answered(text):yield event
                yield {'type':'delta','text':text}
                return
            for event in record.answered('PRIVATE_PLAN_DRAFT 🎉'):
                yield event
            yield {'type':'delta','text':'PRIVATE_PLAN_DRAFT 🎉'}
            _,events=record.tool_started('read_paper',{'paperId':'paper','pages':[1]})
            for event in events:yield event
            yield {'type':'progress','stage':'disconnect_boundary','message':'Reading'}
            await asyncio.Event().wait()
        finally:
            provider_closed=True
    monkeypatch.setattr(chat,'run_turn',generate)
    monkeypatch.setattr(chat,'AnswerHeartbeat',TrackedHeartbeat)
    monkeypatch.setattr(chat,'generate_conversation_title',title)
    response=chat.unified_chat_stream(body,'reader',storage,objects,settings)
    target='disconnect_boundary' if boundary=='active' else '"type": "done"'
    if disconnect in {'close','cancelled-scope'}:
        while target not in await anext(response.body_iterator):pass
        if disconnect=='cancelled-scope':
            import anyio
            with anyio.CancelScope() as scope:
                scope.cancel()
                await response.body_iterator.aclose()
        else:
            await response.body_iterator.aclose()
    else:
        async def send(message):
            if target.encode() in message.get('body',b''):raise OSError('Disconnected during frame send')
        with pytest.raises(OSError):await response.stream_response(send)
    assert provider_closed
    assert heartbeats and all(h._task is None for h in heartbeats)
    messages=storage.get_conversation('reader',body.conversation_id)['messages']
    assert len(messages)==2
    if boundary=='active':
        assert messages[-1]['cancelled']
        assert all('endedAt' in stretch for stretch in messages[-1]['trace'])
        assert messages[-1]['trace'][-1]['entries'][-1]['error']=='Interrupted'
    else:
        assert not messages[-1].get('cancelled') and title_closed
        if mode=='plan':assert messages[-1]['plan']['id']
    assert plans.capacity(storage,'reader')['pending']==0
    if boundary=='active':assert not any(j['kind']=='answer' for j in storage.list_memory_jobs('reader'))
    if mode=='plan':assert 'PRIVATE_PLAN_DRAFT' not in messages[-1]['content']
    assert storage.claim_conversation_title('reader',project_id=project_id,thread_key=selector(row['id'],row['generation']),
        engagement_id=body.engagement_id,fallback_title='Retry') is not None


def test_plan_design_is_a_table_of_runs_by_settings_with_decisive_cells():
    body = type('Body', (), {'_plan':{'token':'token'}})()
    design = draft()['design']
    for broken in ({**design, 'runs': [{**design['runs'][0], 'cells': [{'setting': 'z', 'reports': 'x'}]}]},
                   {**design, 'runs': [{**design['runs'][0], 'cells': [{'setting': 'a', 'reports': 'x'}]}]},
                   {**design, 'settings': design['settings'] * 2}):
        with pytest.raises(ValueError, match='required schema'):
            plans.parse_draft(answer(body, draft(design=broken)), body._plan)
    table = {'kind': 'table', 'title': 'Budget', 'caption': 'Per run.', 'columns': ['Run', 'Memory'], 'rows': [['(1)']]}
    with pytest.raises(ValueError, match='required schema'):
        plans.parse_draft(answer(body, draft(exhibits=[table])), body._plan)
    with pytest.raises(ValueError, match='required schema'):
        plans.parse_draft(answer(body, draft(exhibits=[{**table, 'kind': 'pie'}])), body._plan)


def test_the_plan_prompt_offers_exactly_the_exhibit_kinds_the_page_draws():
    from delphi_core.plan_page import EXHIBIT_KINDS
    guide = plans.plan_instructions()
    for kind in ('table', 'flow', 'bars'):
        assert f'\n- {kind}: ' in guide
    assert len(EXHIBIT_KINDS) == 3 and 'most plans need none' in guide and 'Never draw results' in guide


def test_plan_page_reads_as_a_proposal_with_chosen_exhibits():
    exhibits = [{'kind': 'flow', 'title': 'Data path', 'caption': 'Held out.', 'steps': [{'label': 'Text'}, {'label': '<b>Score</b>', 'key': True}]},
                {'kind': 'bars', 'title': 'Cache', 'caption': 'Computed.', 'unit': 'GiB',
                 'bars': [{'label': '(a)', 'value': 0.5, 'basis': 'computed', 'detail': '3072 × 4 B'}, {'label': '(c)', 'value': 2, 'basis': 'computed', 'detail': '4×'}]}]
    design = {**draft()['design'], 'settings': [{'id': 'a', 'label': 'Pilot', 'detail': ''}, {'id': 'b', 'label': 'Full', 'detail': ''}]}
    record = {'id': 'abc', 'plan': draft(design=design, exhibits=exhibits,
              web=[{'title': 'Model card', 'url': 'https://huggingface.co/gpt2', 'note': ''}])}
    page = render_plan(record)
    assert '<td class="decisive">median ρ</td>' in page and '<td class="none">·</td>' in page
    assert '<tr class="group"><td colspan="3">Discovery</td></tr>' in page
    assert page.index('Figure 2. Data path') > page.index('id="method"') > page.index('Figure 1. Cache')
    assert 'width:25.0%' in page and 'width:100.0%' in page
    assert '&lt;b&gt;Score&lt;/b&gt;' in page and 'Web page, not captured by Delphi' in page
    assert 'Implement runs (1) in setting (a)' in page
    assert '<script' not in page


def test_an_older_store_keeps_only_proposal_plans_and_what_names_them(tmp_path):
    from delphi_core.config import Settings
    from delphi_core.storage import LocalStorage, local_format
    storage = LocalStorage(Settings(data_dir=tmp_path))
    storage.create_account("reader", None, "salt", "hash")
    user = tmp_path / "users" / "reader"
    old, new = {"plan": {"version": 3}}, {"plan": {"version": 4}}
    (user / "plans.json").write_text(json.dumps({
        "plans": {"old": old, "new": new},
        "receipts": {"r1": {"status": "saved", "planId": "old"}, "r2": {"status": "saved", "planId": "new"}, "r3": {"status": "interrupted", "planId": "x"}},
        "grants": {"g1": {"planIds": ["old"]}, "g2": {"planIds": ["old", "new"]}}}))
    for plan_id in ("old", "new"):
        (user / "plan-captures" / plan_id).mkdir(parents=True)
    # A format 3 store kept its Memory, and its marker, in `knowledge/`.
    (user / "knowledge").unlink()
    (user / "memory").rename(user / "knowledge")
    (user / "knowledge" / "format.json").write_text(json.dumps({"format": 3}))
    local_format._CURRENT.discard(str(user))
    LocalStorage(Settings(data_dir=tmp_path))
    state = json.loads((user / "plans.json").read_text())
    assert state == {"plans": {"new": new}, "receipts": {"r2": {"status": "saved", "planId": "new"}, "r3": {"status": "interrupted", "planId": "x"}},
                     "grants": {"g2": {"planIds": ["new"]}}}
    assert json.loads((user / "memory" / "format.json").read_text()) == {"format": local_format.LOCAL_FORMAT}
    assert not (user / "plan-captures" / "old").exists() and (user / "plan-captures" / "new").exists()


def test_bars_cite_sources_references_are_one_per_document_and_values_print_plainly():
    from delphi_core.plan_page import number
    body = type('Body', (), {'_plan':{'token':'token'}})()
    bars = {'kind': 'bars', 'title': 'Data', 'caption': 'Sizes.', 'unit': 'tokens',
            'bars': [{'label': '(a)', 'value': 1234567, 'basis': 'source', 'detail': 'Table 2'}, {'label': '(b)', 'value': 2, 'basis': 'computed', 'detail': '2×'}]}
    with pytest.raises(ValueError, match='required schema'):
        plans.parse_draft(answer(body, draft(exhibits=[bars])), body._plan)
    target = {'sourceId': 'paper', 'summary': 'S', 'target': 'Figure 1', 'pages': [], 'passages': []}
    with pytest.raises(ValueError, match='required schema'):
        plans.parse_draft(answer(body, draft(reference=[target, {**target, 'target': 'Figure 2'}])), body._plan)
    assert plans.parse_draft(answer(body, draft(setup=[{'component': 'Seed', 'setting': '1', 'basis': 'proposed', 'source': None}])), body._plan)
    assert [number(v) for v in (1234567, 1500000, 0.28, 3.0)] == ['1234567', '1500000', '0.28', '3']
    guide = plans.plan_instructions()
    assert 'When web search is available' in guide and 'web documents use an empty pages array' in guide and 'discussion alone' in guide


def test_the_captured_conversation_shows_the_passage_a_question_was_asked_about():
    conversation = [{'role': 'user', 'content': 'Design an experiment around this.', 'selectedText': 'We keep <b>mutual</b> top-1 pairs.'},
                    {'role': 'assistant', 'content': 'Saved.', 'selectedText': ''}]
    page = render_plan({'id': 'abc', 'plan': draft()}, conversation=conversation)
    assert 'Design an experiment around this.' in page
    assert '<b>Selected passage</b><br>We keep &lt;b&gt;mutual&lt;/b&gt; top-1 pairs.' in page
    assert page.count('Selected passage') == 1
