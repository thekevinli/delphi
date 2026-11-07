"""
The maintenance agent's stage: one bounded loop that stages, and one repair.

The provider is scripted: each round of a run is the frames a real response
would stream. Everything else is real: the `memory.maintain` toolset, the
budget, the draft, and a local store behind a wrapper that fails the test on
any call that could change it. A run stages; it stores nothing.
"""

import asyncio
import hashlib
import json
import re
from pathlib import Path

import httpx
import pytest

from delphi_core.config import Settings
from delphi_core.harness import profiles
from delphi_core.harness.budget import MAINTAIN_STAGED_PAGES
from delphi_core.harness.prompts import EVIDENCE_REQUIREMENTS, UNTRUSTED_TEXT_RULE, working_method
from delphi_core.harness.provider import ProviderError, ResponsesClient
from delphi_core.memory_maintenance import agent, maintain
from delphi_core.memory_maintenance.brief import UNTRUSTED_TAGS
from delphi_core.memory_maintenance.run import Authored, EvidenceSet, Objection, Selection
from delphi_core.memory_maintenance.staging import Evidence
from delphi_core.memory_maintenance.validate import CONCEPT_LIMITS, REASONS
from delphi_core.model_tasks import service_tier_for
from delphi_core.storage import LocalStorage

BODY = (
    "## Position encoding\n\n"
    "Sinusoidal encodings add a fixed signal to each token [E1].\n\n"
    "Learned encodings [E2] are a table of vectors; see [[attention]].\n"
)
CITATIONS = [
    {"id": 1, "claimType": "author-claim", "paperId": "p1", "page": 3, "section": None},
    {"id": 2, "claimType": "author-claim", "paperId": "p1", "page": 5, "section": None},
]
ROWS = (
    {"kind": "domain", "domain": "ml", "title": "ML", "slug": "ml", "summary": "The domain.", "body": "Domain page."},
    {"kind": "concept", "domain": "ml", "title": "Position encoding", "summary": "How order reaches a model.",
     "body": BODY, "citations": CITATIONS, "aliases": ["PE"]},
    {"kind": "concept", "domain": "ml", "title": "Attention", "summary": "Weighted mixing.", "body": "Attention mixes tokens.\n"},
    {"kind": "concept", "domain": "ml", "title": "Rotary embeddings", "summary": "Rotations as position.",
     "body": "Rotary embeddings rotate pairs of dimensions.\n"},
    {"kind": "source", "domain": "ml", "title": "Paper A", "summary": "Its digest.",
     "body": "The digest of paper A. See [[position-encoding]].\n", "sourcePaperId": "p1"},
)
SOURCES = (
    Evidence("p1", title="Paper A", pages=12, notes=frozenset({"n1"})),
    Evidence("w1", title="Saved page", sections=("intro", "Method")),
    Evidence("x1", kind="external", title="Outside survey", sections=("s1",)),
)
BRIEF = "<document_digest>\nPaper A introduces a relative position bias (p. 4).\n</document_digest>"
WRITES = ("upsert_", "delete_", "put_", "write_", "save_", "append_", "set_", "create_", "update_", "move_",
          "record_", "add_", "remove_", "rename_", "commit_", "enqueue_", "complete_")
RETIRED = re.compile(r"\b(gaps?|levels?|hubs?|areas?)\b", re.I)


class ReadOnly:
    """A store that fails the test when anything asks it to change."""

    def __init__(self, inner):
        self._inner = inner

    def __getattr__(self, name):
        assert not name.startswith(WRITES), f"the stage called storage.{name}"
        return getattr(self._inner, name)


def fingerprint(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(root).as_posix().encode() + b"\0" + path.read_bytes())
    return digest.hexdigest()


def frames(*events: dict) -> bytes:
    return "".join(f"data: {json.dumps(event)}\n\n" for event in events).encode()


def call(name: str, arguments: dict, call_id: str) -> dict:
    return {"type": "response.output_item.done", "item": {
        "type": "function_call", "id": f"fc_{call_id}", "call_id": call_id, "name": name, "arguments": json.dumps(arguments)}}


def said(text: str) -> list[dict]:
    return [
        {"type": "response.output_text.delta", "delta": text},
        {"type": "response.output_item.done", "item": {
            "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}},
    ]


COMPLETED = {"type": "response.completed", "response": {"status": "completed", "usage": {"input_tokens": 100, "output_tokens": 10}}}


def calls(*made: dict) -> bytes:
    return frames(*made, COMPLETED)


def closing(text: str) -> bytes:
    return frames(*said(text), COMPLETED)


def op(kind, **given):
    return {"op": kind, "block": "", "blocks": [], "markdown": "", "find": "", "with": "", "reason": "", "evidence": [], **given}


def cite(ref, kind="author-claim", **given):
    return {"ref": ref, "claimType": kind, "paperId": "p1" if kind in {"author-claim", "reader-note"} else "",
            "page": 0, "section": "", "noteId": "", "evidenceId": "", **given}


def edit(slug="position-encoding", block="b2", text="Relative schemes add a bias indexed by offset [N1].", **given) -> dict:
    return {"slug": slug, "operations": [op("insert_after", block=block, markdown=text)],
            "citations": [cite("N1", page=4)] if "[N1]" in text else [], "calculations": [],
            "summary": "", "aliases": [], "note": "added the relative bias", **given}


def create(**given) -> dict:
    return {"title": "Relative position bias", "aliases": [], "domain": "ml",
            "summary": "A learned bias on attention scores by offset.",
            "body": "## Relative position bias\n\nA bias indexed by offset is added to each score [N1].",
            "citations": [cite("N1", page=4)], "calculations": [], "note": "paper A introduces it",
            "distinctFrom": [], "distinctReason": "", **given}


class Stalled(httpx.AsyncByteStream):
    """A response that starts and never finishes."""

    async def __aiter__(self):
        yield frames({"type": "response.output_text.delta", "delta": "Next I will"})
        await asyncio.sleep(30)

    async def aclose(self) -> None:
        pass


class Job:
    """One account with pages in it, an event to file, and a scripted provider."""

    def __init__(self, tmp_path, **settings):
        self.root = tmp_path
        self.settings = Settings(_env_file=None, data_dir=tmp_path, openai_api_key="test-key", **settings)
        store = LocalStorage(self.settings)
        store.create_account("reader", None, "salt", "hash")
        for row in ROWS:
            store.upsert_memory_page("reader", row, max_pages=50)
        self.before = fingerprint(tmp_path)
        self.storage = ReadOnly(store)
        self.evidence = EvidenceSet(
            kind="document", marker="paper:p1", project_id="proj", paper_id="p1", title="Paper A",
            start_slugs=("paper-a",), sources=SOURCES, brief=BRIEF,
        )
        self.selection = Selection(False, "Paper A extends position\nencoding.", ("position-encoding",))
        self.same = []
        self.asked = []
        self.sent: list[dict] = []
        self.objects = None

    async def same_idea(self, title, aliases, summary):
        self.asked.append(title)
        return list(self.same)

    def _client(self, rounds):
        start = len(self.sent)

        def handler(request: httpx.Request) -> httpx.Response:
            self.sent.append(json.loads(request.content))
            reply = rounds[min(len(self.sent) - start, len(rounds)) - 1]
            return httpx.Response(200, content=reply) if isinstance(reply, bytes) else httpx.Response(200, stream=reply)

        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    async def author(self, *rounds, deadline=60.0, **given) -> Authored:
        async with self._client(rounds) as http:
            return await maintain.author(
                ResponsesClient(http, self.settings), self.settings, storage=self.storage, objects=self.objects,
                username="reader", same_idea=self.same_idea, deadline_seconds=deadline, use_standard_tier=True,
                **{"evidence": self.evidence, "selection": self.selection, **given},
            )

    async def repair(self, authored, objections, *rounds, deadline=60.0) -> Authored:
        async with self._client(rounds) as http:
            return await maintain.repair(
                ResponsesClient(http, self.settings), self.settings, storage=self.storage, objects=self.objects,
                username="reader", authored=authored, objections=objections, same_idea=self.same_idea,
                deadline_seconds=deadline, use_standard_tier=True,
            )

    def unchanged(self) -> bool:
        return fingerprint(self.root) == self.before


def outputs(request: dict) -> list[str]:
    return [item["output"] for item in request["input"] if item.get("type") == "function_call_output"]


def texts(request: dict) -> list[str]:
    """The user messages of a request, each as one string."""
    found = []
    for item in request["input"]:
        if item.get("role") == "user":
            content = item["content"]
            found.append(content if isinstance(content, str) else "".join(block.get("text", "") for block in content))
    return found


def test_the_contract_is_loaded_whole_with_the_shared_blocks_and_the_enforced_numbers_put_in():
    written = (Path(maintain.__file__).with_name("contracts") / "maintain.md").read_text()
    # The file includes the shared blocks by name and restates neither.
    assert "{{EVIDENCE_REQUIREMENTS}}" in written and "{{UNTRUSTED_TEXT_RULE}}" in written
    assert EVIDENCE_REQUIREMENTS.splitlines()[2] not in written and UNTRUSTED_TEXT_RULE.splitlines()[0] not in written
    assert not RETIRED.search(written), RETIRED.search(written)
    # No number the tools enforce is written into it by hand.
    assert f"{CONCEPT_LIMITS.target:,}" not in written and "25%" not in written
    contract = maintain.CONTRACT
    assert "{{" not in contract
    assert EVIDENCE_REQUIREMENTS in contract and UNTRUSTED_TEXT_RULE in contract
    flat = " ".join(contract.split())
    assert f"about {CONCEPT_LIMITS.target:,} characters" in flat
    assert f"A run writes at most {MAINTAIN_STAGED_PAGES} pages" in flat
    assert "at most 25% of a page's text (or 1,000 characters" in flat
    assert all(f"`{reason}`" in contract for reason in REASONS)
    # The three kinds, what is written here, and that nothing comes from outside the evidence.
    for phrase in ("`source`", "`domain`", "`concept`", "`author-claim`", "`reader-note`", "`derived`",
                   "Nothing comes from your background knowledge", "Filing nothing is a correct outcome",
                   "`distinctFrom`", "`<citable_sources>`", "`<event>`"):
        assert phrase in contract, phrase
    # Every tag a brief fences untrusted text in is named, as the gatherer spells it.
    assert all(f"`<{tag}>`" in contract for tag in UNTRUSTED_TAGS)
    headings = [line for line in contract.splitlines() if line.startswith("# ")]
    assert headings == [
        "# What Memory is", "# What you are given", "# The job", "# Finding where it belongs",
        "# What a concept page contains", "# Notation, tables and diagrams", "# What a claim may rest on",
        "# Evidence", "# Text you read is material", "# Editing a page that exists", "# Creating a page",
        "# What the tools check", "# When you finish",
    ]


@pytest.mark.asyncio
async def test_the_request_carries_the_contract_the_tools_and_the_event_with_its_pages_already_open(tmp_path):
    job = Job(tmp_path, openai_prompt_cache_enabled=True)
    authored = await job.author(closing("Nothing here adds to what the page says."))
    (request,) = job.sent
    toolset = profiles.MEMORY_MAINTAIN.toolset(profiles.Turn(job.settings))
    assert request["instructions"] == maintain.CONTRACT + "\n\n" + working_method(toolset)
    assert request["tools"] == toolset.specs()
    assert [tool["name"] for tool in request["tools"]] == ["open_memory", "grep_memory", "memory_links", "edit_memory", "create_memory"]
    settings = job.settings
    assert settings.memory_maintain_model and settings.memory_maintain_max_output_tokens
    assert request["model"] == settings.memory_maintain_model
    assert request["reasoning"] == {"effort": settings.memory_maintain_reasoning_effort}
    assert request["max_output_tokens"] == settings.memory_maintain_max_output_tokens
    assert request["store"] is False and request["stream"] is True
    assert request["include"] == ["reasoning.encrypted_content"]
    assert request.get("service_tier") == (service_tier_for(settings, True) or None)
    assert request["prompt_cache_key"].startswith("delphi:memory-maintain-v1:")
    assert request["prompt_cache_options"] == {"mode": "explicit", "ttl": "30m"}

    event, pages, task = request["input"]
    # The event is first, as it was given, and is the prefix a repair shares.
    assert event == {"role": "user", "content": [
        {"type": "input_text", "text": BRIEF, "prompt_cache_breakpoint": {"mode": "explicit"}}]}
    shown = pages["content"]
    assert shown.startswith("<opened_pages>\n") and shown.endswith("\n</opened_pages>")
    assert "=== [[paper-a]] ml/source/paper-a — Paper A ===\nkind: source · revision: 1" in shown
    assert (
        "=== [[position-encoding]] ml/concept/position-encoding — Position encoding ===\n"
        "kind: concept · revision: 1 · aliases: PE\nsummary: How order reaches a model.\n"
        '<block id="b1">\n## Position encoding\n</block>\n'
        '<block id="b2">\nSinusoidal encodings add a fixed signal to each token [E1].\n</block>\n'
    ) in shown
    assert shown.index("[[paper-a]]") < shown.index("[[position-encoding]]")
    said_ = task["content"]
    assert said_.startswith("<filing_task>\nStart from [[paper-a]].\n")
    assert "The selection pass judged that the event bears on [[position-encoding]]." in said_
    assert "'Paper A extends position encoding.'" in said_
    assert (
        "<citable_sources>\n"
        "- paperId `p1` — Paper A: a document, a PDF, pages 1 to 12. The reader's notes on it, by noteId: n1.\n"
        "- paperId `w1` — Saved page: a document, read by section: intro, Method.\n"
        "- evidenceId `x1` — Outside survey: an outside source. Sections: s1.\n"
        "</citable_sources>"
    ) in said_
    assert "This run may write at most 2 pages." in said_ and "limit" not in said_
    # Where a new page may go: the domains there are. The project the evidence
    # names does not exist here, and its line is left out rather than failing the job.
    assert "Memory's domains: `ml` (Ml, 5 pages)." in said_ and "project" not in said_
    # Both pages are recorded as shown, so an edit of either addresses these blocks.
    assert set(authored.draft.shown) == {"paper-a", "position-encoding"}
    assert authored.draft.shown["position-encoding"].body == BODY
    assert authored.draft.max_pages == MAINTAIN_STAGED_PAGES
    assert job.unchanged()

    # Without the provider's prompt cache the request names no key and marks no breakpoint.
    plain = Job(tmp_path / "plain", openai_prompt_cache_enabled=False)
    await plain.author(closing("Nothing."), selection=Selection(False, "", ("no-such-page", "paper-a")))
    assert "prompt_cache_key" not in plain.sent[0]
    assert plain.sent[0]["input"][0] == {"role": "user", "content": [{"type": "input_text", "text": BRIEF}]}
    task = texts(plain.sent[0])[-1]
    assert "The selection pass named no other page." in task
    assert "Not opened here, so open them if you need them: [[no-such-page]]." in task


@pytest.mark.asyncio
async def test_a_run_that_opens_a_page_and_edits_it_stages_the_edit_and_stores_nothing(tmp_path):
    job = Job(tmp_path)
    authored = await job.author(
        calls(call("open_memory", {"slugs": ["attention"]}, "c1")),
        calls(call("edit_memory", edit("attention", "b1", "It is biased by offset in relative schemes [N1]."), "c2")),
        closing("Added the relative bias to [[attention]]."),
    )
    (page,) = authored.draft.staged
    assert (page.slug, page.action, page.revision) == ("attention", "edit", 1)
    assert page.body == "Attention mixes tokens.\n\nIt is biased by offset in relative schemes [E1].\n"
    assert authored.closing == "Added the relative bias to [[attention]]."
    assert (authored.ended, authored.rounds, authored.dropped) == ("completed", 3, [])
    assert authored.usage["input_tokens"] == 300 and authored.usage["output_tokens"] == 30
    assert [(entry["tool"], entry["ok"]) for entry in authored.trace] == [("open_memory", True), ("edit_memory", True)]
    assert authored.trace[1]["args"] == {"slug": "attention", "note": "added the relative bias"}
    # The request kept is the run as it ended: every call, every result, and the closing words.
    assert authored.request["instructions"] == job.sent[0]["instructions"]
    kept = authored.request["input"]
    assert kept[:3] == job.sent[0]["input"]
    assert [item.get("type") for item in kept[3:]] == [
        "function_call", "function_call_output", "function_call", "function_call_output", "message"]
    assert kept[6]["output"].startswith("Staged the edit to `attention` as read at revision 1")
    # Nothing reached the store.
    assert job.storage.get_memory_page("reader", "attention")["body"] == "Attention mixes tokens.\n"
    assert job.unchanged()


@pytest.mark.asyncio
async def test_a_refused_write_is_corrected_in_the_same_loop(tmp_path):
    job = Job(tmp_path)
    wrong = edit(text="Relative schemes add a bias [N1].", citations=[cite("N1", page=40)])
    authored = await job.author(
        calls(call("edit_memory", wrong, "c1")),
        calls(call("edit_memory", edit(), "c2")),
        closing("Added the bias to [[position-encoding]]."),
    )
    refused, staged = outputs(job.sent[2])
    assert refused.startswith("Error: the edit to `position-encoding` was not staged.")
    assert "Citation N1 cites page 40 of 'Paper A', which has pages 1 to 12." in refused
    assert staged.startswith("Staged the edit to `position-encoding`")
    (page,) = authored.draft.staged
    assert "Relative schemes add a bias indexed by offset [E3]." in page.body
    assert [entry["ok"] for entry in authored.trace] == [False, True]
    assert job.unchanged()


@pytest.mark.asyncio
async def test_a_page_opened_in_the_input_is_edited_without_being_opened_again(tmp_path):
    job = Job(tmp_path)
    authored = await job.author(calls(call("edit_memory", edit(), "c1")), closing("Filed."))
    (page,) = authored.draft.staged
    assert (page.slug, page.revision) == ("position-encoding", 1)
    assert page.body.startswith("## Position encoding\n\nSinusoidal encodings add a fixed signal to each token [E1].\n\nRelative schemes")
    # A page nobody opened is still refused, and the start page is no concept page.
    other = Job(tmp_path / "other")
    await other.author(
        calls(call("edit_memory", edit("attention", "b1", "More."), "c1"), call("edit_memory", edit("paper-a", "b1", "More."), "c2")),
        closing("Nothing staged."),
    )
    unopened, source = outputs(other.sent[1])
    assert unopened.startswith("Error: `attention` has not been opened in this run")
    assert source.startswith("Error: `paper-a` is a source page")


@pytest.mark.asyncio
async def test_a_create_the_same_idea_check_flags_is_refused_until_the_agent_says_how_it_differs(tmp_path):
    job = Job(tmp_path)
    job.same = ["rotary-embeddings"]
    authored = await job.author(
        calls(call("create_memory", create(), "c1")),
        calls(call("create_memory", create(distinctFrom=["rotary-embeddings"], distinctReason="A bias on scores, not a rotation of vectors."), "c2")),
        closing("Created [[relative-position-bias]]."),
    )
    refused, staged = outputs(job.sent[2])
    assert refused.startswith("Error: These pages may already explain this idea: [[rotary-embeddings]] (Rotary embeddings).")
    assert staged.startswith("Staged the new concept page `relative-position-bias`")
    (page,) = authored.draft.staged
    assert (page.action, page.revision, page.distinct_from) == ("create", 0, ("rotary-embeddings",))
    assert page.distinct_reason == "A bias on scores, not a rotation of vectors."
    assert job.asked == ["Relative position bias"]
    assert job.unchanged()


@pytest.mark.asyncio
async def test_a_run_that_stages_nothing_ends_cleanly_with_its_reason(tmp_path):
    job = Job(tmp_path)
    authored = await job.author(
        calls(call("grep_memory", {"pattern": "relative", "glob": ""}, "c1")),
        closing("The page already says this; nothing to file."),
    )
    assert authored.draft.staged == ()
    assert (authored.ended, authored.closing) == ("completed", "The page already says this; nothing to file.")
    assert job.unchanged()


@pytest.mark.asyncio
async def test_a_run_past_its_deadline_keeps_what_it_staged_and_a_failed_response_is_raised(tmp_path):
    job = Job(tmp_path)
    authored = await job.author(calls(call("edit_memory", edit(), "c1")), Stalled(), deadline=0.5)
    assert authored.ended == "deadline" and authored.closing == ""
    assert [page.slug for page in authored.draft.staged] == ["position-encoding"]
    # The conversation kept can still be resumed: every call in it was answered.
    assert [item.get("type") for item in authored.request["input"][3:]] == ["function_call", "function_call_output"]
    # No time left at all is the same ending, never a loop with no deadline.
    late = await Job(tmp_path / "late").author(closing("Too late."), deadline=0)
    assert late.ended == "deadline" and late.draft.staged == ()

    failed = frames({"type": "response.failed", "response": {"status": "failed", "error": {"message": "The provider broke."}}})
    with pytest.raises(ProviderError):
        await Job(tmp_path / "failed").author(failed)


def test_a_conversation_the_deadline_cut_mid_call_is_kept_without_the_unanswered_call():
    cut = [
        {"role": "user", "content": "event"},
        {"type": "function_call", "call_id": "c1", "name": "open_memory", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "c1", "output": "a page"},
        {"type": "function_call", "call_id": "c2", "name": "edit_memory", "arguments": "{}"},
    ]
    assert agent.settled(cut) == cut[:3]


async def two_staged(job: Job) -> Authored:
    return await job.author(
        calls(call("open_memory", {"slugs": ["attention"]}, "c1")),
        calls(call("edit_memory", edit(), "c2"), call("edit_memory", edit("attention", "b1", "It is biased by offset [N1]."), "c3")),
        closing("Filed on both pages."),
    )


OBJECTION = Objection(
    "position-encoding", "unsupported", "Relative schemes add a bias indexed by offset",
    "Page 4 says the bias is indexed by a bucket of offsets.", evidence_id="p1", blocking=True,
)


@pytest.mark.asyncio
async def test_a_repair_resumes_the_run_and_only_the_blocked_page_can_change(tmp_path):
    job = Job(tmp_path)
    authored = await two_staged(job)
    blocked, other = authored.draft.staged
    assert (blocked.slug, other.slug) == ("position-encoding", "attention")
    rounds_before = len(job.sent)

    fixed = edit(text="Relative schemes add a bias indexed by a bucket of offsets [N1].")
    repaired = await job.repair(
        authored, [OBJECTION, Objection("never-staged", "differs", "x", "y", blocking=True)],
        calls(
            call("edit_memory", fixed, "r1"),
            call("edit_memory", edit("attention", "b1", "Attention is rewritten wholesale [N1]."), "r2"),
        ),
        closing("Corrected the bias to buckets of offsets."),
    )
    request = job.sent[rounds_before]
    # The same run: the request as it ended, and one more message.
    assert request["instructions"] == authored.request["instructions"] and request["tools"] == authored.request["tools"]
    assert request["input"][:-1] == authored.request["input"]
    message = request["input"][-1]["content"]
    assert message.startswith("A checker read what you staged against the evidence and blocked 1 page. Nothing has been stored.")
    assert (
        "[[position-encoding]] (Position encoding), staged as an edit:\n"
        "1. A claim the passage it cites does not support. The page says: "
        "\"Relative schemes add a bias indexed by offset\" The checker's explanation: "
        "Page 4 says the bias is indexed by a bucket of offsets. Evidence: p1."
    ) in message
    assert "never-staged" not in message and "attention" not in message
    assert "do not touch any other page" in message
    # Only the two write tools may be called: the pages are open already.
    assert request["tool_choice"] == {"type": "allowed_tools", "mode": "auto", "tools": [
        {"type": "function", "name": "edit_memory"}, {"type": "function", "name": "create_memory"}]}

    now_blocked, now_other = repaired.draft.staged
    assert now_blocked.slug == "position-encoding"
    assert "indexed by a bucket of offsets [E3]." in now_blocked.body and now_blocked != blocked
    # The scripted model rewrote the other page and was told it was staged. It comes out as it went in.
    assert outputs(job.sent[rounds_before + 1])[-1].startswith("Staged the edit to `attention`")
    assert now_other is other and now_other.body == "Attention mixes tokens.\n\nIt is biased by offset [E1].\n"
    # The event says what the pass filed; the repair's closing describes only the correction.
    assert repaired.closing == "Filed on both pages."
    assert (repaired.ended, repaired.rounds) == ("completed", authored.rounds + 2)
    assert repaired.usage["input_tokens"] == authored.usage["input_tokens"] + 200
    assert [entry["tool"] for entry in repaired.trace] == [*(entry["tool"] for entry in authored.trace), "edit_memory", "edit_memory"]
    assert repaired.request["input"][: len(request["input"])] == request["input"]
    assert job.unchanged()


@pytest.mark.asyncio
async def test_a_repair_keeps_no_page_it_was_not_asked_for_and_spends_two_writes_a_page(tmp_path):
    job = Job(tmp_path)
    authored = await job.author(calls(call("edit_memory", edit(), "c1")), closing("Filed."))
    (blocked,) = authored.draft.staged
    start = len(job.sent)
    # A refused write, a new page nobody asked for, and then a third write past the allowance.
    wrong = edit(text="A bias [N1].", citations=[cite("N1", page=99)])
    repaired = await job.repair(
        authored, [OBJECTION],
        calls(call("edit_memory", wrong, "r1"), call("create_memory", create(), "r2")),
        calls(call("edit_memory", edit(text="A bias indexed by buckets [N1]."), "r3")),
        closing("Could not correct it."),
    )
    first = outputs(job.sent[start + 1])[-2:]
    assert first[0].startswith("Error: the edit to `position-encoding` was not staged.")
    assert first[1].startswith("Staged the new concept page `relative-position-bias`")
    assert outputs(job.sent[start + 2])[-1].startswith("Error: this run's allowance of write calls is spent.")
    # The write calls are spent, so the next round may call nothing; and it is the closing round anyway.
    assert job.sent[start + 2]["tool_choice"] == "none"
    assert repaired.draft.staged == (blocked,)
    assert job.unchanged()

    # No objection about a staged page: nothing is asked and the run comes back as it was.
    assert await job.repair(authored, [Objection("attention", "differs", "x", "y", blocking=True)], closing("unused")) is authored
    assert len(job.sent) == start + 3

    # A repair the provider fails is raised, with every staged page as it went in.
    failed = frames({"type": "response.failed", "response": {"status": "failed", "error": {"message": "The provider broke."}}})
    with pytest.raises(ProviderError):
        await job.repair(authored, [OBJECTION], failed)
    assert authored.draft.staged == (blocked,)
    # One cut off by the deadline keeps what the blocked page had.
    late = await job.repair(authored, [OBJECTION], Stalled(), deadline=0.3)
    assert late.ended == "deadline" and late.draft.staged == (blocked,)


@pytest.mark.asyncio
async def test_at_the_page_cap_the_agent_is_told_and_a_page_it_creates_anyway_is_not_kept(tmp_path):
    job = Job(tmp_path, memory_max_pages=len(ROWS))
    authored = await job.author(
        calls(call("edit_memory", edit(), "c1"), call("create_memory", create(), "c2")),
        closing("Filed, and created a page."),
    )
    task = texts(job.sent[0])[-1]
    assert (
        "Memory holds 5 pages, which is the account's limit, so no page can be created in this run. "
        "Edit the pages that exist, and when you finish say what had no page to go into."
    ) in task
    assert [page.slug for page in authored.draft.staged] == ["position-encoding"]
    (dropped,) = authored.dropped
    assert (dropped.slug, dropped.title, dropped.action) == ("relative-position-bias", "Relative position bias", "create")
    assert "limit" in dropped.reason

    # Room for one: said, and the second page created is the one taken back.
    tight = Job(tmp_path / "tight", memory_max_pages=len(ROWS) + 1)
    kept = await tight.author(
        calls(call("create_memory", create(), "c1"),
              call("create_memory", create(title="Bucketed offsets", body="## Bucketed offsets\n\nOffsets share buckets [N1]."), "c2")),
        closing("Created two pages."),
    )
    assert "Memory holds 5 of the 6 pages the account may have, so this run can create 1 new page at most." in texts(tight.sent[0])[-1]
    assert [page.slug for page in kept.draft.staged] == ["relative-position-bias"]
    assert [page.slug for page in kept.dropped] == ["bucketed-offsets"]
    assert tight.unchanged()


def test_the_shelf_names_each_domain_with_its_size_and_the_documents_project(tmp_path):
    store = LocalStorage(Settings(_env_file=None, data_dir=tmp_path))
    store.create_account("reader", "reader@example.test", "salt", "hash")
    assert maintain.shelf(store, "reader", "") == "Memory has no domains yet."
    project = store.create_project("reader", "Optimizers")
    for slug, domain in (("muon", "optimizers"), ("adam", "optimizers"), ("rope", "position-encoding"), ("x", "general")):
        store.upsert_memory_page("reader", {
            "slug": slug, "kind": "concept", "domain": domain, "title": slug, "summary": "S.", "body": "B.\n",
        }, max_pages=50)
    store.upsert_memory_domain("reader", {"slug": "position-encoding", "title": "Position encoding"})
    # The unsorted domain is not a place to put a page, so it is not offered.
    assert maintain.shelf(store, "reader", project["id"]) == (
        "Memory's domains: `optimizers` (Optimizers, 2 pages); `position-encoding` (Position encoding, 1 page). "
        "The reader keeps this document in the project 'Optimizers'."
    )
    # A domain the reader made is offered while still empty, and one they renamed by its new name; both are
    # marked as theirs. An empty one the model named is not offered.
    store.upsert_memory_domain("reader", {"slug": "world-models", "title": "World models", "origin": "reader"})
    store.upsert_memory_domain("reader", {"slug": "optimizers", "title": "Matrix optimizers", "origin": "reader"})
    store.upsert_memory_domain("reader", {"slug": "abandoned", "title": "Abandoned"})
    assert maintain.shelf(store, "reader", "") == (
        "Memory's domains: `optimizers` (Matrix optimizers, 2 pages, the reader's); "
        "`position-encoding` (Position encoding, 1 page); `world-models` (World models, 0 pages, the reader's)."
    )


def _readable_job(tmp_path):
    """A job about Paper A, a PDF its run may read, in a project that also holds Paper B."""
    from delphi_core.memory_maintenance.run import Readable
    from delphi_core.storage import LocalObjectStore
    from tests.helpers import seed_paper

    job = Job(tmp_path)
    store = LocalStorage(job.settings)
    project = store.create_project("reader", "Reading")["id"]
    pages = {1: "Paper A studies how transformers encode order.",
             4: "A relative position bias is added to every attention logit, indexed by offset."}
    text = "".join(f"\n--- Page {number} ---\n{body}" for number, body in pages.items())
    for paper_id, title in (("p1", "Paper A"), ("p2", "Paper B")):
        seed_paper(job.settings, "reader", project, {"id": paper_id, "title": title, "pages": 4, "filename": "a.pdf"}, text=text)
        store.index_document_sections("reader", project, paper_id, [
            {"kind": "page", "locator": str(number), "ordinal": number, "title": f"Page {number}", "text": body}
            for number, body in pages.items()])
    job.objects = LocalObjectStore(tmp_path)
    job.before = fingerprint(tmp_path)
    job.evidence = EvidenceSet(
        kind="document", marker="paper:p1", project_id=project, paper_id="p1", title="Paper A",
        start_slugs=("paper-a",), sources=SOURCES, brief=BRIEF,
        readable=Readable("p1", project, "Paper A", "pdf", pages=4),
    )
    return job


@pytest.mark.anyio
async def test_a_run_about_a_document_reads_its_pages_finds_them_by_search_and_reads_no_other_document(tmp_path):
    job = _readable_job(tmp_path)

    authored = await job.author(
        calls(call("search_library", {"query": "relative position bias"}, "c1"),
              call("read_paper", {"paper_id": "p1", "pages": [4]}, "c2"),
              call("read_paper", {"paper_id": "p2", "pages": [4]}, "c3")),
        closing("Read page 4."),
    )

    first, last = job.sent[0], job.sent[-1]
    offered = {tool["name"] for tool in first["tools"]}
    assert {"search_library", "read_paper"} <= offered and "read_webpage" not in offered
    found, read, other = outputs(last)
    # The search looks in the event's document only, and points at the page that prints it.
    assert "in this document" in found and "p. 4" in found and "Paper B" not in found
    assert 'read_paper(paper_id="p1", pages=[4])' in found
    assert "indexed by offset" in read
    # The only document it may read is the one its event is about.
    assert other.startswith("Error: no PDF with paper_id 'p2'")
    # A chat turn's reading budget, and nothing stored by reading.
    assert authored.readable.paper_id == "p1" and job.unchanged()
    assert "search_library" in first["instructions"] and "read the page before you write a claim" in first["instructions"]
    # Leaving a claim out, or saying the document lacks something, comes after a search: it is cheap.
    assert "Before you leave out something the\ndigest says, or write that the document does not report something, search" in first["instructions"]
    assert found.count("Open with: read_paper") <= 5 and "Paper A" not in found.split("\n", 1)[1]


@pytest.mark.anyio
async def test_a_run_with_no_document_to_read_is_offered_no_reader(tmp_path):
    job = Job(tmp_path)

    await job.author(closing("Nothing to file."))

    offered = {tool["name"] for tool in job.sent[0]["tools"]}
    assert not offered & {"read_paper", "read_webpage", "search_library"}


@pytest.mark.anyio
async def test_a_repair_reads_the_page_an_objection_names_before_it_corrects_the_claim(tmp_path):
    job = _readable_job(tmp_path)
    authored = await job.author(calls(call("edit_memory", edit(citations=[cite("N1", page=1)]), "c1")), closing("Edited."))
    objection = Objection("position-encoding", "unsupported", "Relative schemes add a bias indexed by offset",
                          "Page 1 does not say this.", "p1", blocking=True)

    await job.repair(
        authored, [objection],
        calls(call("read_paper", {"paper_id": "p1", "pages": [4]}, "r1")),
        calls(call("edit_memory", edit(citations=[cite("N1", page=4)]), "r2")),
        closing("Cited page 4, which prints it."),
    )

    repair = job.sent[-1]
    told = [item for item in repair["input"] if item.get("role") == "user"][-1]["content"]
    assert "Read the page an objection names before you correct it" in told
    assert any("indexed by offset" in output for output in outputs(repair))
    assert {"read_paper", "search_library"} <= {tool["name"] for tool in repair["tools"]}
