"""
Where in a document a claim is said: the passages that hold it, found without a model.

A citation names one page of a PDF or one section of a saved page. The
digests a job files from often name the page where a passage continues, or
the page of only one of a sentence's facts, and an author copies the
locator. `locate` reads every passage of the document and answers which ones
hold a claim that its cited passages do not:

- a claim is matched on its **terms**: its words, stemmed and cut to six
  letters, and its numbers, with a number word read as its digits. Each term
  is weighted by how rare it is among the document's passages, so a page
  holding the one distinctive word outranks one holding the common ones;
- **one passage** that holds the claim wins, and only as the clear best
  (`LEAD`): near a cited passage (`NEAR`) at `NEAR_SHARE`, anywhere else at
  `FAR_SHARE`, and in either case by `MARGIN` over every cited passage;
- only a claim at least half of whose terms the document holds (`COVERED`)
  is placed by words at all.

Anything less certain is the finder's (`verify_find`): measured on the
claims a strict checker raised, matching the parts of a claim of several
facts, or a page beside the cited one holding as much as another, chose the
wrong page three times in five, where the finder, reading meaning, did not.

A locator is a page number or a section anchor, and the distance between two
is how far apart they are in the document. Nothing here reads storage or calls
a model; what is found is checked again by the checker before anything is
stored, so a wrong guess costs a second objection, never a wrong page.
"""

from __future__ import annotations

import itertools
import math
import re
from collections import Counter
from collections.abc import Hashable, Mapping, Sequence

from ..harness.evidence import normalise

Locator = Hashable

#: How far from a cited passage a nearby one may be, in pages or sections.
NEAR = 2
#: The share of the claim's weight a nearby passage must hold, and any other.
NEAR_SHARE = 0.75
FAR_SHARE = 0.9
#: How much more of the claim the chosen passage must hold than every cited one.
MARGIN = 0.2
#: How far the passage chosen must be ahead of the next.
LEAD = 0.05
#: The fewest terms a claim must share with the document, and the least share of
#: its terms: shares are taken over what the document holds at all, so a claim
#: worded in another language than its document would be judged on its names and
#: stray words alone. Round 5c placed an English claim of Su's Chinese RoPE essay,
#: on four of its twelve terms, in the readers' comments under the essay.
MIN_TERMS = 4
COVERED = 0.5
#: A claim whose cited passages hold this much of it is not misplaced.
CITED_HOLD = 0.8

#: A citation marker, `[E3]` or `[N1]`, its name the group: what every `verify_*` module reads markers by.
MARKER = re.compile(r"\[([EN]\d+)\]")
_NUMBER = re.compile(r"(\d+(?:,\d{3})*(?:\.\d+)?)([kmbt](?![^\W\d_]))?")
_WORD = re.compile(r"[^\W\d_]+")
# A C1 control character between digits: a decimal point the font did not map.
_LOST_POINT = re.compile("(?<=\\d)[\\x80-\\x9f](?=\\d)")
_CJK = re.compile("[\\u3400-\\u9fff\\uf900-\\ufaff]")
_SCRIPT = re.compile("[\\u3400-\\u9fff\\uf900-\\ufaff]+|[^\\u3400-\\u9fff\\uf900-\\ufaff]+")
_NUMBER_WORDS = {
    word: str(value) for value, word in enumerate(
        "zero one two three four five six seven eight nine ten eleven twelve".split()
    )
}
_SUFFIXES = (
    "izations", "ization", "ations", "ation", "ments", "ment", "ness", "ities", "ity", "ings", "ing", "ally", "edly",
    "ied", "ies", "ize", "ed", "es", "al", "um", "ly", "s", "e",
)
_STOP = frozenset(
    "the and for are was its this that with from have were which their there these those than then into onto over "
    "under about after before between while where when what because also only more most such each other both same "
    "some many much very does doing done being been they them thus however within without across using used uses "
    "paper authors author page pages show shows shown report reports reported can may not all any our has had".split()
)


def plain(text: str) -> str:
    """Text as a quote is compared, without citation markers, which the checker may or may not quote."""
    return normalise(MARKER.sub(" ", text))


def _stem(word: str) -> str:
    for suffix in _SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 4:
            return word[: -len(suffix)][:6]
    return word[:6]


def readable(text: str) -> str:
    """
    Extracted text with a decimal point a font lost put back: some PDFs print
    0.34 as "0", a control character, "34" (Chinchilla's fitted loss, p.25).
    """
    return _LOST_POINT.sub(".", text)


def terms(text: str, *, claim: bool = False) -> frozenset[str]:
    """
    The terms a passage is matched on (see the module docstring). CJK text is matched by character pairs.

    A decimal is also matched on its digits alone, "#d034" for 0.34, since an
    extraction may print it without its point; a passage's integers of three
    digits or more carry the same form, and a claim's integers do not, so 34
    never matches 0.34 and a claim's 2024 never matches 20.24.
    """
    text = plain(readable(text))
    found: set[str] = set()
    for number, scale in _NUMBER.findall(text):
        number = number.replace(",", "")
        # "1T" and "300M" are numbers of their own as well as the digits.
        found.update(["#" + number] + (["#" + number + scale] if scale else []))
        digits = number.replace(".", "")
        if len(digits) >= 3 and ("." in number or not claim):
            found.add("#d" + digits)
    for token in _WORD.findall(text):
        # "退化为signsgd即" is a CJK run, a Latin word and a CJK run: each is matched as its own.
        for word in _SCRIPT.findall(token) if _CJK.search(token) else (token,):
            if _CJK.search(word):
                found.update(word[i:i + 2] for i in range(len(word) - 1))
            elif word in _NUMBER_WORDS:
                found.add("#" + _NUMBER_WORDS[word])
            elif len(word) >= 3 and word not in _STOP:
                found.add(_stem(word))
    return frozenset(found)


class _Document:
    """A document's passages as terms, with each term's weight for one claim."""

    def __init__(self, texts: Mapping[Locator, str], cited: Sequence[Locator]) -> None:
        self.held = {locator: terms(text) for locator, text in texts.items()}
        order = {locator: index for index, locator in enumerate(texts)}
        self.position = {
            locator: locator if isinstance(locator, int) else order[locator] for locator in texts
        }
        self.cited = [locator for locator in cited if locator in self.held]
        self.cited_terms = frozenset().union(*(self.held[locator] for locator in self.cited))

    def weights(self, claim: str) -> dict[str, float]:
        counts = {term: sum(term in page for page in self.held.values()) for term in terms(claim, claim=True)}
        return {term: math.log((len(self.held) + 1) / count) for term, count in counts.items() if count}

    def distance(self, locator: Locator) -> int:
        if not self.cited:
            return 0
        return min(abs(self.position[locator] - self.position[cited]) for cited in self.cited)

    def share(self, weight: Mapping[str, float], held: frozenset[str]) -> float:
        total = sum(weight.values()) or 1.0
        return sum(value for term, value in weight.items() if term in held) / total


def _one(document: _Document, weight: Mapping[str, float]) -> Locator | None:
    """The one passage that holds a claim its cited passages do not, or None."""
    share = {locator: document.share(weight, held) for locator, held in document.held.items()}
    floor = max((share[locator] for locator in document.cited), default=0.0) + MARGIN
    ranked = sorted(
        (locator for locator in share if locator not in document.cited),
        key=lambda locator: (-share[locator], document.distance(locator), document.position[locator]),
    )
    if not ranked:
        return None
    best = ranked[0]
    runner_up = share[ranked[1]] if len(ranked) > 1 else 0.0
    # The clear best only: two passages that hold it alike are for the finder to tell apart.
    if share[best] - runner_up < LEAD:
        return None
    needed = NEAR_SHARE if document.distance(best) <= NEAR else FAR_SHARE
    return best if share[best] >= max(needed, floor) else None


def locate(claim: str, texts: Mapping[Locator, str], cited: Sequence[Locator]) -> tuple[Locator, ...]:
    """
    The passages of one document to add to a claim's citations, nearest first; empty when none.

    `texts` is every passage of the document, in document order; `cited` the
    ones the claim cites now.
    """
    document = _Document(texts, cited)
    weight = document.weights(claim)
    if len(weight) < max(MIN_TERMS, COVERED * len(terms(claim, claim=True))):
        return ()
    if any(document.share(weight, document.held[at]) >= CITED_HOLD for at in document.cited):
        return ()
    found = _one(document, weight)
    return () if found is None else (found,)


def candidates(claim: str, texts: Mapping[Locator, str], cited: Sequence[Locator], count: int) -> list[Locator]:
    """
    The passages most likely to hold a claim its cited ones lack, at most `count`, in document order.

    The passages on either side of a cited one are always among them: a
    passage that continues on the next page shares few words with the claim's
    wording and is the commonest place for it to be.
    """
    document = _Document(texts, cited)
    weight = document.weights(claim)
    others = [locator for locator in texts if locator not in document.cited]
    beside = [locator for locator in others if document.distance(locator) == 1][: max(0, count // 2)]
    ranked = sorted(others, key=lambda locator: (-document.share(weight, document.held[locator]), document.distance(locator)))
    chosen = list(dict.fromkeys([*beside, *ranked]))[:count]
    return [locator for locator in texts if locator in chosen]


def clip_to_claim(text: str, limit: int, claim: str = "") -> str:
    """
    A passage cut to `limit`: the stretch of whole lines that holds most of the
    claim's terms (`terms`), so what a claim rests on is what is
    shown, wherever on its page it is; the start of the passage when nothing matches.
    """
    if len(text) <= limit:
        return text
    wanted = terms(claim, claim=True) if claim else frozenset()
    best = 0
    if wanted:
        # Each line's terms once, and a window of whole lines slid over them: linear in the passage.
        lines = text.splitlines(keepends=True)
        starts = [0, *itertools.accumulate(len(line) for line in lines)][:-1]
        held = [wanted & terms(line) for line in lines]
        count: Counter[str] = Counter()
        end, best_score = 0, -1
        for first, start in enumerate(starts):
            while end < len(lines) and starts[end] + len(lines[end]) - start <= limit:
                count.update(held[end])
                end += 1
            if len(count) > best_score:
                best, best_score = start, len(count)
            if end >= len(lines):
                break
            count.subtract(held[first])
            count += Counter()
    before, after = best, max(0, len(text) - best - limit)
    return (
        (f"[Delphi left out {before:,} characters before this.]\n" if before else "")
        + text[best : best + limit]
        + (f"\n[Delphi clipped this passage here: {after:,} more characters are not shown.]" if after else "")
    )
