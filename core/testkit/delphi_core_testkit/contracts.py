"""
What a frontend has to agree with the backend on, read from the installed `delphi_core`.

Each frontend keeps its own copy of these, in its own language, and its own
test holds that copy to what is here, so a change on either side alone fails:

    chat_tool_names()   the tools a chat profile offers: a trace draws one
                        row for each, keyed by its name (G8)
    frame_script(name)  a script the backend serves into the web frame, as
                        the package ships it
    READABLE_CHARS      the characters of text after which the bridge calls
                        a page readable; a panel that judges a page rendered
                        by its own count must use the same number
"""

import re
from importlib import resources

#: The scripts the backend serves into the sandboxed web frame or its worker.
FRAME_SCRIPTS = ("web_bridge.js", "web_annotation_bridge.js", "web_annotations.js", "web_annotation_worker.js")


def chat_tool_names() -> list[str]:
    """The tools a chat profile offers, sorted. A tool only a maintenance run is offered appears in no trace."""
    from delphi_core.harness import profiles

    return sorted({offer.tool.name for profile in profiles.CHAT_PROFILES for offer in profile.offers})


def frame_script(name: str) -> str:
    """One of `FRAME_SCRIPTS`, as the installed package ships it."""
    if name not in FRAME_SCRIPTS:
        raise ValueError(f"{name!r} is not a frame script; the backend serves {', '.join(FRAME_SCRIPTS)}")
    return resources.files("delphi_core").joinpath(name).read_text(encoding="utf-8")


def _readable_chars() -> int:
    declared = re.findall(r"\bvar READABLE_CHARS = (\d+);", frame_script("web_bridge.js"))
    if len(declared) != 1:
        raise RuntimeError("web_bridge.js no longer declares READABLE_CHARS once; the frontends' check reads it")
    return int(declared[0])


#: As `web_bridge.js` declares it.
READABLE_CHARS = _readable_chars()
