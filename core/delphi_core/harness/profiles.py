"""
Which tools each task offers, and when.

One named profile per task that offers a tool. A profile is the only way a
request gets its `tools`: no call site writes a tool entry of its own. Whether
a tool is offered on a given turn belongs to the profile's entry, not to the
tool, so one definition serves a scope that always has it and a scope that has
it only when there is something for it to read.

The order of a profile's offers is the order of the request's `tools` array,
which is part of the cached prefix (invariant 12). It is the catalogue's order
in every profile: function tools as a reader would reach for them, the hosted
tool last.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from ..config import Settings
from .registry import Toolset
from .tool import Tool
from .tools import (
    create_memory,
    draw_display,
    edit_memory,
    embed_figure,
    grep_memory,
    memory_links,
    open_memory,
    publish_artifact,
    read_paper,
    read_url,
    read_webpage,
    search_library,
    view_figure,
    web_search,
)


@dataclass(frozen=True)
class Turn:
    """What a profile may look at to decide what one turn is offered."""

    settings: Settings
    #: Hosted web search may be offered: the task has it (`ModelTask.web`) and
    #: the operator has not switched it off (`web_search_enabled`). A property
    #: of the task and the deployment, never of one request.
    web: bool = False
    #: The turn loaded a web document, so there are sections to read.
    web_documents: bool = False
    #: The project holds a PDF this request carries only as a digest.
    companion_pdfs: bool = False
    #: Plan and maintenance turns never acquire the inline artifact workflow.
    artifacts: bool = True
    #: Direct external source reads are chat-only, independently of artifacts.
    url_reads: bool = True


def _always(turn: Turn) -> bool:
    return True


def _memory(turn: Turn) -> bool:
    return turn.settings.memory_enabled


def _web(turn: Turn) -> bool:
    return turn.web


def _artifacts(turn: Turn) -> bool:
    return turn.artifacts and bool(turn.settings.artifact_renderer_path)


def _url_reads(turn: Turn) -> bool:
    return turn.web and turn.settings.web_search_enabled and turn.url_reads


def _figures(turn: Turn) -> bool:
    """Some figure can be listed: a Memory page's, or one a source read lists."""
    return _memory(turn) or _url_reads(turn)


@dataclass(frozen=True)
class Offer:
    tool: Tool
    when: Callable[[Turn], bool] = _always


@dataclass(frozen=True)
class Profile:
    name: str
    offers: tuple[Offer, ...]

    def toolset(self, turn: Turn) -> Toolset:
        return Toolset(offer.tool for offer in self.offers if offer.when(turn))


#: A question beside a document. `read_paper` follows the digests: it is
#: withheld where every PDF is attached whole, and offered when the project
#: holds one this request carries only as a digest. The search is offered
#: exactly where a reading tool already is, because it is the discovery half of
#: one: alone it would let the model name evidence it has no way to open.
#: No tool here writes anything: with the web always in reach, a tool that
#: changed Memory mid-turn could be called by text a page had planted.
CHAT_DOCUMENT = Profile(
    "chat.document",
    (
        Offer(read_webpage.tool(), lambda turn: turn.web_documents),
        Offer(read_paper.tool(), lambda turn: turn.companion_pdfs),
        Offer(
            search_library.tool(),
            lambda turn: turn.settings.library_search_enabled
            and (turn.web_documents or turn.companion_pdfs),
        ),
        # Every persona gets Memory: style lives in the persona, memory does
        # not. The operator kill switch is `memory_enabled` alone.
        Offer(open_memory.tool(), _memory),
        Offer(grep_memory.tool(), _memory),
        Offer(memory_links.tool(memory_links.Options(through_domains=True)), _memory),
        Offer(view_figure.tool(), _figures),
        Offer(draw_display.tool(), _artifacts),
        Offer(embed_figure.tool(), lambda turn: _artifacts(turn) and _figures(turn)),
        Offer(publish_artifact.tool(), _artifacts),
        Offer(read_url.tool(), _url_reads),
        Offer(web_search.tool(), _web),
    ),
)

#: The account-wide chat. It has the whole ladder: it can descend to
#: `search_library`, `read_paper` and `read_webpage` when Memory turns out to
#: be thin (invariant 43), in whichever project the document is filed. No word search and no browse: the request carries the whole
#: index, so the model chooses by meaning and opens what it chose.
CHAT_GENERAL = Profile(
    "chat.general",
    (
        Offer(read_paper.tool()),
        Offer(read_webpage.tool(read_webpage.Options(account=True))),
        Offer(search_library.tool(search_library.Options(scope="account"))),
        Offer(open_memory.tool(open_memory.Options(scope="general"))),
        Offer(grep_memory.tool()),
        Offer(memory_links.tool(memory_links.Options(through_domains=True))),
        Offer(view_figure.tool()),
        Offer(draw_display.tool(), _artifacts),
        Offer(embed_figure.tool(), _artifacts),
        Offer(publish_artifact.tool(), _artifacts),
        Offer(read_url.tool(), _url_reads),
        Offer(web_search.tool(), _web),
    ),
)

#: The research pass: nothing but the web. It reads the document it is given
#: and looks outside for what bears on it.
RESEARCH = Profile("research", (Offer(web_search.tool(), _web),))

#: The maintenance agent (`memory_maintenance`): it finds the pages an event
#: bears on with the tools chat reads Memory with, and changes them with the
#: only two tools that write. Its `open_memory` shows a page as an edit
#: addresses it. It has no web search. A run about one document reads that
#: document, and only that one: its pages (`read_paper`) or sections
#: (`read_webpage`, never a capture), found by searching its text alone. The
#: digest it is handed is another model's summary, and a page it cites is a
#: page it can read before it writes. What it may cite is still the closed
#: evidence set its run was handed, so nothing it reads mid-run arrives from
#: outside the account. The operator's switch for Memory is the stage's to
#: honour before it starts a run.
MEMORY_MAINTAIN = Profile(
    "memory.maintain",
    (
        Offer(open_memory.tool(open_memory.Options(scope="maintenance"))),
        Offer(grep_memory.tool()),
        Offer(memory_links.tool()),
        Offer(read_paper.tool(), lambda turn: turn.companion_pdfs),
        Offer(read_webpage.tool(read_webpage.Options(captures=False)), lambda turn: turn.web_documents),
        Offer(
            search_library.tool(search_library.Options(scope="document")),
            lambda turn: turn.settings.library_search_enabled and (turn.companion_pdfs or turn.web_documents),
        ),
        Offer(edit_memory.tool()),
        Offer(create_memory.tool()),
    ),
)

#: The domain composer: it reads Memory as the maintenance agent does and
#: writes through neither tool, because a domain page is its own to return.
MEMORY_DOMAIN = Profile(
    "memory.domain",
    (
        Offer(open_memory.tool(open_memory.Options(scope="maintenance"))),
        Offer(grep_memory.tool()),
        Offer(memory_links.tool()),
    ),
)

#: The profiles a reader's own turn is served by. A rule about "chat tools" is
#: a rule about what these offer: the trace rows both frontends draw, the
#: journey that plays every tool, and the guard that none of them writes.
CHAT_PROFILES = (CHAT_DOCUMENT, CHAT_GENERAL)

PROFILES = (CHAT_DOCUMENT, CHAT_GENERAL, RESEARCH, MEMORY_MAINTAIN, MEMORY_DOMAIN)
