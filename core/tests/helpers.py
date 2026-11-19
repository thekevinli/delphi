import json
import os
import tempfile
from pathlib import Path
from typing import Any

import httpx

from delphi_core.config import Settings
from delphi_core.harness.budget import TurnBudget
from delphi_core.harness.loop import run_turn
from delphi_core.harness.provider import ResponsesClient
from delphi_core.harness.registry import DEFAULTS, Toolset
from delphi_core.harness.tool import ToolContext
from delphi_core.storage import LocalObjectStore, LocalStorage, paper_key

MINIMAL_PDF = b"%PDF-1.4\n%%EOF\n"


def seed_paper(
    settings: Settings,
    username: str,
    project_id: str,
    paper: dict[str, Any],
    pdf: bytes = MINIMAL_PDF,
    text: str = "",
) -> dict[str, Any]:
    """
    Add a paper the way an upload would: a record plus its two objects. Tests go
    through the storage boundary rather than writing files, so they keep passing
    when the bytes stop being files.
    """
    storage = LocalStorage(settings)
    objects = LocalObjectStore(settings.data_dir)
    stored = storage.add_paper(username, project_id, paper)
    put_bytes(objects, paper_key(username, project_id, paper["id"], "pdf"), pdf)
    objects.put_text(paper_key(username, project_id, paper["id"], "txt"), text)
    return stored


def put_bytes(objects: LocalObjectStore, key: str, payload: bytes) -> None:
    handle, name = tempfile.mkstemp()
    os.close(handle)
    path = Path(name)
    try:
        path.write_bytes(payload)
        objects.put_file(key, path, "application/pdf")
    finally:
        path.unlink(missing_ok=True)


def run_model_turns(
    client,
    payload: dict[str, Any],
    web_documents: dict[str, dict[str, Any]],
    titles: dict[str, str],
    settings: Settings,
    *,
    objects=None,
    username: str = "",
    project_id: str = "",
    paper_documents: dict[str, dict[str, Any]] | None = None,
    storage=None,
    recorder=None,
    memory_tool_max_calls: int | None = None,
    attached_pdf_ids: frozenset[str] = frozenset(),
):
    """
    One turn through the harness, for a test that already holds a request.

    The toolset is read back off the request's own `tools`, so the loop serves
    exactly what the payload under test offers.
    """
    names = [tool.get("name") or tool.get("type", "") for tool in payload.get("tools") or []]
    toolset = Toolset(DEFAULTS[name] for name in names if name in DEFAULTS)
    return run_turn(
        ResponsesClient(client, settings),
        payload,
        toolset,
        TurnBudget.for_chat(settings, memory_calls=memory_tool_max_calls),
        ToolContext(
            settings=settings,
            username=username,
            project_id=project_id,
            storage=storage,
            objects=objects,
            web_documents=web_documents,
            titles=titles,
            paper_documents=paper_documents or {},
            attached_pdf_ids=attached_pdf_ids,
            offered=frozenset(names),
        ),
        recorder=recorder,
    )


#: How a streamed response says it finished. A test that wants a response to
#: end any other way writes its own last frame, or uses `httpx.MockTransport`.
COMPLETED_FRAME = b'data: {"type": "response.completed", "response": {"status": "completed"}}\n\n'
_TERMINAL_FRAMES = (b'"response.completed"', b'"response.incomplete"', b'"response.failed"', b'"type": "error"')


class ProviderTransport(httpx.MockTransport):
    """
    A fake model provider that ends each response the way the real one does.

    A test's handler says what the model produced; whether the response then
    *finished* is not what most tests are about, and the harness never infers
    it (`harness.provider.Terminal`). So a successful answer to `/responses`
    that names no ending is given the ordinary one: a streamed body gains a
    `response.completed` frame, a JSON body a `status` of `completed`. A
    handler that already says how its response ended is left exactly as it is.
    """

    @staticmethod
    def _finish(request: httpx.Request, response: httpx.Response) -> httpx.Response:
        if (
            not request.url.path.endswith("/responses")
            or response.status_code != 200
            or not isinstance(response.stream, httpx.ByteStream)
        ):
            return response
        body = response.content
        if b"data:" in body:
            if any(marker in body for marker in _TERMINAL_FRAMES):
                return response
            return httpx.Response(200, headers=response.headers, content=body + COMPLETED_FRAME)
        try:
            parsed = json.loads(body)
        except ValueError:
            return response
        if not isinstance(parsed, dict) or "status" in parsed:
            return response
        return httpx.Response(200, json={**parsed, "status": "completed"})

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        return self._finish(request, super().handle_request(request))

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        return self._finish(request, await super().handle_async_request(request))


def replay(events):
    """What a client holds after applying every `trace` event, in order."""
    trace = []
    for event in events:
        assert event["type"] == "trace"
        while len(trace) <= event["stretch"]:
            trace.append({"entries": []})
        stretch = trace[event["stretch"]]
        if "open" in event:
            stretch.update(event["open"])
        elif "close" in event:
            stretch.update(event["close"])
        elif "set" in event:
            entries = stretch["entries"]
            if event["entry"] == len(entries):
                entries.append(dict(event["set"]))
            else:
                entries[event["entry"]] = dict(event["set"])
        else:
            stretch["entries"][event["entry"]]["text"] += event["text"]
    return trace
