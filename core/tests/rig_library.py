"""
A small library and a scripted provider, for running a rig end to end.

The stores are real local ones in a temp directory. The provider is the
journey rig's fixture (`delphi_core_testkit/provider.py`), reached over HTTP as
Delphi reaches a provider: it writes a digest for each document, answers the
selection, plays the maintenance agent and the checker, and composes domain
pages. Nothing here can reach a real provider: every `httpx.AsyncClient` made
while `Rig` is installed is given the fixture as its transport.

What the fixture files, by a document's title:

    any title                  one concept page of its own, `prefix-reuse-<paper id>`
    "Shared Idea Study <t> …"   every document of the series into `shared-idea-<t>`:
                               the first creates it, each later one edits it
    "Disputed Claim Study …"    blocked once by the checker, then repaired

`Rig.refuse(title)` adds a document whose every check objects, so its job
drops what it staged and fails.
"""

import importlib.util
import json
import re
from pathlib import Path

import httpx
from fastapi import FastAPI

from delphi_core.config import Settings
from delphi_core.storage import LocalObjectStore, LocalStorage, paper_key

# By path, under a name of its own: `test_e2e_provider` loads its own instance,
# and one shared import would merge the two's recorded requests and counters.
SPEC = importlib.util.spec_from_file_location(
    "rig_e2e_provider", Path(importlib.util.find_spec("delphi_core_testkit").origin).with_name("provider.py")
)
provider = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(provider)

TEXT = (
    "--- Page 1 ---\n\nPrefix caching reuses the unchanged beginning of a prompt. Token equality matters.\n\n"
    "--- Page 2 ---\n\nStable prefix: 120 ms. Shuffled prefix: 240 ms."
)
REFUSAL = "The document reports one comparison, not what a stable prefix does in general."


class _Provider(httpx.AsyncBaseTransport):
    """The fixture's routes, with a checker that never lets a refused document's pages through."""

    def __init__(self, refused: set[str]) -> None:
        app = FastAPI()
        app.include_router(provider.fixture_router)
        self._fixture = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        self._refused = refused
        self.asked: list[str] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        assert request.url.host == "fixture", f"a rig test tried to reach {request.url}"
        body = json.loads(request.content) if request.headers.get("content-type", "").startswith("application/json") else {}
        name = ((body.get("text") or {}).get("format") or {}).get("name")
        self.asked.append(name or ("agent" if body.get("tools") else request.url.path.rsplit("/", 1)[-1]))
        if name == "memory_verdicts":
            text = provider.input_text(body)
            about = re.search(r"^What these pages were written from: (.*) \(\w+\)\.$", text, re.M)
            if about and about[1] in self._refused:
                # Whatever a check is shown of the page, it objects to: its summary, which no
                # strike can cut, so the page cannot stand; or, with none shown, a page checked
                # again after its repair, or after a sentence was struck, is blocked like the first.
                summary = re.search(r"^<summary>\n(.+)$", text, re.M)
                shown = re.findall(r"^<(?:body|after)>\n(.+)$", text, re.M)
                quote = summary[1].rstrip(".") if summary else next(
                    (claim.rstrip(".") for claim in (provider.DISPUTED, provider.REPAIRED) if claim in text), None)
                quote = quote or next(line.split(" [")[0].strip() for line in shown if len(line) > 20 and not line.startswith("#"))
                answer = {"objections": [
                    {"slug": slug, "finding": "differs", "quote": quote, "evidenceId": None, "explanation": REFUSAL}
                    for slug in re.findall(r'^<page slug="([^"]+)" action="(?:create|edit)"(?: again="true")?>$', text, re.M)
                ]}
                return httpx.Response(200, json={
                    "status": "completed", "usage": {"input_tokens": 40, "output_tokens": 8},
                    "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(answer)}]}],
                })
        return await self._fixture.handle_async_request(request)


class Rig:
    """An account `reader` with one project, and the fixture installed as the only provider."""

    def __init__(self, tmp_path, monkeypatch, **settings):
        for name, fresh in (("requests", []), ("refusals", []), ("asked", provider.Counter())):
            monkeypatch.setattr(provider, name, fresh)
        self.settings = Settings(
            _env_file=None, data_dir=tmp_path, openai_api_key="fixture-only",
            openai_api_base_url="http://fixture/__fixtures/provider/v1", **settings,
        )
        self.storage = LocalStorage(self.settings)
        self.objects = LocalObjectStore(tmp_path, self.settings.chat_image_retention_days)
        self.storage.create_account("reader", None, "salt", "hash")
        self.project = self.storage.create_project("reader", "Reading")["id"]
        self._refused: set[str] = set()
        self.provider = _Provider(self._refused)
        client = httpx.AsyncClient
        monkeypatch.setattr(
            httpx, "AsyncClient",
            lambda **given: client(**{**given, "transport": self.provider}),
        )

    def pdf(self, paper_id: str, title: str, *, username: str = "reader", project: str | None = None) -> None:
        """A PDF as import leaves it: the record, its text, the queued job, and no digest yet."""
        project = project or self.project
        self.storage.add_paper(username, project, {
            "id": paper_id, "title": title, "filename": f"{paper_id}.pdf", "pages": 2, "tokens": 20, "bytes": 100,
        })
        self.objects.put_text(paper_key(username, project, paper_id, "txt"), TEXT)
        self.storage.set_openai_file(username, project, paper_id, f"file-{paper_id}")

    def refuse(self, paper_id: str, title: str) -> None:
        """A document whose pages the checker blocks every time."""
        self._refused.add(title)
        self.pdf(paper_id, title)

    def asked(self, name: str) -> int:
        """How many requests of one kind the provider has answered: a format's name, or `agent`."""
        return self.provider.asked.count(name)

    def jobs(self, username: str = "reader", storage=None) -> list[tuple[str, str, str]]:
        return sorted(
            (job["kind"], job["marker"], job["status"])
            for job in (storage or self.storage).list_memory_jobs(username)
        )

    def pages(self, kind: str, username: str = "reader", storage=None) -> list[str]:
        held = (storage or self.storage).list_memory_pages(username, limit=200)
        return sorted(page["slug"] for page in held if page["kind"] == kind)

    def events(self, username: str = "reader", storage=None) -> list[dict]:
        """The `document` events, oldest first."""
        events = (storage or self.storage).list_memory_events(username, limit=200)
        return [event for event in reversed(events) if event.get("kind") == "document"]
