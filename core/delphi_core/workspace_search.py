"""
One search over the whole account, and the collective rule that makes it useful.

`document_index` ranks a library search: coverage-weighted, so a section holding
two of three query terms still scores, just below one holding all three. That is
the right shape for the *model's* `search_library` tool,
which is reaching for evidence and would rather see a near miss than nothing.

It is the wrong shape for a person typing into a search box. Asked for
"metaquery training", a reader means one thing, not two: they do not want every
page about training stacked under every page about metaquery, and a result that
matches half the query is not a weaker answer — it is the wrong answer, and it
outranks the right one whenever the half it matched is a common word. So the
rule here is collective: **every term, or no hit.**

That is why this module exists rather than a flag on `score_section`. The two
rules serve two different callers, and the retrieval ladder (invariant 43) would
be starved by the strict one — a model searching "attention head sparsity" and
getting nothing has no second move. Both rules share their vocabulary, though:
folding, tokenisation and stop words all come from `document_index`, so the two
searches can never disagree about what a *term* is, only about how many of them
a hit must carry.

Pure, no I/O, imported by both storage backends — the same arrangement
`document_index` already has, and for the same reason. Postgres ANDs its tsquery
and the filesystem backend scores in Python, and they have to agree.
"""

import math
from typing import Any, Iterable, NamedTuple

from .document_index import (
    MIN_PREFIX,
    WORD,
    count_term,
    fold,
    query_terms,
)

# What a contiguous phrase is worth over the same words scattered across a
# document. Multiplicative rather than additive so it scales with how strongly
# the hit matched in the first place: "the exact phrase, twice" should beat "the
# exact phrase, once", which an additive bonus flattens.
PHRASE_BONUS = 2.5
# Mirrors the tsvector's 'A' vs 'B' setweight ratio, as `score_section` does.
TITLE_WEIGHT = 4.0
# One term repeated fifty times is not fifty times the answer.
MAX_TERM_COUNT = 12


def collective_terms(query: str) -> list[str]:
    """
    The words a hit has to carry — all of them.

    Delegates to `query_terms` rather than re-tokenising: one definition of a
    term across both searches means a query that finds a page through the
    model's tools and a query that finds it through the search box are looking
    for the same words.
    """
    return query_terms(query)


def score_collective(terms: list[str], title: str, text: str) -> float:
    """
    How well one record answers the whole query, or zero.

    The early return is the entire feature. Coverage in `score_section` is a
    weighting — here it is a gate, so a record missing any term scores nothing
    at all and cannot appear above a record that carries them all.

    Above the gate the shape is `score_section`'s, so the two searches rank
    consistently among the hits they both accept: title matches weigh four times
    body matches, and a term's contribution is capped so one word repeated does
    not outrank one document that discusses everything asked for.
    """
    if not terms:
        return 0.0
    folded_title = fold(title)
    folded_text = fold(text)
    total = 0.0
    for term in terms:
        in_title = count_term(folded_title, term)
        in_text = count_term(folded_text, term)
        if not in_title and not in_text:
            return 0.0
        total += TITLE_WEIGHT * in_title + min(in_text, MAX_TERM_COUNT)
    if _holds_phrase(folded_title, terms) or _holds_phrase(folded_text, terms):
        total *= PHRASE_BONUS
    return total


def _holds_phrase(folded: str, terms: list[str]) -> bool:
    """
    Whether the terms appear in order and adjacent, ignoring what separates them.

    Matched over the *word* sequence rather than as a substring, because the
    stored text carries the punctuation and line breaks the source had: a PDF
    that wraps "metaquery\ntraining" across a line is the phrase, and a
    substring test would say it is not. Single-term queries are excluded — every
    match is trivially contiguous, so the bonus would apply to all of them and
    rank nothing.
    """
    if len(terms) < 2:
        return False
    words = [match.group() for match in WORD.finditer(folded)]
    span = len(terms)
    for start in range(0, max(0, len(words) - span + 1)):
        if all(
            _word_matches(words[start + offset], term)
            for offset, term in enumerate(terms)
        ):
            return True
    return False


# --- One hit per thing, however many times it says the word ----------------
#
# A document, a page and a conversation are what a reader searches *for*; a
# section, a paragraph and a turn are only where the words happen to sit. The
# first cut of this returned the latter, so one blog post that mentioned its own
# subject in six sections filled six of the fifteen document rows with the same
# title — the list stopped being a list of documents and became a concordance.
#
# Collapsing is therefore not a display trick applied at the end but the ranking
# itself, and it lives here so all three scopes and both backends do it once:
# the strongest place decides how well the thing answers, the *number* of places
# says how much of it is about the question, and the first place is what gets
# quoted and opened.

# How much repetition is worth. Multiplicative on the best place and logarithmic
# in the count: the second matching section is real evidence the document is
# about this, the twentieth is the same evidence again. Small on purpose — a
# document that says the phrase once in a sentence written for it must still be
# able to outrank one that mentions it in passing on every page.
REPEAT_WEIGHT = 0.4

# Postgres ranks by the best place alone (it cannot apply the rule above without
# spelling it out a second time in SQL), so it is asked for a few times `limit`
# and the final order is decided here. The factor covers the most repetition can
# move a row: at this weight, twenty places is a little over 2x.
COLLAPSE_FANOUT = 4


class Match(NamedTuple):
    """
    One place inside one thing where the whole query appears.

    `order` is position in the source — page number, section ordinal, turn index
    — and never rank: the reader is shown the *first* mention, not the strongest
    one, because the first is where a document starts explaining itself, and
    because a quote whose position wanders with the query reads as a different
    result every time.
    """

    owner: str
    order: Any
    score: float
    payload: Any


class Collapsed(NamedTuple):
    """One thing, its first mention, and how many mentions it had."""

    owner: str
    payload: Any
    occurrences: int
    score: float


def collapsed_score(best: float, occurrences: int) -> float:
    """The score of a thing, from its best place and how many places matched."""
    return best * (1.0 + REPEAT_WEIGHT * math.log1p(max(occurrences, 1) - 1))


def collapse_matches(matches: Iterable[Match]) -> list[Collapsed]:
    """
    Every match for a thing, reduced to the one row that stands for it.

    Sorted strongest first and tie-broken on the owner's own id, so a library
    that has not changed answers the same query the same way twice — the
    property every ordering in this file keeps, because a result list that
    reshuffles between two identical searches cannot be trusted to be complete.
    """
    best: dict[str, float] = {}
    first: dict[str, Match] = {}
    counts: dict[str, int] = {}
    for match in matches:
        if match.score <= 0:
            continue
        owner = match.owner
        counts[owner] = counts.get(owner, 0) + 1
        if match.score > best.get(owner, 0.0):
            best[owner] = match.score
        held = first.get(owner)
        if held is None or match.order < held.order:
            first[owner] = match
    rows = [
        Collapsed(owner, first[owner].payload, counts[owner],
                  collapsed_score(best[owner], counts[owner]))
        for owner in counts
    ]
    rows.sort(key=lambda row: (-row.score, row.owner))
    return rows


def _word_matches(word: str, term: str) -> bool:
    """One word against one term, on `count_term`'s prefix rule."""
    return word.startswith(term) if len(term) >= MIN_PREFIX else word == term


def tsquery_all(terms: list[str]) -> str:
    """
    The Postgres half of the same rule: `&` between every term.

    `to_tsquery` rather than `websearch_to_tsquery` because only the former
    takes the `:*` prefix operator, and prefix matching is what lets the overlay
    answer while the reader is still typing the last word — the same threshold
    `count_term` uses in Python, so a term that prefix-matches on one backend
    prefix-matches on the other.
    """
    return " & ".join(
        f"{term}:*" if len(term) >= MIN_PREFIX else term for term in terms
    )


# --- One row shape, built in one place --------------------------------------
#
# Two backends answering the same question have to answer it in the same words.
# `document_index` proved that with `build_snippet`, which is Python on both
# sides precisely so a snippet cannot differ between a laptop and production;
# these builders extend it to the whole row. A field added here reaches both
# backends at once, and the contract suite compares their output directly — so
# the shape cannot drift the way it could when each backend spelled its own
# dict out.


def memory_row(
    page: dict, score: float, *, snippet: str, domain_title: str = "",
    occurrences: int = 1,
) -> dict:
    """
    A wiki page as a search result.

    `domain_title` rather than the page's own `domain`, which is the
    denormalised *slug* (invariant 43a) — the domain's record owns its title, and
    a row that shows "reinforcement-learning" where the sidebar shows
    "Reinforcement learning" reads as two different domains.
    """
    return {
        "kind": "memory",
        "title": page.get("title") or page.get("slug") or "",
        # The domain, not the page kind: a reader scanning results is placing the
        # hit in their own wiki, and "Reinforcement learning" does that where
        # "concept" does not.
        "subtitle": domain_title or page.get("domain") or "",
        "snippet": snippet,
        "score": float(score),
        "slug": page.get("slug") or "",
        "pageKind": page.get("kind") or "",
        # A page is one record, so it has one place by construction. The field
        # is on the row anyway because every kind carries it and the client has
        # one renderer.
        "occurrences": occurrences,
    }


def document_row(
    *,
    paper: dict,
    project: dict,
    section_kind: str,
    locator: str,
    locator_label: str,
    snippet: str,
    score: float,
    occurrences: int = 1,
) -> dict:
    """
    A document, shown at the first place inside it that matched.

    The locator is what makes it openable, and it is the *first* mention's
    locator rather than the best one's, so the excerpt a reader read is the
    passage the click lands on.
    """
    return {
        "kind": "document",
        "title": paper.get("title") or "",
        # Where it sits and where in it, because a document long enough to
        # search is long enough that "which page" is half the answer.
        "subtitle": " · ".join(
            part for part in (project.get("name") or "", locator_label) if part
        ),
        "snippet": snippet,
        "score": float(score),
        "paperId": paper.get("id") or "",
        "paperSlug": paper.get("slug") or "",
        "projectId": project.get("id") or "",
        "projectSlug": project.get("slug") or "",
        "documentKind": paper.get("kind") or "pdf",
        "locator": locator,
        "locatorKind": section_kind,
        "done": bool(paper.get("doneAt")),
        # How many places in this document matched the whole query — the second
        # half of its rank, and the difference between a passing mention and a
        # document about the question.
        "occurrences": occurrences,
    }


def conversation_row(
    *,
    conversation: dict,
    project: dict | None,
    paper_slug: str,
    snippet: str,
    score: float,
    occurrences: int = 1,
) -> dict:
    """
    A conversation, named by what it became and shown by what was said.

    `title` is the model-written summary and `snippet` the matching turn, which
    is usually the reader's own question — the thing they are actually trying to
    find their way back to, and the reason a chat search that stopped at titles
    would not have been worth building.
    """
    kind = conversation.get("kind") or ""
    return {
        "kind": "conversation",
        "title": conversation.get("title") or "Untitled conversation",
        "subtitle": (
            "Memory"
            if kind == "memory_chat"
            else (project or {}).get("name") or ""
        ),
        "snippet": snippet,
        "score": float(score),
        "conversationId": conversation.get("id") or "",
        "conversationKind": kind,
        "projectSlug": (project or {}).get("slug") or "",
        "paperSlug": paper_slug,
        "lastEngagedAt": conversation.get("lastEngagedAt") or "",
        "occurrences": occurrences,
    }


def message_text(body: dict) -> str:
    """
    The searchable half of a stored turn.

    Only `content`: a turn also carries the reader's selected text, the model
    it ran on and its reasoning trace, and none of those are things anyone
    types into a search box looking for. It also matches `CHAT_VECTOR`, which
    indexes `body->>'content'` and nothing else — the two have to agree or the
    backends disagree about what a chat says.
    """
    content = body.get("content")
    return content if isinstance(content, str) else ""
