"""
The persona marketplace over HTTP.

The test that matters is `test_a_published_persona_survives_its_author`: publish,
install, then have the author edit, unpublish and delete. Everything about the
marketplace's safety argument rests on the installer being unaffected by all
three, and it is the assertion that would fail first if install ever became a
reference instead of a fork.
"""

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from tests.chat_keys import chat_key, conversation_params, conversation_qs
from delphi_core.config import Settings, get_settings
from delphi_core.personas import DEFAULT_PERSONA_KEY, MENTOR_SKILLS, persona_for_turn
from delphi_core.main import app


def storage_for(client: TestClient):
    """The same store the routes resolve against, for asserting past the wire."""
    return app.state.stores.storage(app.dependency_overrides[get_settings]())


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()


def register(client, username):
    """A fresh signed-in session. The cookie jar carries whoever registered last."""
    response = client.post(
        "/api/auth/register",
        json={"username": username, "password": "password-123"},
    )
    assert response.status_code == 200


def sign_in(client, username):
    assert (
        client.post(
            "/api/auth/login",
            json={"username": username, "password": "password-123"},
        ).status_code
        == 200
    )


def make_project(client, name="Reading"):
    response = client.post("/api/projects", json={"name": name})
    assert response.status_code == 201
    return response.json()


def document_qs(client, username, name="Reading"):
    """A project with one paper, so the document scope has something to name."""
    project = make_project(client, name)
    storage_for(client).add_paper(
        username, project["id"], {"id": "paper", "title": "P", "filename": "p.pdf"}
    )
    return conversation_qs(client, "document", project["id"], "paper")


def test_the_official_personas_are_offered_without_a_database_row(client):
    register(client, "reader")

    catalog = client.get("/api/personas")
    assert catalog.status_code == 200
    body = catalog.json()

    # Two, not four. Tutor never actually asked its calibration question — four
    # exemptions saw to that — so Mentor absorbed it; Researcher's body was
    # evidence discipline, which is not a style a reader should be able to
    # switch off, so it became `EVIDENCE_REQUIREMENTS` in every scope instead.
    assert [item["id"] for item in body["official"]] == ["mentor", "adhd"]
    assert [item["element"] for item in body["official"]] == ["water", "bolt"]
    assert body["mine"] == []
    # A listing never carries bodies.
    assert all("content" not in item for item in body["official"])

    detail = client.get("/api/personas/mentor")
    assert detail.json()["content"] == MENTOR_SKILLS


def test_a_retired_official_key_is_simply_unknown(client):
    """
    `tutor` and `researcher` get no alias and no redirect.

    They are ordinary unknown ids, which is what they are. The one-time cleanup
    — `c1f4e082a6d3` for SQL — is what stopped anything naming them, so there is
    no compatibility layer to carry forward and no second place ownership is
    decided.
    """
    register(client, "reader")

    for retired in ("tutor", "researcher"):
        assert client.get(f"/api/personas/{retired}").status_code == 404
        assert (
            client.put(f"/api/chat/persona?{conversation_qs(client, 'general')}",
                       json={"persona_id": retired}).status_code == 404
        )


def test_a_fresh_conversation_answers_as_the_default_persona(client):
    """
    Asserted against the constant rather than against `"adhd"`, so moving the
    default is one edit. It has moved once already — a project started on
    Researcher when a persona belonged to a project — and a test that spells
    the answer out would have had to be rewritten rather than simply passing.
    """
    register(client, "reader")
    project = make_project(client)
    scope = document_qs(client, "reader")

    assert "persona" not in project
    thread = client.get(f"/api/chat?{scope}").json()
    # Never chosen is None rather than the default spelled out: what answers is
    # resolved per turn, so storing a default would freeze today's answer into
    # every conversation ever opened.
    assert thread["personaId"] is None

    chosen = client.put(
        f"/api/chat/persona?{scope}",
        json={"persona_id": "mentor"},
    )
    assert chosen.status_code == 204
    assert client.get(
        f"/api/chat?{scope}"
    ).json()["personaId"] == "mentor"


def test_a_persona_is_remembered_per_conversation_not_per_project(client):
    """
    Two conversations in one project hold two personas at once. That is the
    whole move: the voice belongs to the question being asked, not to the
    folder the document sits in.
    """
    register(client, "reader")
    document_scope = document_qs(client, "reader")
    general_scope = conversation_qs(client, "general")

    client.put(f"/api/chat/persona?{document_scope}", json={"persona_id": "mentor"})
    client.put(f"/api/chat/persona?{general_scope}", json={"persona_id": "adhd"})

    assert client.get(f"/api/chat?{document_scope}").json()["personaId"] == "mentor"
    assert client.get(f"/api/chat?{general_scope}").json()["personaId"] == "adhd"


def test_choosing_a_persona_does_not_leave_a_conversation_behind(client):
    """
    Picking writes to the conversation, which means creating one if the reader
    has not spoken yet. Opening a menu must not litter their history with chats
    they never had.
    """
    register(client, "reader")
    scope = document_qs(client, "reader")

    client.put(
        f"/api/chat/persona?{scope}",
        json={"persona_id": "mentor"},
    )

    assert client.get("/api/dashboard").json()["conversations"] == []


def test_a_persona_another_account_owns_cannot_be_chosen(client):
    """
    Every scope now sends a persona id on the request, so the route is a way in
    for a stranger's mutable instructions if it does not check. Publishing does
    not help them: the marketplace is readable, and installing — which forks the
    text into a row this reader owns — is the only way it can ever answer.
    """
    register(client, "author")
    private = client.post(
        "/api/personas",
        json={"name": "Private", "element": "fire", "content": "Author's own."},
    ).json()
    published = client.post(
        "/api/personas",
        json={
            "name": "Published",
            "element": "wind",
            "content": "Mutable.",
            "visibility": "public",
        },
    ).json()
    client.post("/api/auth/logout")

    register(client, "reader")
    scope = document_qs(client, "reader")
    for persona in (private, published):
        refused = client.put(
            f"/api/chat/persona?{scope}", json={"persona_id": persona["id"]}
        )
        assert refused.status_code == 404

    installed = client.post(f"/api/personas/{published['id']}/install").json()
    accepted = client.put(
        f"/api/chat/persona?{scope}", json={"persona_id": installed["id"]}
    )
    assert accepted.status_code == 204


def test_an_official_persona_cannot_be_edited_or_installed(client):
    register(client, "reader")

    edited = client.patch("/api/personas/mentor", json={"content": "Mine now."})
    # 409 rather than 404: it exists, it is simply not yours to change.
    assert edited.status_code == 409

    installed = client.post("/api/personas/adhd/install")
    assert installed.status_code == 409


def test_an_official_persona_is_readable_but_not_writable(client):
    """
    Both are code: readable in full — which is what the pane's magnifier serves
    — and not editable, forked, or started from. `PUT /skills` used to fork a
    project's official persona into a private copy on the first save; that
    endpoint is gone with the project persona, and nothing replaced it, because
    "New persona" already writes one. A reader who wants to begin from an
    official's wording can read it here and paste it.
    """
    register(client, "reader")

    body = client.get("/api/personas/mentor").json()["content"]
    assert body == MENTOR_SKILLS

    forked = client.post(
        "/api/personas",
        json={
            "name": "Mentor (edited)",
            "element": "fire",
            "content": f"{body}\n\nAlways give the equation first.",
        },
    )
    assert forked.status_code == 201
    persona = forked.json()
    assert persona["official"] is False
    assert persona["visibility"] == "private"
    assert client.get("/api/personas").json()["mine"][0]["id"] == persona["id"]
    # The shipped Mentor is untouched for everyone.
    assert client.get("/api/personas/mentor").json()["content"] == MENTOR_SKILLS


def test_a_private_persona_is_invisible_to_another_account(client):
    register(client, "author")
    created = client.post(
        "/api/personas",
        json={"name": "Notes to self", "element": "wind", "content": "Terse."},
    )
    assert created.status_code == 201
    persona_id = created.json()["id"]
    assert created.json()["visibility"] == "private"

    register(client, "stranger")
    # 404, never 403: the API must not confirm the id exists to someone who
    # cannot see it.
    assert client.get(f"/api/personas/{persona_id}").status_code == 404
    assert client.get("/api/personas/browse").json()["items"] == []
    assert client.post(f"/api/personas/{persona_id}/install").status_code == 404


def test_a_published_persona_survives_its_author(client):
    register(client, "author")
    created = client.post(
        "/api/personas",
        json={
            "name": "Close reading",
            "element": "water",
            "tagline": "Quote before paraphrasing.",
            "content": "Original wording.",
        },
    )
    persona_id = created.json()["id"]
    published = client.patch(
        f"/api/personas/{persona_id}",
        json={"visibility": "public", "expected_revision": 1},
    )
    assert published.status_code == 200

    register(client, "stranger")
    listing = client.get("/api/personas/browse")
    assert [item["id"] for item in listing.json()["items"]] == [persona_id]
    assert listing.json()["items"][0]["author"] == "author"
    assert "content" not in listing.json()["items"][0]
    assert listing.headers["cache-control"] == "private, max-age=15"

    # Preview the full body before trusting it. Nothing is applied unseen.
    assert client.get(f"/api/personas/{persona_id}").json()["content"] == (
        "Original wording."
    )

    installed = client.post(f"/api/personas/{persona_id}/install")
    assert installed.status_code == 201
    assert installed.json()["installedFrom"] == persona_id
    # Installing selects nothing. A persona belongs to a conversation, and a
    # marketplace row has none in view — the reader picks the fork afterwards
    # from the composer, where they can see what it will answer.
    assert installed.json()["id"] in {
        item["id"] for item in client.get("/api/personas").json()["mine"]
    }

    sign_in(client, "author")
    assert (
        client.patch(
            f"/api/personas/{persona_id}",
            json={"content": "Rewritten.", "expected_revision": 2},
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/personas/{persona_id}",
            json={"visibility": "private", "expected_revision": 3},
        ).status_code
        == 200
    )
    assert client.delete(f"/api/personas/{persona_id}").status_code == 204

    sign_in(client, "stranger")
    # Edited, unpublished, then deleted — and the reader who installed it is
    # untouched by all three. That is the entire safety argument for letting
    # strangers publish instructions.
    assert client.get(f"/api/personas/{installed.json()['id']}").json()["content"] == (
        "Original wording."
    )


def test_a_stale_edit_is_refused_with_the_current_record(client):
    register(client, "author")
    persona_id = client.post(
        "/api/personas",
        json={"name": "Careful", "element": "stone", "content": "First."},
    ).json()["id"]
    assert (
        client.patch(
            f"/api/personas/{persona_id}",
            json={"content": "Second.", "expected_revision": 1},
        ).status_code
        == 200
    )

    stale = client.patch(
        f"/api/personas/{persona_id}",
        json={"content": "Third.", "expected_revision": 1},
    )

    assert stale.status_code == 409
    # The current record travels with the conflict, so the client can show what
    # changed instead of just refusing.
    assert stale.json()["detail"]["persona"]["content"] == "Second."


def test_a_persona_a_conversation_uses_can_still_be_deleted(client):
    """
    Deleting used to be refused while a project pointed at the persona. A
    conversation resolves its persona per turn, so a dangling id falls back to
    the default — and refusing on conversations instead would make a persona
    used for a month undeletable, which is worse than the rule it replaces.
    """
    register(client, "author")
    persona_id = client.post(
        "/api/personas",
        json={"name": "Pinned", "element": "leaf", "content": "Ask first."},
    ).json()["id"]
    scope = document_qs(client, "author", "Holder")
    client.put(f"/api/chat/persona?{scope}", json={"persona_id": persona_id})

    assert client.delete(f"/api/personas/{persona_id}").status_code == 204

    # The conversation keeps the id it was held in — resolution is what falls
    # back, so the stored record is not rewritten behind the reader's back.
    assert client.get(f"/api/chat?{scope}").json()["personaId"] == persona_id


def test_installing_twice_is_one_copy(client):
    register(client, "author")
    persona_id = client.post(
        "/api/personas",
        json={
            "name": "Popular",
            "element": "bolt",
            "content": "Body.",
            "visibility": "public",
        },
    ).json()["id"]

    register(client, "stranger")
    first = client.post(f"/api/personas/{persona_id}/install").json()
    second = client.post(f"/api/personas/{persona_id}/install").json()

    assert first["id"] == second["id"]
    assert len(client.get("/api/personas").json()["mine"]) == 1


def test_browse_pages_forward_and_searches(client):
    register(client, "author")
    for index in range(5):
        client.post(
            "/api/personas",
            json={
                "name": f"Style {index}",
                "element": "stone",
                "tagline": "even" if index % 2 == 0 else "odd",
                "content": "Body.",
                "visibility": "public",
            },
        )

    register(client, "stranger")
    first = client.get("/api/personas/browse", params={"limit": 2}).json()
    assert len(first["items"]) == 2
    second = client.get(
        "/api/personas/browse", params={"limit": 2, "cursor": first["nextCursor"]}
    ).json()
    third = client.get(
        "/api/personas/browse", params={"limit": 2, "cursor": second["nextCursor"]}
    ).json()

    seen = [item["id"] for page in (first, second, third) for item in page["items"]]
    assert len(set(seen)) == 5
    assert third["nextCursor"] is None

    assert len(client.get("/api/personas/browse", params={"q": "odd"}).json()["items"]) == 2
    assert client.get("/api/personas/browse", params={"q": "zzz"}).json()["items"] == []


def test_persona_bodies_are_bounded_at_the_edge(client):
    register(client, "reader")

    assert (
        client.post(
            "/api/personas",
            json={"name": "Too long", "element": "fire", "content": "x" * 30_001},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/personas",
            json={"name": "n" * 41, "element": "fire", "content": "Body."},
        ).status_code
        == 422
    )
    # An unknown element would render as a gap; the set is closed in the type.
    assert (
        client.post(
            "/api/personas",
            json={"name": "Bad element", "element": "plasma", "content": "Body."},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/personas",
            json={"name": "Blank", "element": "fire", "content": "   "},
        ).status_code
        == 422
    )


def test_personas_require_a_session(client):
    assert client.get("/api/personas").status_code == 401
    assert client.get("/api/personas/browse").status_code == 401
    assert client.get("/api/personas/mentor").status_code == 401


def test_config_publishes_the_persona_limits(client):
    config = client.get("/api/config").json()

    # The client must not carry its own copy of a limit the server enforces.
    assert config["personaMaxCharacters"] == 30_000
    assert config["personaMarketplaceEnabled"] is True
    assert config["memoryEnabled"] is True
    assert config["memoryRelatedHops"] == 2


def test_the_adhd_persona_states_a_default_answer_size_and_forbids_restating():
    """
    The two failures this wording exists to prevent, seen in real answers.

    A comparison that put the numbers in a table, then again in bullets, then a
    third time under "Bottom line:" — every one of those passed "no recap",
    which only reads as a ban on the word summary. And "What is this paper
    about?" answered with an inventory of tasks, conditioning, architecture and
    training stages, because nothing said how much the question had asked for.

    Pinned as text because the failure mode is somebody tightening this body and
    dropping the two rules that make it hold; what they actually do to an answer
    is the manual evaluation's job, not a unit test's.
    """
    from delphi_core.personas import ADHD

    body = ADHD.content

    assert "# Default answer size" in body
    assert "Give the smallest answer that resolves the question." in body
    assert "Do not present the same findings in two structures." in body
    assert "State each finding once." in body
    assert "Do not add a conclusion that repeats the opening answer." in body
    # The supports are conditional, not sections every answer carries.
    assert "Only for a reading task." in body
    assert "only when it bears on the question" in body
    # Claims are budgeted; citations are not. Removing a reference to shorten an
    # answer is the opposite of the fix.
    assert "Budget the claims, never the citations." in body


def test_a_reader_scope_answers_as_the_persona_the_conversation_holds(client):
    """
    The pill said Mentor and ADHD answered.

    `chat_stream` resolved `body.persona_id or DEFAULT_PERSONA_KEY` and never
    looked at the conversation — while the reader scopes' client sends no
    `persona_id` at all, because a stale comment on `ChatRequest` still
    described the project persona that `b8d24f60a3c1` deleted. So every reader
    turn answered as the default, and then the stream's own
    `set_conversation_persona` stamped that default over the pick
    `PUT /api/chat/persona` had just recorded — erasing the evidence with it.

    Asserted through the stored id rather than the instructions, because the
    stamp is the half that destroyed data.
    """
    register(client, "reader")
    scope = document_qs(client, "reader")

    client.put(f"/api/chat/persona?{scope}", json={"persona_id": "mentor"})
    assert client.get(f"/api/chat?{scope}").json()["personaId"] == "mentor"

    # What the reader-scope client actually sends: no persona_id. The stream
    # cannot run without a model key, so this is asserted at the resolver the
    # route calls rather than through a request that would fail earlier for an
    # unrelated reason — and that resolver is the whole of the fix.
    stored = client.get(f"/api/chat?{scope}").json()["personaId"]
    resolved = persona_for_turn(storage_for(client), "reader", None, stored)

    assert resolved["id"] == "mentor"
    # Which is what the stream then stamps back. Before the fix the resolution
    # was `body.persona_id or DEFAULT_PERSONA_KEY`, so this read "adhd" and the
    # stamp overwrote the pick.
    assert resolved["content"] == MENTOR_SKILLS


def test_naming_an_unknown_persona_is_still_a_bad_request(client):
    """
    Reading the conversation must not soften the explicit case.

    A dangling *stored* id is ordinary and falls back; an id a live request
    names is a 404. Retired keys are the reason this matters — `tutor` has to
    fail loudly for a client still sending it, not quietly answer as ADHD.
    """
    register(client, "reader")
    scope = document_qs(client, "reader")

    with pytest.raises(HTTPException) as raised:
        persona_for_turn(storage_for(client), "reader", "tutor", "mentor")

    assert raised.value.status_code == 404
    # But the same id merely *stored* falls back rather than breaking the
    # thread — the asymmetry this resolver exists to keep.
    assert persona_for_turn(
        storage_for(client), "reader", None, "tutor"
    )["id"] == DEFAULT_PERSONA_KEY


@pytest.mark.parametrize("scope", ["document", "general"])
def test_an_edit_naming_an_unknown_persona_keeps_the_question(client, scope):
    """
    The persona is resolved before the replacement drop, in both routes.

    It was once resolved after it, so an edit whose named persona 404s had
    already deleted the question it was replacing — and a client echoing a
    since-deleted persona id made that the ordinary path for editing any
    question in a conversation held in one.
    """
    register(client, "reader")
    storage = storage_for(client)
    question = {"role": "user", "content": "typo here", "requestId": "request_edit01"}
    project_id = make_project(client)["id"] if scope == "document" else None
    if project_id:
        storage.add_paper(
            "reader", project_id, {"id": "paper", "title": "P", "filename": "p.pdf"}
        )
    body = conversation_params(client, scope, project_id, "paper" if project_id else None)
    key = chat_key(storage, "reader", project_id, "paper-paper" if project_id else None)
    url = "/api/chat/stream"
    if scope == "general":
        storage.append_memory_message("reader", question, key)

        def read():
            return storage.get_thread("reader", None, key)["messages"]
    else:
        storage.append_message("reader", project_id, key, question)

        def read():
            return storage.get_thread("reader", project_id, key)["messages"]

    response = client.post(
        url,
        json={
            **body,
            "prompt": "fixed",
            "persona_id": "tutor",
            "replace_request_id": "request_edit01",
        },
    )

    assert response.status_code == 404
    assert [message["content"] for message in read()] == ["typo here"]


def test_mentor_routes_narrowly_and_pitches_depth_from_what_was_read():
    """
    The two Mentor rules that cost something when they are wrong.

    Routing used to fire on "when they want to reach something they cannot reach
    yet", which is most requests to explain unfamiliar material — and the same
    step forbade explaining. A reader asking what a method is would be sent away
    to read instead of taught.

    And depth used to be pitched from a level the model had inferred and
    recorded about the reader. It is pitched now from what they show in the
    conversation and from what they marked finished, which is theirs to say.
    """
    from delphi_core.personas import MENTOR

    body = MENTOR.content

    assert "Route only when they ask for a learning path" in body
    assert "teach the material directly" in body
    # The invented acknowledgment is gone: the question ends the turn.
    assert "Good. Then B" not in body
    assert "The question ends your turn." in body
    # A route prefers what the reader has, and says when it leaves their library.
    assert "what you\n   were handed is a short list of candidates, not everything they hold" in body
    assert "Prefer a source they already have." in body
    assert "say\n   that it is outside their library" in body

    # Depth: the conversation first, then the `Reader:` line. No recorded level.
    assert "# Pitching depth" in body and "# Using what you recorded" not in body
    assert "What the reader shows in this conversation." in body
    assert "The `Reader:` line of the Memory pages you were given." in body
    assert "Finished means read. It does not mean mastered" in body
    assert "It never lets you refuse the basics when they ask." in body
    # No chat tool writes Memory, so a persona tells the model to record nothing.
    assert "Recording what they demonstrate" not in body
    # A connection to something read is not an analogy, and opens the answer.
    assert "Building on something the reader has read is not an analogy." in body
    assert "start from it: that is the orientation, and it comes first" in body

    # Omitted detail is mentioned when it matters, not inventoried.
    assert "only when it limits the answer" in body


def test_the_adapted_persona_carries_its_authors_mit_notice():
    # The ADHD persona is adapted from i-have-adhd; MIT requires its notice to travel
    # with it, and the desktop build's third-party notices read it from here.
    import delphi_core.personas as personas

    notice = personas.__doc__
    assert "https://github.com/ayghri/i-have-adhd" in notice
    assert "    Copyright (c) 2026 Ayoub Ghriss\n" in notice
    assert "Permission is hereby granted, free of charge, to any person obtaining a copy" in notice
    assert notice.rstrip().endswith("SOFTWARE.")
