"""
What on a Memory page rests on a reader's note.

A note is evidence of what the reader thinks, and the reader can take it back.
What a page says on a note's word has to be found again when they do, and the
one record of it is the note's citation: a statement (`blocks.statements`)
that cites a note rests on it. Four rules keep that record whole. Each is a
function here that needs neither storage nor a model.

- **What a run that files notes writes cites a note, unless a document's page
  says it** (`unrested`). A note is filed in a run of its own
  (`gather_session`), so what such a run writes came from the notes, or from a
  document the agent went back to because of them. A statement cited to a
  document's page stands on that page: the checker holds it to the passage,
  and it stays when the note goes. Delphi's own inference (`derived`) and new
  words cited to no document have no passage to stand on. They are the
  reader's reasoning restated, and carry the note they came from. Only what
  the write adds is held to this: a statement a `replace` copies, and markers
  a `replace_text` finds, are the page's already. On 0.6.3, three of four
  real notes were filed as `derived` arithmetic and conclusions with no note
  citation, so deleting them retracted nothing.
- **A deleted note takes with it what rested only on it** (`withdrawn`): a
  statement whose every marker is that note's citation or Delphi's inference.
  A statement that also cites a document is the agent's to judge, since part
  of it may stand on the document alone; whatever is left of it loses the
  note's citation (`without_notes`).
- **Its words do not stay without it** (`kept_problems`): an edit that takes
  the marker off such a statement and keeps the words keeps the reader's claim,
  uncited.
- **A strike never parts them** (`parted`): in a run that files notes, the
  checker's strike may not leave Delphi's inference in a statement without the
  note it sat beside.
"""

from __future__ import annotations

import re
from collections.abc import Collection, Mapping, Sequence
from typing import Any

from .blocks import Statement, split_blocks, statements

#: Statements one refusal lists before it counts the rest.
LISTED = 4
#: The fewest characters of a withdrawn statement's words that count as kept.
KEPT_MIN_CHARS = 24
QUOTE_CHARS = 120

_MARKER = re.compile(r"\[([EN]\d+)\]")
_WORD = re.compile(r"[^\W_]+")
_LINK = re.compile(r"\[\[[^\[\]]*\]\]")


def _plain(text: str) -> str:
    """Text without its markers, its whitespace collapsed: what a reader reads of it."""
    return " ".join(_MARKER.sub(" ", text).split())


def _quote(text: str) -> str:
    plain = _plain(text)
    return plain if len(plain) <= QUOTE_CHARS else plain[: QUOTE_CHARS - 1].rstrip() + "…"


def _markers(text: str) -> list[str]:
    return _MARKER.findall(text)


#: What one statement an edit writes adds: where it is, the statement as it
#: will read, the markers the edit put in it, and whether it put in words.
Written = tuple[str, Statement, list[str], bool]
#: A statement of no more words than this, besides its links, only points.
POINTER_WORDS = 3


def _words(text: str) -> set[str]:
    return set(_WORD.findall(_LINK.sub(" ", _plain(text)).casefold()))


def _minus(markers: list[str], taken: list[str]) -> list[str]:
    """The markers of one list that another does not account for, counted."""
    left = list(taken)
    found = []
    for name in markers:
        if name in left:
            left.remove(name)
        else:
            found.append(name)
    return found


def written(shown: str, changes: Sequence[Any]) -> list[Written]:
    """
    What an edit writes, statement by statement, counting only what it adds:
    a statement a `replace` copies unchanged is not written, and markers and
    words a `replace_text` finds are not added by it.
    """
    blocks = {block.id: block.content for block in split_blocks(shown)}
    found: list[Written] = []
    for number, change in enumerate(changes, start=1):
        where = f"Operation {number} ({change.op})"
        if change.op in ("insert_after", "replace"):
            before = _markers(change.before)
            copied = {(_plain(item.text), tuple(sorted(_markers(item.text)))) for item in statements(change.before)}
            for item in statements(change.after):
                if (_plain(item.text), tuple(sorted(_markers(item.text)))) not in copied:
                    found.append((where, item, _minus(_markers(item.text), before), bool(_words(item.text) - _words(change.before))))
        elif change.op == "replace_text" and change.after and change.blocks and change.blocks[0] in blocks:
            content = blocks[change.blocks[0]]
            at = content.find(change.before)
            if at < 0:
                continue
            result = content[:at] + change.after + content[at + len(change.before):]
            end = at + len(change.after)
            for item in statements(result):
                if item.start < end and item.end > at:
                    added = result[max(item.start, at): min(item.end, end)]
                    marked = _minus(_markers(added), _markers(change.before))
                    words = bool(_words(added) - _words(change.before))
                    if marked or words:
                        found.append((where, item, marked, words))
    return found


def unrested(written: Sequence[Written], known: Mapping[str, Mapping[str, Any]], notes: Collection[str]) -> list[str]:
    """
    Why statements a run that files `notes` writes cannot stand (see the module docstring).

    A statement that cites one of the notes stands. One that does not is
    refused when the write put Delphi's inference (`derived`) in it, or put
    words in it and it cites no document or outside source to hold them to.
    `known` resolves a marker's name (`N1`, `E3`) to its citation.
    """
    if not notes:
        return []
    problems: list[str] = []
    for where, item, marked, words in written:
        cited = [known[name] for name in _markers(item.text) if name in known]
        if any(citation.get("claimType") == "reader-note" and citation.get("noteId") in notes for citation in cited):
            continue
        inferred = [name for name in marked if (known.get(name) or {}).get("claimType") == "derived"]
        sourced = any(citation.get("claimType") in ("author-claim", "external") for citation in cited)
        if inferred:
            why = f"is Delphi's own inference ({', '.join(f'[{name}]' for name in inferred)} is derived)"
        elif words and not sourced and len(_words(item.text)) > POINTER_WORDS:
            why = "cites no document" if cited else "cites nothing"
        else:
            continue
        problems.append(f"{where}: {_quote(item.text)!r} {why}")
    if not problems:
        return []
    listed = problems[:LISTED] + ([f"and {len(problems) - LISTED} more like them"] if len(problems) > LISTED else [])
    return [
        "This run files the reader's notes, so what it writes either says what a document's page says, cited "
        "there, or rests on a note. These rest on a note and cite none: "
        + "; ".join(listed)
        + ". Give each the `reader-note` citation of the note it rests on, beside its other citations (this run's "
        + "notes: " + ", ".join(sorted(notes)) + "). Where a document's page says it, cite that page instead."
    ]


def created(body: str) -> list[Written]:
    """A new page's statements, each written whole."""
    return [("The body", item, _markers(item.text), bool(_words(item.text))) for item in statements(body)]


def parted(
    before: str, before_citations: Sequence[Mapping[str, Any]], after: str, after_citations: Sequence[Mapping[str, Any]],
    notes: Collection[str],
) -> bool:
    """
    Whether Delphi's inference that sat in a statement beside one of these
    notes' citations sits, in `after`, in a statement that cites none of them:
    a strike that did that would leave the inference where a deleted note can
    no longer find it (`verify_round._struck`). Citation ids never move, so a
    marker is followed by its id; what had no note before is not counted.
    """
    def ids(citations: Sequence[Mapping[str, Any]], wanted: Any) -> set[str]:
        return {f"E{int(item['id'])}" for item in citations if wanted(item)}

    noted = ids(before_citations, lambda item: item.get("noteId") in notes)
    derived = ids(before_citations, lambda item: item.get("claimType") == "derived")
    paired = {
        name for item in statements(before)
        if (names := set(_markers(item.text))) & noted for name in names & derived
    }
    still = ids(after_citations, lambda item: item.get("noteId") in notes)

    def alone(body: str, held: set[str]) -> set[tuple[str, str]]:
        """Each statement that carries a paired marker without a note's citation, by its words and the marker."""
        return {
            (_plain(item.text), name) for item in statements(body)
            if not (names := set(_markers(item.text))) & held for name in names & paired
        }

    return bool(alone(after, still) - alone(before, noted))


def _gone_markers(citations: Sequence[Mapping[str, Any]], notes: Collection[str]) -> tuple[set[str], set[str]]:
    gone = {f"E{int(item['id'])}" for item in citations if item.get("noteId") in notes}
    derived = {f"E{int(item['id'])}" for item in citations if item.get("claimType") == "derived"}
    return gone, derived


def withdrawn(body: str, citations: Sequence[Mapping[str, Any]], notes: Collection[str]) -> list[Statement]:
    """The statements of a stored page that rest only on these notes: each marker is theirs or Delphi's inference."""
    gone, derived = _gone_markers(citations, notes)
    return [
        item for item in statements(body)
        if (names := set(_markers(item.text))) & gone and names <= gone | derived
    ]


def kept_problems(
    shown: str, citations: Sequence[Mapping[str, Any]], notes: Collection[str], body: str,
    after: Sequence[Mapping[str, Any]], evidence: Collection[str] = (),
) -> list[str]:
    """
    Why an edit keeps the words of a statement that rested only on a deleted
    note. `body` and `after` are the page as the edit leaves it. The same
    statement, word for word, cited to a source of the run instead (a
    document's page, a captured source, a note in `evidence`) stands on that
    source and may stay; words merged into another statement may not. While
    the edit still cites the note, its own refusal says so, and this waits.
    """
    if any(item.get("noteId") in notes for item in after):
        return []
    sourced = {
        f"E{int(item['id'])}" for item in after
        if item.get("claimType") in ("author-claim", "external") or (item.get("noteId") and item["noteId"] in evidence)
    }
    recited = {_plain(item.text) for item in statements(body) if set(_markers(item.text)) & sourced}
    held = _plain(body)
    kept = [
        item for item in withdrawn(shown, citations, notes)
        if len(words := _plain(item.text)) >= KEPT_MIN_CHARS and words in held and words not in recited
    ]
    return [
        f"{item.block} said {_quote(item.text)!r} on the word of a note the reader deleted, and nothing else; "
        "the edit keeps those words. Delete them with the reason `withdrawn`, or keep them as they are, cited to "
        "the source of this run that says them."
        for item in kept
    ]


def without_notes(
    body: str, citations: Sequence[Mapping[str, Any]], notes: Collection[str], *, withdraw: bool = True,
) -> tuple[str, list[dict[str, Any]]]:
    """
    A stored page without what rested only on these notes, and without their
    citations: the statements `withdrawn` names are taken out (a block they
    leave with no statement goes whole), the notes' markers come off what
    stays, and a citation no marker names any more is dropped. With
    `withdraw` false, only the markers and the citations go.
    """
    every = statements(body)
    drop = withdrawn(body, citations, notes) if withdraw else []
    if drop:
        kept: list[str] = []
        offset = 0
        for block in split_blocks(body):
            start, offset = offset + len(block.lead), offset + len(block.text)
            gone = [item for item in drop if item.block == block.id]
            if not gone:
                kept.append(block.text)
            elif len(gone) == sum(item.block == block.id for item in every):
                # A block that went whole keeps the blank line it ended on where the
                # block before ran straight into it, so that two paragraphs stay two.
                if kept and not "".join(kept).endswith(("\n\n", "\n\r\n")):
                    kept.append("\r\n" if "\r\n" in block.text else "\n")
            else:
                # Items of a list or rows of a table: whole lines, the last of which may have no line end.
                content = block.content
                for item in sorted(gone, key=lambda found: found.start, reverse=True):
                    content = content[: item.start - start] + content[item.end - start:]
                kept.append(block.lead + content.rstrip() + block.tail)
        # A page whose last block went ends as it did before, not on that block's blank lines.
        body = "".join(kept).rstrip() + body[len(body.rstrip()):]
    for name in _gone_markers(citations, notes)[0]:
        body = re.sub(rf"[ \t]*\[{name}\]", "", body)
    named = {int(found) for found in re.findall(r"\[E(\d+)\]", body)}
    return body, [dict(item) for item in citations if int(item["id"]) in named]
