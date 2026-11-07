"""A linked PDF is read by page under a hard page ceiling, and its figures reach chat only through checked cards."""

import base64
import io
import json
import os
import re

import pikepdf
import pytest
from PIL import Image

from delphi_core.answer_trace import AnswerTrace
from delphi_core.artifacts.figure_card import card_image
from delphi_core.artifacts.session import ArtifactSession
from delphi_core.artifacts.types import SOURCE_MAX, RenderReport
from delphi_core.config import Settings
from delphi_core.harness import profiles
from delphi_core.harness.budget import TurnBudget
from delphi_core.harness.registry import Toolset
from delphi_core.harness.tool import ToolContext
from delphi_core.harness.tools import embed_figure, read_url, view_figure
from delphi_core.storage import LocalObjectStore, LocalStorage, memory_figure_key
from delphi_core.web_fetch import FetchedResource

SHOT = {"type": "input_image", "image_url": "data:image/png;base64,cGl4ZWxz", "detail": "high"}
URL = "https://example.org/paper.pdf"


def paper(pages, figure_on=(), path=None):
    """A PDF with one line of real text per page, and a picture on the pages named."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    picture = Image.frombytes("RGB", (480, 320), os.urandom(480 * 320 * 3))
    for number, text in enumerate(pages, start=1):
        page = pdf.add_blank_page(page_size=(612, 792))
        resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        lines = "".join(f"({line.replace('(', '[').replace(')', ']')}) Tj T* " for line in text.splitlines())
        # A figure sits at the top of its page, and the text, its caption included, below it.
        content = f"BT /F1 10 Tf 12 TL 72 {540 if number in figure_on else 740} Td {lines}ET ".encode()
        if number in figure_on:
            image = pikepdf.Stream(pdf, picture.tobytes())
            image.Type, image.Subtype = pikepdf.Name.XObject, pikepdf.Name.Image
            image.Width, image.Height = picture.size
            image.ColorSpace, image.BitsPerComponent = pikepdf.Name.DeviceRGB, 8
            resources.XObject = pikepdf.Dictionary(Im0=image)
            content += b"q 360 0 0 200 126 570 cm /Im0 Do Q"
        page.Resources = pdf.make_indirect(resources)
        page.Contents = pdf.make_indirect(pikepdf.Stream(pdf, content))
    buffer = io.BytesIO()
    pdf.save(buffer)
    return buffer.getvalue()


def context(offered=("read_url",), **settings):
    return ToolContext(settings=Settings(_env_file=None, **settings), offered=frozenset(offered))


def serve(monkeypatch, body, content_type="application/pdf", fetched=None):
    async def fetch(url, settings, **options):
        if fetched is not None:
            fetched.append(url)
        return FetchedResource(URL, body, content_type, "utf-8", "2026-10-28T00:00:00Z")

    monkeypatch.setattr(read_url, "fetch_resource", fetch)


async def call(ctx, tool, budget=None, **arguments):
    conversation = []
    payload = {"name": tool.NAME, "arguments": json.dumps(arguments), "call_id": "c"}
    async for _ in Toolset([tool.tool()]).dispatch(payload, ctx, budget or TurnBudget.for_chat(ctx.settings), AnswerTrace(), conversation):
        pass
    return conversation[0]["output"]


def read(ctx, budget=None, pages=(), offset=0, url=URL):
    return call(ctx, read_url, budget, url=url, offset=offset, pages=list(pages))


@pytest.mark.asyncio
async def test_a_pdf_is_read_by_page_from_one_fetch_and_never_as_the_file(monkeypatch):
    fetched = []
    serve(monkeypatch, paper([f"Page {n} says the corrector runs K times." for n in range(1, 7)]), fetched=fetched)
    ctx = context()
    spending = TurnBudget.for_chat(ctx.settings)
    first = await read(ctx, spending)
    assert all(f"--- Page {n} ---" in first for n in range(1, 5)) and "--- Page 5 ---" not in first
    assert "Page 3 says the corrector runs K times." in first
    assert '"pages": 6' in first and "Continue with pages=[5, 6]" in first
    last = await read(ctx, spending, pages=[6])
    assert "--- Page 6 ---" in last and "Last page." in last and "--- Page 1 ---" not in last
    assert fetched == [URL] and spending.document_calls_made == 2
    assert spending.document_chars_returned == len(first) + len(last)
    assert isinstance(first, str) and "%PDF" not in first


@pytest.mark.asyncio
async def test_a_pdf_over_the_page_ceiling_is_refused_before_its_text_is_read(monkeypatch):
    serve(monkeypatch, paper(["x"] * 101))
    ctx = context()
    output = await read(ctx)
    assert output.startswith("Error:") and "101 pages" in output and "up to 100 pages" in output
    assert not ctx.url_documents and not ctx.figures.has_pdf(URL)


@pytest.mark.asyncio
async def test_one_long_pdf_costs_no_more_than_the_turn_budget(monkeypatch):
    serve(monkeypatch, paper(["word " * 2000] * 40))
    ctx = context(webpage_read_max_chars=6_000, document_tool_max_chars=20_000)
    spending = TurnBudget.for_chat(ctx.settings)
    outputs = [await read(ctx, spending, pages=[n]) for n in range(1, 13)]
    assert all(len(output) <= 6_000 for output in outputs)
    assert "was cut at the character limit" in outputs[0]
    assert spending.document_chars_returned <= 20_000
    assert outputs[-1].startswith("Error:") and "budget" in outputs[-1]


@pytest.mark.asyncio
async def test_page_and_offset_arguments_say_how_to_correct_them(monkeypatch):
    serve(monkeypatch, paper(["one", "two"]))
    ctx = context()
    assert "offset=0 and pages=[] first" in await read(ctx, offset=5)
    assert "--- Page 2 ---" in await read(ctx, pages=[2])
    assert "has 2 pages" in await read(ctx, pages=[3])
    assert "Read this PDF with pages" in await read(ctx, offset=10)
    serve(monkeypatch, b"<title>T</title><article><p>Plain words here.</p></article>", content_type="text/html")
    other = "https://example.org/page"
    await read(ctx, url=other)
    assert "pages applies to PDFs only" in await read(ctx, url=other, pages=[1])


@pytest.mark.asyncio
async def test_figures_are_listed_by_id_only_to_tools_the_request_offers(monkeypatch):
    serve(monkeypatch, paper(["Introduction.", "Figure 1: The corrector loop.\nFigure 1 shows it again."], figure_on={2}))
    offered = context(offered=("read_url", "view_figure", "embed_figure"))
    output = await read(offered)
    assert "Figures here (view_figure or embed_figure takes the id):" in output
    assert "- source-fig-1 · p. 2 · Figure 1: The corrector loop." in output
    assert output.count("source-fig-") == 1
    assert "Figures here" not in await read(context())


@pytest.mark.asyncio
async def test_view_figure_cuts_the_listed_crop_in_the_worker(monkeypatch, tmp_path):
    serve(monkeypatch, paper(["Figure 1: The corrector loop."], figure_on={1}))
    ctx = context(offered=("read_url", "view_figure"))
    ctx.storage, ctx.objects = LocalStorage(Settings(_env_file=None, data_dir=tmp_path)), LocalObjectStore(tmp_path)
    await read(ctx)
    caption, image = await call(ctx, view_figure, figure_id="source-fig-1")
    assert caption["text"].startswith("Figure source-fig-1 (") and "The corrector loop." in caption["text"]
    pixels = base64.b64decode(image["image_url"].removeprefix("data:image/webp;base64,"))
    with Image.open(io.BytesIO(pixels)) as decoded:
        assert decoded.format == "WEBP" and min(decoded.size) >= 120
    missing = await call(ctx, view_figure, figure_id="fig-nowhere")
    assert missing == "Error: no stored figure with id 'fig-nowhere'."


def figure_session(reports):
    async def renderer(settings, title, source, checks):
        reports.append((title, source, checks))
        return RenderReport(True, image=SHOT, views=[{"width": 460}])

    settings = Settings(_env_file=None, artifact_renderer_path="/test/renderer")
    return settings, ArtifactSession(settings, renderer)


@pytest.mark.asyncio
async def test_embed_figure_drafts_a_template_card_that_publishes_like_a_diagram(monkeypatch, tmp_path):
    serve(monkeypatch, paper(["Figure 2: Sampling <with> K corrections."], figure_on={1}))
    reports = []
    settings, session = figure_session(reports)
    ctx = ToolContext(settings=settings, offered=frozenset({"read_url", "embed_figure"}), artifacts=session)
    await read(ctx)
    # A figure id comes from a read, so its card is drawn in a later round.
    session.round = 1
    output = await call(ctx, embed_figure, figure_id="source-fig-1", title="Figure 2\n· `Sampling`")
    caption, shot = output
    assert shot == SHOT and '"passed": true' in caption["text"]
    title, source, checks = reports[0]
    assert title == "Figure 2 · Sampling"
    assert checks == [] and len(source) <= SOURCE_MAX
    assert 'src="data:image/webp;base64,' in source
    assert "Figure 2: Sampling &lt;with&gt; K corrections." in source and "<with>" not in source
    assert f"p. 1 ({URL})" in source
    artifact_id = next(iter(session.drafts))
    session.round = 2
    assert "Published" in session.publish(artifact_id, 1, "The figure matches its caption.")


@pytest.mark.asyncio
async def test_a_card_rendered_beside_a_read_is_rechecked_free_under_its_id_and_retitled_as_a_revision(monkeypatch, tmp_path):
    serve(monkeypatch, paper(["Figure 2: Sampling with K corrections."], figure_on={1}))
    reports = []
    settings, session = figure_session(reports)
    ctx = ToolContext(settings=settings, offered=frozenset({"read_url", "embed_figure"}), artifacts=session)
    await read(ctx)
    session.round = 1
    await call(ctx, embed_figure, figure_id="source-fig-1", title="Figure 2")
    artifact_id = next(iter(session.drafts))
    session.read_round, session.round = 1, 2
    refused = session.publish(artifact_id, 1, "Checked.")
    assert "embed_figure with the same figure, title and artifact_id" in refused and "html" not in refused
    await call(ctx, embed_figure, figure_id="source-fig-1", title="Figure 2", artifact_id=artifact_id)
    assert session.drafts[artifact_id].revision == 1 and len(reports) == 2
    session.round = 3
    assert "Published" in session.publish(artifact_id, 1, "The figure matches its caption.")
    assert "HTML" not in session.publish(artifact_id, 1, "Again.")


@pytest.mark.asyncio
async def test_a_retitled_card_is_a_new_revision(monkeypatch, tmp_path):
    serve(monkeypatch, paper(["Figure 2: Sampling with K corrections."], figure_on={1}))
    reports = []
    settings, session = figure_session(reports)
    ctx = ToolContext(settings=settings, offered=frozenset({"read_url", "embed_figure"}), artifacts=session)
    await read(ctx)
    session.round = 1
    await call(ctx, embed_figure, figure_id="source-fig-1", title="Figure 2")
    artifact_id = next(iter(session.drafts))
    await call(ctx, embed_figure, figure_id="source-fig-1", title="Fig. 2", artifact_id=artifact_id)
    assert session.drafts[artifact_id].revision == 2 and session.drafts[artifact_id].title == "Fig. 2" and len(session.drafts) == 1


@pytest.mark.asyncio
async def test_embed_figure_takes_a_memory_figure_and_refuses_what_it_cannot_show(tmp_path):
    reports = []
    settings, session = figure_session(reports)
    storage, objects = LocalStorage(Settings(_env_file=None, data_dir=tmp_path)), LocalObjectStore(tmp_path)
    storage.create_account("reader", None, "salt", "hash")
    storage.upsert_memory_page("reader", {"slug": "corrector", "kind": "concept", "domain": "ml", "title": "Corrector",
                                          "summary": "What the corrector does.", "body": "A page."}, max_pages=200)
    buffer = io.BytesIO()
    Image.new("RGB", (300, 200), "white").save(buffer, "WEBP")
    for figure_id, ext, mime, body in (("fig-kept", "webp", "image/webp", buffer.getvalue()), ("fig-drawn", "svg", "image/svg+xml", b"<svg/>")):
        key = memory_figure_key("reader", figure_id, ext=ext)
        upload = tmp_path / f"upload.{ext}"
        upload.write_bytes(body)
        objects.put_file(key, upload, mime)
        storage.add_memory_figure("reader", {"id": figure_id, "pageSlug": "corrector", "caption": "The loop", "objectKey": key,
                                             "mimeType": mime, "width": 300, "height": 200, "bytes": len(body)}, max_per_page=6)
    ctx = ToolContext(settings=settings, username="reader", storage=storage, objects=objects, artifacts=session)
    caption, _ = await call(ctx, embed_figure, figure_id="fig-kept", title="The loop")
    assert '"passed": true' in caption["text"] and "From your Memory" in reports[0][1]
    assert "cannot be embedded" in await call(ctx, embed_figure, figure_id="fig-drawn", title="Drawn")
    assert await call(ctx, embed_figure, figure_id="fig-nowhere", title="None") == "Error: no stored figure with id 'fig-nowhere'."
    assert len(reports) == 1


def test_a_card_image_always_fits_the_draft_limit_or_is_refused():
    def webp(image):
        buffer = io.BytesIO()
        image.save(buffer, "WEBP", quality=95)
        return buffer.getvalue()

    chart = Image.new("RGB", (3000, 2000), "white")
    for x in range(0, 3000, 40):
        chart.paste((62, 123, 201), (x, 2000 - (x * 7) % 1900, x + 30, 2000))
    fitted = card_image(webp(chart))
    assert fitted is not None and len(fitted) < SOURCE_MAX - 3_000
    with Image.open(io.BytesIO(base64.b64decode(fitted.split(",", 1)[1]))) as decoded:
        assert max(decoded.size) == 1200
    noise = card_image(webp(Image.frombytes("RGB", (3000, 2000), os.urandom(3000 * 2000 * 3))))
    assert noise is None or len(noise) < SOURCE_MAX - 3_000


def test_figures_are_offered_with_any_source_of_figures_and_never_to_maintenance():
    on = Settings(_env_file=None, web_search_enabled=True, artifact_renderer_path="/r", memory_enabled=False)
    document = profiles.CHAT_DOCUMENT.toolset(profiles.Turn(on, web=True)).names
    assert {"view_figure", "embed_figure", "read_url"} <= document
    quiet = profiles.CHAT_DOCUMENT.toolset(profiles.Turn(on, web=False)).names
    assert "view_figure" not in quiet and "embed_figure" not in quiet
    assert "embed_figure" not in profiles.CHAT_GENERAL.toolset(profiles.Turn(on, web=True, artifacts=False)).names
    for profile in profiles.PROFILES:
        if profile not in profiles.CHAT_PROFILES:
            assert "embed_figure" not in profile.toolset(profiles.Turn(on, web=True)).names


@pytest.mark.asyncio
async def test_a_described_web_image_is_listed_and_fetched_through_the_guarded_fetcher(monkeypatch, tmp_path):
    from delphi_core import web_fetch

    page = b'<title>Batch size</title><article><h1>Results</h1><p>Loss falls.</p><img src="/loss.png" alt="Loss against batch size"><img src="/logo.svg" alt="Site logo"><img src="/spacer.png" alt=""></article>'
    serve(monkeypatch, page, content_type="text/html")
    buffer = io.BytesIO()
    Image.new("RGB", (640, 400), "white").save(buffer, "PNG")
    fetched = []

    async def fetch_image(url, settings, **options):
        fetched.append((url, options))
        return FetchedResource(url, buffer.getvalue(), "image/png", "utf-8", "2026-10-28T00:00:00Z")

    monkeypatch.setattr(web_fetch, "fetch_resource", fetch_image)
    ctx = context(offered=("read_url", "view_figure"))
    ctx.storage, ctx.objects = LocalStorage(Settings(_env_file=None, data_dir=tmp_path)), LocalObjectStore(tmp_path)
    output = await read(ctx, url="https://example.org/page")
    assert "- source-fig-1 · Loss against batch size" in output
    assert "logo" not in output.split("Figures here", 1)[1] and "source-fig-2" not in output
    caption, image = await call(ctx, view_figure, figure_id="source-fig-1")
    assert fetched == [("https://example.org/loss.png", {"include_images": True})]
    assert "Loss against batch size" in caption["text"] and image["image_url"].startswith("data:image/webp;base64,")


def test_a_reader_asks_about_a_paper_and_gets_its_own_figure_checked_and_saved(tmp_path, monkeypatch):
    """
    The whole workflow, through the chat route: the model reads a linked PDF by
    page, embeds the figure the page lists, inspects the render, publishes it,
    and the answer the reader sees and keeps carries Delphi's card. The PDF
    never reaches the provider, and the figure's pixels stay out of the trace.
    """
    import httpx
    from fastapi.testclient import TestClient

    from delphi_core.app import Stores, create_app
    from delphi_core.routers import chat as chat_router
    from tests.chat_keys import conversation_params

    body = paper(["Abstract. A corrector is trained beside the denoiser.",
                  "Figure 1: The corrector is applied K times per denoising step."], figure_on={2})
    serve(monkeypatch, body)
    rendered = []

    async def renderer(settings, title, source, checks):
        rendered.append(source)
        return RenderReport(True, image=SHOT, views=[{"width": 460}])

    config = Settings(_env_file=None, data_dir=tmp_path, session_secret="figure-route", openai_api_key="test-key",
                      artifact_renderer_path="/test/renderer", web_search_enabled=True)
    requests = []

    def frame(event):
        return "data: " + json.dumps(event) + "\n\n"

    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        outputs = [item for item in payload["input"] if item.get("type") == "function_call_output"]
        if "And the denoiser?" in json.dumps(payload["input"][-1]):
            answer = "The denoiser is unchanged."
            events = [{"type": "response.output_text.delta", "delta": answer},
                      {"type": "response.output_item.done", "item": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": answer}]}},
                      {"type": "response.completed", "response": {"status": "completed"}}]
            return httpx.Response(200, content="".join(frame(event) for event in events))
        if not outputs:
            item = {"type": "function_call", "name": "read_url", "call_id": "read",
                    "arguments": json.dumps({"url": URL, "offset": 0, "pages": []})}
        elif len(outputs) == 1:
            listed = re.search(r"- (source-fig-\d+) · p\. 2 · Figure 1:", outputs[0]["output"])[1]
            item = {"type": "function_call", "name": "embed_figure", "call_id": "embed",
                    "arguments": json.dumps({"figure_id": listed, "title": "Figure 1 · The corrector loop"})}
        elif len(outputs) == 2:
            feedback, pixels = outputs[1]["output"]
            assert pixels == SHOT
            report, _ = json.JSONDecoder().raw_decode(feedback["text"])
            item = {"type": "function_call", "name": "publish_artifact", "call_id": "publish",
                    "arguments": json.dumps({"artifact_id": report["artifact_id"], "revision": report["revision"],
                                             "review": "The image is the corrector loop its caption names."})}
        else:
            reference = re.search(r"\[\[delphi-artifact:[^\]]+\]\]", outputs[-1]["output"])[0]
            answer = f"The paper applies its corrector K times per step ([paper]({URL})).\n\n{reference}\n"
            events = [{"type": "response.output_text.delta", "delta": answer},
                      {"type": "response.output_item.done", "item": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": answer}]}},
                      {"type": "response.completed", "response": {"status": "completed"}}]
            return httpx.Response(200, content="".join(frame(event) for event in events))
        events = [{"type": "response.output_item.done", "item": item}, {"type": "response.completed", "response": {"status": "completed"}}]
        return httpx.Response(200, content="".join(frame(event) for event in events))

    real_client = httpx.AsyncClient
    monkeypatch.setattr(chat_router.httpx, "AsyncClient", lambda *args, **kwargs: real_client(
        *args, **{**kwargs, "transport": httpx.MockTransport(handler)}))
    monkeypatch.setattr(chat_router, "ArtifactSession", lambda settings, **kwargs: ArtifactSession(settings, renderer, **kwargs))
    app = create_app(config, stores=Stores.local())
    with TestClient(app) as client:
        client.post("/api/auth/register", json={"username": "reader", "password": "password-test"})
        conversation = conversation_params(client, "general")
        response = client.post("/api/chat/stream", json={**conversation, "prompt": "How does correction training sample? Show their figure.", "request_id": "figure_route_1"})
        assert response.status_code == 200, response.text
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        assert events[-1]["type"] == "done" and not events[-1].get("incomplete")
        delivered = "".join(event["text"] for event in events if event["type"] == "delta")
        stored = client.get("/api/chat", params=conversation).json()["messages"][-1]
        follow_up = client.post("/api/chat/stream", json={**conversation, "prompt": "And the denoiser?", "request_id": "figure_route_2"})
        assert follow_up.status_code == 200, follow_up.text

    later = requests.pop()
    assert len(requests) == 4 and len(rendered) == 1
    assert {"read_url", "embed_figure", "view_figure", "publish_artifact"} <= {tool.get("name") for tool in requests[0]["tools"]}
    sent = json.dumps(requests)
    assert "input_file" not in sent and "%PDF" not in sent and base64.b64encode(body[:48]).decode() not in sent
    assert "--- Page 2 ---" in sent and "applied K times per denoising step" in sent
    assert "delphi-artifact Figure 1 · The corrector loop" in delivered and "[[delphi-artifact:" not in delivered
    assert 'src="data:image/webp;base64,' in delivered and "Figure 1: The corrector is applied K times" in delivered
    assert stored["content"] == delivered.strip()
    pixels = re.search(r'src="data:image/webp;base64,([^"]+)"', delivered)[1]
    assert pixels[:200] not in sent
    replayed = json.dumps(later["input"])
    assert "Figure 1: The corrector is applied K times" in replayed and pixels[:200] not in replayed
    assert "data:image/webp;base64,[image omitted]" in replayed
    trace = json.dumps(stored.get("trace"))
    assert '"embed_figure"' in trace and '"read_url"' in trace and "base64," not in trace


def page_of(images, text, drawn=b""):
    """One page of placed pictures and positioned text lines: images are (size, placement), text is (x, y, line)."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    page = pdf.add_blank_page(page_size=(612, 792))
    objects, content = pikepdf.Dictionary(), b"".join(f"BT /F1 10 Tf {x} {y} Td ({line}) Tj ET ".encode() for x, y, line in text)
    for number, ((width, height), placement) in enumerate(images):
        picture = Image.frombytes("RGB", (width, height), os.urandom(width * height * 3))
        stream = pikepdf.Stream(pdf, picture.tobytes())
        stream.Type, stream.Subtype = pikepdf.Name.XObject, pikepdf.Name.Image
        stream.Width, stream.Height, stream.ColorSpace, stream.BitsPerComponent = width, height, pikepdf.Name.DeviceRGB, 8
        objects[f"/Im{number}"] = stream
        content += f"q {placement} cm /Im{number} Do Q ".encode()
    page.Resources = pdf.make_indirect(pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font), XObject=objects))
    page.Contents = pdf.make_indirect(pikepdf.Stream(pdf, content + drawn))
    buffer = io.BytesIO()
    pdf.save(buffer)
    return buffer.getvalue()


async def viewed(ctx, figure_id):
    caption, image = await call(ctx, view_figure, figure_id=figure_id)
    with Image.open(io.BytesIO(base64.b64decode(image["image_url"].split(",", 1)[1]))) as decoded:
        return caption["text"], decoded.width / decoded.height


def figure_context(tmp_path):
    ctx = context(offered=("read_url", "view_figure"))
    ctx.storage, ctx.objects = LocalStorage(Settings(_env_file=None, data_dir=tmp_path)), LocalObjectStore(tmp_path)
    return ctx


@pytest.mark.asyncio
async def test_each_caption_gets_the_picture_just_above_it_not_the_largest(monkeypatch, tmp_path):
    # Top: wide and short. Below: larger and square, so a ranking by area puts it first.
    serve(monkeypatch, page_of(
        [((600, 200), "360 0 0 120 126 600"), ((400, 400), "300 0 0 300 156 180")],
        [(72, 585, "Figure 1: The small one on top."), (72, 165, "Figure 2: The large one below.")],
    ))
    ctx = figure_context(tmp_path)
    output = await read(ctx)
    assert "source-fig-1 · p. 1 · Figure 1: The small one on top." in output and "source-fig-2 · p. 1 · Figure 2" in output
    (first, wide), (_, square) = await viewed(ctx, "source-fig-1"), await viewed(ctx, "source-fig-2")
    assert wide > 2 and 0.8 < square < 1.25 and "page region" not in first


@pytest.mark.asyncio
@pytest.mark.parametrize("separator", [":", "."])
async def test_a_body_line_that_opens_with_the_figure_never_takes_its_caption(monkeypatch, tmp_path, separator):
    # The text opens a line with "Figure 1." above the picture; its caption sits below it.
    serve(monkeypatch, page_of(
        [((600, 200), "360 0 0 120 126 300")],
        [(72, 700, "Figure 1. We train the corrector first, as the loop shows."), (72, 285, f"Figure 1{separator} The corrector loop.")],
    ))
    ctx = figure_context(tmp_path)
    output = await read(ctx)
    listed = output.split("Figures here", 1)[1]
    assert "Figure 1: The corrector loop." in listed and ("We train" in listed) == (separator == ".")
    caption = re.search(r"- (source-fig-\d+) · p\. 1 · Figure 1: The corrector loop\.", listed)[1]
    text, wide = await viewed(ctx, caption)
    assert wide > 2 and "page region" not in text


@pytest.mark.asyncio
async def test_a_figure_drawn_as_vector_art_is_cut_as_the_region_above_its_caption_and_says_so(monkeypatch, tmp_path):
    # A raster figure higher up, and a vector drawing whose caption has no picture object above it.
    serve(monkeypatch, page_of(
        [((600, 200), "360 0 0 120 126 620")],
        [(72, 605, "Figure 1: A photograph."), (72, 285, "Figure 2: A drawn diagram.")],
        drawn=b"0.2 0.4 0.8 rg 100 320 400 200 re f",
    ))
    ctx = figure_context(tmp_path)
    await read(ctx)
    text, _ = await viewed(ctx, "source-fig-2")
    assert "page region above it" in text and "Figure 2: A drawn diagram." in text
    # And the photograph is not mistaken for it: its own caption still finds it.
    text, wide = await viewed(ctx, "source-fig-1")
    assert wide > 2 and "page region" not in text


def test_a_page_of_any_claimed_size_renders_within_the_pixel_budget():
    from delphi_core.pdf_figures import MAX_RENDER_PIXELS, RENDER_SCALE, _render_scale

    assert _render_scale(612, 792) == RENDER_SCALE
    huge = _render_scale(14_400, 14_400)
    assert (14_400 * huge) ** 2 <= MAX_RENDER_PIXELS * 1.0001


@pytest.mark.asyncio
async def test_memory_figures_stay_closed_when_memory_is_off(monkeypatch, tmp_path):
    serve(monkeypatch, paper(["Figure 1: The corrector loop."], figure_on={1}))
    ctx = figure_context(tmp_path)
    ctx.settings = Settings(_env_file=None, memory_enabled=False)
    await read(ctx)
    assert await call(ctx, view_figure, figure_id="fig-anything") == (
        "Error: no figure with id 'fig-anything' in this turn. Use an id a source read listed."
    )
    text, _ = await viewed(ctx, "source-fig-1")
    assert "The corrector loop." in text


@pytest.mark.asyncio
async def test_two_columns_keep_their_own_figures_and_share_a_caption_line(monkeypatch, tmp_path):
    # Left: a picture over Figure 1. Right: Figure 2 drawn as vector art, its caption on the same row,
    # which the text extractor returns as one line with Figure 1's.
    serve(monkeypatch, page_of(
        [((400, 400), "220 0 0 300 72 400")],
        [(72, 380, "Figure 1: Raster on the left."), (320, 380, "Figure 2: Vector on the right.")],
        drawn=b"0.1 0.7 0.1 rg 320 400 220 300 re f",
    ))
    ctx = figure_context(tmp_path)
    listed = (await read(ctx)).split("Figures here", 1)[1]
    assert "Figure 1: Raster on the left." in listed and "· Figure 2: Vector on the right." in listed
    left, _ = await viewed(ctx, "source-fig-1")
    right, _ = await viewed(ctx, "source-fig-2")
    assert "page region" not in left and "page region above it" in right


@pytest.mark.asyncio
async def test_a_grid_of_panels_and_a_tall_figure_come_back_whole(monkeypatch, tmp_path):
    serve(monkeypatch, page_of(
        [((300, 300), "200 0 0 200 72 520"), ((300, 300), "200 0 0 200 340 520"), ((400, 400), "300 0 0 400 156 80")],
        [(72, 500, "Figure 1: Two panels, (a) and (b)."), (72, 60, "Figure 2: A tall figure.")],
    ))
    ctx = figure_context(tmp_path)
    await read(ctx)
    (grid_text, grid), (tall_text, tall) = await viewed(ctx, "source-fig-1"), await viewed(ctx, "source-fig-2")
    assert grid > 2 and 0.65 < tall < 0.85 and "page region" not in grid_text + tall_text


@pytest.mark.asyncio
async def test_pages_past_the_text_cap_read_as_unknown_not_empty(monkeypatch):
    serve(monkeypatch, paper(["A first page with enough words to fill the cap.", "Second page.", "Third page."]))
    output = await read(context(web_max_extract_chars=30), pages=[3])
    assert "[Not extracted: this PDF's text cap was reached before this page.]" in output
    assert "No extractable text" not in output
