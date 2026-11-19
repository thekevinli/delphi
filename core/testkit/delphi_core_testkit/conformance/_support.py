"""What the store tests share with the rest of core's suite, copied here because the kit cannot import it.

A consumer's tests package is not core's, so the kit carries its own copy of
each helper its tests use. Each is the copy of the one named in its
docstring, and changes with it.
"""
import json

import httpx

from delphi_core.storage.conversations import selector


def chat_key(storage, username, project_id=None, scope_key=None, *, name="default"):
    """A context's conversation, created once, as a selector (core's `tests/chat_keys.py`)."""
    if project_id is None:
        scope, paper_id = "general", None
    else:
        scope, paper_id = "document", str(scope_key).removeprefix("paper-")
    context = paper_id or project_id or "account"
    item = storage.create_conversation(username, scope, project_id, paper_id, f"t_{name}_{context}"[:64])
    return selector(item["id"], item["generation"])


def html_payload():
    """A highlight on a web document (core's `tests/test_web_annotations.py`)."""
    return {"type":"html", "text":"A 😀 quote", "requestId":"a"*32, "color":"amber", "anchor": {
        "version":1,"revision":"a"*64,"blockHash":"b"*64,"blockOrdinalHint":0,
        "startInBlock":0,"start":0,"end":10,"prefix":"","suffix":""}}


#: How a streamed response says it finished. A test that wants a response to
#: end any other way writes its own last frame, or uses `httpx.MockTransport`.
COMPLETED_FRAME = b'data: {"type": "response.completed", "response": {"status": "completed"}}\n\n'
_TERMINAL_FRAMES = (b'"response.completed"', b'"response.incomplete"', b'"response.failed"', b'"type": "error"')


class ProviderTransport(httpx.MockTransport):
    """
    A fake model provider that ends each response the way the real one does
    (core's `tests/helpers.py`).

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
