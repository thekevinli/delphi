"""
A running answer says it is alive, and learns whether it is still owed.

Every ANSWER_HEARTBEAT_SECONDS the stream stamps its conversation through
`Storage.renew_answer`. That one small write does two jobs:

- Liveness. `check_append` refuses a second question only while the first one's
  stamp is fresh, so a process that died mid-answer blocks its conversation for
  ANSWER_STALE_SECONDS rather than until someone intervenes.
- Cancellation. The write answers False once the question is no longer the one
  being answered — Stop appended its marker, the conversation was deleted or
  reset, a stale question was closed. The stream reads `live`, an attribute,
  on every model event: cancellation costs no storage read per token.

A failed renewal is not a verdict. A database blip must not kill a healthy
answer, so an exception is logged and the next beat tries again; if the
process is genuinely gone, the missing stamps say so on their own.
"""

import asyncio
import logging
from typing import Any

from starlette.concurrency import run_in_threadpool

from .storage.conversations import ANSWER_HEARTBEAT_SECONDS

logger = logging.getLogger(__name__)


class AnswerHeartbeat:
    def __init__(
        self, storage: Any, username: str, conversation_id: str | None,
        generation: int, request_id: str, *, every: float = ANSWER_HEARTBEAT_SECONDS,
    ):
        self._args = (username, conversation_id, generation, request_id)
        self._storage = storage
        self._every = every
        self._task: asyncio.Task[None] | None = None
        self.live = True

    def start(self) -> None:
        if self._task is None and self._args[1]:
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self._every)
            try:
                alive = await run_in_threadpool(self._storage.renew_answer, *self._args)
            except Exception:
                logger.warning("answer heartbeat failed", exc_info=True)
                continue
            if not alive:
                self.live = False
                return
