"""
A long document's digest is longer, by one bounded factor of its length.

Every length a digest is held to — the words it is asked for, the characters
accepted, the decoder's wall, its share of the chat block, the output budget
and the page it is filed as — moves with `DigestBudget.factor`, which is 1 for
a standard paper and at most `DIGEST_MAX_LENGTH_FACTOR` for anything longer.
"""

import json

import httpx
import pytest

from delphi_core.config import Settings
from delphi_core.memory import (
    MEMORY_PAGE_BODY_MAX_LENGTH,
    MEMORY_SOURCE_EMBED_ALLOWANCE,
    source_page_from_digest,
)
from delphi_core.research_digest import (
    DIGEST_MAX_CITATIONS,
    DIGEST_CONTENT_ACCEPT_LENGTH,
    DIGEST_CONTENT_MAX_LENGTH,
    DIGEST_CONTENT_SCHEMA_MAX,
    DIGEST_MAX_LENGTH_FACTOR,
    DIGEST_STANDARD_SOURCE_CHARS,
    DIGEST_TOKEN_ACCEPT_RATIO,
    LONGEST_DIGEST_BUDGET,
    RESEARCH_DIGEST_SKILL,
    STANDARD_DIGEST_BUDGET,
    compact_digest_cards,
    digest_budget,
    digest_budget_instructions,
    digest_skill,
    digest_tokens,
    generate_digest,
    load_digest,
    stored_digest_budget,
    validate_digest,
)
from delphi_core.storage import LocalObjectStore, LocalStorage, paper_key
from tests.helpers import ProviderTransport

#: Alisa's book of LLMs, captured whole: 57 sections in about this many characters.
BOOK_CHARS = 104_000


def _digest(body: str) -> dict:
    return {
        "title": "",
        "contentMarkdown": body,
        "citations": [{"id": 1, "claimType": "author-claim", "page": 1, "section": None}],
        "assets": [],
    }


def _body(chars: int) -> str:
    """Prose of about `chars` characters, in cited paragraphs a cut can land between."""
    paragraph = "A finding the document reports, with its conditions. " * 8 + "[E1]"
    paragraphs = [paragraph] * max(1, chars // (len(paragraph) + 2))
    return "\n\n".join(paragraphs)


def test_a_standard_paper_keeps_every_length_it_had():
    settings = Settings()
    for chars in (0, 12_000, DIGEST_STANDARD_SOURCE_CHARS):
        assert digest_budget(chars) == STANDARD_DIGEST_BUDGET
    budget = STANDARD_DIGEST_BUDGET
    assert budget.words == "900–1,200"
    assert budget.ask_chars == DIGEST_CONTENT_MAX_LENGTH
    assert budget.accept_chars == DIGEST_CONTENT_ACCEPT_LENGTH
    assert budget.wall_chars == DIGEST_CONTENT_SCHEMA_MAX
    assert budget.share_tokens(settings) == settings.digest_document_max_tokens
    assert budget.output_tokens(settings) == settings.digest_max_output_tokens
    assert digest_skill(budget) == RESEARCH_DIGEST_SKILL
    assert "approximately 900–1,200 useful words" in RESEARCH_DIGEST_SKILL
    assert "is long" not in digest_budget_instructions(settings, budget)
    # A record that names no factor is a standard digest.
    assert stored_digest_budget({"digest": {"status": "ready"}}) == STANDARD_DIGEST_BUDGET
    assert stored_digest_budget({}) == STANDARD_DIGEST_BUDGET


def test_the_factor_grows_with_the_source_and_stops_at_the_bound():
    settings = Settings()
    assert digest_budget(2 * DIGEST_STANDARD_SOURCE_CHARS).factor == 2.0
    assert 1.5 < digest_budget(BOOK_CHARS).factor < 2.0
    assert digest_budget(10_000_000) == LONGEST_DIGEST_BUDGET
    assert LONGEST_DIGEST_BUDGET.factor == DIGEST_MAX_LENGTH_FACTOR == 3.0
    # About six pages at most: three times the two a standard digest is.
    assert LONGEST_DIGEST_BUDGET.ask_chars == 3 * DIGEST_CONTENT_MAX_LENGTH
    assert stored_digest_budget({"digest": {"lengthFactor": 99}}) == LONGEST_DIGEST_BUDGET
    assert stored_digest_budget({"digest": {"lengthFactor": "nonsense"}}) == STANDARD_DIGEST_BUDGET

    previous = STANDARD_DIGEST_BUDGET
    for chars in range(DIGEST_STANDARD_SOURCE_CHARS, 240_001, 10_000):
        budget = digest_budget(chars)
        # The three character numbers keep their order and their ratios.
        assert budget.ask_chars < budget.accept_chars < budget.wall_chars
        assert budget.accept_chars == round(budget.ask_chars * 1.5)
        # The output budget holds the larger wall on top of the same reasoning.
        assert budget.output_tokens(settings) - budget.wall_chars // 4 >= (
            settings.digest_max_output_tokens - DIGEST_CONTENT_SCHEMA_MAX // 4
        )
        assert budget.factor >= previous.factor
        previous = budget
    # A page copied from the longest digest still has room for its figures.
    assert MEMORY_PAGE_BODY_MAX_LENGTH == (
        LONGEST_DIGEST_BUDGET.accept_chars + MEMORY_SOURCE_EMBED_ALLOWANCE
    )


def _seed_book(tmp_path, chars=BOOK_CHARS):
    settings = Settings(
        data_dir=tmp_path,
        openai_api_key="test-key",
        openai_api_base_url="https://api.openai.test/v1",
        digest_reasoning_effort="high",
    )
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    project = storage.create_project("reader", "Project")
    storage.add_paper(
        "reader",
        project["id"],
        {
            "id": "book",
            "title": "Alisa's book of LLMs",
            "filename": "book.pdf",
            "pages": 2,
            "tokens": 20,
            "bytes": 100,
        },
    )
    objects = LocalObjectStore(tmp_path)
    text = "--- Page 1 ---\n\n" + "word " * (chars // 5)
    objects.put_text(paper_key("reader", project["id"], "book", "txt"), text)
    storage.set_openai_file("reader", project["id"], "book", "file-book")
    return settings, storage, objects, project, len(text)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "source_chars, body_chars",
    [
        # The book, with a digest over everything a standard paper may store.
        (BOOK_CHARS, 15_000),
        # A source past the cap, with a digest just inside the cap's ceiling.
        (200_000, LONGEST_DIGEST_BUDGET.accept_chars - 400),
    ],
    ids=["book", "cap"],
)
async def test_a_long_document_is_asked_for_a_longer_digest_accepts_it_and_files_its_page(
    tmp_path, source_chars, body_chars
):
    settings, storage, objects, project, source_chars = _seed_book(tmp_path, source_chars)
    budget = digest_budget(source_chars)
    assert budget.factor > 1.5

    # Over everything a standard paper may store, in characters and in tokens,
    # and inside this document's own ceilings.
    body = _body(body_chars)
    assert DIGEST_CONTENT_ACCEPT_LENGTH < len(body) < budget.accept_chars
    answer = json.dumps(_digest(body))
    assert (
        settings.digest_document_max_tokens * DIGEST_TOKEN_ACCEPT_RATIO
        < digest_tokens(json.loads(answer))
        < budget.share_tokens(settings)
    )
    with pytest.raises(ValueError, match="character ceiling|length cap"):
        validate_digest(
            answer, paper={"pages": 2}, web_sections=None,
            max_tokens=settings.digest_document_max_tokens,
        )

    requests = []
    transcript = (
        "data: " + json.dumps({"type": "response.output_text.delta", "delta": answer}) + "\n\n"
        + "data: " + json.dumps({"type": "response.completed", "response": {"usage": {"input_tokens": 1, "output_tokens": 1}}}) + "\n\n"
    ).encode()

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, content=transcript)

    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        events = [
            event
            async for event in generate_digest(
                client, storage, objects, "reader", project["id"], "book", settings
            )
        ]

    assert len(requests) == 1, "the longer digest was accepted on the first attempt"
    payload = requests[0]
    schema = payload["text"]["format"]["schema"]
    assert schema["properties"]["contentMarkdown"]["maxLength"] == budget.wall_chars
    assert payload["max_output_tokens"] == budget.output_tokens(settings)
    assert payload["max_output_tokens"] > settings.digest_max_output_tokens
    # The reasoning keeps the room it has for a standard digest.
    assert payload["max_output_tokens"] - budget.wall_chars // 4 == (
        settings.digest_max_output_tokens - DIGEST_CONTENT_SCHEMA_MAX // 4
    )
    assert f"approximately {budget.words} useful words" in payload["instructions"]
    assert f"about {budget.share_tokens(settings):,} tokens" in payload["instructions"]
    assert "This document is long" in payload["instructions"]
    assert any(event.get("type") == "_digest_ready" for event in events)

    paper = storage.get_paper("reader", project["id"], "book")
    assert paper["digest"]["status"] == "ready"
    assert paper["digest"]["lengthFactor"] == budget.factor
    assert stored_digest_budget(paper) == budget

    digest = load_digest(objects, "reader", project["id"], "book")
    page, _ = await source_page_from_digest(
        objects, storage, "reader", project["id"], paper, digest, settings,
        slug="alisas-book-of-llms", domain="general",
    )
    assert page.bodyMarkdown == digest["contentMarkdown"]
    assert len(page.bodyMarkdown) > DIGEST_CONTENT_ACCEPT_LENGTH


def _card(paper_id: str, tokens: int, factor: float = 1.0) -> tuple[dict, dict]:
    record = {"status": "ready", **({"lengthFactor": factor} if factor > 1 else {})}
    digest = _digest(_body(tokens * 4))
    return {"id": paper_id, "digest": record}, digest


def test_a_standard_project_keeps_its_block():
    settings = Settings()
    share = settings.digest_document_max_tokens
    within = [_card(f"p{index}", share - 200) for index in range(10)]
    kept, estimated = compact_digest_cards(within, settings)
    assert [digest for _, digest in kept] == [digest for _, digest in within]
    assert estimated <= settings.digest_context_max_tokens

    over = [_card(f"p{index}", share + 400) for index in range(10)]
    _, estimated = compact_digest_cards(over, settings)
    assert estimated <= settings.digest_context_max_tokens


def test_the_block_holds_a_long_digest_and_cuts_the_one_furthest_over_its_share():
    settings = Settings()
    share = settings.digest_document_max_tokens
    long_paper, long_digest = _card("book", 2 * share - 100, factor=2.0)
    standard = [_card(f"p{index}", int(share * 1.15)) for index in range(9)]
    cards = [(long_paper, long_digest), *standard]
    # More than the standard block, and more than the block grown by the
    # book's extra share, so something must be shortened.
    total = sum(digest_tokens(digest) for _, digest in cards)
    block = settings.digest_context_max_tokens + share
    assert total > block

    kept, estimated = compact_digest_cards(cards, settings)

    assert estimated <= block
    # The book is the longest digest, and it is at its own share: it stays whole.
    assert kept[0][1]["contentMarkdown"] == long_digest["contentMarkdown"]
    assert any(
        "Digest shortened in project context" in digest["contentMarkdown"]
        for _, digest in kept[1:]
    )


def test_a_long_digest_over_its_own_share_is_still_the_one_cut():
    settings = Settings()
    share = settings.digest_document_max_tokens
    # Written before its factor was recorded, so it is held to a standard share.
    unscaled = _card("book", 2 * share)
    standard = [_card(f"p{index}", share) for index in range(9)]
    kept, estimated = compact_digest_cards([unscaled, *standard], settings)
    assert estimated <= settings.digest_context_max_tokens
    assert "Digest shortened in project context" in kept[0][1]["contentMarkdown"]
    assert [digest for _, digest in kept[1:]] == [digest for _, digest in standard]


# At the cap: every reader of a digest, given the largest one Delphi accepts.


def _cap_digest(assets=()) -> dict:
    """A digest at the cap's ceiling, with the most evidence a digest may index."""
    citations = [
        {"id": index, "claimType": "author-claim", "page": 1, "section": None}
        for index in range(1, DIGEST_MAX_CITATIONS + 1)
    ]
    paragraph = "A finding the book reports, with its conditions and its numbers. " * 6
    paragraphs, length, index = [], 0, 0
    while length < LONGEST_DIGEST_BUDGET.accept_chars - 600:
        text = f"{paragraph}[E{index % DIGEST_MAX_CITATIONS + 1}]"
        paragraphs.append(text)
        length += len(text) + 2
        index += 1
    return {"title": "", "contentMarkdown": "\n\n".join(paragraphs), "citations": citations, "assets": list(assets)}


def _webp() -> bytes:
    import io

    from PIL import Image

    image = io.BytesIO()
    Image.new("RGB", (24, 12), "white").save(image, format="WEBP")
    return image.getvalue()


def test_a_cap_digest_passes_every_check_it_is_written_against():
    settings = Settings()
    digest = _cap_digest()
    raw = json.dumps(digest)
    assert LONGEST_DIGEST_BUDGET.ask_chars < len(digest["contentMarkdown"]) < LONGEST_DIGEST_BUDGET.accept_chars
    assert digest_tokens(digest) <= LONGEST_DIGEST_BUDGET.share_tokens(settings) * DIGEST_TOKEN_ACCEPT_RATIO
    validated = validate_digest(
        raw, paper={"pages": 1}, web_sections=None,
        content_max_chars=LONGEST_DIGEST_BUDGET.wall_chars,
        max_tokens=LONGEST_DIGEST_BUDGET.share_tokens(settings),
        budget=LONGEST_DIGEST_BUDGET,
    )
    assert len(validated.citations) == DIGEST_MAX_CITATIONS


@pytest.mark.asyncio
async def test_a_cap_digest_is_stored_as_its_source_page_with_every_figure(tmp_path):
    """The page is the digest with its pictures put back; at the cap, all of them still fit."""
    from delphi_core.memory import refresh_source_page
    from delphi_core.research_digest import digest_asset_key

    settings, storage, objects, project, _ = _seed_book(tmp_path, 200_000)
    paper = storage.get_paper("reader", project["id"], "book")
    picture = _webp()
    assets = []
    for index in range(1, settings.memory_figure_max_per_page + 1):
        path = tmp_path / f"asset-{index}.webp"
        path.write_bytes(picture)
        objects.put_file(digest_asset_key("reader", project["id"], "book", f"asset-{index}", "image/webp"), path, "image/webp")
        assets.append({
            "id": f"asset-{index}", "inventoryId": f"pdf-figure-{index}",
            "caption": "A figure the book prints, described at the longest a caption may be. " * 4,
            "alt": "Figure", "teachingValue": "Shows the result.", "afterEvidenceId": index * 7,
            "kind": "source-figure", "page": 1, "mimeType": "image/webp",
            "width": 24, "height": 12, "bytes": len(picture),
        })
    digest = _cap_digest(assets)

    assert await refresh_source_page(objects, storage, "reader", project["id"], paper, digest, settings)

    (stored,) = storage.list_memory_pages("reader")
    page = storage.get_memory_page("reader", stored["slug"])
    assert page["kind"] == "source"
    assert page["body"].count("](figure:") == settings.memory_figure_max_per_page
    assert len(page["citations"]) == DIGEST_MAX_CITATIONS
    assert len(page["body"]) <= MEMORY_PAGE_BODY_MAX_LENGTH


def _cap_library(tmp_path):
    """An account whose long document's digest is at the cap, filed, beside three concept pages."""
    from delphi_core.memory import refresh_source_page

    settings, storage, objects, project, _ = _seed_book(tmp_path, 200_000)
    paper = storage.get_paper("reader", project["id"], "book")
    digest = _cap_digest()
    objects.put_text(paper_key("reader", project["id"], "book", "digest"), json.dumps({"digest": digest}))
    return settings, storage, objects, project, paper, digest, refresh_source_page


@pytest.mark.asyncio
async def test_filing_reads_a_cap_digest_whole_and_opens_the_selected_pages_beside_it(tmp_path):
    from delphi_core.memory_harness import open_chosen_memory, open_memory_for_editing
    from delphi_core.memory_maintenance import agent, jobs, select
    from delphi_core.memory_maintenance.gather import gather_document

    settings, storage, objects, project, paper, digest, refresh = _cap_library(tmp_path)
    assert await refresh(objects, storage, "reader", project["id"], paper, digest, settings)
    source_slug = storage.list_memory_pages("reader")[0]["slug"]
    concepts = [f"concept-{index}" for index in range(3)]
    for slug in concepts:
        # Concept pages as long as a page is asked to be.
        storage.upsert_memory_page("reader", {
            "slug": slug, "title": slug, "kind": "concept", "domain": "general",
            "summary": "A concept.", "body": "A concept the library explains. " * 250,
        }, max_pages=settings.memory_max_pages)

    job = {"id": "job-1", "kind": "document", "marker": jobs.document_marker("book"), "attempts": 1,
           "payload": {"projectId": project["id"], "paperId": "book"}}
    evidence = gather_document(storage, objects, "reader", settings, job)
    # The gathered brief carries the whole digest and its whole evidence index...
    assert digest["contentMarkdown"] in evidence.brief
    assert f"E{DIGEST_MAX_CITATIONS}" in evidence.brief
    assert len(evidence.brief) > select.EVENT_MAX_CHARS
    # ...and selection and the agent both read all of it.
    assert select.event_turn(evidence).endswith(evidence.brief)
    assert agent.event_turn(evidence.brief, False)["content"][0]["text"] == evidence.brief

    # The agent starts from the source page and is handed the selected pages
    # beside it, as it would be beside a standard digest's page.
    text, records = open_memory_for_editing([source_slug, *concepts], storage, "reader", settings)
    assert [record["slug"] for record in records] == [source_slug, *concepts]
    assert "Not opened" not in text

    # A chat that opens the page reads it whole.
    opened, chosen, _ = open_chosen_memory([source_slug], storage, "reader", settings, settings.memory_open_max_chars)
    assert chosen == [source_slug] and "[cut here" not in opened
    assert digest["contentMarkdown"][-200:] in opened


def test_a_project_with_digests_at_every_ceiling_keeps_each_near_its_share():
    """
    Ten digests each at the most Delphi accepts, one of them at the cap: the
    block is over, and each is cut toward its own share, the long one no more
    than the rest. A general chat's open digest at the cap is never cut.
    """
    from delphi_core.routers.chat import project_library_blocks

    settings = Settings()
    cap_paper = {"id": "book", "digest": {"status": "ready", "lengthFactor": DIGEST_MAX_LENGTH_FACTOR}}
    cap = _cap_digest()
    standard = [_card(f"p{index}", round(settings.digest_document_max_tokens * DIGEST_TOKEN_ACCEPT_RATIO) - 60) for index in range(9)]
    cards = [(cap_paper, cap), *standard]
    shares = [LONGEST_DIGEST_BUDGET.share_tokens(settings)] + [settings.digest_document_max_tokens] * 9
    block = settings.digest_context_max_tokens + shares[0] - settings.digest_document_max_tokens

    kept, estimated = compact_digest_cards(cards, settings)

    assert estimated <= block
    for (_, digest), share in zip(kept, shares):
        assert digest_tokens(digest) >= 0.8 * share

    alone, _ = compact_digest_cards([(cap_paper, cap)], settings)
    assert alone[0][1] == cap
    blocks = project_library_blocks([{"id": "book", "title": "Book"}], alone, frozenset(), False)
    assert json.dumps(cap, ensure_ascii=False) in blocks[-1]["text"]
