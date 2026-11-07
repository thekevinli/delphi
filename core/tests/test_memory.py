"""
What `delphi_core.memory` still serves beside the maintenance pipeline: Memory's
routes, the reorganize, lint and health passes, the durable job queue, and the
source page a digest becomes.

An edit's own checks (citations held to the run's evidence set, a body's
shape) belong to the pipeline and are tested with it (`test_memory_validate.py`,
`test_memory_gather.py`).
"""

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from tests.chat_keys import conversation_params
from delphi_core.config import Settings, get_settings
from delphi_core.memory import (
    MEMORY_VERSION,
    MemoryPageUpsert,
    audit_schema,
    clean_memory_summary,
    index_lines,
    page_record,
    reorganization_schema,
)
from delphi_core.memory_health import (
    orphan_pages,
    uncaptured_figures,
)
from delphi_core.main import app
from delphi_core.research_digest import RESEARCH_DIGEST_VERSION, digest_evidence_labels
from delphi_core.storage import LocalObjectStore, LocalStorage, paper_key
from tests.helpers import MINIMAL_PDF, seed_paper
from tests.helpers import ProviderTransport

pytestmark = pytest.mark.kb_maintenance


def update(**overrides):
    page = {
        "slug": "kl-divergence",
        "kind": "concept",
        "domain": "ml",
        "title": "KL divergence",
        "summary": "why it appears in the ELBO",
        "bodyMarkdown": "The second term penalises drift from the prior [E1].",
        "tags": [],
        "note": "wrote the ELBO's second term down",
        "citations": [
            {
                "id": 1,
                "claimType": "author-claim",
                "paperId": "paper-a",
                "page": 3,
                "section": None,
            }
        ],
        **overrides.pop("page", {}),
    }
    return json.dumps(
        {
            "pages": [page],
            "logEntry": "Filed one concept.",
            "method": "Checked §3 of the VAE paper.",
            **overrides,
        }
    )


def test_summary_drops_complete_or_partial_evidence_markers_before_bounding():
    summary = "A useful explanation that belongs in listings. [E"

    assert clean_memory_summary(summary) == "A useful explanation that belongs in listings."
    page = MemoryPageUpsert.model_validate(
        json.loads(update(page={"summary": summary}))["pages"][0]
    )
    stored = page_record(page, Settings(memory_summary_max_chars=32))["summary"]
    assert stored == "A useful explanation that…"
    assert len(stored) <= 32


def test_digest_evidence_labels_follow_headings_and_specific_bullet_leads():
    labels = digest_evidence_labels(
        """# DeepSeek V4

**Document.** A preview report. [E1]

## Architecture

- **Overall stack.** The retained and new components. [E4]
- **Muon.** The optimizer split. [E8]

The section-level consequence remains here. [E9]
"""
    )

    assert labels == {
        1: "Document",
        4: "Overall stack",
        8: "Muon",
        9: "Architecture",
    }


@pytest.mark.asyncio
async def test_memory_update_waits_for_short_provider_capacity(
    tmp_path, monkeypatch
):
    import httpx

    from delphi_core import memory as memory_module

    settings = Settings(
        data_dir=tmp_path,
        openai_api_key="test-key",
        openai_api_base_url="https://api.openai.test/v1",
    )
    calls = 0
    delays = []

    async def fake_sleep(delay):
        delays.append(delay)

    monkeypatch.setattr(memory_module.asyncio, "sleep", fake_sleep)

    def handler(_request):
        nonlocal calls
        calls += 1
        if calls < 3:
            return httpx.Response(429, headers={"retry-after": "0.5"})
        return httpx.Response(
            200,
            json={
                "output": [
                    {"content": [{"type": "output_text", "text": update()}]}
                ]
            },
        )

    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        raw = await memory_module._provider_update(
            client,
            settings=settings,
            index="(empty)",
            use_standard_tier=False,
            instructions="Check the pages.",
            task={"type": "input_text", "text": "<pages>none</pages>"},
            schema=audit_schema(),
            schema_name="knowledge_audit",
        )

    assert calls == 3
    assert delays == [0.5, 0.5]
    assert json.loads(raw)["pages"][0]["slug"] == "kl-divergence"


@pytest.mark.asyncio
async def test_memory_update_preserves_provider_rejection_detail(tmp_path):
    import httpx

    from delphi_core import memory as memory_module

    settings = Settings(
        data_dir=tmp_path,
        openai_api_key="test-key",
        openai_api_base_url="https://api.openai.test/v1",
    )

    def handler(_request):
        return httpx.Response(
            400,
            json={
                "error": {
                    "message": "Invalid schema for response_format: unsupported keyword.",
                    "param": "text.format.schema",
                    "code": "invalid_json_schema",
                }
            },
        )

    async with httpx.AsyncClient(transport=ProviderTransport(handler)) as client:
        with pytest.raises(RuntimeError) as caught:
            await memory_module._provider_update(
                client,
                settings=settings,
                index="(empty)",
                use_standard_tier=False,
                instructions="Check the pages.",
                task={"type": "input_text", "text": "<pages>none</pages>"},
                schema=audit_schema(),
                schema_name="knowledge_audit",
            )

    detail = str(caught.value)
    assert "Invalid schema for response_format" in detail
    assert "parameter text.format.schema" in detail
    assert "code invalid_json_schema" in detail
    assert "api.openai.test" not in detail


# --- what the ingest is given -------------------------------------------


@pytest.mark.asyncio
async def test_a_compound_figure_uses_the_guarded_static_browser_capture(
    tmp_path, monkeypatch
):
    from io import BytesIO

    from PIL import Image, ImageDraw

    from delphi_core import dashboard as dashboard_module
    from delphi_core import memory as memory_module

    screenshot = tmp_path / "compound.png"
    page = Image.new("RGB", (1024, 1024), "white")
    draw = ImageDraw.Draw(page)
    draw.rectangle((100, 100, 900, 600), fill="#663d22")
    page.save(screenshot)
    called = {}

    async def capture(source_url, html, settings, **options):
        called.update(source_url=source_url, html=html, options=options)
        return screenshot

    monkeypatch.setattr(dashboard_module, "capture_static_html", capture)
    payload, width, height, extension = await memory_module._capture_html_figure(
        "<html><body><figure>complete diagram</figure></body></html>",
        "https://example.test/post",
        Settings(data_dir=tmp_path, memory_figure_max_side=512),
    )

    assert called["source_url"] == "https://example.test/post"
    assert called["options"] == {"viewport_width": 1512, "viewport_height": 1512}
    assert "complete diagram" in called["html"]
    assert extension == "webp"
    assert max(width, height) <= 512
    assert (width, height) != (512, 512)
    assert not screenshot.exists()
    with Image.open(BytesIO(payload)) as captured:
        assert captured.format == "WEBP"


@pytest.mark.asyncio
async def test_an_external_svg_keeps_embedded_styles_and_uses_the_guarded_fetcher(
    tmp_path, monkeypatch
):
    from delphi_core import memory as memory_module
    from delphi_core import web_fetch
    from delphi_core.web_fetch import FetchedResource

    called = []

    async def fetch(url, settings, **options):
        called.append((url, options))
        return FetchedResource(
            url=url,
            body=(
                b'<svg viewBox="0 0 400 200" class="architecture">'
                b'<style>.architecture .node{fill:#edc}</style>'
                b'<rect class="node" width="400" height="200"/></svg>'
            ),
            content_type="image/svg+xml",
            encoding="utf-8",
            fetched_at="2026-08-17T00:00:00Z",
        )

    monkeypatch.setattr(web_fetch, "fetch_resource", fetch)
    payload, width, height, extension = await memory_module._capture_web_figure(
        "https://cdn.example.test/architecture.svg",
        Settings(data_dir=tmp_path),
        objects=LocalObjectStore(tmp_path),
        username="reader",
        project_id="project-a",
        paper_id="page-b",
    )

    assert called == [
        (
            "https://cdn.example.test/architecture.svg",
            {"include_images": True, "include_svg": True},
        )
    ]
    assert b'class="architecture"' in payload
    assert b".architecture .node" in payload
    assert (width, height, extension) == (400, 200, "svg")


def test_the_index_names_slugs_the_model_can_revise():
    lines = index_lines(
        [
            {
                "slug": "kl-divergence",
                "kind": "concept",
                "domain": "ml",
                "title": "KL divergence",
            }
        ]
    )

    assert "[[kl-divergence]]" in lines
    assert "concept/ml" in lines
    assert "no knowledge pages yet" in index_lines([])


# --- proposing a re-filing, never applying one ---------------------------


REORG_PAGES = [
    {"slug": "machine-learning", "kind": "domain", "domain": "machine-learning",
     "title": "Machine learning", "summary": "domain page"},
    {"slug": "kv-cache", "kind": "concept", "domain": "machine-learning",
     "title": "KV cache", "summary": "s"},
    {"slug": "fingerpicking", "kind": "concept", "domain": "guitar",
     "title": "Fingerpicking", "summary": "s"},
]
REORG_DOMAINS = [
    {"slug": "machine-learning", "title": "Machine learning"},
    {"slug": "efficiency-serving", "title": "Efficiency & serving"},
    {"slug": "guitar", "title": "Guitar"},
]


def reorg(moves):
    return json.dumps({"moves": moves, "method": "Compared titles to domains."})


def test_a_proposed_move_that_names_a_real_page_and_domain_survives():
    from delphi_core.memory import validate_reorganization

    update = validate_reorganization(
        reorg([{"slug": "kv-cache", "to": "efficiency-serving", "why": "serving"}]),
        pages=REORG_PAGES,
        domains=REORG_DOMAINS,
    )
    assert [(m.slug, m.to) for m in update.moves] == [
        ("kv-cache", "efficiency-serving")
    ]


def test_a_move_naming_something_that_does_not_exist_is_dropped():
    from delphi_core.memory import validate_reorganization

    # Unlike an invented citation this cannot mislead anyone — it simply
    # cannot be applied — so it is dropped rather than raised, and the good
    # proposals beside it survive.
    update = validate_reorganization(
        reorg([
            {"slug": "no-such-page", "to": "guitar", "why": "x"},
            {"slug": "kv-cache", "to": "no-such-domain", "why": "x"},
            {"slug": "kv-cache", "to": "efficiency-serving", "why": "serving"},
        ]),
        pages=REORG_PAGES,
        domains=REORG_DOMAINS,
    )
    assert [m.slug for m in update.moves] == ["kv-cache"]


def test_a_domain_page_is_never_moved_out_of_the_domain_it_names():
    from delphi_core.memory import validate_reorganization

    # A domain page *is* its domain; moving one leaves the domain without the page that
    # explains it.
    update = validate_reorganization(
        reorg([{"slug": "machine-learning", "to": "guitar", "why": "x"}]),
        pages=REORG_PAGES,
        domains=REORG_DOMAINS,
    )
    assert update.moves == []


def test_a_move_to_where_the_page_already_sits_is_not_a_move():
    from delphi_core.memory import validate_reorganization

    update = validate_reorganization(
        reorg([{"slug": "fingerpicking", "to": "guitar", "why": "x"}]),
        pages=REORG_PAGES,
        domains=REORG_DOMAINS,
    )
    assert update.moves == []


def test_the_same_page_proposed_twice_moves_once():
    from delphi_core.memory import validate_reorganization

    update = validate_reorganization(
        reorg([
            {"slug": "kv-cache", "to": "efficiency-serving", "why": "first"},
            {"slug": "kv-cache", "to": "guitar", "why": "second"},
        ]),
        pages=REORG_PAGES,
        domains=REORG_DOMAINS,
    )
    assert [(m.slug, m.to) for m in update.moves] == [
        ("kv-cache", "efficiency-serving")
    ]


def test_a_base_with_one_domain_proposes_nothing_without_a_model_call(tmp_path):
    import asyncio

    from delphi_core.memory import propose_reorganization

    settings = Settings(data_dir=tmp_path)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    storage.upsert_memory_page(
        "reader",
        {"kind": "concept", "domain": "ml", "title": "KL", "summary": "s",
         "body": "Body."},
        max_pages=50,
    )

    # With one domain there is nowhere to move anything, so the honest answer is
    # "nothing to propose" rather than a model call that must return [].
    # `client=None` proves no request is made.
    result = asyncio.run(
        propose_reorganization(None, storage, "reader", settings)
    )
    assert result["moves"] == []


def test_the_reorganize_route_proposes_and_the_move_route_applies(tmp_path, monkeypatch):
    """
    The two halves of a re-filing, and the line between them: the pass only
    ever *proposes*, and nothing in the base changes until the reader posts the
    moves they accepted.
    """
    import httpx

    from delphi_core import memory as memory_module

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        openai_api_key="test-key",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            for title, domain in (("KV cache", "ml"), ("Fingerpicking", "guitar")):
                storage.upsert_memory_page(
                    "reader",
                    {"kind": "concept", "domain": domain, "title": title,
                     "summary": "s", "body": "Body."},
                    max_pages=50,
                )

            proposal = {
                "moves": [
                    {"slug": "kv-cache", "to": "guitar", "why": "misfiled"},
                    # Refused on the way out: the domain does not exist, so the
                    # move could never be applied.
                    {"slug": "kv-cache", "to": "invented", "why": "nope"},
                ],
                "method": "Compared every page to every domain.",
            }

            def handler(request: httpx.Request) -> httpx.Response:
                return httpx.Response(200, json={
                    "output": [{"content": [
                        {"type": "output_text", "text": json.dumps(proposal)}
                    ]}]
                })

            transport = ProviderTransport(handler)
            original = httpx.AsyncClient

            def fake_client(*args, **kwargs):
                kwargs["transport"] = transport
                return original(*args, **kwargs)

            monkeypatch.setattr(
                __import__("delphi_core.routers.memory", fromlist=["httpx"]).httpx,
                "AsyncClient",
                fake_client,
            )
            monkeypatch.setattr(memory_module.httpx, "AsyncClient", fake_client)

            def streamed_events():
                with client.stream("POST", "/api/memory/reorganize/stream") as streamed:
                    assert streamed.status_code == 200
                    return [
                        json.loads(line.removeprefix("data: "))
                        for line in streamed.iter_lines()
                        if line.startswith("data: ")
                    ]

            body = streamed_events()[-1]
            assert body["type"] == "done"
            assert [m["slug"] for m in body["moves"]] == ["kv-cache"]
            assert body["moves"][0]["from"] == "ml"
            assert body["moves"][0]["to"] == "guitar"

            # The route sends a first byte immediately and heartbeats while the
            # model works, so the edge never replaces a healthy proposal with a
            # 524 response.
            import asyncio

            from delphi_core.routers import memory as memory_router

            async def delayed_proposal(*args, **kwargs):
                await asyncio.sleep(0.012)
                return {**body, "domains": storage.memory_domains("reader")}

            monkeypatch.setattr(
                memory_router, "propose_reorganization", delayed_proposal
            )
            monkeypatch.setattr(
                memory_router, "REORGANIZE_HEARTBEAT_SECONDS", 0.002
            )
            events = streamed_events()
            assert events[0]["type"] == "progress"
            assert sum(event["type"] == "progress" for event in events) >= 2
            assert events[-1]["type"] == "done"
            assert events[-1]["moves"][0]["slug"] == "kv-cache"

            # Proposing changed nothing.
            assert (
                client.get("/api/memory/pages/kv-cache").json()["page"]["domain"]
                == "ml"
            )

            applied = client.post(
                "/api/memory/pages/move",
                json={"slugs": ["kv-cache"], "domain": "guitar"},
            )
            assert applied.status_code == 200
            assert (
                client.get("/api/memory/pages/kv-cache").json()["page"]["domain"]
                == "guitar"
            )
    finally:
        app.dependency_overrides.clear()


# --- what is wrong with the base's shape ---------------------------------
#
# Every case here is arithmetic the model is never asked for. The reason is on
# record: the one lint bug this repository has seen was a model handed the
# unresolved half of the link graph under a heading that said "link graph",
# concluding honestly and wrongly that every page was an orphan. These
# assertions are the fence around that.


def health_page(slug, **fields):
    return {
        "id": f"id-{slug}",
        "slug": slug,
        "kind": "concept",
        "domain": "ml",
        "title": slug.replace("-", " ").capitalize(),
        "linkDegree": 0,
        **fields,
    }


def test_a_page_no_link_touches_in_either_direction_is_an_orphan():
    orphans = orphan_pages(
        [health_page("kl-divergence"), health_page("vae", linkDegree=2)]
    )

    assert [finding["slug"] for finding in orphans] == ["kl-divergence"]


def test_a_page_only_ever_linked_to_is_not_an_orphan():
    # The recorded bug, as an assertion. `linkDegree` counts both columns, so a
    # page that is purely a destination is the opposite of orphaned.
    assert orphan_pages([health_page("machine-learning", linkDegree=7)]) == []


def test_a_figure_kept_as_a_link_names_the_page_that_shows_the_hole():
    findings = uncaptured_figures(
        [health_page("deepseek-r1")],
        [
            {"id": "f1", "pageId": "id-deepseek-r1", "caption": "The router",
             "captured": False, "sourceUrl": "https://example.test/f.png"},
            {"id": "f2", "pageId": "id-deepseek-r1", "caption": "Kept",
             "captured": True},
        ],
    )

    assert [finding["id"] for finding in findings] == ["f1"]
    assert findings[0]["pageSlug"] == "deepseek-r1"


def test_health_needs_no_model_provider(tmp_path):
    # The counters are arithmetic. A reader with no provider configured is
    # entitled to them, which is why this route carries no `api_key` guard
    # while `/lint` answers 503.
    # Built here rather than through `signed_in`, which reads `../.env` and so
    # picks up whatever key the machine running the suite happens to have.
    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        openai_api_key="",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            storage.upsert_memory_page(
                "reader",
                {"kind": "concept", "domain": "ml", "title": "VAE", "summary": "s",
                 "body": "Rests on [[kl-divergence]]."},
                max_pages=50,
            )

            payload = client.get("/api/memory/health").json()
            assert payload["pages"] == 1
            # A link with no page behind it is not a finding of its own.
            assert "unexplained" not in payload
            # `vae` links out, so it is not an orphan; nothing has ever checked,
            # so there is no lint tier at all — which the tab shows as a dash
            # rather than as a zero.
            assert payload["orphans"] == []
            assert payload["lastCheck"] is None
            assert client.post("/api/memory/lint").status_code == 503
    finally:
        app.dependency_overrides.clear()


def test_health_still_finds_a_lint_buried_under_newer_events(tmp_path):
    # Same windowing failure `has_memory_event` exists to stop: after a busy
    # Update the lint scrolls out of the mixed 50-event page, and the Health
    # tab would claim nobody ever looked while contradictions sit on disk.
    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        openai_api_key="",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            storage.append_memory_event(
                "reader",
                {
                    "kind": "lint",
                    "summary": "Checked the base.",
                    "contradictions": [],
                    "questions": [],
                },
            )
            for index in range(60):
                storage.append_memory_event(
                    "reader",
                    {"kind": "document", "summary": f"Filed paper {index}."},
                )

            # The listing's window no longer holds it.
            assert "lint" not in {
                event.get("kind")
                for event in storage.list_memory_events("reader", limit=50)
            }

            payload = client.get("/api/memory/health").json()
            assert payload["lastCheck"] is not None
            assert payload["lastCheck"]["kind"] == "lint"
            assert payload["lastCheck"]["summary"] == "Checked the base."
            assert payload["lastCheck"]["contradictions"] == []
    finally:
        app.dependency_overrides.clear()


# --- scoping one question to the domains it is actually about --------------


def page(slug, domain, score=None):
    entry = {"slug": slug, "domain": domain, "title": slug, "summary": ""}
    if score is not None:
        entry["score"] = score
    return entry


# --- the routes ----------------------------------------------------------


def signed_in(tmp_path):
    settings = Settings(data_dir=tmp_path, session_secret="test-session-secret")
    app.dependency_overrides[get_settings] = lambda: settings
    return settings


def test_the_memory_needs_a_session(tmp_path):
    signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            assert client.get("/api/memory").status_code == 401
            assert client.get("/api/memory/pages/anything").status_code == 401
            assert client.get("/api/memory/figures/anything").status_code == 401
    finally:
        app.dependency_overrides.clear()


def test_a_durable_job_survives_a_new_storage_instance_and_drains_once(
    tmp_path, monkeypatch
):
    from delphi_core.routers import memory as memory_router

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        openai_api_key="test-key",
    )
    app.dependency_overrides[get_settings] = lambda: settings

    async def fake_run(job, *, storage, username, **_kwargs):
        storage.append_memory_event(
            username,
            {"kind": job["kind"], "requestId": job["marker"], "pages": []},
        )
        yield {"type": "_memory_result", "pages": [], "reused": False}

    monkeypatch.setattr(memory_router, "run_maintenance_job", fake_run)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            first = LocalStorage(settings)
            project = first.create_project("reader", "Queued")
            first.add_paper(
                "reader",
                project["id"],
                {"id": "paper-a", "title": "A", "filename": "a.pdf"},
            )

            # Recreate storage as a later request or process would. The work is
            # in account JSON, not in the tab or the LocalStorage instance.
            assert len(LocalStorage(settings).list_memory_jobs("reader")) == 1
            status = client.get("/api/memory/maintenance").json()
            assert status["pending"] == 1
            assert status["failed"] == 0

            drained = client.post("/api/memory/maintenance/drain")
            assert drained.status_code == 200
            assert '"claimed": true' in drained.text
            assert LocalStorage(settings).list_memory_jobs("reader") == []
            assert LocalStorage(settings).has_memory_event(
                "reader", "paper:paper-a"
            )

            empty = client.post("/api/memory/maintenance/drain")
            assert '"claimed": false' in empty.text
            assert len(LocalStorage(settings).list_memory_events("reader")) == 1
    finally:
        app.dependency_overrides.clear()


def test_a_failed_maintenance_job_is_retained_and_can_be_reset(tmp_path, monkeypatch):
    from delphi_core.routers import memory as memory_router

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        openai_api_key="test-key",
    )
    app.dependency_overrides[get_settings] = lambda: settings

    async def fail_job(*_args, **_kwargs):
        raise RuntimeError("temporary provider failure")
        yield  # pragma: no cover - keeps this an async generator

    monkeypatch.setattr(memory_router, "run_maintenance_job", fail_job)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            job = storage.enqueue_memory_job(
                "reader",
                kind="document",
                marker="paper:missing",
                payload={"projectId": "missing", "paperId": "missing"},
            )
            response = client.post("/api/memory/maintenance/drain")
            assert '"type": "error"' in response.text
            failed = client.get("/api/memory/maintenance").json()
            assert failed["failed"] == 1
            assert failed["jobs"][0]["retryAt"]

            reset = client.post(
                f"/api/memory/maintenance/jobs/{job['id']}/retry"
            )
            assert reset.status_code == 200
            assert reset.json()["status"] == "pending"
            assert reset.json()["attempts"] == 0
    finally:
        app.dependency_overrides.clear()


def test_an_update_run_outlives_the_tab_that_started_it(tmp_path):
    """
    The reader can leave. The Update pass runs in one browser, so without a
    record every other surface — and the same surface after a reload — showed
    nothing at all while a library was filing.

    A `running` record whose heartbeat stopped is the run's documented end, not
    a live one, and `stale` is derived on read because the only thing that
    could have written it is the tab that is gone.
    """
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            assert client.get("/api/memory/update").json() == {"update": None}

            live = client.put(
                "/api/memory/update",
                json={
                    "status": "running",
                    "total": 21,
                    "processed": 3,
                    "filed": 3,
                    "skipped": 0,
                    "failures": 0,
                },
            ).json()["update"]
            assert live["stale"] is False
            assert live["startedAt"] and live["heartbeatAt"]
            assert live["finishedAt"] is None

            # A second tick keeps the run's one start rather than restarting it.
            again = client.put(
                "/api/memory/update",
                json={
                    "status": "running",
                    "total": 21,
                    "processed": 7,
                    "filed": 7,
                    "skipped": 0,
                    "failures": 0,
                },
            ).json()["update"]
            assert again["startedAt"] == live["startedAt"]

            # A heartbeat that stopped is a tab that went away.
            storage = LocalStorage(settings)
            storage.set_memory_update(
                "reader",
                {**again, "heartbeatAt": "2020-01-01T00:00:00+00:00"},
            )
            assert client.get("/api/memory/update").json()["update"]["stale"] is True

            done = client.put(
                "/api/memory/update",
                json={
                    "status": "done",
                    "total": 21,
                    "processed": 21,
                    "filed": 20,
                    "skipped": 0,
                    "failures": 1,
                    "detail": "20 filed, 1 could not be read.",
                },
            ).json()["update"]
            assert done["finishedAt"] and done["stale"] is False

            client.delete("/api/memory/update")
            assert client.get("/api/memory/update").json() == {"update": None}
    finally:
        app.dependency_overrides.clear()


def test_a_document_the_reader_already_filed_is_not_offered_as_unfiled(tmp_path):
    """
    The Reader's card asks the record, not the graph.

    A document with no page in the graph is four different situations, and the
    card used to offer "File it now" for all of them — including the one where
    the reader had already pressed it and the work was queued, which is how the
    button came to look like it did nothing.
    """
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            project = storage.create_project("reader", "Filing")
            storage.add_paper(
                "reader",
                project["id"],
                {"id": "paper-a", "title": "A", "filename": "a.pdf"},
            )

            # Which situation this is, rather than which keys the route
            # happens to answer with: the card branches on these four and a
            # literal dict here fails every time one grows a fifth.
            def situation(paper_id):
                answer = client.get(
                    f"/api/memory/documents/{paper_id}/filing"
                ).json()
                return {
                    key: answer[key]
                    for key in ("filed", "queued", "stuck", "stale")
                }

            # Adding it queued its `document` job, so nothing is owed from
            # the reader yet.
            assert situation("paper-a") == {
                "filed": False, "queued": True, "stuck": False, "stale": False,
            }

            # An unrelated document shares neither the marker nor the job.
            assert situation("paper-b") == {
                "filed": False, "queued": False, "stuck": False, "stale": False,
            }

            for job in storage.list_memory_jobs("reader"):
                storage.complete_memory_job("reader", job["id"])
            storage.append_memory_event(
                "reader",
                {
                    "kind": "document",
                    "requestId": "paper:paper-a",
                    "version": MEMORY_VERSION,
                    "pages": [],
                },
            )
            assert situation("paper-a") == {
                "filed": True, "queued": False, "stuck": False, "stale": False,
            }

            # The fifth situation, and the one nothing could see before: filed,
            # with pages, by a pass Delphi has replaced. It is not "unfiled" —
            # offering to file it would be a lie about what is in the wiki — and
            # it is not settled either.
            storage.append_memory_event(
                "reader",
                {
                    "kind": "document",
                    "requestId": "paper:paper-b",
                    "version": "knowledge-v1",
                    "pages": [],
                },
            )
            assert situation("paper-b") == {
                "filed": True, "queued": False, "stuck": False, "stale": True,
            }
            # Served, not spelled by the client, so a bump needs no frontend
            # release to be noticed.
            answer = client.get("/api/memory/documents/paper-b/filing").json()
            assert answer["version"] == MEMORY_VERSION
            assert answer["filedVersion"] == "knowledge-v1"
    finally:
        app.dependency_overrides.clear()


def test_a_page_and_its_backlinks_are_served_together(tmp_path):
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            storage.upsert_memory_page(
                "reader",
                {"kind": "concept", "domain": "ml", "title": "VAE", "summary": "s",
                 "body": "Rests on [[kl-divergence]]."},
                max_pages=50,
            )
            storage.upsert_memory_page(
                "reader",
                {"kind": "concept", "domain": "ml", "title": "KL divergence",
                 "summary": "s", "body": "Body."},
                max_pages=50,
            )

            payload = client.get("/api/memory/pages/kl-divergence").json()
            assert payload["page"]["title"] == "KL divergence"
            # A wiki without backlinks is a pile of pages.
            assert [item["slug"] for item in payload["backlinks"]] == ["vae"]
    finally:
        app.dependency_overrides.clear()


def test_a_page_names_the_documents_it_was_compiled_from(tmp_path):
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            project = storage.create_project("reader", "Reading")
            seed_paper(
                settings,
                "reader",
                project["id"],
                {"id": "paper-a", "title": "DeepSeek R1", "filename": "r1.pdf"},
                MINIMAL_PDF,
                "text",
            )
            storage.upsert_memory_page(
                "reader",
                {
                    "kind": "concept",
                    "domain": "ml",
                    "title": "Knowledge distillation",
                    "summary": "s",
                    "body": "Body. [E1][E2][E3]",
                    "citations": [
                        {"id": 1, "claimType": "author-claim", "paperId": "paper-a",
                         "page": 2, "section": "page-2"},
                        {"id": 2, "claimType": "author-claim", "paperId": "paper-a",
                         "page": 4, "section": "results"},
                        {"id": 3, "claimType": "author-claim", "paperId": "ghost",
                         "page": 1, "section": None},
                    ],
                },
                max_pages=50,
            )

            sources = client.get(
                "/api/memory/pages/knowledge-distillation"
            ).json()["sources"]

            assert [item["paperId"] for item in sources] == ["paper-a", "ghost"]
            # Grouped per document, so the rail says "2 passages" rather than
            # printing an opaque id twice.
            assert sources[0]["title"] == "DeepSeek R1"
            assert sources[0]["passages"] == 2
            assert sources[0]["pages"] == [2, 4]
            # `page-2` is what the page number already says; only a real anchor
            # earns a line of its own.
            assert sources[0]["sections"] == ["results"]
            assert sources[0]["available"] is True
            # A deleted document keeps its citation rather than losing it —
            # provenance survives the paper, and the lint pass reports it.
            assert sources[1]["available"] is False
            assert sources[1]["title"] is None
    finally:
        app.dependency_overrides.clear()


def test_pdf_citations_gain_display_titles_from_their_validated_digest(tmp_path):
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            objects = LocalObjectStore(settings.data_dir)
            project = storage.create_project("reader", "Reading")
            seed_paper(
                settings,
                "reader",
                project["id"],
                {"id": "paper-a", "title": "DeepSeek V4", "filename": "v4.pdf"},
                MINIMAL_PDF,
                "text",
            )
            objects.put_text(
                paper_key("reader", project["id"], "paper-a", "digest"),
                json.dumps(
                    {
                        "version": "research-digest-v5",
                        "sourceHash": "unused-in-this-read-path",
                        "digest": {
                            "contentMarkdown": (
                                "## Architecture\n\n"
                                "- **Overall stack.** Components. [E4]\n"
                                "- **Muon optimizer.** Training. [E8]"
                            ),
                            "citations": [
                                {"id": 4, "claimType": "author-claim", "page": 6,
                                 "section": None},
                                {"id": 8, "claimType": "author-claim", "page": 14,
                                 "section": None},
                            ],
                        },
                    }
                ),
            )
            storage.upsert_memory_page(
                "reader",
                {
                    "kind": "source",
                    "domain": "ml",
                    "title": "DeepSeek V4",
                    "summary": "s",
                    "body": "Architecture [E4] and optimization [E8].",
                    "citations": [
                        {"id": 4, "claimType": "author-claim", "paperId": "paper-a",
                         "page": 6, "section": None},
                        {"id": 8, "claimType": "author-claim", "paperId": "paper-a",
                         "page": 14, "section": None},
                    ],
                },
                max_pages=50,
            )

            citations = client.get(
                "/api/memory/pages/deepseek-v4"
            ).json()["page"]["citations"]

            assert citations[0]["sectionTitle"] == "Overall stack"
            assert citations[1]["sectionTitle"] == "Muon optimizer"
            # It is response decoration, not a second stored locator.
            assert "sectionTitle" not in storage.get_memory_page(
                "reader", "deepseek-v4"
            )["citations"][0]
    finally:
        app.dependency_overrides.clear()


def test_the_overview_lists_a_dropped_page_without_the_page_as_staged(tmp_path):
    """The log keeps a dropped page's staged body for diagnosis; a listing carries no bodies."""
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post("/api/auth/register", json={"username": "reader", "password": "password-123"})
            LocalStorage(settings).append_memory_event("reader", {
                "kind": "document", "marker": "paper:p1", "requestId": "paper:p1", "outcome": "filed",
                "dropped": [{"slug": "heterop", "title": "HeteroP", "action": "create",
                             "reason": "The 4.1x is the complete configuration's.", "quote": "4.1x from HeteroP",
                             "unstruck": "the next sentence refers back to the one that would go",
                             "body": "## Gains\n\nThe paper reports 4.1x from HeteroP [E1]. It is the largest.\n",
                             "summary": "HeteroP gives 4.1x."}],
            })
            listed = client.get("/api/memory").json()["events"][0]["dropped"][0]
            assert "body" not in listed and "summary" not in listed
            assert listed["unstruck"] == "the next sentence refers back to the one that would go"
            # The log itself still holds it.
            assert "It is the largest." in LocalStorage(settings).list_memory_events("reader")[0]["dropped"][0]["body"]
    finally:
        app.dependency_overrides.clear()


def test_domains_can_be_named_reordered_and_refilled_by_the_reader(tmp_path):
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            for title in ("KV cache", "Mixed precision"):
                storage.upsert_memory_page(
                    "reader",
                    {"kind": "concept", "domain": "ml", "title": title,
                     "summary": "s", "body": "Body."},
                    max_pages=50,
                )

            # A domain the model named comes back with a slug in sentence case
            # and no claim on it.
            listed = client.get("/api/memory/domains").json()["domains"]
            assert [(item["slug"], item["title"], item["origin"]) for item in listed] == [
                ("ml", "Ml", "model")
            ]

            created = client.post(
                "/api/memory/domains",
                json={"title": "Efficiency & serving", "summary": "Cheap to run."},
            )
            assert created.status_code == 200
            assert created.json()["slug"] == "efficiency-serving"
            assert created.json()["origin"] == "reader"

            moved = client.post(
                "/api/memory/pages/move",
                json={"slugs": ["kv-cache"], "domain": "efficiency-serving"},
            )
            assert moved.status_code == 200
            assert moved.json()["pages"][0]["domain"] == "efficiency-serving"
            # The move is on the log, so the reader can see later why a page
            # is where it is.
            log = client.get("/api/memory").json()["events"]
            assert any(entry["kind"] == "refile" for entry in log)

            # Reading and moving write no page: a domain is its record until
            # its page has been composed, and both domains are owed one.
            counts = {
                item["slug"]: item["pages"]
                for item in client.get("/api/memory/domains").json()["domains"]
            }
            assert counts == {"ml": 1, "efficiency-serving": 1}
            assert client.get("/api/memory/pages/efficiency-serving").status_code == 404
            assert {page["kind"] for page in client.get("/api/memory").json()["pages"]} == {"concept"}
            assert {job["marker"] for job in storage.list_memory_jobs("reader")} == {
                "domain:ml", "domain:efficiency-serving"}

            # An empty domain is listed when the reader made it, as the sign
            # their Create worked. One the model named and every page has left,
            # such as the unsorted domain once its source pages are filed, is
            # a row nobody asked for ("General 0") and is not.
            storage.upsert_memory_domain("reader", {"slug": "general", "title": "General"})
            client.post("/api/memory/domains", json={"title": "World models"})
            listed = {
                item["slug"]: item["pages"]
                for item in client.get("/api/memory/domains").json()["domains"]
            }
            assert listed == {"ml": 1, "efficiency-serving": 1, "world-models": 0}
    finally:
        app.dependency_overrides.clear()


def test_a_domain_still_holding_pages_cannot_be_deleted(tmp_path):
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            LocalStorage(settings).upsert_memory_page(
                "reader",
                {"kind": "concept", "domain": "ml", "title": "VAE", "summary": "s",
                 "body": "Body."},
                max_pages=50,
            )

            # Cascading here would delete the reader's own writing to tidy up
            # a label they no longer like.
            refused = client.delete("/api/memory/domains/ml")
            assert refused.status_code == 409

            client.post(
                "/api/memory/pages/move", json={"slugs": ["vae"], "domain": "other"}
            )
            # A lone domain page left behind by ensure is bookkeeping, not content —
            # deleting the empty domain drops it with the label.
            assert client.delete("/api/memory/domains/ml").status_code == 204


    finally:
        app.dependency_overrides.clear()


def test_the_queue_names_its_work_after_the_thing_it_is_about(tmp_path):
    """A marker is an idempotency key, not something a reader can act on.

    The labels come from the records rather than from the payload, so work
    queued before any of this existed still resolves — and a job whose document
    has since been deleted falls back to saying what kind of work it is instead
    of showing an empty line.
    """
    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        openai_api_key="test-key",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project = client.post("/api/projects", json={"name": "Robotics"}).json()
            storage = LocalStorage(settings)
            storage.add_paper(
                "reader",
                project["id"],
                {"id": "cosmos", "title": "Cosmos 3", "filename": "cosmos.pdf"},
            )
            client.post("/api/memory/domains", json={"title": "World models"})

            jobs = {
                job["kind"]: job
                for job in client.get("/api/memory/maintenance").json()["jobs"]
            }
            assert jobs["document"]["label"] == "Cosmos 3"
            assert jobs["document"]["context"] == "Filing a document"
            assert jobs["domain"]["label"] == "World models"
            assert jobs["domain"]["context"] == "Writing a domain summary"

            # A document that is gone leaves the kind to speak for itself.
            storage.delete_paper("reader", project["id"], "cosmos")
            storage.enqueue_memory_job(
                "reader",
                kind="document",
                marker="paper:vanished",
                payload={"projectId": project["id"], "paperId": "vanished"},
            )
            orphan = next(
                job
                for job in client.get("/api/memory/maintenance").json()["jobs"]
                if job["marker"] == "paper:vanished"
            )
            assert orphan["label"] == "Filing a document"
            assert orphan["context"] == "Robotics"
    finally:
        app.dependency_overrides.clear()


def test_index_lines_can_include_summaries():
    lines = index_lines(
        [
            {
                "slug": "kl",
                "kind": "concept",
                "domain": "ml",
                "title": "KL",
                "summary": "a divergence",
            }
        ],
        with_summaries=True,
    )
    assert "a divergence" in lines


def test_renaming_a_domain_never_moves_its_address(tmp_path):
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            LocalStorage(settings).upsert_memory_page(
                "reader",
                {"kind": "concept", "domain": "ml", "title": "VAE", "summary": "s",
                 "body": "Body."},
                max_pages=50,
            )

            renamed = client.patch(
                "/api/memory/domains/ml",
                json={"title": "Machine learning", "slug": "machine-learning"},
            )
            # The title is what anyone reads; the slug is what every stored
            # page and every [[link]] resolves against, so it stays put even
            # when the request asks otherwise.
            assert renamed.json()["title"] == "Machine learning"
            assert renamed.json()["slug"] == "ml"
            assert client.get("/api/memory/pages/vae").json()["page"]["domain"] == "ml"

            assert client.patch(
                "/api/memory/domains/no-such-domain", json={"title": "X"}
            ).status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_renaming_a_document_renames_its_source_page_and_nothing_else(tmp_path):
    """An upload is filed under its filename; the reader's rename is the name
    every page, card and prompt should use. Only the source page follows."""
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project = client.post("/api/projects", json={"name": "Pages"}).json()["id"]
            storage = LocalStorage(settings)
            storage.add_paper("reader", project, {"id": "doc", "kind": "pdf", "title": "temp_file_v1.pdf"})
            storage.upsert_memory_page(
                "reader",
                {"slug": "temp-file-v1-pdf", "kind": "source", "domain": "ml",
                 "title": "temp_file_v1.pdf", "summary": "s", "body": "Body. [[vae]]",
                 "sourcePaperId": "doc", "sourceProjectId": project},
                max_pages=50,
            )
            storage.upsert_memory_page(
                "reader",
                {"kind": "concept", "domain": "ml", "title": "VAE", "summary": "s",
                 "body": "Body.", "sourcePaperId": "doc"},
                max_pages=50,
            )
            path = f"/api/projects/{project}/papers/doc"
            assert client.patch(path, json={"title": "Auto-Encoding Variational Bayes"}).status_code == 200

            source = client.get("/api/memory/pages/temp-file-v1-pdf").json()["page"]
            # The address and the body stay: every [[link]] resolves by slug.
            assert source["title"] == "Auto-Encoding Variational Bayes"
            assert source["slug"] == "temp-file-v1-pdf" and source["body"] == "Body. [[vae]]"
            assert source["sourcePaperId"] == "doc"
            # A page the model wrote keeps the name it was given.
            assert client.get("/api/memory/pages/vae").json()["page"]["title"] == "VAE"

            # The same title again writes nothing.
            revision = source["revision"]
            client.patch(path, json={"title": "Auto-Encoding Variational Bayes"})
            assert client.get("/api/memory/pages/temp-file-v1-pdf").json()["page"]["revision"] == revision

            # A document with no page of its own still renames.
            storage.add_paper("reader", project, {"id": "bare", "kind": "pdf", "title": "x.pdf"})
            assert client.patch(f"/api/projects/{project}/papers/bare", json={"title": "Named"}).json()["title"] == "Named"
    finally:
        app.dependency_overrides.clear()


def test_a_figure_kept_as_a_link_answers_404_rather_than_streaming_nothing(tmp_path):
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            storage.upsert_memory_page(
                "reader",
                {"kind": "concept", "domain": "ml", "title": "VAE", "summary": "s",
                 "body": "Body."},
                max_pages=50,
            )
            storage.add_memory_figure(
                "reader",
                {"id": "fig1", "pageSlug": "vae", "caption": "the architecture",
                 "sourceUrl": "https://example.test/fig.png"},
                max_per_page=6,
            )

            # The page renders its source URL instead; a 404 is what tells it so.
            assert client.get("/api/memory/figures/fig1").status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_deleting_a_page_takes_its_figure_bytes_with_it(tmp_path):
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            objects = LocalObjectStore(tmp_path)
            storage.upsert_memory_page(
                "reader",
                {"kind": "concept", "domain": "ml", "title": "VAE", "summary": "s",
                 "body": "Body."},
                max_pages=50,
            )
            key = "knowledge/u/reader/figures/fig1.webp"
            objects.put_text(key, "not really a webp")
            storage.add_memory_figure(
                "reader",
                {"id": "fig1", "pageSlug": "vae", "caption": "c", "objectKey": key},
                max_per_page=6,
            )

            assert client.delete("/api/memory/pages/vae").status_code == 204
            # No store can cascade into the object store, so the route has to.
            assert not objects.exists(key)
    finally:
        app.dependency_overrides.clear()


# --- the loop, end to end ------------------------------------------------


def transcript(events):
    return "".join(f"data: {json.dumps(e)}\n\n" for e in events).encode()


def test_the_secretary_gets_the_whole_ladder(tmp_path):
    from delphi_core.routers.chat import build_general_payload
    from delphi_core.schemas import ChatRequest

    settings = Settings(data_dir=tmp_path)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    storage.upsert_memory_page(
        "reader",
        {"kind": "concept", "domain": "ml", "title": "KL divergence",
         "summary": "s", "body": "Body."},
        max_pages=50,
    )

    payload = asyncio.run(build_general_payload(
        storage,
        "reader",
        settings,
        ChatRequest(prompt="What do I know about KL divergence?", scope="general",
                    model="gpt-6-luna", reasoning_effort="high"),
        [],
        use_standard_tier=False,
    ))

    offered = [tool.get("name") or tool["type"] for tool in payload["tools"]]
    # It chooses from the index and opens what it chose, and can still drop
    # back to raw evidence when Memory turns out to be thin.
    assert "open_memory" in offered
    assert "search_library" in offered and "read_paper" in offered
    # The whole index, first, and nothing chosen for it by matching words.
    first = payload["input"][0]["content"][0]
    assert first["text"].startswith("<memory_index>") and "ml/concept/kl-divergence · KL divergence" in first["text"]
    assert "<reader_memory>" not in json.dumps(payload["input"])
    # It is the same for every question, so it is this scope's cached prefix.
    other = asyncio.run(build_general_payload(
        storage, "reader", settings,
        ChatRequest(prompt="Something else entirely?", scope="general",
                    model="gpt-6-luna", reasoning_effort="high"),
        [], use_standard_tier=False,
    ))
    assert other["input"][0] == payload["input"][0]
    assert first["prompt_cache_breakpoint"] == {"mode": "explicit"}
    assert payload["prompt_cache_key"] == other["prompt_cache_key"]
    # Brevity is part of the contract, not taste: a secretary that writes a
    # survey nobody finishes has failed the same way one that skips the ladder
    # has. Assert the durable ask (lead with the answer, stop when done), not
    # the wording of any one rule.
    instructions = payload["instructions"]
    assert "Lead with the answer" in instructions
    assert "Stop when the answer is done" in instructions
    # One ceiling for chat in both scopes, sized so that thinking at a high
    # effort cannot spend it all and truncate the visible answer mid-cite.
    assert payload["max_output_tokens"] == settings.model_max_output_tokens == 32_000


def test_memory_chat_answers_as_the_default_persona_and_can_search_the_web(tmp_path):
    from delphi_core.personas import DEFAULT_PERSONA_KEY, resolve_persona_or_default
    from delphi_core.routers.chat import build_general_payload
    from delphi_core.schemas import ChatRequest

    settings = Settings(data_dir=tmp_path)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    body = ChatRequest(prompt="What changed?", scope="general",
                       model="gpt-6-luna", reasoning_effort="high")
    # Omitting the field means "whatever this conversation is held in", not
    # ADHD. It used to default to the literal string here, which is the same
    # mistake `chat_stream` made one layer up: a request that names no persona
    # answered as the default instead of as the one that was picked.
    assert body.persona_id is None
    # Nothing chosen yet, so the resolution lands on the account default.
    persona = resolve_persona_or_default(storage, "reader", body.persona_id)
    assert persona["id"] == DEFAULT_PERSONA_KEY

    payload = asyncio.run(build_general_payload(
        storage, "reader", settings, body, [],
        persona=persona, use_standard_tier=False,
    ))

    assert f"<persona>\n{persona['content']}\n</persona>" in payload["instructions"]
    # Search is offered without being asked for, last, and the instructions
    # say when to reach for it.
    assert payload["tools"][-1]["type"] == "web_search"
    assert "Do not search for what the open document or Memory already settles" in " ".join(
        payload["instructions"].split()
    )


def test_chat_executes_only_owned_or_official_personas(tmp_path):
    """
    The resolver every scope goes through, and the one place ownership is
    enforced. It served the account-wide chat alone while a reader scope took
    its persona from the project row; now that both carry a client-supplied
    `persona_id`, a second resolver anywhere would be a way around this.
    """
    from fastapi import HTTPException

    from delphi_core.personas import resolve_persona_for_request as resolve_memory_persona

    settings = Settings(data_dir=tmp_path)
    storage = LocalStorage(settings)
    for username in ("reader", "author"):
        storage.create_account(username, None, "salt", "hash")
    owned = storage.create_persona(
        "reader",
        {"name": "Direct", "element": "stone", "content": "Lead with the number."},
    )
    foreign = storage.create_persona(
        "author",
        {"name": "Public", "element": "wind", "content": "Mutable instructions."},
    )
    storage.update_persona("author", foreign["id"], {"visibility": "public"})

    assert resolve_memory_persona(storage, "reader", "adhd")["official"] is True
    assert resolve_memory_persona(storage, "reader", owned["id"])["content"] == "Lead with the number."
    with pytest.raises(HTTPException) as refused:
        resolve_memory_persona(storage, "reader", foreign["id"])
    assert refused.value.status_code == 404


def test_a_question_beside_a_document_knows_the_document_and_its_related_reading(tmp_path):
    """
    Asked from the reader, the account-wide chat is asked *about something*:
    the document beside it. It arrives as its digest, the selection arrives
    with the question, and the block is seeded from the document's own source
    page — so "is anything related already here" is answered by the pages that
    share an idea with it, without a single word of the question matching them.
    """
    from delphi_core.routers.chat import build_general_payload
    from delphi_core.schemas import ChatRequest

    settings = Settings(data_dir=tmp_path)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    for row in (
        {"kind": "source", "slug": "open-paper", "title": "Open paper", "sourcePaperId": "p-open",
         "body": "Builds on [[shared-idea]]."},
        {"kind": "concept", "slug": "shared-idea", "title": "Shared idea", "body": "An idea."},
        {"kind": "source", "slug": "earlier-paper", "title": "Earlier paper", "sourcePaperId": "p-old",
         "body": "Introduced [[shared-idea]]."},
        {"kind": "source", "slug": "elsewhere", "title": "Elsewhere", "body": "Nothing in common."},
    ):
        storage.upsert_memory_page(
            "reader", {"domain": "ml", "summary": "A summary.", **row}, max_pages=50
        )
    paper = {"id": "p-open", "title": "Open paper"}
    record: dict = {}

    payload = asyncio.run(build_general_payload(
        storage,
        "reader",
        settings,
        ChatRequest(
            prompt="anything like this already?", scope="general",
            project_id="proj", paper_id="p-open",
            selected_text="the quoted claim",
            model="gpt-6-luna", reasoning_effort="high",
        ),
        [],
        use_standard_tier=False,
        open_paper=paper,
        open_digest={"contentMarkdown": "What the open paper says."},
        record=record,
    ))

    index, opened, question = (item["content"] for item in payload["input"])
    assert '<open_document paper_id="p-open"' in opened[0]["text"]
    assert "What the open paper says." in opened[0]["text"]
    # The index holds every page, related or not: which of them bear on the
    # question is the model's to decide, and it names nothing about this turn.
    listing = index[0]["text"]
    for slug in ("open-paper", "shared-idea", "earlier-paper", "elsewhere"):
        assert f"/{slug} · " in listing
    assert "anything like this" not in listing and "open beside" not in listing
    assert question.endswith("the quoted claim")
    # Where lookup started is recorded for the trail under the answer.
    assert record == {
        "start": {"kind": "document", "title": "Open paper", "paperId": "p-open", "slug": "open-paper"},
        "index": {"pages": 4, "documents": 0, "projects": 0, "chats": 0},
    }
    # Still no file: the document is context, not an attachment.
    assert "input_file" not in json.dumps(payload["input"])

    # On a Memory page instead, the page is named beside the question.
    on_page = asyncio.run(build_general_payload(
        storage, "reader", settings,
        ChatRequest(prompt="what links here?", scope="general",
                    page_slug="shared-idea", model="gpt-6-luna", reasoning_effort="high"),
        [], use_standard_tier=False,
    ))
    assert on_page["input"][0] == payload["input"][0]
    assert "[[shared-idea]] — Shared idea (ml/concept/shared-idea)" in on_page["input"][-2]["content"][0]["text"]


def test_a_memory_answer_stores_the_trace_it_actually_made(tmp_path, monkeypatch):
    """
    End to end: the model searches, opens a page, answers — and the stored
    message carries Delphi's own account of that, replayable after a reload.
    """
    import httpx

    from delphi_core.routers import chat as chat_router

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        openai_api_key="test-key",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            storage.upsert_memory_page(
                "reader",
                {"kind": "domain", "domain": "ml", "title": "Machine learning",
                 "summary": "domain page", "body": "See [[knowledge-distillation]]."},
                max_pages=50,
            )
            storage.upsert_memory_page(
                "reader",
                {"kind": "concept", "domain": "ml", "title": "Knowledge distillation",
                 "summary": "soft targets", "body": "Part of [[machine-learning]]."},
                max_pages=50,
            )

            def transcript(events):
                return "".join(
                    f"data: {json.dumps(event)}\n\n" for event in events
                ).encode()

            turns = []

            def handler(request: httpx.Request) -> httpx.Response:
                turns.append(json.loads(request.content))
                if len(turns) == 1:
                    return httpx.Response(200, content=transcript([
                        {"type": "response.output_item.done", "item": {
                            "type": "function_call", "call_id": "c1",
                            "name": "grep_memory",
                            "arguments": json.dumps(
                                {"pattern": "distillation", "glob": ""}
                            )}},
                    ]))
                if len(turns) == 2:
                    return httpx.Response(200, content=transcript([
                        {"type": "response.output_item.done", "item": {
                            "type": "function_call", "call_id": "c2",
                            "name": "open_memory",
                            "arguments": json.dumps(
                                {"slugs": ["knowledge-distillation"]}
                            )}},
                    ]))
                return httpx.Response(200, content=transcript([
                    {"type": "response.output_text.delta",
                     "delta": "Soft targets carry more than a label."},
                ]))

            transport = ProviderTransport(handler)
            original = httpx.AsyncClient

            def fake_client(*args, **kwargs):
                kwargs["transport"] = transport
                return original(*args, **kwargs)

            monkeypatch.setattr(chat_router.httpx, "AsyncClient", fake_client)

            conversation = conversation_params(client, "general")
            streamed = client.post(
                "/api/chat/stream",
                json={**conversation, "prompt": "how does distillation work", "request_id": "req_abc123"},
            )
            assert streamed.status_code == 200
            assert "Soft targets" in streamed.text

            thread = client.get("/api/chat", params=conversation).json()
            answer = thread["messages"][-1]
            assert answer["role"] == "assistant"
            # One record, in the order it happened: what the answer was
            # handed, then each call Delphi ran with the pages it returned.
            (stretch,) = answer["trace"]
            assert stretch["context"]["start"] == {"kind": "question"}
            assert stretch["context"]["index"]["pages"] == 2
            calls = [entry for entry in stretch["entries"] if entry["kind"] == "tool"]
            assert [call["tool"] for call in calls] == ["grep_memory", "open_memory"]
            assert calls[0]["args"] == {"pattern": "distillation"}
            assert calls[1]["results"] == [
                {"slug": "knowledge-distillation", "title": "Knowledge distillation", "kind": "concept"}
            ]
            assert "walk" not in answer
            # And the stream carried the same record while it was built.
            sent = [
                json.loads(line[5:])
                for line in streamed.text.splitlines()
                if line.startswith("data:")
            ]
            assert any(event["type"] == "trace" for event in sent)
            assert sent[-1]["type"] == "done" and sent[-1]["trace"] == answer["trace"]
    finally:
        app.dependency_overrides.clear()


def test_the_general_scope_is_gated_and_its_done_has_no_domains(tmp_path, monkeypatch):
    """
    The whole Memory index is what makes the general scope work, so with
    Memory turned off the route refuses before the stream opens; and the
    terminal event is the shared one — one wire shape, no `domains` key.
    """
    import httpx

    from delphi_core.routers import chat as chat_router

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        openai_api_key="test-key",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            conversation = conversation_params(client, "general")

            off = Settings(
                data_dir=tmp_path,
                session_secret="test-session-secret",
                openai_api_key="test-key",
                memory_enabled=False,
            )
            app.dependency_overrides[get_settings] = lambda: off
            refused = client.post(
                "/api/chat/stream",
                json={**conversation, "prompt": "anything", "request_id": "req_off001"},
            )
            assert refused.status_code == 403
            app.dependency_overrides[get_settings] = lambda: settings

            original = httpx.AsyncClient

            def fake_client(*args, **kwargs):
                kwargs["transport"] = ProviderTransport(
                    lambda request: httpx.Response(
                        200,
                        content=(
                            b'data: {"type": "response.output_text.delta",'
                            b' "delta": "An answer."}\n\n'
                        ),
                    )
                )
                return original(*args, **kwargs)

            monkeypatch.setattr(chat_router.httpx, "AsyncClient", fake_client)
            streamed = client.post(
                "/api/chat/stream",
                json={**conversation, "prompt": "anything", "request_id": "req_on0001"},
            )
            assert streamed.status_code == 200
            events = [
                json.loads(line[5:])
                for line in streamed.text.splitlines()
                if line.startswith("data:")
            ]
            done = events[-1]
            assert done["type"] == "done" and "domains" not in done
    finally:
        app.dependency_overrides.clear()


def test_a_memory_index_the_model_cannot_hold_is_said_as_unavailable_memory(
    tmp_path, monkeypatch
):
    """
    The general scope sends the whole index, so a context refusal means Memory
    could not be consulted, which the reader is told in those words rather than
    as the provider's status line.
    """
    import httpx

    from delphi_core.routers import chat as chat_router

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        openai_api_key="test-key",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    original = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = ProviderTransport(
            lambda request: httpx.Response(
                400,
                json={"error": {"code": "context_length_exceeded", "message": "Input exceeds the context window."}},
            )
        )
        return original(*args, **kwargs)

    monkeypatch.setattr(chat_router.httpx, "AsyncClient", fake_client)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            conversation = conversation_params(client, "general")
            streamed = client.post(
                "/api/chat/stream",
                json={**conversation, "prompt": "anything", "request_id": "req_overflow1"},
            )
            events = [
                json.loads(line[5:])
                for line in streamed.text.splitlines()
                if line.startswith("data:")
            ]
            (failure,) = [event for event in events if event["type"] == "error"]
            assert "Memory could not be consulted" in failure["message"]
            answer = client.get("/api/chat", params=conversation).json()["messages"][-1]
            assert answer["error"] is True
            assert "Memory could not be consulted" in answer["content"]
    finally:
        app.dependency_overrides.clear()


def test_the_secretary_can_open_a_paper_it_found_in_any_project(tmp_path):
    from delphi_core.document_reads import resolve_account_paper

    settings = Settings(data_dir=tmp_path)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    first = storage.create_project("reader", "Alpha")
    second = storage.create_project("reader", "Beta")
    storage.add_paper(
        "reader", second["id"],
        {"id": "paper-a", "title": "VAE", "filename": "a.pdf", "pages": 12},
    )
    storage.add_paper(
        "reader", first["id"],
        {"id": "page-b", "kind": "web", "title": "Post", "filename": "x", "pages": 1},
    )

    # `search_library` reaches every project, so a hit the secretary cannot then
    # open would break the ladder at its last rung.
    project_id, papers = resolve_account_paper(storage, "reader", "paper-a")
    assert project_id == second["id"]
    assert list(papers) == ["paper-a"]

    # A web document is not a PDF and is read through read_webpage, so this
    # must not claim to have found one.
    assert resolve_account_paper(storage, "reader", "page-b") == ("", {})
    # And a stranger's paper is simply not there.
    assert resolve_account_paper(storage, "nobody", "paper-a") == (
        "",
        {},
    )


def test_the_backfill_listing_says_what_each_document_will_cost(tmp_path):
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            first = client.post("/api/projects", json={"name": "Diffusion"}).json()["id"]
            second = client.post("/api/projects", json={"name": "Optimisers"}).json()["id"]

            seed_paper(
                settings,
                "reader",
                first,
                {"id": "paper-a", "title": "MDLM", "filename": "a.pdf",
                 "sourceHash": "source-a",
                 "digest": {
                     "status": "ready",
                     "version": RESEARCH_DIGEST_VERSION,
                     "model": settings.digest_model,
                     "sourceHash": "source-a",
                 }},
            )
            seed_paper(
                settings,
                "reader",
                first,
                {"id": "paper-b", "title": "Unread", "filename": "b.pdf",
                 "sourceHash": "source-b",
                 # Ready under the old generator is not ready for this Update:
                 # Memory must rebuild the evidence index before filing.
                 "digest": {
                     "status": "ready",
                     "version": "research-digest-v5",
                     "model": settings.digest_model,
                     "sourceHash": "source-b",
                 }},
            )
            seed_paper(
                settings,
                "reader",
                second,
                {"id": "paper-c", "title": "Adam", "filename": "c.pdf",
                 "doneAt": "2026-01-01T00:00:00Z"},
            )
            for filed in ("paper-a", "paper-c"):
                LocalStorage(settings).append_memory_event(
                    "reader", {"kind": "document", "requestId": f"paper:{filed}"}
                )

            papers = client.get("/api/memory/backfill/papers").json()["papers"]
            by_id = {item["paperId"]: item for item in papers}

            # Every project, not just the open one — the wiki is account-wide.
            assert set(by_id) == {"paper-a", "paper-b", "paper-c"}
            assert by_id["paper-a"]["projectName"] == "Diffusion"
            assert by_id["paper-c"]["projectId"] == second

            # The two numbers the reader is owed before they commit: what is
            # already filed costs nothing, and what has no digest costs a whole
            # document read.
            assert by_id["paper-a"]["filed"] is True
            assert by_id["paper-b"]["filed"] is False
            assert by_id["paper-c"]["filed"] is True
            assert all(item["dropped"] == [] for item in by_id.values())
            assert by_id["paper-a"]["digestReady"] is True
            assert by_id["paper-b"]["digestReady"] is False
            # Nothing of the retired filing model is served.
            assert not {"done", "owed", "unverified", "reason"} & set(by_id["paper-a"])

            # An archived paper is still a document the reader read. Invariant
            # 34 takes it out of the working set for chat, not out of the wiki.
            assert by_id["paper-c"]["title"] == "Adam"
    finally:
        app.dependency_overrides.clear()


def test_a_document_filed_by_a_replaced_pass_is_offered_and_then_settles(tmp_path):
    """The whole point of the version stamp, end to end.

    Improving the authoring pass used to reach existing readers only through an
    operator running `delphi_core.backfill.memory --force` from a laptop, for every
    account, on their own card. The stamp was written from the beginning and
    read by nothing, so a `knowledge-v1` document reported `filed: true` to
    every surface in the product and no button ever offered to bring it forward.
    """
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project = client.post("/api/projects", json={"name": "Diffusion"}).json()["id"]
            for paper_id, title in (("old", "Behind"), ("new", "Current")):
                seed_paper(
                    settings, "reader", project,
                    {"id": paper_id, "title": title, "filename": f"{paper_id}.pdf"},
                )
            storage = LocalStorage(settings)
            for job in storage.list_memory_jobs("reader"):
                storage.complete_memory_job("reader", job["id"])
            storage.append_memory_event(
                "reader",
                {"kind": "document", "requestId": "paper:old",
                 "version": "knowledge-v1"},
            )
            storage.append_memory_event(
                "reader",
                {"kind": "document", "requestId": "paper:new",
                 "version": MEMORY_VERSION},
            )

            listing = client.get("/api/memory/backfill/papers").json()
            assert listing["version"] == MEMORY_VERSION
            rows = {item["paperId"]: item for item in listing["papers"]}
            # Both are in the wiki. Only one of them is in the wiki that Delphi
            # writes now, and "filed" alone could never say which.
            assert rows["old"]["filed"] is True and rows["new"]["filed"] is True
            assert rows["old"]["stale"] is True and rows["new"]["stale"] is False
            assert rows["old"]["filedVersion"] == "knowledge-v1"

            # The press queues the behind one and nothing else. A document
            # already at the current version costs no row and no model call to
            # skip — it is turned away by its own stamp.
            assert client.post("/api/memory/backfill/papers").json() == {
                "queued": 0, "revived": 0, "upgraded": 1, "inFlight": 0,
            }
            jobs = storage.list_memory_jobs("reader")
            assert [job["marker"] for job in jobs] == ["paper:old"]
            assert jobs[0]["kind"] == "document"
            assert jobs[0]["payload"]["targetVersion"] == MEMORY_VERSION

            # And once the refile lands, the offer goes away rather than
            # recurring — the property that makes this safe to leave switched on.
            storage.append_memory_event(
                "reader",
                {"kind": "document", "requestId": "paper:old",
                 "version": MEMORY_VERSION},
            )
            after = client.get("/api/memory/backfill/papers").json()["papers"]
            assert all(item["stale"] is False for item in after)
    finally:
        app.dependency_overrides.clear()


def test_stopping_a_filing_calls_off_the_spend_and_leaves_the_offer_standing(
    tmp_path,
):
    """The way back out of a press that costs more than the reader expected.

    Update is the one control that commits an account to an unbounded amount of
    model spend — a job per out-of-date document, drained by the pump for the
    rest of the session — and it had no cancel. That was survivable while the
    backlog it was written for was one-shot and shrank permanently; a refile
    recurs on every version bump and covers the whole library.

    The offer coming back afterwards is the point, not a defect: the documents
    really are still out of date. What the reader stopped was the spending, not
    the fact.
    """
    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        openai_api_key="test-key",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project = client.post(
                "/api/projects", json={"name": "Diffusion"}
            ).json()["id"]
            storage = LocalStorage(settings)
            for paper_id in ("old-a", "old-b"):
                seed_paper(
                    settings, "reader", project,
                    {"id": paper_id, "title": paper_id, "filename": f"{paper_id}.pdf"},
                )
            for job in storage.list_memory_jobs("reader"):
                storage.complete_memory_job("reader", job["id"])
            for paper_id in ("old-a", "old-b"):
                storage.append_memory_event(
                    "reader",
                    {"kind": "document", "requestId": f"paper:{paper_id}",
                     "version": "knowledge-v1"},
                )

            assert client.post("/api/memory/backfill/papers").json()["upgraded"] == 2
            snapshot = client.get("/api/memory/maintenance").json()
            assert snapshot["pending"] == 2 and snapshot["cancellable"] == 2

            # A job waiting out its retry backoff is still cancellable — it has
            # not been paid for yet, which makes it the clearest case for
            # stopping. Counting only `pending` would hide the button for
            # exactly the documents a reader most wants called off.
            storage_jobs = storage.list_memory_jobs("reader")
            storage.fail_memory_job(
                "reader", storage_jobs[0]["id"],
                error="provider was busy", retry_at="2099-01-01T00:00:00+00:00",
            )
            retrying = client.get("/api/memory/maintenance").json()
            assert retrying["pending"] == 1 and retrying["cancellable"] == 2

            assert client.post("/api/memory/maintenance/cancel").json() == {
                "cancelled": 2
            }
            snapshot = client.get("/api/memory/maintenance").json()
            assert snapshot["pending"] == 0 and snapshot["due"] == 0

            # Nothing was undone: the documents are still behind, so the offer
            # is still made. A reader who stopped by accident presses again.
            listing = client.get("/api/memory/backfill/papers").json()["papers"]
            assert all(row["stale"] for row in listing)
            assert client.post("/api/memory/backfill/papers").json()["upgraded"] == 2

            # And it is idempotent, so a second press reports the truth.
            client.post("/api/memory/maintenance/cancel")
            assert client.post("/api/memory/maintenance/cancel").json() == {
                "cancelled": 0
            }
    finally:
        app.dependency_overrides.clear()


def test_stopping_reaches_the_document_being_written_and_saves_what_is_left(
    tmp_path, monkeypatch
):
    """Stop during a filing, and the calls that document had left are not made.

    This is the bug the feature shipped with. Stop was offered whenever a run
    was going and cancelled only work that had not started, so during a
    one-document Update — the whole queue in flight from the first frame —
    pressing it fired a request that deleted nothing and changed nothing on
    screen. The reader's reasonable reading of that is that the button is
    broken.

    Sparing in-flight work sounds thrifty and is close to backwards. Filing one
    document is a plan, a call per page that plan asks for, and a verification,
    so a reader who stops at "Deciding which pages to write" is stopping nearly
    all of it. The fake below is shaped like that on purpose: each stage
    announces itself and *then* does its work, so a stage that never resumes is
    a call never paid for, which is the whole claim being tested.

    Standing down leaves nothing behind, because pages and their event are one
    commit at the end of the pass. The document stays out of date and the offer
    comes back — the reader stopped the spending, not the fact.
    """
    from delphi_core.routers import memory as memory_router

    settings = Settings(
        data_dir=tmp_path,
        session_secret="test-session-secret",
        openai_api_key="test-key",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    calls: list[str] = []
    closed: list[str] = []

    async def fake_run(job, *, storage, username, **_kwargs):
        try:
            yield {
                "type": "progress",
                "stage": "memory_plan",
                "message": "Deciding which pages to write",
            }
            calls.append("plan")
            # The reader presses Stop while the planning call is out. It is the
            # storage call the route makes, from the process that took the
            # press — which is generally not this one, and is why the signal
            # has to be the durable row rather than anything in memory.
            storage.cancel_memory_jobs(username, kinds=("document",))
            yield {
                "type": "progress",
                "stage": "memory_page",
                "message": "Writing Attention",
            }
            # Everything from here is what stopping is worth, and none of it
            # should happen: the page's own call, and the commit that would
            # file the document.
            calls.append("page")
            storage.append_memory_event(
                username,
                {"kind": job["kind"], "requestId": job["marker"], "pages": []},
            )
            yield {"type": "_memory_result", "pages": [], "reused": False}
        except GeneratorExit:
            closed.append("closed")
            raise

    monkeypatch.setattr(memory_router, "run_maintenance_job", fake_run)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project = client.post(
                "/api/projects", json={"name": "Diffusion"}
            ).json()["id"]
            storage = LocalStorage(settings)
            seed_paper(
                settings, "reader", project,
                {"id": "old-a", "title": "old-a", "filename": "old-a.pdf"},
            )
            for job in storage.list_memory_jobs("reader"):
                storage.complete_memory_job("reader", job["id"])
            storage.append_memory_event(
                "reader",
                {"kind": "document", "requestId": "paper:old-a",
                 "version": "knowledge-v1"},
            )
            assert client.post("/api/memory/backfill/papers").json()["upgraded"] == 1

            # The one document is in flight from the first frame, which is
            # exactly the case the shipped button could not touch.
            drained = client.post("/api/memory/maintenance/drain")
            assert drained.status_code == 200

            # The plan was paid for; nothing after it was.
            assert calls == ["plan"]
            # And the pass was torn down rather than left suspended forever.
            # This says the generator was finalised, not that the route closed
            # it explicitly: CPython refcounting collects it either way, so the
            # `aclosing` in the drain is deliberate practice this cannot pin.
            assert closed == ["closed"]

            # Nothing filed: the marker is still the one the old pass left, so
            # no refile was committed. And the row is gone rather than left to
            # be reclaimed and paid for a second time.
            assert LocalStorage(settings).memory_event_version(
                "reader", "paper:old-a"
            ) == "knowledge-v1"
            assert LocalStorage(settings).list_memory_jobs("reader") == []
            # The stream says what happened, and does not count an abandoned
            # document as a filed one.
            assert '"cancelled": true' in drained.text
            assert '"claimed": false' in drained.text

            # The document is still behind, so the offer stands. A reader who
            # stopped by accident presses Update again.
            listing = client.get("/api/memory/backfill/papers").json()["papers"]
            assert [row["stale"] for row in listing] == [True]
    finally:
        app.dependency_overrides.clear()


def test_stopping_a_filing_needs_a_session(tmp_path):
    signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            assert client.post(
                "/api/memory/maintenance/cancel"
            ).status_code == 401
    finally:
        app.dependency_overrides.clear()


def test_the_backfill_listing_shows_one_account_only(tmp_path):
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "stranger", "password": "password-123"},
            )
            theirs = client.post("/api/projects", json={"name": "Theirs"}).json()["id"]
            seed_paper(
                settings, "stranger", theirs,
                {"id": "paper-x", "title": "Theirs", "filename": "x.pdf"},
            )
            client.post("/api/auth/logout")

            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )

            # The listing, not the envelope: it also carries the version the
            # library is being measured against, and pinning the whole dict
            # here fails on a field that was supposed to arrive.
            assert client.get("/api/memory/backfill/papers").json()["papers"] == []
    finally:
        app.dependency_overrides.clear()


def test_the_backfill_listing_needs_a_session(tmp_path):
    signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            assert client.get("/api/memory/backfill/papers").status_code == 401
    finally:
        app.dependency_overrides.clear()


def test_file_it_all_queues_the_backlog_and_revives_what_gave_up(tmp_path):
    """The backlog goes to the durable queue, and a dead job is not a wall.

    File-it-all used to run the filing in the reader's own tab, so leaving the
    page — not even closing it — killed whatever was in flight. Enqueued, each
    document is a leased job that survives navigation, reload and a closed tab.

    The revive half is the part that is easy to get wrong and was: a document
    still unfiled has very often already failed, `enqueue_memory_job` is
    idempotent on its marker, so enqueueing alone hands back the dead row and
    changes nothing. Without this the button would do nothing for exactly the
    documents it exists to rescue.
    """
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            project = client.post(
                "/api/projects", json={"name": "Diffusion"}
            ).json()["id"]
            seed_paper(
                settings,
                "reader",
                project,
                {"id": "paper-a", "title": "Flow", "filename": "a.pdf"},
            )
            seed_paper(
                settings,
                "reader",
                project,
                {"id": "paper-b", "title": "Adam", "filename": "b.pdf"},
            )
            storage = LocalStorage(settings)
            # Already in the wiki *at the current pass*: Update is catch-up, not
            # a redo of every upload. The version matters — an event with no
            # stamp is one written by something Delphi has replaced, which is
            # work to do rather than work already done.
            storage.append_memory_event(
                "reader",
                {
                    "kind": "document",
                    "requestId": "paper:paper-b",
                    "version": MEMORY_VERSION,
                },
            )

            first = client.post("/api/memory/backfill/papers").json()
            assert first == {
                "queued": 1, "revived": 0, "upgraded": 0, "inFlight": 0,
            }

            queued = [
                job
                for job in storage.list_memory_jobs("reader")
                if job["marker"] == "paper:paper-a"
            ]
            assert len(queued) == 1 and queued[0]["status"] == "pending"

            # `queued` counts documents now waiting, not rows written, because
            # that is what the reader is being told. Pressing again is still
            # free: the marker is unique, so the second press adds no row and
            # buys no second model call.
            assert client.post("/api/memory/backfill/papers").json() == {
                "queued": 1, "revived": 0, "upgraded": 0, "inFlight": 0,
            }
            assert (
                len(
                    [
                        item
                        for item in storage.list_memory_jobs("reader")
                        if item["marker"] == "paper:paper-a"
                    ]
                )
                == 1
            )

            # Now let that job give up, the way a real filing does when a plan
            # or a verification refuses it.
            for _ in range(settings.memory_job_max_attempts + 1):
                claimed = storage.claim_memory_job(
                    "reader",
                    now="2026-01-01T00:00:00+00:00",
                    lease_expires_at="2026-01-01T00:10:00+00:00",
                    max_attempts=settings.memory_job_max_attempts,
                )
                if claimed is None:
                    break
                storage.fail_memory_job(
                    "reader", claimed["id"], error="refused", retry_at=None
                )
            dead = [
                item
                for item in storage.list_memory_jobs("reader")
                if item["marker"] == "paper:paper-a"
            ][0]
            assert dead["status"] == "failed"

            # The press that matters: a failed job is revived rather than
            # silently left where it is.
            assert client.post("/api/memory/backfill/papers").json() == {
                "queued": 0, "revived": 1, "upgraded": 0, "inFlight": 0,
            }
            revived = [
                item
                for item in storage.list_memory_jobs("reader")
                if item["marker"] == "paper:paper-a"
            ][0]
            assert revived["status"] == "pending"
            assert revived["attempts"] == 0
    finally:
        app.dependency_overrides.clear()


def test_queueing_the_backlog_needs_a_session(tmp_path):
    signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            assert client.post("/api/memory/backfill/papers").status_code == 401
    finally:
        app.dependency_overrides.clear()


def test_graph_etag_and_bounded_document_neighborhood(tmp_path, monkeypatch):
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            storage.upsert_memory_page(
                "reader",
                {
                    "slug": "paper-nine",
                    "kind": "source",
                    "domain": "ml",
                    "title": "Paper Nine",
                    "summary": "The canonical source.",
                    "body": "Introduces [[first-hop]].",
                    "sourcePaperId": "p9",
                },
                max_pages=50,
            )
            storage.upsert_memory_page(
                "reader",
                {
                    "slug": "first-hop",
                    "kind": "concept",
                    "domain": "ml",
                    "title": "First hop",
                    "summary": "One edge away.",
                    "body": "Leads to [[second-hop]].",
                },
                max_pages=50,
            )
            storage.upsert_memory_page(
                "reader",
                {
                    "slug": "second-hop",
                    "kind": "concept",
                    "domain": "ml",
                    "title": "Second hop",
                    "summary": "Two edges away.",
                    "body": "Leaf.",
                },
                max_pages=50,
            )

            graph = client.get("/api/memory/graph")
            assert graph.headers["etag"]

            def refuse_rescan(*args, **kwargs):
                raise AssertionError("an unchanged revision must reuse the graph index")

            monkeypatch.setattr(LocalStorage, "list_memory_pages", refuse_rescan)
            assert (
                client.get(
                    "/api/memory/graph",
                    headers={"If-None-Match": graph.headers["etag"]},
                ).status_code
                == 304
            )

            payload = client.get(
                "/api/memory/documents/p9/neighborhood?hops=1"
            ).json()
            assert payload["sourcePage"]["slug"] == "paper-nine"
            assert payload["center"]["slug"] == "paper-nine"
            assert payload["distances"] == {"paper-nine": 0, "first-hop": 1}
            assert {page["slug"] for page in payload["pages"]} == {
                "paper-nine",
                "first-hop",
            }
            assert "second-hop" not in payload["distances"]
            assert payload["statistics"]["pages"] == 3
            assert payload["filing"]["filed"] is False
            default_document = client.get("/api/memory/documents/p9/neighborhood").json()
            default_page = client.get("/api/memory/neighborhood?slug=paper-nine").json()
            assert default_document["distances"] == default_page["distances"] == {
                "paper-nine": 0, "first-hop": 1, "second-hop": 2,
            }
            assert client.get("/api/memory/neighborhood?slug=paper-nine&hops=0").json()["distances"] == {"paper-nine": 0}
            assert client.get("/api/memory/neighborhood?slug=paper-nine&hops=5").status_code == 422
    finally:
        app.dependency_overrides.clear()


def test_the_wiki_shell_reads_each_listing_once(tmp_path, monkeypatch):
    """
    The shell's own load reads each listing once, and writes nothing.

    `list_memory_pages` is four statements on the SQL backend, and this
    route is fetched by every mount of the wiki. A domain with members and no
    page is shown from its record: no page is written for it on a read.
    """
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            storage.upsert_memory_domain(
                "reader", {"slug": "ml", "title": "ML", "origin": "reader"}
            )
            storage.upsert_memory_page(
                "reader",
                {"kind": "concept", "domain": "ml", "title": "VAE", "summary": "s",
                 "body": "A page."},
                max_pages=50,
            )

            calls: list[str] = []
            for name in ("list_memory_pages", "memory_domains"):
                original = getattr(LocalStorage, name)

                def counted(self, *args, _name=name, _original=original, **kwargs):
                    calls.append(_name)
                    return _original(self, *args, **kwargs)

                monkeypatch.setattr(LocalStorage, name, counted)

            payload = client.get("/api/memory").json()
            assert calls.count("list_memory_pages") == 1
            assert calls.count("memory_domains") == 1
            assert [page["slug"] for page in payload["pages"]] == ["vae"]
            assert [(domain["slug"], domain["title"]) for domain in payload["domains"]] == [("ml", "ML")]

            # …and still answers with the same catalog it always did.
            assert [domain["slug"] for domain in payload["domains"]] == ["ml"]
    finally:
        app.dependency_overrides.clear()


def test_catalog_requires_a_real_member_and_does_not_count_its_domain_page(tmp_path):
    settings = signed_in(tmp_path)
    try:
        with TestClient(app) as client:
            client.post(
                "/api/auth/register",
                json={"username": "reader", "password": "password-123"},
            )
            storage = LocalStorage(settings)
            storage.upsert_memory_domain(
                "reader",
                {"slug": "empty-reader-domain", "title": "Empty reader domain", "origin": "reader"},
            )
            storage.upsert_memory_page(
                "reader",
                {
                    "slug": "model-invented-summary-domain",
                    "kind": "domain",
                    "domain": "model-invented-summary-domain",
                    "title": "Model invented summary domain",
                    "summary": "A stale domain page.",
                    "body": "A stale domain page with no member pages.",
                },
                max_pages=50,
            )
            storage.upsert_memory_page(
                "reader",
                {
                    "slug": "vae",
                    "kind": "concept",
                    "domain": "machine-learning",
                    "title": "VAE",
                    "summary": "A latent-variable model.",
                    "body": "A latent-variable model.",
                },
                max_pages=50,
            )

            overview = client.get("/api/memory").json()
            graph = client.get("/api/memory/graph").json()

            assert [(domain["slug"], domain["pages"]) for domain in overview["domains"]] == [
                ("machine-learning", 1)
            ]
            assert {page["slug"] for page in overview["pages"]} == {"vae"}
            assert graph["domains"] == overview["domains"]
            assert {page["slug"] for page in graph["pages"]} == {"vae"}
    finally:
        app.dependency_overrides.clear()


def test_health_reports_what_each_documents_last_job_dropped():
    """
    Health reads dropped targets from the newest event of each document's
    markers. A later job for the same document that wrote everything it staged
    clears the report; nothing else does, and nothing has to be marked resolved.
    """
    from delphi_core.memory_health import dropped_targets

    dropped = {"slug": "softcap", "title": "Softcap", "action": "create",
               "reason": "The passage never states the softcap.", "quote": "the softcap is 30 in every layer"}
    events = {
        "paper:p1": {"createdAt": "2026-10-01T10:00:00Z", "projectId": "proj-1", "paperId": "p1",
                     "outcome": "filed", "dropped": [dropped, {**dropped, "slug": "balance", "title": "Balance"}]},
        # A job that failed outright still names what it dropped.
        "paper:p2": {"createdAt": "2026-10-01T11:00:00Z", "projectId": "proj-1", "outcome": "failed",
                     "dropped": [{**dropped, "slug": "other", "extra": "not served"}]},
        "paper:p3": {"createdAt": "2026-10-01T12:00:00Z", "outcome": "filed", "dropped": []},
        # Not a document's marker: another kind of job's event is not read here.
        "session:paper:p1": {"createdAt": "2026-10-02T10:00:00Z", "dropped": [dropped]},
    }
    rows = dropped_targets(events)
    assert [(row["paperId"], row["slug"]) for row in rows] == [("p1", "balance"), ("p1", "softcap"), ("p2", "other")]
    assert rows[1] == {**dropped, "paperId": "p1", "projectId": "proj-1", "marker": "paper:p1",
                       "filedAt": "2026-10-01T10:00:00Z"}
    # The marker a retry names is the document's own, whichever job dropped the target.
    assert rows[2]["marker"] == "paper:p2" and "extra" not in rows[2]

    # The document's follow-up ran later and wrote what it staged: nothing is owed for p1.
    later = {**events, "paper:p1:part:1": {"createdAt": "2026-10-03T10:00:00Z", "outcome": "filed", "dropped": []}}
    assert [row["paperId"] for row in dropped_targets(later)] == ["p2"]
    assert dropped_targets({}) == []


def test_bare_greek_inside_authored_math_is_caught_before_the_verifier_is_paid(tmp_path):
    """`$alpha_t$` renders as the letters `alpha`, not as the variable.

    Knowable for free from the text, and otherwise found two model calls later
    by the paid verifier, which rejects the whole filing over a missing
    backslash. Scanned across 272 real filed pages it flagged five bodies and
    every one was a genuine defect, which is why it is restricted to Greek
    names: a false positive here rejects a page that was fine.
    """
    from delphi_core.research_digest import malformed_math_in_body as malformed

    assert malformed("The rate $alpha_t$ decays and $pi$ is fixed.") == [
        "alpha",
        "pi",
    ]
    assert malformed("$$\\beta = alpha + 1$$") == ["alpha"]
    assert malformed("\\(sigma^2\\) is the variance") == ["sigma"]

    # The two shapes this pass rejected *after* the first version of the check
    # shipped: a span that is only a broken newline escape carries no Greek
    # name, and a span holding a real line break was invisible to the span
    # regex altogether. Both were found by the paid verifier instead.
    assert "stray \\n" in malformed("the state $\\n$\\hat z_{t+1}=g(z_t)$")
    assert "unclosed $" in malformed("predict $\n$\\hat z_{t+1}=g(z_t)$")
    # `\nabla`, `\neq` and `\nu` all begin `\n` and are real commands.
    assert malformed("$\\nabla f$, $\\neq$, $\\nu$.") == []
    # A price is not an unclosed equation.
    assert malformed("It cost $12.50 today.\nThat is a lot.") == []
    assert malformed("It cost $5 and then $10.") == []

    # The shapes that must never be flagged: correct commands, ordinary
    # variables, the same words as prose, and a Greek name written as a literal
    # label rather than as a symbol.
    assert malformed("The rate $\\alpha_t$ decays and $\\pi$ holds.") == []
    assert malformed("Let $n$ be the count and $x_i$ the input.") == []
    assert malformed("The alpha release covers pi calculations.") == []
    assert malformed("$\\mathrm{pi}$ and $\\text{alpha}$ are labels.") == []
    assert malformed("$p_{\\theta}(x)$ is the model.") == []
    # Display math legitimately spans lines.
    assert malformed("$$\n\\beta = \\alpha + 1\n$$") == []


def test_no_authoring_prompt_smuggles_a_control_character():
    """`\\alpha` inside a non-raw string is a bell, not a Greek letter.

    Writing the mathematical-correctness guidance introduced exactly that: the
    skill shipped `\\x07lpha'_t` where it meant `\\alpha'_t`, teaching the author
    to emit a control character in the one section telling it to write correct
    LaTeX. Python only warns, and only for escapes that are *invalid* — `\\a`
    and `\\n` are both legal, so neither the interpreter nor any prose test
    would have said a word.
    """
    from delphi_core import memory as km
    from delphi_core import research_digest as rd

    prompts = {
        f"{module.__name__}.{name}": value
        for module in (km, rd)
        for name, value in vars(module).items()
        if name.isupper() and isinstance(value, str) and len(value) > 400
    }
    assert prompts, "no prompt constants found; has the naming changed?"
    for name, text in prompts.items():
        stray = {
            char for char in text if ord(char) < 32 and char not in "\n\t"
        }
        assert not stray, f"{name} contains control characters {stray!r}"


@pytest.mark.asyncio
async def test_a_stored_digest_with_bad_latex_still_files_its_source_page(
    tmp_path, monkeypatch
):
    """Refuse it at publication; never refuse it once it is stored.

    `validate_digest` rejects malformed LaTeX when the digest is written, where
    the next attempt can produce a better one. The same check over a *stored*
    digest has no such escape: the bytes never change, so every lease
    reproduces the failure, the job spends all three attempts and the document
    becomes unfilable -- for a missing backslash on a page that is otherwise
    the validated digest. Four digests in a real 47-document library
    carry this today, so it is the common shape rather than an edge of it.
    """
    from delphi_core import memory as km

    settings = Settings(data_dir=tmp_path)
    storage = LocalStorage(settings)
    storage.create_account("reader", None, "salt", "hash")
    project = storage.create_project("reader", "Reading")
    paper = storage.add_paper(
        "reader",
        project["id"],
        {"id": "paper-a", "title": "OLMoE", "filename": "olmoe.pdf", "pages": 9},
    )
    objects = LocalObjectStore(tmp_path)

    # Exactly the shape found in the wild: a bare Greek name in a hyperparameter.
    digest = {
        "contentMarkdown": "# OLMoE\n\nTrained with $eta=0.001$ throughout. [E1]",
        "citations": [{"id": 1, "claimType": "author-claim", "page": 3}],
        "assets": [],
    }

    page = await km.source_page_from_digest(
        objects,
        storage,
        "reader",
        project["id"],
        paper,
        digest,
        settings,
        slug="olmoe",
        domain="ml",
    )

    # It files, warts and all: the source page is the digest verbatim (§36f).
    assert page is not None
    upsert = page[0] if isinstance(page, tuple) else page
    assert "$eta=0.001$" in upsert.bodyMarkdown


def test_provider_schemas_require_every_declared_property():
    """Strict Responses schemas allow null, but never omitted properties."""

    schemas = {
        "knowledge_audit": audit_schema(),
        "knowledge_reorganization": reorganization_schema(),
    }
    for schema_name, schema in schemas.items():
        definitions = schema.get("$defs", {})
        for name, definition in {"root": schema, **definitions}.items():
            properties = definition.get("properties")
            if properties is not None:
                assert set(definition.get("required", ())) == set(properties), (
                    schema_name,
                    name,
                )


def test_delphis_own_chrome_asks_for_english_rather_than_only_refusing_it():
    """The UI-metadata fields say the rule the audit's validator enforces.

    `logEntry`, `method` and a page's `note` are Delphi's own chrome: they sit
    in the reader's Log beside every other pass, and `validate_memory_audit`
    refuses CJK in a lint's `logEntry` and `method`. A gate the model cannot
    see is not guidance, so the schema that travels with the call says it.
    """
    for build in (audit_schema,):
        assert "written in English" in json.dumps(build())