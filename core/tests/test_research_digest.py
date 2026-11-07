import json
import re

import httpx
import pytest

from delphi_core.config import Settings
from delphi_core.research_digest import (
    DIGEST_CONTENT_MAX_LENGTH,
    DIGEST_CONTENT_SCHEMA_MAX,
    DigestAsset,
    DigestAssetChoice,
    RESEARCH_DIGEST_SKILL,
    RESEARCH_DIGEST_VERSION,
    digest_is_valid,
    source_hash,
    generate_digest,
    load_digest,
    malformed_math_in_body,
    validate_digest,
    web_visual_manifest,
)
from delphi_core.document_reads import read_paper
from delphi_core.routers.chat import build_responses_payload
from delphi_core.routers.digests import digest_detail
from delphi_core.schemas import ChatRequest
from tests.helpers import run_model_turns
from delphi_core.storage import LocalObjectStore, LocalStorage, paper_key
from tests.helpers import ProviderTransport


def evidence(identifier=1, page=1):
    return {
        "id": identifier,
        "claimType": "author-claim",
        "page": page,
        "section": None,
    }


def valid_digest(page=1):
    return {
        "contentMarkdown": (
            "The document's own structure determines this concise digest. [E1]"
        ),
        "citations": [evidence(page=page)],
    }


async def digest_with_title(storage, objects, project_id, settings, title):
    """Run one digest of `paper-one` whose provider answers with this printed title."""
    body = json.dumps({**valid_digest(), "title": title, "assets": []})
    transcript = (
        "data: " + json.dumps({"type": "response.output_text.delta", "delta": body}) + "\n\n"
        + "data: " + json.dumps({"type": "response.completed", "response": {"usage": {"input_tokens": 1, "output_tokens": 1}}}) + "\n\n"
    ).encode()
    async with httpx.AsyncClient(transport=ProviderTransport(lambda request: httpx.Response(200, content=transcript))) as client:
        return [event async for event in generate_digest(client, storage, objects, "reader", project_id, "paper-one", settings)]


@pytest.mark.asyncio
async def test_an_upload_still_named_after_its_file_takes_the_title_its_digest_reads(tmp_path):
    settings, storage, objects, project, _ = seeded(tmp_path)
    storage.rename_paper("reader", project["id"], "paper-one", "paper")
    printed = "Neural Tangent Kernel: Convergence and Generalization in Neural Networks"

    events = await digest_with_title(storage, objects, project["id"], settings, f"  {printed}\n")

    ready = next(event for event in events if event["type"] == "_digest_ready")
    assert ready["paper"]["title"] == printed and ready["digest"]["title"] == printed
    assert storage.get_paper("reader", project["id"], "paper-one")["title"] == printed
    # The source page is derived after the rename, so it is named by the title too.
    [source] = [page for page in storage.list_memory_pages("reader") if page["kind"] == "source"]
    assert source["title"] == printed and load_digest(objects, "reader", project["id"], "paper-one")["title"] == printed


@pytest.mark.asyncio
async def test_a_title_the_reader_set_or_an_empty_printed_title_is_left_as_it_is(tmp_path):
    settings, storage, objects, project, _ = seeded(tmp_path / "named")
    # "Paper" is not the file's name ("paper"): someone chose it.
    await digest_with_title(storage, objects, project["id"], settings, "The Printed Title")
    assert storage.get_paper("reader", project["id"], "paper-one")["title"] == "Paper"

    settings, storage, objects, project, _ = seeded(tmp_path / "untitled")
    storage.rename_paper("reader", project["id"], "paper-one", "paper")
    events = await digest_with_title(storage, objects, project["id"], settings, "")
    assert storage.get_paper("reader", project["id"], "paper-one")["title"] == "paper"
    assert next(event for event in events if event["type"] == "_digest_ready")["digest"]["title"] == ""


def test_web_visual_manifest_lists_inline_and_raster_figures():
    document = {
        "svgFigures": [
            {
                "id": "inline-html:0",
                "caption": "Figure 1. The DVA loop.",
                "html": "<figure><svg/></figure>",
            }
        ],
        "sections": [
            {
                "anchor": "results",
                "title": "Results",
                "markdown": "See ![Ablation](https://ex.test/ablate.png) below.",
            }
        ],
    }

    manifest = web_visual_manifest(document)

    assert "Visual evidence named in this snapshot" in manifest
    assert "Figure 1. The DVA loop." in manifest
    assert "inline-html:0" in manifest
    assert "§results" in manifest
    assert "Ablation" in manifest
    assert web_visual_manifest({"sections": []}) == ""


def seeded(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        openai_api_key="test-key",
        openai_api_base_url="https://api.openai.test/v1",
        digest_reasoning_effort="high",
    )
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    project = storage.create_project("reader", "Project")
    paper = storage.add_paper(
        "reader",
        project["id"],
        {
            "id": "paper-one",
            "title": "Paper",
            "filename": "paper.pdf",
            "pages": 2,
            "tokens": 20,
            "bytes": 100,
        },
    )
    objects = LocalObjectStore(tmp_path)
    objects.put_text(
        paper_key("reader", project["id"], "paper-one", "txt"),
        "--- Page 1 ---\n\nFirst exact page.\n\n--- Page 2 ---\n\nSecond exact page.",
    )
    storage.set_openai_file("reader", project["id"], "paper-one", "file-paper")
    return settings, storage, objects, project, paper


def test_digest_detail_reports_missing_without_reading_a_derived_object(tmp_path):
    settings, storage, objects, project, _ = seeded(tmp_path)

    detail = digest_detail(
        project["id"],
        "paper-one",
        username="reader",
        storage=storage,
        objects=objects,
        settings=settings,
    )

    assert detail["paper"].get("digest") is None
    assert detail["digest"] is None


def test_web_digest_requires_the_exact_saved_source_url():
    settings = Settings()
    digest = {
        "status": "ready",
        "version": RESEARCH_DIGEST_VERSION,
        "model": settings.digest_model,
        "sourceHash": "content-hash",
    }
    paper = {
        "kind": "web",
        "url": "https://example.com/canonical",
        "digest": digest,
    }

    assert not digest_is_valid(paper, "content-hash", settings)
    paper["digest"] = {**digest, "sourceUrl": "https://example.com/temporary"}
    assert not digest_is_valid(paper, "content-hash", settings)
    paper["digest"] = {**digest, "sourceUrl": paper["url"]}
    assert digest_is_valid(paper, "content-hash", settings)

    # Existing PDF metadata remains valid without the web-only field.
    assert digest_is_valid({"kind": "pdf", "digest": digest}, "content-hash", settings)


def test_web_digest_canonicalizes_heading_case_to_the_stored_anchor():
    digest = valid_digest()
    digest["citations"][0]["page"] = None
    digest["citations"][0]["section"] = "Abstract"
    validated = validate_digest(
        json.dumps(digest),
        paper={"pages": 1},
        web_sections={"abstract"},
    )

    assert validated.citations[0].section == "abstract"


def test_web_digest_canonicalizes_the_snapshot_anchor_title_marker():
    digest = valid_digest()
    digest["citations"][0]["page"] = None
    digest["citations"][0]["section"] = "top · How To Be Successful"
    validated = validate_digest(
        json.dumps(digest),
        paper={"pages": 1},
        web_sections={"top"},
        section_titles={"How To Be Successful": "top"},
    )

    assert validated.citations[0].section == "top"


def test_linked_pdf_digest_maps_visible_heading_to_exact_page_anchor():
    digest = valid_digest()
    digest["citations"][0]["page"] = 1
    digest["citations"][0]["section"] = "Abstract"
    validated = validate_digest(
        json.dumps(digest),
        paper={"pages": 2},
        web_sections={"page-1", "page-2"},
    )

    assert validated.citations[0].section == "page-1"


def test_digest_requires_a_complete_evidence_map_without_prescribing_sections():
    digest = valid_digest()
    digest["contentMarkdown"] = "A source-grounded point. [E2]"

    with pytest.raises(ValueError, match="Undefined digest evidence marker: E2"):
        validate_digest(
            json.dumps(digest),
            paper={"pages": 2},
            web_sections=None,
        )


def test_digest_content_strips_stray_control_characters():
    # A raw ANSI reset code observed in practice, embedded mid-token — enough
    # to abort a client-side Markdown parse for the whole document if kept.
    digest = valid_digest()
    digest["contentMarkdown"] = "A video planner \x1b[0m$\\pi_{\\mathrm{vid}}$. [E1]"

    validated = validate_digest(
        json.dumps(digest),
        paper={"pages": 2},
        web_sections=None,
    )

    assert validated.contentMarkdown == "A video planner $\\pi_{\\mathrm{vid}}$. [E1]"


def test_digest_rejects_visibly_malformed_math_before_it_can_be_filed():
    """The digest is the source page, so this validation belongs upstream."""
    assert malformed_math_in_body("The rate $alpha_t$ decays.") == ["alpha"]
    assert "stray \\n" in malformed_math_in_body(
        "The next state is $\\n$\\hat z_{t+1}."
    )
    assert "unclosed $" in malformed_math_in_body("The state is $\n$\\hat z_{t+1}.")
    assert malformed_math_in_body("The rate $\\alpha_t$ decays.") == []
    assert malformed_math_in_body("It cost $12.50 today.") == []

    digest = valid_digest()
    digest["contentMarkdown"] = "The rate $alpha_t$ decays. [E1]"
    with pytest.raises(ValueError, match="Digest contains malformed LaTeX.*alpha"):
        validate_digest(
            json.dumps(digest),
            paper={"pages": 2},
            web_sections=None,
        )


def test_digest_prompt_owns_formula_fidelity():
    """The pass that can see the paper must preserve its equations exactly."""
    lowered = RESEARCH_DIGEST_SKILL.casefold()
    assert "quoted evidence" in lowered
    assert "transcribe" in lowered and "exactly" in lowered
    assert "symbol" in lowered and "sign" in lowered
    assert "normalization/cardinality" in lowered
    assert "matrix dimension" in lowered
    assert "state the relationship accurately in prose" in lowered


def test_digest_content_saturating_the_length_cap_is_rejected_as_truncated():
    # A string that lands exactly on maxLength is what the provider's
    # constrained decoding produces when it force-closes the string
    # mid-generation — indistinguishable from a genuinely short digest unless
    # validate_digest checks for it explicitly.
    # Against the *wall*, which is where a force-close can land -- not against
    # the ask, which is merely the length the prompt requests and which a
    # complete digest may legitimately exceed. Those were one number, and
    # spelling the ask as the wall is what severed digests mid-sentence.
    padding = "x" * (DIGEST_CONTENT_SCHEMA_MAX - len(" [E1]"))
    digest = valid_digest()
    digest["contentMarkdown"] = padding + " [E1]"
    assert len(digest["contentMarkdown"]) == DIGEST_CONTENT_SCHEMA_MAX
    assert DIGEST_CONTENT_SCHEMA_MAX > DIGEST_CONTENT_MAX_LENGTH

    with pytest.raises(ValueError, match="hit the length cap"):
        validate_digest(
            json.dumps(digest),
            paper={"pages": 2},
            web_sections=None,
        )


def test_digest_assets_must_name_exact_non_decoy_inventory_candidates():
    digest = valid_digest()
    digest["assets"] = [
        {
            "inventoryId": "architecture",
            "caption": "The block data flow.",
            "alt": "Inputs pass through partitioned attention blocks.",
            "teachingValue": "Shows the mechanism more clearly than prose.",
            "afterEvidenceId": 1,
        }
    ]
    inventory = [
        {
            "id": "architecture",
            "kind": "figure",
            "page": 1,
            "capturable": True,
            "isQrOrBarcode": False,
        }
    ]
    validated = validate_digest(
        json.dumps(digest),
        paper={"pages": 2},
        web_sections=None,
        inventory=inventory,
    )
    assert validated.assets[0].inventoryId == "architecture"

    digest["assets"][0]["inventoryId"] = "missing"
    with pytest.raises(ValueError, match="Unknown digest asset inventory"):
        validate_digest(
            json.dumps(digest),
            paper={"pages": 2},
            web_sections=None,
            inventory=inventory,
        )

    digest["assets"][0]["inventoryId"] = "architecture"
    inventory[0]["isQrOrBarcode"] = True
    with pytest.raises(ValueError, match="QR/barcode"):
        validate_digest(
            json.dumps(digest),
            paper={"pages": 2},
            web_sections=None,
            inventory=inventory,
        )


@pytest.mark.asyncio
async def test_pdf_digest_request_is_one_low_detail_file_on_a_strict_schema(tmp_path):
    settings, storage, objects, project, _ = seeded(tmp_path)
    requests = []
    transcript = "".join(
        [
            "data: "
            + json.dumps(
                {
                    "type": "response.output_text.delta",
                    "delta": json.dumps(valid_digest()),
                }
            )
            + "\n\n",
            "data: "
            + json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "service_tier": "default",
                        "usage": {
                            "input_tokens": 123,
                            "output_tokens": 45,
                            "input_tokens_details": {
                                "cached_tokens": 80,
                                "cache_write_tokens": 40,
                            },
                            "output_tokens_details": {"reasoning_tokens": 12},
                        },
                    },
                }
            )
            + "\n\n",
        ]
    ).encode()

    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        return httpx.Response(200, content=transcript)

    events = []
    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        async for event in generate_digest(
            client,
            storage,
            objects,
            "reader",
            project["id"],
            "paper-one",
            settings,
        ):
            events.append(event)

    assert len(requests) == 1
    payload = requests[0]
    assert payload["model"] == "gpt-6.1-sol"
    assert payload["reasoning"]["effort"] == settings.digest_reasoning_effort
    assert payload["service_tier"] == "default"
    assert payload["store"] is False
    # A first digest call writes no cache prefix. It is one call whose prefix
    # nothing else shares -- the filing calls key separately and could not read
    # it -- so caching here billed ~26,000 write tokens per document against
    # zero reads, measured. Only a correction attempt re-sends this prefix.
    assert "prompt_cache_options" not in payload
    assert "prompt_cache_key" not in payload
    # The number is tunable; what must hold is that the payload carries the
    # configured one, and that it leaves room for the reasoning as well as the
    # answer. The two share this budget, so a value that only fits the JSON
    # produces a truncated, unparseable digest rather than a shorter one.
    assert payload["max_output_tokens"] == settings.digest_max_output_tokens
    max_markdown_chars = payload["text"]["format"]["schema"]["properties"][
        "contentMarkdown"
    ]["maxLength"]
    assert payload["max_output_tokens"] > max_markdown_chars // 4
    assert payload["text"]["format"]["strict"] is True
    assert set(payload["text"]["format"]["schema"]["properties"]) == {
        "title",
        "contentMarkdown",
        "citations",
        "assets",
    }
    assert "title" in payload["text"]["format"]["schema"]["required"]
    files = [
        block
        for item in payload["input"]
        for block in item["content"]
        if block["type"] == "input_file"
    ]
    assert files == [
        {"type": "input_file", "file_id": "file-paper", "detail": "low"}
    ]
    assert not any(
        "prompt_cache_breakpoint" in block for block in payload["input"][0]["content"]
    )
    # The skill, then the length it is written to: one document's share of the
    # block every chat request carries, stated in the request that writes it.
    assert payload["instructions"].startswith(RESEARCH_DIGEST_SKILL)
    budget = payload["instructions"][len(RESEARCH_DIGEST_SKILL):]
    assert f"{settings.digest_document_max_tokens:,} tokens" in budget
    assert f"{settings.digest_context_max_tokens:,}-token block" in budget
    for priority in [
        "freeform Markdown",
        "introduction and conclusion",
        "Visuals are neutral evidence candidates",
        "Prefer tables",
        "Ablation tables",
        "methods or methodology",
        "results",
        "ablation studies",
        "Related work belongs when it is needed",
        "what an outside source claims",
        "no mandatory sections",
    ]:
        assert priority in payload["instructions"]
    assert "Never manufacture" in payload["instructions"]
    assert "research question" in payload["instructions"]
    assert "valid LaTeX" in payload["instructions"]
    assert "Never put mathematics in Markdown code spans" in payload["instructions"]
    assert "project_skills" not in payload["instructions"]
    assert events[-1]["type"] == "_digest_ready"
    digest_metadata = storage.get_paper("reader", project["id"], "paper-one")[
        "digest"
    ]
    assert digest_metadata["status"] == "ready"
    assert digest_metadata["model"] == payload["model"] == "gpt-6.1-sol"
    assert digest_metadata["telemetry"]["callCount"] == 1
    assert "semanticCheck" not in digest_metadata
    assert digest_metadata["telemetry"]["requestedTier"] == "default"
    assert digest_metadata["telemetry"]["actualTier"] == "default"
    assert digest_metadata["telemetry"]["cacheReadTokens"] == 80
    assert digest_metadata["telemetry"]["cacheWriteTokens"] == 40
    assert digest_metadata["telemetry"]["bodyCharacters"] == len(
        valid_digest()["contentMarkdown"]
    )
    assert objects.exists(paper_key("reader", project["id"], "paper-one", "digest"))
    detail = digest_detail(
        project["id"],
        "paper-one",
        username="reader",
        storage=storage,
        objects=objects,
        settings=settings,
    )
    assert detail["paper"]["digest"]["status"] == "ready"
    assert detail["digest"]["contentMarkdown"].endswith("[E1]")

    reused_events = []
    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        async for event in generate_digest(
            client,
            storage,
            objects,
            "reader",
            project["id"],
            "paper-one",
            settings,
            force=False,
        ):
            reused_events.append(event)

    # Project-wide chat uses this non-forced path. A current card is loaded from
    # storage without another Files API upload or model request.
    assert len(requests) == 1
    assert reused_events[-1]["type"] == "_digest_ready"
    assert reused_events[-1]["reused"] is True
    assert not any(
        event.get("stage") == "digest_generate" for event in reused_events
    )


@pytest.mark.asyncio
async def test_digest_uses_standard_tier_when_the_account_prefers_it(tmp_path):
    settings, storage, objects, project, _ = seeded(tmp_path)
    requests = []
    transcript = (
        "data: "
        + json.dumps(
            {
                "type": "response.output_text.delta",
                "delta": json.dumps(valid_digest()),
            }
        )
        + "\n\ndata: "
        + json.dumps(
            {"type": "response.completed", "response": {"usage": {}}}
        )
        + "\n\n"
    ).encode()

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, content=transcript)

    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        async for _ in generate_digest(
            client,
            storage,
            objects,
            "reader",
            project["id"],
            "paper-one",
            settings,
            use_standard_tier=True,
        ):
            pass

    assert requests[0]["service_tier"] == "default"


@pytest.mark.asyncio
async def test_invalid_evidence_never_replaces_a_digest(tmp_path):
    settings, storage, objects, project, _ = seeded(tmp_path)
    bad = valid_digest(page=99)
    transcript = (
        "data: "
        + json.dumps(
            {
                "type": "response.output_text.delta",
                "delta": json.dumps(bad),
            }
        )
        + "\n\n"
    ).encode()

    async with httpx.AsyncClient(
        transport=ProviderTransport(
            lambda request: httpx.Response(200, content=transcript)
        )
    ) as client:
        with pytest.raises(ValueError, match="between 1 and 2"):
            async for _ in generate_digest(
                client,
                storage,
                objects,
                "reader",
                project["id"],
                "paper-one",
                settings,
            ):
                pass

    assert storage.get_paper("reader", project["id"], "paper-one")["digest"][
        "status"
    ] == "failed"
    assert not objects.exists(paper_key("reader", project["id"], "paper-one", "digest"))


@pytest.mark.asyncio
async def test_an_incomplete_digest_gets_one_corrective_attempt_at_the_same_wall(tmp_path):
    settings, storage, objects, project, _ = seeded(tmp_path)
    requests = []

    def transcript(answer):
        return (
            "data: "
            + json.dumps({"type": "response.output_text.delta", "delta": answer})
            + "\n\n"
        ).encode()

    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        answer = "{\"contentMarkdown\": \"cut off"
        if len(requests) == 2:
            answer = json.dumps(valid_digest())
        return httpx.Response(200, content=transcript(answer))

    events = []
    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        async for event in generate_digest(
            client,
            storage,
            objects,
            "reader",
            project["id"],
            "paper-one",
            settings,
        ):
            events.append(event)

    assert len(requests) == 2
    first_limit = requests[0]["text"]["format"]["schema"]["properties"][
        "contentMarkdown"
    ]["maxLength"]
    retry_limit = requests[1]["text"]["format"]["schema"]["properties"][
        "contentMarkdown"
    ]["maxLength"]
    # **The wall does not move between attempts.** It used to narrow to 0.8x on
    # the theory that asking for less would make the model stop sooner; it does
    # the reverse -- the model writes to whatever wall it is given, so the
    # corrective attempt was force-closed at the smaller wall and stored. Two
    # of four digests in one measured rebuild ended mid-table that way. What
    # makes the retry different is the rejection it carries, not a squeeze.
    assert retry_limit == first_limit
    assert requests[1]["instructions"] == requests[0]["instructions"]
    retry_task = json.dumps(requests[1]["input"])
    assert "<validation_feedback>" in retry_task
    # And the sentence quotes the ask, never the wall: telling the model to
    # finish below the wall asks for the one length only truncation reaches.
    assert f"below {DIGEST_CONTENT_MAX_LENGTH} " in retry_task
    assert f"below {DIGEST_CONTENT_SCHEMA_MAX} " not in retry_task
    # The retry is the one call that can read this prefix back, so it is the
    # one that marks it.
    assert requests[1]["prompt_cache_key"].startswith(f"delphi:{RESEARCH_DIGEST_VERSION}:")
    assert "prompt_cache_key" not in requests[0]
    retry_tail = requests[1]["input"][0]["content"][-1]["text"]
    assert "previous attempt" in retry_tail
    assert "<validation_feedback>" in retry_tail
    assert requests[1]["input"][0]["content"][-2][
        "prompt_cache_breakpoint"
    ] == {"mode": "explicit"}
    assert events[-1]["type"] == "_digest_ready"


@pytest.mark.asyncio
async def test_a_missing_cached_provider_file_is_reuploaded_once(tmp_path):
    settings, storage, objects, project, _ = seeded(tmp_path)
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4\n")
    objects.put_file(
        paper_key("reader", project["id"], "paper-one", "pdf"),
        pdf,
        "application/pdf",
    )
    response_files = []

    def handler(request):
        if request.url.path.endswith("/files"):
            return httpx.Response(200, json={"id": "file-refreshed"})
        payload = json.loads(request.content)
        file_id = next(
            block["file_id"]
            for item in payload["input"]
            for block in item["content"]
            if block["type"] == "input_file"
        )
        response_files.append(file_id)
        if len(response_files) == 1:
            return httpx.Response(
                404,
                json={"error": {"message": "File file-paper was not found"}},
            )
        answer = json.dumps(valid_digest())
        return httpx.Response(
            200,
            content=(
                "data: "
                + json.dumps(
                    {"type": "response.output_text.delta", "delta": answer}
                )
                + "\n\n"
            ).encode(),
        )

    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        events = [
            event
            async for event in generate_digest(
                client,
                storage,
                objects,
                "reader",
                project["id"],
                "paper-one",
                settings,
            )
        ]

    assert response_files == ["file-paper", "file-refreshed"]
    assert storage.get_paper("reader", project["id"], "paper-one")[
        "openaiFileId"
    ] == "file-refreshed"
    assert events[-1]["repairedStaleFile"] is True


@pytest.mark.asyncio
async def test_a_digest_the_provider_cut_off_is_corrected_once_and_never_stored(tmp_path):
    """
    A response that stopped at the output ceiling is not a shorter digest.

    It used to be read as a finished one, and only failed later if its JSON
    happened not to parse. Now the provider's own word decides: the cut-off
    response gets the one corrective attempt, a second cut-off fails, and in
    neither case is anything written for the document.
    """
    from delphi_core.harness.provider import ProviderError
    from delphi_core.research_digest import load_digest
    from delphi_core.storage import paper_key as key

    settings, storage, objects, project, _ = seeded(tmp_path)
    whole = json.dumps(valid_digest())
    cut_off = "".join("data: " + json.dumps(frame) + "\n\n" for frame in (
        {"type": "response.output_text.delta", "delta": whole[: len(whole) // 2]},
        {"type": "response.incomplete", "response": {
            "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}},
    )).encode()
    finished = ("data: " + json.dumps({"type": "response.output_text.delta", "delta": whole}) + "\n\n").encode()
    requests: list[dict] = []

    def provider(*bodies: bytes):
        def handler(request):
            requests.append(json.loads(request.content))
            return httpx.Response(200, content=bodies[min(len(requests), len(bodies)) - 1])
        return handler

    async def run(handler):
        async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
            return [
                event async for event in generate_digest(
                    client, storage, objects, "reader", project["id"], "paper-one", settings
                )
            ]

    # Cut off both times: an error, two requests, and no digest.
    with pytest.raises(ProviderError) as refused:
        await run(provider(cut_off))
    assert "cut off before it finished (max_output_tokens)" in str(refused.value)
    assert len(requests) == 2
    assert not objects.exists(key("reader", project["id"], "paper-one", "digest"))

    # Cut off once: the corrective attempt is told why, and its digest is kept.
    requests.clear()
    events = await run(provider(cut_off, finished))
    assert len(requests) == 2
    assert "cut off before it finished" in json.dumps(requests[1]["input"])
    assert events[-1]["type"] == "_digest_ready"
    assert load_digest(objects, "reader", project["id"], "paper-one")["contentMarkdown"]


@pytest.mark.asyncio
async def test_digest_waits_for_a_short_rate_limit_and_resumes(
    tmp_path, monkeypatch
):
    from delphi_core import research_digest as digest_module

    settings, storage, objects, project, _ = seeded(tmp_path)
    requests = 0
    delays = []

    async def fake_sleep(delay):
        delays.append(delay)

    monkeypatch.setattr(digest_module.asyncio, "sleep", fake_sleep)

    def handler(request):
        nonlocal requests
        requests += 1
        if requests == 1:
            return httpx.Response(
                429,
                headers={"retry-after": "3.25"},
                json={"error": {"message": "Rate limit reached"}},
            )
        return httpx.Response(
            200,
            content=(
                "data: "
                + json.dumps(
                    {
                        "type": "response.output_text.delta",
                        "delta": json.dumps(valid_digest()),
                    }
                )
                + "\n\n"
            ).encode(),
        )

    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        events = [
            event
            async for event in generate_digest(
                client,
                storage,
                objects,
                "reader",
                project["id"],
                "paper-one",
                settings,
            )
        ]

    assert requests == 2
    assert delays == [3.25]
    assert any("Provider is busy" in event.get("message", "") for event in events)
    assert events[-1]["type"] == "_digest_ready"


def test_companion_digests_make_the_exact_read_reachable():
    settings = Settings()
    paper = {"id": "paper-one", "title": "Paper", "pages": 2}
    other = {"id": "paper-two", "title": "Other", "pages": 3}
    body = ChatRequest(scope="document", prompt="Compare.", paper_id="paper-one")
    payload = build_responses_payload(
        settings=settings,
        username="reader",
        project_id="project",
        project_skills="Explain intuition first.",
        sources=[(paper, "file-test")],
        previous_messages=[],
        body=body,
        digest_cards=[(paper, valid_digest()), (other, valid_digest())],
        companions=[other],
    )

    content = payload["input"][0]["content"]
    assert content[0]["type"] == "input_file"
    assert content[1]["text"].startswith("<project_library")
    assert "<research_digest" in content[2]["text"]
    # Companion digest cards are an index, so the exact read has to be
    # reachable — and the search that finds where to read is offered with it,
    # never instead.
    offered = [tool.get("name") or tool["type"] for tool in payload["tools"]]
    assert "read_paper" in offered
    assert "search_library" in offered


def test_exact_paper_read_validates_pages_markers_and_truncation(tmp_path):
    _, _, objects, project, paper = seeded(tmp_path)
    papers = {"paper-one": {**paper, "pages": 2}}
    result = read_paper(
        "paper-one", [2],
        objects,
        "reader",
        project["id"],
        papers,
        4,
        10_000,
    )
    assert "--- Page 2 ---" in result
    assert "Second exact page." in result
    assert "(paper_id paper-one · PDF · exact stored text of page 2):" in result.split("\n")[0]
    assert "First exact page." not in result
    assert read_paper(
        "paper-one", [3],
        objects,
        "reader",
        project["id"],
        papers,
        4,
        10_000,
    ).startswith("Error:")
    assert "truncated" in read_paper(
        "paper-one", [1, 2],
        objects,
        "reader",
        project["id"],
        papers,
        4,
        30,
    )


@pytest.mark.asyncio
async def test_parallel_page_calls_count_individually_and_final_turn_may_call_none(
    tmp_path,
):
    settings, _, objects, project, paper = seeded(tmp_path)
    settings.model_tool_max_rounds = 1
    settings.document_tool_max_calls = 1
    turns = []

    def transcript(events):
        return "".join(f"data: {json.dumps(item)}\n\n" for item in events).encode()

    def handler(request):
        payload = json.loads(request.content)
        turns.append(payload)
        if len(turns) == 1:
            return httpx.Response(
                200,
                content=transcript(
                    [
                        {
                            "type": "response.output_item.done",
                            "item": {
                                "type": "function_call",
                                "call_id": "call-1",
                                "name": "read_paper",
                                "arguments": json.dumps(
                                    {"paper_id": "paper-one", "pages": [1]}
                                ),
                            },
                        },
                        {
                            "type": "response.output_item.done",
                            "item": {
                                "type": "function_call",
                                "call_id": "call-2",
                                "name": "read_paper",
                                "arguments": json.dumps(
                                    {"paper_id": "paper-one", "pages": [2]}
                                ),
                            },
                        },
                    ]
                ),
            )
        return httpx.Response(
            200,
            content=transcript(
                [{"type": "response.output_text.delta", "delta": "Checked."}]
            ),
        )

    body = ChatRequest(scope="document", prompt="Compare exact values.", paper_id="paper-one")
    payload = build_responses_payload(
        settings=settings,
        username="reader",
        project_id=project["id"],
        project_skills="",
        sources=[({**paper, "pages": 2}, None)],
        previous_messages=[],
        body=body,
        digest_cards=[({**paper, "pages": 2}, valid_digest())],
        # Held as a digest, so its pages are something the request can open:
        # a tool the request does not offer is refused, whatever asks for it.
        companions=[{**paper, "pages": 2}],
    )
    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        events = [
            event
            async for event in run_model_turns(
                client,
                payload,
                {},
                {},
                settings,
                objects=objects,
                username="reader",
                project_id=project["id"],
                paper_documents={"paper-one": {**paper, "pages": 2}},
            )
        ]

    assert {"type": "delta", "text": "Checked."} in events
    assert len(turns) == 2
    assert turns[-1]["tools"] == turns[0]["tools"] and turns[-1]["tool_choice"] == "none"
    outputs = [
        item["output"]
        for item in turns[-1]["input"]
        if item.get("type") == "function_call_output"
    ]
    assert "First exact page." in outputs[0]
    assert "budget is exhausted" in outputs[1]


def test_a_long_digest_keeps_saying_where_it_has_got_to():
    """The stage a reader watches longest has to keep moving.

    "Digest response started" was emitted once and then nothing until the
    response completed. The transport heartbeat kept the connection open, so
    this was never a broken stream — it was a card that read exactly like a
    hang for the minutes a v6 digest takes, which is the longest single stretch
    of a filing and the one a reader is most likely to give up on.
    """
    from delphi_core.research_digest import digest_stream_stage

    # Before any output: reasoning is already streaming, so there is something
    # true to report rather than silence.
    assert digest_stream_stage("", 0) == "Working through the document"
    thinking = digest_stream_stage("", 4210)
    assert "4,210" in thinking and "notes" in thinking

    # Once output starts the count follows the response, and it moves.
    first = digest_stream_stage("x" * 1200, 4210)
    later = digest_stream_stage("x" * 12400, 4210)
    assert "1,200 characters" in first
    assert "12,400 characters" in later
    assert first != later
    # Characters, not words: the response is a JSON schema payload, so a word
    # count would be a number about punctuation.
    assert "word" not in later


def test_digest_progress_never_borrows_the_document_counters():
    """`current`/`total` mean documents to the filing surfaces.

    A character count arriving in them would render as a run that had suddenly
    grown twelve thousand documents, so the moving detail goes in the message.
    """
    from delphi_core.research_digest import digest_stream_stage, progress

    frame = progress(
        "model_stream",
        digest_stream_stage("x" * 12400, 0),
        {"id": "paper-a"},
        0.0,
    )
    assert "current" not in frame and "total" not in frame
    assert "12,400 characters" in frame["message"]


@pytest.mark.asyncio
async def test_the_stream_reports_progress_while_it_reasons_and_while_it_writes(
    tmp_path, monkeypatch
):
    """End to end: reasoning frames and output frames both move the card.

    The throttle is wall-clock, so a test whose whole stream completes in
    milliseconds would legitimately emit one frame. It is set to zero here to
    assert the reporting, not the interval.
    """
    from delphi_core import research_digest as digest_module

    monkeypatch.setattr(digest_module, "DIGEST_PROGRESS_SECONDS", 0.0)
    settings, storage, objects, project, _ = seeded(tmp_path)
    body = json.dumps(valid_digest())
    frames = [
        # A long think before a single character of output — the phase that
        # used to be entirely silent.
        {"type": "response.reasoning_summary_text.delta", "delta": "weighing the ablations"},
        {"type": "response.reasoning_summary_text.delta", "delta": " and the figures"},
        {"type": "response.output_text.delta", "delta": body[: len(body) // 2]},
        {"type": "response.output_text.delta", "delta": body[len(body) // 2 :]},
        {"type": "response.completed", "response": {"usage": {"input_tokens": 123}}},
    ]
    transcript = "".join(
        "data: " + json.dumps(frame) + "\n\n" for frame in frames
    ).encode()

    def handler(request):
        return httpx.Response(200, content=transcript)

    events = []
    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        async for event in generate_digest(
            client, storage, objects, "reader", project["id"], "paper-one", settings
        ):
            events.append(event)

    stages = [
        event["message"]
        for event in events
        if event.get("type") == "progress" and event.get("stage") == "model_stream"
    ]
    # The old behaviour was exactly one of these for the whole generation.
    assert len(stages) > 1
    assert stages[0] == "Digest response started"
    assert any("characters of notes" in stage for stage in stages), stages
    written = [stage for stage in stages if "Writing the digest" in stage]
    assert written, stages
    # And the number moves rather than repeating a first reading.
    assert len(set(written)) > 1, written


def test_an_inline_image_embed_never_reaches_a_digest_body():
    """A figure is placed by the assets list, never by prose the model invents.

    Observed on a healthy v6 digest: all four figures captured, one rendering
    correctly as a captioned card, and two broken-image glyphs a few lines
    above it — the model had written `![alt](asset:<inventoryId>)` into the
    prose as well as declaring the assets, and nothing owns that protocol.
    """
    from delphi_core.research_digest import strip_inline_image_embeds

    body = (
        "Alignment is strongest late.\n\n"
        "![CKA comparisons between pathways](asset:pdf-p7-c0-5d09da0dc61a)\n\n"
        "Entropy falls with depth [E4]."
    )
    cleaned = strip_inline_image_embeds(body)
    assert "asset:" not in cleaned
    # The alt goes with it: a caption for a picture that is no longer there
    # reads as a dangling fragment.
    assert "CKA comparisons" not in cleaned
    assert "Alignment is strongest late." in cleaned
    assert "Entropy falls with depth [E4]." in cleaned


def test_markdown_shown_inside_a_code_fence_is_left_alone():
    """Inside a fence an embed is a sample of Markdown, not a request to draw one."""
    from delphi_core.research_digest import strip_inline_image_embeds

    body = "Use this:\n\n```md\n![alt](https://example.com/a.png)\n```\n\nDone."
    assert strip_inline_image_embeds(body) == body


def test_validation_strips_the_embed_so_it_is_never_stored():
    from delphi_core.research_digest import validate_digest

    draft = valid_digest()
    draft["contentMarkdown"] = (
        draft["contentMarkdown"] + "\n\n![A figure](asset:pdf-p1-c0-abc123)"
    )
    result = validate_digest(
        json.dumps(draft),
        paper={"id": "paper-one", "title": "Paper", "pages": 4, "kind": "pdf"},
        web_sections=None,
        section_titles=None,
        inventory={},
    )
    assert "asset:" not in result.contentMarkdown
    assert "![" not in result.contentMarkdown


def _asset_choice(identifier):
    return DigestAssetChoice(
        inventoryId=identifier,
        caption="A caption",
        alt="Alt text",
        teachingValue="Shows the architecture the section describes",
        afterEvidenceId=1,
    )


@pytest.mark.asyncio
async def test_a_pdf_capture_never_returns_the_child_process_tuple(
    tmp_path, monkeypatch
):
    """
    The accumulator survives the capture that fills it.

    `run_isolated` answers `(bytes, width, height)`, and assigning that over the
    list this function returns published a digest whose `assets` *was* the
    tuple — three Pydantic errors about `assets.0` being bytes, raised minutes
    into a filing and nowhere near the line at fault. Every PDF document that
    selected an asset failed that way, so a library of papers could not be
    filed at all.
    """
    from delphi_core import pdf_figures, research_digest

    monkeypatch.setattr(
        pdf_figures, "run_isolated", lambda *_args, **_kwargs: (b"webp-bytes", 718, 410)
    )
    monkeypatch.setattr(
        research_digest, "_put_digest_asset", lambda *_args, **_kwargs: None
    )

    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.7\n")

    class _Objects:
        def fetch_to_tempfile(self, key):
            return source

    assets = await research_digest._capture_digest_assets(
        _Objects(),
        "reader",
        "project",
        {"id": "paper", "kind": "pdf", "title": "A paper"},
        Settings(),
        choices=[_asset_choice("fig-1"), _asset_choice("fig-2")],
        inventory=[
            {"id": "fig-1", "kind": "figure", "page": 3, "section": None},
            {"id": "fig-2", "kind": "table", "page": 4, "section": None},
        ],
    )
    assert isinstance(assets, list)
    assert [asset.inventoryId for asset in assets] == ["fig-1", "fig-2"]
    assert all(isinstance(asset, DigestAsset) for asset in assets)


@pytest.mark.asyncio
async def test_a_web_documents_digest_captures_its_figures(tmp_path, monkeypatch):
    """
    A web document's chosen figure is captured by Memory's web capture, which
    the digest imports where it calls it to break an import cycle. A capture
    that fails is logged and its asset skipped, so a module moved under that
    import would cost every web digest its figures with nothing but a log line.
    """
    from delphi_core import memory, research_digest

    asked = []

    async def capture(url, settings, *, objects, username, project_id, paper_id):
        asked.append((url, paper_id))
        return b"captured-webp", 640, 320, "webp"

    monkeypatch.setattr(memory, "_capture_web_figure", capture)
    objects = LocalObjectStore(tmp_path)
    assets = await research_digest._capture_digest_assets(
        objects,
        "reader",
        "project",
        {"id": "post", "kind": "web", "title": "Why We Think"},
        Settings(),
        choices=[_asset_choice("web-fig1")],
        inventory=[{
            "id": "web-fig1", "kind": "figure", "section": "thinking-in-tokens",
            "locator": "https://example.test/fig1.png",
        }],
    )

    assert asked == [("https://example.test/fig1.png", "post")]
    [asset] = assets
    assert (asset.inventoryId, asset.kind, asset.section, asset.mimeType, asset.width, asset.height, asset.bytes) == (
        "web-fig1", "source-figure", "thinking-in-tokens", "image/webp", 640, 320, len(b"captured-webp"))
    key = research_digest.digest_asset_key("reader", "project", "post", asset.id, asset.mimeType)
    assert b"".join(objects.open_range(key)) == b"captured-webp"


def _digest_payload(body: str) -> str:
    import json

    return json.dumps(
        {
            "contentMarkdown": body,
            "citations": [
                {"id": 1, "claimType": "author-claim", "page": 1, "section": "Intro"}
            ],
            "assets": [],
        }
    )


def test_a_retry_is_checked_against_the_wall_it_was_decoded_at():
    """
    The corrective attempt narrows the schema's `maxLength` to give itself
    headroom; the truncation check compared against the module constant. So a
    retry force-closed at its *own* smaller wall passed cleanly and was stored
    -- measured as two of four digests in one rebuild landing on exactly
    `int(DIGEST_CONTENT_MAX_LENGTH * 0.8)` characters and ending mid-table.
    """
    retry_wall = int(DIGEST_CONTENT_MAX_LENGTH * 0.8)
    # Ends in punctuation, so only the length is under test here.
    body = "Fact [E1]. " + "x" * (retry_wall - 12) + "."
    assert len(body) == retry_wall

    # Against the full cap it is simply a long digest.
    validate_digest(
        _digest_payload(body), paper={"pages": 3}, web_sections=None
    )

    with pytest.raises(ValueError, match="hit the length cap"):
        validate_digest(
            _digest_payload(body),
            paper={"pages": 3},
            web_sections=None,
            content_max_chars=retry_wall,
        )


def test_a_digest_may_run_over_the_ask_but_not_away_from_it():
    """
    Ask 8,000, accept 12,000, decode at 16,000 -- three numbers, three jobs.

    Every real v7 digest overshoots the ask: the rehearsal corpus measured
    9,719-10,844 characters, so a ceiling at the ask would refuse all four.
    What was missing was any ceiling at all -- between the ask and the
    decoder's wall a digest could be twice what was requested and still be
    stored without comment. 50% is what separates an ordinary overshoot from
    one that ignored the brief.
    """
    from delphi_core.research_digest import (
        DIGEST_CONTENT_ACCEPT_LENGTH,
        DIGEST_CONTENT_MAX_LENGTH,
        DIGEST_CONTENT_SCHEMA_MAX,
    )

    assert (
        DIGEST_CONTENT_MAX_LENGTH
        < DIGEST_CONTENT_ACCEPT_LENGTH
        < DIGEST_CONTENT_SCHEMA_MAX
    )
    # The largest digest actually measured. It must not be refused.
    assert 10_844 <= DIGEST_CONTENT_ACCEPT_LENGTH

    def sized(length: int) -> str:
        digest = valid_digest()
        body = digest["contentMarkdown"]
        digest["contentMarkdown"] = body + " word" * ((length - len(body)) // 5) + "."
        return json.dumps(digest)

    accepted = sized(DIGEST_CONTENT_MAX_LENGTH + 2_000)
    validate_digest(accepted, paper={"pages": 2}, web_sections=None)

    with pytest.raises(ValueError, match="character ceiling"):
        validate_digest(
            sized(DIGEST_CONTENT_ACCEPT_LENGTH + 500),
            paper={"pages": 2},
            web_sections=None,
        )


def test_a_digest_cut_mid_word_is_refused_even_below_the_wall():
    """
    A constrained decoder can close a string just short of its wall, so length
    alone cannot see every truncation: one rebuild stored 7,999 characters
    against an 8,000 wall, ending "the difference is cle".

    The check is deliberately narrow -- only an ending that is unmistakably
    mid-word. Prose ends in punctuation, a table row in `|`, a fence in a
    backtick. A false positive costs a whole digest rebuild, so the bias is
    toward firing only on a clear breach.
    """
    with pytest.raises(ValueError, match="ends mid-word"):
        validate_digest(
            _digest_payload("The entropy gap [E1]. The difference is cle"),
            paper={"pages": 3},
            web_sections=None,
        )

    for ending in ("ends here [E1].", "| a | b [E1] |", "See [E1]:"):
        validate_digest(_digest_payload(ending), paper={"pages": 3}, web_sections=None)

    # A trailing delimiter is punctuation, but it is not therefore a complete
    # formula. The math check now owns this case before the truncation heuristic.
    with pytest.raises(ValueError, match="malformed LaTeX.*unclosed"):
        validate_digest(
            _digest_payload("$x^2$ [E1]$"),
            paper={"pages": 3},
            web_sections=None,
        )


@pytest.mark.asyncio
async def test_deterministic_rejection_keeps_ready_digest_without_a_semantic_call(tmp_path):
    settings, storage, objects, project, _ = seeded(tmp_path)
    rejecting = False
    calls = []

    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        assert payload["text"]["format"]["name"] == "research_digest"
        answer = valid_digest(page=99 if rejecting else 1)
        return httpx.Response(200, content=("data: " + json.dumps({
            "type": "response.output_text.delta", "delta": json.dumps(answer),
        }) + "\n\n").encode())

    key = paper_key("reader", project["id"], "paper-one", "digest")
    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        async for _ in generate_digest(client, storage, objects, "reader", project["id"], "paper-one", settings):
            pass
        assert len(calls) == 1
        before = objects.get_text(key)
        rejecting = True
        with pytest.raises(ValueError, match="between 1 and 2"):
            async for _ in generate_digest(client, storage, objects, "reader", project["id"], "paper-one", settings, force=True):
                pass
    assert len(calls) == 3
    assert objects.get_text(key) == before


@pytest.mark.asyncio
async def test_a_model_switch_keeps_saved_digests_readable_and_reusable(tmp_path):
    settings, storage, objects, project, _ = seeded(tmp_path)
    digest = valid_digest()
    text = objects.get_text(paper_key("reader", project["id"], "paper-one", "txt"))
    fingerprint = source_hash(text)
    metadata = {
        "status": "ready", "version": RESEARCH_DIGEST_VERSION,
        "model": "gpt-6-luna", "sourceHash": fingerprint,
    }
    storage.update_paper_snapshot("reader", project["id"], "paper-one", {"digest": metadata})
    objects.put_text(paper_key("reader", project["id"], "paper-one", "digest"), json.dumps({"digest": digest}))
    settings = settings.model_copy(update={"digest_model": "gpt-6-sol"})
    detail = digest_detail(project["id"], "paper-one", username="reader", storage=storage, objects=objects, settings=settings)
    assert detail["digest"] == digest
    assert detail["paper"]["digest"]["model"] == "gpt-6-luna"
    assert digest_is_valid(detail["paper"], fingerprint, settings)
    assert not digest_is_valid(detail["paper"], "changed-source", settings)
    assert not digest_is_valid({"digest": {**metadata, "version": "old-version"}}, fingerprint, settings)

    def no_provider(request):
        pytest.fail(f"Reusing a saved digest must not contact the provider: {request.url}")

    async with httpx.AsyncClient(transport=ProviderTransport(no_provider)) as client:
        events = [event async for event in generate_digest(
            client, storage, objects, "reader", project["id"], "paper-one", settings,
        )]
    assert events[-1]["reused"] is True
    assert events[-1]["digest"] == digest
    assert storage.get_paper("reader", project["id"], "paper-one")["digest"] == metadata


@pytest.mark.asyncio
async def test_digest_finishing_after_project_cleanup_removes_its_late_bytes(tmp_path, monkeypatch):
    """Cleanup runs before the final byte write, while the provider is still answering."""
    settings, storage, objects, project, paper = seeded(tmp_path)
    from delphi_core.storage import project_prefix
    from fastapi import HTTPException

    put_text = objects.put_text
    digest_key = paper_key("reader", project["id"], paper["id"], "digest")

    def late_write(key, value):
        if key == digest_key:
            storage.delete_project("reader", project["id"])
            objects.delete_prefix(project_prefix("reader", project["id"]))
        put_text(key, value)

    monkeypatch.setattr(objects, "put_text", late_write)
    transcript = "".join("data: " + json.dumps(event) + "\n\n" for event in [
        {"type": "response.output_text.delta", "delta": json.dumps(valid_digest())},
        {"type": "response.completed", "response": {"usage": {}}},
    ])
    async with httpx.AsyncClient(transport=ProviderTransport(
        lambda request: httpx.Response(200, text=transcript)
    )) as client:
        with pytest.raises(HTTPException) as raised:
            async for _ in generate_digest(client, storage, objects, "reader", project["id"], paper["id"], settings):
                pass
    assert raised.value.status_code == 404
    assert not objects.exists(digest_key)
    assert storage.list_projects("reader") == []


def test_a_digest_is_held_to_its_share_of_the_chat_block_when_it_is_written():
    """
    The block's ceiling is kept at the author, not by trimming at the reader.

    Ten documents share `digest_context_max_tokens`, so one document's share is
    a tenth of it. The count is of the whole digest — prose, evidence and
    figure choices — which is what a chat request carries; a digest a little
    over its share is ordinary and one well over it is rewritten.
    """
    from delphi_core.config import Settings
    from delphi_core.research_digest import DIGEST_TOKEN_ACCEPT_RATIO, digest_tokens

    settings = Settings()
    share = settings.digest_document_max_tokens
    assert share * settings.max_papers_per_project <= settings.digest_context_max_tokens

    def sized(chars: int) -> str:
        return _digest_payload("Fact [E1]. " + "x" * chars + ".")

    ordinary = sized(6_000)
    assert digest_tokens(json.loads(ordinary)) <= share
    validate_digest(ordinary, paper={"pages": 3}, web_sections=None, max_tokens=share)

    # Prose inside its own character ceiling can still be over the share once
    # the evidence and figures are counted, which is the case this guards. A
    # tighter share stands in for them here.
    tight = share * 2 // 3
    long = sized(11_000)
    assert digest_tokens(json.loads(long)) > tight * DIGEST_TOKEN_ACCEPT_RATIO
    with pytest.raises(ValueError, match="share of the chat context"):
        validate_digest(long, paper={"pages": 3}, web_sections=None, max_tokens=tight)
    # Without a share to hold it to, it is only a long digest.
    validate_digest(long, paper={"pages": 3}, web_sections=None)


@pytest.mark.asyncio
async def test_sse_cancellation_releases_digest_claim_before_normal_retry(tmp_path):
    import anyio
    settings, storage, objects, project, _ = seeded(tmp_path)
    async with httpx.AsyncClient() as client:
        with anyio.CancelScope() as cancellation:
            async for event in generate_digest(client,storage,objects,'reader',project['id'],'paper-one',settings):
                if event.get('stage') == 'digest_inventory':
                    cancellation.cancel()
    paper = storage.get_paper('reader',project['id'],'paper-one')
    assert paper['digest']['status']=='failed'
    assert not paper.get('digestClaim')


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["digest", "maintenance"])
@pytest.mark.parametrize("stage", ["digest_inventory", "digest_generate"])
@pytest.mark.parametrize("disconnect", ["close", "send-failure"])
async def test_closing_digest_response_between_progress_frames_releases_claim(tmp_path, route, stage, disconnect):
    from delphi_core.routers.digests import digest_stream
    from delphi_core.routers.memory import drain_memory_maintenance
    from delphi_core.schemas import DigestRequest
    settings, storage, objects, project, _ = seeded(tmp_path)
    response = (digest_stream(project['id'], 'paper-one', DigestRequest(), 'reader', storage, objects, settings)
                if route == "digest" else drain_memory_maintenance('reader', storage, objects, settings))
    if disconnect == "close":
        stream = response.body_iterator
        while True:
            frame = await anext(stream)
            if stage in frame:
                break
        assert storage.get_paper('reader', project['id'], 'paper-one')['digest']['status'] == 'pending'
        await stream.aclose()
    else:
        async def send(message):
            if stage.encode() in message.get("body", b""):
                raise OSError("Browser disconnected while receiving progress")
        with pytest.raises(OSError):
            await response.stream_response(send)
    paper = storage.get_paper('reader', project['id'], 'paper-one')
    assert paper['digest']['status'] == 'failed'
    # Public paper records omit digestClaim. Reclaiming immediately proves the
    # owned claim was actually released, not merely hidden from the response.
    assert storage.claim_digest('reader', project['id'], 'paper-one', claim_id='retry',
        expires_at='2030-01-01T00:00:00+00:00', metadata=paper['digest'], force=False) == 'claimed'
    if route == "maintenance":
        job = storage.list_memory_jobs('reader')[0]
        assert job['status'] == 'pending' and job['attempts'] == 0 and job['leaseExpiresAt'] is None


def test_an_outside_claim_is_cited_to_a_captured_source_and_nothing_else():
    """
    The `external` claim type exists only for a digest written with captured
    sources in front of it, and names one of them and a section it has. An
    address the model merely remembers is not evidence and is refused.
    """
    from delphi_core.memory import audit_schema
    from delphi_core.research_digest import digest_schema

    def claim_types(schema) -> set[str]:
        found: set[str] = set()

        def walk(node):
            if isinstance(node, dict):
                if "evidenceId" in (node.get("properties") or {}):
                    found.add("evidenceId")
                found.update(value for value in node.get("enum") or () if value == "external")
                for child in node.values():
                    walk(child)
            elif isinstance(node, list):
                for child in node:
                    walk(child)

        walk(schema)
        return found

    # Offered only when asked for: an ordinary digest and every page-writing
    # schema cannot produce a citation nothing could check.
    assert claim_types(digest_schema()) == set() == claim_types(audit_schema())
    assert claim_types(digest_schema(external=True)) == {"external", "evidenceId"}

    paper = {"id": "p", "title": "Paper", "pages": 9}

    def raw(citation: dict) -> str:
        return json.dumps({
            "contentMarkdown": "## What it shows\n\nThe paper reports the result. [E1] Later work qualifies it. [E2]",
            "citations": [{"id": 1, "claimType": "author-claim", "page": 3, "section": None, "evidenceId": "ev1"}, citation],
            "assets": [],
        })

    captured = {"ev1": {"Results", "limits"}}
    digest = validate_digest(
        raw({"id": 2, "claimType": "external", "page": 4, "section": "§results", "evidenceId": "ev1"}),
        paper=paper, web_sections=None, captured=captured,
    )
    document, outside = digest.citations
    # A claim about the document never borrows an outside source...
    assert (document.claimType, document.page, document.evidenceId) == ("author-claim", 3, None)
    # ...and an outside claim is stored with the captured page's own anchor.
    assert (outside.claimType, outside.evidenceId, outside.section, outside.page) == ("external", "ev1", "Results", None)

    for citation, message in (
        ({"id": 2, "claimType": "external", "page": None, "section": "results", "evidenceId": "ev-remembered"}, "not one of the captured sources"),
        ({"id": 2, "claimType": "external", "page": None, "section": "discussion", "evidenceId": "ev1"}, "does not have"),
        ({"id": 2, "claimType": "external", "page": None, "section": "results", "evidenceId": None}, "not one of the captured sources"),
    ):
        with pytest.raises(ValueError, match=message):
            validate_digest(raw(citation), paper=paper, web_sections=None, captured=captured)
    with pytest.raises(ValueError, match="not one of the captured sources"):
        validate_digest(raw({"id": 2, "claimType": "external", "page": None, "section": "results", "evidenceId": "ev1"}),
                        paper=paper, web_sections=None)


@pytest.mark.asyncio
async def test_a_digest_is_written_with_captured_outside_evidence_and_keeps_only_what_it_cites(tmp_path, monkeypatch):
    """
    The whole pipeline: a research pass finds two leads, one page bears its
    quote out and one does not, the author is shown only the one that did and
    may cite it as `external`, and what the digest cites is what is kept.
    """
    from delphi_core.harness import evidence as capture_module
    from delphi_core.web_fetch import FetchedResource

    settings, storage, objects, project, _ = seeded(tmp_path)
    settings = settings.model_copy(update={"digest_research_enabled": True})
    page = ("<html><head><title>A later erratum</title></head><body><article><h1>A later erratum</h1>"
            "<p>" + "An introduction long enough for the extractor to treat this page as an article worth reading in full. " * 8 + "</p>"
            "<h2 id=\"correction\">Correction</h2><p>The reported gain disappears once the baseline is tuned equally.</p>"
            "</article></body></html>")

    async def fetch(url, _settings, **_options):
        return FetchedResource(url=url, body=page.encode(), content_type="text/html", encoding="utf-8", fetched_at="2026-10-11T00:00:00+00:00")

    monkeypatch.setattr(capture_module, "fetch_resource", fetch)
    findings = {"findings": [
        {"claim": "A later erratum withdraws the gain.", "url": "https://example.org/erratum", "title": "Erratum",
         "quote": "The reported gain disappears once the baseline is tuned equally.", "bearsOn": "correction"},
        {"claim": "It was reproduced widely.", "url": "https://example.org/erratum", "title": "Erratum",
         "quote": "Dozens of independent groups have reproduced the reported gain exactly.", "bearsOn": "correction"},
    ], "unresolved": []}
    requests = []

    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        if payload["text"]["format"]["name"] == "research_findings":
            written = json.dumps(findings)
        else:
            shown = json.dumps(payload["input"])
            evidence_id = re.search(r'evidenceId=\\"([a-f0-9]+)', shown)[1]
            written = json.dumps({
                "contentMarkdown": "The paper reports a gain. [E1] A later erratum, outside this document, reports that it disappears with an equally tuned baseline. [E2]",
                "citations": [
                    {"id": 1, "claimType": "author-claim", "page": 1, "section": None, "evidenceId": None},
                    {"id": 2, "claimType": "external", "page": None, "section": "correction", "evidenceId": evidence_id},
                ],
                "assets": [],
            })
        return httpx.Response(200, content=f"data: {json.dumps({'type': 'response.output_text.delta', 'delta': written})}\n\n".encode())

    events = []
    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        async for event in generate_digest(client, storage, objects, "reader", project["id"], "paper-one", settings):
            events.append(event)

    research, author = requests
    # The research pass has only the web; the author has no tools at all.
    assert research["tools"] == [{"type": "web_search", "search_context_size": "medium"}] and "tools" not in author
    shown = json.dumps(author["input"])
    # Only the finding the page bore out reaches the author.
    assert "<outside_evidence>" in shown and "A later erratum withdraws the gain." in shown
    assert "reproduced widely" not in shown
    assert "claimType `external`" in author["instructions"]
    claim_types = author["text"]["format"]["schema"]["$defs"]["DigestCitation"]["properties"]["claimType"]["enum"]
    assert "external" in claim_types

    stored = load_digest(objects, "reader", project["id"], "paper-one")
    outside = stored["citations"][1]
    assert outside["claimType"] == "external" and outside["section"] == "correction"
    # What the digest cites is kept, readable, and named by the digest's metadata.
    record = storage.get_external_evidence("reader", outside["evidenceId"])
    assert record["url"] == "https://example.org/erratum" and [f["anchor"] for f in record["findings"]] == ["correction"]
    paper = storage.get_paper("reader", project["id"], "paper-one")
    assert paper["digest"]["evidenceIds"] == [outside["evidenceId"]]
    # The digest holds it, and so does the source page derived from that digest.
    assert storage.external_evidence_references("reader") == {outside["evidenceId"]: [
        {"kind": "digest", "paperId": "paper-one"}, {"kind": "page", "slug": "paper"}]}
    assert any(event.get("stage") == "digest_research" for event in events)


@pytest.mark.asyncio
async def test_a_research_pass_that_fails_still_leaves_a_whole_digest(tmp_path):
    settings, storage, objects, project, _ = seeded(tmp_path)
    settings = settings.model_copy(update={"digest_research_enabled": True})
    requests = []

    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload["text"]["format"]["name"])
        if payload["text"]["format"]["name"] == "research_findings":
            return httpx.Response(500, json={"error": {"message": "search is down"}})
        return httpx.Response(200, content=f"data: {json.dumps({'type': 'response.output_text.delta', 'delta': json.dumps({**valid_digest(), 'assets': []})})}\n\n".encode())

    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        async for _ in generate_digest(client, storage, objects, "reader", project["id"], "paper-one", settings):
            pass

    assert requests[-1] == "research_digest" and "research_findings" in requests
    stored = load_digest(objects, "reader", project["id"], "paper-one")
    assert [citation["claimType"] for citation in stored["citations"]] == ["author-claim"]
    assert storage.get_paper("reader", project["id"], "paper-one")["digest"]["evidenceIds"] == []


def test_a_capture_goes_when_the_document_whose_digest_cited_it_goes(tmp_path):
    from delphi_core.harness import evidence as capture_module

    settings, storage, objects, project, _ = seeded(tmp_path)
    settings = settings.model_copy(update={"external_evidence_reap_grace_seconds": 0})
    packet = capture_module.Packet(sources=[{
        "id": "ev1", "url": "https://example.org/a", "finalUrl": "https://example.org/a", "title": "A", "contentHash": "c" * 64,
        "capturedAt": "2026-10-11T00:00:00+00:00", "findings": [], "sections": [{"anchor": "top", "markdown": "text"}],
    }])
    capture_module.store(packet, storage, objects, "reader")
    assert storage.claim_digest("reader", project["id"], "paper-one", claim_id="c", expires_at="2999-01-01T00:00:00+00:00",
                                metadata={"status": "generating"}, force=True) == "claimed"
    storage.complete_digest("reader", project["id"], "paper-one", "c", {"status": "ready", "evidenceIds": ["ev1"]})

    # Cited: nothing to reap, and the bytes are there.
    assert capture_module.reap(storage, objects, "reader", settings) == 0
    assert capture_module.load_sections(objects, storage.get_external_evidence("reader", "ev1"))

    storage.delete_paper("reader", project["id"], "paper-one")
    assert capture_module.reap(storage, objects, "reader", settings) == 1
    with pytest.raises(Exception):
        storage.get_external_evidence("reader", "ev1")
    with pytest.raises(Exception):
        objects.get_text("knowledge/u/reader/evidence/ev1.json")


@pytest.mark.asyncio
async def test_regenerating_a_digest_rewrites_the_documents_memory_page_without_a_model(tmp_path):
    """
    A source page is its document's digest, copied. Regenerating the digest
    used to queue nothing, so the page kept the old text.
    """
    settings, storage, objects, project, paper = seeded(tmp_path)
    storage.upsert_memory_page("reader", {
        "kind": "source", "domain": "general", "title": "Paper", "slug": "paper", "summary": "The old digest.",
        "body": "What the old digest said.", "sourcePaperId": "paper-one", "sourceProjectId": project["id"],
    }, max_pages=50)
    before = storage.get_memory_page("reader", "paper")
    requests = []

    def handler(request):
        requests.append(json.loads(request.content)["text"]["format"]["name"])
        digest = {"contentMarkdown": "What the regenerated digest says. [E1]", "citations": [evidence()], "assets": []}
        return httpx.Response(200, content=f"data: {json.dumps({'type': 'response.output_text.delta', 'delta': json.dumps(digest)})}\n\n".encode())

    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        async for _ in generate_digest(client, storage, objects, "reader", project["id"], "paper-one", settings, force=True):
            pass

    # One model call: the digest. The page was derived from it.
    assert requests == ["research_digest"]
    after = storage.get_memory_page("reader", "paper")
    assert "What the regenerated digest says." in after["body"] and "old digest" not in after["body"]
    assert after["revision"] > before["revision"] and after["kind"] == "source"
