"""The tool-sequence matrix: one scripted turn per row.

A question that names a row (`[e2e:s4]`) is answered by playing that row: a
list of rounds, each a list of steps. The fixture provider (`provider.py`)
turns the steps into real output items and refuses to play one the request
does not allow, so a row passes only if Delphi offered the tool, served each
call exactly once, and handed the result back.

Nothing here knows an id in advance. Every argument is read off the request
the way a model would read it: a document's id from its outline, a page's slug
from the index, the page to open next from the result of the call before. A
result that stops saying what the next call needs fails the row.

Every tool a chat profile offers is in at least two rows, and `matrix.spec.ts`
fails if one is in none.
"""
from __future__ import annotations

import re

WEB_TITLE = "Prefix Cache Study"
PAPER = {"url": "https://arxiv.org/abs/2203.03466", "title": "Tensor Programs V: Tuning Large Neural Networks via Zero-Shot Hyperparameter Transfer"}
FIGURE_CAPTION = "Stable and shuffled prefix latency, side by side."
#: A section anchor the launcher makes the reading tool raise on (`server.py`).
RAISES = "e2e-raises"
#: The slug of a concept page the fixture's filing writes (`provider.py`): one
#: for each document, or one that a series of documents shares. Whole slugs
#: only: a series' own documents have pages at `shared-idea-study-<token>-…`.
CONCEPT = r"(?<![a-z0-9-])(?:prefix-reuse-[a-f0-9]+|shared-idea-[a-z0-9]+)(?![a-z0-9-])"


class Read:
    """What a model could read off one request: its blocks, and each result so far."""

    def __init__(self, payload: dict, text: str, asked: str) -> None:
        self.payload, self.text, self.asked = payload, text, asked
        self.outputs = [str(item.get("output")) for item in payload.get("input", []) if item.get("type") == "function_call_output"]

    def find(self, pattern: str, where: str | None, what: str) -> re.Match:
        match = re.search(pattern, self.text if where is None else where, re.M | re.S)
        if not match:
            raise ValueError(f"Nothing in the request says {what}")
        return match

    @property
    def last(self) -> str:
        if not self.outputs:
            raise ValueError("No call has been answered yet")
        return self.outputs[-1]

    @property
    def web_doc(self) -> str:
        return self.find(r"doc_id=([a-f0-9]+)", None, "which web document is attached")[1]

    def _pdf(self) -> tuple[str, str]:
        """A PDF the request names but does not attach: by its digest card, or by its line in the index."""
        outlined = set(re.findall(r"doc_id=([a-f0-9]+)", self.text))
        cards = [(paper, title) for paper, title in re.findall(r'<research_digest paper_id="([a-f0-9]+)" title="([^"]+)"', self.text) if paper not in outlined]
        listed = [(paper, title) for title, paper in re.findall(r"^\s+- ([^\n]*?) · pdf ·[^\n]*?paper_id ([a-f0-9]+)", self.text, re.M)]
        if not cards and not listed:
            raise ValueError("Nothing in the request says which PDF the library holds")
        return (cards or listed)[0]

    @property
    def pdf(self) -> str:
        return self._pdf()[0]

    @property
    def pdf_title(self) -> str:
        return self._pdf()[1]

    @property
    def named(self) -> str:
        """The Memory page the reader named in the question."""
        return self.find(rf"kept on ({CONCEPT})", self.asked, "which page the reader asked about")[1]

    @property
    def concept(self) -> str:
        return self.find(rf"({CONCEPT})", None, "a page about prefix reuse")[1]

    def opener(self, tool: str) -> dict:
        """The call a library hit says opens it."""
        hit = self.find(rf'Open with: {tool}\(paper_id="([a-f0-9]+)", pages=\[(\d+)\]\)', self.last, f"how to open a hit with {tool}")
        return {"paper_id": hit[1], "pages": [int(hit[2])]}

    def found(self) -> str:
        """The first page a search of Memory listed."""
        return self.find(r"^· \S+/\S+/(\S+) — ", self.last, "which page holds the wording")[1]

    def linked(self, start: str) -> str:
        """A page the link walk reached from `start`."""
        reached = [slug for slug in re.findall(r"^\S+ \S+/\S+/(\S+) — ", self.last, re.M) if slug != start]
        if not reached:
            raise ValueError(f"The link walk from {start} reached no other page: {self.last[:300]!r}")
        return reached[0]

    def beside(self) -> str:
        """A page `<reader_memory>` names but did not open: one link from a page it did."""
        block = self.find(r"<reader_memory>(.*?)</reader_memory>", None, "what was chosen from Memory")[1]
        opened = set(re.findall(r"^=== \[\[([^\]]+)\]\]", block, re.M))
        if not opened:
            raise ValueError("<reader_memory> opened no page for this question")
        linked = [slug for slug in re.findall(r"\[\[([^\]|]+)\]\]", block) if slug not in opened]
        if not linked:
            raise ValueError("The pages in <reader_memory> link to nothing that is not already open")
        return linked[0]

    @property
    def figure(self) -> str:
        """The id an opened page prints beside the figure it keeps."""
        for output in self.outputs:
            listed = re.search(rf"^- ([A-Za-z0-9_-]+): {re.escape(FIGURE_CAPTION)}", output, re.M)
            if listed:
                return listed[1]
        raise ValueError("No opened page lists the figure")

    def says(self, wording: str) -> str:
        """Wording the last result must contain, for an answer that rests on it."""
        if wording not in self.last:
            raise ValueError(f"The last result does not contain {wording!r}: {self.last[:300]!r}")
        return wording

    def sees_image(self) -> bool:
        blocks = [block for item in self.payload.get("input", []) if isinstance(item.get("content"), list) for block in item["content"]]
        if not any(block.get("type") == "input_image" for block in blocks):
            raise ValueError("The request carries no image")
        return True


def call(tool, arguments):
    return ("call", tool, arguments)

def unusable(tool, arguments):
    """A call whose arguments the tool cannot use, sent as written."""
    return ("raw", tool, arguments)

def web(query):
    return ("web", {"type": "search", "query": query})

def answer(text, cites=()):
    return ("answer", text, cites)

def page(anchor="all"):
    """
    Read the open web page. Whole, unless a row wants a section that is not there.

    The page is short, which is when the tool says to ask for all of it. A
    section is not asked for by name because the names do not last: once the
    reader's own copy of the page is saved, the outline is cut by passage.
    """
    return call("read_webpage", lambda read: {"doc_id": read.web_doc, "anchor": anchor})

def done(row: str) -> str:
    """How every row's answer ends, so a journey can tell it finished."""
    return f"That settles row {row.upper()}."

def cited(source):
    return f"([{source['url'].split('/')[2]}]({source['url']}))"

LIBRARY_THEN_PAGE = [
    [call("search_library", {"query": "shuffled"})],
    [call("read_paper", lambda read: read.opener("read_paper"))],
]

ROWS: dict[str, list[list[tuple]]] = {
    # Ask about the open web document.
    "s1": [
        [page()],
        [answer(lambda read: f"{read.says('Only prefix ordering changes')}, so the comparison is fair ({WEB_TITLE}). {done('s1')}")],
    ],
    # Ask about another paper in the project.
    "s2": [
        *LIBRARY_THEN_PAGE,
        [answer(lambda read: f"The paper reports it directly: {read.says('Stable prefix: 120 ms')} ({read.pdf_title}, p. 2). {done('s2')}")],
    ],
    # "What have I read about X?" in Memory chat.
    "s3": [
        [call("open_memory", lambda read: {"slugs": [read.concept]})],
        [call("memory_links", lambda read: {"slug": read.concept, "hops": 1})],
        [call("open_memory", lambda read: {"slugs": [read.linked(read.concept)]})],
        [answer(lambda read: f"You have a page on it, [[{read.concept}]], and the page it was written from. {done('s3')}")],
    ],
    # Find an exact number across Memory.
    "s4": [
        [call("grep_memory", {"pattern": "hit rate", "glob": ""})],
        [call("open_memory", lambda read: {"slugs": [read.found()]})],
        [call("read_paper", lambda read: {"paper_id": read.pdf, "pages": [2]})],
        [answer(lambda read: f"Your notes say to measure hit rate, and the paper gives the number: {read.says('Shuffled prefix: 240 ms')} ({read.pdf_title}, p. 2). {done('s4')}")],
    ],
    # A question the figure answers: the picture arrives as a turn of its own.
    "s5": [
        [call("open_memory", lambda read: {"slugs": [read.named]})],
        [call("view_figure", lambda read: {"figure_id": read.figure})],
        [answer(lambda read: read.sees_image() and f"The figure on [[{read.named}]] puts the two conditions side by side. {done('s5')}")],
    ],
    # Compare a paper with outside work.
    "s6": [
        [call("read_paper", lambda read: {"paper_id": read.pdf, "pages": [1]})],
        [web("prefix caching related work"), web("prompt cache latency measurements"),
         answer(lambda read: f"The paper holds that token equality is what matters ({read.pdf_title}, p. 1), and outside work agrees {cited(PAPER)}. {done('s6')}", (PAPER,))],
    ],
    # Memory is thin: descend the ladder to the library, the page, then the web.
    "s7": [
        [call("open_memory", lambda read: {"slugs": [read.concept]})],
        [call("search_library", {"query": "token equality"})],
        [call("read_paper", lambda read: read.opener("read_paper"))],
        [web("token equality prefix cache"),
         answer(lambda read: f"Your page stops short of it; the paper says it ({read.pdf_title}, p. 1) and so does outside work {cited(PAPER)}. {done('s7')}", (PAPER,))],
    ],
    # Two calls in one round.
    "s8": [
        [call("open_memory", lambda read: {"slugs": [read.concept]}), call("grep_memory", {"pattern": "prefix", "glob": ""})],
        [answer(lambda read: f"Both lookups agree: [[{read.concept}]] is the page that covers it. {done('s8')}")],
    ],
    # Budgets run out, one class at a time, and the turn still answers:
    # document reads over two rounds, the web's allowance, figure views, then
    # the last round, in which nothing may be called.
    "s9": [
        [page()] * 6,
        [page()] * 7,
        [*(web(f"prefix cache study {number}") for number in range(1, 10)),
         call("open_memory", lambda read: {"slugs": [read.named]})],
        [call("view_figure", lambda read: {"figure_id": read.figure})] * 3,
        [call("grep_memory", {"pattern": "prefix", "glob": ""})],
        [call("memory_links", lambda read: {"slug": read.named, "hops": 1})],
        [answer(lambda read: f"With what was read before the limits: a matching prefix is reused ({WEB_TITLE}). {done('s9')}")],
    ],
    # A tool fails five ways; each failure is prose, and the model tries again once.
    "s10": [
        [page("no-such-section"),
         call("open_memory", {"slugs": ["no-such-page"]}),
         unusable("read_paper", lambda read: f'{{"paper_id": "{read.pdf}"}}'),
         unusable("search_library", "{not json"),
         page(RAISES)],
        [page()],
        [answer(lambda read: f"{read.says('A changed suffix does not invalidate the matching prefix')} ({WEB_TITLE}). {done('s10')}")],
    ],
    # A question with an image attached gets one round of tools, then the answer.
    "s11": [
        [page()],
        [answer(lambda read: read.sees_image() and f"The picture and the page say the same: {read.says('not a universal latency guarantee')} ({WEB_TITLE}). {done('s11')}")],
    ],
    # A follow-up turn: the first question, then a second in the same conversation.
    "s12": [
        *LIBRARY_THEN_PAGE,
        [answer(lambda read: f"{read.says('Stable prefix: 120 ms')} ({read.pdf_title}, p. 2). {done('s12')}")],
    ],
    "s12-then": [
        [page()],
        [answer(lambda read: f"And it is {read.says('not a universal latency guarantee')} ({WEB_TITLE}). That settles the follow-up.")],
    ],
    # The page that matters is one link from a page chosen for the question.
    "s13": [
        [call("open_memory", lambda read: {"slugs": [read.beside()]})],
        [answer(lambda read: f"The page beside the one chosen is the one that says it, [[{read.beside()}]]. {done('s13')}")],
    ],
}


def tools_played() -> dict[str, list[list[str]]]:
    """Each row as the tools its rounds call, in order."""
    return {name: [["web_search" if step[0] == "web" else step[1] for step in steps if step[0] in {"call", "raw", "web"}]
                   for steps in rounds] for name, rounds in ROWS.items()}
