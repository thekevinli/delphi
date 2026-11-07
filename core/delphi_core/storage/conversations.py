"""Conversation identity is independent of the evidence scope.

Existing records and image sidecars remain readable in place. The versioned
selector is internal: it fences every storage call made by a running answer,
including calls made after the reader clears the last conversation.
"""

from datetime import datetime, timezone
from fastapi import HTTPException

LIMIT = 10
KINDS = {"document": "document_chat", "general": "memory_chat"}


def selector(conversation_id, generation=0):
    return f"conversation-{conversation_id}-{generation}"


def require_selector(key):
    """(conversation id, generation) from a selector; anything else names nothing."""
    parts = str(key).split("-")
    if len(parts) != 3 or parts[0] != "conversation" or len(parts[1]) != 32 or not parts[2].isdigit():
        raise HTTPException(404, "Conversation not found")
    return parts[1], int(parts[2])


def same_scope(row, scope, project_id, paper_id):
    return (row.get("kind"), row.get("projectId"), row.get("paperId")) == (
        KINDS[scope], project_id, paper_id if scope == "document" else None,
    )


def summary(row):
    return {key: row.get(key) for key in (
        "id", "kind", "projectId", "paperId", "title", "createdAt", "lastEngagedAt", "personaId", "lastChatModel"
    )} | {"generation": row.get("generation", 0), "empty": row.get("empty", not row.get("messages")),
         "manualTitle": bool(row.get("manualTitle"))}


def validate_scope(store, username, scope, project_id, paper_id):
    if scope not in KINDS:
        raise HTTPException(400, "Invalid chat context")
    if scope == "general":
        if project_id or paper_id:
            raise HTTPException(400, "General chat has no project or document")
        if not store.account_exists(username):
            raise HTTPException(404, "Account not found")
    elif not project_id:
        raise HTTPException(400, "This context requires a project")
    elif scope == "document":
        if not paper_id:
            raise HTTPException(400, "Document chat requires a document")
        store.get_paper(username, project_id, paper_id)


# A running answer renews its conversation's `answering` stamp every
# ANSWER_HEARTBEAT_SECONDS (delphi_core/answer_heartbeat.py). A question with no answer
# and no stamp newer than ANSWER_STALE_SECONDS belongs to a process that died —
# a recycled Cloud Run instance, a quit desktop app — so the next question
# closes it rather than being refused. Six missed beats: long enough that a
# slow database write or a busy threadpool never looks like death, short
# enough that a reader who retries after a crash waits about a minute.
ANSWER_HEARTBEAT_SECONDS = 15.0
ANSWER_STALE_SECONDS = 90.0


def _age_seconds(stamp):
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(stamp)).total_seconds()
    except (TypeError, ValueError):
        return float("inf")


def answer_is_alive(question, answering):
    """Whether the process answering `question` has been heard from recently."""
    ages = [_age_seconds(question.get("createdAt"))]
    if answering and answering.get("requestId") == question.get("requestId"):
        ages.append(_age_seconds(answering.get("at")))
    return min(ages) < ANSWER_STALE_SECONDS


def check_append(messages, message, answering=None):
    """
    Called under the same lock as append; no second provider call on retry.

    Returns an assistant marker closing an abandoned question, which the caller
    appends before `message`, or None. The marker is `cancelled`, so a zombie
    stream that outlived its heartbeat is fenced like a stopped one, and
    `complete_exchanges` leaves the dead question out of later context.
    """
    request_id = message.get("requestId")
    if message.get("role") == "user":
        if request_id and any(m.get("requestId") == request_id for m in messages):
            raise HTTPException(409, "This question was already submitted; reload its conversation")
        users = [m for m in messages if m.get("role") == "user"]
        if users and users[-1].get("requestId"):
            last = users[-1]
            if not any(m.get("role") == "assistant" and m.get("requestId") == last["requestId"] for m in messages):
                if answer_is_alive(last, answering):
                    raise HTTPException(409, "This conversation is still answering")
                return {"role": "assistant", "content": "Request interrupted.", "cancelled": True,
                        "interrupted": True, "createdAt": datetime.now(timezone.utc).isoformat(),
                        "requestId": last["requestId"]}
    elif message.get("role") == "assistant" and request_id:
        if any(m.get("role") == "assistant" and m.get("requestId") == request_id for m in messages):
            raise HTTPException(409, "This answer has already finished")
        users = [m for m in messages if m.get("role") == "user"]
        if not users or users[-1].get("requestId") != request_id:
            raise HTTPException(409, "This answer is no longer active")
    return None


class LocalConversationCatalog:
    def list_scope_conversations(self, username, scope, project_id=None, paper_id=None):
        from .local import CONVERSATION_LOCK
        validate_scope(self, username, scope, project_id, paper_id)
        with CONVERSATION_LOCK:
            rows = [r for r in self._conversation_heads(username) if same_scope(r, scope, project_id, paper_id)]
            rows.sort(key=lambda r: (r.get("createdAt", ""), r["id"]))
            return {"items": [summary(r) for r in rows], "defaultId": rows[0]["id"] if rows else None, "limit": LIMIT}

    def create_conversation(self, username, scope, project_id, paper_id, creation_key):
        from uuid import uuid4
        from .base import utc_now, safe_id
        from .local import CONVERSATION_LOCK
        safe_id(creation_key)
        validate_scope(self, username, scope, project_id, paper_id)
        with CONVERSATION_LOCK:
            rows = [r for r in self._conversation_heads(username) if same_scope(r, scope, project_id, paper_id)]
            for row in rows:
                if row.get("creationKey") == creation_key:
                    return summary(row)
            if len(rows) == 1 and rows[0]["empty"] and not rows[0].get("creationKey"):
                row = self._read_json(self._conversation_path(username, rows[0]["id"]), {})
            else:
                if len(rows) >= LIMIT:
                    raise HTTPException(409, "10 chats maximum. Continue a chat or delete one to start another.")
                now = utc_now()
                row = {"id": uuid4().hex, "kind": KINDS[scope], "projectId": project_id,
                       "paperId": paper_id if scope == "document" else None, "title": "New chat",
                       "createdAt": now, "lastEngagedAt": now, "messages": [], "generation": 0,
                       "memoryFiledThrough": None}
                row["threadKey"] = selector(row["id"])
            row["creationKey"] = creation_key
            self._write_json(self._conversation_path(username, row["id"]), row)
            return summary(row)

    def rename_conversation(self, username, conversation_id, title, generation):
        from .local import CONVERSATION_LOCK
        with CONVERSATION_LOCK:
            row = self.get_conversation(username, conversation_id)
            if row.get("generation", 0) != generation:
                raise HTTPException(409, "Conversation changed; reload it")
            row.update(title=title, manualTitle=True)
            self._write_json(self._conversation_path(username, conversation_id), row)
            return summary(row)

    def delete_conversation(self, username, conversation_id, generation, *, reset=False):
        from .local import CONVERSATION_LOCK, CHAT_IMAGE_LOCK
        # Same lock order as attachment writes. Metadata commits before bytes
        # are cleaned by the route; stale selectors can never create records.
        with CHAT_IMAGE_LOCK, CONVERSATION_LOCK:
            row = self.get_conversation(username, conversation_id)
            if row.get("generation", 0) != generation:
                raise HTTPException(409, "Conversation changed; reload it")
            peers = [r["id"] for r in sorted(self._conversation_heads(username), key=lambda r: (r.get("createdAt", ""), r["id"]))
                     if (r.get("kind"), r.get("projectId"), r.get("paperId")) ==
                     (row.get("kind"), row.get("projectId"), row.get("paperId"))]
            image_path = self._chat_sidecar(username, row, "images")
            sequence_path = self._chat_sidecar(username, row, "image-sequence")
            images = self._read_json(image_path, [])
            do_reset = reset or len(peers) == 1
            if do_reset:
                row.update(messages=[], title="New chat", generation=generation + 1, manualTitle=False,
                           personaId=None, lastChatModel=None, creationKey=None, titleEngagementId=None,
                           titleModel=None, titleUpdatedAt=None, answering=None,
                           memoryFiledThrough=None)
                row["threadKey"] = selector(conversation_id, generation + 1)
                self._write_json(self._conversation_path(username, conversation_id), row)
                selected = conversation_id
            else:
                index = peers.index(row["id"])
                peers.remove(row["id"])
                selected = peers[min(index, len(peers) - 1)]
                self._conversation_path(username, conversation_id).unlink()
            image_path.unlink(missing_ok=True)
            sequence_path.unlink(missing_ok=True)
            return {"action": "reset" if do_reset else "deleted", "selectedId": selected,
                    "images": images}


    def finish_cancelled_trace(self, username, conversation_id, generation, request_id, trace):
        from .local import CONVERSATION_LOCK
        with CONVERSATION_LOCK:
            path = self._conversation_path(username, conversation_id)
            row = self._read_json(path, {})
            if not row or row.get("generation", 0) != generation:
                return
            for message in row.get("messages", []):
                if message.get("role") == "assistant" and message.get("requestId") == request_id and message.get("cancelled") and not message.get("trace"):
                    message["trace"] = [{**stretch, "offset": 0} for stretch in trace]
                    self._write_json(path, row)
                    return

    def renew_answer(self, username, conversation_id, generation, request_id):
        """Stamp a running answer as alive; False once it is no longer the one owed."""
        from .base import utc_now
        from .local import CONVERSATION_LOCK
        with CONVERSATION_LOCK:
            path = self._conversation_path(username, conversation_id)
            row = self._read_json(path, {})
            if not row or row.get("generation", 0) != generation:
                return False
            last = (row.get("messages") or [{}])[-1]
            if last.get("role") != "user" or last.get("requestId") != request_id:
                return False
            row["answering"] = {"requestId": request_id, "at": utc_now()}
            self._write_json(path, row)
            return True


def resolve_selector(store, username, scope, project_id, paper_id, conversation_id, generation=None):
    """Every chat operation names its conversation; the context only checks it."""
    if not conversation_id:
        raise HTTPException(422, "conversation_id is required")
    row = store.get_conversation(username, conversation_id)
    if not same_scope(row, scope, project_id, paper_id):
        raise HTTPException(404, "Conversation not found in this context")
    current = row.get("generation", 0)
    if generation is not None and current != generation:
        raise HTTPException(409, "Conversation changed; reload it")
    return selector(conversation_id, current)
