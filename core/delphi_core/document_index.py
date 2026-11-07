"""
The raw layer, cut into addressable pieces so it can be searched.

Delphi already stores every document twice over: a PDF's authoritative text
carries `--- Page {n} ---` markers, and a web snapshot is a list of sections
keyed by the heading's own anchor. Neither was ever queryable — a question
spanning thirty papers across four projects had no way to find which of them
were relevant. This module reshapes what is already there into rows a search can
rank, and nothing else: no new extraction, no second copy of the truth.

The index is **derived**. The stored `.txt`/`.web` objects remain the authority
for what a document says, so a lost or stale index costs a search hit, never a
citation. That is why indexing failures are logged rather than raised, and why
rebuilding is idempotent.

Ranking lives here as a pure function because two backends have to agree on it:
Postgres ranks with `ts_rank_cd` over a generated `tsvector`, the filesystem
backend scans and scores in Python. The weights below are chosen so the two
order the same hits the same way — title matches beat body matches, and a
section covering more of the query beats one that repeats a single term.
"""

import re
import unicodedata
from typing import Any

# A raw control character has no legitimate place in Markdown and JSON happily
# carries one unescaped in a string, so nothing upstream of storage catches it.
# One observed in practice: a bare ANSI SGR reset (`\x1b[0m`) sitting mid-digest,
# most plausibly a terminal-formatting artifact the model's own token stream
# picked up rather than anything Delphi did — but regardless of source, a single
# such byte is enough to abort the whole Markdown parse client-side, which is
# why an unrelated heading three paragraphs later rendered as raw text too: one
# bad byte took the entire document's formatting down with it, not just its own
# line. The escape byte itself is invisible, so stripping only it would still
# leave the sequence's printable tail (`[0m`) sitting in the reader's prose as
# junk text — the whole CSI run has to go together. Preserve tab, LF and CR
# for whitespace.
_ANSI_CSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def strip_control_characters(text: str) -> str:
    """Clean derived prose, never authoritative source objects.

    NUL also makes Postgres reject an entire document index transaction. Keep
    both storage backends on this same rule before their rows are built.
    """
    return _CONTROL_CHARS.sub("", _ANSI_CSI.sub("", text))


# One definition, imported by both `document_reads.read_paper` and the indexer. Two
# regexes over the same stored format is how a page eventually lands under the
# wrong number in one of them.
PAGE_MARKER = re.compile(
    r"(?:^|\n)--- Page (?P<page>\d+) ---\n(?P<text>.*?)(?=\n--- Page \d+ ---\n|\Z)",
    re.DOTALL,
)

WORD = re.compile(r"[a-z0-9][a-z0-9'’_-]*")
# Deliberately tiny. A long stoplist starts throwing away terms that carry the
# query ("no free lunch", "attention is all you need"); these five are the ones
# that otherwise match every section in the library and rank noise first.
STOP_WORDS = frozenset({"the", "a", "an", "of", "and"})
SNIPPET_CHARS = 240
# Below this a "term" is a fragment rather than a word, and matches everywhere.
MIN_TERM = 2
# Below this, a prefix match would be a fragment match in disguise — "in"
# prefix-matching "inference" is noise, not autocomplete. At and above it, a
# reader mid-word ("att") reasonably expects to see "attention" before they
# finish typing it, so the term matches as a prefix rather than a whole word.
MIN_PREFIX = 3


def fold(value: str) -> str:
    """Lowercase and strip accents, so `Rényi` and `renyi` are one term."""
    decomposed = unicodedata.normalize("NFKD", value or "")
    return "".join(
        char for char in decomposed if not unicodedata.combining(char)
    ).lower()


def query_terms(query: str) -> list[str]:
    """
    The distinct words a library search is actually looking for.

    Order is preserved and duplicates are dropped, so scoring cannot be gamed by
    repeating a word — the query "attention attention attention" and "attention"
    return the same ranking.
    """
    folded = fold(query)
    seen: list[str] = []
    for match in WORD.finditer(folded):
        term = match.group()
        if len(term) < MIN_TERM or term in STOP_WORDS:
            continue
        if term not in seen:
            seen.append(term)
    return seen


def sections_from_pdf_text(text: str) -> list[dict[str, Any]]:
    """
    One row per page, from the same markers `read_paper` serves pages out of.

    A PDF stored before markers existed, or one whose extraction produced none,
    yields a single whole-document row rather than nothing: an unsearchable
    paper is worse than one that can only be found as a whole.
    """
    text = strip_control_characters(text or "")
    rows: list[dict[str, Any]] = []
    has_markers = False
    for match in PAGE_MARKER.finditer(text):
        has_markers = True
        body = match.group("text").strip()
        if not body:
            continue
        page = int(match.group("page"))
        rows.append(
            {
                "kind": "page",
                "locator": str(page),
                "ordinal": page,
                "title": f"Page {page}",
                "text": body,
            }
        )
    if has_markers:
        return rows
    body = (text or "").strip()
    if not body:
        return []
    return [
        {
            "kind": "page",
            "locator": "1",
            "ordinal": 1,
            "title": "Page 1",
            "text": body,
        }
    ]


def sections_from_web_document(document: dict[str, Any]) -> list[dict[str, Any]]:
    """One row per stored section, keyed by the anchor a citation already uses."""
    rows: list[dict[str, Any]] = []
    for index, section in enumerate(document.get("sections") or [], start=1):
        body = strip_control_characters(section.get("markdown") or "").strip()
        anchor = (section.get("anchor") or "").strip()
        # An anchor is an address in the authoritative snapshot. Cleaning it
        # could point at a different section or collide with an existing key.
        # Skip an unstoreable address without losing the rest of the document.
        if not body or not anchor or "\x00" in anchor:
            continue
        title = strip_control_characters(section.get("title") or "").strip()
        rows.append(
            {
                "kind": "section",
                "locator": anchor,
                "ordinal": index,
                "title": title or anchor,
                "text": body,
            }
        )
    return rows


def locator_label(kind: str, locator: str, title: str) -> str:
    """How a hit is cited back — the vocabulary the reader already sees."""
    if kind == "page":
        return f"p. {locator}"
    return title or f"§{locator}"


def score_section(terms: list[str], title: str, text: str) -> float:
    """
    How well one stored piece answers a query, in the shape `ts_rank_cd` gives.

    Two components, both load-bearing: frequency, so a page that discusses the
    term beats one that mentions it in passing; and coverage, so a section
    holding every query term beats one repeating a single word — which is the
    difference between finding the paper about variational autoencoders and
    finding every paper that says "variational".
    """
    if not terms:
        return 0.0
    haystack_title = fold(title)
    haystack_text = fold(text)
    total = 0.0
    covered = 0
    for term in terms:
        in_title = count_term(haystack_title, term)
        in_text = count_term(haystack_text, term)
        if not in_title and not in_text:
            continue
        covered += 1
        # Title weight matches the tsvector's 'A' vs 'B' setweight ratio.
        total += 4.0 * in_title + min(in_text, 12)
    if not covered:
        return 0.0
    return total * (covered / len(terms)) ** 2


def tsquery_term(term: str) -> str:
    """
    One term as Postgres should ask for it, mirroring `count_term`'s rule.

    Here rather than in the SQL backend because it *is* `count_term`'s rule,
    written in the other dialect: a term long enough to mean something matches
    as a prefix, a shorter one has to be a whole word. Two spellings of that
    threshold is how a laptop and production start answering different
    questions.
    """
    return f"{term}:*" if len(term) >= MIN_PREFIX else term


def count_term(haystack: str, term: str) -> int:
    """
    Occurrences of a term, as a prefix once it is long enough to mean something.

    A short term (below `MIN_PREFIX`) still has to match a whole word — a
    prefix match would make "in" match "inference" everywhere it appears. A
    longer one matches as a prefix, so a search box answers while the reader
    is still typing it: "att" finds "attention" before the word is complete.
    """
    if len(term) < MIN_PREFIX:
        return sum(1 for match in WORD.finditer(haystack) if match.group() == term)
    return sum(1 for match in WORD.finditer(haystack) if match.group().startswith(term))


def build_snippet(text: str, terms: list[str], max_chars: int = SNIPPET_CHARS) -> str:
    """
    A window around the first match, so a hit shows why it is a hit.

    Built in Python for both backends rather than with `ts_headline`, because a
    snippet that differs between a laptop and production is a bug report nobody
    can reproduce.
    """
    body = re.sub(r"\s+", " ", (text or "")).strip()
    if not body:
        return ""
    if len(body) <= max_chars:
        return body
    folded = fold(body)
    position = -1
    for match in WORD.finditer(folded):
        word = match.group()
        if word in terms or any(
            len(term) >= MIN_PREFIX and word.startswith(term) for term in terms
        ):
            position = match.start()
            break
    if position < 0:
        return body[:max_chars].rstrip() + "…"
    start = max(0, position - max_chars // 3)
    # Start on a word boundary; a snippet opening mid-word reads as corruption.
    if start:
        space = body.find(" ", start)
        start = space + 1 if 0 <= space < start + 40 else start
    window = body[start : start + max_chars].rstrip()
    return ("…" if start else "") + window + ("…" if start + max_chars < len(body) else "")


def rank_hits(hits: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    """
    Order by score, then by document order.

    The tie-break is the reason this is a function rather than a `sorted` call
    at the call site: two sections scoring identically must come back in the
    same order on every backend and every run, or paging through results
    silently repeats and drops rows.
    """
    ordered = sorted(
        hits,
        key=lambda hit: (
            -hit["score"],
            hit.get("paperId") or "",
            hit.get("ordinal") or 0,
        ),
    )
    return ordered[:limit]
