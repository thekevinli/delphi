import asyncio
import json
import re

import httpx
import pytest
from fastapi import HTTPException

from tests.chat_keys import chat_key, conversation_params
from delphi_core.answer_trace import AnswerTrace
from delphi_core.config import Settings
from delphi_core.document_reads import read_webpage
from delphi_core.harness import profiles
from delphi_core.harness.prompts import EVIDENCE_REQUIREMENTS, compose_instructions, working_method
from delphi_core.harness.provider import Terminal, parse_stream
from delphi_core.harness.tool import ToolContext
from delphi_core.personas import resolve_persona_for_request
from delphi_core.routers.chat import (
    build_responses_input,
    build_responses_payload,
    ensure_openai_files,
    open_document_block,
    tail_input,
    select_reader_memory,
    prepare_viewport_context,
    request_papers,
    request_prompt_cache_key,
    ready_project_digests,
    toolset_for_scope,
    resolve_model,
    resolve_reasoning_effort,
    request_was_cancelled,
)
from delphi_core.memory_harness import (
    grep_memory,
    memory_grep_matcher,
    memory_links,
    reader_memory_block,
)
from delphi_core.schemas import ChatRequest
from delphi_core.storage import LocalObjectStore, LocalStorage

from tests.helpers import run_model_turns, seed_paper
from pydantic import ValidationError

from tests.helpers import ProviderTransport


def tool_names(payload: dict) -> list[str]:
    """What a request offers, in order, by name; a hosted tool has only its type."""
    return [tool.get("name") or tool["type"] for tool in payload.get("tools", [])]


def test_chat_omitted_reasoning_effort_falls_back_to_settings():
    settings = Settings()
    assert ChatRequest(scope="document", prompt="Explain the method.").reasoning_effort is None
    assert resolve_reasoning_effort(settings, None) == settings.reasoning_effort_default
    assert resolve_reasoning_effort(settings, "low") == "low"
    assert resolve_reasoning_effort(settings, "not-an-effort") == (
        settings.reasoning_effort_default
    )
    supported = Settings(model_choices="gpt-6-luna,gpt-6-sol")
    assert resolve_reasoning_effort(supported, "max", "gpt-6-luna") == "max"
    assert resolve_reasoning_effort(supported, "xhigh", "gpt-6-sol") == supported.reasoning_effort_default


def test_cancellation_is_a_durable_idempotency_key(tmp_path):
    storage = LocalStorage(Settings(data_dir=tmp_path))
    storage.create_account("reader", None, "salt", "hash")
    project = storage.create_project("reader", "Project")
    storage.add_paper(
        "reader", project["id"], {"id": "p", "title": "P", "filename": "p.pdf"}
    )
    key = chat_key(storage, "reader", project["id"], "paper-p")
    storage.append_message(
        "reader", project["id"], key,
        {"role": "user", "content": "Question", "requestId": "request_123"},
    )
    storage.append_message(
        "reader",
        project["id"],
        key,
        {
            "role": "assistant",
            "content": "Request cancelled.",
            "cancelled": True,
            "requestId": "request_123",
        },
    )

    assert request_was_cancelled(
        storage, "reader", project["id"], key, "request_123"
    )
    assert not request_was_cancelled(
        storage, "reader", project["id"], key, "another_request"
    )


def test_last_user_turn_index_refuses_a_question_that_is_no_longer_last():
    from delphi_core.storage.base import last_user_turn_index

    messages = [
        {"role": "user", "content": "one", "requestId": "request_one000"},
        {"role": "assistant", "content": "a"},
        {"role": "user", "content": "two", "requestId": "request_two000"},
    ]
    assert last_user_turn_index(messages, "request_two000") == 2
    with pytest.raises(HTTPException) as moved:
        last_user_turn_index(messages, "request_one000")
    assert moved.value.status_code == 409
    with pytest.raises(HTTPException) as missing:
        last_user_turn_index([], "request_none00")
    assert missing.value.status_code == 404
    # A turn stored before requestIds existed is still the tail.
    assert last_user_turn_index(
        [{"role": "user", "content": "legacy"}], "request_edit01"
    ) == 0


def test_editing_the_last_question_discards_the_stale_answer(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from delphi_core.config import get_settings
    from delphi_core.main import app
    from delphi_core.routers import chat as chat_router

    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret", openai_api_key="test-key")
    real_client = httpx.AsyncClient
    monkeypatch.setattr(chat_router.httpx, "AsyncClient", lambda *args, **kwargs: real_client(
        *args, **{**kwargs, "transport": ProviderTransport(lambda request: httpx.Response(
            200, content=b'data: {"type": "response.output_text.delta", "delta": "An answer."}\n\n'))}))
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            conversation = conversation_params(client, "general")

            def ask(prompt, request_id, replace=None):
                payload = {
                    **conversation,
                    "prompt": prompt,
                    "request_id": request_id,
                }
                if replace:
                    payload["replace_request_id"] = replace
                with client.stream("POST", "/api/chat/stream", json=payload) as response:
                    assert response.status_code == 200
                    for _ in response.iter_lines():
                        pass

            ask("first question that is wrong", "request_first1")
            ask("corrected question", "request_second2", replace="request_first1")
            thread = client.get("/api/chat", params=conversation).json()
            assert [item["content"] for item in thread["messages"] if item["role"] == "user"] == [
                "corrected question"
            ]
            assert thread["messages"][0]["role"] == "user"
            assert thread["messages"][1]["role"] == "assistant"
            assert all(
                "first question that is wrong" not in (item.get("content") or "")
                for item in thread["messages"]
            )
    finally:
        app.dependency_overrides.clear()


def test_flex_stays_reachable_as_the_toggles_off_position():
    # Every account is standard by default, so this is no longer what a request
    # gets — it is what `service_tier_for` falls back to when a reader turns the
    # Settings toggle off, and an empty value still omits the key entirely for a
    # provider that has no tiers at all.
    settings = Settings()

    assert settings.openai_service_tier == "flex"
    assert settings.openai_request_timeout_seconds == 900.0


def test_responses_input_uses_low_detail_cache_breakpoint_and_bounded_history():
    body = ChatRequest(
        scope="document", prompt="What does the ablation establish?",
        paper_id="paper-one",
        selected_text="The result improves by 4.2 points.")
    history = [
        {"role": "user" if index % 2 == 0 else "assistant", "content": str(index),
         "requestId": f"r{index // 2}"}
        for index in range(24)
    ]

    request_input = build_responses_input(
        [({"id": "paper-one", "title": "Paper"}, "file-test")],
        history,
        body,
    )

    assert request_input[0]["content"][0] == {
        "type": "input_file",
        "file_id": "file-test",
        "detail": "low",
        "prompt_cache_breakpoint": {"mode": "explicit"},
    }
    # The history, then what is open, then the question.
    assert len(request_input[1:-2]) == 20
    assert request_input[1]["content"] == "4"
    assert request_input[-2]["content"][0]["text"].startswith(
        '<open_document paper_id="paper-one"'
    )
    assert "4.2 points" in request_input[-1]["content"]


def project_with_three_papers(tmp_path):
    settings = Settings(data_dir=tmp_path)
    storage = LocalStorage(settings)
    meta = storage.create_project("reader", "Project")
    for paper_id, title in (
        ("primary", "Primary paper"),
        ("comparison", "Comparison paper"),
        ("unused", "Unused paper"),
    ):
        seed_paper(
            settings,
            "reader",
            meta["id"],
            {"id": paper_id, "title": title, "filename": f"{paper_id}.pdf"},
        )
    return storage, storage.get_project("reader", meta["id"])


def test_only_current_paper_is_attached_by_default(tmp_path):
    storage, meta = project_with_three_papers(tmp_path)
    body = ChatRequest(scope="document", prompt="Summarize it.", paper_id="primary")

    _, papers = request_papers(storage, "reader", meta["id"], body)

    assert [paper["id"] for paper in papers] == ["primary"]


def test_only_current_and_explicit_references_are_attached(tmp_path):
    storage, meta = project_with_three_papers(tmp_path)
    body = ChatRequest(
        scope="document", prompt="How do the methods differ?",
        paper_id="primary",
        referenced_paper_ids=["comparison", "comparison", "primary"])

    _, papers = request_papers(storage, "reader", meta["id"], body)
    assert [paper["id"] for paper in papers] == ["primary", "comparison"]

    request_input = build_responses_input(
        [
            (papers[0], "file-primary"),
            (papers[1], "file-comparison"),
        ],
        [],
        body,
    )
    source_content = request_input[0]["content"]
    assert [
        item["file_id"]
        for item in source_content
        if item["type"] == "input_file"
    ] == [
        "file-primary",
        "file-comparison",
    ]
    assert source_content[0]["prompt_cache_breakpoint"] == {"mode": "explicit"}
    assert source_content[-1]["prompt_cache_breakpoint"] == {"mode": "explicit"}
    # Which is open and which was only named is said beside the question.
    turn = request_input[-2]["content"][0]["text"]
    assert turn.startswith('<open_document paper_id="primary" title="Primary paper"')
    assert 'also @-referenced "Comparison paper" (paper_id comparison)' in turn


def test_at_referencing_a_done_paper_is_refused(tmp_path):
    storage, meta = project_with_three_papers(tmp_path)
    storage.set_paper_done("reader", meta["id"], "comparison", True)
    body = ChatRequest(
        scope="document", prompt="How do the methods differ?",
        paper_id="primary",
        referenced_paper_ids=["comparison"])

    with pytest.raises(HTTPException) as error:
        request_papers(storage, "reader", meta["id"], body)
    assert error.value.status_code == 400


def test_a_done_papers_own_chat_still_works_and_can_reference_a_sibling(tmp_path):
    storage, meta = project_with_three_papers(tmp_path)
    storage.set_paper_done("reader", meta["id"], "primary", True)
    body = ChatRequest(
        scope="document", prompt="Summarize it.",
        paper_id="primary",
        referenced_paper_ids=["comparison"])

    _, papers = request_papers(storage, "reader", meta["id"], body)
    assert [paper["id"] for paper in papers] == ["primary", "comparison"]


def test_viewport_context_is_refused_by_pdf_paper_chat(tmp_path):
    storage, meta = project_with_three_papers(tmp_path)
    viewport = {
        "source": "anonymous",
        "kind": "html",
        "url": "https://example.com/thread",
    }

    with pytest.raises(HTTPException) as pdf_error:
        request_papers(
            storage,
            "reader",
            meta["id"],
            ChatRequest(scope="document", prompt="Question", paper_id="primary", viewport=viewport),
        )
    assert pdf_error.value.status_code == 400


def test_prompt_cache_can_be_disabled_for_compatible_providers():
    body = ChatRequest(scope="document", prompt="Question", paper_id="paper-one")
    request_input = build_responses_input(
        [({"id": "paper-one", "title": "Paper"}, "file-test")],
        [],
        body,
        prompt_cache_enabled=False,
    )

    assert "prompt_cache_breakpoint" not in request_input[0]["content"][0]


def test_prompt_cache_key_is_stable_and_scoped_to_the_current_paper():
    first_body = ChatRequest(scope="document", prompt="One", paper_id="paper-one")
    same_paper_with_reference = ChatRequest(
        scope="document", prompt="Two",
        paper_id="paper-one",
        referenced_paper_ids=["paper-two"])
    other_paper = ChatRequest(scope="document", prompt="Three", paper_id="paper-two")
    first = request_prompt_cache_key("reader", "project-one", first_body)

    assert first == request_prompt_cache_key(
        "reader",
        "project-one",
        same_paper_with_reference,
    )
    assert first != request_prompt_cache_key(
        "reader",
        "project-one",
        other_paper,
    )
    assert first != request_prompt_cache_key(
        "reader",
        "project-two",
        first_body,
    )
    assert first != request_prompt_cache_key(
        "other-reader",
        "project-one",
        first_body,
    )
    assert len(first) <= 64


def test_prompt_cache_key_changes_with_the_viewport_source_hash():
    first = ChatRequest(
        scope="document", prompt="Question",
        paper_id="paper-one",
        viewport={
            "source": "anonymous",
            "kind": "html",
            "url": "https://example.com/thread",
            "sourceHash": "a" * 64,
        })
    changed = ChatRequest(
        scope="document", prompt="Question",
        paper_id="paper-one",
        viewport={
            "source": "anonymous",
            "kind": "html",
            "url": "https://example.com/thread",
            "sourceHash": "b" * 64,
        })

    assert request_prompt_cache_key("reader", "project", first) != request_prompt_cache_key(
        "reader", "project", changed
    )


def test_responses_payload_uses_explicit_project_cache():
    settings = Settings(
        openai_prompt_cache_enabled=True,
        model_max_output_tokens=10_000,
    )
    body = ChatRequest(scope="document", prompt="Compare them.", paper_id="paper-one")
    sources = [
        ({"id": "paper-one", "title": "Paper one"}, "file-one"),
        ({"id": "paper-two", "title": "Paper two"}, "file-two"),
    ]

    payload = build_responses_payload(
        settings=settings,
        username="reader",
        project_id="project-one",
        project_skills="Explain intuition first.",
        sources=sources,
        previous_messages=[],
        body=body,
    )

    source_content = payload["input"][0]["content"]
    assert payload["prompt_cache_key"] == request_prompt_cache_key(
        "reader",
        "project-one",
        body,
    )
    assert payload["prompt_cache_options"] == {
        "mode": "explicit",
        "ttl": "30m",
    }
    # Standard is what an account gets by default; flex is what the Settings
    # toggle selects.
    assert payload["service_tier"] == "default"
    assert source_content[0]["prompt_cache_breakpoint"] == {"mode": "explicit"}
    assert source_content[-1]["prompt_cache_breakpoint"] == {"mode": "explicit"}
    assert source_content[1]["type"] == "input_text"
    # What counts as a project document is policy, so it is in the
    # instructions once rather than beside the evidence on every request.
    assert "Only library entries are documents in this project" in payload["instructions"]


def test_the_working_method_names_the_tools_offered_and_no_others():
    # The instructions and the `tools` array are one statement: a method that
    # named a tool the request lacks would send the model after a refusal.
    reading = profiles.CHAT_DOCUMENT.toolset(
        profiles.Turn(Settings(memory_enabled=False), web_documents=True)
    )
    method = working_method(reading)
    assert method.startswith("# How to find things")
    assert "read_webpage(doc_id, anchor)" in method and "search_library(" in method
    assert "read_paper" not in method and "open_memory" not in method
    assert working_method(profiles.CHAT_DOCUMENT.toolset(profiles.Turn(Settings(memory_enabled=False)))) == ""

    settings = Settings(memory_enabled=False)
    body = ChatRequest(scope="document", prompt="?", paper_id="one")
    payload = build_responses_payload(
        settings=settings, username="reader", project_id="p", project_skills="",
        sources=[({"id": "one", "title": "One"}, "file-one")],
        previous_messages=[], body=body,
        companions=[{"id": "two", "title": "Two"}],
    )
    offered = set(tool_names(payload))
    assert "read_paper(paper_id, pages)" in payload["instructions"]
    assert "read_webpage" not in offered and "read_webpage" not in payload["instructions"]


def test_responses_payload_omits_openai_cache_fields_when_disabled():
    settings = Settings(openai_prompt_cache_enabled=False)
    body = ChatRequest(scope="document", prompt="Question", paper_id="paper-one")

    payload = build_responses_payload(
        settings=settings,
        username="reader",
        project_id="project-one",
        project_skills="",
        sources=[({"id": "paper-one", "title": "Paper"}, "file-one")],
        previous_messages=[],
        body=body,
    )

    assert "prompt_cache_key" not in payload
    assert "prompt_cache_options" not in payload
    assert "prompt_cache_breakpoint" not in payload["input"][0]["content"][0]


def test_service_tier_can_be_omitted_for_compatible_providers():
    settings = Settings(openai_service_tier="")
    body = ChatRequest(scope="document", prompt="Question", paper_id="paper-one")

    payload = build_responses_payload(
        settings=settings,
        username="reader",
        project_id="project-one",
        project_skills="",
        sources=[({"id": "paper-one", "title": "Paper"}, "file-one")],
        previous_messages=[],
        body=body,
    )

    assert "service_tier" not in payload


def test_account_standard_tier_preference_overrides_flex():
    payload = build_responses_payload(
        settings=Settings(openai_service_tier="flex"),
        username="reader",
        project_id="project-one",
        project_skills="",
        sources=[({"id": "paper-one", "title": "Paper"}, "file-one")],
        previous_messages=[],
        body=ChatRequest(scope="document", prompt="Question", paper_id="paper-one"),
        use_standard_tier=True,
    )

    assert payload["service_tier"] == "default"


@pytest.mark.parametrize("scope", ["document", "general"])
def test_every_scope_carries_the_shared_evidence_requirements(scope):
    """
    Evidence discipline is not the persona's to decline, and not the scope's.

    It used to be the Researcher persona's body, so a reader who picked any other
    voice answered without it. It is one constant now, composed into both
    instruction paths — and there are two, selected by scope inside
    `build_responses_payload`, not by which router was called. Asserted per scope
    because the failure this guards against is exactly "added to one prompt and
    not the other", which every single-payload test would pass.
    """
    persona = resolve_persona_for_request(None, "reader", "adhd")
    payload = build_responses_payload(
        settings=Settings(),
        username="reader",
        project_id="" if scope == "general" else "project-one",
        project_skills=persona["content"],
        sources=[] if scope == "general" else [({"id": "p1", "title": "P"}, "f1")],
        previous_messages=[],
        body=ChatRequest(
            prompt="Does Table 3 isolate that?",
            scope=scope,
            paper_id=None if scope != "document" else "p1",
        ),
        persona=persona,
    )
    instructions = payload["instructions"]

    assert EVIDENCE_REQUIREMENTS in instructions
    # The three that were only ever in the retired persona. A paraphrase here
    # would pass against a prompt that dropped them, so these are the wording.
    assert "is not a finding" in instructions
    assert "correlation as causation" in instructions
    assert '"Not reported" is not "does not exist"' in instructions
    # Where a claim may come from is shared too, and each scope still keeps
    # the section on how its own request is laid out.
    assert "(Title, p. N) for a PDF, (Title, §anchor) for a web document" in instructions
    assert "[[slug]]" in instructions
    if scope == "general":
        assert "The first thing in this conversation is the whole index" in instructions
    else:
        assert "Only library entries are documents in this project" in instructions


def test_presentation_is_a_default_the_persona_sets_in_every_scope():
    """
    A prompt that mandated answer-first output of its own competed with
    Mentor's calibration and with a request for depth, so the same persona
    behaved differently depending on where the reader asked. Presentation is a
    default in both scopes, and the wrapper the persona arrives in says so.
    """
    persona = resolve_persona_for_request(None, "reader", "mentor")
    for scope, profile in (("document", profiles.CHAT_DOCUMENT), ("general", profiles.CHAT_GENERAL)):
        instructions = compose_instructions(scope, profile.toolset(profiles.Turn(Settings())), persona["content"])
        assert "# Presentation, by default" in instructions
        assert "the persona\nwins" in instructions
        assert "the presentation defaults above, which are its to set" in instructions
        assert persona["content"] in instructions


@pytest.mark.asyncio
async def test_response_stream_separates_answer_reasoning_and_tool_activity():
    events = [
        {"type": "response.created"},
        {"type": "response.reasoning_summary_text.delta", "delta": "Reading"},
        {"type": "response.reasoning_summary_text.delta", "delta": " section 3."},
        {"type": "response.reasoning_summary_part.done"},
        {
            "type": "response.output_item.added",
            "item": {"type": "web_search_call"},
        },
        {"type": "response.web_search_call.completed"},
        {"type": "response.output_text.delta", "delta": "Evidence"},
        {"type": "response.output_text.delta", "delta": " first."},
        {
            "type": "response.completed",
            "response": {
                "usage": {
                    "input_tokens": 32_000,
                    "input_tokens_details": {
                        "cached_tokens": 31_000,
                        "cache_write_tokens": 0,
                    },
                }
            },
        },
    ]
    content = "".join(f"data: {json.dumps(event)}\n\n" for event in events)
    response = httpx.Response(200, content=content.encode())

    chunks = [chunk async for chunk in parse_stream(response.aiter_lines())]

    # The provider's stream, in its own vocabulary, ending in how it ended.
    assert chunks[:-1] == [
        {"type": "opened"},
        {"type": "reasoning_delta", "text": "Reading"},
        {"type": "reasoning_delta", "text": " section 3."},
        {"type": "reasoning_break"},
        {"type": "item_added", "item": {"type": "web_search_call"}},
        {"type": "call_completed"},
        {"type": "text_delta", "text": "Evidence"},
        {"type": "text_delta", "text": " first."},
    ]
    result = chunks[-1]["result"]
    assert chunks[-1]["type"] == "terminal" and result.terminal is Terminal.COMPLETED
    assert (result.usage.input_tokens, result.usage.cached_tokens) == (32_000, 31_000)

    # And what the loop tells a reader's client about the same stream.
    settings = Settings(openai_api_key="test-key")
    async with httpx.AsyncClient(
        transport=ProviderTransport(lambda request: httpx.Response(200, content=content.encode()))
    ) as client:
        told = [
            event
            async for event in run_model_turns(
                client, {"input": [{"role": "user", "content": "Question"}]}, {}, {}, settings
            )
            if event["type"] not in {"trace", "turn_end"}
        ]
    assert told == [
        {"type": "reasoning", "text": "Reading"},
        {"type": "reasoning", "text": " section 3."},
        {"type": "reasoning_break"},
        {"type": "status", "text": "Searching the web"},
        {"type": "status", "text": ""},
        {"type": "delta", "text": "Evidence"},
        {"type": "delta", "text": " first."},
    ]


def test_web_search_is_always_offered_and_is_not_a_request_field():
    """
    The reader used to switch web search on per question. The model decides
    now, so the request has no say: every chat request offers the tool, and the
    old switch is refused rather than quietly ignored.
    """
    arguments = {
        "settings": Settings(),
        "username": "reader",
        "project_id": "project-one",
        "project_skills": "",
        "sources": [({"id": "paper-one", "title": "Paper"}, "file-one")],
        "previous_messages": [],
    }
    body = ChatRequest(scope="document", prompt="Question", paper_id="paper-one")

    payload = build_responses_payload(body=body, **arguments)

    # Function tools in the order to reach for them, the hosted one last.
    assert tool_names(payload) == [
        "open_memory", "grep_memory", "memory_links", "view_figure", "read_url", "web_search",
    ]
    assert payload["tools"][-1] == {"type": "web_search", "search_context_size": "medium"}
    # What the trace needs to say where a search looked.
    assert payload["include"] == ["reasoning.encrypted_content", "web_search_call.action.sources"]
    with pytest.raises(ValidationError):
        ChatRequest(scope="document", prompt="Question", paper_id="paper-one", web_search=True)

    # An operator whose provider has no hosted search turns it off for everyone.
    without = build_responses_payload(
        body=body, **{**arguments, "settings": Settings(web_search_enabled=False)}
    )
    assert "web_search" not in tool_names(without)
    assert without["include"] == ["reasoning.encrypted_content"]
    # The same in the account-wide scope: one task, one rule.
    general = build_responses_payload(
        body=ChatRequest(scope="general", prompt="Question"),
        **{**arguments, "sources": [], "project_id": ""},
    )
    assert tool_names(general)[-1] == "web_search"


def test_reasoning_summaries_are_requested():
    payload = build_responses_payload(
        settings=Settings(),
        username="reader",
        project_id="project-one",
        project_skills="",
        sources=[({"id": "paper-one", "title": "Paper"}, "file-one")],
        previous_messages=[],
        body=ChatRequest(scope="document", prompt="Question", paper_id="paper-one"),
    )

    assert payload["reasoning"] == {
        "effort": Settings().reasoning_effort_default,
        "summary": "auto",
    }


def test_offered_models_are_selectable_and_unknown_names_fall_back():
    settings = Settings(model_choices="gpt-6-luna,gpt-6-sol")

    assert settings.models == [settings.model_default, "gpt-6-luna", "gpt-6-sol"]
    assert resolve_model(settings, "gpt-6-sol") == "gpt-6-sol"
    assert settings.model_reasoning_efforts == {
        "gpt-6.1-sol": ["max", "xhigh", "high", "medium", "low"],
        "gpt-6-luna": ["max", "xhigh", "high", "medium", "low"],
        "gpt-6-sol": ["high", "medium", "low"],
    }
    assert resolve_model(settings, "gpt-4o") == settings.model_default
    assert resolve_model(settings, None) == settings.model_default


@pytest.mark.asyncio
async def test_openai_file_upload_is_cached_in_project_metadata(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        openai_api_key="test-key",
        openai_api_base_url="https://api.openai.test/v1",
    )
    storage = LocalStorage(settings)
    meta = storage.create_project("reader", "Project")
    paper = seed_paper(
        settings,
        "reader",
        meta["id"],
        {
            "id": "paper-one",
            "title": "Paper",
            "filename": "paper.pdf",
            "pages": 1,
            "tokens": 10,
        },
        pdf=b"%PDF-test",
    )
    uploads = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal uploads
        uploads += 1
        assert request.url.path == "/v1/files"
        assert request.headers["authorization"] == "Bearer test-key"
        return httpx.Response(200, json={"id": "file-cached"})

    objects = LocalObjectStore(settings.data_dir)
    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        first = await ensure_openai_files(
            client,
            storage,
            objects,
            "reader",
            meta["id"],
            [paper],
            settings,
        )
        # A second pass must reuse the cached id rather than upload again;
        # re-reading the paper proves the cache survived the first call.
        second = await ensure_openai_files(
            client,
            storage,
            objects,
            "reader",
            meta["id"],
            [storage.get_paper("reader", meta["id"], paper["id"])],
            settings,
        )

    assert first[0][1] == "file-cached"
    assert second[0][1] == "file-cached"
    assert uploads == 1
    saved = storage.get_project("reader", meta["id"])
    assert saved["papers"][0]["openaiFileId"] == "file-cached"


# --- web documents ----------------------------------------------------

SNAPSHOT = {
    "title": "Why We Think",
    "url": "https://lilianweng.github.io/posts/2025-05-01-thinking/",
    "fetchedAt": "2026-07-29T00:00:00+00:00",
    "wordCount": 8456,
    "sections": [
        {"anchor": "top", "title": "Why We Think", "level": 1, "words": 174,
         "markdown": "Test time compute has led to significant improvements."},
        {"anchor": "thinking-in-tokens", "title": "Thinking in Tokens", "level": 2,
         "words": 287, "markdown": "Sampling more tokens buys more computation."},
    ],
}
WEB_PAPER = {"id": "page-one", "kind": "web", "title": "Why We Think",
             "url": SNAPSHOT["url"]}


def test_a_web_document_is_attached_as_an_outline_not_as_text():
    """
    The point of the feature: a 8,456-word post costs a few hundred tokens per
    turn, and the body only arrives if the model asks for a section.
    """
    body = ChatRequest(scope="document", prompt="What is sequential revision?", paper_id="page-one")

    request_input = build_responses_input(
        [(WEB_PAPER, None)],
        [],
        body,
        True,
        {"page-one": SNAPSHOT},
    )
    attached = request_input[-2]["content"][0]["text"]

    # The outline rides beside the question with the document's identity, and
    # is called an outline: nothing claims the page is here whole.
    assert attached.startswith('<open_document paper_id="page-one"')
    assert "only its outline is in context" in attached
    assert 'Web document "Why We Think"' in attached
    assert "doc_id=page-one" in attached
    assert "thinking-in-tokens · Thinking in Tokens · 287w" in attached
    assert "Sampling more tokens" not in attached
    assert not any(
        block.get("type") == "input_file" for block in request_input[0]["content"]
    )


def test_the_reading_tool_is_offered_only_when_a_web_document_is_attached():
    settings = Settings()
    arguments = {
        "settings": settings,
        "username": "reader",
        "project_id": "project-one",
        "project_skills": "",
        "previous_messages": [],
        "body": ChatRequest(scope="document", prompt="Summarise.", paper_id="paper-one"),
    }

    pdf_only = build_responses_payload(
        sources=[({"id": "paper-one", "title": "Paper"}, "file-one")], **arguments
    )
    with_web = build_responses_payload(
        sources=[(WEB_PAPER, None)],
        web_documents={"page-one": SNAPSHOT},
        **{**arguments, "body": ChatRequest(scope="document", prompt="Summarise.", paper_id="page-one")},
    )

    # A PDF-only question still gets Memory tools (always on); it does not
    # get a document-reading tool until a web document is in play.
    pdf_names = tool_names(pdf_only)
    assert pdf_names == [
        "open_memory",
        "grep_memory",
        "memory_links",
        "view_figure",
        "read_url",
        "web_search",
    ]
    assert "read_webpage" not in pdf_names
    offered = tool_names(with_web)
    assert "read_webpage" in offered
    # Discovery travels with the reading tool and never without it: a model
    # given search results it has no way to open would cite what it never read.
    assert "search_library" in offered
    assert "open_memory" in offered
    # One order in every request: what reads the documents, then Memory, then the web.
    assert offered == [
        "read_webpage", "search_library", "open_memory", "grep_memory",
        "memory_links", "view_figure", "read_url", "web_search",
    ]


def test_reading_a_section_returns_only_that_section():
    result = read_webpage(
        "page-one", "thinking-in-tokens",
        {"page-one": SNAPSHOT},
        {"page-one": "Why We Think"},
        24_000,
    )

    assert "Sampling more tokens buys more computation." in result
    assert "Test time compute has led" not in result
    # A read says whose text it is, by the id the library lists it under.
    assert result.startswith('From "Why We Think" (paper_id page-one · web page · ')


def test_a_long_section_is_truncated_with_a_way_forward():
    long_snapshot = {
        **SNAPSHOT,
        "sections": [{**SNAPSHOT["sections"][1], "markdown": "word " * 5_000}],
    }

    result = read_webpage(
        "page-one", "thinking-in-tokens",
        {"page-one": long_snapshot},
        {"page-one": "Why We Think"},
        500,
    )

    assert len(result) < 800
    assert "narrower anchor" in result


def test_an_unknown_anchor_answers_with_the_ones_that_exist():
    """A tool error should make the model retry, not take the answer down."""
    result = read_webpage(
        "page-one", "does-not-exist",
        {"page-one": SNAPSHOT},
        {"page-one": "Why We Think"},
        24_000,
    )

    assert result.startswith("Error:")
    assert "thinking-in-tokens" in result


def test_an_unattached_document_cannot_be_read():
    result = read_webpage(
        "someone-elses-page", "top",
        {"page-one": SNAPSHOT},
        {"page-one": "Why We Think"},
        24_000,
    )

    assert result.startswith("Error: no web document")


def test_arguments_a_tool_cannot_use_are_refused_in_prose_before_it_runs():
    """
    A tool's `Arguments` is the one statement of what it takes. The dispatcher
    parses a call against it, and a call that does not fit never reaches the
    tool: the model is told which argument was wrong and what the tool takes.
    """
    from delphi_core.harness.registry import DEFAULTS, _unusable

    def refusal(tool: str, arguments: str) -> str:
        try:
            DEFAULTS[tool].arguments.model_validate_json(arguments)
        except ValidationError as refused:
            return _unusable(DEFAULTS[tool], refused)
        raise AssertionError(f"{tool} accepted {arguments}")

    assert refusal("read_webpage", "{not json") == "Error: arguments were not valid JSON."
    missing = refusal("read_webpage", json.dumps({"doc_id": "page-one"}))
    assert missing.startswith("Error: read_webpage cannot use these arguments. `anchor`: Field required.")
    assert missing.endswith("It takes: doc_id, anchor.")
    assert "`pages.1`" in refusal("read_paper", json.dumps({"paper_id": "p", "pages": [1, "two"]}))
    assert "`pages`" in refusal("read_paper", json.dumps({"paper_id": "p", "pages": [1, 2, 3, 4, 5]}))
    assert "`hops`" in refusal("memory_links", json.dumps({"slug": "kv-cache", "hops": 3}))
    # An argument the schema does not name is refused too, not passed along.
    assert "`scope`" in refusal("search_library", json.dumps({"query": "x", "scope": "account"}))


@pytest.mark.asyncio
async def test_a_round_is_handed_everything_the_model_produced_in_the_one_before():
    """
    The answer that announced its plan three times: each round was given the
    calls and nothing else, so the model never knew it had already spoken or
    what it had concluded. Reasoning goes back sealed, the message as written,
    and neither with an id the provider never stored.
    """
    settings = Settings(openai_api_key="test-key")
    turns: list[dict] = []

    def transcript(events: list[dict]) -> bytes:
        return "".join(f"data: {json.dumps(e)}\n\n" for e in events).encode()

    def done(item: dict) -> dict:
        return {"type": "response.output_item.done", "item": item}

    def handler(request: httpx.Request) -> httpx.Response:
        turns.append(json.loads(request.content))
        if len(turns) == 1:
            return httpx.Response(200, content=transcript([
                done({"type": "reasoning", "id": "rs_1", "summary": [],
                      "encrypted_content": "sealed"}),
                {"type": "response.output_text.delta", "delta": "I'll read the section."},
                done({"type": "message", "id": "msg_1", "role": "assistant",
                      "status": "completed", "phase": "commentary",
                      "content": [{"type": "output_text", "annotations": [],
                                   "text": "I'll read the section."}]}),
                done({"type": "reasoning", "id": "rs_2", "summary": []}),
                done({"type": "function_call", "id": "fc_1", "call_id": "call-1",
                      "name": "read_webpage",
                      "arguments": json.dumps({"doc_id": "page-one",
                                               "anchor": "thinking-in-tokens"})}),
            ]))
        return httpx.Response(200, content=transcript([
            {"type": "response.output_text.delta", "delta": "It samples more."},
        ]))

    payload = build_responses_payload(
        settings=settings,
        username="reader",
        project_id="project-one",
        project_skills="",
        sources=[(WEB_PAPER, None)],
        web_documents={"page-one": SNAPSHOT},
        previous_messages=[],
        body=ChatRequest(scope="document", prompt="Why more tokens?", paper_id="page-one"),
    )
    assert payload["include"][0] == "reasoning.encrypted_content"

    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        events = [
            event
            async for event in run_model_turns(
                client, payload, {"page-one": SNAPSHOT},
                {"page-one": "Why We Think"}, settings,
            )
        ]

    assert turns[1]["input"][len(turns[0]["input"]):] == [
        {"type": "reasoning", "summary": [], "encrypted_content": "sealed"},
        {"type": "message", "role": "assistant", "phase": "commentary",
         "content": [{"type": "output_text", "text": "I'll read the section."}]},
        # The reasoning item that came back unsealed cannot be handed back.
        {"type": "function_call", "call_id": "call-1", "name": "read_webpage",
         "arguments": json.dumps({"doc_id": "page-one", "anchor": "thinking-in-tokens"})},
        turns[1]["input"][-1],
    ]
    assert turns[1]["input"][-1]["type"] == "function_call_output"
    # What was said before the read stays in the answer, as its own paragraph.
    assert "".join(e["text"] for e in events if e["type"] == "delta") == (
        "I'll read the section.\n\nIt samples more."
    )


@pytest.mark.asyncio
async def test_a_function_call_is_answered_and_replayed_into_the_next_request():
    """
    `store: False` means the provider remembers nothing between requests, so the
    model's own call has to be echoed back alongside our answer to it or the
    second turn has no idea a page was ever read.
    """
    settings = Settings(openai_api_key="test-key")
    turns: list[dict] = []

    def transcript(events: list[dict]) -> bytes:
        return "".join(f"data: {json.dumps(e)}\n\n" for e in events).encode()

    def handler(request: httpx.Request) -> httpx.Response:
        turns.append(json.loads(request.content))
        if len(turns) == 1:
            return httpx.Response(200, content=transcript([
                {"type": "response.output_item.added",
                 "item": {"type": "function_call", "name": "read_webpage"}},
                {"type": "response.output_item.done",
                 "item": {"type": "function_call", "call_id": "call-1",
                          "name": "read_webpage",
                          "arguments": json.dumps({"doc_id": "page-one",
                                                   "anchor": "thinking-in-tokens"})}},
            ]))
        return httpx.Response(200, content=transcript([
            {"type": "response.output_text.delta", "delta": "It samples more."},
        ]))

    payload = build_responses_payload(
        settings=settings,
        username="reader",
        project_id="project-one",
        project_skills="",
        sources=[(WEB_PAPER, None)],
        web_documents={"page-one": SNAPSHOT},
        previous_messages=[],
        body=ChatRequest(scope="document", prompt="Why more tokens?", paper_id="page-one"),
    )

    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        events = [
            event
            async for event in run_model_turns(
                client, payload, {"page-one": SNAPSHOT},
                {"page-one": "Why We Think"}, settings,
            )
        ]

    assert len(turns) == 2
    assert {"type": "status", "text": "Reading the page"} in events
    assert {"type": "delta", "text": "It samples more."} in events
    # No output item reaches the browser; the reader sees a status line only.
    assert not any(event["type"] == "item" for event in events)

    replayed = turns[1]["input"][-2:]
    assert replayed[0]["type"] == "function_call"
    assert replayed[0]["call_id"] == "call-1"
    assert replayed[1]["type"] == "function_call_output"
    assert "Sampling more tokens" in replayed[1]["output"]


@pytest.mark.asyncio
async def test_the_last_round_keeps_its_tools_and_may_call_none():
    """
    Otherwise a model that keeps asking spends its final request on a call it
    will never be given, and the reader is left with no answer at all.

    The tools used to be deleted from that request. That cost the cached prefix
    on the turn's largest request, and left instructions describing tools the
    request no longer carried. The closing round is the same request, told it
    may call nothing.
    """
    settings = Settings(openai_api_key="test-key", model_tool_max_rounds=2)
    turns: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        turns.append(json.loads(request.content))
        events = [
            {"type": "response.output_item.done",
             "item": {"type": "function_call", "call_id": f"call-{len(turns)}",
                      "name": "read_webpage",
                      "arguments": json.dumps({"doc_id": "page-one", "anchor": "top"})}},
        ]
        return httpx.Response(
            200, content="".join(f"data: {json.dumps(e)}\n\n" for e in events).encode()
        )

    payload = build_responses_payload(
        settings=settings,
        username="reader",
        project_id="project-one",
        project_skills="",
        sources=[(WEB_PAPER, None)],
        web_documents={"page-one": SNAPSHOT},
        previous_messages=[],
        body=ChatRequest(scope="document", prompt="Read everything.", paper_id="page-one"),
    )

    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        async for _ in run_model_turns(
            client, payload, {"page-one": SNAPSHOT},
            {"page-one": "Why We Think"}, settings,
        ):
            pass

    assert len(turns) == 3  # two rounds that may call a tool, then the closing one
    assert turns[-1]["tools"] == turns[0]["tools"]
    assert turns[-1]["instructions"] == turns[0]["instructions"]
    assert turns[-1]["tool_choice"] == "none"
    assert all("tool_choice" not in turn for turn in turns[:-1])
    assert "tool allowance is finished" in turns[-1]["input"][-1]["content"]


@pytest.mark.asyncio
async def test_abandoning_the_answer_hangs_up_on_the_provider():
    """
    Stop has to cost the reader nothing beyond what has already been generated.
    A disconnect cancels the SSE generator mid-yield, and the only thing that
    turns that into an actual stop is the `async with client.stream(...)`
    unwinding and closing the connection — the provider bills a streamed
    response until the socket goes away. Recording a cancelled turn without
    hanging up would be a button that lies.
    """
    settings = Settings(openai_api_key="test-key")

    class Endless(httpx.AsyncByteStream):
        def __init__(self) -> None:
            self.closed = False

        async def __aiter__(self):
            while True:
                yield (
                    b'data: {"type": "response.output_text.delta", '
                    b'"delta": "and then "}\n\n'
                )
                await asyncio.sleep(0)

        async def aclose(self) -> None:
            self.closed = True

    upstream = Endless()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=upstream)

    payload = build_responses_payload(
        settings=settings,
        username="reader",
        project_id="project-one",
        project_skills="",
        sources=[(WEB_PAPER, None)],
        web_documents={"page-one": SNAPSHOT},
        previous_messages=[],
        body=ChatRequest(scope="document", prompt="Keep going forever.", paper_id="page-one"),
    )

    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        turns = run_model_turns(
            client, payload, {"page-one": SNAPSHOT},
            {"page-one": "Why We Think"}, settings,
        )
        async for event in turns:
            if event["type"] == "delta":
                break
        assert not upstream.closed
        await turns.aclose()

    assert upstream.closed


# --- Memory in a chat request -------------------------------


PAGES = [
    {
        "slug": "attention",
        "kind": "concept",
        "domain": "ml",
        "title": "attention",
        "summary": "Has implemented it.",
        "linkDegree": 2,
    },
    {
        "slug": "amortized-inference",
        "kind": "concept",
        "domain": "ml",
        "title": "amortized inference",
        "summary": "named in the VAE paper, never covered",
        "linkDegree": 1,
    },
    {
        "slug": "switchbacks",
        "kind": "concept",
        "domain": "hiking",
        "title": "switchbacks",
        "summary": "unrelated interest",
        "linkDegree": 0,
    },
    {
        "slug": "diffusion-models",
        "kind": "concept",
        "domain": "ml",
        "title": "diffusion models",
        "summary": "score matching and denoising",
        "linkDegree": 3,
    },
]


def test_memory_tools_are_offered_to_every_persona_when_the_base_is_on():
    settings = Settings(model_max_output_tokens=10_000)
    body = ChatRequest(scope="document", prompt="Explain this.", paper_id="paper-one")
    sources = [({"id": "paper-one", "title": "Paper"}, "file-one")]

    def payload_for(persona):
        return build_responses_payload(
            settings=settings,
            username="reader",
            project_id="project-one",
            project_skills="",
            sources=sources,
            previous_messages=[],
            body=body,
            persona=persona,
        )

    for persona in (
        {"id": "researcher"},
        {"id": "tutor"},
        None,
    ):
        assert tool_names(payload_for(persona)) == [
            "open_memory",
            "grep_memory",
            "memory_links",
            "view_figure",
            "read_url",
            "web_search",
        ]

    def without(**switches):
        return build_responses_payload(
            settings=Settings(model_max_output_tokens=10_000, **switches),
            username="reader",
            project_id="project-one",
            project_skills="",
            sources=sources,
            previous_messages=[],
            body=body,
            persona={"id": "researcher"},
        )

    # Each switch removes its own tools and nothing else; with both off the
    # key is omitted, never sent empty (invariant 12). `view_figure` stays while
    # a source read can list figures.
    assert tool_names(without(memory_enabled=False)) == ["view_figure", "read_url", "web_search"]
    assert "tools" not in without(memory_enabled=False, web_search_enabled=False)


def test_the_reader_block_sits_after_the_cached_source_prefix():
    settings = Settings(model_max_output_tokens=10_000)
    block = reader_memory_block("=== [[attention]] ml/concept/attention — attention ===\nHas implemented it.")

    payload = build_responses_payload(
        settings=settings,
        username="reader",
        project_id="project-one",
        project_skills="",
        sources=[({"id": "paper-one", "title": "Paper"}, "file-one")],
        previous_messages=[{"role": "user", "content": "Earlier question"}],
        body=ChatRequest(scope="document", prompt="Explain this.", paper_id="paper-one"),
        persona={"id": "researcher"},
        memory_block=block,
    )

    blocks = payload["input"]
    text = blocks[-2]["content"][0]["text"]
    # Second to last: after the documents and the history, immediately before
    # the question. Any earlier and what was chosen for one question — which
    # changes every turn — invalidates every cached PDF and digest block.
    assert text.startswith("<reader_memory>") and "Has implemented it." in text
    assert blocks[-1]["content"].startswith("Explain this.")
    assert "<reader_memory>" not in json.dumps(blocks[0])
    # The instructions say what the block is and how to walk on from it; they
    # never carry it.
    assert "Has implemented it." not in payload["instructions"]
    assert "open_memory(slugs)" in payload["instructions"]
    # Nothing a chat can call writes Memory.
    assert "write_knowledge" not in tool_names(payload)
    assert "write_knowledge" not in payload["instructions"]


def chooser(slugs, turns=None, status=200):
    """A provider that answers the Memory selection call with these slugs."""

    def handler(request: httpx.Request) -> httpx.Response:
        if turns is not None:
            turns.append(json.loads(request.content))
        return httpx.Response(status, json={"output": [{"type": "message", "content": [
            {"type": "output_text", "text": json.dumps({"slugs": slugs})}]}]})

    return ProviderTransport(handler)


@pytest.mark.asyncio
async def test_a_project_question_is_handed_the_memory_pages_a_model_chose(tmp_path):
    """
    Memory reaches a Project question the way it reaches a Memory one: a model
    reads the whole index and chooses by meaning. The pages it chose are opened
    into the request, so the answer spends no round fetching them.
    """
    settings, storage, project = memory_store(tmp_path)
    settings = Settings(data_dir=tmp_path, openai_api_key="test-key")
    for row in (
        {"kind": "domain", "domain": "ml", "title": "ML", "slug": "ml", "summary": "The domain.", "body": "Domain page."},
        {"kind": "concept", "domain": "ml", "title": "KV cache", "summary": "Reusing attention state.",
         "body": "Prefix reuse. See [[radix-attention]]."},
        {"kind": "concept", "domain": "ml", "title": "Radix attention", "summary": "A shared-prefix tree.",
         "body": "Requests that share a prefix share its state."},
        {"kind": "source", "domain": "ml", "title": "Held paper", "summary": "Its digest.",
         "body": "The digest.", "sourcePaperId": "held"},
        {"kind": "source", "domain": "ml", "title": "Companion paper", "summary": "Its digest.",
         "body": "The companion's digest.", "sourcePaperId": "companion"},
    ):
        storage.upsert_memory_page("reader", row, max_pages=50)
    held = [{"id": "held", "title": "Held paper"}, {"id": "companion", "title": "Companion paper"}]
    body = ChatRequest(scope="document", prompt="How do I make serving faster?", paper_id="held")
    turns: list[dict] = []

    async with httpx.AsyncClient(
        transport=chooser(["ml/concept/kv-cache", "companion-paper", "ml", "no-such-page"], turns)
    ) as client:
        memory = await select_reader_memory(
            client, storage, "reader", settings, body,
            [{"role": "user", "content": "What is batching?"}],
            open_paper=held[0], held=held, objects=LocalObjectStore(tmp_path),
        )
    block = memory.block
    # What was handed over and how much it was chosen from are returned, so
    # the answer's trace can record both. The open document's own page leads.
    assert memory.opened == ["held-paper", "kv-cache", "ml"] and memory.available
    assert memory.index["pages"] == 5 and "conversations" not in memory.index

    request = turns[0]
    # The whole index first, as that call's cached prefix; the question after.
    index = request["input"][0]["content"][0]
    assert index["text"].startswith("<memory_index>") and "radix-attention" in index["text"]
    assert index["prompt_cache_breakpoint"] == {"mode": "explicit"}
    turn = request["input"][1]["content"]
    assert "How do I make serving faster?" in turn and "What is batching?" in turn
    assert 'The reader has open: "Held paper"' in turn
    assert request["text"]["format"]["name"] == "memory_selection"

    text = block["content"][0]["text"]
    assert text.startswith("<reader_memory>")
    # Chosen by the model, opened by us, in full — with what the page rests on
    # and the start of what it links to.
    assert "=== [[kv-cache]]" in text and "Prefix reuse." in text
    assert "Reader: not drawn from a document" in text
    assert "[[radix-attention]]" in text
    # A domain page the model chose is handed over like any page.
    assert "=== [[ml]] ml/domain/ml" in text and "Domain page." in text
    # What the request already carries and a page that does not exist are
    # refused here, whatever the model said: of the documents it carries, only
    # the open one's page is opened, as where the answer starts from.
    assert "=== [[companion-paper]]" not in text and text.count("=== [[held-paper]]") == 1
    assert "no-such-page" not in text


@pytest.mark.asyncio
async def test_a_failed_memory_selection_never_fails_the_answer(tmp_path, monkeypatch):
    settings, storage, project = memory_store(tmp_path)
    settings = Settings(data_dir=tmp_path, openai_api_key="test-key")
    body = ChatRequest(scope="document", prompt="?", paper_id="p")
    arguments = dict(open_paper=None, held=[], objects=LocalObjectStore(tmp_path))

    async def said(transport, storage=storage, settings=settings):
        async with httpx.AsyncClient(transport=transport) as client:
            memory = await select_reader_memory(
                client, storage, "reader", settings, body, [], **arguments
            )
        text = memory.block["content"][0]["text"]
        assert memory.opened == []
        # Only a selection that could not be made is recorded as a failure.
        assert memory.available is ("could not be consulted" not in text)
        return text

    # The instructions name this block whenever the Memory tools are offered,
    # so it exists whenever they are, and says which of three things is true.
    assert "has no pages yet" in await said(chooser(["x"]))

    storage.upsert_memory_page(
        "reader",
        {"kind": "concept", "domain": "ml", "title": "KV cache", "summary": "s", "body": "b"},
        max_pages=50,
    )
    # A considered "none" and a selection that could not be made are different
    # statements: only the second leaves Memory unexamined.
    assert "Nothing in the reader's Memory was chosen" in await said(chooser([]))
    assert "could not be consulted" in await said(chooser(["kv-cache"], status=500))

    # One limit on the whole exchange, not one per phase of it.
    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.2)
        return httpx.Response(200, json={"output": []})

    hurried = Settings(
        data_dir=tmp_path, openai_api_key="test-key", memory_select_timeout_seconds=0.02
    )
    assert "could not be consulted" in await said(ProviderTransport(slow), settings=hurried)

    # Not only the call: a fault opening the chosen pages is survived too.
    import delphi_core.routers.chat as chat_module

    def broken(*args, **kwargs):
        raise RuntimeError("storage fault")

    monkeypatch.setattr(chat_module, "open_chosen_memory", broken)
    assert "could not be consulted" in await said(chooser(["kv-cache"]))

    off = Settings(data_dir=tmp_path, openai_api_key="test-key", memory_enabled=False)
    async with httpx.AsyncClient(transport=chooser(["x"])) as client:
        assert (await select_reader_memory(
            client, storage, "reader", off, body, [], **arguments
        )).block is None


def test_the_cache_key_moves_with_the_persona_but_not_with_memory():
    body = ChatRequest(scope="document", prompt="Explain.", paper_id="paper-one")
    researcher = {"id": "researcher", "revision": 0}
    tutor = {"id": "tutor", "revision": 0}
    edited = {"id": "a1b2c3d4e5f6", "revision": 4}

    key = lambda persona: request_prompt_cache_key(
        "reader", "project-one", body, persona
    )

    assert key(researcher) != key(tutor)
    # A revision bump is a different prefix, so it gets its own lineage.
    assert key(edited) != key({"id": "a1b2c3d4e5f6", "revision": 5})
    # Memory is not an input here on purpose: it changes almost every turn, and
    # keying on it would mint a fresh key per turn and miss the whole prefix.
    assert key(tutor) == key({"id": "tutor", "revision": 0, "unused": "x"})


def test_two_conversations_in_one_project_do_not_share_a_cache_lineage():
    """
    A persona used to be a project setting, so every conversation in a project
    resolved the same one and one key per project was right. Two conversations
    can now be held in two personas at once, and their prefixes differ — so a
    shared key would serve one conversation's cached instructions to the other.
    """
    document = ChatRequest(scope="document", prompt="Explain.", paper_id="paper-one")
    mentor = {"id": "mentor", "revision": 0}
    tutor = {"id": "tutor", "revision": 0}

    assert request_prompt_cache_key(
        "reader", "project-one", document, mentor
    ) != request_prompt_cache_key("reader", "project-one", document, tutor)


def test_a_deleted_persona_falls_back_rather_than_failing_a_conversation(tmp_path):
    """
    A persona a conversation names can now be deleted, so a stored id can
    dangle. Resolving one has to fall back, or that thread stops answering for
    good — while an id named explicitly in a live request is still a 404,
    because that one is a mistake the caller can fix.
    """
    from delphi_core.personas import DEFAULT_PERSONA_KEY, resolve_persona_or_default

    settings = Settings(data_dir=tmp_path)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    persona = storage.create_persona(
        "reader",
        {"name": "Gone", "element": "stone", "content": "Ask why."},
    )

    assert resolve_persona_or_default(storage, "reader", persona["id"])["content"] == (
        "Ask why."
    )

    storage.delete_persona("reader", persona["id"])

    assert resolve_persona_or_default(storage, "reader", persona["id"])["id"] == (
        DEFAULT_PERSONA_KEY
    )
    # Never chosen resolves the same way, so a fresh conversation and one whose
    # persona was deleted answer identically rather than one of them failing.
    assert resolve_persona_or_default(storage, "reader", None)["id"] == (
        DEFAULT_PERSONA_KEY
    )
    with pytest.raises(HTTPException) as refused:
        resolve_persona_for_request(storage, "reader", persona["id"])
    assert refused.value.status_code == 404


def memory_store(tmp_path):
    settings = Settings(data_dir=tmp_path)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    project = storage.create_project("reader", "Teaching")
    return settings, storage, project


def memory_of_two_related_documents(tmp_path):
    settings, storage, project = memory_store(tmp_path)
    for row in (
        {"kind": "domain", "domain": "ml", "title": "ML", "slug": "ml", "summary": "The domain.", "body": "Domain page."},
        {"kind": "concept", "domain": "ml", "title": "KV cache", "summary": "Reusing attention state.",
         "body": "Intro.\nThe key-value cache stores past keys.\nSee [[ml]] and [[prefix-sharing]]."},
        {"kind": "source", "domain": "ml", "title": "Paper A", "summary": "First paper.",
         "body": "Uses the [[kv-cache]].\nFiled under [[ml]]."},
        {"kind": "source", "domain": "ml", "title": "Paper B", "summary": "Second paper.",
         "body": "Also a KV-cache design: [[kv-cache]] and [[ml]]."},
        {"kind": "source", "domain": "ml", "title": "Paper C", "summary": "Unrelated.", "body": "Only [[ml]]."},
        {"kind": "concept", "domain": "systems", "title": "Paging", "summary": "Swapping memory.", "body": "Open."},
    ):
        storage.upsert_memory_page("reader", row, max_pages=50)
    return settings, storage


def test_grep_memory_returns_lines_not_pages(tmp_path):
    settings, storage = memory_of_two_related_documents(tmp_path)

    def ask(pattern, glob=""):
        return grep_memory(pattern, glob, storage, "reader", settings)

    answer, shown = ask("kv.?cache|key-value cache")
    # Most matching lines first; the body is quoted by line, never whole.
    assert shown[0] == "kv-cache" and set(shown) == {"kv-cache", "paper-a", "paper-b"}
    assert "line 2: The key-value cache stores past keys." in answer
    assert "Intro." not in answer
    assert ask("kv.?cache", "*/source/*")[1] == ["paper-a", "paper-b"]
    nothing, shown = ask("volcanology")
    assert nothing.startswith("No Memory page contains") and shown == []
    # A pattern that does not compile is a phrase; one that could backtrack
    # badly is never run as an expression.
    assert memory_grep_matcher("[[ml")[1] is True
    assert "paper-c" in ask("[[ml")[1]
    assert memory_grep_matcher("(a+)+$")[1] is True
    assert memory_grep_matcher("a.*b.*c.*d")[1] is True
    assert memory_grep_matcher("kv.?cache|prefix")[1] is False


def test_memory_links_walks_two_hops_around_the_domain_page(tmp_path):
    settings, storage = memory_of_two_related_documents(tmp_path)

    def ask(slug, hops, through_domains=False):
        return memory_links(slug, hops, storage, "reader", settings, through_domains=through_domains)

    near, shown = ask("paper-a", 1)
    assert shown == ["kv-cache", "ml"]
    assert "→ ml/concept/kv-cache — KV cache" in near and "Two links away" not in near
    far, shown = ask("ml/source/paper-a", 2)
    # Paper B shares the concept; Paper C shares only the domain, and is not
    # reached, because maintenance's walk never goes through a domain page.
    assert shown == ["kv-cache", "ml", "paper-b"]
    assert "ml/source/paper-b — Paper B — via [[kv-cache]]" in far
    assert "domain page, not walked through" in far and "paper-c" not in far
    # A chat's walk goes through it, since a domain page says how its pages relate.
    walked, shown = ask("ml/source/paper-a", 2, through_domains=True)
    assert shown == ["kv-cache", "ml", "paper-b", "paper-c"]
    assert "ml/source/paper-c — Paper C — via [[ml]]" in walked and "not walked through" not in walked
    # Chat's profiles offer that walk; maintenance's keep the rule.
    context = ToolContext(settings=settings, username="reader", storage=storage)
    walks_through = {}
    for profile in (profiles.CHAT_DOCUMENT, profiles.CHAT_GENERAL, profiles.MEMORY_MAINTAIN, profiles.MEMORY_DOMAIN):
        [tool] = [tool for tool in profile.toolset(profiles.Turn(settings)).tools if tool.name == "memory_links"]
        walks_through[profile.name] = "paper-c" in asyncio.run(tool.run(tool.arguments(slug="paper-a", hops=2), context)).text
    assert walks_through == {"chat.document": True, "chat.general": True, "memory.maintain": False, "memory.domain": False}
    # A link with no page behind it is not listed, and a name with no page
    # has no links to show, whoever names it.
    concept, shown = ask("kv-cache", 1)
    assert "prefix-sharing" not in concept and "← ml/source/paper-a" in concept
    assert "prefix-sharing" not in shown
    for missing in ("nowhere", "prefix-sharing"):
        answer, shown = ask(missing, 1)
        assert answer.startswith("No page exists") and shown == []


def test_what_chat_is_told_about_memory_names_only_the_kinds_that_exist():
    from delphi_core.harness.tools import memory_links as links_tool
    from delphi_core.memory_harness import MEMORY_SELECTION_INSTRUCTIONS

    for text in (MEMORY_SELECTION_INSTRUCTIONS, links_tool.tool().description, links_tool.tool().guidance):
        words = set(re.findall(r"[a-z]+", text.lower()))
        assert not words & {"gap", "gaps", "synthesis"}
    for kind in ("`source`", "`concept`", "domain page"):
        assert kind in MEMORY_SELECTION_INSTRUCTIONS


def test_every_scope_reaches_memory_with_the_same_tools():
    settings = Settings()
    general = [
        tool.get("name") or tool["type"]
        for tool in toolset_for_scope(settings, ChatRequest(scope="general", prompt="?")).specs()
    ]
    # No word search and no browse in any scope: pages are chosen by a model
    # that read the index, then opened, and looked up only for what an index
    # cannot show.
    memory = ["open_memory", "grep_memory", "memory_links", "view_figure"]
    assert general == ["read_paper", "read_webpage", "search_library", *memory, "read_url", "web_search"]
    document = [
        tool.get("name") or tool["type"]
        for tool in toolset_for_scope(
            settings, ChatRequest(scope="document", prompt="?", paper_id="p")
        ).specs()
    ]
    assert document == [*memory, "read_url", "web_search"]
    assert not {"search_knowledge", "read_knowledge"} & set(general + document)
    # No scope can write Memory from a conversation. With the web always in
    # reach, a tool that did could be called by text a page had planted.
    assert "write_knowledge" not in general + document


def test_an_open_document_reaches_the_general_scope_as_its_digest_before_the_block():
    paper = {"id": "p1", "title": 'The "Open" Paper'}
    block = open_document_block(paper, {"contentMarkdown": "Summary."})
    text = block["content"][0]["text"]
    assert text.startswith('<open_document paper_id="p1"') and '<research_digest paper_id="p1"' in text
    assert "No research digest" in open_document_block(paper, None)["content"][0]["text"]

    request_input = tail_input(
        [{"role": "user", "content": "earlier", "requestId": "r1"},
         {"role": "assistant", "content": "answer", "requestId": "r1"}],
        {"role": "user", "content": "<reader_memory>…"},
        "What is new here?",
        "a quoted line",
        turn_context=block,
    )
    # Invariant 39 holds with a document in the turn: the block is still second
    # to last, and the document sits ahead of it.
    assert request_input[-3] is block
    assert "<reader_memory>" in request_input[-2]["content"]
    assert "a quoted line" in request_input[-1]["content"]


def test_the_general_scope_takes_an_open_document_whole_or_not_at_all():
    assert ChatRequest(scope="general", prompt="?", project_id="proj", paper_id="p1").paper_id == "p1"
    for partial in ({"project_id": "proj"}, {"paper_id": "p1"}):
        with pytest.raises(ValueError):
            ChatRequest(scope="general", prompt="?", **partial)
    with pytest.raises(ValueError):
        ChatRequest(scope="general", prompt="?", referenced_paper_ids=["p2"])


# --- Cached-prefix snapshots -------------------------------------------------
#
# These two exist to catch the one regression that no other test in this file
# would notice and that production reports only as a cost line: a reordering,
# a re-wording, or an extra block in the part of the request that sits *before*
# the cache breakpoint. Invariant 12 calls the prefix an architectural asset;
# these assert its exact shape so that changing it has to be a deliberate act
# accompanied by a `PROMPT_CACHE_VERSION` bump, rather than a silent side
# effect of refactoring the three chats onto one code path.
#
# They deliberately snapshot *structure and order*, not prose: the library's
# wording is allowed to change, but where it sits and what surrounds it is not.


def prefix_shape(request_input):
    """The part of a request the provider is asked to cache, as a shape."""
    shape = []
    for item in request_input:
        content = item.get("content")
        if isinstance(content, str):
            shape.append((item["role"], "text"))
            continue
        for block in content:
            shape.append(
                (
                    block["type"],
                    block.get("file_id"),
                    "breakpoint" if "prompt_cache_breakpoint" in block else None,
                )
            )
    return shape


def test_the_document_prefix_keeps_its_shape():
    body = ChatRequest(scope="document", prompt="What does the ablation establish?", paper_id="one")

    request_input = build_responses_input(
        [({"id": "one", "title": "Paper"}, "file-one")],
        [{"role": "user", "content": "earlier", "requestId": "r1"},
         {"role": "assistant", "content": "answer", "requestId": "r1"}],
        body,
        memory_block={"role": "user", "content": "<reader_memory>…"},
    )

    # One user item carrying the PDF and then the library; the history; what
    # is open; the Memory block; the question — in that order. Everything
    # after the first item is free to change per turn.
    assert prefix_shape(request_input) == [
        ("input_file", "file-one", "breakpoint"),
        ("input_text", None, "breakpoint"),
        ("user", "text"),
        ("assistant", "text"),
        ("input_text", None, None),
        ("user", "text"),
        ("user", "text"),
    ]
    assert request_input[0]["content"][1]["text"].startswith("<project_library")
    assert request_input[-3]["content"][0]["text"].startswith("<open_document")
    # Invariant 39: the block is second-to-last, after every breakpoint, which
    # is the whole reason it can be given to every persona for free.
    assert "<reader_memory>" in request_input[-2]["content"]


def test_a_document_question_carries_the_project_behind_the_document():
    body = ChatRequest(scope="document", prompt="How does this differ from B?", paper_id="one")
    one, two, three = (
        {"id": "one", "title": "One"},
        {"id": "two", "title": "Two"},
        {"id": "three", "title": "Three", "kind": "web"},
    )

    request_input = build_responses_input(
        [(one, "file-one")],
        [],
        body,
        digest_cards=[(one, {"contentMarkdown": "…"}), (two, {"contentMarkdown": "…"})],
        memory_block={"role": "user", "content": "<reader_memory>…"},
        companions=[two, three],
        tool_names=frozenset({"read_paper"}),
    )

    # The document is still first and still carries the first breakpoint
    # (invariant 12); the library follows with one of its own on the last
    # digest, so a regenerated digest never costs the document's cached prefix.
    assert prefix_shape(request_input) == [
        ("input_file", "file-one", "breakpoint"),
        ("input_text", None, None),
        ("input_text", None, None),
        ("input_text", None, "breakpoint"),
        ("input_text", None, None),
        ("user", "text"),
        ("user", "text"),
    ]
    blocks = request_input[0]["content"]
    # The index leads, and says what this request holds for each document: a
    # digest, or its title only because none has been written yet.
    index = blocks[1]["text"]
    assert index.startswith('<project_library documents="3">')
    listed = [json.loads(line) for line in index.split("\n")[2:5]]
    assert [(entry["paper_id"], entry["kind"], entry["in_context"]) for entry in listed] == [
        ("one", "pdf", "digest"),
        ("two", "pdf", "digest"),
        ("three", "web-page", "title only"),
    ]
    # Only a reading tool that is actually offered is named.
    assert "read_paper(paper_id, pages)" in index and "read_webpage" not in index
    assert blocks[2]["text"].startswith('<research_digest paper_id="one"')
    assert blocks[3]["text"].startswith('<research_digest paper_id="two"')
    # Each digest is there once, and which document is open is not said in the
    # prefix at all — it is said beside the question.
    assert json.dumps(blocks).count("<research_digest paper_id") == 2
    assert "open_document" not in json.dumps(blocks)
    turn = request_input[-3]["content"][0]["text"]
    assert turn.startswith('<open_document paper_id="one" title="One" kind="pdf">')
    assert '"this paper"' in turn and "the first attachment" in turn
    assert "Its research digest is in the project library" in turn


def test_the_library_is_the_same_whichever_web_document_is_open():
    """
    The request that named the wrong document: six documents, a web page open,
    and the last digest in the project answered about instead. Identity is now
    beside the question, and the prefix does not move when the reader does.
    """
    papers = [
        {"id": f"d{n}", "title": f"Document {n}", "kind": "web", "url": SNAPSHOT["url"]}
        for n in range(6)
    ]
    cards = [(paper, {"contentMarkdown": paper["title"]}) for paper in papers]
    snapshots = {paper["id"]: SNAPSHOT for paper in papers}

    def ask(open_id):
        body = ChatRequest(
            scope="document", prompt="Summarize this blogpost.", paper_id=open_id
        )
        current = next(paper for paper in papers if paper["id"] == open_id)
        return build_responses_input(
            [(current, None)],
            [],
            body,
            web_documents=snapshots,
            digest_cards=cards,
            companions=[paper for paper in papers if paper["id"] != open_id],
            tool_names=frozenset({"read_webpage"}),
            project_documents=papers,
        )

    third, last = ask("d3"), ask("d5")
    assert third[0] == last[0]
    turn = third[-2]["content"][0]["text"]
    assert turn.startswith('<open_document paper_id="d3" title="Document 3" kind="web-page">')
    assert '"this post"' in turn and "never another document" in turn
    assert "only its outline is in context" in turn and "here whole" not in turn
    assert "Document 5" not in turn


def test_digests_sit_ahead_of_the_comparison_papers_a_question_adds():
    body = ChatRequest(
        scope="document", prompt="Compare", paper_id="one", referenced_paper_ids=["two"]
    )
    one, two = {"id": "one", "title": "One"}, {"id": "two", "title": "Two"}

    request_input = build_responses_input(
        [(one, "file-one"), (two, "file-two")],
        [],
        body,
        digest_cards=[(one, {"contentMarkdown": "…"})],
    )

    assert prefix_shape(request_input)[:4] == [
        ("input_file", "file-one", "breakpoint"),
        ("input_text", None, None),
        ("input_text", None, "breakpoint"),
        ("input_file", "file-two", "breakpoint"),
    ]


def test_document_scope_can_open_the_rest_of_the_project_and_only_then():
    # Memory and the web are switched off so that only the reading tools show.
    settings = Settings(memory_enabled=False, web_search_enabled=False)
    body = ChatRequest(scope="document", prompt="?", paper_id="one")
    attached = [({"id": "one", "title": "One"}, "file-one")]

    def names(**extra):
        return [
            tool.get("name")
            for tool in toolset_for_scope(settings, body, **extra).specs()
        ]

    # Alone, the attached PDF is here whole and nothing needs opening.
    assert names() == []
    # A PDF present only as a digest has to be reachable by exact page.
    assert "read_paper" in names(companions=[{"id": "two", "title": "Two"}])
    web = {"id": "three", "title": "Three", "kind": "web"}
    assert "read_paper" not in names(companions=[web])
    assert "read_webpage" in names(companions=[web], web_documents={"three": {}})


def test_only_digests_that_already_exist_join_a_document_question(tmp_path):
    from delphi_core.research_digest import RESEARCH_DIGEST_VERSION
    from delphi_core.storage import paper_key

    settings = Settings(data_dir=tmp_path)
    storage = LocalStorage(settings)
    objects = LocalObjectStore(settings.data_dir)
    meta = storage.create_project("reader", "Project")
    ready = {"status": "ready", "sourceHash": "abc", "version": RESEARCH_DIGEST_VERSION}
    for paper_id, digest, done in (
        ("open", ready, False),
        ("filed", ready, False),
        ("unfiled", None, False),
        ("archived", ready, True),
        ("unreadable", ready, False),
    ):
        seed_paper(
            settings, "reader", meta["id"],
            {"id": paper_id, "title": paper_id, "filename": f"{paper_id}.pdf"},
        )
        snapshot = {}
        if digest:
            snapshot["digest"] = digest
        if done:
            snapshot["doneAt"] = "2026-01-01T00:00:00+00:00"
        if snapshot:
            storage.update_paper_snapshot("reader", meta["id"], paper_id, snapshot)
        if digest and paper_id != "unreadable":
            objects.put_text(
                paper_key("reader", meta["id"], paper_id, "digest"),
                json.dumps({"digest": {"contentMarkdown": paper_id}}),
            )
    project = storage.get_project("reader", meta["id"])
    attached = [paper for paper in project["papers"] if paper["id"] == "open"]

    cards, companions, estimated = asyncio.run(
        ready_project_digests(objects, "reader", meta["id"], project, attached, settings)
    )

    # Nothing is generated and nothing waits: a document without a digest, or
    # with one that cannot be read, is simply listed without it. A document
    # marked done keeps no card.
    assert [paper["id"] for paper, _ in cards] == ["open", "filed"]
    # A finished document has no card and is still a companion: the reading
    # tools may open what the reader has read.
    assert [paper["id"] for paper in companions] == ["filed", "unfiled", "archived", "unreadable"]
    assert estimated > 0


def test_the_library_prefix_keeps_its_shape():
    body = ChatRequest(scope="document", prompt="How do these compare?")
    papers = [{"id": "a", "title": "A"}, {"id": "b", "title": "B"}]

    request_input = build_responses_input(
        [(paper, None) for paper in papers],
        [],
        body,
        digest_cards=[(paper, {"contentMarkdown": "…"}) for paper in papers],
        memory_block={"role": "user", "content": "<reader_memory>…"},
    )

    # The index, then one digest block per document with the breakpoint on the
    # *last* of them only. A companion present only as a digest is an
    # `input_text`, never an `input_file` — and with no paper open, nothing is
    # named as one.
    assert prefix_shape(request_input) == [
        ("input_text", None, None),
        ("input_text", None, None),
        ("input_text", None, "breakpoint"),
        ("user", "text"),
        ("user", "text"),
    ]
    blocks = request_input[0]["content"]
    assert blocks[0]["text"].startswith("<project_library")
    assert blocks[1]["text"].startswith('<research_digest paper_id="a"')
    assert blocks[2]["text"].startswith('<research_digest paper_id="b"')


# --- The account-wide scope --------------------------------------------------
#
# Everything here is a property that must survive the three chats sharing one
# assembler. Each one is a difference that is load-bearing, not an accident of
# how the two endpoints happened to be written.


def general_payload(**overrides):
    settings = Settings(data_dir="/tmp/delphi-general-scope")
    body = ChatRequest(prompt="What do I already know about VAEs?", scope="general",
                       **overrides)
    return build_responses_payload(
        settings=settings,
        username="reader",
        project_id="",
        project_skills="",
        sources=[],
        previous_messages=[],
        body=body,
        memory_block={"role": "user", "content": "<reader_memory>…"},
    )


def test_the_account_wide_scope_never_asks_for_a_cached_prefix():
    payload = general_payload()

    # It has no stable prefix to cache — no PDF, no digest, nothing that is the
    # same next turn — so a key here would be a key that never hits, quietly
    # charged for on every question.
    assert "prompt_cache_key" not in payload
    assert "prompt_cache_options" not in payload
    for item in payload["input"]:
        content = item.get("content")
        if isinstance(content, list):
            assert all("prompt_cache_breakpoint" not in block for block in content)


def test_the_account_wide_scope_shares_the_chat_ceiling_and_carries_no_documents():
    payload = general_payload()
    settings = Settings(data_dir="/tmp/delphi-general-scope")

    # One task, one ceiling. This scope used to borrow the filing pass's larger
    # one because chat's was too small for a long answer at a high effort; the
    # chat ceiling is now sized for that in both scopes.
    assert payload["max_output_tokens"] == settings.model_max_output_tokens == 32_000
    # History, the reader block, the question — and no source item at all.
    serialised = json.dumps(payload["input"])
    assert "<project_library" not in serialised
    assert "<research_digest" not in serialised
    assert "input_file" not in serialised
    assert "<reader_memory>" in payload["input"][-2]["content"]


def test_asking_the_wiki_a_question_may_not_revise_it():
    offered = {
        tool.get("name") or tool["type"] for tool in general_payload()["tools"]
    }

    # Memory first, and a thin Memory can drop back to raw evidence…
    assert {"open_memory", "search_library", "read_paper"} <= offered
    # …but writing is for the passes that have an exchange or a digest behind
    # them. A question is not evidence that anything was learned.
    assert "write_knowledge" not in offered


def test_the_reader_scopes_still_ask_for_a_cached_prefix():
    settings = Settings(data_dir="/tmp/delphi-general-scope")
    payload = build_responses_payload(
        settings=settings,
        username="reader",
        project_id="project-one",
        project_skills="",
        sources=[({"id": "one", "title": "Paper"}, "file-one")],
        previous_messages=[],
        body=ChatRequest(scope="document", prompt="q", paper_id="one"),
    )

    assert payload["prompt_cache_key"].startswith("delphi:")
    assert payload["prompt_cache_options"]["mode"] == "explicit"


@pytest.mark.asyncio
async def test_document_budget_exhaustion_does_not_suppress_memory(tmp_path, monkeypatch):
    from delphi_core.harness.tools import open_memory as chat
    settings = Settings(openai_api_key='test', data_dir=tmp_path, document_tool_max_calls=1,
                        document_tool_max_chars=1, model_tool_max_rounds=1)
    storage = LocalStorage(settings)
    storage.create_account('reader', None, 'salt', 'hash')
    turns = []
    monkeypatch.setattr(chat, 'open_chosen_memory', lambda *args: ('Actual Memory content', ['remembered'], []))
    def provider(request):
        turns.append(json.loads(request.content))
        calls = [("read_webpage", {"doc_id": "page-one", "anchor": "all"}), ("read_webpage", {"doc_id": "page-one", "anchor": "all"}), ("open_memory", {"slugs": ["remembered"]})]
        events = [{"type": "response.output_item.done", "item": {"type": "function_call", "call_id": str(i), "name": name, "arguments": json.dumps(arguments)}} for i, (name, arguments) in enumerate(calls)] if len(turns) == 1 else [{"type": "response.output_text.delta", "delta": "Answer"}]
        return httpx.Response(200, content=''.join('data: '+json.dumps(e)+'\n\n' for e in events).encode())
    payload = {"model": "gpt-6.1-sol", "input": [], "tools": [{"type": "function", "name": name} for name in ("read_webpage", "open_memory")]}
    async with httpx.AsyncClient(transport=ProviderTransport(provider)) as client:
        events = [event async for event in run_model_turns(client, payload, {'page-one': SNAPSHOT}, {'page-one': 'Page'}, settings, storage=storage, username='reader')]
    outputs = [item['output'] for item in turns[1]['input'] if item.get('type') == 'function_call_output']
    assert 'budget is exhausted' in outputs[1]
    assert outputs[2] == 'Actual Memory content'
    assert any(e.get('text') == 'Answer' for e in events)


def test_a_finished_document_is_a_library_row_the_reading_tools_can_open():
    """
    Finishing a document says the reader has read it. It keeps no digest in the
    request, and it is still named, marked finished, and readable: an answer
    that builds on it can cite its page instead of going to the web for a copy.
    """
    from delphi_core.routers.chat import project_library_blocks, toolset_for_scope

    reading = {"id": "open", "title": "Open paper"}
    finished = {"id": "read", "title": "Read paper", "doneAt": "2026-09-14T00:00:00+00:00"}
    toolset = toolset_for_scope(
        Settings(), ChatRequest(scope="document", prompt="?", paper_id="open"), companions=[finished]
    )
    assert {"read_paper", "search_library"} <= toolset.names

    header = project_library_blocks([reading, finished], [], toolset.names, False)[0]["text"]
    rows = [json.loads(line) for line in header.splitlines() if line.startswith("{")]
    assert rows == [
        {"paper_id": "open", "title": "Open paper", "kind": "pdf", "in_context": "title only"},
        {"paper_id": "read", "title": "Read paper", "kind": "pdf", "in_context": "finished; not attached"},
    ]
    assert "`finished; not attached` is a document the reader marked finished" in " ".join(header.split())
    assert "exact PDF pages with read_paper(paper_id, pages)" in header
