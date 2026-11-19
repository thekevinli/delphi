"""
Two of the Memory tools a chat reads with, where no other test reaches:
`memory_links` past its cap on each hop, and `view_figure`.

Every call goes through `Toolset.dispatch` with the account-wide chat's
toolset, so what is tested is what the model is handed: the tool's prose and,
for a figure, the image inside the call's result. No model is called.
"""

import base64
import json

import pytest

from delphi_core.answer_trace import AnswerTrace
from delphi_core.config import Settings
from delphi_core.harness import profiles
from delphi_core.harness.budget import TurnBudget
from delphi_core.harness.tool import ToolContext
from delphi_core.memory_harness import MEMORY_LINKS_MAX_PER_HOP
from delphi_core.storage import LocalObjectStore, LocalStorage, memory_figure_key, paper_key
from tests.helpers import put_bytes

pytestmark = pytest.mark.kb_maintenance


class Chat:
    """An account-wide chat turn's tools, over a real local store."""

    def __init__(self, tmp_path):
        self.settings = Settings(_env_file=None, data_dir=tmp_path)
        self.storage = LocalStorage(self.settings)
        self.objects = LocalObjectStore(tmp_path)
        self.storage.create_account("reader", None, "salt", "hash")
        self.toolset = profiles.CHAT_GENERAL.toolset(profiles.Turn(self.settings))
        self.ctx = ToolContext(
            settings=self.settings, username="reader", storage=self.storage, objects=self.objects,
            offered=self.toolset.names,
        )

    def page(self, slug, body="A page."):
        self.storage.upsert_memory_page("reader", {
            "slug": slug, "kind": "concept", "domain": "ml", "title": slug.replace("-", " ").capitalize(),
            "summary": f"What {slug} says.", "body": body,
        }, max_pages=200)

    async def call(self, name, **arguments) -> list[dict]:
        """What the model's next round is handed: prose and any image in one tool result."""
        conversation: list[dict] = []
        call = {"name": name, "arguments": json.dumps(arguments), "call_id": "c1"}
        async for _ in self.toolset.dispatch(call, self.ctx, TurnBudget.for_chat(self.settings), AnswerTrace(), conversation):
            pass
        return conversation


@pytest.mark.asyncio
async def test_memory_links_says_how_many_links_it_left_out(tmp_path):
    """Past the cap a hop lists what it can and says how many more there are, so the model knows it saw part."""
    chat = Chat(tmp_path)
    over = MEMORY_LINKS_MAX_PER_HOP + 1
    near = [f"near-{index:02d}" for index in range(over)]
    far = [f"far-{index:02d}" for index in range(over)]
    for slug in near + far:
        chat.page(slug)
    chat.page("wide", " ".join(f"[[{slug}]]" for slug in near))
    chat.page("bridge", " ".join(f"[[{slug}]]" for slug in far))
    chat.page("deep", "[[bridge]]")

    [one_hop] = await chat.call("memory_links", slug="wide", hops=1)
    assert one_hop["output"].count("\n→ ml/concept/near-") == MEMORY_LINKS_MAX_PER_HOP
    assert "\n…and 1 more linked page(s)." in one_hop["output"]

    [two_hops] = await chat.call("memory_links", slug="deep", hops=2)
    assert "\n→ ml/concept/bridge — Bridge\n" in two_hops["output"]
    assert two_hops["output"].count("\n· ml/concept/far-") == MEMORY_LINKS_MAX_PER_HOP
    assert "\n…and 1 more two links away." in two_hops["output"]


@pytest.mark.asyncio
async def test_the_memory_chat_reads_a_library_web_page_filed_in_any_project(tmp_path):
    """
    The account-wide chat opens a library web page from its stored copy, wherever
    it is filed, as it opens a PDF there. Without this its search found the page,
    said it could not be opened, and the model read the public original instead.
    """
    chat = Chat(tmp_path)
    optimizers = chat.storage.create_project("reader", "Optimizers")
    chat.storage.add_paper("reader", optimizers["id"], {
        "id": "muon-page", "kind": "web", "title": "Muon: An optimizer for hidden layers",
        "filename": "kellerjordan.github.io/posts/muon", "url": "https://kellerjordan.github.io/posts/muon/", "pages": 2,
    })
    chat.objects.put_text(paper_key("reader", optimizers["id"], "muon-page", "web"), json.dumps({
        "title": "Muon", "url": "https://kellerjordan.github.io/posts/muon/",
        "sections": [
            {"anchor": "definition", "title": "Definition", "markdown": "Muon orthogonalizes the momentum."},
            {"anchor": "算法初探", "title": "算法初探", "markdown": "Newton–Schulz iterations."},
        ],
    }))

    [section] = await chat.call("read_webpage", doc_id="muon-page", anchor="definition")
    assert "Muon orthogonalizes the momentum." in section["output"]
    [chinese] = await chat.call("read_webpage", doc_id="muon-page", anchor="§算法初探")
    assert "Newton–Schulz iterations." in chinese["output"]
    # A wrong anchor is told the ones there are, so the next round can correct it.
    [wrong] = await chat.call("read_webpage", doc_id="muon-page", anchor="results")
    assert "Its anchors are: definition, 算法初探." in wrong["output"]
    # A page the account does not hold is refused in prose, never raised.
    [missing] = await chat.call("read_webpage", doc_id="nowhere", anchor="definition")
    assert missing["output"].startswith("Error: no web document with doc_id 'nowhere'")


@pytest.mark.asyncio
async def test_only_the_memory_chat_reads_web_pages_across_the_account(tmp_path):
    """A document question reads its project's pages and a maintenance run one; neither reaches the account."""
    chat = Chat(tmp_path)
    elsewhere = chat.storage.create_project("reader", "Elsewhere")
    chat.storage.add_paper("reader", elsewhere["id"], {"id": "post", "kind": "web", "title": "Post", "filename": "x", "pages": 1})
    chat.objects.put_text(paper_key("reader", elsewhere["id"], "post", "web"), json.dumps({
        "title": "Post", "sections": [{"anchor": "intro", "title": "Intro", "markdown": "Elsewhere."}],
    }))
    narrow = profiles.MEMORY_MAINTAIN.toolset(profiles.Turn(chat.settings, web_documents=True))
    conversation: list[dict] = []
    call = {"name": "read_webpage", "arguments": json.dumps({"doc_id": "post", "anchor": "intro"}), "call_id": "c1"}
    async for _ in narrow.dispatch(call, chat.ctx, TurnBudget.for_chat(chat.settings), AnswerTrace(), conversation):
        pass
    assert conversation[0]["output"].startswith("Error: no web document with doc_id 'post'")


@pytest.mark.asyncio
async def test_view_figure_hands_the_model_the_stored_figure(tmp_path):
    """
    A captured figure arrives as an image in the call's result; a figure kept
    as a link, or an id nothing holds, is answered in prose the model can act on.
    """
    chat = Chat(tmp_path)
    chat.page("kl-divergence", "Where the gap opens.")
    pixels = b"RIFF\x1a\x00\x00\x00WEBPVP8 stored figure"
    stored = memory_figure_key("reader", "fig-stored")
    put_bytes(chat.objects, stored, pixels)
    chat.storage.add_memory_figure("reader", {
        "id": "fig-stored", "pageSlug": "kl-divergence", "caption": "Where the gap opens",
        "objectKey": stored, "width": 8, "height": 4, "bytes": len(pixels),
    }, max_per_page=6)
    chat.storage.add_memory_figure("reader", {
        "id": "fig-linked", "pageSlug": "kl-divergence", "caption": "The architecture",
        "sourceUrl": "https://example.test/fig.png",
    }, max_per_page=6)

    [output] = await chat.call("view_figure", figure_id="fig-stored")
    assert output["type"] == "function_call_output" and output["call_id"] == "c1"
    caption, image = output["output"]
    assert caption == {"type": "input_text", "text": "Figure fig-stored is attached below. Caption: Where the gap opens"}
    assert (image["type"], image["detail"]) == ("input_image", "low")
    assert base64.b64decode(image["image_url"].removeprefix("data:image/webp;base64,")) == pixels

    [linked] = await chat.call("view_figure", figure_id="fig-linked")
    assert linked["output"] == (
        "Figure fig-linked was kept as a link rather than captured, so there is nothing to look at. "
        "Its caption is: The architecture"
    )
    [unknown] = await chat.call("view_figure", figure_id="fig-nowhere")
    assert unknown["output"] == "Error: no stored figure with id 'fig-nowhere'."


@pytest.mark.xfail(strict=True, reason=(
    "memory_figure_block declares every figure's bytes image/webp, so an SVG a web "
    "document's digest captured reaches the model as SVG text labelled WebP"
))
@pytest.mark.asyncio
async def test_view_figure_never_hands_the_model_an_svg_under_another_type(tmp_path):
    """
    A web document's digest keeps an inline SVG as an SVG, and its source page
    keeps the figure with that type. What the model is handed must say what
    the bytes are, or be prose; never SVG text declared as a raster image.
    """
    chat = Chat(tmp_path)
    chat.page("transformer", "The architecture, drawn.")
    drawing = b'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"><rect width="8" height="4"/></svg>'
    stored = memory_figure_key("reader", "fig-drawn", ext="svg")
    put_bytes(chat.objects, stored, drawing)
    chat.storage.add_memory_figure("reader", {
        "id": "fig-drawn", "pageSlug": "transformer", "caption": "The architecture",
        "objectKey": stored, "mimeType": "image/svg+xml", "width": 8, "height": 4, "bytes": len(drawing),
    }, max_per_page=6)

    handed = await chat.call("view_figure", figure_id="fig-drawn")

    for turn in handed:
        for part in turn["output"] if isinstance(turn["output"], list) else []:
            if part["type"] != "input_image":
                continue
            declared, _, encoded = part["image_url"].removeprefix("data:").partition(";base64,")
            assert base64.b64decode(encoded) != drawing or declared == "image/svg+xml", declared
