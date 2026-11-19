"""
What a page checked again is shown, and what is taken out of a page its repair could not mend.

**Checked again, a page shows only what changed.** A page blocked by the first
check is repaired (or re-cited) and checked once more. Before 0.6.4 the
second check read the whole page again, and a new page of thirty claims that
had passed once was read whole a second time: the checker, a reasoning model
with no temperature, then struck claims it had passed, and a domain page
needed three attempts. Now each check records what it passed, by unit (a
block of a new page, its summary, one change of an edit), with citation
markers read as the locators they name so a renumbered citation is the same
text (`unit_key`); a later check of the page is shown only the units not
passed (`verify._show`). What it is not shown was checked and passed, so
nothing unchecked is committed.

A quote that no single unit holds (a paragraph running into display
mathematics, two changes of one edit) passes nothing new on its page: the
objected claim is in units nobody can tell apart, so all of them are shown
again.

**What a check passes, it passes claim by claim** (`verify_claims`).

**What a repair could not mend is struck** (`strike`). When the author's repair
of a page is refused or leaves it as it was, or the page is still blocked after
it, the claims the standing objections quote are taken out of the page's new
text: a table row, a list item with its continuation lines, or a sentence with
up to `FOLLOWERS_MAX` sentences after it that point back at it. A
sentence's closing run of markers stays, on the sentence before it, because it
may carry the citations of the sentences before it; a block left with no
sentence, or with sentences that cite nothing of their own, goes, and a citation
no marker names any more goes with it. A strike is refused, and the page
dropped, whenever it could damage what the reader sees:

- a quote in the page's summary, in more than one block, in a blockquote or
  a wrapped paragraph (striking one would join its lines), in a list or table
  it would leave with no item, or in old text, or still on the page after the
  cut, or a `removed` or `overwritten` objection;
- more sentences leaning on the struck one than `FOLLOWERS_MAX`, or a next
  paragraph that opens by pointing back at it;
- an edit whose struck changes `validate.preservation_problems` refuses, or
  that would delete text the page already had: a `replace` whose new text is
  all struck becomes a deletion of the old;
- a page left with no cited block, which a check would pass on nothing;
- in a run that files notes, Delphi's inference left without the note it sat
  beside, where a deleted note could no longer find it (`verify_round._struck`).

A refused strike says why (`Refused`), and the dropped page's event keeps it
beside the page as staged: a page lost over one sentence can then be told
from a strike that worked as meant.

Sentences end at a stop, Chinese ones too, but not at "Fig.", "e.g." or an
initial.
"""

from __future__ import annotations

import dataclasses
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..harness.evidence import normalise
from .blocks import split_blocks
from .run import Objection
from .staging import StagedPage
from .validate import preservation_problems
from .verify_locate import MARKER, plain

@dataclass(frozen=True)
class Refused:
    """Why a strike was refused, in words the dropped page's event keeps."""

    why: str


#: The findings whose quoted sentence may be struck from new text.
STRIKABLE = ("unsupported", "differs")
#: How much more than its quote a strike may take: more means the sentences
#: could not be told apart, and others would go with it.
OVERREACH = 2
OVERREACH_CHARS = 120
#: Sentences after a struck one that point back at it ("It …") and go with it,
#: as one claim: more than this and the repair, not a strike, should mend it.
FOLLOWERS_MAX = 2
#: Words a full stop follows without ending the sentence.
ABBREVIATIONS = frozenset(
    "fig figs eq eqs sec secs tab no nos ref refs ch app appx al e.g i.e vs cf approx resp p pp vol ed dr mr ms".split()
)

# The run of markers that closes a sentence, before or after its stop.
_CLOSING_RUN = re.compile(r"((?:\s*\[[EN]\d+\])+)\s*[.!?。！？]?\s*$")
# Where a sentence may end: a stop and the run of markers that closes it.
_STOP = re.compile(r"[.!?](?:\s*\[[EN]\d+\])*(?=\s|$)|[。！？](?:\s*\[[EN]\d+\])*")
_WORD_BEFORE = re.compile(r"([^\W\d][\w.]*)$")
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
# A list item at the margin: a bullet or a number, then a space. An indented one belongs to the item above.
_TOP_ITEM = re.compile(r"^(?:[-*+]|\d+[.)])\s")
_HEADING = re.compile(r" {0,3}#{1,6}[ \t]")
_LINK = re.compile(r"\[\[[^\]]+\]\]")
# Markup a sentence may open with: emphasis, a list mark, a quotation mark.
_OPENING = re.compile(r"^[\s*_>\-\"'“‘(]+")
_BACK_REFERENCE = re.compile(
    r"(?i)(?:it|its|it's|this|that|these|those|they|them|their|such|here|there|thus|hence|therefore|so|"
    r"however|instead|in contrast|by contrast|conversely|likewise|similarly|also|moreover|furthermore|"
    r"meanwhile|then|both|neither|either|yet|but|and|or|nor|accordingly|consequently|otherwise|"
    r"the latter|the former|the same|unlike (?:this|that|these|it))\b"
)


def _signature(citation: Mapping[str, Any]) -> str:
    source = citation.get("evidenceId") or citation.get("paperId") or ""
    where = citation.get("noteId") or citation.get("section") or citation.get("page") or ""
    return f"[{citation.get('claimType')}:{source}:{where}]"


def unit_key(text: str, page: StagedPage, kind: str = "") -> str:
    """A unit of a page as a check compares it: its words, with each marker read as what it cites."""
    by_id = {int(citation["id"]): citation for citation in page.citations}

    def read(found: re.Match[str]) -> str:
        name = found.group(1)
        number = page.refs.get(name) if name.startswith("N") else int(name[1:])
        return _signature(by_id[number]) if number in by_id else found.group(0)

    return kind + "\0" + normalise(MARKER.sub(read, text))


def units_of(page: StagedPage, changes: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """What a check of a page is made of: a new page's summary and blocks, an edit's changes, each with its key."""
    if page.action == "create":
        blocks = [block.content for block in split_blocks(page.body) if block.content.strip()]
        return [(unit_key(page.summary, page, "summary"), page.summary)] + [(unit_key(text, page, "block"), text) for text in blocks]
    return [
        (unit_key(change["before"], page, change["op"]) + unit_key(change["after"], page), f"{change['before']}\n{change['after']}")
        for change in changes
    ]


def passed_units(
    shown: Mapping[str, Sequence[tuple[str, str]]], objections: Sequence[Objection], again: Mapping[str, frozenset[str]]
) -> dict[str, frozenset[str]]:
    """
    What each page has passed so far: what earlier checks passed, and every
    unit shown now that no blocking objection quotes. A blocking quote no
    single unit holds passes nothing new on its page.
    """
    passed = dict(again)
    for slug, units in shown.items():
        quotes = [normalise(item.quote.replace("&lt;", "<")) for item in objections if item.blocking and item.slug == slug]

        def quoted(text: str, quote: str) -> bool:
            return quote in normalise(text) or quote in plain(text)

        if any(not any(quoted(text, quote) for _, text in units) for quote in quotes):
            passed[slug] = again.get(slug, frozenset())
            continue
        passed[slug] = again.get(slug, frozenset()) | {
            key for key, text in units if not any(quoted(text, quote) for quote in quotes)
        }
    return passed


def sentences(text: str) -> list[str]:
    """A paragraph's sentences, each with the run of markers that closes it, in order and whole."""
    found, start = [], 0
    for stop in _STOP.finditer(text):
        if stop.group(0)[0] == "." and (word := _WORD_BEFORE.search(text[start:stop.start()])):
            last = word.group(1).casefold()
            if last in ABBREVIATIONS or len(last) == 1:
                continue
        found.append(text[start:stop.end()])
        start = stop.end()
    if text[start:].strip():
        found.append(text[start:])
    return [sentence for sentence in found if sentence.strip()]


def _refers_back(sentence: str) -> bool:
    """Whether a sentence opens by pointing at the one before it ("It asks …", "In contrast to …", "However, …")."""
    opening = _OPENING.sub("", sentence)
    return bool(_BACK_REFERENCE.match(opening)) or opening[:1].islower()


def _without(text: str, quote: str, old: str = "", whole: bool = False) -> tuple[str, str, bool] | Refused:
    """
    A block's text without the sentences a quote is in, keeping their closing
    runs on new text; with what was taken out, and whether that was the
    block's last sentence. Refused when it cannot be done cleanly: see the module
    docstring. `old` is the page as shown: a run is never moved onto a sentence it holds.
    """
    wanted = plain(quote)
    lines = text.strip().splitlines()
    if not wanted or not lines:
        return Refused("the quote is not in the block")
    if _TABLE_ROW.match(lines[0]):
        rows = text.splitlines(keepends=True)
        kept = [row for row in rows if wanted not in plain(row)]
        # A table keeps its header, its rule and at least one row.
        if len(rows) - len(kept) != 1 or len(kept) <= 2:
            return Refused("the quote is in more than one row of a table, or its table would be left with no row")
        return "".join(kept), next(row for row in rows if row not in kept), False
    if _TOP_ITEM.match(lines[0]):
        # An item is a claim, with the lines and nested items that continue it: it goes whole, and the list keeps one.
        items: list[list[str]] = []
        for line in text.splitlines(keepends=True):
            if items and not _TOP_ITEM.match(line):
                items[-1].append(line)
            else:
                items.append([line])
        hit = [item for item in items if wanted in plain("".join(item))]
        # A change may insert a single item; the list it joins keeps its others (`whole`).
        if len(hit) != 1 or (len(items) < 2 and not whole):
            return Refused("the quote is in more than one item of a list, or its list would be left with none")
        return "".join(line for item in items if item is not hit[0] for line in item), "".join(hit[0]), False
    if len(lines) > 1:
        # A quotation or a wrapped paragraph: joining its lines would change what the reader sees.
        return Refused("the quote is in a quotation or a paragraph of several lines")
    parts = sentences(text.strip())
    flat = [plain(part) for part in parts]
    hit = {index for index, sentence in enumerate(flat) if sentence and (sentence in wanted or wanted in sentence)}
    if not hit:
        # A quote that runs across sentences: every sentence it covers.
        joined, spans, at = " ".join(flat), [], 0
        for sentence in flat:
            spans.append((at, at + len(sentence)))
            at += len(sentence) + 1
        start = joined.find(wanted)
        if start < 0:
            return Refused("the quote is not in the block's sentences")
        hit = {index for index, (left, right) in enumerate(spans) if left < start + len(wanted) and right > start}
    removed = " ".join(parts[index] for index in sorted(hit))
    if len(plain(removed)) > max(OVERREACH * len(wanted), len(wanted) + OVERREACH_CHARS):
        # Far more than the quote: sentences the split could not tell apart would go with it.
        return Refused("the sentences around the quote could not be told apart")
    after = first = max(hit) + 1
    # What follows and leans on it is part of the same claim, and goes with it.
    while after < len(parts) and _refers_back(parts[after]) and after - first < FOLLOWERS_MAX:
        hit.add(after)
        after += 1
    if after < len(parts) and _refers_back(parts[after]):
        # More leans on it than a strike may take: the repair, not a strike, can mend that.
        return Refused("more sentences lean on the one that would go than a strike may take")
    removed = " ".join(parts[index] for index in sorted(hit))
    kept: list[str] = []
    for index, sentence in enumerate(parts):
        if index not in hit:
            kept.append(sentence)
            continue
        run = _CLOSING_RUN.search(sentence)
        if index - 1 in hit:
            # A sentence leaning on the one struck before it cites for itself: its run goes with it.
            continue
        if run and kept and not MARKER.search(kept[-1]) and not (old and plain(kept[-1]) in plain(old)):
            # The run may close the sentences before this one too: it stays, on the one before, when
            # that one cites nothing of its own. One that does was not leaning on it, and it goes.
            kept[-1] = kept[-1].rstrip() + " " + run.group(1).strip()
    body = " ".join(part.strip() for part in kept if part.strip())
    if MARKER.search(text) and not MARKER.search(body):
        # What is left cited nothing on its own: it leaned on what was struck.
        body = ""
    return body + ("\n" if text.endswith("\n") and body else ""), removed, after >= len(parts)


def _kept_old(shown_body: str, page: StagedPage, body: str) -> bool:
    """Whether every sentence of the page as shown that the edit kept is still there."""
    held = plain(body)
    return all(
        plain(sentence) in held
        for block in split_blocks(shown_body) for sentence in sentences(block.content.strip())
        if plain(sentence) and plain(sentence) in plain(page.body)
    )


def strike(page: StagedPage, objections: Sequence[Objection], shown_body: str = "") -> StagedPage | Refused:
    """
    The page without the new sentences its standing objections quote, or why a strike is refused.

    `shown_body` is the page as the run was shown it, for an edit: text it
    already holds is never struck (see the module docstring).
    """
    body, changes = page.body, list(page.changes)
    pending = list(objections)
    while pending:
        objection = pending.pop(0)
        if objection.finding not in STRIKABLE:
            return Refused(f"a {objection.finding} objection is never struck")
        if shown_body and plain(objection.quote) in plain(shown_body):
            return Refused("the quote is text the page already held")
        if plain(objection.quote) in plain(page.summary):
            return Refused("the quote is in the page's summary, which a strike cannot cut")
        if plain(objection.quote) in plain(page.body) and plain(objection.quote) not in plain(body):
            # An earlier cut took part of what it quotes, with a claim it leaned on: what is left of it goes too.
            original = next((block.content for block in split_blocks(page.body) if plain(objection.quote) in plain(block.content)), "")
            covered = _without(original, objection.quote, shown_body) if original else Refused("no single block of the page holds the quote")
            if isinstance(covered, Refused):
                return covered
            left = [sentence for sentence in sentences(covered[1]) if plain(sentence) and plain(sentence) in plain(body)]
            pending[0:0] = [dataclasses.replace(objection, quote=sentence) for sentence in left]
            continue
        blocks = split_blocks(body)
        holding = [index for index, block in enumerate(blocks) if plain(objection.quote) in plain(block.content)]
        if len(holding) > 1:
            # Nobody can say which of them the checker meant.
            return Refused("the quote is in more than one block of the page")
        at = holding[0] if holding else None
        if at is None:
            return Refused("no single block of the page holds the quote")
        cut = _without(blocks[at].content, objection.quote, shown_body)
        if isinstance(cut, Refused):
            return cut
        rest, removed, last = cut
        following = next((block.content for block in blocks[at + 1:] if block.content.strip()), "")
        if last and following and not _HEADING.match(following) and _refers_back(sentences(following.strip())[0]):
            # The next paragraph opens by pointing back at what would be struck.
            return Refused("the next paragraph opens by referring back to the sentence that would go")
        if page.action == "edit":
            index = next((i for i, change in enumerate(changes) if plain(objection.quote) in plain(change.after)), None)
            if index is None:
                return Refused("no change of the edit holds the quote")
            changed = _without(changes[index].after, objection.quote, shown_body, whole=True)
            if isinstance(changed, Refused):
                return changed
            if not changed[0].strip() and changes[index].before.strip():
                # All of a replacement struck would leave a deletion of what it replaced.
                return Refused("all of a replacement would go, leaving a deletion of what it replaced")
            changes[index] = dataclasses.replace(changes[index], after=changed[0])
        body = body.replace(blocks[at].content, rest, 1)
        if plain(objection.quote) in plain(body):
            return Refused("the quote is still on the page after the cut")
        if any(link not in body for link in _LINK.findall(removed)):
            # The page's only link to another page would go with the sentence.
            return Refused("a link to another page would go with the sentence")
    named = {int(number) for number in re.findall(r"\[E(\d+)\]", body)} | {
        page.refs[name] for name in re.findall(r"\[(N\d+)\]", body) if name in page.refs
    }
    citations = tuple(citation for citation in page.citations if int(citation["id"]) in named)
    body = re.sub(r"\n{3,}", "\n\n", body)
    if body == page.body:
        return Refused("nothing would be struck")
    if not any(MARKER.search(block.content) for block in split_blocks(body)):
        # Nothing cited left for a check to read.
        return Refused("no cited block would be left")
    if page.action == "edit":
        changes = [change for change in changes if change.before or change.after]
        known = {f"E{citation['id']}" for citation in page.citations} | set(page.refs)
        if body.strip() == shown_body.strip():
            return Refused("nothing new would be left of the edit")
        if not _kept_old(shown_body, page, body) or preservation_problems(
            shown_body, changes, evidence=known, keep_words=page.kind == "concept"
        ):
            return Refused("the edit would lose text the page already had")
    return dataclasses.replace(page, body=body, citations=citations, changes=tuple(changes))
