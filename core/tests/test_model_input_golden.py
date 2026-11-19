"""
The exact requests Delphi sends a model, pinned byte for byte.

Each flow runs through the real routes, the real drain and the real pipeline,
with the journey rig's scripted provider (`tests/rig_library.py`) as the only
provider. Every request is captured at the `httpx` transport, as it leaves for
the provider: the instructions, the input items in order, the tool definitions
and what each tool returned, the model and every parameter. Each is compared
with its golden, one file per request in the order they were sent, named by
what the request asks for (its `text.format` name, `maintain` for a round of
the maintenance agent, `answer` for a round of a chat turn):

    filing/          two documents of one idea: digest, select, maintain,
                     verify, then the domain they settle into, composed and
                     checked
    page-rewrite/    one concept page rewritten with a reader's note, checked,
                     and the composition its new summary owes its domain
    chat-document/   a question beside a document: Memory selection, then
                     the turn with the `<reader_memory>` block, the Memory
                     tools, and `open_memory`'s result handed back
    chat-general/    a Memory chat: the whole index, and `open_memory`
    session-filing/  that document chat, released and filed as a session
    lint/            the Memory check over the filed pages, which reports and
                     writes nothing
    reorganization/  a proposal to re-file the pages, once the reader has made
                     a second domain for them to move to

The point is a change that must not alter what the model is asked (a rename,
a module split): it leaves every golden as it was. A change meant to reach the
model fails here first, and the golden's diff is the review of what the model
will read from then on.

Only what is genuinely unstable is normalised, each to a placeholder naming
what it stood for: page and conversation ids minted by the run, wall-clock
timestamps and dates, the temp directory. The project's id is pinned instead,
so the prompt cache key derived from it is compared as sent. Nothing else is
masked, and key order is kept as sent.

Regenerating is deliberate and never automatic. With the flag set, each
flow's directory is rewritten to what was sent:

    DELPHI_REGENERATE_MODEL_INPUTS=1 .venv/bin/python -m pytest tests/test_model_input_golden.py

and the diff under `tests/data/model-inputs/` is then reviewed and committed
with the change that caused it. Without the flag a missing, extra or
different request fails.
"""

import json
import os
import re
from itertools import count
from pathlib import Path
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient

import delphi_core.storage.local as local_store
from delphi_core.backfill.memory import drain_account
from delphi_core.config import Settings, get_settings
from delphi_core.main import app
from delphi_core.memory_maintenance import verify
from delphi_core.storage import LocalObjectStore, LocalStorage, paper_key
from tests.chat_keys import conversation_params
from tests.rig_library import TEXT, _Provider, provider

GOLDENS = Path(__file__).parent / "data" / "model-inputs"
REGENERATE = os.environ.get("DELPHI_REGENERATE_MODEL_INPUTS") == "1"
PROVIDER = "http://fixture/__fixtures/provider/v1"
#: The project's id, pinned so that what is derived from it is stable too.
PROJECT = UUID("5eed0000-0000-4000-8000-000000000000")
TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?")
DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")


class Recorder(httpx.AsyncBaseTransport):
    """The rig's provider, keeping every model request as it arrived."""

    def __init__(self) -> None:
        self.provider = _Provider(set())
        self.sent: list[dict] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/responses"):
            self.sent.append({"method": request.method, "url": str(request.url), "body": json.loads(request.content)})
        return await self.provider.handle_async_request(request)


class Library:
    """A signed-in reader with one project, and two documents of one idea waiting to be filed."""

    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        # A model or an effort exported in the shell would otherwise change what is sent.
        for name in list(os.environ):
            if name.lower() in Settings.model_fields:
                monkeypatch.delenv(name)
        for name, fresh in (("requests", []), ("refusals", []), ("holds", []), ("asked", provider.Counter()),
                            ("sequence", count(1))):
            monkeypatch.setattr(provider, name, fresh)
        self.tmp_path = tmp_path
        self.settings = Settings(
            _env_file=None, data_dir=tmp_path, openai_api_key="fixture-only", openai_api_base_url=PROVIDER,
            session_secret="golden-session-secret", memory_drain_workers=1, digest_research_enabled=False,
        )
        self.recorder = Recorder()
        client = httpx.AsyncClient
        monkeypatch.setattr(httpx, "AsyncClient", lambda *args, **given: client(*args, **{**given, "transport": self.recorder}))
        monkeypatch.setitem(app.dependency_overrides, get_settings, lambda: self.settings)
        self.storage = LocalStorage(self.settings)
        self.objects = LocalObjectStore(tmp_path, self.settings.chat_image_retention_days)
        self.minted: dict[str, str] = {}
        self.monkeypatch = monkeypatch

    def seed(self, client: TestClient) -> None:
        self.client = client
        signed_up = client.post("/api/auth/register", json={"username": "reader", "password": "password-123"})
        assert signed_up.is_success, signed_up.text
        with self.monkeypatch.context() as pinned:
            pinned.setattr(local_store, "uuid4", lambda: PROJECT)
            self.project = self.storage.create_project("reader", "Reading")["id"]
        for paper_id, title in (("aaaaaaaaaaa1", "Shared Idea Study k3x9 A"), ("aaaaaaaaaaa2", "Shared Idea Study k3x9 B")):
            self.storage.add_paper("reader", self.project, {
                "id": paper_id, "title": title, "filename": f"{paper_id}.pdf", "pages": 2, "tokens": 20, "bytes": 100,
            })
            self.objects.put_text(paper_key("reader", self.project, paper_id, "txt"), TEXT)
            self.storage.set_openai_file("reader", self.project, paper_id, f"file-{paper_id}")

    async def drain(self) -> list[dict]:
        runs = await drain_account(self.storage, self.objects, self.settings, "reader", verbose=False)
        assert provider.refusals == [] and all(run["outcome"] != "failed" for run in runs), runs
        return runs

    def ask(self, prompt: str, request_id: str, *context: str) -> None:
        conversation = conversation_params(self.client, *context)
        self.minted[conversation["conversation_id"]] = "<conversation>"
        streamed = self.client.post("/api/chat/stream", json={**conversation, "prompt": prompt, "request_id": request_id})
        assert streamed.status_code == 200, streamed.text
        assert '"type": "done"' in streamed.text and '"type": "error"' not in streamed.text, streamed.text[-2000:]

    def take(self) -> list[dict]:
        """What was sent since the last call, normalised."""
        for page in self.storage.list_memory_pages("reader", limit=200):
            self.minted[page["id"]] = f"<page-id:{page['slug']}>"
        sent, self.recorder.sent = self.recorder.sent, []
        return [self.normalise(request) for request in sent]

    def normalise(self, value):
        if isinstance(value, str):
            value = value.replace(str(self.tmp_path), "<tmp>")
            for raw, placeholder in self.minted.items():
                value = value.replace(raw, placeholder)
            return DATE.sub("<date>", TIMESTAMP.sub("<timestamp>", value))
        if isinstance(value, list):
            return [self.normalise(item) for item in value]
        if isinstance(value, dict):
            return {self.normalise(key): self.normalise(item) for key, item in value.items()}
        return value


def name_of(request: dict) -> str:
    body = request["body"]
    asked = ((body.get("text") or {}).get("format") or {}).get("name")
    if asked:
        return asked
    return "maintain" if any(tool.get("name") == "edit_memory" for tool in body.get("tools") or ()) else "answer"


def rendered(sent: list[dict]) -> dict[str, str]:
    """Each request as its golden file holds it, by file name."""
    return {
        f"{index:02d}-{name_of(request)}.json": json.dumps(request, indent=2, ensure_ascii=False) + "\n"
        for index, request in enumerate(sent, 1)
    }


def first_difference(held, sent, path="$") -> str:
    """Where two requests first part, with the text around it."""
    if type(held) is not type(sent):
        return f"{path}: {type(held).__name__} became {type(sent).__name__}"
    if isinstance(held, dict):
        if list(held) != list(sent):
            return f"{path}: keys {list(held)} became {list(sent)}"
        return next((first_difference(held[key], sent[key], f"{path}.{key}") for key in held if held[key] != sent[key]), "")
    if isinstance(held, list):
        if len(held) != len(sent):
            return f"{path}: {len(held)} items became {len(sent)}"
        return next((first_difference(a, b, f"{path}[{i}]") for i, (a, b) in enumerate(zip(held, sent)) if a != b), "")
    if isinstance(held, str):
        at = next((i for i, (a, b) in enumerate(zip(held, sent)) if a != b), min(len(held), len(sent)))
        start = max(0, at - 60)
        return f"{path} at character {at}:\n  golden: {held[start:at + 60]!r}\n  sent:   {sent[start:at + 60]!r}"
    return f"{path}: {held!r} became {sent!r}"


def differences(flow: str, sent: list[dict]) -> list[str]:
    """How what was sent differs from the flow's goldens, one entry per file; empty when identical."""
    folder = GOLDENS / flow
    now = rendered(sent)
    held = {path.name: path.read_text(encoding="utf-8") for path in sorted(folder.glob("*.json"))} if folder.is_dir() else {}
    found = []
    for name in sorted(held.keys() | now.keys()):
        if name not in now:
            found.append(f"{flow}/{name}: the golden holds a request that was not sent")
        elif name not in held:
            found.append(f"{flow}/{name}: sent, and no golden holds it")
        elif held[name] != now[name]:
            found.append(f"{flow}/{name}: {first_difference(json.loads(held[name]), json.loads(now[name]))}")
    return found


def regenerate(flow: str, sent: list[dict]) -> None:
    folder = GOLDENS / flow
    folder.mkdir(parents=True, exist_ok=True)
    now = rendered(sent)
    for stale in folder.glob("*.json"):
        if stale.name not in now:
            stale.unlink()
    for name, text in now.items():
        (folder / name).write_text(text, encoding="utf-8")


def pinned(flow: str, sent: list[dict]) -> None:
    assert sent, f"{flow} sent no model request"
    if REGENERATE:
        regenerate(flow, sent)
        return
    found = differences(flow, sent)
    assert not found, (
        f"What {flow} sends a model is not what its goldens hold. If the change is meant to reach the model, "
        "regenerate with DELPHI_REGENERATE_MODEL_INPUTS=1 and review the diff.\n" + "\n".join(found)
    )


@pytest.fixture
def library(tmp_path, monkeypatch):
    library = Library(tmp_path, monkeypatch)
    with TestClient(app) as client:
        library.seed(client)
        yield library


@pytest.mark.asyncio
async def test_filing_two_documents_and_their_domain_sends_what_its_goldens_hold(library):
    runs = await library.drain()
    assert [(run["kind"], run["outcome"]) for run in runs if run["outcome"] != "nothing"] == [
        ("document", "filed"), ("document", "filed"), ("domain", "filed")]
    pinned("filing", library.take())


@pytest.mark.asyncio
async def test_a_page_rewrite_sends_what_its_goldens_hold(library):
    await library.drain()
    library.take()
    queued = library.client.post("/api/memory/pages/shared-idea-k3x9/rewrite",
                                 json={"note": "Say how the measurement was held fixed."})
    assert queued.status_code == 200, queued.text
    runs = await library.drain()
    assert [(run["kind"], run["outcome"]) for run in runs] == [("page-rewrite", "done"), ("domain", "nothing")]
    pinned("page-rewrite", library.take())


@pytest.mark.asyncio
async def test_a_question_beside_a_document_and_its_session_send_what_their_goldens_hold(library):
    await library.drain()
    library.take()
    library.ask("How does a stable prefix change latency here?", "req_golden_document",
                "document", library.project, "aaaaaaaaaaa2")
    document = library.take()
    assert [name_of(request) for request in document] == ["memory_selection", "answer", "answer"]
    pinned("chat-document", document)

    released = library.client.post("/api/memory/sessions/release", json={"paperId": "aaaaaaaaaaa2"})
    assert released.json() == {"released": 1}
    runs = await library.drain()
    assert [run["kind"] for run in runs] == ["session"]
    pinned("session-filing", library.take())


@pytest.mark.asyncio
async def test_a_memory_chat_sends_what_its_goldens_hold(library):
    await library.drain()
    library.take()
    library.ask("What have I read about prefix reuse?", "req_golden_general", "general")
    pinned("chat-general", library.take())


@pytest.mark.asyncio
async def test_a_memory_check_sends_what_its_goldens_hold(library):
    await library.drain()
    library.take()
    checked = library.client.post("/api/memory/lint")
    assert checked.status_code == 200, checked.text
    assert '"type": "done"' in checked.text and '"type": "error"' not in checked.text, checked.text[-2000:]
    sent = library.take()
    assert [name_of(request) for request in sent] == ["knowledge_audit"]
    pinned("lint", sent)


@pytest.mark.asyncio
async def test_a_reorganization_proposal_sends_what_its_goldens_hold(library):
    """With one domain there is nowhere to move a page and no request is made; a second one gives it somewhere."""
    await library.drain()
    library.take()
    created = library.client.post("/api/memory/domains", json={"title": "Serving cost", "summary": "What it costs to answer."})
    assert created.is_success, created.text
    proposed = library.client.post("/api/memory/reorganize/stream")
    assert proposed.status_code == 200, proposed.text
    assert '"type": "done"' in proposed.text and '"type": "error"' not in proposed.text, proposed.text[-2000:]
    sent = library.take()
    assert [name_of(request) for request in sent] == ["knowledge_reorganization"]
    pinned("reorganization", sent)


@pytest.mark.asyncio
async def test_one_changed_character_in_a_prompt_fails_its_golden(library, monkeypatch):
    """The checker's contract with its last character changed: the checks fail, and nothing else does."""
    last = verify.CONTRACT[-1]
    monkeypatch.setattr(verify, "CONTRACT", verify.CONTRACT[:-1] + ("," if last == "." else "."))
    await library.drain()
    sent = library.take()
    found = differences("filing", sent)
    checks = [name for name in rendered(sent) if name.endswith("-memory_verdicts.json")]
    assert checks and [entry.split(":")[0] for entry in found] == [f"filing/{name}" for name in checks]
    assert all("$.body.instructions at character" in entry for entry in found)
