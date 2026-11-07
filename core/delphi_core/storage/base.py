"""
The storage boundary.

Everything durable goes through `Storage` (records) and `ObjectStore` (bytes).
Neither exposes a filesystem path, because the deployed implementation is a
document database plus an object store and there is no path to expose. Routers
call entity methods and never learn where the data physically lives.
"""

import re
import unicodedata
from abc import ABC, abstractmethod
from base64 import urlsafe_b64decode, urlsafe_b64encode
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from ..memory_maintenance.jobs import document_marker, domain_marker
from ..schemas import CONVERSATION_TITLE_MAX_CHARS
from .domains import DOMAIN_SETTLE_SECONDS
from .sessions import SESSION_IDLE_SECONDS

SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")
ROUTE_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ROUTE_SLUG_MAX = 60
APOSTROPHES = str.maketrans("", "", "'\u2018\u2019\u02bc")


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def last_user_turn_index(messages: list[dict[str, Any]], request_id: str) -> int:
    """
    Index of the last user message, which must still be the turn `request_id`
    names.

    Everything from this index onward is the question being replaced and the
    answer (if any) it produced. A later user turn means another tab has
    already moved the conversation on, and dropping the tail would take that
    question with it — the same reason an append is not a rewrite of the
    thread. A stored turn with no `requestId` is older than this check, so
    the last user message is accepted as the tail.
    """
    index = next(
        (
            i
            for i in range(len(messages) - 1, -1, -1)
            if messages[i].get("role") == "user"
        ),
        None,
    )
    if index is None:
        raise HTTPException(404, "There is no question to replace")
    existing = messages[index].get("requestId")
    if existing and existing != request_id:
        raise HTTPException(409, "A newer question has already been asked")
    return index


def safe_id(value: str) -> str:
    """
    Reject identifiers that could escape their container. Parameterised queries
    make this redundant as a database defence, but identifiers are still spliced
    into object keys, and an object store will happily accept one containing
    `../`.
    """
    if not SAFE_ID.fullmatch(value):
        raise HTTPException(400, "Invalid identifier")
    return value


def route_slug(value: str, fallback: str) -> str:
    """Turn a visible name into the stable, URL-clean route alphabet."""
    decomposed = unicodedata.normalize("NFKD", value or "")
    ascii_text = "".join(char for char in decomposed if not unicodedata.combining(char))
    cleaned = ascii_text.translate(APOSTROPHES).lower().encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", cleaned).strip("-")
    if len(slug) > ROUTE_SLUG_MAX:
        clipped = slug[:ROUTE_SLUG_MAX]
        boundary = clipped.rfind("-")
        slug = (clipped[:boundary] if boundary > 0 else clipped).rstrip("-")
    return slug or fallback


def allocate_route_slug(value: str, fallback: str, used: set[str]) -> str:
    """Allocate the first readable slug not already present in one namespace."""
    base = route_slug(value, fallback)
    if base not in used:
        return base
    suffix = 2
    while True:
        ending = f"-{suffix}"
        candidate = f"{base[: ROUTE_SLUG_MAX - len(ending)].rstrip('-')}{ending}"
        if candidate not in used:
            return candidate
        suffix += 1


def valid_route_slug(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= ROUTE_SLUG_MAX
        and ROUTE_SLUG.fullmatch(value) is not None
    )


def plan_route_slug_repairs(
    entries: list[tuple[str, str, object, object]], fallback: str
) -> dict[str, str]:
    """
    Decide which persisted routes need repair, without knowing how they are stored.

    Each entry is `(id, current_name, slug, name_snapshot)` in deterministic
    allocation order. Valid current mappings are reserved first, so a stale row
    cannot steal an established sibling's address during a rolling deploy. Old
    slugs belonging to other stale rows stay reserved until those rows are
    processed, avoiding transient uniqueness collisions in SQL.
    """
    stable: set[str] = set()
    pending: list[tuple[str, str, object]] = []
    for identifier, name, slug, snapshot in entries:
        if snapshot == name and valid_route_slug(slug) and slug not in stable:
            stable.add(slug)
        else:
            pending.append((identifier, name, slug))

    blocked = {slug for _, _, slug in pending if valid_route_slug(slug)}
    repairs: dict[str, str] = {}
    for identifier, name, old_slug in pending:
        if valid_route_slug(old_slug):
            blocked.discard(old_slug)
        slug = allocate_route_slug(name, fallback, stable | blocked)
        repairs[identifier] = slug
        stable.add(slug)
    return repairs


#: The longest title a document record holds.
PAPER_TITLE_MAX_CHARS = 200


def initial_title(paper: dict[str, Any]) -> str | None:
    """
    The title a document is given before anyone has named it: its file's name
    without the extension, as an upload titles it. None for a record with no
    file name. A stored title equal to this is one nobody chose.
    """
    filename = str(paper.get("filename") or "")
    return Path(filename).stem[:PAPER_TITLE_MAX_CHARS] if filename else None


def is_web(paper: dict[str, Any]) -> bool:
    """A record written before web documents existed has no kind, and is a PDF."""
    return paper.get("kind") == "web"


def paper_key(username: str, project_id: str, paper_id: str, ext: str) -> str:
    return (
        f"u/{safe_id(username)}/p/{safe_id(project_id)}/{safe_id(paper_id)}.{ext}"
    )


def project_prefix(username: str, project_id: str) -> str:
    return f"u/{safe_id(username)}/p/{safe_id(project_id)}/"


def evidence_key(username: str, paper_id: str, evidence_id: str) -> str:
    """Immutable chat evidence follows paper identity, not project filing."""
    return (
        f"evidence/u/{safe_id(username)}/p/{safe_id(paper_id)}/"
        f"{safe_id(evidence_id)}.json"
    )


def evidence_prefix(username: str, paper_id: str) -> str:
    return f"evidence/u/{safe_id(username)}/p/{safe_id(paper_id)}/"


# What the account-wide conversation's images are filed under. It names the
# object key and the filesystem directory only, and is deliberately *never*
# written into `chat_threads.thread_key`, which stays NULL for that row: the
# general thread is not a project thread with a missing project, and giving it
# a key would make it collide with the uniqueness rule the project threads use.
ACCOUNT_CHAT_IMAGE_KEY = "knowledge-base"


def chat_image_prefix(
    username: str, project_id: str | None, thread_key: str | None = None
) -> str:
    """
    Where one conversation's images live.

    `project_id is None` is the account-wide chat, which has no project to be
    filed under — so it gets its own branch of the tree rather than a
    placeholder project id that a later listing would have to know to skip.
    """
    root = (
        f"chat-images/u/{safe_id(username)}/account/"
        if project_id is None
        else f"chat-images/u/{safe_id(username)}/p/{safe_id(project_id)}/"
    )
    key = thread_key or (ACCOUNT_CHAT_IMAGE_KEY if project_id is None else None)
    return root if key is None else f"{root}{safe_id(key)}/"


def chat_image_key(
    username: str,
    project_id: str | None,
    thread_key: str | None,
    image_id: str,
    variant: str,
) -> str:
    return (
        f"{chat_image_prefix(username, project_id, thread_key)}"
        f"{safe_id(image_id)}-{safe_id(variant)}.webp"
    )


def rehome_chat_image_key(
    key: str, username: str, source_project_id: str, destination_project_id: str
) -> str:
    """
    A project chat image's key once its paper has moved projects.

    Keys name the project (invariant 33), so a move copies the bytes to this key
    first, then rewrites the records to it, then drops the originals. Every
    conversation of the paper travels, not only one.
    """
    old = chat_image_prefix(username, source_project_id)
    if not key.startswith(old):
        return key
    return chat_image_prefix(username, destination_project_id) + key[len(old):]


def encode_cursor(published_at: str, persona_id: str) -> str:
    """
    Opaque position in the marketplace listing.

    Keyset, not `OFFSET`: a page is `WHERE (published_at, id) < (…)` against the
    partial index, so page 40 costs what page 1 costs and nothing shifts under a
    reader when someone else publishes mid-browse.
    """
    raw = f"{published_at}\0{persona_id}".encode()
    return urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> tuple[str, str] | None:
    """A cursor a stranger can edit, so a malformed one is 'start again', not 500."""
    if not cursor:
        return None
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        published_at, _, persona_id = (
            urlsafe_b64decode(padded.encode()).decode().partition("\0")
        )
    except (ValueError, UnicodeDecodeError):
        return None
    return (published_at, persona_id) if published_at and persona_id else None


#: A `list_recent_conversations` limit meaning "every one of them".
#:
#: Well past any real account, and stated here rather than at each call site
#: because two callers now want the whole list — the settings sheet's Chats
#: pane and the one-time title backfill — and two independently chosen
#: ceilings are two things to keep in step for no reason. The method already
#: drops threads holding no message, which is what both callers want: an empty
#: thread has nothing to title and nothing to resume.
ALL_CONVERSATIONS = 10_000

def fit_conversation_title(text: str) -> str:
    """`text` on one line, cut at a word to fit `CONVERSATION_TITLE_MAX_CHARS`."""
    title = " ".join(str(text or "").split())
    if len(title) <= CONVERSATION_TITLE_MAX_CHARS:
        return title
    head = title[:CONVERSATION_TITLE_MAX_CHARS + 1]
    return (head.rsplit(" ", 1)[0] if " " in head else "") or title[:CONVERSATION_TITLE_MAX_CHARS]

def abandoned_job_error(attempts: int) -> str:
    """
    Why a job stopped being work.

    Written by `claim_memory_job` when a job reaches its attempt ceiling
    without ever reporting a failure of its own — which is what an abandoned
    drain looks like from the queue: claimed, leased, and then nothing. It
    states the fact and stops there, because no screen shows this yet: the
    reader's route back is the Reader rail's own **File it now**, which forces
    a fresh pass over the document in front of them.
    """
    return (
        f"Filing was claimed {attempts} times and never finished — the request "
        "was cut short each time rather than failing."
    )


def domain_job_marker(slug: str) -> str:
    """
    The queued composition of one domain's page (`jobs.domain_marker`).

    Stable per domain on purpose: ten changes to the same domain collapse into
    one pending job and one composition. It is also the marker of the job's
    event, whose fingerprint is what the page was composed from.
    """
    return domain_marker(slug)


class MemoryJobGone(Exception):
    """A filing no longer owns the job claim it must present at publication.

    The drain checks `memory_job_exists` between stages, which leaves the
    window between the last check and the commit. A commit given
    `fence_job` (job id, attempt number) closes it: it checks the claim inside the same transaction,
    under the same account lock, as the pages and event it would publish, and
    raises this instead of writing. The drain treats it as standing down.
    """


# First-run onboarding, as recorded on the account. `running` names the
# projects the attempt created; `complete` means a later visit opens the
# Dashboard. No record at all is an account that never started onboarding.
ONBOARDING_RUNNING = "running"
ONBOARDING_COMPLETE = "complete"


def onboarding_tally(
    paper_ids: Sequence[str],
    filed_markers: set[str],
    pending_markers: set[str],
    *,
    require_filing: bool,
) -> dict[str, int]:
    """How far an onboarding attempt's documents got, by one rule for every backend.

    A document is *completed* once it is uploaded and, where Memory is on,
    filed: its `paper:<id>` event exists, which a job that found nothing worth
    filing writes too. With filing off
    there is nothing to wait for, so uploaded is completed. `pending` counts
    documents whose filing is still queued or running, so a caller can tell
    "not yet" from "never will".
    """
    uploaded = len(paper_ids)
    filed = sum(1 for paper_id in paper_ids if document_marker(paper_id) in filed_markers)
    pending = sum(1 for paper_id in paper_ids if document_marker(paper_id) in pending_markers)
    return {
        "uploaded": uploaded,
        "filed": filed,
        "pending": pending,
        "completed": filed if require_filing else uploaded,
    }


#: What a Memory page can be. A `source` page is one document's digest, a
#: `concept` page explains one idea, and a `domain` page orients a reader
#: across the pages filed under it. Both stores refuse any other kind
#: (`check_page_shape`), and `models.py` mirrors the set as a check constraint.
MEMORY_KINDS = ("domain", "concept", "source")
#: What a citation on a Memory page can claim: what a document in the library
#: says, what a captured outside source says, what the reader wrote in a
#: margin note, or Delphi's own inference, which names no source. A digest has
#: its own vocabulary (`digest-inference`), mapped where a source page is
#: derived from it.
MEMORY_CLAIM_TYPES = ("author-claim", "external", "reader-note", "derived")
#: The filing pass that is running now. A document's job is queued for a
#: version (`targetVersion` in its payload) and its event is stamped with the
#: version that wrote it, so a document filed by a pass Delphi has replaced can
#: be told from one that is current. It lives beside the queue's vocabulary
#: because the stores write it into the job `add_paper` enqueues.
MEMORY_VERSION = "knowledge-v6"
# The durable maintenance queue's vocabulary, in one place. Both backends
# validate against this and `models.py` mirrors it as a check constraint, so a
# new kind is one edit plus one migration rather than four copies to keep in
# step — which is what they had drifted into being.
MEMORY_JOB_KINDS = (
    "domain",
    "page-rewrite",
    "document",
    "session",
    "reconcile",
    "capture",
)
#: The queue's one kind that is not Memory's: reading a web page whole that its
#: add read at its first window (`routers.captures`). It is durable for the same
#: reasons and leased the same way, but only its own drain claims it
#: (`claim_memory_job(kinds=CAPTURE_JOB_KINDS)`), Memory's counts leave it out,
#: and it needs no model.
CAPTURE_JOB_KINDS = ("capture",)
#: The kinds `claim_memory_job` takes before any other: a document the
#: reader added is what they are waiting to see filed. Both stores order by
#: this one tuple, so a new kind cannot be first in one and not the other.
DOCUMENT_JOB_KINDS = ("document",)
#: Kinds that are queued and that no claim takes yet: none. A kind is named
#: here while the pipeline cannot yet run it, so its jobs wait without being
#: failed for waiting. Both stores read this one tuple.
HELD_JOB_KINDS: tuple[str, ...] = ()


def capture_is_owed(job: dict[str, Any]) -> bool:
    """Whether a capture job will still run: queued, leased or backing off, not given up."""
    return job.get("kind") in CAPTURE_JOB_KINDS and not (
        job.get("status") == "failed" and job.get("retryAt") is None
    )


def waits_for_capture(job: dict[str, Any], jobs: Iterable[dict[str, Any]]) -> bool:
    """Whether a document job waits for its page to be read whole first.

    A document is filed from its text, and a page the add read at its first
    window has only part of it until its capture job runs; filing it then would
    build a digest from the part and build it again from the whole. So no claim
    takes a document's job while that paper has a capture still owed, and the
    capture finishing (or giving up) is all that lets it go. Nothing waits on a
    time: an app quit mid-capture finds both owed at the next launch, and the
    order is still capture first.
    """
    if job.get("kind") not in DOCUMENT_JOB_KINDS:
        return False
    paper_id = (job.get("payload") or {}).get("paperId")
    return bool(paper_id) and any(
        capture_is_owed(other) and (other.get("payload") or {}).get("paperId") == paper_id
        for other in jobs
    )


def job_is_due(job: dict[str, Any], now: str) -> bool:
    """Whether `claim_memory_job` would take this job at `now`.

    `retryAt` means one thing whatever the status: not claimable before this
    time. A pending job used to be due whatever its `retryAt` and only a failed
    one waited, which left no way to hold a session's job until the session
    ends or to let a burst of changes to one domain settle into one pass. A
    failed job with no `retryAt` has given up and is never due. Nor is a job
    of a kind in `HELD_JOB_KINDS`, whatever else is true of it.

    The local store and the drain's `remaining` count call this; the SQL claim
    states the same test as a WHERE clause, and the contract suite holds the
    two together.
    """
    if job.get("kind") in HELD_JOB_KINDS:
        return False
    retry_at = job.get("retryAt")
    if retry_at is not None and retry_at > now:
        return False
    status = job.get("status")
    if status == "pending":
        return True
    if status == "leased":
        return (job.get("leaseExpiresAt") or "") <= now
    return status == "failed" and retry_at is not None


def job_fingerprint_moved(job: dict[str, Any], fingerprint: str | None) -> bool:
    """Whether the record a job covers changed while a worker was on it.

    A worker hands back the fingerprint it read. An enqueue that arrived
    during the work stored a newer one on the row, so the two differ and the
    pass that just finished did not read everything: the job stays queued. A
    job that carries no fingerprint, or a worker that names none, completes as
    it always has.
    """
    stored = (job.get("payload") or {}).get("fingerprint")
    return fingerprint is not None and stored is not None and stored != fingerprint


def job_payload_is_upgradeable(job: dict[str, Any], now: str) -> bool:
    """Whether a queued job's payload may still be reconciled in place.

    `enqueue_memory_job` is idempotent on `(username, marker)`, so a second
    enqueue hands back the row that is already there. That is right for the
    ordinary catch-up and wrong for an upgrade: a document queued as "file this,
    it was never filed" and then found to be behind the current pass has to
    learn the version it is now being filed *for*, or the press does nothing for
    it.

    The one row that must be left alone is the one a worker is actually holding
    — it has already read the payload it will run with. A row whose lease has
    **expired** is not that row: `claim_memory_job` re-reads its payload on
    the next claim, so it upgrades like a pending one. This is the same
    due-ness test `maintenance_snapshot` and the claim itself already share, and
    it is stated once here so the two backends cannot disagree about which rows
    a press reaches.
    """
    status = job.get("status")
    if status in ("pending", "failed"):
        return True
    return status == "leased" and (job.get("leaseExpiresAt") or "") <= now
WIKI_LINK = re.compile(r"\[\[([^\[\]|]{1,120})(?:\|[^\[\]]{0,120})?\]\]")
FIGURE_REF = re.compile(r"!\[([^\]]{0,300})\]\(figure:([A-Za-z0-9_-]{1,32})\)")


def memory_slug(value: str) -> str:
    """
    The address of a wiki page, and the thing `[[links]]` resolve against.

    Deliberately the route alphabet: a slug is typed by a model into the body
    of another page, so it has to survive being written by hand. Length is
    capped where every other visible route is.
    """
    return route_slug(value, "")


#: The page kinds whose every committed revision is kept in version history,
#: and for which a commit may be told to demand `expectedRevision`. A source
#: page is derived from its document's digest and is neither.
VERSIONED_KINDS = ("concept", "domain")
#: What can cause a revision. `None` is a writer that does not say.
VERSION_TRIGGERS = ("document", "conversation", "notes", "domain", "reconcile", "page-rewrite")
VERSIONS_KEPT = 20
LINK_REPAIR_NOTE = "link to a deleted page became text"
ALIASES_MAX = 12
ALIAS_MAX_CHARS = 80
_NOT_ALNUM = re.compile(r"[\W_]+", re.UNICODE)


def alias_key(value: object) -> str:
    """The form two names are compared in: a title, an alias, a slug.

    NFKC, case-folded, every run of punctuation or whitespace one space, and
    trimmed. So "Self-Attention", "self attention" and the slug
    `self-attention` are one name, and "BERT" and "bert" are. Nothing is
    stemmed or transliterated: "transformer" and "transformers" stay two.
    """
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return _NOT_ALNUM.sub(" ", text).strip()


def clean_aliases(values: object, *, title: str = "", slug: str = "") -> list[str]:
    """A page's aliases as stored: the author's spelling, without the noise.

    Each keeps its case and punctuation with whitespace collapsed, because an
    alias is shown as well as matched. One that compares equal (`alias_key`)
    to an earlier alias, to the page's title or to its slug is dropped: it
    names nothing the page did not already answer to.
    """
    if not isinstance(values, (list, tuple)):
        return []
    seen = {alias_key(title), alias_key(slug), ""}
    kept: list[str] = []
    for value in values:
        if not isinstance(value, str):
            continue
        alias = " ".join(value.split())[:ALIAS_MAX_CHARS].strip()
        key = alias_key(alias)
        if key in seen:
            continue
        seen.add(key)
        kept.append(alias)
        if len(kept) == ALIASES_MAX:
            break
    return kept


def alias_index(pages: Iterable[dict[str, Any]]) -> dict[str, str]:
    """`alias_key` of every alias, to the slug of the page that holds it.

    Two pages claiming one alias is settled by slug order, so the answer does
    not depend on which was written last. A page's own slug is not in here:
    the reader of this index looks a slug up first and an alias second.
    """
    index: dict[str, str] = {}
    for page in sorted(pages, key=lambda page: page["slug"]):
        for alias in page.get("aliases") or []:
            if key := alias_key(alias):
                index.setdefault(key, page["slug"])
    return index


def check_version_trigger(trigger: str | None) -> None:
    if trigger is not None and trigger not in VERSION_TRIGGERS:
        raise HTTPException(422, "Unknown cause for a Memory page revision")


def page_version(
    page: dict[str, Any], *, event_id: str | None, trigger: str | None, note: str | None
) -> dict[str, Any]:
    """One row of version history: the page as committed, and why."""
    return {
        "slug": page["slug"],
        "revision": page["revision"],
        "title": page["title"],
        "summary": page.get("summary") or "",
        "body": page.get("body") or "",
        "citations": list(page.get("citations") or ()),
        "createdAt": page["updatedAt"],
        "eventId": event_id,
        "trigger": trigger,
        "note": (note or None) and str(note)[:500],
    }


def page_history_entry(versions: list[dict[str, Any]]) -> dict[str, Any]:
    """`page_history`'s answer for one page, from its rows newest first."""
    bare = [{key: value for key, value in row.items() if key != "body"} for row in versions]
    return {
        "latest": bare[0] if bare else None,
        "asked": next((row for row in bare if row["trigger"] == "conversation"), None),
    }


def unlink_deleted_page(body: str, slug: str, title: str) -> str:
    """A body with every link to one deleted page written as plain words.

    The words are the label where the author wrote one (`[[slug|label]]`) and
    the deleted page's title otherwise. Other links are left as they are,
    resolved or not, and so is anything inside code. The import is deferred
    because `memory_maintenance.validate` imports this module.
    """
    from ..memory_maintenance.validate import repair_links

    others = set(parse_wiki_links(body)) - {slug}
    return repair_links(body, others, titles={slug: title})[0]


def check_expected_revision(
    page: dict[str, Any], prior: dict[str, Any] | None, *, required: bool = False
) -> None:
    """Refuse a write drafted against a revision the page no longer has.

    A writer that read a page before drafting carries the revision it read as
    `expectedRevision`; a page that does not exist yet is revision 0. `prior`
    is the record read *inside* the same lock or transaction as the write,
    never a snapshot passed down from the caller: a filing reads its pages
    minutes before it commits, and whatever landed in between is exactly what
    this exists to keep. A write that carries no `expectedRevision` is
    last-writer-wins, unless the commit said `required`: then a write to a
    `concept` or `domain` page (the draft's kind or the stored page's) that
    carries none is refused with a 422 naming the page, because an edit
    addressed to blocks of a body it never read would land on another body.
    """
    if (
        required
        and "expectedRevision" not in page
        and {page.get("kind"), (prior or {}).get("kind")} & set(VERSIONED_KINDS)
    ):
        name = page.get("slug") or page.get("title") or "a page"
        raise HTTPException(
            422,
            f"The write to {name} names no expectedRevision; a concept or domain "
            "page is written against the revision that was read (0 for a new page)",
        )
    if "expectedRevision" in page and page["expectedRevision"] != (prior or {}).get("revision", 0):
        raise HTTPException(409, "Memory changed during filing; retry against the current pages")


def check_page_shape(page: dict[str, Any]) -> None:
    """Refuse a page whose kind, or a citation whose claim type, Memory does not hold."""
    name = page.get("slug") or page.get("title") or "a page"
    if page.get("kind") not in MEMORY_KINDS:
        raise HTTPException(
            422,
            f"The write to {name} names the kind {page.get('kind')!r}; "
            f"a Memory page is one of {', '.join(MEMORY_KINDS)}",
        )
    for citation in page.get("citations") or ():
        if citation.get("claimType") not in MEMORY_CLAIM_TYPES:
            raise HTTPException(
                422,
                f"The write to {name} cites with the claim type {citation.get('claimType')!r}; "
                f"a citation is one of {', '.join(MEMORY_CLAIM_TYPES)}",
            )


def domain_title(slug: str) -> str:
    """
    The name a domain gets when nobody has given it one.

    Sentence case rather than Title Case — "Machine learning", not "Machine
    Learning" — because these read as headings in a tree beside page titles
    that are themselves sentence case, and a row of Capitalised Words in that
    position reads as a proper noun the reader does not recognise.
    """
    words = slug.replace("-", " ").strip()
    return words[:1].upper() + words[1:] if words else slug


def default_domain_record(slug: str, now: str) -> dict[str, Any]:
    """
    A brand-new domain row, as both backends spell it.

    Shared so a domain synthesised on the filesystem and one inserted in
    Postgres cannot differ in their defaults — which is precisely the kind of
    divergence the contract suite exists to catch, and cheaper to prevent here
    than to assert twice.
    """
    return {
        "slug": slug,
        "title": domain_title(slug),
        "summary": None,
        "origin": "model",
        "position": 0,
        "createdAt": now,
        "updatedAt": now,
    }


def memory_figure_key(username: str, figure_id: str, *, ext: str = "webp") -> str:
    """
    Figure bytes follow the *account*, not a project.

    A KB write names the account and nothing else — papers and projects appear
    only as provenance — so filing a paper elsewhere or deleting it must leave
    the figure the reader kept exactly where it was. Extension is usually
    `webp` (raster captures); inline SVGs from a web snapshot keep `.svg` so
    the browser can paint them without a rasteriser Delphi does not ship.
    """
    suffix = safe_id(ext) or "webp"
    return f"knowledge/u/{safe_id(username)}/figures/{safe_id(figure_id)}.{suffix}"


def external_evidence_key(username: str, evidence_id: str) -> str:
    """
    Where one captured outside source keeps its extracted sections.

    Under the account, like a figure: evidence belongs to the reader whose
    digest or page cites it, and deleting the account removes it with the rest.
    """
    return f"knowledge/u/{safe_id(username)}/evidence/{safe_id(evidence_id)}.json"


def evidence_holders(
    papers: Iterable[dict[str, Any]], pages: Iterable[dict[str, Any]]
) -> dict[str, list[dict[str, str]]]:
    """
    Which artifacts cite each piece of external evidence: `{id: [holder, ...]}`.

    Computed from the artifacts themselves, never kept as rows of its own: a
    digest names its evidence in its metadata and a page names it in its
    citations, so deleting either drops the reference with nothing to clean up.
    """
    holders: dict[str, list[dict[str, str]]] = {}
    for paper in papers:
        for evidence_id in (paper.get("digest") or {}).get("evidenceIds") or ():
            holders.setdefault(evidence_id, []).append({"kind": "digest", "paperId": paper["id"]})
    for page in pages:
        cited = {c.get("evidenceId") for c in page.get("citations") or () if c.get("evidenceId")}
        for evidence_id in sorted(cited):
            holders.setdefault(evidence_id, []).append({"kind": "page", "slug": page["slug"]})
    return holders


def external_evidence_record(record: dict[str, Any], *, object_key: str) -> dict[str, Any]:
    """The stored shape of one capture, the same in both stores."""
    return {
        "id": safe_id(record["id"]),
        "url": record["url"],
        "finalUrl": record.get("finalUrl") or record["url"],
        "title": record.get("title") or "",
        "contentHash": record["contentHash"],
        "findings": list(record.get("findings") or ()),
        "objectKey": object_key,
        "capturedAt": record.get("capturedAt") or utc_now(),
    }


def parse_wiki_links(body: str) -> list[str]:
    """
    Every `[[slug]]` a page points at, in order, without duplicates.

    A target that does not exist is kept rather than dropped: the edge list
    says what the body says, and repairing a link is a decision for whoever
    writes the page.
    """
    seen: list[str] = []
    for match in WIKI_LINK.finditer(body or ""):
        slug = memory_slug(match.group(1))
        if slug and slug not in seen:
            seen.append(slug)
    return seen


def parse_figure_refs(body: str) -> list[str]:
    """Every `![caption](figure:<id>)` a page embeds, in order, deduplicated."""
    seen: list[str] = []
    for match in FIGURE_REF.finditer(body or ""):
        if match.group(2) not in seen:
            seen.append(match.group(2))
    return seen


def matches_persona_query(query: str, name: str, tagline: str | None) -> bool:
    """Substring search over what a browsing reader can actually see."""
    needle = (query or "").strip().lower()
    if not needle:
        return True
    return needle in (name or "").lower() or needle in (tagline or "").lower()


@dataclass
class Removed:
    """
    What a delete freed up. The caller is responsible for the parts no store can
    cascade into: bytes in the object store, and files held by the model
    provider.
    """

    object_keys: list[str] = field(default_factory=list)
    openai_file_ids: list[str] = field(default_factory=list)


class ObjectStore(ABC):
    """Opaque, validated keys to bytes; user filenames never become object keys."""

    @abstractmethod
    def put_file(self, key: str, path: Path, content_type: str) -> None: ...

    @abstractmethod
    def put_text(self, key: str, text: str) -> None: ...

    @abstractmethod
    def get_text(self, key: str) -> str: ...

    @abstractmethod
    def size(self, key: str) -> int: ...

    @abstractmethod
    def exists(self, key: str) -> bool: ...

    @abstractmethod
    def open_range(
        self, key: str, start: int | None = None, end: int | None = None
    ) -> Iterator[bytes]:
        """
        Yield bytes for an inclusive `[start, end]` byte range, or the whole
        object when both are None. Streamed so a 34 MB PDF never lands in memory.
        """

    @abstractmethod
    def fetch_to_tempfile(self, key: str) -> Path:
        """
        Materialise an object as a real file, for the callers that need a file
        handle rather than bytes — pypdf clones from a path, and the provider
        file upload wants one. There are ten of them now (annotated export, the
        Files API upload, digest and figure capture, source inventory, dashboard
        previews, and two backfills), so do not trust a count here: grep.
        **Every caller must unlink it in a `finally`.**
        """

    @abstractmethod
    def copy(self, source: str, destination: str) -> bool:
        """
        Duplicate one object under a second key, answering whether there was
        anything to copy.

        A key carries the project a paper sits in, so moving a paper between
        projects has to move its bytes. Copy-then-delete rather than a rename:
        the record is re-parented between the two, and only that ordering leaves
        every crash point with an unreferenced object rather than a record
        pointing at bytes that are not there yet.

        Absent is a legitimate answer, not an error — a paper has two of `pdf`,
        `txt` and `web`, never all three, and callers move the set blindly.
        """

    @abstractmethod
    def delete(self, key: str) -> None: ...

    @abstractmethod
    def delete_prefix(self, prefix: str) -> None: ...


def empty_plan_state() -> dict[str, dict]:
    """An account's Plan state before its first reservation."""
    return {"plans": {}, "receipts": {}, "grants": {}}


class Storage(ABC):
    """
    Records. Every method is scoped by `username`; ownership is enforced here so
    no router can forget it.

    Personas are the one entity with a published form, so the rule is worth
    stating exactly rather than leaving it to look eroded:

    * **Writes** admit a row only when `username` owns it.
    * **Reads** admit a row when `username` owns it *or* the row is public, and a
      public row comes back in the listing shape — which carries the author's
      username and nothing else from their account.

    Nothing another account owns is ever resolved while building a model request.
    A public persona reaches a reader only by being forked into a row of their
    own, so the request path stays free of cross-account reads and an author
    cannot change what runs inside someone else's prompt.
    """

    #: How long a session's job waits after the last turn or note change when
    #: nothing reports that the reader left. Whoever constructs a store sets
    #: it from `Settings.memory_session_idle_seconds`; a store method takes no
    #: settings, and this is the one number a write needs from them.
    session_idle_seconds: float = SESSION_IDLE_SECONDS
    #: How long a domain's job waits after the last change to the domain, set
    #: the same way from `Settings.memory_domain_settle_seconds`.
    domain_settle_seconds: float = DOMAIN_SETTLE_SECONDS

    #: Short name for the backing store, reported by the health endpoint.
    kind: str = "unknown"

    @abstractmethod
    def plan_transaction(self, username: str, operation, *, conversation: dict | None = None):
        """Run a short account Plan-state transaction, optionally fencing its conversation.

        The callback is trusted server code, never request data. Both backends serialize
        capacity reservations, receipts and grants together. No provider/object IO inside.
        """
        ...

    @abstractmethod
    def plan_state(self, username: str) -> dict:
        """The account's committed Plan state: no lock taken, nothing written.

        `plans.history` reads receipts on every thread load and every question,
        so it must not serialize behind reservations or create state; anything
        that changes Plan state goes through `plan_transaction`.
        """
        ...

    # --- accounts -------------------------------------------------------
    @abstractmethod
    def save_highlight_placements(self, username: str, project_id: str, paper_id: str, revision: str, placements: list[dict]) -> None:
        """Cache verified positions without changing the original anchor."""
        ...

    @abstractmethod
    def annotation_revision_lock(self, username: str, project_id: str, paper_id: str):
        """Serialise publication of a paper's rolling saved webpage."""
        ...

    @abstractmethod
    def account_exists(self, username: str) -> bool: ...

    @abstractmethod
    def get_account(self, username: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def create_account(
        self, username: str, email: str | None, salt: str, password_hash: str
    ) -> dict[str, Any]:
        """Raises 409 if the username is taken."""

    @abstractmethod
    def update_password(self, username: str, salt: str, password_hash: str) -> None: ...

    @abstractmethod
    def update_account_preferences(
        self, username: str, *, use_standard_tier: bool
    ) -> dict[str, Any]: ...

    # --- projects -------------------------------------------------------
    @abstractmethod
    def list_projects(self, username: str) -> list[dict[str, Any]]: ...

    @abstractmethod
    def create_project(
        self, username: str, name: str, *, onboarding: bool = False
    ) -> dict[str, Any]:
        """Create a project; with `onboarding`, also record it on the account's
        running onboarding attempt (starting one), in the same write, so no
        attempt project can exist unrecorded."""

    @abstractmethod
    def onboarding_status(self, username: str, *, require_filing: bool) -> dict[str, Any]:
        """The account's onboarding record and, while running, its tally."""

    @abstractmethod
    def settle_onboarding(
        self, username: str, *, require_filing: bool, finishing: bool = False
    ) -> dict[str, Any]:
        """Decide an onboarding attempt, under the lock filing commits take.

        Returns `{"outcome": ..., "removed": Removed, "projectIds": [...]}`.

        - `complete`: at least one document completed (see `onboarding_tally`),
          or the account predates onboarding — it has projects or threads and
          no record. The record is marked complete; the Dashboard opens.
        - `fresh`: no record and nothing in the account: start onboarding.
        - `restart` (only when not `finishing`): a running attempt none of
          whose documents completed. Its filing jobs and projects are deleted
          here, so a filing still running is fenced out of publishing (its
          commit checks the job row under this same lock), and the record is
          cleared. The caller deletes the returned projects' bytes.
        - `running` (only when `finishing`): nothing completed yet. Failed filing never
          counts as completion; the caller can resolve again to restart.
        """

    @abstractmethod
    def get_project(self, username: str, project_id: str) -> dict[str, Any]:
        """Raises 404 when absent or owned by someone else."""

    @abstractmethod
    def list_projects_with_papers(self, username: str) -> list[dict[str, Any]]:
        """
        Every project in `list_projects` order, in the `get_project` record shape.

        The Dashboard needs all of them at once, and asking `get_project` in a
        loop cost one round trip per project plus one per eager-loaded relation
        — measured at four seconds for eight projects against Cloud SQL, which
        is most of a page load spent on a query the database can answer once.
        """

    @abstractmethod
    def resolve_reader(
        self, username: str, project_slug: str, paper_slug: str | None = None
    ) -> dict[str, Any]:
        """Resolve visible route metadata strictly inside `username`'s namespace."""

    @abstractmethod
    def rename_project(
        self, username: str, project_id: str, name: str
    ) -> dict[str, Any]: ...

    @abstractmethod
    def delete_project(self, username: str, project_id: str) -> Removed: ...

    # --- personas -------------------------------------------------------
    # A project has no persona and no guidance of its own. Both were the same
    # thing wearing two names — `get_skills` resolved the project's persona and
    # `set_skills` edited it — and the pair is gone with the concept. A persona
    # belongs to a conversation now; see `set_conversation_persona`.
    @abstractmethod
    def list_personas(self, username: str) -> list[dict[str, Any]]:
        """This account's own personas, newest first. Summaries, without bodies."""

    @abstractmethod
    def get_persona(self, username: str, persona_id: str) -> dict[str, Any]:
        """
        One persona with its body. Readable when `username` owns it or it is
        public; 404 otherwise, never 403.

        A persona this account owns also carries `projects`: the names of its
        own projects currently pointed at it. An edit reaches every one of them,
        so the editor has to be able to say which before it saves — and the same
        list is what `delete_persona` refuses with. Omitted, not empty, for a
        persona read from the marketplace: another account's projects are not
        this reader's business, and an official persona is not editable at all.
        """

    @abstractmethod
    def create_persona(self, username: str, fields: dict[str, Any]) -> dict[str, Any]: ...

    @abstractmethod
    def update_persona(
        self,
        username: str,
        persona_id: str,
        fields: dict[str, Any],
        *,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        """
        Edit a persona this account owns.

        `expected_revision` is the revision the caller read. A mismatch raises
        409 rather than overwriting: two tabs editing one persona is the ordinary
        case, and last-write-wins loses work silently.
        """

    @abstractmethod
    def delete_persona(self, username: str, persona_id: str) -> None:
        """Raises 409 naming the projects still referencing it."""

    @abstractmethod
    def browse_personas(
        self, username: str, *, query: str = "", cursor: str | None = None, limit: int = 24
    ) -> dict[str, Any]:
        """
        One page of public personas, newest published first.

        Summaries only — never bodies. A page is then a few hundred bytes a row
        instead of thirty kilobytes, which is the same argument that keeps web
        documents down to an outline. Pagination is keyset, not `OFFSET`.
        """

    @abstractmethod
    def install_persona(self, username: str, persona_id: str) -> dict[str, Any]:
        """
        Fork a public persona into a private one this account owns.

        Idempotent: installing twice returns the copy that already exists. The
        fork is what makes a stranger's text safe to run — after it, nothing the
        author does reaches this reader.
        """

    # --- papers ---------------------------------------------------------
    @abstractmethod
    def count_active_papers(self, username: str, project_id: str) -> int: ...

    @abstractmethod
    def add_paper(
        self, username: str, project_id: str, paper: dict[str, Any]
    ) -> dict[str, Any]:
        """Make a document visible, after the job that files it is queued (invariant 50).

        A web page whose add read only its first window carries
        `capture: "partial"`, and its `capture` job (`capture_marker`) is
        queued before the record too, so a visible partial page never lacks
        the job that finishes it. Its document job waits for that one
        (`waits_for_capture`).
        """

    @abstractmethod
    def get_paper(
        self, username: str, project_id: str, paper_id: str
    ) -> dict[str, Any]:
        """Raises 404 when absent."""

    @abstractmethod
    def touch_paper(
        self, username: str, project_id: str, paper_id: str
    ) -> dict[str, Any]:
        """Record an authenticated reader open and return the narrow paper record."""

    @abstractmethod
    def rename_paper(
        self, username: str, project_id: str, paper_id: str, title: str
    ) -> dict[str, Any]: ...

    @abstractmethod
    def adopt_paper_title(
        self, username: str, project_id: str, paper_id: str, title: str
    ) -> dict[str, Any] | None:
        """
        Name a document by the title it prints, unless someone has named it.

        An upload is titled after its file (`initial_title`): the reader chose
        that name, and a PDF's own metadata is too often wrong to trust. Its
        digest then reads the title the document prints, and this writes it as
        `rename_paper` would, but only while the stored title is still the
        file's name, read inside the same lock or transaction: a title the
        reader set is never overwritten. Returns the paper renamed, or None
        when it was left as it was. 404 when absent.
        """

    @abstractmethod
    def update_paper_snapshot(
        self, username: str, project_id: str, paper_id: str, fields: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Record the counts and fingerprint after a re-snapshot. Narrow on
        purpose — the title stays what document creation chose, and no other
        field of a paper is the snapshot's to move.
        """

    @abstractmethod
    def store_linked_pdf(
        self, username: str, project_id: str, paper_id: str, fields: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Turn a linked PDF into a stored one, in place.

        Narrow for the reason `set_openai_file` is (invariant 9): this runs after
        a fetch that took seconds, so a whole-aggregate write would replay a
        stale paper list over a concurrent rename or reorder. It moves exactly
        what stops being true when Delphi starts holding the bytes — `kind`,
        the counts, the fingerprint, and the display filename — and keeps the
        paper's id, so its highlights, notes, digest and thread stay attached.

        `source_url` is deliberately kept on the row rather than cleared. It is
        provenance, and `paper_record` already omits `url` for a PDF, so nothing
        downstream can mistake a stored paper for a live one.
        """

    @abstractmethod
    def reorder_papers(
        self, username: str, project_id: str, paper_ids: list[str]
    ) -> dict[str, Any]: ...

    @abstractmethod
    def move_paper(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        destination_project_id: str,
        position: int | None = None,
    ) -> dict[str, Any]:
        """
        Re-parent one paper. Returns the destination project.

        `position` is where it lands, clamped into range; `None` means first,
        because a move is something the reader just did and the result belongs
        where they can see it. The drag passes an index because it showed a gap
        and has to honour it.

        What travels is what is about the document: the record, its digest, its
        highlights, and its own chat thread.

        Both projects must belong to `username`, and the destination must have
        room. The caller moves the object bytes; keys carry the project id.
        """

    @abstractmethod
    def delete_paper(
        self, username: str, project_id: str, paper_id: str
    ) -> Removed: ...

    @abstractmethod
    def set_openai_file(
        self, username: str, project_id: str, paper_id: str, file_id: str
    ) -> None:
        """
        Record the provider's file id for one paper. Deliberately not a
        whole-project write: this runs mid-stream, minutes after the project was
        read, and must not replay a stale paper list over a concurrent rename or
        reorder. Implementations must no-op when an id is already set, so two
        concurrent first-questions cannot orphan an uploaded file.
        """

    @abstractmethod
    def replace_openai_file(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        expected_file_id: str,
        file_id: str,
    ) -> bool:
        """Replace one stale provider file id with a freshly uploaded id.

        The expected id makes this a compare-and-swap: a slow recovery must not
        overwrite a newer id installed by another request. Returns whether the
        replacement won.
        """

    @abstractmethod
    def set_paper_source_hash(
        self, username: str, project_id: str, paper_id: str, source_hash: str
    ) -> None:
        """Record the fingerprint of the authoritative page-marked text."""

    @abstractmethod
    def set_paper_done(
        self, username: str, project_id: str, paper_id: str, done: bool
    ) -> dict[str, Any]:
        """Toggle whether a paper is archived out of the working set.

        One field on one paper, never a whole-aggregate replay — the same
        concurrency argument as `set_openai_file`: this can land minutes after
        the project was last read, and must not clobber a concurrent rename
        or reorder.

        Library state only: marking a document done queues no Memory work,
        and returning it to active never rewinds what was filed.
        """

    @abstractmethod
    def claim_digest(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        *,
        claim_id: str,
        expires_at: str,
        metadata: dict[str, Any],
        force: bool,
    ) -> str:
        """
        Claim one digest build.

        Returns ``claimed``, ``busy``, or ``ready``. A forced build keeps an
        existing ready digest visible until its replacement validates.
        """

    @abstractmethod
    def complete_digest(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        claim_id: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        """Publish a validated digest only when this caller still owns the claim."""

    @abstractmethod
    def fail_digest(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        claim_id: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        """Release a claim and expose failure only when no valid digest predates it."""

    # --- Memory ---------------------------------------------
    # Every method here names the **account**, never a project. Papers and
    # projects appear only as provenance, so filing a paper elsewhere — or
    # deleting it — leaves the Memory pages it produced intact and turns its
    # citation into a dangling reference the lint pass reports.
    @abstractmethod
    def enqueue_memory_job(
        self,
        username: str,
        *,
        kind: str,
        marker: str,
        payload: dict[str, Any],
        target_version: str | None = None,
        not_before: str | None = None,
    ) -> dict[str, Any]:
        """Durably schedule one idempotent maintenance pass.

        ``(username, marker)`` is unique. Re-enqueueing returns the existing
        row rather than creating another model call.

        ``target_version`` is the ``MEMORY_VERSION`` this job is being queued
        *for*, stored in its payload as ``targetVersion``. It is part of what
        identifies the job's work: the pipeline looks for its own event by the
        job's id, this version and the fingerprint it read, so a job that
        committed and was claimed again answers ``reused``, and a job queued
        for a newer version is new work. A durable row never carries a bare
        "do it again": the event is written before the job is removed, and a
        row reclaimed after a crash between the two would file twice.

        When the row already exists, only this field is reconciled, and only if
        ``job_payload_is_upgradeable``. The rest of the payload is left exactly
        as it stands, because ``move_paper`` rewrites queued provenance and an
        enqueue must not undo it.

        **Waiting and fingerprints.** ``not_before`` is an ISO time before which
        the job may not be claimed; it is stored as the row's ``retryAt``
        (``job_is_due``). A kind with a stable marker enqueues once per change,
        so on a row that already exists:

        - an enqueue that names ``not_before`` or whose payload carries a
          ``fingerprint`` merges its payload over the stored one, whatever the
          row's status. A worker holding the row then finds at completion that
          the fingerprint moved (``complete_memory_job``);
        - ``not_before`` replaces the ``retryAt`` of a pending or leased row. **A
          later enqueue pushes the wait forward**: every turn of a session sets
          the idle limit again, and ten changes to a domain settle as one pass
          after the last of them. On a leased row it is the wait the job
          returns to when its fingerprint has moved. A failed row keeps its own
          ``retryAt``: that is a backoff, or a job that gave up, and neither is
          this caller's to move.

        An enqueue that names neither behaves as it did before either existed.
        """

    @abstractmethod
    def list_memory_jobs(self, username: str) -> list[dict[str, Any]]:
        """Every unfinished job for this account, oldest first."""

    @abstractmethod
    def claim_memory_job(
        self,
        username: str,
        *,
        now: str,
        lease_expires_at: str,
        max_attempts: int,
        kinds: Sequence[str] | None = None,
    ) -> dict[str, Any] | None:
        """
        Lease one due job and increment its attempt count atomically.

        Only jobs of `kinds`; None is every kind but `CAPTURE_JOB_KINDS`, which
        only their own drain asks for. A document job whose page still owes
        its capture is passed over (`waits_for_capture`).

        Least-attempted first, then oldest — **not** oldest first. `attempts`
        counts claims rather than failures, so a job whose drain nobody stayed
        for comes back due the moment its lease expires; under a strict
        `createdAt` order that job is claimed again ahead of everything behind
        it, forever, and a queue with one such job at its head never advances.
        Ordering on attempts turns the queue into rounds: everything gets a
        first try before anything gets a second.

        A candidate already at `max_attempts` is failed on the way past, with
        that reason recorded, and the scan moves on to the next one — so the
        cap removes it from the queue instead of leaving it permanently due.
        The reason is also appended to its `attemptTelemetry`, as
        `{"rejection": <the reason>, "abandoned": True, "failedAt": now}`: no
        worker reported this attempt, and that is what tells it from one that
        failed.
        """

    @abstractmethod
    def complete_memory_job(
        self,
        username: str,
        job_id: str,
        *,
        expected_lease_expires_at: str | None = None,
        fingerprint: str | None = None,
    ) -> bool:
        """Remove a job after its event marker is durable (including reused).

        ``fingerprint`` is the one the worker read before it started. When the
        row now stores a different one (``job_fingerprint_moved``), something
        the job covers changed during the work, and the pass did not read it:
        the row is kept, pending again with a fresh attempt count and no error,
        its payload and ``retryAt`` exactly as the later enqueue left them.
        Nothing is marked filed that the pass did not read.

        True when the job is gone, false when it was kept for that reason or
        the lease fence did not match.
        """

    @abstractmethod
    def release_memory_jobs(
        self, username: str, *, kind: str | None = None, marker: str | None = None
    ) -> int:
        """Make waiting jobs due now, and say how many were waiting.

        Clears ``retryAt`` on every matching pending job, and on a leased one,
        whose ``retryAt`` is only the wait it would return to. This is the
        reader leaving a session, the app being launched again with no session
        open, and an explicit "File it now". With neither filter it releases
        the account's whole queue. A failed job's ``retryAt`` is its backoff
        and is not touched: `retry_memory_job` is the way past that.
        """

    @abstractmethod
    def fail_memory_job(
        self,
        username: str,
        job_id: str,
        *,
        error: str,
        retry_at: str | None,
        diagnostics: dict[str, Any] | None = None,
        expected_lease_expires_at: str | None = None,
    ) -> dict[str, Any]:
        """Retain a failed job, optionally carrying bounded retry telemetry.

        Every failure appends one entry to the payload's ``attemptTelemetry``,
        which keeps the last eight: ``rejection`` (the error, bounded), then
        ``diagnostics``, then ``failedAt``, the row's new ``updatedAt``. The
        last entry is therefore always this failure, and its ``cause`` is why
        the reader is told it failed (`memory_failure.py`).
        """

    @abstractmethod
    def renew_memory_job_lease(
        self,
        username: str,
        job_id: str,
        *,
        expected_lease_expires_at: str,
        lease_expires_at: str,
    ) -> bool:
        """Push a live claim's fence forward. False if the claim is no longer ours.

        The lease is a *fence*, not a budget for the work. It used to be the
        budget — `memory_job_lease_seconds` sized to outlast a whole filing —
        and the cost of that is what a dead worker leaves behind: a document
        held for the full lease with nothing running, and no way to release it,
        because `retry_memory_job` deliberately refuses anything that is not
        already failed. Sixty-five minutes of a reader's document, for a drain
        that was killed.

        So the lease is short and a live worker keeps renewing it. A worker that
        dies simply stops, and the row frees within one lease. The compare on
        `expected_lease_expires_at` is what makes it safe: if the claim expired
        and somebody else took it, our renewal must not steal it back.
        """

    @abstractmethod
    def release_memory_job(
        self, username: str, job_id: str, *, expected_lease_expires_at: str | None = None
    ) -> None:
        """Hand a claim back, unspent, because nobody abandoned it on purpose.

        `attempts` counts *claims*, so a drain the reader navigated away from
        would spend one for work that never ran: three claims, three
        cancellations, and a document that gave up without one filing being
        tried. The route catches `asyncio.CancelledError` by name, so a
        cancellation restores the count and clears the lease, where a genuine
        failure still spends one. Only a client going away produces this, and
        a client that keeps going away is doing no work either way.

        ``retryAt`` is left as it is. A claim clears it, so it is set here only
        when an enqueue arrived during the work and asked the job to wait.
        """

    @abstractmethod
    def retry_memory_job(self, username: str, job_id: str) -> dict[str, Any]:
        """Reset one explicitly selected failed job to a fresh pending job."""

    @abstractmethod
    def clear_memory_job(self, username: str, marker: str) -> None:
        """Remove the queued job under this marker, whatever its status. No job is not an error."""

    @abstractmethod
    def cancel_memory_jobs(self, username: str, *, kinds: Sequence[str]) -> int:
        """Call off work the reader asked for and has changed their mind about.

        Every other way a job leaves this queue is the queue's own decision —
        it completed, it gave up, its authority was destroyed. This one is the
        reader's, and it exists because pressing Update is the only control in
        the product that commits an account to an unbounded amount of model
        spend: one press queues a job per out-of-date document, and the pump
        then drains them on focus, on becoming visible, and every five minutes
        for the rest of the session. Nothing bounded that.

        **It removes future spend, including the rest of a document already
        being written.** A `pending` row and a `failed` row that still carries a
        `retryAt` are both work that will run if nobody intervenes. So, less
        obviously, is a `leased` one: filing a document is not a single model
        call but a plan, a call per page that plan asks for, and a verification,
        so a reader who stops during "Deciding which pages to write" is stopping
        nearly all of that document's cost, not none of it. This deletes the row
        for all three, and the row's absence is the signal — `memory_job_exists`
        is what the drain asks between stages to find out it should stand down.

        Only a `failed` row with no `retryAt` stays. It has given up, so it will
        never spend again, and its `lastError` is the only account of what went
        wrong — which Health shows and a reader may still want to read.

        Cancelling is not undoing, but it is not lossy either: a document's
        pages and its event are committed in one write at the very end of the
        pass, so a filing stopped partway leaves nothing behind. Pages already
        written stay written, and a document that was out of date still is —
        the offer comes back, because it is still true. Returns how many rows
        were removed.
        """

    @abstractmethod
    def memory_job_exists(self, username: str, job_id: str) -> bool:
        """Whether a job the caller is running is still one the account wants.

        The queue row is the authority on that, and its absence is how a
        cancelled run reaches the process doing the work — which is generally
        not the process that took the cancel, so this cannot be a flag in
        memory. The drain asks between stages, where standing down costs
        nothing and saves every model call the document has left.

        A row also vanishes when its document or its project is deleted
        while a drain holds the job leased. Standing down is the right answer
        to both: in each case the account has stopped wanting this work.
        """

    @abstractmethod
    def list_memory_pages(
        self,
        username: str,
        *,
        kinds: list[str] | None = None,
        domains: list[str] | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        """
        Page metadata, newest first. **Never bodies** — same argument as the
        persona marketplace and the web outline: a listing that carries bodies
        is a listing that cannot be asked for.
        """

    @abstractmethod
    def memory_graph_revision(self, username: str) -> int:
        """Cheap cache key that changes with every graph-affecting write."""

    @abstractmethod
    def replace_memory_snapshot(
        self, username: str, snapshot: dict[str, Any], *, max_pages: int
    ) -> None:
        """Atomically replace one account's wiki from an offline candidate.

        The candidate is built in an isolated filesystem store. This is the
        narrow promotion boundary: normal request code never sees partial rows,
        and no source document, conversation, note, or account record changes.
        """

    @abstractmethod
    def get_memory_page(self, username: str, slug: str) -> dict[str, Any]:
        """One page with its body. 404 when absent or owned by someone else."""

    @abstractmethod
    def upsert_memory_page(
        self,
        username: str,
        page: dict[str, Any],
        *,
        max_pages: int,
        trigger: str | None = None,
        note: str | None = None,
    ) -> dict[str, Any]:
        """
        Write one page, keyed by slug.

        Keyed by slug rather than by request, because that is what makes an
        ingest idempotent: filing the same answer twice revises a page instead
        of appending a near-duplicate. The link table is rebuilt from the body
        in the same transaction, so a page and its edges can never disagree.

        ``aliases`` are stored through ``clean_aliases``; a write that does not
        name the key keeps the aliases the page has, as it keeps provenance.
        A ``concept`` or ``domain`` page gets a version-history row for the
        revision, in the same transaction or under the same lock, stamped with
        ``trigger`` (one of ``VERSION_TRIGGERS``) and ``note``; both are null
        when the writer does not say.
        """

    @abstractmethod
    def delete_memory_page(self, username: str, slug: str) -> Removed:
        """Remove one page, its version history, and every link to it.

        A `[[slug]]` left pointing at a deleted page is a link Delphi cannot
        keep true, so each page that held one is rewritten in the same
        transaction or under the same lock (``unlink_deleted_page``): the link
        becomes its label, or the deleted page's title. A page rewritten this
        way gets a new revision, and a ``concept`` or ``domain`` page a
        version row with no trigger and the note ``LINK_REPAIR_NOTE``. Reports
        the figure bytes the deleted page owned.
        """

    @abstractmethod
    def list_page_versions(self, username: str, slug: str) -> list[dict[str, Any]]:
        """A page's version history, newest first, bodies included.

        One row for every committed revision of a ``concept`` or ``domain``
        page, the current one included, up to ``VERSIONS_KEPT``; the shape is
        ``page_version``. Empty for a source page, and for a slug with no page.
        """

    @abstractmethod
    def page_history(
        self, username: str, slugs: Sequence[str]
    ) -> dict[str, dict[str, dict[str, Any] | None]]:
        """For each slug, its newest version row and its newest `conversation` one.

        ``{"latest": row or None, "asked": row or None}`` for every slug asked
        for, without bodies. ``asked`` is how "you asked about this" is known
        without storing it on the page: the stamp is what the log already says,
        and it is gone once ``VERSIONS_KEPT`` later revisions have pushed the
        row out.
        """

    @abstractmethod
    def search_memory_pages(
        self,
        username: str,
        query: str,
        *,
        domain: str | None = None,
        limit: int = 12,
    ) -> list[dict[str, Any]]:
        """Ranked metadata hits. Bodies are reached one at a time, by slug."""

    @abstractmethod
    def memory_page_bodies(self, username: str) -> dict[str, str]:
        """
        Every page's body, by slug, in one read.

        The exception to "bodies are reached one at a time", for the one caller
        that has to see all of them at once: `grep_memory` matches lines, and
        a line-level answer cannot be assembled from metadata. Nothing here is
        returned to a client or put in a prompt whole.
        """

    @abstractmethod
    def memory_backlinks(self, username: str, slug: str) -> list[dict[str, Any]]:
        """Which pages point here — the half of a wiki a link table exists for."""

    @abstractmethod
    def list_memory_links(self, username: str) -> list[dict[str, str]]:
        """
        Every `[[slug]]` edge in the account, as `{"from", "to"}`.

        One query rather than a page-by-page walk: the graph view needs the
        whole edge list at once, and asking for it a page at a time was
        thirty-seven round trips to draw one picture.
        """

    @abstractmethod
    def memory_domains(self, username: str) -> list[dict[str, Any]]:
        """
        Every domain this account has, in reader order, with its page count.

        Returns the domain *record* — `slug`, `title`, `summary`, `origin`,
        `position` — plus a derived `pages` count, rather than the bare
        `{domain, pages}` pair it used to. The count still comes from the pages
        themselves so a domain nothing sits in reports zero rather than
        disappearing: a domain the reader has just created and not filed
        anything into yet is exactly the one they need to see.
        """

    @abstractmethod
    def upsert_memory_domain(
        self, username: str, domain: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Create or update one domain, keyed by slug.

        Called by `upsert_memory_page` for a domain it has never seen, which
        is what keeps every page in a domain that exists. `origin` never
        downgrades: once a reader has claimed a domain, a later ingest naming it
        does not turn it back into something the model invented.
        """

    @abstractmethod
    def delete_memory_domain(self, username: str, slug: str) -> None:
        """
        Remove one domain.

        Refuses with 409 while any non-domain page still sits in it. Cascading
        would delete the reader's own writing to tidy up a label, and re-filing
        the pages first is both the safe order and the one that makes them think
        about where each belongs. The domain's own page, when it has one, is
        dropped with the label: it described the pages that have just left.
        """

    @abstractmethod
    def move_memory_pages(
        self, username: str, slugs: list[str], domain: str
    ) -> list[dict[str, Any]]:
        """
        Re-file pages into a domain, in one write.

        One call rather than a page-at-a-time loop because a reorganization is
        one decision: applied halfway it leaves the wiki in a state the reader
        did not choose and cannot name. Returns the updated summaries.
        """

    @abstractmethod
    def add_memory_figure(
        self, username: str, figure: dict[str, Any], *, max_per_page: int
    ) -> dict[str, Any]: ...

    @abstractmethod
    def commit_memory_update(
        self,
        username: str,
        *,
        pages: list[dict[str, Any]],
        figures: list[dict[str, Any]],
        event: dict[str, Any],
        max_pages: int,
        max_figures_per_page: int,
        fence_job: tuple[str, int] | None = None,
        require_revision: bool = False,
        trigger: str | None = None,
    ) -> dict[str, Any]:
        """Atomically publish pages, links, figures and event.

        With `fence_job` (id, attempt), publish only while that claim is still leased,
        checked inside the same transaction; raise `MemoryJobGone` otherwise.

        With `require_revision`, a `concept` or `domain` page that carries no
        `expectedRevision` refuses the whole commit with a 422 naming the page
        (`check_expected_revision`); a stale one is a 409 either way.

        Every `concept` or `domain` page written gets a version-history row in
        the same write, holding the event's id, `trigger` and the page's
        `_eventNote`. The stored event always has an `id` for that row to name.
        """

    @abstractmethod
    def get_memory_figure(self, username: str, figure_id: str) -> dict[str, Any]:
        """404 for anyone but the owner — these are pixels out of their library."""

    @abstractmethod
    def put_external_evidence(self, username: str, record: dict[str, Any]) -> dict[str, Any]:
        """
        Keep one captured outside source. Immutable: a capture is what a page
        said on the day it was read, so an id is written once and a second
        write of it is refused with 409.
        """

    @abstractmethod
    def get_external_evidence(self, username: str, evidence_id: str) -> dict[str, Any]:
        """404 for anyone but the owner."""

    @abstractmethod
    def external_evidence_references(self, username: str) -> dict[str, list[dict[str, str]]]:
        """Every evidence id something of this account cites, with what cites it (`evidence_holders`)."""

    @abstractmethod
    def note_citations(self, username: str, paper_id: str) -> dict[str, list[str]]:
        """
        Every note of one document that a Memory page cites, with the pages
        that cite it: `{note id: [slug, ...]}` (`sessions.note_holders`).

        Read off the pages, so it still names a note the reader has deleted,
        which is what it is for: a session's job finds the pages that rest on
        a note that is gone.
        """

    @abstractmethod
    def delete_unreferenced_external_evidence(
        self, username: str, *, older_than_seconds: int
    ) -> list[str]:
        """
        Remove captures nothing cites any more and return their object keys,
        for the caller to delete the bytes. `older_than_seconds` spares a
        capture made for a digest that has not been stored yet.
        """

    @abstractmethod
    def list_memory_figures(
        self, username: str, *, page_id: str | None = None
    ) -> list[dict[str, Any]]: ...

    @abstractmethod
    def append_memory_event(
        self, username: str, event: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Append one line to the log of what the wiki did and why.

        Append-only for the same reason chat is: entries land minutes apart from
        concurrent ingests, and rewriting a list would drop whichever one lost.
        """

    @abstractmethod
    def list_memory_events(
        self, username: str, *, limit: int = 50
    ) -> list[dict[str, Any]]: ...

    @abstractmethod
    def page_events(self, username: str, slug: str) -> list[dict[str, Any]]:
        """
        Every event whose `edits` name this page, oldest first, the whole log.

        What a page's Written by is read from (`memory_authorship`). Not a
        window of `list_memory_events`: a page's first author is often older
        than the newest fifty events the Log shows.
        """

    @abstractmethod
    def get_memory_update(self, username: str) -> dict[str, Any] | None:
        """
        The account's one Update run, so a reader who navigated away can find it.

        The Update pass is client-driven by design — three workers in the tab
        the reader started it in — so the run is invisible everywhere else, and
        a reader who opened another page or closed the tab had no way to learn
        whether their library was still filing. One record per account, because
        one is all a reader can start.

        `heartbeatAt` is what keeps it honest. A tab that goes away stops
        writing, and a stored `running` with no heartbeat is not a run in
        progress — it is exactly the boundary this pass has always had, that a
        closed tab loses whatever was in flight. The read reports that as
        `stale`, so the surface can say "interrupted" rather than animating a
        progress bar nothing is advancing.
        """

    @abstractmethod
    def set_memory_update(
        self, username: str, state: dict[str, Any] | None
    ) -> dict[str, Any] | None:
        """Write or clear it. `None` is the dismissal, not an empty record."""

    @abstractmethod
    def has_memory_event(self, username: str, request_id: str, *, operation_id: str | None = None) -> bool:
        """
        Whether one ingest has already been filed, with no window to fall out of.

        `operation_id` narrows the marker to one exact durable job request
        (its id, its target version and the fingerprint it read), for crash
        recovery.

        The ingest passes are idempotent on a marker, and they used to look for
        it in the newest `list_memory_events` page. That is a cap on how far
        back "already filed" can be seen: an account with more recent entries
        than the limit reports an old ingest as never having happened and refiles
        it, which is the second model call the marker exists to prevent. Backfill
        reaches that in one run; a busy account reaches it eventually.
        """

    @abstractmethod
    def memory_event_version(self, username: str, request_id: str) -> str | None:
        """
        Which pass filed this marker, or None if nothing has.

        `has_memory_event` answers "was this filed", which is the only
        question the idempotency guard has. A *refile* asks a different one —
        "was this filed by the pass that is running now" — and without it a
        bulk refile has no skip test at all: every document it has already
        rewritten is indistinguishable from one it has not touched, so an
        interrupted run redoes the whole library from the top. Reads the newest
        matching event, on `has_memory_event`'s precedent: a windowed listing
        is a cap on how far back "already filed" can be seen, and a refile is
        exactly the operation that writes past any window.
        """

    @abstractmethod
    def latest_marker_events(
        self, username: str, markers: Sequence[str] | None = None
    ) -> dict[str, dict[str, Any]]:
        """
        The newest event each job marker left, whatever way its job ended.

        Keyed by the event's `marker`, which every event of the maintenance
        pipeline carries: a job that filed or found nothing to file, and also
        one whose every page was dropped, whose `requestId` is deliberately not
        its marker. So this is the read for "what did the last job for this
        document do": the fingerprint and version it read, and the targets it
        dropped. `memory_event_versions` answers a different question,
        whether a marker is settled.

        `markers` narrows it to those; None is every marker in the account's
        log, which is what Health walks. A marker with no event is absent.
        Whole log, same ordering as `memory_event_versions`, tie-break
        included.
        """

    @abstractmethod
    def memory_event_versions(
        self, username: str, request_ids: Sequence[str]
    ) -> dict[str, str | None]:
        """The same answer as `memory_event_version`, for many markers at once.

        **A marker nothing filed is absent from the result; a marker filed by a
        pass that predates the stamp maps to `None`.** The singular form
        collapses those two into one `None` because its only caller — the CLI's
        skip test — treats them alike. Every reader-facing surface has to tell
        them apart: one is "not in your wiki", the other is "in your wiki,
        written by something we have replaced", and they get different sentences
        and different verbs.

        Batched because the callers walk the whole library. Asking the singular
        form twice per document is two round trips per paper on Postgres and two
        whole-file reads per paper on the filesystem backend — fifty-two full
        JSON parses for a twenty-six document library, on one request. That is
        the cost invariant 57a exists to refuse, on the read that sits behind
        the Update button.

        Ordering must match `memory_event_version` exactly, tie-break
        included: two events a microsecond apart resolving differently in two
        places is a document that reports stale on one surface and current on
        the other.
        """

    @abstractmethod
    def latest_memory_event(
        self, username: str, *, kind: str
    ) -> dict[str, Any] | None:
        """
        The newest event of one kind, with no mixed-list window to fall out of.

        `list_memory_events` is capped because the Log and the overview only
        need a page of history. Health's `lastCheck` is different: it needs the
        newest *lint*, and a stretch of document events after a check
        must not make the tab claim nobody ever looked. Same argument as
        `has_memory_event` — a windowed scan is a cap on how far back a fact
        can be seen.
        """

    @abstractmethod
    def append_memory_message(
        self, username: str, message: dict[str, Any], thread_key: str
    ) -> None: ...

    # --- the raw-layer index --------------------------------------------
    # Derived, never authoritative. The stored `.txt`/`.web` objects remain the
    # truth about what a document says; these rows exist only so a question can
    # find which documents are worth reading. Rebuilding them is idempotent, and
    # losing them costs a search hit rather than a citation.
    #: A citation needs to know which document owns a section, not what it says.
    SECTION_ANCHORS_PER_DOCUMENT = 400

    @abstractmethod
    def list_section_anchors(
        self, username: str, project_id: str
    ) -> dict[str, list[str]]:
        """
        Every web document's section anchors in one project, in document order.

        Read off the derived section index and nothing else, so a citation of a
        bare `§anchor` can be routed to the document that owns it without an
        object read per document. Bounded per document. Owner-scoped: a project
        another account owns is the same 404 as a missing one.
        """

    @abstractmethod
    def index_document_sections(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        sections: list[dict[str, Any]],
    ) -> int:
        """
        Replace the whole index for one document and answer how many rows it now
        has. Replace rather than merge: a re-snapshot can remove a section, and
        a merge would leave the old one findable forever.
        """

    @abstractmethod
    def search_documents(
        self,
        username: str,
        query: str,
        *,
        project_id: str | None = None,
        paper_id: str | None = None,
        limit: int = 12,
    ) -> list[dict[str, Any]]:
        """
        Ranked `(paper, locator, snippet)` hits across this account's library.

        Account-wide by default, which is the point: one question can reach a
        paper filed in another project. `paper_id` narrows it to one document,
        for a reader that may read that document and no other. Archived documents are still searchable
        — being out of the working set is about what a chat attaches, not about
        what the reader is allowed to find.
        """

    @abstractmethod
    def search_workspace(
        self,
        username: str,
        query: str,
        *,
        limit: int = 20,
    ) -> dict[str, list[dict[str, Any]]]:
        """
        One collective search over everything this account holds.

        `{"memory": [...], "documents": [...], "conversations": [...]}`, each
        list ranked and bounded by `limit`. One method rather than three because
        the three scopes share one query, one term list and one ceiling — and a
        caller able to ask for two of them separately will eventually ask with
        two different needles and wonder why the counts disagree.

        Collective, not coverage-weighted: a hit carries **every** term or it is
        not a hit (`workspace_search.score_collective`). That is the opposite of
        `search_documents` and `search_memory_pages`, which stay lenient
        because they answer the model's tools, where a near miss beats nothing.
        Here a near miss is the wrong answer wearing the right one's rank.

        Every row has the same shape whatever it names — `kind`, `title`,
        `subtitle`, `snippet`, `score` — so one renderer draws all three, plus
        the fields its kind needs to become an address. Rows are records only:
        no object read, on any backend, for any scope.
        """

    @abstractmethod
    def list_usernames(self) -> list[str]:
        """
        Every account, for maintenance that spans them.

        Deliberately narrow and deliberately here rather than in a script
        reaching around the boundary: the deployed backend has no directory to
        walk, so a rebuild command needs the store to answer this.
        """

    # --- chat -----------------------------------------------------------
    @abstractmethod
    def list_recent_conversations(
        self, username: str, *, limit: int = 5
    ) -> list[dict[str, Any]]:
        """Newest non-empty conversations across the document and Memory scopes."""

    @abstractmethod
    def finish_cancelled_trace(self, username: str, conversation_id: str, generation: int, request_id: str, trace: list) -> None:
        """Attach server-recorded terminal work to an existing cancellation only.

        Never creates an answer, alters its content, or crosses a generation.
        The first terminal trace wins; no Memory job is enqueued.
        """

    @abstractmethod
    def get_conversation(self, username: str, conversation_id: str) -> dict[str, Any]:
        """One owned conversation with its append-ordered messages."""

    @abstractmethod
    def set_memory_filed_through(
        self, username: str, conversation_id: str, request_id: str | None, *, if_present: bool = False
    ) -> bool:
        """Record the last request a Memory filing has covered.

        Read back as ``memoryFiledThrough`` wherever a conversation record is
        (`get_conversation`, `list_recent_conversations`). Three values mean
        three things (`jobs.unfiled_exchanges`): a request id is "filed
        through here"; the empty string is "nothing filed, file from the
        first turn"; null is "nothing to file", which is what a conversation
        has until its first whole answer is appended (`sessions.turn_to_file`).
        `drop_from_last_user_turn` moves it back to the last request still in
        the thread when it drops the one named here, and resetting a
        conversation clears it.

        ``if_present`` writes only while the conversation still holds a
        message of that request, under the conversation's lock, and answers
        whether it wrote: a job that filed a request the reader has since
        retracted must not leave a watermark that names nothing. 404 for a
        conversation the account does not own.
        """

    @abstractmethod
    def claim_conversation_title(
        self,
        username: str,
        *,
        project_id: str | None,
        thread_key: str | None,
        engagement_id: str,
        fallback_title: str,
    ) -> dict[str, Any] | None:
        """Atomically claim the one title attempt this engagement gets.

        `None` for the engagement already holding the claim, and only for that
        — every mounted chat that asks something buys one title, so a
        conversation returned to a week later is named for what it has become
        rather than for how it opened. A failed attempt writes nothing, which
        leaves the previous title standing.
        """

    @abstractmethod
    def set_conversation_title(
        self,
        username: str,
        conversation_id: str,
        *,
        title: str,
        model: str,
        updated_at: str,
    ) -> None: ...

    @abstractmethod
    def release_conversation_title_claim(
        self, username: str, conversation_id: str, *, engagement_id: str
    ) -> None:
        """Give the claim back when the attempt never happened.

        The claim is taken before the stream so the conversation has a name
        while it runs, but the request that would write the title only exists
        once there is an answer. A stream that failed or was stopped would
        otherwise spend the mount's one claim on nothing, and every later
        question asked from that same mounted chat is refused the title it
        should have bought. A no-op unless the claim is still this
        engagement's, so a newer mount's claim is never taken away.
        """

    @abstractmethod
    def set_conversation_model(
        self,
        username: str,
        *,
        project_id: str | None,
        thread_key: str | None,
        model: str,
    ) -> None: ...

    @abstractmethod
    def set_conversation_persona(
        self,
        username: str,
        *,
        project_id: str | None,
        thread_key: str | None,
        persona_id: str,
    ) -> None:
        """
        Record the persona this conversation is held in.

        Narrow, in the spirit of `set_openai_file`: it writes one field and
        replays no aggregate. It runs both when a turn is appended and when the
        reader merely picks from the composer's menu, which is why it creates
        the conversation if there is not one yet — a persona chosen before the
        first question still has to survive a reload. An empty conversation is
        invisible to `list_recent_conversations`, which requires a message, so
        opening a menu cannot litter the reader's history.
        """

    @abstractmethod
    def get_thread(
        self, username: str, project_id: str | None, thread_key: str
    ) -> dict[str, Any]:
        """One conversation, named by its selector; `None` is the account-wide scope."""

    @abstractmethod
    def append_message(
        self, username: str, project_id: str, thread_key: str, message: dict[str, Any]
    ) -> None:
        """
        Append one turn. An append, not a rewrite of the thread, so two tabs
        cannot silently drop each other's messages.

        A whole answer holds the session's job in the same write
        (`sessions.session_job`): the document's, shared by every chat beside
        it and by its notes. `append_memory_message` does the same for a
        Memory chat, whose job is the conversation's own. An answer that was
        cut off, stopped or failed enqueues nothing.
        """

    @abstractmethod
    def drop_from_last_user_turn(
        self,
        username: str,
        project_id: str | None,
        thread_key: str,
        request_id: str,
    ) -> list[dict[str, Any]]:
        """
        Drop the last user message and everything after it.

        Tail-only, so a concurrent tab that already appended a later question
        is a 409 rather than a silent drop of that question. Memory already
        written stays. A `memoryFiledThrough` that named a dropped request
        moves back to the last request that remains, or to null. The session's
        job is left queued: it reads the conversation as it stands when it
        runs, and one with nothing left to file ends without an event.
        """

    @abstractmethod
    def list_chat_images(
        self, username: str, project_id: str | None, thread_key: str | None, now: str
    ) -> list[dict[str, Any]]: ...

    @abstractmethod
    def add_chat_image(
        self,
        username: str,
        project_id: str | None,
        thread_key: str | None,
        image: dict[str, Any],
        *,
        max_count: int,
        max_bytes: int,
    ) -> dict[str, Any]: ...

    @abstractmethod
    def get_chat_image(
        self, username: str, project_id: str | None, thread_key: str | None, image_id: str
    ) -> dict[str, Any]: ...

    @abstractmethod
    def reference_chat_images(
        self,
        username: str,
        project_id: str | None,
        thread_key: str | None,
        image_ids: list[str],
        now: str,
        question_excerpt: str,
    ) -> list[dict[str, Any]]: ...

    @abstractmethod
    def delete_unused_chat_image(
        self, username: str, project_id: str | None, thread_key: str | None, image_id: str
    ) -> dict[str, Any]: ...

    # --- highlights -----------------------------------------------------
    @abstractmethod
    def list_highlights(
        self, username: str, project_id: str, paper_id: str
    ) -> list[dict[str, Any]]: ...

    @abstractmethod
    def add_highlight(
        self, username: str, project_id: str, paper_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]: ...

    @abstractmethod
    def delete_highlight(
        self, username: str, project_id: str, paper_id: str, highlight_id: str
    ) -> None: ...

    # --- notes ----------------------------------------------------------
    # What the reader wrote against a passage, as opposed to what the authors
    # wrote. Anchored to a highlight and cascading from it, so removing the
    # stroke removes the note; removing the note leaves the stroke, which is
    # what emptying the editor means.
    #
    # Writing, editing or deleting a note holds the document's session job in
    # the same write (`sessions.session_job`), and so does deleting a
    # highlight that carried one. A note reaches Memory when the session ends,
    # not each time one is taken.
    @abstractmethod
    def list_notes(
        self, username: str, project_id: str, paper_id: str
    ) -> list[dict[str, Any]]: ...

    @abstractmethod
    def add_note(
        self, username: str, project_id: str, paper_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]: ...

    @abstractmethod
    def update_note(
        self, username: str, project_id: str, paper_id: str, note_id: str, body: str
    ) -> dict[str, Any]: ...

    @abstractmethod
    def delete_note(
        self, username: str, project_id: str, paper_id: str, note_id: str
    ) -> None: ...

    @abstractmethod
    def list_unfiled_notes(
        self, username: str, project_id: str, paper_id: str
    ) -> list[dict[str, Any]]:
        """
        The notes no filing has read yet, or that changed since one did.

        `mark_notes_filed` is the write half, and it runs only after a job
        that read them has committed.
        """

    @abstractmethod
    def mark_notes_filed(
        self,
        username: str,
        project_id: str,
        paper_id: str,
        note_ids: list[str],
        now: str,
    ) -> None: ...
