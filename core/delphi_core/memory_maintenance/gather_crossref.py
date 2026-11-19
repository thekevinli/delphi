"""
What one document says, with a number, about another document of the reader's library.

Papers report each other's results, and they misreport them: a paper that
quotes "α≈0.46 and β≈0.51 for Chinchilla-scaling" is quoting Chinchilla's
allocation exponents as its loss exponents, which Chinchilla gives as 0.34 and
0.28. Nothing in a job that files the quoting paper reads the quoted one, so a
page would repeat the number as the other paper's own. This finds such
sentences, without a model, so the agent and the domain composer are told to
compare before relying on them (`contracts/maintain.md`, `contracts/domain.md`):

- a document of the library is **named** by its title as the reader keeps it,
  without the parenthesis an arXiv copy carries ("Chinchilla"), by that
  title's first word when it is a name of its own and a distinctive one (six
  letters, or a capital or digit inside it, as in "RoPE"; not "Adam"), or by
  its arXiv number. A name two documents share names neither. A passage is
  read once, word by word, whatever the library's size;
- a **cross-reference** is a sentence of a document in the job's evidence set
  that names another document of the library and states a value: a decimal
  or a percentage. A reference list is not one: a sentence carrying an arXiv
  number, a DOI or "preprint" is left out;
- at most `MAX_REFERENCES` are given, in document order.

What the other document itself says is not read here. The model compares,
from the pages that cite it or, in a domain job, from its passages, and the
checker holds what it writes to the passages cited, as for any claim.

`brief_part` writes them for a brief, each fenced as `<cross_reference>`.

Pure: no storage, no model.
"""

from __future__ import annotations

import re
from collections.abc import Hashable, Iterable, Mapping
from dataclasses import dataclass

from . import brief as tags

#: Cross-references one brief carries; how much of the text around the name
#: each quotes; how far from the name its value may be; and how many numbers
#: make the text around a name a table or a plot's axis rather than a sentence.
MAX_REFERENCES = 6
WINDOW_CHARS = 360
VALUE_NEAR_CHARS = 120
MAX_NUMBERS = 12
#: A name of one word must be at least this long, unless it is written with a
#: capital or a digit inside it ("RoPE", "GPT4"): "Adam" or "Muon" is a word
#: many papers use for something else. A title of several words needs this many.
NAME_MIN_CHARS = 6
TITLE_MIN_WORDS = 3
#: The passages of one document read for cross-references: a long one is read
#: from its start, where a paper places the work it builds on.
MAX_PASSAGES = 60

_ARXIV = re.compile(r"\b(\d{4}\.\d{4,5})(?:v\d+)?\b")
_PARENTHESIS = re.compile(r"\s*\([^)]*\)\s*")
_PARTS = re.compile(r"\s+[|–—-]\s+|:\s*")
_ONE_NAME = re.compile(r"[A-Z](?:[a-z]{%d,}|[A-Za-z0-9]*[A-Z0-9][A-Za-z0-9]*)" % (NAME_MIN_CHARS - 1))
_VALUE = re.compile(r"(?<![\d.])\d+\.\d+(?![\d.])|\d+(?:\.\d+)?\s?%")
_NUMBER = re.compile(r"\d+(?:\.\d+)?")
#: A number that is a place in the document, not a value: "§4.1", "Table 2", "Eq. (6)".
_PLACE = re.compile(
    r"(?:§|\b(?:Sec(?:tion)?|Fig(?:ure)?|Table|Eq(?:uation)?|Appendix|Algorithm|Theorem|Lemma)s?\.?)\s*\(?[A-Z]?\d+(?:\.\d+)*\)?"
)
_REFERENCE_LIST = re.compile(r"arxiv|doi|preprint|proceedings|https?://", re.IGNORECASE)
_TOKEN = re.compile(r"[^\W_]+(?:\.\d+)?")


@dataclass(frozen=True)
class CrossReference:
    """A sentence of one document that names another and states a value."""

    #: The paper id of the document the sentence is in, and where.
    source: str
    locator: Hashable
    sentence: str
    #: The paper id of the document it names.
    names: str


class Names(dict):
    """
    Each document's names as a pattern, by paper id; and every name by the
    word it starts with, so a passage is scanned once, word by word, and a
    pattern is tried only where its first word stands.
    """

    def __init__(self, spelled: Mapping[str, Iterable[str]]) -> None:
        super().__init__({paper_id: re.compile(_pattern(names)) for paper_id, names in spelled.items()})
        self.anchors: dict[str, list[tuple[str, re.Pattern[str]]]] = {}
        for paper_id, names in spelled.items():
            for name in names:
                first = _TOKEN.match(name)
                if first:
                    self.anchors.setdefault(first.group(0).casefold(), []).append((paper_id, re.compile(_pattern([name]))))

    def finditer(self, text: str) -> Iterable[tuple[str, re.Match[str]]]:
        """Each place in `text` a document is named, with the paper id."""
        for token in _TOKEN.finditer(text):
            for paper_id, pattern in self.anchors.get(token.group(0).casefold(), ()):
                if found := pattern.match(text, token.start()):
                    yield paper_id, found


def _pattern(names: Iterable[str]) -> str:
    """One document's names as a pattern: a one-word name as written (a capital), a title in any case."""
    alternatives = [
        re.escape(name) if " " not in name else "(?i:" + r"\s+".join(map(re.escape, name.split())) + ")"
        for name in sorted(names, key=len, reverse=True)
    ]
    return r"(?<![\w])(?:" + "|".join(alternatives) + r")(?![a-z])"


def names(papers: Iterable[Mapping[str, object]]) -> Names:
    """Each document's names, by paper id (see the module docstring)."""
    found: dict[str, set[str]] = {}
    for paper in papers:
        title = str(paper.get("title") or "")
        spelled: set[str] = set()
        spelled.update(_ARXIV.findall(title))
        cleaned = " ".join(_PARENTHESIS.sub(" ", title).split())
        parts = [part.strip() for part in _PARTS.split(cleaned) if part.strip()]
        if parts and _ONE_NAME.fullmatch(parts[0]):
            # "Chinchilla", "RoPE: …": a name of its own, before anything else.
            spelled.add(parts[0])
        spelled.update(part for part in [cleaned, *parts] if len(part.split()) >= TITLE_MIN_WORDS)
        found[str(paper["id"])] = spelled
    owners: dict[str, set[str]] = {}
    for paper_id, spelled in found.items():
        for name in spelled:
            owners.setdefault(name.casefold(), set()).add(paper_id)
    own = {paper_id: [name for name in spelled if owners[name.casefold()] == {paper_id}] for paper_id, spelled in found.items()}
    return Names({paper_id: names for paper_id, names in own.items() if names})


def _windows(text: str, named: Names, allowed: set[str], source: str) -> dict[str, tuple[int, str]]:
    """
    For each document a passage names that states a value near the name: the
    text around the place where a value is nearest, and how near. One scan of
    the passage, whatever the size of the library.
    """
    text = " ".join(text.split())
    found: dict[str, tuple[int, str]] = {}
    for other, match in named.finditer(text):
        if other not in allowed or other == source:
            continue
        start = max(0, match.start() - WINDOW_CHARS // 2)
        window = text[start: start + WINDOW_CHARS]
        if _REFERENCE_LIST.search(window) or _ARXIV.search(window) or len(_NUMBER.findall(window)) > MAX_NUMBERS:
            continue
        here = match.start() - start
        values = _VALUE.finditer(_PLACE.sub(lambda place: " " * len(place.group(0)), window))
        near = [abs(value.start() - here) for value in values]
        if near and min(near) <= VALUE_NEAR_CHARS and min(near) < found.get(other, (VALUE_NEAR_CHARS + 1, ""))[0]:
            cut_left, cut_right = start > 0, start + WINDOW_CHARS < len(text)
            found[other] = (min(near), ("…" if cut_left else "") + window.strip() + ("…" if cut_right else ""))
    return found


def cross_references(
    texts: Mapping[str, Mapping[Hashable, str]], named: Names, *, among: Iterable[str] | None = None,
) -> list[CrossReference]:
    """
    The cross-references in `texts` (each document's passages, by paper id, in document order).

    `among` limits the documents that may be named; a document never names
    itself. At most `MAX_PASSAGES` passages of each document are read.
    """
    allowed = set(named) if among is None else set(among) & set(named)
    found: list[tuple[int, int, CrossReference]] = []
    for source, passages in texts.items():
        for locator, text in list(passages.items())[:MAX_PASSAGES]:
            for other, (near, window) in sorted(_windows(text, named, allowed, source).items()):
                found.append((near, len(found), CrossReference(source, locator, window, other)))
    # The values nearest their names are likeliest to be the named document's own.
    kept = sorted(found, key=lambda item: (item[0], item[1]))[:MAX_REFERENCES]
    return [reference for _, _, reference in sorted(kept, key=lambda item: item[1])]


def brief_part(references: Iterable[CrossReference], titles: Mapping[str, str], source_pages: Mapping[str, str]) -> str:
    """The brief's paragraph of cross-references, or nothing when there are none."""
    blocks = [
        tags.fence(
            tags.CROSS_REFERENCE, reference.sentence, paper_id=reference.source,
            at=f"page {reference.locator}" if isinstance(reference.locator, int) else f"section {reference.locator}",
            names=reference.names, named_title=tags.clip(titles.get(reference.names, ""), 200),
            named_page=f"[[{source_pages[reference.names]}]]" if reference.names in source_pages else None,
        )
        for reference in references
    ]
    if not blocks:
        return ""
    return (
        "Where a document of this event reports a value of another document of the reader's library: its own words, "
        "found by the other document's name. They are its report of the other, which may be mislabelled or wrong. "
        "Before a page relies on one, compare it with what the other document itself says:\n" + "\n".join(blocks)
    )
