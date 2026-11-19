"""CPU-only Memory ranking shared by local and SQL search.

    score = (4 * title coverage + 2 * summary coverage + body coverage) / 7

The title's field is the title, the slug's words and the page's aliases.

Coverage counts distinct query terms, not repetitions. This is the word search
behind the Memory search route a reader types into. No chat uses it to
decide relevance: a model reads the whole index and chooses by meaning
(`memory_harness`).
"""

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

_WORDS = re.compile(r"[^\W_]+", re.UNICODE)
_CJK = re.compile(r"[\u3400-\u9fff]+")
_STOP = set("a an the of and or to in on for is are was were be been do does did how what which why when where who can could would should i we you my me it its this that these those then please explain tell about with from".split())


@dataclass(frozen=True)
class RetrievalPolicy:
    title_weight: float = 4
    summary_weight: float = 2
    body_weight: float = 1


POLICY = RetrievalPolicy()


def retrieval_terms(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text).casefold()
    terms = []
    for word in _WORDS.findall(text):
        if word in _STOP or len(word) < 2:
            continue
        pieces = [word]
        if _CJK.fullmatch(word):
            pieces = [word[i:i + 2] for i in range(len(word) - 1)]
        for piece in pieces:
            if piece not in terms:
                terms.append(piece)
    return terms[:32]


def lexical_score(terms: list[str], page: dict[str, Any]) -> float:
    if not terms:
        return 0.0
    # Aliases are other names for the title, so they score with it. A page
    # with none scores exactly as it did before aliases existed.
    names = " ".join([page.get("title", "") or "", (page.get("slug", "") or "").replace("-", " "),
                      *(page.get("aliases") or [])])
    fields = (names, page.get("summary", ""), page.get("body", ""))
    score = 0.0
    weights = (POLICY.title_weight, POLICY.summary_weight, POLICY.body_weight)
    for weight, value in zip(weights, fields):
        normalized = unicodedata.normalize("NFKC", value or "").casefold()
        words = set(_WORDS.findall(normalized))
        count = sum(term in normalized if _CJK.fullmatch(term) else term in words for term in terms)
        score += weight * count / len(terms)
    return score / sum(weights)
