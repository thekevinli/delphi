"""Recovery and bounded rewrites exercise real storage with provider doubles."""
import json

import httpx
import pytest
from pydantic import ValidationError

from delphi_core import memory
from delphi_core.config import Settings
from delphi_core.memory import MEMORY_VERSION
from delphi_core.memory_rewrite import PageRewrite, validate_page_rewrite, rewrite_page
from delphi_core.research_digest import digest_semantic_objections
from delphi_core.routers import memory as routes
from delphi_core.schemas import (
    REWRITE_NOTE_MAX_CHARS,
    REWRITE_NOTE_MAX_WORDS,
    MemoryBackfillRequest,
    MemoryPageRewriteRequest,
)
from delphi_core.storage import LocalStorage, LocalObjectStore, paper_key

pytestmark = pytest.mark.kb_maintenance


@pytest.fixture
def library(tmp_path):
    settings = Settings(data_dir=tmp_path)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    project = storage.create_project("reader", "Reading")
    paper = storage.add_paper("reader", project["id"], {
        "id": "paper-one", "title": "Paper", "filename": "p.pdf", "pages": 2,
    })
    objects = LocalObjectStore(tmp_path)
    objects.put_text(paper_key("reader", project["id"], paper["id"], "txt"), "The rate is 3. The mechanism matters.")
    for job in storage.list_memory_jobs("reader"):
        storage.complete_memory_job("reader", job["id"])
    return settings, storage, objects, project, paper


DROPPED = {"slug": "mechanism", "title": "Mechanism", "action": "create",
           "reason": "The passage gives the rate as 3, not 4.", "quote": "the rate is 4 in every setting"}
DIGEST = {
    "contentMarkdown": "The rate is 3 [E1].",
    "citations": [{"id": 1, "claimType": "author-claim", "page": 1, "section": None, "evidenceId": None}],
    "assets": [],
}


def provider(asked: list[str]) -> httpx.AsyncClient:
    """A provider whose every selection finds nothing to file, and that records what it was asked."""

    def handler(request: httpx.Request) -> httpx.Response:
        asked.append(json.loads(request.content)["text"]["format"]["name"])
        answer = {"nothingToFile": True, "reason": "Memory already says this.", "pages": [], "needsOutside": None}
        return httpx.Response(200, json={
            "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(answer)}]}],
            "usage": {"input_tokens": 10, "output_tokens": 2},
        })

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def claim(storage):
    return storage.claim_memory_job(
        "reader", now="2026-10-13T00:00:00+00:00", lease_expires_at="2099-01-01T00:00:00+00:00", max_attempts=3
    )


def test_retry_queues_a_document_whose_last_job_dropped_a_target(library):
    """
    A document at the current version whose last job could not write a page is
    still owed that page. The card says what was dropped, and the press queues
    the document's one job again.
    """
    settings, storage, _, project, paper = library
    marker = f"paper:{paper['id']}"
    storage.append_memory_event("reader", {
        "kind": "document", "requestId": marker, "marker": marker, "outcome": "filed",
        "paperId": paper["id"], "projectId": project["id"], "pages": ["other"],
        "version": MEMORY_VERSION, "dropped": [DROPPED],
    })
    state = routes.document_filing_state(paper["id"], username="reader", storage=storage, settings=settings)
    assert state["filed"] and not state["stale"] and state["dropped"] == [DROPPED]

    result = routes.enqueue_backfill(MemoryBackfillRequest(paperIds=[paper["id"]]),
        username="reader", storage=storage, settings=settings)
    assert result == {"queued": 0, "revived": 0, "upgraded": 1, "inFlight": 0}
    job = storage.list_memory_jobs("reader")[0]
    assert (job["kind"], job["marker"]) == ("document", marker)
    assert job["payload"] == {"projectId": project["id"], "paperId": paper["id"], "targetVersion": MEMORY_VERSION}

    # A later job that wrote everything it staged settles it: nothing is offered.
    storage.complete_memory_job("reader", job["id"])
    storage.append_memory_event("reader", {
        "kind": "document", "requestId": marker, "marker": marker, "outcome": "filed",
        "paperId": paper["id"], "pages": ["mechanism"], "version": MEMORY_VERSION, "dropped": [],
    })
    assert routes.document_filing_state(paper["id"], username="reader", storage=storage, settings=settings)["dropped"] == []
    assert sum(routes.enqueue_backfill(MemoryBackfillRequest(paperIds=[paper["id"]]),
        username="reader", storage=storage, settings=settings).values()) == 0


def test_targeted_enqueue_does_not_touch_another_document(library):
    settings, storage, _, _, _ = library
    result = routes.enqueue_backfill(MemoryBackfillRequest(paperIds=["not-owned"]),
        username="reader", storage=storage, settings=settings)
    assert sum(result.values()) == 0
    assert storage.list_memory_jobs("reader") == []


@pytest.mark.asyncio
async def test_page_rewrite_preserves_graph_figures_and_is_idempotent(library, monkeypatch):
    settings, storage, objects, project, paper = library
    prior = storage.upsert_memory_page("reader", {
        "slug": "mechanism", "kind": "concept", "title": "Mechanism", "domain": "ml",
        "body": "The rate is 3. [E1] [[neighbor]] ![A](figure:fig-one)", "summary": "Rate",
        "sourcePaperId": paper["id"], "sourceProjectId": project["id"],
        "citations": [{"id": 1, "paperId": paper["id"], "page": 1, "claimType": "author-claim"}],
    }, max_pages=50)
    storage.add_memory_figure("reader", {"id": "fig-one", "pageSlug": "mechanism", "caption": "A",
        "objectKey": "knowledge/figure.webp"}, max_per_page=5)
    before = storage.get_memory_page("reader", "mechanism")
    edges = storage.list_memory_links("reader")
    for pending in storage.list_memory_jobs("reader"):
        storage.complete_memory_job("reader", pending["id"])
    job = routes.enqueue_page_rewrite("mechanism", username="reader", storage=storage, settings=settings)
    calls = []

    async def provider(*args, **kwargs):
        calls.append(kwargs["schema_name"])
        if kwargs["schema_name"] == "knowledge_page_rewrite":
            return json.dumps({"body": "The rate is 3. The mechanism matters. [E1] [[neighbor]] ![A](figure:fig-one)", "summary": "A clearer rate explanation"})
        return '{"objections": []}'

    monkeypatch.setattr("delphi_core.memory_rewrite._provider_update", provider)
    for _ in range(2):
        events = [event async for event in rewrite_page(None, storage, objects, "reader", settings,
            job=job, use_standard_tier=True)]
    assert calls == ["knowledge_page_rewrite", "knowledge_page_rewrite_check"]
    assert events[-1]["reused"]
    after = storage.get_memory_page("reader", "mechanism")
    for key in ("slug", "kind", "title", "domain", "citations", "figures"):
        assert after[key] == before[key], key
    assert after["revision"] == prior["revision"] + 1
    assert storage.list_memory_links("reader") == edges
    assert len(storage.list_memory_pages("reader")) == 1
    # The rewrite gave the page another summary, which its domain's page is owed.
    assert [job["marker"] for job in storage.list_memory_jobs("reader") if job["kind"] == "domain"] == [
        f"domain:{after['domain']}"]


@pytest.mark.parametrize("body", ["Lost the connection. [E1]", "Changed [[other]]. [E1]", "Kept [[neighbor]] but lost evidence."])
def test_rewrite_cannot_change_graph_or_evidence(body):
    with pytest.raises(ValueError):
        validate_page_rewrite(PageRewrite(body=body, summary="Draft"), {"body": "Prior [[neighbor]]. [E1]"})


@pytest.mark.asyncio
async def test_reader_note_reaches_the_author_as_guidance_and_never_the_verifier(library, monkeypatch):
    """Not `instructions` (hashed into the cache key), and not the verifier (35)."""
    settings, storage, objects, project, paper = library
    storage.upsert_memory_page("reader", {
        "slug": "mechanism", "kind": "concept", "title": "Mechanism", "domain": "ml",
        "body": "The rate is 3. [E1]", "summary": "Rate",
        "sourcePaperId": paper["id"], "sourceProjectId": project["id"],
        "citations": [{"id": 1, "paperId": paper["id"], "page": 1, "claimType": "author-claim"}],
    }, max_pages=50)
    for pending in storage.list_memory_jobs("reader"):
        storage.complete_memory_job("reader", pending["id"])

    note = "  too   abstract, start from the worked example  "
    body = MemoryPageRewriteRequest(note=note)
    job = routes.enqueue_page_rewrite("mechanism", body=body, username="reader",
                                      storage=storage, settings=settings)
    assert job["payload"]["readerNote"] == "too abstract, start from the worked example"
    # The same words again are the same job; different words are not.
    assert routes.enqueue_page_rewrite("mechanism", body=MemoryPageRewriteRequest(note=note),
        username="reader", storage=storage, settings=settings)["id"] == job["id"]
    assert routes.enqueue_page_rewrite("mechanism", body=MemoryPageRewriteRequest(note="too long"),
        username="reader", storage=storage, settings=settings)["id"] != job["id"]

    seen = {}

    async def provider(*args, **kwargs):
        seen[kwargs["schema_name"]] = kwargs
        if kwargs["schema_name"] == "knowledge_page_rewrite":
            return json.dumps({"body": "The rate is 3, from the worked example. [E1]", "summary": "Rate"})
        return '{"objections": []}'

    monkeypatch.setattr("delphi_core.memory_rewrite._provider_update", provider)
    [event async for event in rewrite_page(None, storage, objects, "reader", settings,
        job=job, use_standard_tier=True)]
    author = seen["knowledge_page_rewrite"]
    assert author["reader_request"] == "too abstract, start from the worked example"
    assert "too abstract" not in author["instructions"]
    assert not seen["knowledge_page_rewrite_check"].get("reader_request")


def test_a_note_the_reader_was_never_offered_room_for_is_refused():
    """The word count is the rule the reader was given, so it is the rule enforced."""
    MemoryPageRewriteRequest(note=" ".join(["word"] * REWRITE_NOTE_MAX_WORDS))
    with pytest.raises(ValidationError):
        MemoryPageRewriteRequest(note=" ".join(["word"] * (REWRITE_NOTE_MAX_WORDS + 1)))
    with pytest.raises(ValidationError):
        MemoryPageRewriteRequest(note="w" * (REWRITE_NOTE_MAX_CHARS + 1))


@pytest.mark.asyncio
async def test_the_reader_request_is_the_last_thing_the_model_reads():
    """Asserted on the outgoing request: "appended late" is not "arrives last"."""
    sent = {}

    class Response:
        status_code = 200
        text = ""
        is_error = False
        headers: dict[str, str] = {}

        def raise_for_status(self):
            return None

        def json(self):
            return {"status": "completed",
                    "output": [{"type": "message",
                                "content": [{"type": "output_text", "text": "{}"}]}]}

    class Client:
        async def post(self, url, **kwargs):
            sent.update(kwargs["json"])
            return Response()

    async def call(**extra):
        sent.clear()
        await memory._provider_update(
            Client(), settings=Settings(),
            index="(one-page rewrite)", use_standard_tier=True,
            instructions="AUTHORING SKILL",
            task={"type": "input_text", "text": '{"page": {}, "sourceText": "..."}'},
            schema={"type": "object", "properties": {}, "additionalProperties": False},
            schema_name="knowledge_page_rewrite",
            reader_request="too abstract, start from the worked example", **extra)
        return [block["text"] for block in sent["input"][0]["content"]]

    blocks = await call()
    assert blocks[-1].startswith("<reader_request>")
    # Stated as the objective before it is bounded, or it reads as a boundary.
    assert "objective of this attempt" in blocks[-1]
    assert "not authority to add, drop or change" in blocks[-1]
    # The reader's words are input to read, never part of the instructions.
    assert "worked example" not in sent["instructions"]

    after_rejection = await call(validation_feedback="Invented locator")
    assert after_rejection[-2].startswith("<reader_request>")
    assert after_rejection[-1].startswith("<validation_feedback>")


def test_rewrite_scrubs_control_bytes_before_it_judges_the_graph():
    """Stripped, and stripped before the comparisons a stray byte would fool."""
    draft = PageRewrite(body="Kept [[neigh\x1cbor]]. Let $x = a \x1ccdots b$. [E1]", summary="Dr\x1caft")
    validate_page_rewrite(draft, {"body": "Prior [[neighbor]]. [E1]"})
    assert "\x1c" not in draft.body and "\x1c" not in draft.summary
    assert draft.summary == "Draft"


def test_semantic_checks_ground_errors_without_length_or_image_quotas():
    """A grounded objection counts; an unfindable one is dropped, never raised.

    Raising spent the whole digest on the *checker's* mistake — one correction
    attempt regenerated it from scratch and a second miss failed the document,
    for a quotation the author had no part in. The count is what keeps the drop
    from being silent: a check whose every objection was dropped publishes as
    `inconclusive`, not as `passed`.
    """
    draft = PageRewrite(body="The rate is 4.", summary="Rate")
    objection = {"kind": "incorrect-claim", "sourceQuote": "The rate is 3.",
                 "digestQuote": "The rate is 4.", "reason": "Wrong rate"}

    grounded = digest_semantic_objections(
        json.dumps({"objections": [objection]}), draft, "The rate is 3.")
    assert grounded.objections and grounded.ungrounded == 0

    clean = digest_semantic_objections('{"objections": []}', draft, "The rate is 4.")
    assert clean.objections == [] and clean.ungrounded == 0

    # The quotation is nowhere in the source: unverifiable, so it is not
    # evidence of a defect — and the digest survives to be published.
    adrift = digest_semantic_objections(
        json.dumps({"objections": [objection]}), draft, "Unrelated text")
    assert adrift.objections == [] and adrift.ungrounded == 1

    # Rendering differences are not disagreements: ligatures, curly quotes and
    # a soft hyphen all still ground, which is the PDF case that made dropping
    # so much commoner than a real fabrication.
    fancy = {**objection, "sourceQuote": "The \u201crate\u201d is 3.",
             "digestQuote": "The rate is 4."}
    folded = digest_semantic_objections(
        json.dumps({"objections": [fancy]}), draft, 'The "ra\u00adte"  is\n3.')
    assert folded.objections and folded.ungrounded == 0


@pytest.mark.asyncio
async def test_a_job_survives_deploy_and_crash_without_repeating_model_work(library, monkeypatch):
    """
    A job queued for one version and run by a worker at another, which dies
    after its commit and before the job is removed. The reclaimed job finds
    its own event and asks no model. A new job for the document is another
    operation, and runs.
    """
    settings, storage, objects, project, paper = library
    settings = settings.model_copy(update={"openai_api_key": "test-key"})
    objects.put_text(paper_key("reader", project["id"], paper["id"], "digest"), json.dumps({"digest": DIGEST}))
    monkeypatch.setattr(routes, "digest_is_current", lambda *_: True)
    # Memory already explains an idea, so a selection may find nothing to file
    # (into a Memory with no concept page, a document is always filed).
    storage.upsert_memory_page("reader", {
        "slug": "mechanism", "kind": "concept", "title": "Mechanism", "domain": "ml",
        "body": "The rate is 3. [E1]", "summary": "Rate",
        "sourcePaperId": paper["id"], "sourceProjectId": project["id"],
        "citations": [{"id": 1, "paperId": paper["id"], "page": 1, "claimType": "author-claim"}],
    }, max_pages=50)
    for pending in storage.list_memory_jobs("reader"):
        storage.complete_memory_job("reader", pending["id"])
    marker = f"paper:{paper['id']}"
    storage.enqueue_memory_job("reader", kind="document", marker=marker,
        payload={"projectId": project["id"], "paperId": paper["id"]}, target_version="queued-before-deploy")
    job = claim(storage)
    asked: list[str] = []

    async def run(current):
        async with provider(asked) as client:
            return [event async for event in routes.run_maintenance_job(current, client=client, storage=storage,
                objects=objects, username="reader", settings=settings, use_standard_tier=True)]

    first = (await run(job))[-1]
    assert not first["reused"] and first["outcome"] == "nothing"
    # The worker stamps its own version, whatever version the job was queued for.
    assert storage.memory_event_version("reader", marker) == MEMORY_VERSION
    # A document with a digest and no source page was given its page on the way.
    assert sorted(page["kind"] for page in storage.list_memory_pages("reader", limit=10)) == ["concept", "source"]

    again = (await run(job))[-1]
    assert again["reused"] and asked == ["memory_file_selection"]

    assert storage.complete_memory_job("reader", job["id"], fingerprint=again["fingerprint"])
    storage.enqueue_memory_job("reader", kind="document", marker=marker,
        payload=job["payload"], target_version=MEMORY_VERSION)
    assert not (await run(claim(storage)))[-1]["reused"]
    assert asked == ["memory_file_selection"] * 2


@pytest.mark.asyncio
async def test_a_page_rewrite_is_written_and_checked_by_the_tasks_that_file_a_document(library):
    """
    The whole rewrite against the provider's wire shape: the agent's model
    writes the page from the authoring contract's own account of a concept
    page, and the checker's model reads the result against its sources.
    """
    from delphi_core.memory_rewrite import REWRITE_INSTRUCTIONS

    settings, storage, objects, project, paper = library
    settings = settings.model_copy(update={"openai_api_key": "test-key"})
    storage.upsert_memory_page("reader", {
        "slug": "mechanism", "kind": "concept", "title": "Mechanism", "domain": "ml",
        "body": "The rate is 3. [E1]", "summary": "Rate",
        "sourcePaperId": paper["id"], "sourceProjectId": project["id"],
        "citations": [{"id": 1, "paperId": paper["id"], "page": 1, "claimType": "author-claim"}],
    }, max_pages=50)
    for pending in storage.list_memory_jobs("reader"):
        storage.complete_memory_job("reader", pending["id"])
    job = routes.enqueue_page_rewrite("mechanism", username="reader", storage=storage, settings=settings)
    assert "reason" not in job["payload"]
    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent.append(body)
        rewrite = body["text"]["format"]["name"] == "knowledge_page_rewrite"
        answer = {"body": "The rate is 3, and the mechanism matters. [E1]", "summary": "Rate"} if rewrite else {"objections": []}
        return httpx.Response(200, json={
            "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(answer)}]}],
            "usage": {"input_tokens": 10, "output_tokens": 2},
        })

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        events = [event async for event in rewrite_page(client, storage, objects, "reader", settings,
            job=job, use_standard_tier=True)]

    assert events[-1]["type"] == "_memory_result" and not events[-1]["reused"]
    assert "the mechanism matters" in storage.get_memory_page("reader", "mechanism")["body"]
    author, check = sent
    assert (author["model"], author["reasoning"]["effort"], author["max_output_tokens"]) == (
        settings.memory_maintain_model, settings.memory_maintain_reasoning_effort, settings.memory_maintain_max_output_tokens)
    assert (check["model"], check["reasoning"]["effort"], check["max_output_tokens"]) == (
        settings.memory_verify_model, settings.memory_verify_reasoning_effort, settings.memory_verify_max_output_tokens)
    assert author["instructions"] == REWRITE_INSTRUCTIONS
    for said in ("# What a concept page contains", "# Notation, tables and diagrams", "# This rewrite",
                 "Rewrite ONLY this page's body and summary"):
        assert said in REWRITE_INSTRUCTIONS
    # No placeholder of the contract is left unfilled, and nothing of the agent's tools came along.
    assert "{{" not in REWRITE_INSTRUCTIONS and "edit_memory" not in REWRITE_INSTRUCTIONS
    # The page's document is what both calls read; nothing is offered as citable beyond the page's own markers.
    blocks = [block["text"] for block in author["input"][0]["content"]]
    assert any("The rate is 3. The mechanism matters." in block for block in blocks)
    assert not any("<evidence_ids>" in block for block in blocks)


def test_a_rewrite_of_a_page_on_two_long_papers_reads_the_pages_it_cites():
    # The first evaluation: a two-document page could not be rewritten, because
    # both papers whole passed the rewrite's bound.
    from delphi_core.memory_rewrite import REWRITE_SOURCE_MAX_CHARS, rewrite_source

    def paper(tag, pages=40, size=3_000):
        return "".join(f"--- Page {page} ---\n{tag}{page} " + "x" * size + "\n" for page in range(1, pages + 1))

    texts = {"a": paper("alpha"), "b": paper("beta"), "web": "A saved page, read whole."}
    citations = [{"paperId": "a", "page": 7}, {"paperId": "b", "page": 1}, {"paperId": "b", "page": 30}, {"paperId": "web", "section": "intro"}]
    source = rewrite_source(texts, citations)
    assert len(source) <= REWRITE_SOURCE_MAX_CHARS
    assert [f"alpha{page} " in source for page in (5, 6, 7, 8, 9)] == [False, True, True, True, False]
    assert all(f"beta{page} " in source for page in (1, 2, 29, 30, 31)) and "beta3 " not in source
    assert "--- Page 6 ---\nalpha6" in source and "A saved page, read whole." in source
    # Sources that fit are read whole, as before.
    small = {"a": paper("alpha", pages=3, size=10)}
    assert rewrite_source(small, citations) == f"Document a:\n{small['a']}"
