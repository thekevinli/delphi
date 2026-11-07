"""
The two tools that write Memory, through the dispatcher a maintenance run uses.

Every call here goes through `Toolset.dispatch` with the `memory.maintain`
profile's toolset, so what is tested is what a run would be served: the
arguments as the strict schema parses them, the budget, and the prose handed
back. No model is called. The store is a real local one behind a wrapper that
fails the test on any call that could change it, and its files are compared
before and after: a write tool stages, and stores nothing.
"""

import hashlib
import json
from pathlib import Path

import pytest

from delphi_core.answer_trace import AnswerTrace
from delphi_core.config import Settings
from delphi_core.harness import profiles
from delphi_core.harness.budget import WRITE_CALLS_SPENT, TurnBudget
from delphi_core.harness.tool import ToolContext
from delphi_core.memory_harness import open_chosen_memory
from delphi_core.memory_maintenance.blocks import split_blocks
from delphi_core.memory_maintenance.staging import Evidence, ExistingPage, MemoryDraft
from delphi_core.storage import LocalStorage

LONG = "Relative schemes encode the offset between two tokens, not where either one sits. " * 6
BODY = (
    "## Position encoding\n\n"
    "Sinusoidal encodings add a fixed signal to each token [E1].\n\n"
    "Learned encodings [E2] are a table of vectors; see [[attention]] and [[old-idea|the old idea]].\n\n"
    f"{LONG.strip()}\n\n"
    "```python\nrow = table[[0]]\n```\n\n"
    "An open question: do learned tables extrapolate past the trained length?\n"
)
CITATIONS = [
    {"id": 1, "claimType": "author-claim", "paperId": "p1", "page": 3, "section": None},
    {"id": 2, "claimType": "author-claim", "paperId": "p1", "page": 5, "section": None},
]
EVIDENCE = (
    Evidence("p1", title="Paper A", pages=12, notes=frozenset({"n1"})),
    Evidence("w1", title="Saved page", sections=("intro", "Method")),
    Evidence("x1", kind="external", title="Outside survey", sections=("s1",)),
)
ALIASES = {"position-encoding": ("Positional encoding", "PE")}
WRITES = ("upsert_", "delete_", "put_", "write_", "save_", "append_", "set_", "create_", "update_", "move_", "record_", "add_", "remove_", "rename_")


class ReadOnly:
    """A store that fails the test when anything asks it to change."""

    def __init__(self, inner):
        self._inner = inner

    def __getattr__(self, name):
        assert not name.startswith(WRITES), f"a tool called storage.{name}"
        return getattr(self._inner, name)


def fingerprint(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(root).as_posix().encode() + b"\0" + path.read_bytes())
    return digest.hexdigest()


class Run:
    """One maintenance run's context, with fakes for what a stage would supply."""

    def __init__(self, tmp_path, *, max_pages=2, same_idea=(), evidence=EVIDENCE):
        self.root = tmp_path
        self.settings = Settings(_env_file=None, data_dir=tmp_path)
        store = LocalStorage(self.settings)
        store.create_account("reader", None, "salt", "hash")
        for row in (
            {"kind": "domain", "domain": "ml", "title": "ML", "slug": "ml", "summary": "The domain.", "body": "Domain page."},
            {"kind": "concept", "domain": "ml", "title": "Position encoding", "summary": "How order reaches a model.",
             "body": BODY, "citations": CITATIONS},
            {"kind": "concept", "domain": "ml", "title": "Attention", "summary": "Weighted mixing.", "body": "Attention mixes tokens."},
            {"kind": "concept", "domain": "ml", "title": "Rotary embeddings", "summary": "Rotations as position.",
             "body": "Rotary embeddings rotate pairs of dimensions."},
            {"kind": "source", "domain": "ml", "title": "Paper A", "summary": "Its digest.", "body": "The digest of paper A.",
             "sourcePaperId": "p1"},
            {"kind": "concept", "domain": "ml", "title": "Legacy page", "summary": "Written before the rules.",
             "body": "An old page that names https://example.org/old in its text.\n\nA second paragraph.\n"},
        ):
            store.upsert_memory_page("reader", row, max_pages=50)
        self.before = fingerprint(tmp_path)
        self.storage = ReadOnly(store)
        self.draft = MemoryDraft(evidence, max_pages=max_pages)
        self.asked: list[tuple[str, list[str], str]] = []
        self.same_idea = list(same_idea)
        self.budget = TurnBudget.for_maintenance(self.settings, staged_pages=max_pages)
        self.toolset = profiles.MEMORY_MAINTAIN.toolset(profiles.Turn(self.settings))
        self.ctx = ToolContext(
            settings=self.settings, username="reader", storage=self.storage, offered=self.toolset.names,
            draft=self.draft, memory_pages=self.pages, same_idea=self.ask,
        )

    def pages(self):
        return [
            ExistingPage(page["slug"], page["title"], page["kind"], ALIASES.get(page["slug"], ()), page["revision"])
            for page in self.storage.list_memory_pages("reader", limit=100)
        ]

    async def ask(self, title, aliases, summary):
        self.asked.append((title, aliases, summary))
        return list(self.same_idea)

    async def call(self, name, arguments, *, toolset=None, ctx=None) -> str:
        conversation: list[dict] = []
        call = {"name": name, "arguments": json.dumps(arguments), "call_id": "c1"}
        async for _ in (toolset or self.toolset).dispatch(call, ctx or self.ctx, self.budget, AnswerTrace(), conversation):
            pass
        return conversation[-1]["output"]

    async def open(self, *slugs) -> str:
        return await self.call("open_memory", {"slugs": list(slugs)})

    async def edit(self, operations, slug="position-encoding", **given) -> str:
        return await self.call("edit_memory", {
            "slug": slug, "operations": operations, "citations": [], "calculations": [],
            "summary": "", "aliases": [], "note": "added what paper A says", **given,
        })

    async def create(self, **given) -> str:
        return await self.call("create_memory", {
            "title": "Relative position bias", "aliases": [], "domain": "ml",
            "summary": "A learned bias on attention scores by offset.",
            "body": "## Relative position bias\n\nA bias indexed by offset is added to each score [N1].",
            "citations": [cite("N1", page=4)], "calculations": [],
            "note": "paper A introduces it", "distinctFrom": [], "distinctReason": "", **given,
        })

    def unchanged(self) -> bool:
        return fingerprint(self.root) == self.before


def op(kind, **given):
    return {"op": kind, "block": "", "blocks": [], "markdown": "", "find": "", "with": "", "reason": "", "evidence": [], **given}


def cite(ref, kind="author-claim", **given):
    return {"ref": ref, "claimType": kind, "paperId": "p1" if kind in {"author-claim", "reader-note"} else "",
            "page": 0, "section": "", "noteId": "", "evidenceId": "", **given}


NOT_STAGED = "Error: the edit to `position-encoding` was not staged. Fix each of these and call again:\n- "


@pytest.mark.asyncio
async def test_a_maintenance_run_is_shown_a_page_with_its_blocks_labelled_and_chat_is_shown_what_it_always_was(tmp_path):
    run = Run(tmp_path)
    shown = await run.open("ml/concept/position-encoding", "paper-a", "no-such-page")
    assert shown.startswith(
        "=== [[position-encoding]] ml/concept/position-encoding — Position encoding ===\n"
        "kind: concept · revision: 1\n"
        "summary: How order reaches a model.\n"
        '<block id="b1">\n## Position encoding\n</block>\n'
        '<block id="b2">\nSinusoidal encodings add a fixed signal to each token [E1].\n</block>\n'
    )
    assert '<block id="b6">\nAn open question: do learned tables extrapolate past the trained length?\n</block>\n' in shown
    assert (
        "Citations of this page:\n"
        "[E1] author-claim · paperId p1 · page 3\n"
        "[E2] author-claim · paperId p1 · page 5\n\n"
        "=== [[paper-a]] ml/source/paper-a — Paper A ===\nkind: source · revision: 1\n"
    ) in shown
    assert shown.endswith('<block id="b1">\nThe digest of paper A.\n</block>\nThis page has no citations.\n\nNo page exists at: no-such-page')
    # What was shown is what an edit will address, and what a commit will expect.
    page = run.draft.shown["position-encoding"]
    assert (page.body, page.revision, page.kind, page.domain) == (BODY, 1, "concept", "ml")
    assert [citation["id"] for citation in page.citations] == [1, 2]
    assert set(run.draft.shown) == {"position-encoding", "paper-a"}
    assert (await run.open("no-such-page")).startswith("Error: none of those pages exist.")

    # Chat's tool is the tool it was: the same arguments, the page as prose, and no draft to record in.
    for profile in profiles.CHAT_PROFILES:
        chat = profile.toolset(profiles.Turn(run.settings))
        ours = {tool.name: tool for tool in run.toolset.tools}["open_memory"]
        theirs = {tool.name: tool for tool in chat.tools}["open_memory"]
        assert theirs.spec["parameters"] == ours.spec["parameters"]
        assert "block" not in theirs.spec["description"] and "block" not in theirs.guidance
        ctx = ToolContext(settings=run.settings, username="reader", storage=run.storage, offered=chat.names)
        text = await run.call("open_memory", {"slugs": ["position-encoding"]}, toolset=chat, ctx=ctx)
        assert text == open_chosen_memory(["position-encoding"], run.storage, "reader", run.settings)[0]
        assert "<block" not in text and BODY.strip() in text
    assert run.unchanged()


@pytest.mark.asyncio
async def test_an_edit_is_staged_with_every_block_it_did_not_name_kept_byte_for_byte(tmp_path):
    run = Run(tmp_path)
    await run.open("position-encoding")
    said = await run.edit(
        [
            op("insert_after", block="b2", markdown="Rotary variants rotate each pair of dimensions [N1]; see [[rotary-embeddings]]."),
            op("replace_text", block="b6", find="An open question:", **{"with": "Still open [N2]:"}),
            op("delete", blocks=["b3"], reason="superseded", evidence=["N3"]),
        ],
        citations=[cite("N1", page=7), cite("N2", "derived"), cite("N3", paperId="w1", section="#method")],
        summary="How order reaches a model, and how the schemes differ.",
        aliases=["Positional embedding", "PE"],
        note="added rotary variants\nfrom paper A",
    )
    assert said == (
        "Staged the edit to `position-encoding` as read at revision 1: 3 operations, 778 to 761 characters. "
        "No longer cited, and dropped: [E2]. New citations: N1 is [E3], N2 is [E4]. "
        "1 of 2 pages staged. Nothing is stored until the run has ended and the page has been checked."
    )
    (page,) = run.draft.staged
    before = {block.id: block.text for block in split_blocks(BODY)}
    after = [block.text for block in split_blocks(page.body)]
    assert after == [
        before["b1"], before["b2"],
        "Rotary variants rotate each pair of dimensions [E3]; see [[rotary-embeddings]].\n\n",
        before["b4"], before["b5"],
        before["b6"].replace("An open question:", "Still open [E4]:"),
    ]
    assert (page.slug, page.action, page.revision, page.title, page.domain) == ("position-encoding", "edit", 1, "Position encoding", "ml")
    assert page.summary == "How order reaches a model, and how the schemes differ."
    assert page.aliases == ("Positional embedding", "PE") and page.note == "added rotary variants from paper A"
    assert [(citation["id"], citation["claimType"], citation["paperId"], citation["page"]) for citation in page.citations] == [
        (1, "author-claim", "p1", 3), (3, "author-claim", "p1", 7), (4, "derived", None, None),
    ]
    assert [(change.op, change.blocks, change.reason, change.evidence) for change in page.changes] == [
        ("insert_after", ("b2",), None, ()), ("replace_text", ("b6",), None, ()), ("delete", ("b3",), "superseded", ("N3",)),
    ]
    # The evidence for the delete is cited by no marker, so it is on no page: it is kept for the event.
    assert page.evidence == {"N3": {
        "claimType": "author-claim", "paperId": "w1", "page": None, "section": "Method", "noteId": None, "evidenceId": None,
    }}
    assert page.refs == {"N1": 3, "N2": 4} and page.repaired == ()
    assert run.unchanged()


@pytest.mark.asyncio
async def test_a_second_edit_of_a_page_addresses_it_as_shown_and_replaces_the_first(tmp_path):
    run = Run(tmp_path)
    await run.open("position-encoding")
    await run.edit([op("insert_after", block="b6", markdown="First thought.")])
    said = await run.edit([op("insert_after", block="b6", markdown="Second thought.")], note="a better line")
    assert said == (
        "Staged the edit to `position-encoding` as read at revision 1: 1 operation, 778 to 795 characters. "
        "This replaces what was staged for the page earlier in this run. "
        "1 of 2 pages staged. Nothing is stored until the run has ended and the page has been checked."
    )
    (page,) = run.draft.staged
    assert page.body == BODY + "\nSecond thought.\n" and page.note == "a better line"
    assert "First thought" not in page.body
    # Opening it again shows the stored page, and says an edit is waiting.
    assert (await run.open("position-encoding")).endswith(
        "An edit is already staged for position-encoding. What is shown is the page as stored, "
        "which is what another edit_memory call addresses and would replace that edit on."
    )
    assert run.unchanged()


@pytest.mark.asyncio
async def test_an_edit_is_refused_for_a_page_that_was_not_opened_or_is_not_a_concept(tmp_path):
    run = Run(tmp_path)
    assert await run.edit([op("insert_after", block="b1", markdown="More.")]) == (
        "Error: `position-encoding` has not been opened in this run; open it with open_memory, "
        "then address its blocks by the labels that shows."
    )
    await run.open("paper-a", "ml", "position-encoding")
    assert await run.edit([op("insert_after", block="b1", markdown="More.")], slug="paper-a") == (
        "Error: `paper-a` is a source page: a source page is its document's digest and is never edited. "
        "Put what you have into a concept page."
    )
    assert await run.edit([op("insert_after", block="b1", markdown="More.")], slug="ml/domain/ml") == (
        "Error: `ml` is a domain page: a domain page is written by its own pass. Put what you have into a concept page."
    )
    assert await run.edit([]) == (
        "Error: The call changes nothing on `position-encoding`; give an operation, a new summary or a new alias."
    )
    assert run.draft.staged == () and run.unchanged()


@pytest.mark.asyncio
async def test_an_edit_is_refused_with_what_to_fix_and_nothing_is_staged(tmp_path):
    run = Run(tmp_path)
    await run.open("position-encoding")
    insert = op("insert_after", block="b2", markdown="Rotary variants [N1].")
    run.budget.write_calls = 100

    # The operations do not apply.
    assert await run.edit([op("replace", blocks=["b9"], markdown="New."), op("replace_text", block="b2", find="nowhere", **{"with": "x"})]) == (
        NOT_STAGED + "Operation 1 (replace) names b9, which the page does not have; its blocks are b1 to b6.\n"
        "- Operation 2 (replace_text): `find` does not occur in b2; copy the text exactly as the page shows it, "
        "or replace the whole block."
    )
    assert await run.edit([insert]) == (
        NOT_STAGED + "The new text cites [N1], and `citations` defines no N1; define it, or remove the marker."
    )
    # A citation outside the evidence set, or the wrong shape for its type.
    assert await run.edit([insert], citations=[cite("N1", paperId="p9", page=2)]) == (
        NOT_STAGED + "Citation N1 names the document 'p9', which is not in this run's evidence; "
        "cite only what the evidence lists: p1, w1."
    )
    assert await run.edit([insert], citations=[cite("N1", page=40)]) == (
        NOT_STAGED + "Citation N1 cites page 40 of 'Paper A', which has pages 1 to 12."
    )
    assert await run.edit([insert], citations=[cite("N1")]) == (
        NOT_STAGED + "Citation N1 cites page none of 'Paper A', which has pages 1 to 12."
    )
    assert await run.edit([insert], citations=[cite("N1", paperId="w1", section="results")]) == (
        NOT_STAGED + "Citation N1 cites section 'results' of 'Saved page', which has no such section; "
        "its sections are: intro, Method."
    )
    assert await run.edit([insert], citations=[cite("N1", "derived", paperId="p1", page=2)]) == (
        NOT_STAGED + "Citation N1 is derived, which is Delphi's own inference, and names a source (paperId, page); "
        "leave those empty, or give the claim type of what the source says."
    )
    assert await run.edit([insert], citations=[cite("N1", "reader-note", noteId="n7")]) == (
        NOT_STAGED + "Citation N1 cites note 'n7' of 'Paper A', which is not a note the reader wrote on it."
    )
    assert await run.edit([insert], citations=[cite("N1", "external", evidenceId="p1", section="s1")]) == (
        NOT_STAGED + "Citation N1 names the outside source 'p1', which is not in this run's evidence; "
        "cite only what the evidence lists: x1."
    )
    assert await run.edit([insert], citations=[cite("N1", "external")]) == (
        NOT_STAGED + "Citation N1 is external and names no outside source; give its `evidenceId`."
    )
    # Detail may not vanish quietly.
    assert await run.edit([op("replace", blocks=["b3"], markdown="Learned encodings are a table of vectors.")]) == (
        NOT_STAGED + "Operation 1 (replace) on b3 removes [E2], [[attention]], [[old-idea]] and states no `reason`; "
        "keep what is there, or give one of superseded, contradicted, duplicate, off-topic, moved, withdrawn."
    )
    assert await run.edit([op("delete", blocks=["b3"], reason="contradicted", evidence=["N4"])]) == (
        NOT_STAGED + "Operation 1 (delete) on b3 names N4 as evidence, which is neither a citation this edit "
        "defines nor one the page has."
    )
    # A derived number is recomputed.
    sums = [{"expression": "heads * width", "result": 500.0, "unit": "", "inputs": [
        {"name": "heads", "value": 8, "unit": "", "citation": "E1"},
        {"name": "width", "value": 64, "unit": "", "citation": "N1"},
    ]}]
    assert await run.edit([insert], citations=[cite("N1", page=2)], calculations=sums) == (
        NOT_STAGED + "Calculation 1 (`heads * width`) comes to 512 with the inputs given, and the result stated is 500; "
        "correct the result, the expression or the inputs."
    )
    # The shape of the result, and more than one thing at once.
    assert await run.edit(
        [op("insert_after", block="b6", markdown="See https://example.org/rope for $\\alpha"), op("delete", blocks=["b2"])],
        note=" ",
    ) == (
        NOT_STAGED + "The call has no `note`; say in one line what this write does to the page.\n"
        "- Operation 2 (delete) on b2 removes [E1] and states no `reason`; keep what is there, or give one of "
        "superseded, contradicted, duplicate, off-topic, moved, withdrawn.\n"
        "- The body contains a URL (https://example.org/rope); a page names its sources through citations, "
        "never an address. Remove it.\n"
        "- The body's LaTeX is malformed (unclosed $): close every $, write Greek letters as commands such as "
        "\\alpha, and leave no literal \\n inside maths."
    )
    assert await run.edit([op("insert_after", block="b6", markdown="x" * 12_000)]) == (
        NOT_STAGED + "The page body would be 12,780 characters, and a page is about 8,000. "
        "Add less, and never shorten what the page already says to make room: what does not fit "
        "belongs on the page for the narrower idea it is about, linked from this one."
    )
    assert await run.edit([], aliases=["attention"]) == (
        NOT_STAGED + "'attention' is already the page [[attention]] (Attention), by its title or an alias. "
        "Open that page and edit it; a second page for the same name is never created."
    )
    # Arguments the schema refuses never reach the tool, and say so.
    assert (await run.edit([op("delete", blocks=["b3"], reason="tidier")])).startswith(
        "Error: edit_memory cannot use these arguments. `operations.0.reason`:"
    )
    assert run.draft.staged == () and run.unchanged()


@pytest.mark.asyncio
async def test_a_move_keeps_its_citations_and_states_no_loss(tmp_path):
    run = Run(tmp_path)
    await run.open("position-encoding")
    moved = "Learned encodings [E2] are a table of vectors; see [[attention]] and [[old-idea|the old idea]]."
    said = await run.edit([op("delete", blocks=["b3"], reason="moved"), op("insert_after", block="b5", markdown=moved)])
    assert said.startswith("Staged the edit to `position-encoding` as read at revision 1: 2 operations, 778 to 778 characters.")
    (page,) = run.draft.staged
    assert [citation["id"] for citation in page.citations] == [1, 2]
    # The link with no page behind it was the page's own, in text the edit carried over: it is left as it was.
    assert "[[old-idea|the old idea]]" in page.body and page.repaired == ()


@pytest.mark.asyncio
async def test_a_link_with_no_page_behind_it_is_written_as_words_and_the_agent_is_told(tmp_path):
    run = Run(tmp_path)
    await run.open("position-encoding")
    said = await run.edit([op(
        "insert_after", block="b4",
        markdown="Compare [[rotary-embeddings]], [[Relative Position Bias]] and [[t5-bias|the T5 bias]]; index with `m[[0]]`.",
    )])
    assert said == (
        "Staged the edit to `position-encoding` as read at revision 1: 1 operation, 778 to 871 characters. "
        "No page exists for [[relative-position-bias]], [[t5-bias]], so each was written as plain words, not a link. "
        "If a link is wanted, create that page first and make this call again. "
        "1 of 2 pages staged. Nothing is stored until the run has ended and the page has been checked."
    )
    (page,) = run.draft.staged
    assert "Compare [[rotary-embeddings]], Relative Position Bias and the T5 bias; index with `m[[0]]`." in page.body
    assert page.repaired == ("relative-position-bias", "t5-bias")
    # Blocks the edit did not name keep even a link that leads nowhere, and code is never read as a link.
    assert "[[old-idea|the old idea]]" in page.body and "row = table[[0]]" in page.body

    # A page this run creates is a page a link may name, in the same commit.
    assert (await run.create()).startswith("Staged the new concept page `relative-position-bias`")
    said = await run.edit([op("insert_after", block="b4", markdown="Compare [[Relative Position Bias]].")])
    assert "No page exists" not in said and "This replaces what was staged" in said
    assert "Compare [[Relative Position Bias]]." in run.draft.staged_page("position-encoding").body
    assert run.unchanged()


@pytest.mark.asyncio
async def test_an_edit_is_not_refused_for_a_defect_the_page_already_had(tmp_path):
    run = Run(tmp_path)
    await run.open("legacy-page")
    # The address was there before this run; the edit names another block and is not made to fix it.
    said = await run.edit([op("insert_after", block="b2", markdown="A third paragraph.")], slug="legacy-page")
    assert said.startswith("Staged the edit to `legacy-page` as read at revision 1: 1 operation, 81 to 101 characters.")
    assert run.draft.staged_page("legacy-page").body.startswith("An old page that names https://example.org/old in its text.\n\n")
    # One it adds is its own.
    assert await run.edit([op("insert_after", block="b2", markdown="See https://example.org/new too.")], slug="legacy-page") == (
        "Error: the edit to `legacy-page` was not staged. Fix each of these and call again:\n"
        "- The body contains a URL (https://example.org/new); a page names its sources through citations, "
        "never an address. Remove it."
    )


@pytest.mark.asyncio
async def test_a_run_stages_no_more_pages_than_it_may(tmp_path):
    run = Run(tmp_path, max_pages=1)
    await run.open("position-encoding", "attention")
    assert (await run.edit([op("insert_after", block="b1", markdown="More.")], slug="attention")).startswith("Staged the edit to `attention`")
    full = "Error: This run has staged `attention`, and 1 page is the most one run may write. Change one of those, or leave `{}` for a later run and say so when you finish."
    assert await run.edit([op("insert_after", block="b6", markdown="More.")]) == full.format("position-encoding")
    assert await run.create() == full.format("relative-position-bias")
    assert run.asked == []
    # The page that is staged may still be changed.
    assert "This replaces what was staged" in await run.edit([op("insert_after", block="b1", markdown="Other.")], slug="attention")
    assert [page.slug for page in run.draft.staged] == ["attention"]

    # Write calls are counted apart from reads, and run out on their own.
    assert (run.budget.write_calls, run.budget.write_calls_made, run.budget.memory_calls_made) == (4, 4, 1)
    assert await run.edit([op("insert_after", block="b1", markdown="Again.")], slug="attention") == WRITE_CALLS_SPENT
    assert (await run.open("attention")).startswith("=== [[attention]]")
    assert run.toolset.round_fields(run.budget, closing=False)["tool_choice"]["tools"] == [
        {"type": "function", "name": name} for name in ("open_memory", "grep_memory", "memory_links")
    ]
    assert run.unchanged()


@pytest.mark.asyncio
async def test_a_page_is_not_created_under_a_name_another_page_has(tmp_path):
    run = Run(tmp_path, same_idea=["rotary-embeddings"])
    taken = "Error: {} is already the page [[{}]] ({}), by its title or an alias. Open that page and edit it; a second page for the same name is never created."
    assert await run.create(title="Position  Encoding!") == taken.format("'Position Encoding!'", "position-encoding", "Position encoding")
    assert await run.create(title="pe") == taken.format("'pe'", "position-encoding", "Position encoding")
    assert await run.create(aliases=["RoPE", "positional-encoding"]) == taken.format("'positional-encoding'", "position-encoding", "Position encoding")
    # There is no override: saying it is distinct changes nothing.
    assert await run.create(title="Attention", distinctFrom=["attention"], distinctReason="It is not.") == taken.format("'Attention'", "attention", "Attention")
    assert await run.create(title="?!") == "Error: A page needs a title of letters or digits, at most 200 characters."
    # None of those asked a model anything.
    assert run.asked == [] and run.draft.staged == () and run.unchanged()


@pytest.mark.asyncio
async def test_a_page_whose_idea_may_already_have_a_page_is_refused_until_the_agent_says_why_it_differs(tmp_path):
    run = Run(tmp_path, same_idea=["rotary-embeddings", "attention", "paper-a", "never-existed"])
    refusal = (
        "Error: These pages may already explain this idea: [[rotary-embeddings]] (Rotary embeddings), [[attention]] (Attention). "
        "Open them with open_memory and edit the one that does. If this is a different idea, call create_memory again "
        "with every one of them in `distinctFrom` and one sentence in `distinctReason` saying how it differs."
    )
    assert await run.create() == refusal
    assert run.asked == [("Relative position bias", [], "A learned bias on attention scores by offset.")]
    # Naming some of them, or giving no reason, is not an answer.
    assert await run.create(distinctFrom=["rotary-embeddings"], distinctReason="A bias, not a rotation.") == refusal
    assert await run.create(distinctFrom=["rotary-embeddings", "attention"]) == refusal
    assert run.draft.staged == ()
    said = await run.create(
        distinctFrom=["attention", "ml/concept/rotary-embeddings", "never-existed"],
        distinctReason="It adds a learned bias to scores;\nrotary embeddings rotate the vectors themselves.",
    )
    assert said == (
        "Staged the new concept page `relative-position-bias` (Relative position bias) in ml: 80 characters. "
        "New citations: N1 is [E1]. "
        "1 of 2 pages staged. Nothing is stored until the run has ended and the page has been checked."
    )
    # The check is asked once for a page in a run: a second answer could contradict the first.
    assert len(run.asked) == 1
    (page,) = run.draft.staged
    assert (page.slug, page.action, page.revision, page.domain) == ("relative-position-bias", "create", 0, "ml")
    assert page.body == "## Relative position bias\n\nA bias indexed by offset is added to each score [E1]."
    assert page.citations == ({"id": 1, "claimType": "author-claim", "paperId": "p1", "page": 4, "section": None, "noteId": None, "evidenceId": None},)
    assert page.distinct_from == ("attention", "rotary-embeddings")
    assert page.distinct_reason == "It adds a learned bias to scores; rotary embeddings rotate the vectors themselves."
    # A page being created is not a page to edit, and its name is taken for the rest of the run.
    assert await run.edit([op("insert_after", block="b1", markdown="More.")], slug="relative-position-bias") == (
        "Error: `relative-position-bias` is a page this run is creating, so there is no stored page to edit; "
        "to change it, call create_memory again with the whole page."
    )
    assert await run.create(title="T5 bias", aliases=["relative position bias"]) == (
        "Error: 'relative position bias' is already the page [[relative-position-bias]] (Relative position bias), "
        "by its title or an alias. Open that page and edit it; a second page for the same name is never created."
    )
    assert run.unchanged()


@pytest.mark.asyncio
async def test_a_new_page_passes_the_checks_an_edit_does_and_a_second_call_replaces_the_first(tmp_path):
    run = Run(tmp_path)
    created = "Error: the new page `relative-position-bias` was not staged. Fix each of these and call again:\n- "
    assert await run.create(body="A bias [N2] at https://example.org; <block id=\"b1\">", summary=" ", domain="!") == (
        created + "The page has no `summary`; say in a sentence or two what the page explains.\n"
        "- The page names no `domain`; give the domain it belongs to, as the index spells it.\n"
        "- The body includes a <block> tag; write the Markdown alone, without the labels."
    )
    assert await run.create(body="A bias [N2] and [E1].") == (
        created + "The new text cites [N2], and `citations` defines no N2; define it, or remove the marker.\n"
        "- The new text cites [E1], which is not one of this page's citations; cite evidence the page does not "
        "have yet as [N1], [N2], … and define each in `citations`."
    )
    assert await run.create(citations=[cite("N1", page=99)], body="See http://example.org [N1].") == (
        created + "Citation N1 cites page 99 of 'Paper A', which has pages 1 to 12.\n"
        "- The body contains a URL (http://example.org); a page names its sources through citations, never an address. Remove it."
    )
    assert await run.create(body="  ") == created + "The page has no `body`."
    assert run.draft.staged == ()
    assert len(run.asked) == 1

    body = "A bias by offset [N1]; unlike [[rotary-embeddings]] and [[no-such-idea]]. It needs 2 * 32 - 1 = 63 entries [N2]."
    sums = [{"expression": "2 * n - 1", "result": 63, "unit": "entries", "inputs": [{"name": "n", "value": 32, "unit": "", "citation": "N1"}]}]
    first = await run.create(aliases=["T5 bias", "t5-bias", "Relative position bias"])
    assert "This replaces" not in first
    said = await run.create(body=body, citations=[cite("N2", "derived"), cite("N1", paperId="w1", section="METHOD")], calculations=sums, aliases=["T5 bias"])
    assert said == (
        "Staged the new concept page `relative-position-bias` (Relative position bias) in ml: 108 characters. "
        "New citations: N1 is [E1], N2 is [E2]. "
        "No page exists for [[no-such-idea]], so each was written as plain words, not a link. "
        "If a link is wanted, create that page first and make this call again. "
        "This replaces what was staged for the page earlier in this run. "
        "1 of 2 pages staged. Nothing is stored until the run has ended and the page has been checked."
    )
    (page,) = run.draft.staged
    assert page.body == "A bias by offset [E1]; unlike [[rotary-embeddings]] and no such idea. It needs 2 * 32 - 1 = 63 entries [E2]."
    assert page.aliases == ("T5 bias",) and page.calculations == tuple(sums)
    assert [(citation["id"], citation["claimType"], citation["paperId"], citation["section"]) for citation in page.citations] == [
        (1, "author-claim", "w1", "Method"), (2, "derived", None, None),
    ]
    assert len(run.asked) == 1 and run.unchanged()


@pytest.mark.asyncio
async def test_a_turn_with_no_draft_cannot_write_whatever_its_toolset_holds(tmp_path):
    run = Run(tmp_path)
    await run.open("position-encoding")
    chat = ToolContext(settings=run.settings, username="reader", storage=run.storage, offered=run.toolset.names)
    for name, arguments in (
        ("edit_memory", {"slug": "position-encoding"}),
        ("create_memory", {"title": "Anything"}),
        ("open_memory", {"slugs": ["position-encoding"]}),
    ):
        said = await run.call(name, arguments, ctx=chat)
        assert said.startswith(f"Error: '{name}' is not a tool this conversation offers."), said
    # And a chat toolset does not hold them at all: the offered set is the allowlist.
    for profile in profiles.CHAT_PROFILES:
        toolset = profile.toolset(profiles.Turn(run.settings, web=True, web_documents=True, companion_pdfs=True))
        assert not {"edit_memory", "create_memory"} & toolset.names
        assert (await run.call("edit_memory", {"slug": "position-encoding"}, toolset=toolset)).startswith(
            "Error: 'edit_memory' is not a tool this conversation offers."
        )
    assert run.draft.staged == () and run.unchanged()


def test_a_maintenance_budget_has_writes_to_spend_and_a_chat_budget_has_none():
    settings = Settings(_env_file=None)
    maintain, chat = TurnBudget.for_maintenance(settings), TurnBudget.for_chat(settings)
    assert (maintain.rounds, maintain.memory_calls, maintain.staged_pages, maintain.write_calls) == (12, 16, 2, 8)
    assert (maintain.document_calls, maintain.figure_views, maintain.hosted_calls) == (0, 0, 0)
    assert (chat.write_calls, chat.staged_pages) == (0, 0)
    assert MemoryDraft(max_pages=maintain.staged_pages).max_pages == 2
