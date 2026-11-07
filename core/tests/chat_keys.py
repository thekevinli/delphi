"""Tests name a conversation by its context; storage takes a selector.

`chat_key` creates the context's conversation once (idempotent on a creation key
derived from the context) and returns its current selector, so a test can keep
writing `chat_key(storage, "reader", project, "paper-b")` where it used to write
`"paper-b"`.
"""
from delphi_core.storage.conversations import selector


def chat_key(storage, username, project_id=None, scope_key=None, *, name="default"):
    if project_id is None:
        scope, paper_id = "general", None
    else:
        scope, paper_id = "document", str(scope_key).removeprefix("paper-")
    context = paper_id or project_id or "account"
    item = storage.create_conversation(username, scope, project_id, paper_id, f"t_{name}_{context}"[:64])
    return selector(item["id"], item["generation"])


def conversation_params(client, scope, project_id=None, paper_id=None, *, name="default"):
    """The query/body fields naming one conversation, created through the API."""
    context = {"scope": scope}
    if project_id:
        context["project_id"] = project_id
    if paper_id:
        context["paper_id"] = paper_id
    created = client.post("/api/chat/conversations", json={
        **context, "creation_key": f"t_{name}_{paper_id or project_id or 'account'}"[:64],
    })
    assert created.status_code == 201, created.text
    item = created.json()
    return {**context, "conversation_id": item["id"], "generation": item["generation"]}


def conversation_qs(client, scope, project_id=None, paper_id=None, *, name="default"):
    from urllib.parse import urlencode
    return urlencode(conversation_params(client, scope, project_id, paper_id, name=name))
