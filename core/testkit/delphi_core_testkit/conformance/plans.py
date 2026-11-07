"""
Plan durability, capability authority and immutable evidence, on every store
the consumer's `store_harness` opens.
"""

import json
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from delphi_core import plans
from delphi_core.plan_page import render_plan
from delphi_core.deps import get_object_store, get_storage
from delphi_core.main import app
from delphi_core.schemas import ChatRequest
from delphi_core.storage import LocalObjectStore
from delphi_core.storage.conversations import selector


@pytest.fixture
def store(store_harness, tmp_path):
    storage = store_harness.make(tmp_path)
    storage.create_account("reader", None, "salt", "hash")
    return storage

@pytest.fixture
def objects(tmp_path):
    return LocalObjectStore(tmp_path)


def draft(**changes):
    return {"version": 4, "title": "A reproducible experiment", "question": "Does the baseline hold?", "scope": "One measured baseline",
            "design": {"settings": [{"id": "a", "label": "Pilot", "detail": "One layer"}],
                       "runs": [{"id": "1", "group": "Discovery", "label": "Aligned", "cells": [{"setting": "a", "reports": "median ρ", "decisive": True}]}],
                       "caption": "One run decides the claim."},
            "method": "Implement and measure", "order": ["Run (1) in (a)"], "pseudocode": "",
            "setup": [{"component": "Seed", "setting": "42", "basis": "proposed"}],
            "readings": [{"when": "(1) is positive", "then": "The baseline holds"}], "limits": "One seed",
            "reference": [], **changes}


def request(store, username="reader"):
    chat = store.create_conversation(username, "general", None, None, uuid4().hex)
    return ChatRequest(scope="general", prompt="Plan the experiment", mode="plan", conversation_id=chat["id"], generation=chat["generation"], request_id=uuid4().hex)


def start(store, body, username="reader"):
    body._plan = plans.reserve(store, username, body)
    store.append_memory_message(username, {"role": "user", "content": body.prompt, "requestId": body.request_id, "createdAt": "2026-10-08T00:00:00+00:00"}, selector(body.conversation_id, body.generation))
    return body


def answer(body, value=None):
    return '```delphi_plan_' + body._plan["token"] + '\n' + json.dumps({"action": "create_plan", "plan": value or draft()}) + '\n```'


def save(store, objects, *, username="reader", **changes):
    body = start(store, request(store, username), username)
    text, saved = plans.finish(store, objects, username, body, answer(body, draft(**changes)))
    return body, saved


def test_saved_receipt_replays_without_a_second_plan(store, objects):
    body, saved = save(store, objects)
    assert plans.reserve(store, "reader", body)["saved"]["id"] == saved["id"]
    assert len(plans.list_plans(store, "reader")["plans"]) == 1
    with pytest.raises(HTTPException) as error:
        plans.reserve(store, "reader", body.model_copy(update={"prompt": "Different request"}))
    assert error.value.status_code == 409


def test_capacity_reservations_are_atomic(store):
    bodies = [request(store) for _ in range(4)]
    def claim(body):
        try:
            return plans.reserve(store, "reader", body)
        except HTTPException as error:
            return error.status_code
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(claim, bodies))
    assert sum(isinstance(r, dict) for r in results) == 3
    assert results.count(409) == 1
    assert plans.capacity(store, "reader")["pending"] == 3


def test_generation_and_cancel_fence_publication(store, objects):
    body = start(store, request(store))
    store.delete_conversation("reader", body.conversation_id, body.generation)
    with pytest.raises(HTTPException):
        plans.finish(store, objects, "reader", body, answer(body))
    assert plans.list_plans(store, "reader")["plans"] == []
    plans.release(store, "reader", body._plan)
    body = start(store, request(store))
    store.append_memory_message("reader", {"role": "assistant", "content": "Stopped", "requestId": body.request_id, "cancelled": True}, selector(body.conversation_id, body.generation))
    with pytest.raises(HTTPException) as error:
        plans.finish(store, objects, "reader", body, answer(body))
    assert error.value.status_code == 409
    assert plans.list_plans(store, "reader")["plans"] == []


def test_interruption_releases_capacity_and_old_worker_cannot_commit(store, objects):
    body = start(store, request(store))
    plans.release(store, "reader", body._plan)
    assert plans.capacity(store, "reader")["pending"] == 0
    with pytest.raises(HTTPException):
        plans.finish(store, objects, "reader", body, answer(body))
    prior = deepcopy(body._plan)
    body._plan = plans.reserve(store, "reader", body)
    assert body._plan["token"] != prior["token"]


def test_clarification_releases_reservation_malformed_command_never_saves(store, objects):
    body = start(store, request(store))
    assert plans.finish(store, objects, "reader", body, "Which scientific result?") == ("Which scientific result?", None)
    assert plans.capacity(store, "reader")["pending"] == 0
    with pytest.raises(ValueError):
        plans.parse_draft('```delphi_plan_'+body._plan["token"]+'\n{"action":', body._plan)


def test_captures_survive_live_changes_and_reject_forged_sources(store, objects):
    project = store.create_project("reader", "Sources")
    store.add_paper("reader", project["id"], {"id": "source", "title": "Original", "filename": "source.pdf", "pages": 1})
    from delphi_core.storage.base import paper_key
    key = paper_key("reader", project["id"], "source", "txt")
    objects.put_text(key, "Original exact source passage.")
    reference = [{"sourceId": "source", "summary": "The baseline", "target": "Method", "pages": [],
                  "passages": [{"location": "Method", "excerpt": "Original exact source passage."}, {"location": "Method", "excerpt": "Invented words"}]}]
    body, saved = save(store, objects, reference=reference)
    record = plans.get_plan(store, "reader", saved["id"])
    assert len(record["plan"]["reference"][0]["passages"]) == 1
    objects.put_text(key, "Changed live document")
    assert objects.get_text(record["documents"][0]["textKey"]) == "Original exact source passage."
    other = start(store, request(store))
    with pytest.raises(ValueError, match="outside"):
        plans.finish(store, objects, "reader", other, answer(other, draft(reference=[{**reference[0], "sourceId": "foreign"}])))
    assert len(plans.list_plans(store, "reader")["plans"]) == 1


def test_literature_needs_captured_reference(store, objects):
    body = start(store, request(store))
    value = draft(setup=[{"component": "Learning rate", "setting": "3e-4", "basis": "source"}])
    with pytest.raises(ValueError, match="required schema"):
        plans.finish(store, objects, "reader", body, answer(body, value))


def test_object_failure_does_not_publish(store, objects, monkeypatch):
    body = start(store, request(store))
    def fail(*args):
        raise RuntimeError("storage unavailable")
    monkeypatch.setattr(objects, "put_text", fail)
    with pytest.raises(RuntimeError):
        plans.finish(store, objects, "reader", body, answer(body))
    assert not plans.list_plans(store, "reader")["plans"]
    plans.release(store, "reader", body._plan)
    assert plans.capacity(store, "reader")["pending"] == 0


def test_archive_atomic_and_account_owned(store, objects):
    from delphi_core.routers.plans import Archive, archive
    _, a = save(store, objects)
    _, b = save(store, objects)
    with pytest.raises(HTTPException):
        archive(Archive(selected=[{"id": a["id"], "revision": 1}, {"id": b["id"], "revision": 8}]), "reader", store)
    assert len(plans.capacity(store, "reader")["plans"]) == 2
    archive(Archive(selected=[{"id": a["id"], "revision": 1}]), "reader", store)
    assert plans.get_plan(store, "reader", a["id"])["archived"]
    store.create_account("other", None, "salt", "hash")
    with pytest.raises(HTTPException) as error:
        plans.get_plan(store, "other", a["id"])
    assert error.value.status_code == 404


def test_grants_narrow_revocable_hash_only(store, objects):
    from delphi_core.routers.plans import Grant, issue_grant, authorized_grant, revoke
    _, saved = save(store, objects)
    issued = issue_grant(Grant(planIds=[saved["id"]]), "reader", store)
    assert authorized_grant(store, issued["token"]) == ("reader", [saved["id"]])
    assert issued["token"] not in json.dumps(store.plan_transaction("reader", lambda s: deepcopy(s)))
    revoke(issued["grant"]["id"], "reader", store)
    with pytest.raises(HTTPException) as error:
        authorized_grant(store, issued["token"])
    assert error.value.status_code == 401


def test_mcp_http_protocol_and_ownership(store, objects):
    from delphi_core.routers.plans import Grant, issue_grant
    _, saved = save(store, objects)
    token = issue_grant(Grant(planIds=[saved["id"]]), "reader", store)["token"]
    app.dependency_overrides[get_storage] = lambda: store
    app.dependency_overrides[get_object_store] = lambda: objects
    try:
        with TestClient(app) as client:
            headers = {"Authorization": "Bearer " + token}
            def rpc(method, params=None, **extra):
                return client.post('/api/plans/mcp', headers={**headers, **extra}, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})
            assert rpc('initialize', {"protocolVersion": "2025-11-25"}).json()["result"]["protocolVersion"] == "2025-11-25"
            assert {t["name"] for t in rpc('tools/list').json()["result"]["tools"]} == {"get_plan", "read_plan_source"}
            result = rpc('tools/call', {"name": "get_plan", "arguments": {"plan_id": saved["id"]}}).json()["result"]
            value = json.loads(result["content"][0]["text"])
            assert "conversation" not in value
            assert value["plan"]["version"] == 4
            assert "error" in rpc('tools/call', {"name": "get_plan", "arguments": {"plan_id": 'foreign'}}).json()
            assert rpc('tools/list', **{"Origin": "https://evil.example"}).status_code == 403
            assert rpc('tools/list', **{"MCP-Protocol-Version": "2099"}).status_code == 400
            assert client.post('/api/plans/mcp', headers=headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"}).status_code == 202
    finally:
        app.dependency_overrides.clear()


def test_http_sessions_cannot_cross_owners_and_mcp_grants_do_not_expand(store, objects):
    """Use real session authentication, on both stores, for every Plan surface."""
    from delphi_core.config import Settings, get_settings
    from delphi_core.security import make_session

    store.create_account("other", None, "salt", "hash")
    _, shared = save(store, objects, title="Reader's shared plan")
    _, private = save(store, objects, title="Reader's private plan")
    _, other = save(store, objects, username="other", title="Other account's plan")
    settings = Settings(_env_file=None, session_secret="isolated-plan-ownership-test")
    app.dependency_overrides.update({get_settings: lambda: settings, get_storage: lambda: store,
                                    get_object_store: lambda: objects})
    try:
        with TestClient(app) as client:
            def signed_in(username):
                client.cookies.set("delphi_session", make_session(username, settings.session_secret, 1))

            def rpc(token, plan_id):
                return client.post("/api/plans/mcp", headers={"Authorization": f"Bearer {token}"},
                                   json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                         "params": {"name": "get_plan", "arguments": {"plan_id": plan_id}}})

            for path in ("/api/plans", f'/api/plans/{shared["id"]}/view', f'/api/plans/{shared["id"]}/export'):
                assert client.get(path).status_code == 401
            signed_in("reader")
            grant_response = client.post("/api/plans/grants", json={"planIds": [shared["id"]]})
            assert grant_response.status_code == 201
            grant = grant_response.json()
            # A later Plan never enlarges an existing connection's selection.
            _, later = save(store, objects, title="Created after sharing")

            signed_in("other")
            assert [row["id"] for row in client.get("/api/plans").json()["plans"]] == [other["id"]]
            assert client.get("/api/plans/grants").json() == {"grants": []}
            for suffix in ("", "/view", "/export"):
                assert client.get(f'/api/plans/{shared["id"]}{suffix}').status_code == 404
            assert client.post("/api/plans/grants", json={"planIds": [shared["id"]]}).status_code == 404
            assert client.delete(f'/api/plans/grants/{grant["grant"]["id"]}').status_code == 404
            assert client.post("/api/plans/archive", json={"selected": [{"id": shared["id"], "revision": 1}]}).status_code == 409
            assert not plans.get_plan(store, "reader", shared["id"])["archived"]
            assert client.get(other["url"]).status_code == 200

            # The MCP identity is the explicit capability, never the cookie.
            assert client.post("/api/plans/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).status_code == 401
            assert rpc(grant["token"].replace("dpg.reader.", "dpg.other."), shared["id"]).status_code == 401
            result = rpc(grant["token"], shared["id"]).json()["result"]
            assert not result["isError"] and "Reader's shared plan" in result["content"][0]["text"]
            for denied in (private, later, other):
                response = rpc(grant["token"], denied["id"])
                assert response.status_code == 200 and response.json()["error"]["code"] == -32602
                assert denied["title"] not in response.text

            signed_in("reader")
            assert client.delete(f'/api/plans/grants/{grant["grant"]["id"]}').status_code == 204
            assert rpc(grant["token"], shared["id"]).status_code == 401
    finally:
        app.dependency_overrides.clear()


def test_saved_receipt_repairs_interrupted_history_without_mutating_question(store, objects):
    body, saved = save(store, objects)
    messages = store.get_conversation("reader", body.conversation_id)["messages"]
    projected = plans.history(store, "reader", body.conversation_id, body.generation, messages)
    assert len(projected) == 2 and projected[0]["content"] == body.prompt
    assert projected[1]["plan"]["id"] == saved["id"]
    assert plans.history(store, "reader", body.conversation_id, body.generation+1, messages) == messages


def test_history_reads_receipts_without_locking_or_writing_plan_state(store, objects, monkeypatch):
    # Every thread load and every question reads history; none may serialize
    # behind a reservation or create Plan state for an account that never planned.
    store.create_account("fresh", None, "salt", "hash")
    assert store.plan_state("fresh") == {"plans": {}, "receipts": {}, "grants": {}}
    body, saved = save(store, objects)
    messages = store.get_conversation("reader", body.conversation_id)["messages"]
    monkeypatch.setattr(store, "plan_transaction", lambda *args, **kwargs: pytest.fail("history took a Plan transaction"))
    projected = plans.history(store, "reader", body.conversation_id, body.generation, messages)
    assert projected[-1]["plan"]["id"] == saved["id"]
    assert plans.history(store, "fresh", body.conversation_id, body.generation, messages) == messages


def test_pdf_capture_image_export_and_source_limits(store, objects, tmp_path):
    import io
    from pypdf import PdfWriter
    from delphi_core.storage.base import paper_key
    from delphi_core.routers.plans import read_tool
    project = store.create_project('reader', 'Research')
    store.add_paper('reader', project['id'], {'id': 'pdf-source', 'title': 'Paper', 'filename': 'paper.pdf', 'pages': 2})
    path = tmp_path / 'original.pdf'
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_blank_page(width=612, height=792)
    writer.write(path)
    objects.put_file(paper_key('reader', project['id'], 'pdf-source', 'pdf'), path, 'application/pdf')
    objects.put_text(paper_key('reader', project['id'], 'pdf-source', 'txt'), 'Source text. '*50000)
    reference = [{'sourceId': 'pdf-source', 'summary': 'Baseline', 'target': 'Page one', 'pages': [1], 'passages': []}]
    _, saved = save(store, objects, reference=reference)
    record = plans.get_plan(store, 'reader', saved['id'])
    assert record['documents'][0]['truncated']
    assert len(objects.get_text(record['documents'][0]['textKey']).encode()) <= plans.TEXT_BYTES
    assert len(record['referenceImages']) == 1
    result = read_tool('read_plan_source', {'plan_id': saved['id'], 'index': 0, 'page': 1}, record, objects)
    assert result[0]['mimeType'] == 'image/png'
    import base64
    from PIL import Image
    with Image.open(io.BytesIO(base64.b64decode(result[0]['data']))) as image:
        assert max(image.size) <= 1600
    with pytest.raises(ValueError):
        read_tool('read_plan_source', {'plan_id': saved['id'], 'index': 0, 'page': 2}, record, objects)
    first = json.loads(read_tool('read_plan_source', {'plan_id': saved['id'], 'index': 0}, record, objects)[0]['text'])
    assert len(first['text']) == 20000 and first['nextOffset'] == 20000
    body = start(store, request(store))
    with pytest.raises(ValueError, match='outside'):
        plans.finish(store, objects, 'reader', body, answer(body, draft(reference=[{**reference[0], 'pages': [3]}])))


def test_expired_receipt_cannot_publish_and_expired_grant_cannot_read(store, objects):
    from delphi_core.routers.plans import Grant, issue_grant, authorized_grant
    body = start(store, request(store))
    store.plan_transaction('reader', lambda s: s['receipts'][body._plan['key']].update(expiresAt=0))
    assert plans.capacity(store, 'reader')['pending'] == 0
    with pytest.raises(HTTPException):
        plans.finish(store, objects, 'reader', body, answer(body))
    _, saved = save(store, objects)
    issued = issue_grant(Grant(planIds=[saved['id']]), 'reader', store)
    store.plan_transaction('reader', lambda s: s['grants'][issued['grant']['id']].update(expires=0))
    with pytest.raises(HTTPException) as error:
        authorized_grant(store, issued['token'])
    assert error.value.status_code == 401


def test_cancelled_trace_is_owned_generation_fenced_and_never_appends(store):
    body = request(store)
    key = selector(body.conversation_id, body.generation)
    store.append_memory_message('reader', {'role':'user','content':'Question','requestId':body.request_id}, key)
    store.append_memory_message('reader', {'role':'assistant','content':'Request cancelled.','requestId':body.request_id,'cancelled':True}, key)
    trace = [{'offset':999,'startedAt':0,'endedAt':2,'entries':[]}]
    store.finish_cancelled_trace('reader', body.conversation_id, body.generation+1, body.request_id, trace)
    assert 'trace' not in store.get_conversation('reader',body.conversation_id)['messages'][-1]
    store.create_account('other',None,'salt','hash')
    store.finish_cancelled_trace('other', body.conversation_id, body.generation, body.request_id, trace)
    store.finish_cancelled_trace('reader', body.conversation_id, body.generation, body.request_id, trace)
    row=store.get_conversation('reader',body.conversation_id)
    assert len(row['messages'])==2 and row['messages'][-1]['trace'][0]['offset']==0
    assert row['messages'][-1]['content']=='Request cancelled.'
    assert not store.list_memory_jobs('reader')


def test_a_source_setting_is_checked_against_its_captured_source(store, objects):
    project = store.create_project('reader', 'Sources')
    store.add_paper('reader', project['id'], {'id': 'source', 'title': 'Original', 'filename': 'source.pdf', 'pages': 2})
    from delphi_core.storage.base import paper_key
    objects.put_text(paper_key('reader', project['id'], 'source', 'txt'), 'Table 2. Learning rates.')
    row = {'component': 'Learning rate', 'setting': '3e-4', 'basis': 'source', 'source': {'sourceId': 'source', 'location': 'Table 2'}}
    _, saved = save(store, objects, setup=[row])
    assert plans.get_plan(store, 'reader', saved['id'])['documents'][0]['id'] == 'source'
    body = start(store, request(store))
    with pytest.raises(ValueError, match='absent'):
        plans.finish(store, objects, 'reader', body, answer(body, draft(setup=[{**row, 'source': {'sourceId': 'source', 'location': 'Table 9'}}])))


def test_a_source_value_in_a_bar_chart_is_checked_and_cited(store, objects):
    project = store.create_project('reader', 'Sources')
    store.add_paper('reader', project['id'], {'id': 'source', 'title': 'Original', 'filename': 'source.pdf', 'pages': 2})
    from delphi_core.storage.base import paper_key
    objects.put_text(paper_key('reader', project['id'], 'source', 'txt'), 'Table 2. Dataset sizes.')
    bar = {'label': '(a)', 'value': 1234567, 'basis': 'source', 'detail': 'tokens in the training split', 'source': {'sourceId': 'source', 'location': 'Table 2'}}
    bars = {'kind': 'bars', 'title': 'Data', 'caption': 'Sizes.', 'unit': 'tokens', 'bars': [bar, {'label': '(b)', 'value': 2, 'basis': 'computed', 'detail': '2×'}]}
    _, saved = save(store, objects, exhibits=[bars])
    record = plans.get_plan(store, 'reader', saved['id'])
    page = render_plan(record)
    assert '1234567 tokens' in page and '<span class="ref">[1, Table 2]</span>' in page
    body = start(store, request(store))
    with pytest.raises(ValueError, match='absent'):
        plans.finish(store, objects, 'reader', body, answer(body, draft(exhibits=[{**bars, 'bars': [{**bar, 'source': {'sourceId': 'source', 'location': 'Table 9'}}, bars['bars'][1]]}])))
