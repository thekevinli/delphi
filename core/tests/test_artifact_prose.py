"""Saved visualizations stay exact; downstream text tasks receive their prose."""

import asyncio
import copy
import json

import httpx
import pytest

from delphi_core.artifacts.prose import assistant_prose
from delphi_core.chat_history import history_input
from delphi_core.config import Settings
from delphi_core.conversation_titles import generate_conversation_title
from delphi_core.storage import LocalObjectStore, LocalStorage
from delphi_core_testkit.conformance.memory_sessions import Reader, gathered
from tests.helpers import ProviderTransport


def artifact(title="Cache flow", body="<script>artifactImplementation()</script>"):
    return f"```delphi-artifact {title}\n{body}\n```\n"


@pytest.mark.parametrize("body", [
    "Plain prose mentioning delphi-artifact.\n",
    "Inline `delphi-artifact` and ` ```delphi-artifact example ` remain.\n",
    "````text\n```delphi-artifact Example\nuser code\n```\n````\n",
    "```html\n<script>const format = 'delphi-artifact';</script>\n```\n",
    "    ```delphi-artifact Example\n    code\n    ```\n",
    "\\```delphi-artifact Example\nnot a fence\n",
    "```delphi-artifact-example\nordinary code\n```\n",
    "``` delphi-artifact Example\nordinary code\n```\n",
    "```delphi&#45;artifact Example\nordinary code\n```\n",
])
def test_projection_preserves_mentions_and_ordinary_code_exactly(body):
    assert assistant_prose(body) == body


@pytest.mark.parametrize("marker,prefix", [("```", ""), ("~~~~", ""), ("`````", "> "), ("```", "- ")])
@pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"])
def test_projection_handles_real_fences_containers_and_line_endings(marker, prefix, newline):
    continuation = "> " if prefix == "> " else "  " if prefix == "- " else ""
    before, after = f"Before.{newline}{newline}", f"{newline}After.{newline}"
    code = (f"{prefix}{marker}delphi-artifact Cache flow{newline}"
            f"{continuation}<script>artifactImplementation()</script>{newline}"
            f"{continuation}{marker}{newline}")
    assert assistant_prose(before + code + after) == (
        before + prefix + '[Visualization: "Cache flow"; source and UI state omitted]' + newline + after
    )


def test_projection_titles_are_bounded_and_incomplete_artifact_source_is_omitted():
    text = artifact('title="A diagram"') + "\n" + artifact("T" * 500) + "\n```delphi-artifact\nunfinished HTML"
    projected = assistant_prose(text)
    assert '"A diagram"' in projected
    assert '"' + "T" * 160 + '"' in projected and "T" * 161 not in projected
    assert '"Interactive visualization"' in projected
    assert "artifactImplementation" not in projected and "unfinished HTML" not in projected
    assert projected.count("source and UI state omitted") == 3


def test_followup_context_keeps_exact_source_for_edits_and_preserves_user_code_and_records():
    # No model tool can retrieve an earlier diagram's source. Projecting chat
    # history would silently break exact follow-up edits; only derived text
    # tasks (Memory and titles) use the prose projection for now.
    code = artifact()
    messages = [
        {"role": "user", "requestId": "one", "content": code, "selectedText": code},
        {"role": "assistant", "requestId": "one", "content": "Before.\n\n" + code + "\nAfter."},
    ]
    original = copy.deepcopy(messages)
    context = history_input(messages)
    assert context[0]["content"] == code + f"\n\nQuoted passage selected by the user:\n{code}"
    assert context[1]["content"] == messages[1]["content"]
    assert messages == original


@pytest.mark.parametrize("web_evidence", [False, True])
def test_memory_projects_before_excerpt_and_citation_scanning(tmp_path, web_evidence):
    settings = Settings(_env_file=None, data_dir=tmp_path)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    reader = Reader(storage, LocalObjectStore(tmp_path))
    key = reader.tab()
    hidden_url, cited_url = "https://example.test/source-only", "https://example.test/prose"
    source = '<script>const sourceUrl = "' + hidden_url + '";\n' + ("artifactImplementation();\n" * 300) + "</script>"
    answer = artifact(body="<script>" + "artifactImplementation();" * 300 + "</script>") + "\n" + artifact(body=source)
    answer += "\nThe prefix is reused because tokens match.\n\n" + f"Outside claim. [Source]({cited_url})."
    question = "Explain this user code: " + artifact(body="<script>userCode()</script>")
    reader.ask(key, "artifact_turn", question, answer, sources=[
        {"url": hidden_url, "title": "Source only"}, {"url": cited_url, "title": "Prose"},
    ])
    before = storage.get_conversation("reader", reader.conversation(key))
    evidence = gathered(reader, tmp_path, memory_web_evidence=web_evidence)
    assert "artifactImplementation" not in evidence.brief
    assert "Cache flow" in evidence.brief and "tokens match" in evidence.brief
    assert "userCode()" in evidence.brief
    assert hidden_url not in evidence.brief and "Outside claim" not in evidence.brief
    assert [item["url"] for item in evidence.web_cited] == ([cited_url] if web_evidence else [])
    assert storage.get_conversation("reader", reader.conversation(key)) == before


def test_titles_project_prior_and_current_answers_before_their_separate_budgets(tmp_path, monkeypatch):
    settings = Settings(_env_file=None, data_dir=tmp_path, openai_api_key="test-key",
                        conversation_title_recent_input_tokens=250, conversation_title_answer_input_tokens=150)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    reader = Reader(storage, LocalObjectStore(tmp_path))
    key = reader.tab()
    large = "<script>" + "artifactImplementation();" * 500 + "</script>"
    claim = {"id": reader.conversation(key), "messages": [
        {"role": "user", "content": "Original cache question\n\n" + artifact(body="<script>historicalUserCode()</script>")},
        {"role": "assistant", "content": "Prior thesis.\n\n" + artifact("Prior diagram", large)},
    ]}
    original = copy.deepcopy(claim)
    sent = []

    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"output": [{"content": [{"type": "output_text", "text": "Cache reuse"}]}]})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda *args, **kwargs: real_client(transport=ProviderTransport(handler)))
    prompt = "Explain my code: " + artifact("User example", "<script>userCode()</script>")
    answer = artifact("Current diagram", large) + "\nCurrent thesis: stable tokens enable cache reuse."
    asyncio.run(generate_conversation_title(claim, prompt, answer, "reader", storage, settings, False))
    text = sent[0]["input"][0]["content"]
    assert "artifactImplementation" not in text
    assert all(part in text for part in ("Original cache question", "Prior thesis", "Prior diagram",
                                         "Current diagram", "Current thesis", "userCode()", "historicalUserCode()"))
    assert claim == original
