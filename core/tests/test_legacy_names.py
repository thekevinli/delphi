"""
Names that old data still carries, read as old data carries them.

Each test here feeds a stored value written before a rename and asserts what
Delphi does with it today. The old spellings are literals on purpose: they
are data in someone's library or database, not names in this code, so a
rename of the code must leave every one of them exactly as written. If one of
these fails after a rename, the rename reached a stored value it should have
left alone.

Plan 4's frozen list of these sites names each test here (L5). L1 reads an
Alembic revision, so it went with the SQL store's migrations.
"""

import json

from fastapi.testclient import TestClient

from delphi_core.config import Settings, get_settings
from delphi_core.main import app
from delphi_core.storage import LocalObjectStore, LocalStorage, chat_image_prefix
from tests.chat_keys import conversation_params
from tests.test_chat_images import encoded_image


def test_an_account_conversation_from_before_selectors_keeps_its_images(tmp_path):
    """
    L5. An account-wide conversation written before conversation selectors has
    no `threadKey`. Its image sidecars and bytes were filed under the fixed key
    `knowledge-base`, and that key is a stored path, not a name: the image is
    still listed and served, and the next one is numbered after it.
    """
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-123"})
            chat = conversation_params(client, "general")
            uploaded = client.post("/api/chat/images", params=chat,
                                   files={"image": ("figure.png", encoded_image(), "image/png")})
            assert uploaded.status_code == 201 and uploaded.json()["number"] == 1
            image_id = uploaded.json()["id"]

            # Put the conversation back the way it was stored before selectors:
            # no `threadKey` on the row, and its sidecars and bytes under the
            # account chat's fixed key.
            storage = LocalStorage(settings)
            objects = LocalObjectStore(tmp_path, settings.chat_image_retention_days)
            row_path = storage._conversation_path("reader", chat["conversation_id"])
            row = json.loads(row_path.read_text())
            current = {"threadKey": row.pop("threadKey"), "projectId": None}
            row_path.write_text(json.dumps(row))
            old = {"projectId": None}
            old_images = storage._chat_sidecar("reader", old, "images")
            old_sequence = storage._chat_sidecar("reader", old, "image-sequence")
            assert (old_images.name, old_sequence.name) == ("knowledge-base-images.json", "knowledge-base-image-sequence.json")
            assert chat_image_prefix("reader", None) == "chat-images/u/reader/account/knowledge-base/"
            storage._chat_sidecar("reader", current, "image-sequence").rename(old_sequence)
            records = json.loads(storage._chat_sidecar("reader", current, "images").read_text())
            storage._chat_sidecar("reader", current, "images").unlink()
            for record in records:
                for field in ("imageKey", "thumbnailKey"):
                    moved = "chat-images/u/reader/account/knowledge-base/" + record[field].rsplit("/", 1)[-1]
                    assert objects.copy(record[field], moved)
                    objects.delete(record[field])
                    record[field] = moved
            old_images.write_text(json.dumps(records))

            listed = client.get("/api/chat", params=chat).json()
            assert [image["id"] for image in listed["images"]] == [image_id]
            thumbnail = client.get(f"/api/chat/images/{image_id}/thumbnail", params=chat)
            assert thumbnail.status_code == 200 and thumbnail.content
            following = client.post("/api/chat/images", params=chat,
                                    files={"image": ("second.png", encoded_image(), "image/png")})
            assert following.status_code == 201 and following.json()["number"] == 2
    finally:
        app.dependency_overrides.clear()
