"""
What a check judges, claim by claim, and which of its verdicts a later check must keep.

**What a check passes, it passes claim by claim** (`claims`). A unit is the
context the checker reads; a claim is what it judges: a table row, a list
item, or a sentence with the sentences after it that point back at it. Each
check records the claims of the new text it saw that no objection touched,
advice included, by their words without citation markers and by the
locators they cite, so a claim given another passage too is the same claim.
A unit is shown again when anything in it changed, and the claims in it that
passed are context there: an objection to one of them is advice
(`already_passed`). Rewording a claim or the sentence it leans on, or taking
away a passage it passed on, makes it a claim no check has passed. A quote is
placed only where exactly one block of the new text holds it once: one that
two blocks hold could be about either, so it passes nothing and keeps no
verdict.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from .run import Objection
from .staging import StagedPage
from .verify_again import _TABLE_ROW, _TOP_ITEM, _refers_back, _signature, sentences
from .verify_locate import MARKER, plain


def _said(text: str) -> str:
    """Words as a claim is kept by: `plain`, without the space a marker leaves before a stop."""
    return re.sub(r"\s+(?=[.,;:!?)\]])", "", plain(text))


def marker_signatures(page: StagedPage) -> dict[str, str]:
    """Each marker of a page, `E3` or `N1`, read as the locator it cites."""
    by_id = {int(citation["id"]): citation for citation in page.citations}
    named = {f"E{number}": _signature(citation) for number, citation in by_id.items()}
    named.update({name: _signature(by_id[number]) for name, number in page.refs.items() if number in by_id})
    return named


def _blocks(text: str) -> list[str]:
    return [block for block in re.split(r"\n\s*\n", text.strip()) if block.strip()]


def _raw_claims(block: str) -> list[str]:
    """One block's claims, in order, as written (see `claims`)."""
    lines = [line for line in block.splitlines() if line.strip()]
    if not lines:
        return []
    if _TABLE_ROW.match(lines[0]) or _TOP_ITEM.match(lines[0]):
        # A row or an item is one claim; a line that continues an item, a nested item among them, belongs to it.
        items: list[str] = []
        for line in lines:
            if items and not (_TABLE_ROW.match(line) or _TOP_ITEM.match(line)):
                items[-1] += " " + line.strip()
            else:
                items.append(line)
        return items
    grouped: list[str] = []
    for sentence in sentences(" ".join(line.strip() for line in lines)):
        if grouped and _refers_back(sentence):
            grouped[-1] += " " + sentence
        else:
            grouped.append(sentence)
    return grouped


def _keyed(text: str) -> list[list[tuple[str, str]]]:
    """
    Each block's claims as (as written, the words it is kept by). A claim is
    kept with what it is read in: a table row under its header, a list item
    under the line that leads into the list, and a later claim of a paragraph
    under the paragraph's first. Rewriting what frames a claim reopens it.
    """
    keyed, lead = [], ""
    for block in _blocks(text):
        raw = _raw_claims(block)
        lines = [line for line in block.splitlines() if line.strip()]
        table = bool(lines) and bool(_TABLE_ROW.match(lines[0]))
        listed = bool(lines) and bool(_TOP_ITEM.match(lines[0]))
        frame = _said(raw[0]) if raw and (table or not listed) else _said(lead)
        keys = []
        for index, item in enumerate(raw):
            words = _said(item)
            first = index == 0 and not listed
            keys.append((item, words if first or not frame else f"{frame} ⟩ {words}"))
        keyed.append(keys)
        lead = raw[-1] if raw else lead
    return keyed


def claims(text: str, signatures: Mapping[str, str] | None = None) -> list[tuple[str, frozenset[str]]]:
    """
    What a check judges, in new text, each with what it rests on: a table row,
    a list item, or a sentence together with the sentences after it that point
    back at it ("It …", "This …"). A claim is kept by its words, `plain` and
    without markers, and by the locators its markers cite, read through
    `signatures` (or, with none of its own, those of the run that closes it):
    a claim given another passage too is the same claim, and one whose words
    change, whose leaned-on sentence changes, or that loses a passage it had,
    is another.
    """
    found = []
    for keyed in _keyed(text):
        raw = [item for item, _ in keyed]
        for index, (item, key) in enumerate(keyed):
            if not re.search(r"\w", _said(item)):
                continue
            names = MARKER.findall(item) or next((MARKER.findall(later) for later in raw[index + 1:] if MARKER.search(later)), [])
            found.append((key, frozenset((signatures or {}).get(name, name) for name in names)))
    return found


def _touched(text: str, quote: str) -> list[str] | None:
    """The claims a quote touches, by their words, or None unless exactly one block holds it, once."""
    holding = [
        (keyed, whole) for block, keyed in zip(_blocks(text), _keyed(text))
        if quote and quote in (whole := _said(" ".join(line.strip() for line in block.splitlines())))
    ]
    if len(holding) != 1 or holding[0][1].count(quote) != 1:
        # In several places, or nowhere: nobody can say which claim it is about.
        return None
    keyed, whole = holding[0]
    start = whole.find(quote)
    end, touched, at = start + len(quote), [], 0
    for item, key in keyed:
        words = _said(item)
        begin = whole.find(words, at)
        if begin < 0:
            continue
        at = begin + len(words)
        if begin < end and start < at:
            touched.append(key)
    return touched or None


def passed_claims(shown: Mapping[str, Any], objections: Sequence[Objection], earlier: Mapping[str, Mapping[str, frozenset[str]]]) -> dict[str, dict[str, frozenset[str]]]:
    """
    Every claim a check has passed, by page, with the locators it passed on:
    what earlier checks passed, and every claim of the new text shown now
    (`Shown.after`) that no objection touches, advice included. A blocking
    quote that cannot be placed in one block passes nothing new on its page.
    """
    passed = {slug: dict(found) for slug, found in earlier.items()}
    for slug, page in shown.items():
        mine = [item for item in objections if item.slug == slug]
        touched = [(item.blocking, _touched(page.after, _said(item.quote.replace("&lt;", "<")))) for item in mine]
        if any(blocking and found is None for blocking, found in touched):
            continue
        objected = {key for _, found in touched for key in found or ()}
        current = passed.setdefault(slug, {})
        for words, cites in claims(page.after, page.signatures):
            if words not in objected:
                current.setdefault(words, cites)
    return passed


def already_passed(objection: Objection, page: Any, earlier: Mapping[str, Mapping[str, frozenset[str]]]) -> bool:
    """
    Whether every claim an objection touches was passed by an earlier check,
    in the same words, and still cites every passage it passed on. Its verdict
    stands: a sentence shown again only because the block around it changed
    is not judged a second time.
    """
    passed = earlier.get(objection.slug)
    touched = _touched(page.after, _said(objection.quote.replace("&lt;", "<"))) if passed else None
    if not touched:
        return False
    now = dict(claims(page.after, page.signatures))
    return all(key in passed and passed[key] <= now.get(key, frozenset()) for key in touched)
