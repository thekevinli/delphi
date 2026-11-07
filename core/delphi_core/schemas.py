from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator, model_validator

#: A conversation's title, however it was named: generated, renamed, or taken
#: from its opening question. Room for the whole question it pursued across a
#: wide window; every surface fits it to its own width, the Dashboard with an
#: ellipsis and a tab or a list with a fade. It was 80 characters and ten
#: words, and a title one word over lost its ending mid-phrase ("…K=0 vs")
#: before any screen could show it. Cut by `storage.base.fit_conversation_title`.
CONVERSATION_TITLE_MAX_CHARS = 120


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    password: str = Field(min_length=8, max_length=200)
    email: str | None = Field(default=None, max_length=200)
    # Only consulted by /register, and only when SIGNUP_CODE is configured.
    invite_code: str | None = Field(default=None, max_length=200)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=8, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


class AccountPreferencesUpdate(BaseModel):
    use_standard_tier: bool


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    # Made by first-run onboarding: recorded on the account's attempt, so an
    # interrupted attempt can be told apart from a library and cleaned up.
    onboarding: bool = False


class ProjectUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


"""
The persona vocabulary, as types rather than as validation in a handler.

`Element` is a closed set because it reaches the UI: an element picks an icon
and a colour token, and an open string would let a persona name an icon that
renders as a gap.
"""
Element = Literal["fire", "water", "leaf", "bolt", "stone", "wind"]


class PersonaCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    element: Element = "stone"
    # Plain text, rendered as plain text. A tagline is the one field of a public
    # persona a stranger sees before deciding to trust it; it never goes through
    # the markdown renderer.
    tagline: str | None = Field(default=None, max_length=140)
    content: str = Field(min_length=1, max_length=30_000)
    visibility: Literal["private", "public"] = "private"


class PersonaUpdate(BaseModel):
    """
    Every field optional, so publishing is a one-key request that cannot
    accidentally carry a stale body along with it.
    """

    name: str | None = Field(default=None, min_length=1, max_length=40)
    element: Element | None = None
    tagline: str | None = Field(default=None, max_length=140)
    content: str | None = Field(default=None, min_length=1, max_length=30_000)
    visibility: Literal["private", "public"] | None = None
    # The revision the client read. Omitted means "I have not read one", which is
    # only safe for a request that sets nothing a concurrent edit could lose.
    expected_revision: int | None = Field(default=None, ge=1)


class PersonaInstall(BaseModel):
    """
    Nothing, now that installing selects nothing.

    It used to carry a `project_id` so a browse row could fork and select in one
    round trip. A persona belongs to a conversation rather than to a project, and
    a marketplace row has no conversation in view — the reader picks the fork
    from the composer afterwards, where they can see what it will answer.
    """


class ChatPersonaSelect(BaseModel):
    """
    The persona a conversation is to be held in, chosen from the composer.

    One field, because a conversation names one persona: an official key, which
    is code, or an id this account owns. The two used to need separate fields
    on a project because a check constraint kept them exclusive; a single
    string is the shape that replaced it.
    """

    persona_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


class PaperUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class PaperDone(BaseModel):
    done: bool


class PaperMove(BaseModel):
    """Which project a paper is being filed into. Ownership is checked in storage."""

    project_id: str = Field(min_length=1, max_length=64)
    # Where in the destination it lands. Omitted by the picker, which has no
    # opinion; sent by the drag, which showed the reader a gap and has to put it
    # there. Clamped rather than validated against the list — the count can have
    # changed in another tab between the drag starting and the drop.
    position: int | None = Field(default=None, ge=0)


class PageCreate(BaseModel):
    """Adding a web page as a document. Validated properly in `web_fetch`."""

    url: str = Field(min_length=4, max_length=2000)
    # PDF links first answer with a non-blocking choice. A second request says
    # whether to keep the remote document as a page or import its bytes as a
    # full PDF with the native reader and persistent highlights.
    pdf_mode: Literal["ask", "web", "upload"] = "ask"


class NavigationMint(BaseModel):
    """A destination stays in the authenticated POST body, never a frame URL."""

    url: str = Field(min_length=4, max_length=2000)


class AnonymousViewport(BaseModel):
    source: Literal["anonymous"] = "anonymous"
    url: str = Field(min_length=4, max_length=2000)
    title: str | None = Field(default=None, max_length=500)
    kind: Literal["html", "image", "pdf", "unknown"] = "unknown"
    # Filled by the server after the one question-time fetch. Accepting it on
    # the wire is harmless because the fetched bytes remain authoritative.
    source_hash: str | None = Field(
        default=None, alias="sourceHash", pattern=r"^[a-f0-9]{64}$"
    )

    model_config = {"populate_by_name": True}


class CapturedViewport(BaseModel):
    source: Literal["captured"]
    kind: Literal["html"] = "html"
    url: str = Field(min_length=4, max_length=2000)
    title: str = Field(max_length=500)
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    texts: list[str] = Field(max_length=100000)
    source_hash: str | None = Field(default=None, alias="sourceHash")

    @model_validator(mode="after")
    def validate_capture(self):
        import hashlib
        if sum(len(t.encode("utf-16-le"))//2+1 for t in self.texts)>600000:
            raise ValueError("Captured article exceeds text limit")
        if hashlib.sha256(("1\n"+"\n".join(self.texts)).encode()).hexdigest()!=self.revision:
            raise ValueError("Captured article fingerprint mismatch")
        return self


ViewportContext = AnonymousViewport | CapturedViewport


class StagedUpload(BaseModel):
    """Answering the compression prompt. The token carries the paper itself."""

    token: str = Field(min_length=1, max_length=4000)


class DigestRequest(BaseModel):
    force: bool = False


class PaperOrderUpdate(BaseModel):
    paper_ids: list[str] = Field(min_length=1, max_length=50)


class PdfRect(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)


class PdfHighlight(BaseModel):
    type: Literal["pdf"] = "pdf"
    page: int = Field(ge=1)
    rects: list[PdfRect] = Field(min_length=1)
    text: str = Field(min_length=1, max_length=20_000)
    color: str = "amber"


class TextHighlight(BaseModel):
    type: Literal["text"] = "text"
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    text: str = Field(min_length=1, max_length=20_000)
    color: str = "amber"


class ResolvedPlacement(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    start: int = Field(ge=0, le=600000)
    end: int = Field(gt=0, le=600000)


class PlacementCache(BaseModel):
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    placements: list[ResolvedPlacement] = Field(max_length=10000)


class HtmlAnchor(BaseModel):
    version: Literal[1] = 1
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    blockHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    blockOrdinalHint: int = Field(ge=0, le=600000)
    startInBlock: int = Field(ge=0, le=600000)
    start: int = Field(ge=0, le=600000)
    end: int = Field(gt=0, le=600000)
    prefix: str = Field(max_length=128)
    suffix: str = Field(max_length=128)


class HtmlHighlight(BaseModel):
    type: Literal["html"]
    anchor: HtmlAnchor
    text: str = Field(min_length=1, max_length=20000)
    color: Literal["amber"] = "amber"
    requestId: str = Field(min_length=16, max_length=64, pattern=r"^[a-zA-Z0-9-]+$")

    @model_validator(mode="after")
    def validate_range(self):
        # DOM Range offsets are UTF-16 code units, including astral characters.
        if self.anchor.end - self.anchor.start != len(self.text.encode("utf-16-le")) // 2:
            raise ValueError("Anchor range must equal its canonical quote")
        return self


class NoteCreate(BaseModel):
    """
    What the reader wrote against a passage.

    `anchor_y` is the top of the highlight's first band, normalised like every
    other stored PDF coordinate (invariant 10), so the margin icon survives a
    zoom or a panel resize. `body` is markdown; the cap is smaller than a
    highlight's quoted text because this is a margin note, not a document.
    """

    highlight_id: str = Field(min_length=1, max_length=64, alias="highlightId")
    page: int | None = Field(ge=1)
    anchor_y: float | None = Field(ge=0, le=1, alias="anchorY")
    quoted_text: str = Field(min_length=1, max_length=20_000, alias="quotedText")
    body: str = Field(min_length=1, max_length=5_000)

    model_config = {"populate_by_name": True}


class NoteUpdate(BaseModel):
    body: str = Field(min_length=1, max_length=5_000)


"""
The structural ceiling on images in one question.

A base64 image is the largest thing a request can carry, so the list is bounded
in the type rather than only in the handler — a body that could never be served
should not reach the code that would try. `chat_image_max_per_question` is the
operational limit and may sit anywhere at or below this;
`test_chat_images.py` refuses to let the two invert, because a setting above
the ceiling would be answered by an unexplained 422 instead of the limit the
client was told about through `/api/config`.
"""
MAX_REFERENCED_IMAGES = 8


"""
Which evidence a question is asked against.

The two scopes are one conversation authority with two different reads:
`document` names the open document and carries the project library behind it,
and `general` attaches nothing but the account's own wiki.
"""
ChatScope = Literal["document", "general"]


class ChatRequest(BaseModel):
    # A field this schema does not name is refused, not ignored. Chat used to
    # carry a `web_search` switch; it is gone, and a client still sending it
    # (or any other leftover) must fail loudly rather than be quietly obeyed
    # in a way it did not ask for.
    model_config = ConfigDict(extra="forbid")

    mode: Literal["chat", "plan"] = "chat"
    # A caller may opt out of inline rendering without changing its own plan
    # protocol. This cannot enable a tool the deployment/profile does not offer.
    disable_artifacts: bool = False
    # The same opt-out for the explanation contract: the desktop's Plan mode
    # writes a plan through its own protocol, never `mode="plan"`, and a plan is
    # not an explanation of a paper.
    disable_explanation_contract: bool = False
    _plan: dict | None = PrivateAttr(default=None)
    # A side chat's own turns (`SideChatRequest.side_turns`). Set only by the
    # side route, which stores nothing; None on every stored turn.
    _side: list["SideTurn"] | None = PrivateAttr(default=None)
    conversation_id: str | None = Field(default=None, min_length=32, max_length=32, pattern=r"^[a-f0-9]+$")
    generation: int | None = Field(default=None, ge=0)

    prompt: str = Field(min_length=1, max_length=50_000)
    scope: ChatScope
    # Carried in the body rather than the path because the general scope has no
    # project to put in a path — which is the whole reason these routes left
    # `/api/projects/{id}/…`.
    project_id: str | None = Field(
        default=None, min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$"
    )
    # Every scope picks its persona per request. Absent means "whatever this
    # conversation is held in", which the route resolves from the stored id —
    # never a silent fall to the default.
    #
    # This said "the reader scopes take the project's" until the project
    # persona was dropped (`b8d24f60a3c1`), and the routes were not updated
    # with it: the client stopped sending an id outside the general scope
    # because of this comment, and `chat_stream` answered as the default every
    # turn. A stale comment about a deleted column, and pills that lied about
    # which persona answered.
    persona_id: str | None = Field(
        default=None, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"
    )
    paper_id: str | None = None
    # General scope only: the Memory page open beside the conversation, as a
    # retrieval seed. The document scope names its document by `paper_id`.
    page_slug: str | None = Field(default=None, max_length=200)
    referenced_paper_ids: list[str] = Field(default_factory=list, max_length=9)
    referenced_image_ids: list[str] = Field(
        default_factory=list, max_length=MAX_REFERENCED_IMAGES
    )
    selected_text: str | None = Field(default=None, max_length=20_000)
    # Unknown or omitted values fall back to the configured default in the
    # router (resolve_reasoning_effort), same pattern as model just below — so
    # the valid set lives only in Settings.reasoning_efforts, not here too.
    reasoning_effort: str | None = Field(default=None, max_length=16)
    # Unknown names fall back to the configured default in the router, so an
    # older client that never sends this keeps working.
    model: str | None = Field(default=None, max_length=100)
    request_id: str | None = Field(
        default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"
    )
    engagement_id: str | None = Field(
        default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"
    )
    viewport: ViewportContext | None = None
    # Names the last user turn being replaced. The stream drops that question
    # and the stale answer after it *before* appending this prompt, so an edit
    # is a new turn rather than a rewrite of the thread. Absent on a first ask.
    replace_request_id: str | None = Field(
        default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"
    )

    @model_validator(mode="after")
    def reconcile_scope(self) -> "ChatRequest":
        """`scope` is the discriminator; the general scope validates its pair."""
        if self.scope == "general":
            # A project and a paper *together* name the document open beside
            # the conversation: context for one turn, verified as the reader's
            # own before it is read, and never part of the thread's identity.
            # One without the other names nothing and is refused, as a
            # viewport or a referenced paper still is — those are claims about
            # a reader panel the account-wide chat does not have.
            if bool(self.project_id) != bool(self.paper_id):
                raise ValueError("The general scope takes an open document as a project and a paper together")
            if self.viewport is not None:
                raise ValueError("The general scope has no reader viewport")
            if self.referenced_paper_ids:
                raise ValueError("The general scope cannot reference papers")
        return self


class SideTurn(BaseModel):
    """One earlier exchange of a side chat, as plain text the client kept."""

    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=50_000)
    answer: str = Field(min_length=1, max_length=50_000)


#: Earlier exchanges one side question may carry, and their text in all: about
#: what the main thread's ten-exchange window carries, so an oversized side chat
#: is refused here rather than by the provider mid-stream.
MAX_SIDE_TURNS = 20
MAX_SIDE_CHARS = 200_000


class SideChatRequest(BaseModel):
    """
    A side question beside a stored conversation (`POST /api/chat/side`).

    The conversation is read-only context and the side chat is whatever the
    client sends: nothing here is stored. So it names a conversation but no
    request id, engagement, plan mode, replacement, image, viewport or quoted
    passage, and an unknown field is refused.
    """

    model_config = ConfigDict(extra="forbid")

    conversation_id: str = Field(min_length=32, max_length=32, pattern=r"^[a-f0-9]+$")
    generation: int | None = Field(default=None, ge=0)
    scope: ChatScope
    project_id: str | None = Field(
        default=None, min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$"
    )
    paper_id: str | None = None
    page_slug: str | None = Field(default=None, max_length=200)
    persona_id: str | None = Field(
        default=None, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"
    )
    reasoning_effort: str | None = Field(default=None, max_length=16)
    model: str | None = Field(default=None, max_length=100)
    prompt: str = Field(min_length=1, max_length=50_000)
    side_turns: list[SideTurn] = Field(default_factory=list, max_length=MAX_SIDE_TURNS)

    @model_validator(mode="after")
    def reconcile_scope(self) -> "SideChatRequest":
        """The general scope's open document is a pair, as on `ChatRequest`."""
        if self.scope == "general" and bool(self.project_id) != bool(self.paper_id):
            raise ValueError("The general scope takes an open document as a project and a paper together")
        if sum(len(turn.question) + len(turn.answer) for turn in self.side_turns) > MAX_SIDE_CHARS:
            raise ValueError("This side chat is too long to send; close it and start another")
        return self

    def chat_request(self) -> ChatRequest:
        """The same question as a main turn would ask it, minus artifacts."""
        body = ChatRequest(
            disable_artifacts=True,
            **self.model_dump(exclude={"side_turns"}),
        )
        body._side = list(self.side_turns)
        return body


class ChatCancelRequest(BaseModel):
    conversation_id: str = Field(min_length=32, max_length=32, pattern=r"^[a-f0-9]+$")
    generation: int | None = Field(default=None, ge=0)

    request_id: str = Field(
        min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"
    )
    scope: ChatScope
    project_id: str | None = Field(
        default=None, min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$"
    )
    paper_id: str | None = None


"""
Memory's request bodies.

`MemoryKind` is a closed set for the same reason `Element` is: a kind picks
an icon and a colour on `/memory`, so an open string would render as a
gap.
"""
MemoryKind = Literal["domain", "concept", "source"]


class MemoryDomainWrite(BaseModel):
    """
    A domain of interest the reader named themselves.

    `slug` is optional because a reader types a name, not an address — it is
    derived from the title when absent, exactly as a page's is. `origin` is not
    a field: anything arriving through this route is by definition the reader's,
    and letting a request claim otherwise would let a caller downgrade a domain
    the reader had claimed.
    """

    title: str = Field(min_length=1, max_length=120)
    slug: str | None = Field(default=None, max_length=60)
    summary: str | None = Field(default=None, max_length=400)
    position: int | None = Field(default=None, ge=-999, le=999)


class MemoryPageMove(BaseModel):
    """Re-file pages into a domain, as one decision rather than N."""

    slugs: list[str] = Field(min_length=1, max_length=200)
    domain: str = Field(min_length=1, max_length=60)


class MemoryUpdateProgress(BaseModel):
    """
    How the account's one Update run is going, written by the tab running it.

    Client-authored, and deliberately nothing but counts: the run itself is
    client-driven, so the browser is the only thing that knows where it has
    got to. Everything a reader is *told* — what filed, what is queued, what
    failed — still comes from the records, and this may only ever say how far
    along a run is. Bounded so an ended tab cannot leave prose behind.
    """

    status: Literal["running", "done", "failed"]
    total: int = Field(ge=0, le=10_000)
    processed: int = Field(ge=0, le=10_000)
    filed: int = Field(ge=0, le=10_000)
    skipped: int = Field(ge=0, le=10_000)
    failures: int = Field(ge=0, le=10_000)
    detail: str = Field(default="", max_length=240)


#: `Settings.memory_rewrite_note_max_words` defaults to this and publishes it,
#: so the reader's counter and the refusal here are one number. The character
#: bound is the wall behind the rule, not a limit anyone works to.
REWRITE_NOTE_MAX_WORDS = 20
REWRITE_NOTE_MAX_CHARS = 400


class MemoryPageRewriteRequest(BaseModel):
    """Why the reader wants this explanation written again, in twenty words.

    Optional: a press with nothing said is invariant 61's case, the authoring
    pass having moved. A paragraph would be a request for a different page,
    which is a document filing rather than a rewrite.
    """

    note: str = Field(default="", max_length=REWRITE_NOTE_MAX_CHARS)

    @field_validator("note")
    @classmethod
    def within_the_word_limit(cls, value: str) -> str:
        collapsed = " ".join(value.split())
        if collapsed and len(collapsed.split(" ")) > REWRITE_NOTE_MAX_WORDS:
            raise ValueError(f"Say why in {REWRITE_NOTE_MAX_WORDS} words or fewer")
        return collapsed


class MemoryBackfillRequest(BaseModel):
    paperIds: list[str] = Field(min_length=1, max_length=1000)


class SameDocumentAnswer(BaseModel):
    """The reader's answer: use the page a deleted copy left, or keep this document separate."""

    use: bool


class SessionRelease(BaseModel):
    """
    What the reader left: a document (its chats and its notes), or a Memory
    chat. Neither means every session of the account, which is what the
    window sends when it is launched and no session is open yet.
    """

    paperId: str | None = Field(default=None, min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    #: The document's project. Not needed to find the job; accepted so a
    #: caller can send the pair it already holds.
    projectId: str | None = Field(default=None, min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    conversationId: str | None = Field(default=None, min_length=32, max_length=32, pattern=r"^[a-f0-9]+$")

    @model_validator(mode="after")
    def one_session(self) -> "SessionRelease":
        if self.paperId and self.conversationId:
            raise ValueError("Name the document that was left or the Memory chat, not both")
        return self


class ConversationCreate(BaseModel):
    scope: ChatScope
    project_id: str | None = None
    paper_id: str | None = None
    creation_key: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")

class ConversationRename(BaseModel):
    # A generated title is offered back in the rename box, so the reader can
    # save it unchanged: one bound for both.
    title: str = Field(min_length=1, max_length=CONVERSATION_TITLE_MAX_CHARS)
    generation: int = Field(ge=0)
