import io
import json

import pytest
from PIL import Image, ImageDraw

from delphi_core.config import Settings
from delphi_core.memory import (
    MEMORY_PAGE_SUMMARY_MAX_LENGTH,
    MEMORY_PAGE_BODY_MAX_LENGTH,
    usable_printed_caption,
    audit_schema,
)
from delphi_core.pdf_figures import detect_qr_or_barcode
from delphi_core.storage import LocalObjectStore, LocalStorage

pytestmark = pytest.mark.kb_maintenance


def test_architecture_diagram_box_patterns_are_not_a_qr_code():
    diagram = Image.new("RGB", (420, 220), "white")
    draw = ImageDraw.Draw(diagram)
    colors = ("#d8e8ff", "#dff3df", "#ffe2c5", "#eadcff")
    for index, left in enumerate((20, 125, 230, 335)):
        draw.rounded_rectangle(
            (left, 70, left + 65, 145),
            radius=8,
            fill=colors[index],
            outline="black",
            width=3,
        )
        draw.rectangle((left + 12, 87, left + 52, 128), outline="black", width=4)
        if index:
            draw.line((left - 38, 107, left, 107), fill="black", width=4)
    # Repeated nested boxes and connectors produce finder-like scan lines, but
    # not three clustered finder squares in an L arrangement.
    assert not detect_qr_or_barcode(diagram)


def test_the_filing_pass_does_not_inherit_the_orchestrators_effort():
    """
    Lint, re-filing and domain composition run at their own effort and not at
    the orchestrator's. An operator pinning MEMORY_REVIEW_REASONING_EFFORT still wins.
    """
    settings = Settings(
        orchestrator_reasoning_effort="xhigh", digest_reasoning_effort=""
    )
    assert settings.memory_review_reasoning_effort == "medium"
    assert settings.digest_reasoning_effort == "medium"
    # An operator who pins it still wins.
    pinned = Settings(memory_review_reasoning_effort="xhigh")
    assert pinned.memory_review_reasoning_effort == "xhigh"


# --- the two-call document path: what a failed attempt is allowed to cost ---


def test_a_printed_caption_is_used_only_where_extraction_left_it_intact():
    """PDF extraction damages captions, and a damaged one loses the document.

    It truncates at whatever the crop covered and drops the space at a line
    break, so the strings that arrive read "Overview of PiD.PiD unifies latent
    decoding..." and "of theTunaarchitecture. Our model employs...". Committed
    under a picture, that is what the independent verifier rejects -- and it
    rejects the whole document with it. Six of fourteen rejections in a
    measured run were exactly this.
    """
    # Trimming to the last sentence that closes recovers a real caption.
    assert (
        usable_printed_caption(
            "3:Overview of PiD.PiD unifies latent decoding and upsampling as a"
        )
        == "Overview of PiD."
    )
    assert (
        usable_printed_caption("Dynamic of Training Loss. (a) Comparing the training")
        == "Dynamic of Training Loss."
    )
    assert (
        usable_printed_caption("Confronting vs. bypassing uncertainty. (a) AR or-")
        == "Confronting vs. bypassing uncertainty."
    )

    # A caption that begins mid-phrase is the tail of one cut earlier, and a
    # caption that never closes a sentence was truncated outright. Both fall
    # back to the model's own sentence, which is always well formed.
    assert usable_printed_caption("of theTunaarchitecture. Our model employs a") == ""
    assert usable_printed_caption("Pareto frontier of validation loss versus") == ""
    # A bare figure number carries nothing once the number is stripped.
    assert usable_printed_caption("Figure 2.") == ""
    assert usable_printed_caption("") == ""


def test_a_summary_budget_is_not_spelled_as_a_decoder_wall():
    """The body learned this once; the summary was left at 400 and repeated it.

    A budget spelled as the schema's `maxLength` is a wall: a model writing to
    it has its string force-closed mid-generation, so the page arrives
    truncated rather than merely long. Two summaries in a measured run ended
    "and an--" and "The evidence is strongest for the tested image", and each
    cost the document a whole two-call attempt over a defect that was never the
    model's judgement.
    """
    from delphi_core.memory import (
        MEMORY_PAGE_SUMMARY_BUDGET,
        MEMORY_PAGE_SUMMARY_MAX_LENGTH,
        trim_to_sentence,
    )

    # The wall sits far above the ask, so the decoder never closes on it.
    assert MEMORY_PAGE_SUMMARY_MAX_LENGTH > MEMORY_PAGE_SUMMARY_BUDGET * 3

    # Over budget is trimmed at a sentence, never mid-word: the length of a
    # card subtitle is Delphi's bookkeeping, not a claim about a source.
    assert trim_to_sentence("First one. Second one runs long.", 15) == "First one."
    assert trim_to_sentence("Already short.", 400) == "Already short."
    # A first sentence longer than the budget is left whole -- half a sentence
    # is worse than a long one.
    assert trim_to_sentence("One long clause with no terminator", 10) == (
        "One long clause with no terminator"
    )


def test_control_characters_are_stripped_from_a_rendered_document_body():
    """`\\x07hat` reached a committed page and the verifier rejected it.

    The strip named `body`, and the document render model names its body
    `bodyMarkdown` -- so the one path that actually files documents was the one
    path it did not cover.
    """
    from delphi_core.memory import strip_control_characters

    assert strip_control_characters("\x07hat y_1") == "hat y_1"
    assert strip_control_characters("clean") == "clean"


def test_a_synced_folders_conflict_copy_is_not_a_second_page(tmp_path):
    # macOS iCloud Drive resolves a conflict on a file it is mid-upload by
    # keeping both under a " 2" suffix, and `_write_atomic`'s `os.replace` is
    # exactly that conflict. A real staging run under a synced Desktop grew
    # three files for one slug, each with its own id, and the directory walk
    # reported them as three pages — one of which then had no page at all,
    # because the next write found no file where it looked and minted a
    # fourth. A page is named for its own slug; the copy is not ours.
    settings = Settings(data_dir=tmp_path)
    storage = LocalStorage(settings)
    storage.create_account("ada", None, "salt", "hash")
    storage.upsert_memory_page(
        "ada",
        {"slug": "flow-matching", "title": "Flow Matching", "kind": "concept"},
        max_pages=100,
    )
    pages = storage.list_memory_pages("ada")
    assert [page["slug"] for page in pages] == ["flow-matching"]

    directory = tmp_path / "users" / "ada" / "memory" / "pages"
    stranded = json.loads((directory / "flow-matching.json").read_text())
    stranded["id"] = "0" * 24
    (directory / "flow-matching 2.json").write_text(json.dumps(stranded))

    assert [page["slug"] for page in storage.list_memory_pages("ada")] == [
        "flow-matching"
    ]


# ---------------------------------------------------------------------------
# The source page is the digest.
# ---------------------------------------------------------------------------


def _digest(content="What the paper established. [E1]", assets=(), citations=None):
    return {
        "contentMarkdown": content,
        "citations": citations
        if citations is not None
        else [
            {"id": 1, "claimType": "author-claim", "page": 3, "section": None},
        ],
        "assets": list(assets),
    }


def _account(tmp_path):
    settings = Settings(data_dir=tmp_path)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    return settings, storage


def test_one_documents_page_is_never_written_over_by_another(tmp_path):
    """The failure this replaced, in the shape it actually happened.

    A `done` filing chose `pid-generative-latent-decoding` for its own source
    page -- a slug that already belonged to a different paper. Pages upsert by
    slug, so it overwrote that paper's prose and took its `sourcePaperId`, and
    the robbed document ended with no page of its own. Nothing chooses now, so
    the collision resolves instead of happening.
    """
    from delphi_core.memory import source_page_slug

    settings, storage = _account(tmp_path)
    storage.upsert_memory_page(
        "reader",
        {
            "slug": "generative-latent-decoding",
            "kind": "source",
            "domain": "ml",
            "title": "Generative Latent Decoding",
            "body": "The first paper's own page.",
            "sourcePaperId": "paper-one",
        },
        max_pages=100,
    )

    intruder = {"id": "paper-two", "title": "Generative Latent Decoding"}
    slug = source_page_slug(storage, "reader", intruder, settings)

    assert slug != "generative-latent-decoding"
    assert "paper-two" in slug
    # And the page it would have taken is untouched.
    held = storage.get_memory_page("reader", "generative-latent-decoding")
    assert held["sourcePaperId"] == "paper-one"
    assert held["body"] == "The first paper's own page."


def test_a_document_keeps_one_page_however_many_newer_pages_bury_it(tmp_path):
    """`lingbot-va2` and `lingbot-va2-source` were one document's two pages.

    The reuse lookup read a 200-row recency window, so the page a later pass
    should have revised had sunk out of sight and it wrote a second.
    Provenance is exact and does not sink.
    """
    from delphi_core.memory import source_page_slug

    settings, storage = _account(tmp_path)
    paper = {"id": "paper-one", "title": "LingBot-VA 2.0"}

    first = source_page_slug(storage, "reader", paper, settings)
    storage.upsert_memory_page(
        "reader",
        {
            "slug": first,
            "kind": "source",
            "domain": "ml",
            "title": "LingBot-VA 2.0",
            "body": "Filed when the document was added.",
            "sourcePaperId": "paper-one",
        },
        max_pages=100,
    )
    # Bury it under newer pages, exactly as a library-wide filing run does.
    for index in range(5):
        storage.upsert_memory_page(
            "reader",
            {
                "slug": f"later-page-{index}",
                "kind": "concept",
                "domain": "ml",
                "title": f"Later {index}",
                "body": "Something else entirely.",
            },
            max_pages=100,
        )

    assert source_page_slug(storage, "reader", paper, settings) == first
    assert (
        len([page for page in storage.list_memory_pages("reader") if page["kind"] == "source"])
        == 1
    )


def test_a_page_nothing_claims_is_still_somebody_elses_page(tmp_path):
    """An unclaimed slug is not a free one.

    The occupied-slug test above seeds a page owned by another paper, which
    passes through the branch the bug was never in. The dangerous occupant is
    the one holding no `sourcePaperId` at all: a domain page, whose slug *is* its
    domain name, so a document titled like a domain would have rewritten that
    domain's heading into a source page and taken its provenance. A page holding
    *this* paper's id but some other kind is the same mistake wearing a
    different hat -- the concept page loses its prose.
    """
    from delphi_core.memory import source_page_slug

    settings, storage = _account(tmp_path)
    storage.upsert_memory_page(
        "reader",
        {
            "slug": "robotics",
            "kind": "domain",
            "domain": "robotics",
            "title": "Robotics",
            "body": "What this domain is about.",
        },
        max_pages=100,
    )
    storage.upsert_memory_page(
        "reader",
        {
            "slug": "inverse-dynamics",
            "kind": "concept",
            "domain": "robotics",
            "title": "Inverse Dynamics",
            "body": "A concept this same paper taught.",
            "sourcePaperId": "paper-one",
        },
        max_pages=100,
    )

    domain_taker = {"id": "paper-two", "title": "Robotics"}
    assert source_page_slug(storage, "reader", domain_taker, settings) != "robotics"
    own_concept = {"id": "paper-one", "title": "Inverse Dynamics"}
    assert (
        source_page_slug(storage, "reader", own_concept, settings)
        != "inverse-dynamics"
    )

    domain_page = storage.get_memory_page("reader", "robotics")
    assert domain_page["kind"] == "domain"
    assert domain_page["body"] == "What this domain is about."
    assert domain_page.get("sourcePaperId") is None
    concept = storage.get_memory_page("reader", "inverse-dynamics")
    assert concept["kind"] == "concept"
    assert concept["body"] == "A concept this same paper taught."


def test_a_page_filed_under_an_older_slug_is_revised_not_orphaned(tmp_path):
    """Provenance wins over the title, so a refile keeps every link into it."""
    from delphi_core.memory import source_page_slug

    settings, storage = _account(tmp_path)
    storage.upsert_memory_page(
        "reader",
        {
            "slug": "mdlm-paper",
            "kind": "source",
            "domain": "ml",
            "title": "MDLM",
            "body": "Written by a superseded pass.",
            "sourcePaperId": "doc1",
        },
        max_pages=100,
    )

    assert (
        source_page_slug(storage, "reader", {"id": "doc1", "title": "MDLM"}, settings)
        == "mdlm-paper"
    )


@pytest.mark.asyncio
async def test_a_long_evidence_index_survives_the_page_it_becomes(tmp_path):
    """Forty markers, forty citations -- not the first twenty-four.

    A digest may index 64 pieces of evidence; the page model capped citations
    at 24 and `_digest_citations` sliced to fit. Five of one real library's
    forty-seven source pages published prose citing `[E25]` and up against a
    list that stopped at `[E24]` -- forty-eight markers pointing at nothing.
    The §36a strip that then removed an undefined marker could not save them:
    it ran on the model's own output, before the slice that created the problem.
    """
    from delphi_core.memory import source_page_from_digest

    settings, storage = _account(tmp_path)
    objects = LocalObjectStore(tmp_path)
    marks = " ".join(f"Claim {index} holds. [E{index}]" for index in range(1, 41))
    digest = _digest(
        content=marks,
        citations=[
            {
                "id": index,
                "claimType": "author-claim" if index % 2 else "digest-inference",
                "page": index,
                "section": None,
            }
            for index in range(1, 41)
        ],
    )

    page, _ = await source_page_from_digest(
        objects,
        storage,
        "reader",
        "project-one",
        {"id": "doc1", "title": "Forty Claims"},
        digest,
        settings,
        slug="forty-claims",
        domain="ml",
    )

    assert len(page.citations) == 40
    assert [item.id for item in page.citations] == list(range(1, 41))
    assert every_marker_is_cited(page)


@pytest.mark.asyncio
async def test_the_source_page_is_the_digest_with_its_evidence_intact(tmp_path):
    """Body, citations and markers survive; the summary is derived, not asked for.

    Carrying the citations is not bookkeeping: a body copied without them
    would publish every `[E<n>]` pointing at nothing -- and a digest cites
    `digest-inference`, which is not a claim type a page knows.
    """
    from delphi_core.memory import source_page_from_digest

    settings, storage = _account(tmp_path)
    objects = LocalObjectStore(tmp_path)
    digest = _digest(
        content="Masked diffusion trains without a causal mask [E1], and it "
        "beats the autoregressive baseline on perplexity [E2].",
        citations=[
            {"id": 1, "claimType": "author-claim", "page": 3, "section": None},
            {"id": 2, "claimType": "digest-inference", "page": 7, "section": None},
        ],
    )

    page, figures = await source_page_from_digest(
        objects,
        storage,
        "reader",
        "project-one",
        {"id": "doc1", "title": "MDLM"},
        digest,
        settings,
        slug="mdlm",
        domain="ml",
    )

    assert page.kind == "source"
    assert page.bodyMarkdown == digest["contentMarkdown"]
    assert page.title == "MDLM"
    assert [(item.id, item.claimType, item.page) for item in page.citations] == [
        (1, "author-claim", 3),
        # The digest's own inference is Delphi's on the page, and names no source.
        (2, "derived", None),
    ]
    assert page.citations[1].paperId is None and page.citations[0].paperId == "doc1"
    assert every_marker_is_cited(page)
    assert page.summary and len(page.summary) <= MEMORY_PAGE_SUMMARY_MAX_LENGTH
    assert figures == []


def every_marker_is_cited(page) -> bool:
    import re

    cited = {item.id for item in page.citations}
    return all(
        int(marker) in cited for marker in re.findall(r"\[E(\d+)\]", page.bodyMarkdown)
    )


@pytest.mark.asyncio
async def test_a_digest_asset_becomes_a_figure_with_bytes_before_its_row(tmp_path):
    """A digest's pictures are the source page's pictures.

    Digest assets are object bytes with no row; `memory_figures` is a table.
    Without this step every figure would vanish, because digest markdown carries
    no embeds at all -- `validate_digest` strips them, and the reader's digest
    view places assets out of band. A page has no out-of-band channel.
    """
    from delphi_core.memory import source_page_from_digest
    from delphi_core.research_digest import digest_asset_key

    settings, storage = _account(tmp_path)
    objects = LocalObjectStore(tmp_path)
    image = io.BytesIO()
    Image.new("RGB", (24, 12), "white").save(image, format="WEBP")
    asset_path = tmp_path / "asset.webp"
    asset_path.write_bytes(image.getvalue())
    objects.put_file(
        digest_asset_key("reader", "project-one", "doc1", "asset-1", "image/webp"),
        asset_path,
        "image/webp",
    )

    page, figures = await source_page_from_digest(
        objects,
        storage,
        "reader",
        "project-one",
        {"id": "doc1", "title": "MDLM"},
        _digest(
            content="First paragraph. [E1]\n\nSecond paragraph.",
            assets=[
                {
                    "id": "asset-1",
                    "inventoryId": "pdf-figure-1",
                    "caption": "The architecture, end to end.",
                    "alt": "Architecture diagram",
                    "teachingValue": "Shows the whole pipeline.",
                    "afterEvidenceId": 1,
                    "kind": "source-figure",
                    "page": 3,
                    "mimeType": "image/webp",
                    "width": 24,
                    "height": 12,
                    "bytes": len(image.getvalue()),
                }
            ],
        ),
        settings,
        slug="mdlm",
        domain="ml",
    )

    assert len(figures) == 1
    figure = figures[0]
    assert figure["pageSlug"] == "mdlm"
    assert figure["kind"] == "source-figure"
    # Bytes before the record, so a row never points at pixels nobody wrote.
    assert objects.exists(figure["objectKey"])
    # And the prose carries the embed, addressed the way the renderer resolves
    # it -- by figure id, after the paragraph the digest placed it under.
    assert f"](figure:{figure['id']})" in page.bodyMarkdown
    assert page.bodyMarkdown.index("figure:") < page.bodyMarkdown.index("Second paragraph")


@pytest.mark.asyncio
async def test_an_asset_whose_bytes_are_gone_costs_a_picture_not_the_page(tmp_path):
    from delphi_core.memory import source_page_from_digest

    settings, storage = _account(tmp_path)
    objects = LocalObjectStore(tmp_path)

    page, figures = await source_page_from_digest(
        objects,
        storage,
        "reader",
        "project-one",
        {"id": "doc1", "title": "MDLM"},
        _digest(
            assets=[
                {
                    "id": "missing",
                    "inventoryId": "pdf-figure-1",
                    "caption": "Never captured.",
                    "alt": "Nothing",
                    "afterEvidenceId": 1,
                    "kind": "source-figure",
                    "page": 3,
                    "mimeType": "image/webp",
                }
            ]
        ),
        settings,
        slug="mdlm",
        domain="ml",
    )

    assert figures == []
    assert "figure:" not in page.bodyMarkdown
    assert page.bodyMarkdown


@pytest.mark.parametrize(
    "body,expected",
    [
        ("## Problem\n\nIt trains without a causal mask.", "It trains without a causal mask."),
        ("| a | b |\n|---|---|\n\nThe table shows the ablation.", "The table shows the ablation."),
        ("```python\nx = 1\n```\n\nThe snippet defines the loss.", "The snippet defines the loss."),
        ("It trains without a causal mask.\n\n## Later", "It trains without a causal mask."),
    ],
)
def test_a_page_summary_is_prose_not_the_structure_above_it(body, expected):
    """A summary is a card subtitle, and a digest opens with structure.

    Trimming the raw body put "## Problem" — or a table rule, or a line of
    Python — at the top of every card in the wiki.
    """
    from delphi_core.memory import digest_lead_prose

    assert digest_lead_prose(body) == expected


def test_a_digest_that_is_all_structure_still_gets_a_summary(tmp_path):
    # Nothing to lead with is not a reason to file a page with no subtitle.
    from delphi_core.memory import digest_lead_prose

    assert digest_lead_prose("## Only\n\n| a |\n|---|") == ""


def test_an_embed_follows_its_evidence_marker_not_a_stray_digit():
    """`afterEvidenceId` is an integer, and searching for the bare number is
    not the same question.

    A real digest placed a figure after `[E2]` at character 1,963 and the
    search for "2" matched a digit in the prose at 1,100 — so the architecture
    diagram landed several paragraphs above the claim it illustrates. Nothing
    errors; the picture is simply in the wrong place.
    """
    from delphi_core.memory import _embed_digest_assets

    body = "Alpha [E1]. A stray 2 here.\n\nBeta [E2] is the claim.\n\nGamma."
    out = _embed_digest_assets(body, [(2, "fig-a")], ceiling=10_000)

    assert out.index("figure:fig-a") > out.index("Beta [E2]")
    assert out.index("figure:fig-a") < out.index("Gamma")


def test_an_embed_costs_a_reference_not_a_caption():
    """The alt is empty on purpose, and it is not a cosmetic choice.

    `MemoryMarkdown` unwraps a lone image into a `<figure>` and renders the
    caption from the figure row, so an alt here is never displayed — while a
    digest's own caption runs to 300 characters. Three of those against an
    11,179-character digest overran the page ceiling, and the ceiling check
    then dropped every figure's embed silently.
    """
    from delphi_core.memory import _embed_digest_assets

    body = "Claim [E1].\n\n" + ("Filler sentence. " * 700)
    out = _embed_digest_assets(body, [(1, "a" * 24)], ceiling=len(body) + 60)

    assert out.count("](figure:") == 1
    assert "![](figure:" in out


def test_a_figure_that_cannot_fit_is_dropped_before_the_prose_is():
    from delphi_core.memory import _embed_digest_assets

    body = "Claim [E1].\n\nMore."
    out = _embed_digest_assets(body, [(1, "fig-a")], ceiling=len(body) + 2)

    # A page that teaches without its picture beats a page cut mid-sentence.
    assert out == body


def test_an_anchor_that_is_not_in_the_prose_still_leaves_the_picture():
    """Repair in the direction of the work the model actually did (§36c).

    A digest may name `afterEvidenceId: 7` for a citation whose `[E7]` marker
    never reached the body — two assets did exactly that in a measured run.
    Choosing the figure is the half only the model can do; placing it is
    bookkeeping, so the bookkeeping yields and the figure lands at the end.
    """
    from delphi_core.memory import _embed_digest_assets

    body = "Claim [E1].\n\nMore prose."
    out = _embed_digest_assets(body, [(7, "orphan")], ceiling=10_000)

    assert "![](figure:orphan)" in out
    assert out.startswith(body)


def test_the_page_wall_holds_a_maximal_digest_and_its_own_figures():
    """
    A source page is a digest with its pictures put back, so the wall the
    schema sets on a page body has to hold both. At the digest's own wall an
    11,974-character digest had twenty-six characters of headroom, and its six
    figures were captured, stored and dropped without an embed.
    """
    from delphi_core.research_digest import DIGEST_CONTENT_ACCEPT_LENGTH

    per_page = Settings(_env_file=None, web_sandbox_origin="http://s.test").memory_figure_max_per_page
    assert MEMORY_PAGE_BODY_MAX_LENGTH >= DIGEST_CONTENT_ACCEPT_LENGTH + per_page * 40


def test_no_pass_may_name_a_figure_of_its_own():
    """A `figures` row is server-owned. The schema is what makes a model's own rows unrepresentable."""
    for schema in (audit_schema(),):
        for definition in schema.get("$defs", {}).values():
            assert "figures" not in definition.get("properties", {})
        assert "figures" not in schema.get("properties", {})
