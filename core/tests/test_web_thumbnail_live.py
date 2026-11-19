"""Import real pages and photograph them, exactly as adding a page does.

Every other thumbnail test stubs Chromium or the network, so none of them can
see the failures that actually reach the Dashboard: a site that refuses the
second request, a video player that never holds still, a Notion page whose
served HTML is a loading skeleton. These can, and only against the live sites.

Opt-in, because they depend on third parties and a local Chrome:

    DELPHI_LIVE_WEB=1 backend/.venv/bin/python -m pytest -m live_web
"""

import asyncio
import io
import os

import pytest
from PIL import Image, ImageStat

import delphi_core.dashboard as dashboard_module
from delphi_core.browser_render import _chrome_executable
from delphi_core.config import Settings
from delphi_core.dashboard import make_web_thumbnail
from delphi_core.routers.projects import snapshot_page
from delphi_core.storage import LocalObjectStore, paper_key

pytestmark = [
    pytest.mark.live_web,
    pytest.mark.skipif(
        os.environ.get("DELPHI_LIVE_WEB") != "1",
        reason="live web capture; set DELPHI_LIVE_WEB=1",
    ),
]

PAGES = {
    # A server-rendered article whose hero is a <video>, on a host that rate
    # limits automated readers between the import and the capture.
    "video-player": "https://www.pi.website/blog/pi07",
    "plain-html": "https://thinkingmachines.ai/blog/on-policy-distillation/",
    "notion": "https://alisawuffles.notion.site/alisa-s-book-of-llms",
}


@pytest.mark.parametrize("url", PAGES.values(), ids=PAGES.keys())
def test_an_imported_page_gets_a_real_thumbnail(url, tmp_path):
    if not _chrome_executable():
        pytest.skip("no Chrome or Chromium to capture with")
    settings = Settings(data_dir=tmp_path)
    objects = LocalObjectStore(tmp_path / "objects")

    async def add_page():
        # The capture slot is an asyncio primitive bound to the loop that made it.
        dashboard_module._CAPTURE_SLOT = None
        document = await snapshot_page(url, objects, settings, "reader", "project", "paper")
        return await make_web_thumbnail(
            document["title"], document["url"], document.get("favicon"), objects,
            settings, "reader", "project", "paper",
            settings.web_thumbnail_inline_seconds,
        )

    assert asyncio.run(add_page()) is True, "fell back to the placeholder card"
    key = paper_key("reader", "project", "paper", "thumb")
    assert not dashboard_module._is_fallback_web_thumbnail(objects, key)
    card = Image.open(io.BytesIO(b"".join(objects.open_range(key)))).convert("L")
    # A photograph of an article has ink on it. An empty shell, a skeleton or a
    # blank white window does not, and each has passed as a PNG before. The
    # bound is set by the Notion outline, a sparse monospace list at ~1% ink;
    # a skeleton's pale bars never reach below 200.
    inked = sum(1 for pixel in card.getdata() if pixel < 200) / (card.width * card.height)
    assert inked > 0.005, f"{inked:.1%} of the card is ink"
    assert ImageStat.Stat(card).stddev[0] > 8
