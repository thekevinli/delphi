"""
Addressed edits to a Memory page, applied.

A model that rewrites a whole page to add one paragraph quietly loses detail
from the paragraphs it meant to keep. So an edit never carries a new body: it
names blocks of the page as `blocks.show_page` showed it. A block no operation
names is copied to the result byte for byte, by construction: nothing here
ever re-renders it.

**An edit** (`apply_operations`) is a list of operations, each a mapping:

    {"op": "insert_after", "block": "b14" | "start", "markdown": "…"}
    {"op": "replace", "blocks": ["b9", "b10"], "markdown": "…",
     "reason": "superseded", "evidence": ["N2"]}
    {"op": "delete", "blocks": ["b21"], "reason": "duplicate"}
    {"op": "replace_text", "block": "b9", "find": "…", "with": "…"}

Every operation addresses the page as it was shown, never the result of an
earlier one, and no two may change the same block. `replace` takes one block or
an unbroken run; `find` must occur exactly once in its block. An insertion
after a block that another operation replaces or deletes is allowed: it names a
place, not a change. New text is separated from its neighbours by a blank line
and written with the page's own line ending.

**Citations.** A page's citations are mappings in the stored page's shape
(`id`, `claimType`, `paperId`, `page`, `section`, `noteId`, `evidenceId`), and
its body cites them as `[E<id>]`. New text cites an existing one by that
marker, and new evidence as `[N1]`, `[N2]`, …, each defined once in
`new_citations` as the same mapping with `ref` in place of `id`. Applying the
edit numbers the new ones after the page's highest id, in the order the result
cites them, and drops every citation, old or new, that no marker cites any
more. Existing ids never move, because moving one would rewrite a block the
edit did not name.

**What comes back** is an `Edit`. It never raises for something the caller
sent: `problems` holds one sentence for each thing that is wrong, written for
the model that sent the edit, and when it is not empty nothing else in the
`Edit` is to be used. `changes` holds one `Change` for each operation, in the
order given: what it took out and what it put in, with new text as the model
wrote it (`[N#]` not yet numbered). The preservation check in `validate.py`
reads it.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .blocks import split_blocks

#: What `insert_after` names to put text before the first block.
START = "start"
#: The highest id a stored citation may carry (`MemoryCitation.id`).
CITATION_ID_MAX = 99

_NEW_MARKER = re.compile(r"\[(N\d+)\]")
_MARKER = re.compile(r"\[E(\d+)\]")
_REF = re.compile(r"N\d+")
_SHOWN_TAG = re.compile(r"</?block\b")
_LOCATOR_FIELDS = ("paperId", "page", "section", "noteId", "evidenceId")


@dataclass(frozen=True)
class Change:
    """What one operation took out and put in. `blocks` is what it named."""

    op: str
    blocks: tuple[str, ...]
    before: str
    after: str
    reason: str | None = None
    evidence: tuple[str, ...] = ()


@dataclass(frozen=True)
class Edit:
    """The result of applying operations: a new page, or why there is none."""

    body: str = ""
    #: The page's citations after the edit, in the stored shape, by id.
    citations: tuple[dict[str, Any], ...] = ()
    #: The id each new reference was given: `{"N1": 4}`.
    refs: Mapping[str, int] = field(default_factory=dict)
    #: Ids of citations the page had that nothing cites any more.
    dropped: tuple[int, ...] = ()
    changes: tuple[Change, ...] = ()
    problems: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return not self.problems


class _Draft:
    """The operations as they are read: what each claims, and what is wrong with it."""

    def __init__(self, body: str) -> None:
        self.body = body
        self.blocks = split_blocks(body)
        self.newline = "\r\n" if "\r\n" in body else "\n"
        self.index = {block.id: position for position, block in enumerate(self.blocks)}
        #: Block position to the number of the operation that changes it.
        self.claimed: dict[int, int] = {}
        #: Position inserted after (-1 is the start) to operation number and text.
        self.inserted: dict[int, tuple[int, str]] = {}
        #: First position of a replaced run to its new text and last position.
        self.replaced: dict[int, tuple[str, int]] = {}
        self.patched: dict[int, tuple[str, str]] = {}
        self.removed: set[int] = set()
        self.changes: list[Change] = []
        self.problems: list[str] = []

    def take(self, number: int, operation: Any) -> None:
        kind = operation.get("op") if isinstance(operation, Mapping) else None
        handler = {
            "insert_after": self._insert, "replace": self._replace,
            "delete": self._delete, "replace_text": self._replace_text,
        }.get(kind)
        if handler is None:
            self.problems.append(
                f"Operation {number} has op {kind!r}; an operation is insert_after, replace, "
                "delete or replace_text."
            )
            return
        handler(number, f"Operation {number} ({kind})", operation)

    def _insert(self, number: int, where: str, operation: Mapping[str, Any]) -> None:
        anchor = operation.get("block")
        text = self._markdown(where, operation.get("markdown"))
        found = [-1] if anchor == START else self._named(where, [anchor])
        if found is None or text is None:
            return
        if found[0] in self.inserted:
            self.problems.append(
                f"{where} inserts after {anchor}, and so does operation "
                f"{self.inserted[found[0]][0]}; put both in one operation, in the order wanted."
            )
            return
        self.inserted[found[0]] = (number, text)
        self.changes.append(Change("insert_after", (anchor,), "", text))

    def _replace(self, number: int, where: str, operation: Mapping[str, Any]) -> None:
        found = self._named(where, operation.get("blocks"))
        text = self._markdown(where, operation.get("markdown"))
        if found is None or text is None:
            return
        run = sorted(found)
        names = tuple(self.blocks[position].id for position in run)
        if run != list(range(run[0], run[-1] + 1)):
            self.problems.append(
                f"{where} names blocks that are not next to each other ({', '.join(names)}); "
                "a replace takes one block or an unbroken run, so use one operation for each run."
            )
        elif self._claim(number, where, run):
            self.replaced[run[0]] = (text, run[-1])
            self.removed.update(run[1:])
            self.changes.append(Change("replace", names, self._content(run), text, *_stated(operation)))

    def _delete(self, number: int, where: str, operation: Mapping[str, Any]) -> None:
        found = self._named(where, operation.get("blocks"))
        if found is None or not self._claim(number, where, found):
            return
        run = sorted(found)
        self.removed.update(run)
        names = tuple(self.blocks[position].id for position in run)
        self.changes.append(Change("delete", names, self._content(run), "", *_stated(operation)))

    def _replace_text(self, number: int, where: str, operation: Mapping[str, Any]) -> None:
        name, find, new = operation.get("block"), operation.get("find"), operation.get("with")
        found = self._named(where, [name])
        if not isinstance(find, str) or not find or not isinstance(new, str):
            self.problems.append(
                f"{where} needs `find`, the exact text to change, and `with`, the text to put in its place."
            )
            return
        if found is None:
            return
        find, new = self._native(find), self._native(new)
        content = self.blocks[found[0]].content
        count = content.count(find)
        if count == 0:
            problem = (
                f"`find` does not occur in {name}; copy the text exactly as the page shows it, "
                "or replace the whole block"
            )
        elif count > 1:
            problem = (
                f"`find` occurs {count} times in {name}; lengthen it until it occurs once, "
                "or replace the whole block"
            )
        elif find == new:
            problem = "`with` is the same as `find`, so it changes nothing"
        elif not content.replace(find, new).strip():
            problem = f"would leave {name} empty; delete the block instead"
        else:
            if self._claim(number, where, found):
                self.patched[found[0]] = (find, new)
                self.changes.append(Change("replace_text", (name,), find, new))
            return
        self.problems.append(f"{where}: {problem}.")

    def _named(self, where: str, names: Any) -> list[int] | None:
        """The positions of the blocks an operation names, or None with the problem recorded."""
        if not isinstance(names, (list, tuple)) or not names or not all(isinstance(name, str) for name in names):
            self.problems.append(f"{where} names no block; give block ids as the page showed them, such as b3.")
            return None
        unknown = [name for name in names if name not in self.index]
        if unknown:
            has = f"its blocks are b1 to b{len(self.blocks)}" if self.blocks else 'it is empty, so insert after "start"'
            self.problems.append(f"{where} names {', '.join(unknown)}, which the page does not have; {has}.")
            return None
        if len(set(names)) != len(names):
            self.problems.append(f"{where} names a block twice; name each block once.")
            return None
        return [self.index[name] for name in names]

    def _claim(self, number: int, where: str, positions: list[int]) -> bool:
        taken = [position for position in positions if position in self.claimed]
        for position in taken:
            self.problems.append(
                f"{where} and operation {self.claimed[position]} both change {self.blocks[position].id}; "
                "operations may not overlap, so put every change to a block in one operation."
            )
        if not taken:
            self.claimed.update((position, number) for position in positions)
        return not taken

    def _markdown(self, where: str, value: Any) -> str | None:
        text = self._native(value).strip("\r\n").rstrip() if isinstance(value, str) else ""
        if not text.strip():
            self.problems.append(f"{where} has no `markdown`; to remove a block, use delete.")
            return None
        if _SHOWN_TAG.search(text):
            self.problems.append(f"{where} includes a <block> tag; write the Markdown alone, without the labels.")
            return None
        return text

    def _native(self, text: str) -> str:
        """Text a model wrote, with the page's line ending."""
        return text.replace("\r\n", "\n").replace("\n", self.newline)

    def _content(self, run: list[int]) -> str:
        return (self.newline * 2).join(self.blocks[position].content for position in run)

    def assemble(self, cite: Callable[[str], str]) -> str:
        """The new body. `cite` is applied to each piece of new text, in page order."""
        # (text, the tail of what it replaced, whether it is new text).
        pieces: list[tuple[str, str | None, bool]] = []
        if -1 in self.inserted:
            pieces.append((cite(self.inserted[-1][1]), None, True))
        for position, block in enumerate(self.blocks):
            if position in self.replaced:
                text, last = self.replaced[position]
                pieces.append((cite(text), self.blocks[last].tail, True))
            elif position in self.patched:
                find, new = self.patched[position]
                pieces.append((block.lead + block.content.replace(find, cite(new)) + block.tail, None, False))
            elif position not in self.removed:
                pieces.append((block.text, None, False))
            if position in self.inserted:
                pieces.append((cite(self.inserted[position][1]), None, True))
        out = ""
        for number, (text, tail, new) in enumerate(pieces, start=1):
            if not new:
                out += text
                continue
            # A blank line on both sides of new text. It is added beside the
            # new text, never by changing a block the edit did not name.
            if out.strip():
                out += self.newline * max(0, 2 - out[len(out.rstrip()) :].count("\n"))
            if number == len(pieces):
                end = tail if tail is not None else (self.newline if self.body.endswith("\n") else "")
            else:
                end = tail if tail and tail.count("\n") >= 2 else self.newline * 2
            out += text + end
        return out


def _stated(operation: Mapping[str, Any]) -> tuple[str | None, tuple[str, ...]]:
    """An operation's reason and evidence, as given. `validate.py` judges them."""
    reason, evidence = operation.get("reason"), operation.get("evidence")
    listed = evidence if isinstance(evidence, (list, tuple)) else ()
    return (str(reason) if reason is not None else None), tuple(str(item) for item in listed)


def apply_operations(
    body: str,
    operations: Sequence[Mapping[str, Any]],
    *,
    citations: Sequence[Mapping[str, Any]] = (),
    new_citations: Sequence[Mapping[str, Any]] = (),
) -> Edit:
    """Apply operations addressed to `body` as `show_page` showed it (see the module docstring)."""
    draft = _Draft(body)
    for number, operation in enumerate(operations, start=1):
        draft.take(number, operation)
    existing: dict[int, dict[str, Any]] = {}
    for citation in citations:
        existing.setdefault(int(citation["id"]), dict(citation))
    defined: dict[str, Mapping[str, Any]] = {}
    for entry in new_citations:
        ref = entry.get("ref") if isinstance(entry, Mapping) else None
        if not isinstance(ref, str) or not _REF.fullmatch(ref):
            draft.problems.append(
                f"A new citation has ref {ref!r}; name new citations N1, N2, … and cite them in the text as [N1]."
            )
        elif ref in defined:
            draft.problems.append(f"Citation {ref} is defined twice; define each reference once.")
        else:
            defined[ref] = entry
    if draft.problems:
        return Edit(problems=tuple(draft.problems))

    written: list[str] = []

    def collect(text: str) -> str:
        written.append(text)
        return text

    unnumbered = draft.assemble(collect)
    cited = list(dict.fromkeys(ref for text in written for ref in _NEW_MARKER.findall(text)))
    for ref in cited:
        if ref not in defined:
            draft.problems.append(
                f"The new text cites [{ref}], and `citations` defines no {ref}; define it, or remove the marker."
            )
    invented = {int(found) for text in written for found in _MARKER.findall(text)} - set(existing)
    for number in sorted(invented):
        draft.problems.append(
            f"The new text cites [E{number}], which is not one of this page's citations; cite evidence "
            "the page does not have yet as [N1], [N2], … and define each in `citations`."
        )
    if not unnumbered.strip():
        draft.problems.append("The operations would leave the page with no text.")
    standing = {int(found) for found in _MARKER.findall(unnumbered)}
    top = max(standing | set(existing), default=0)
    # After the highest id the page has had, so that a marker never comes to
    # mean a different citation between two versions. Only a page that has run
    # out of ids reuses the ones it dropped.
    free = list(range(top + 1, CITATION_ID_MAX + 1))
    if len(free) < len(cited):
        free = [number for number in range(1, CITATION_ID_MAX + 1) if number not in standing]
    if len(free) < len(cited):
        draft.problems.append(
            f"The page would carry more than {CITATION_ID_MAX} citations; cite fewer sources in this edit."
        )
    if draft.problems:
        return Edit(problems=tuple(draft.problems))

    refs = dict(zip(cited, free))
    result = draft.assemble(lambda text: _NEW_MARKER.sub(lambda found: f"[E{refs[found.group(1)]}]", text))
    kept = [existing[number] for number in sorted(existing) if number in standing]
    added = [
        {"id": refs[ref], "claimType": defined[ref].get("claimType"),
         **{name: defined[ref].get(name) for name in _LOCATOR_FIELDS}}
        for ref in cited
    ]
    return Edit(
        body=result,
        citations=tuple(sorted([*kept, *added], key=lambda citation: citation["id"])),
        refs=refs,
        dropped=tuple(number for number in sorted(existing) if number not in standing),
        changes=tuple(draft.changes),
    )
