"""
The transport every streaming route answers through.

These are the properties that were invisible in local development and cost a
deployed account its Memory: nothing sits between the two processes on
a laptop, so a stream that goes silent for three minutes is only ever a problem
in production.
"""

import asyncio
from collections.abc import AsyncIterator

import pytest

from delphi_core.sse import HEARTBEAT_FRAME, event_stream, keep_alive, sse


def test_a_heartbeat_is_a_frame_every_parser_already_ignores():
    """
    It carries no `data:` line, which the format defines as a comment.

    That is the whole reason this reaches every existing client without one of
    them changing: `parseSseFrames` skips a frame with no data line, and always
    has.
    """
    assert "data:" not in HEARTBEAT_FRAME
    assert HEARTBEAT_FRAME.endswith("\n\n")
    assert sse({"type": "done"}) == 'data: {"type": "done"}\n\n'


@pytest.mark.asyncio
async def test_a_silent_stream_keeps_speaking_and_still_delivers_its_result():
    """
    A pass that says nothing for minutes is dropped by the edge — without a
    frame. The client sees a clean end of body with no terminal event, and the
    route's `except` never runs because nothing raised.

    The source is held open by an event rather than a sleep, so the silence is
    real rather than a race with the clock. Timing this against a `sleep` made
    the test hostage to loop scheduling: starve the loop past the sleep and
    `wait_for` finds the pull already complete and returns it, correctly
    producing no heartbeat because there was no silence to cover.
    """
    release = asyncio.Event()

    async def slow() -> AsyncIterator[str]:
        yield sse({"type": "progress"})
        await release.wait()
        yield sse({"type": "done"})

    stream = keep_alive(slow(), every=0.01)
    assert await stream.__anext__() == sse({"type": "progress"})
    # Nothing can arrive from the source until the test releases it, so this
    # frame is liveness or nothing.
    assert await stream.__anext__() == HEARTBEAT_FRAME
    release.set()

    rest = [frame async for frame in stream]
    # The shielded pull survived every heartbeat rather than being restarted by
    # one, so the real frame is still there at the end.
    assert rest[-1] == sse({"type": "done"})
    assert set(rest[:-1]) <= {HEARTBEAT_FRAME}


@pytest.mark.asyncio
async def test_closing_the_response_cancels_the_work_behind_it():
    """Cloud Run must not inherit a model call the reader walked away from."""
    cancelled = False

    async def forever() -> AsyncIterator[str]:
        nonlocal cancelled
        yield sse({"type": "progress"})
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled = True
            raise
        yield sse({"type": "done"})

    stream = keep_alive(forever(), every=0.05)
    assert (await stream.__anext__()) == sse({"type": "progress"})
    # Asking for the next frame resumes the pass into its long wait; what comes
    # back while it waits is the heartbeat.
    assert (await stream.__anext__()) == HEARTBEAT_FRAME
    await stream.aclose()
    assert cancelled


def test_an_event_stream_refuses_to_be_buffered():
    """
    The other half of the heartbeat. An intermediary that buffers holds it back
    until it has a bufferful, which is the same silence by a different route.
    """
    response = event_stream(_empty())
    assert response.media_type == "text/event-stream"
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"


async def _empty() -> AsyncIterator[str]:
    return
    yield ""


@pytest.mark.asyncio
async def test_cancellation_joins_a_durable_write_before_cleanup(tmp_path):
    import threading
    from delphi_core.sse import run_durable_write

    started = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()
    output = tmp_path / "late-figure.webp"
    cleaned = False

    def write():
        loop.call_soon_threadsafe(started.set)
        assert release.wait(5)
        output.write_bytes(b"figure")

    async def publish():
        nonlocal cleaned
        try:
            await run_durable_write(write)
        finally:
            output.unlink(missing_ok=True)
            cleaned = True

    task = asyncio.create_task(publish())
    await asyncio.wait_for(started.wait(), 2)
    task.cancel()
    try:
        await asyncio.sleep(0)
        assert not cleaned, "cleanup must wait for the worker thread"
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 2)
    assert cleaned
    assert not output.exists()


@pytest.mark.asyncio
async def test_a_completed_pull_is_closed_before_transport_returns():
    closed = False
    async def source():
        nonlocal closed
        try:
            yield sse({"type": "progress"})
        finally:
            closed = True
    stream = keep_alive(source())
    await anext(stream)
    await stream.aclose()
    assert closed
