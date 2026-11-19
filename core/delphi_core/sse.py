"""
One server-sent-events surface for every streaming route.

The frontend consolidated its four hand-rolled frame readers into
`lib/sse.ts` on the argument that a parser bug in one of four places is a bug
nobody finds. The backend never got the counterpart: `sse()` existed three
times, identically, and the property that actually matters — *a stream must
not go silent* — was written down in exactly one route out of eight.

That property is not a per-route concern, and treating it as one is what cost
a real deployment its Memory. A model call is silent for as long as it
thinks; an intermediary drops a connection that idles, and it drops it without
a frame, so the client sees a clean end of body with no terminal event and the
server's `except` never runs because nothing raised. Invisible in local
development, where nothing sits between the two processes.

So the heartbeat lives here, at the byte level, and every SSE route is
required to go through `event_stream` (`test_deployment.py` asserts it). Byte
level rather than event level on purpose: it needs no knowledge of any route's
event vocabulary, which is what lets it cover the routes nobody remembered to
think about. It is an SSE *comment*, which the format defines as ignorable and
which `parseSseFrames` already skips — so it reaches every existing client
without one of them changing a line.

A heartbeat is liveness, not progress. A route with something to *say* while
it works still says it in its own `progress` frames.
"""

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from contextlib import suppress
from typing import Any

import anyio
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

# Comfortably inside the ~100s an idle proxy allows, and long enough that a
# healthy stream never pays for it.
HEARTBEAT_SECONDS = 15.0
# A frame with no `data:` line. The format calls it a comment; every SSE
# parser, Delphi's included, is required to ignore it.
HEARTBEAT_FRAME = ": keep-alive\n\n"


async def run_durable_write(function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Join a byte/record write before cancellation runs its caller's cleanup.

    Cancelling an asyncio task cannot stop its worker thread. Without joining
    it, cleanup can run first and the thread can recreate deleted bytes later.
    """
    work = asyncio.create_task(run_in_threadpool(function, *args, **kwargs))
    try:
        return await asyncio.shield(work)
    except asyncio.CancelledError:
        with anyio.CancelScope(shield=True):
            with suppress(Exception):
                await work
        raise


def sse(payload: dict[str, Any]) -> str:
    """Serialize one event frame."""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def keep_alive(
    frames: AsyncIterator[str], *, every: float = HEARTBEAT_SECONDS
) -> AsyncIterator[str]:
    """
    Emit a comment frame whenever the source has said nothing for `every`.

    The pull is shielded, so a heartbeat can never cancel the work it is
    announcing, and cancelled in the `finally`, so closing the response takes
    the model call with it rather than leaving Cloud Run holding detached work
    after the reader closes the tab.
    """
    iterator = frames.__aiter__()
    pull: asyncio.Task[str] | None = None
    try:
        while True:
            pull = asyncio.ensure_future(iterator.__anext__())
            while True:
                try:
                    frame = await asyncio.wait_for(asyncio.shield(pull), timeout=every)
                    break
                except TimeoutError:
                    yield HEARTBEAT_FRAME
                except StopAsyncIteration:
                    return
            pull = None
            yield frame
    finally:
        # Disconnect can land while a frame is being sent, after its pull has
        # completed. Closing only an in-flight pull leaves the source suspended
        # at that yield, still holding claims until GC or their lease deadline.
        with anyio.CancelScope(shield=True):
            if pull is not None and not pull.done():
                pull.cancel()
                with suppress(asyncio.CancelledError):
                    await pull
            close = getattr(iterator, "aclose", None)
            if close is not None:
                await close()


class ClosingStreamingResponse(StreamingResponse):
    """Join generator cleanup even when sending a yielded frame disconnects.

    An async-for loop does not close its iterator on an exception in its body.
    Starlette's send can fail after the iterator yielded its progress frame, so
    cancellation never reaches the iterator unless the response closes it here.
    """
    async def stream_response(self, send):
        try:
            await super().stream_response(send)
        finally:
            with anyio.CancelScope(shield=True):
                close = getattr(self.body_iterator, "aclose", None)
                if close is not None:
                    await close()


def event_stream(
    frames: AsyncIterator[str], *, every: float = HEARTBEAT_SECONDS
) -> StreamingResponse:
    """
    The one way to answer with an event stream.

    `no-cache` and `X-Accel-Buffering: no` are the other half of the heartbeat:
    an intermediary that buffers is one that holds the heartbeat back until it
    has a bufferful, which is the same silence by a different route.
    """
    return ClosingStreamingResponse(
        keep_alive(frames, every=every),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
