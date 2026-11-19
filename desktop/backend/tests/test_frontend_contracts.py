"""
What the desktop's interface shares with core, read from both sides.

Each check here holds a value the interface keeps in its own source against the
core it ships with. Core pins its side of each (`core/tests/test_harness_structure.py`
G8, `core/tests/test_web.py`); the comparison lives with the frontend that can drift.
"""
import json
from pathlib import Path
import re

from delphi_core.harness import profiles
from delphi_core.web_proxy import bridge_source

#: desktop/
DESKTOP = Path(__file__).resolve().parents[2]


def chat_tools() -> list[str]:
    """The names of the tools a chat profile offers: what a reader's own turn can call."""
    return sorted({offer.tool.name for profile in profiles.CHAT_PROFILES for offer in profile.offers})


def test_the_desktop_draws_a_row_for_every_tool_a_chat_profile_offers():
    """
    G8, the desktop's half. The trace's wording lives in the interface, one row
    per tool, keyed by the tool's name. This list is what holds the two sides
    together: it must equal the tools a chat profile offers, and the
    interface's own test (`frontend/tests/answer-trace.test.mts`) requires its
    rows to equal the same file. A chat tool renamed or added on either side
    alone fails. The same file is the list the matrix journey plays.
    """
    listed = json.loads((DESKTOP / "frontend" / "tests" / "fixtures" / "tool-catalogue.json").read_text(encoding="utf-8"))
    assert listed == chat_tools()


def test_the_bridge_and_the_panel_agree_on_what_rendered_means():
    """
    The bridge decides both when a page is readable and when one is blank, and
    says so. A bridge from before it sent that verdict reports only a count of
    characters, and the panel then judges by its own number: if the two drift
    apart, a page can be announced readable and then immediately called empty.
    """
    bridge = bridge_source()
    viewer = (DESKTOP / "frontend" / "app" / "components" / "PageViewer.tsx").read_text(encoding="utf-8")

    readable = re.search(r"\bvar READABLE_CHARS = (\d+);", bridge)
    rendered = re.search(r"\bconst RENDERED_CHARS = (\d+);", viewer)
    assert readable and rendered, "a threshold is no longer spelled where this check reads it"
    assert rendered[1] == readable[1]
    assert "blank: blank()," in bridge
    assert 'typeof data.blank === "boolean"' in viewer
