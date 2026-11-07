"""
A Memory page as its top-level Markdown blocks, and how they are shown.

An edit to a page names the blocks it changes (`ops.py`), so the page is cut
into blocks and each is shown under a label, `b1`, `b2`, … in order.

**The split** (`split_blocks`) is lossless: joining the blocks' `text` gives
the body back exactly (`join_blocks`). A block is one heading, one fenced code
block, one display-maths block (`$$…$$`, `\\[…\\]`, `\\begin{x}…\\end{x}`), one
list with everything nested in it, or one run of lines up to a blank line (a
paragraph, a table, a blockquote). Blank lines belong to the block before
them. It is a line scanner, not a Markdown parser: the backend depends on
none, and a parser that normalised a single space would break the promise that
a block no edit names is kept byte for byte.

Where the scanner and a renderer could disagree, it only draws a boundary in a
different place: a setext heading stays with its paragraph, an indented code
block with a blank line in it is two blocks, a paragraph that runs straight
into a list is a paragraph and then a list. No text is ever lost or changed.

**As shown** (`show_page`), each block is its `content`, verbatim, between two
lines of its own:

    <block id="b1">
    ## Position encoding
    </block>
    <block id="b2">
    Sinusoidal encodings add a fixed signal to each token [E1].
    </block>

The blank lines between blocks are not shown, and line endings are shown as
`\\n` whatever the page uses.

**Statements** (`statements`) are what a citation marker vouches for: a
paragraph, one item of a list (at any depth, up to the next item), one body row
of a table, and display maths that carries a marker. A heading, fenced code, a
table's header and rule, a line that is only a figure and unmarked maths state
nothing a marker could cite, and are not statements. What rests on a reader's
note is decided statement by statement (`reader_notes.py`).
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

_LINE = re.compile(r"[^\n]*\n|[^\n]+")
_FENCE = re.compile(r" {0,3}(?:`{3,}|~{3,})")
_HEADING = re.compile(r" {0,3}#{1,6}(?:[ \t]|\r?$)")
_LIST_ITEM = re.compile(r" {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|\r?$)")
# What may start a list in the middle of a paragraph, as CommonMark has it: a
# bullet, or the number one. "2015. It was" at the start of a wrapped line is
# a sentence.
_ITEM_AFTER_TEXT = re.compile(r" {0,3}(?:[-*+]|1[.)])[ \t]+\S")
_BEGIN = re.compile(r"\\begin\{([^}]+)\}")
_LEADING_BLANK_LINES = re.compile(r"(?:[ \t]*\r?\n)*")
_TABLE_ROW = re.compile(r" {0,3}\|")
_ANY_ITEM = re.compile(r"[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|\r?$)")
_MARKED = re.compile(r"\[[EN]\d+\]")
# A table's rule: pipes, colons and hyphens, as GFM writes `|:--|--:|`.
_TABLE_RULE = re.compile(r"[ \t]*\|?[ \t:|-]*-[ \t:|-]*\r?\n?$")
_FIGURE_ONLY = re.compile(r"\s*!\[[^\]]*\]\([^)]*\)\s*")


@dataclass(frozen=True)
class Statement:
    """One statement of a body: `text` is `body[start:end]`, whole lines for an item or a row."""

    start: int
    end: int
    text: str
    #: The label of the block it is in.
    block: str


@dataclass(frozen=True)
class Block:
    """One top-level block: `text` is its exact slice of the body."""

    id: str
    text: str

    @property
    def lead(self) -> str:
        """Blank lines before the content. Only a page's first block has any."""
        return _LEADING_BLANK_LINES.match(self.text).group(0) if self.text.strip() else ""

    @property
    def content(self) -> str:
        """The block without the blank lines around it: what is shown and edited."""
        return self.text[len(self.lead) : len(self.text.rstrip())]

    @property
    def tail(self) -> str:
        """The line ending and blank lines after the content."""
        return self.text[len(self.text.rstrip()) :] if self.text.strip() else self.text


def split_blocks(body: str) -> list[Block]:
    """The page's top-level blocks, labelled b1, b2, … Joining their text is the body."""
    lines = _LINE.findall(body)
    starts: list[int] = []
    at = 0
    while at < len(lines):
        if lines[at].strip():
            starts.append(at)
            at = _block_end(lines, at)
        else:
            at += 1
    if not starts:
        return [Block("b1", body)] if body else []
    # A block runs to the start of the next, so it owns the blank lines after
    # it; the first also owns any before it.
    edges = [0, *starts[1:], len(lines)]
    return [
        Block(f"b{number}", "".join(lines[edges[number - 1] : edges[number]]))
        for number in range(1, len(edges))
    ]


def join_blocks(blocks: Sequence[Block]) -> str:
    return "".join(block.text for block in blocks)


def show_page(body: str) -> str:
    """The page as a model reads it: each block under its label (see the module docstring)."""
    return "\n".join(
        f'<block id="{block.id}">\n' + block.content.replace("\r\n", "\n") + "\n</block>"
        for block in split_blocks(body)
    )


def statements(body: str) -> list[Statement]:
    """The statements of a body, in order (see the module docstring)."""
    found: list[Statement] = []
    at = 0
    for block in split_blocks(body):
        start = at + len(block.lead)
        at += len(block.text)
        content = block.content
        lines = _LINE.findall(content)
        if not content.strip() or _FENCE.match(lines[0]) or _HEADING.match(lines[0]):
            continue
        if _maths_end(lines, 0) == len(lines) and not _MARKED.search(content):
            continue
        spans: list[list[int]] = []
        if _LIST_ITEM.match(lines[0]):
            # An item runs to the next item, at whatever depth: a nested item
            # is a claim of its own, and may rest on what its parent does not.
            offset = 0
            for line in lines:
                if _ANY_ITEM.match(line):
                    spans.append([offset, offset + len(line)])
                elif spans:
                    spans[-1][1] = offset + len(line)
                offset += len(line)
        elif _TABLE_ROW.match(lines[0]) and len(lines) > 1 and _TABLE_RULE.match(lines[1]):
            offset = 0
            for index, line in enumerate(lines):
                if index and _TABLE_ROW.match(line) and not _TABLE_RULE.match(line):
                    spans.append([offset, offset + len(line)])
                offset += len(line)
        elif not _FIGURE_ONLY.fullmatch(content):
            spans.append([0, len(content)])
        found += [Statement(start + left, start + right, body[start + left : start + right], block.id) for left, right in spans]
    return found


def _block_end(lines: list[str], at: int) -> int:
    """The index after the last line of the block that starts at `at`."""
    line = lines[at]
    if _FENCE.match(line):
        return _fence_end(lines, at)
    if (end := _maths_end(lines, at)) is not None:
        return end
    if _HEADING.match(line):
        return at + 1
    if _LIST_ITEM.match(line):
        return _list_end(lines, at)
    at += 1
    while at < len(lines) and lines[at].strip() and not _starts_a_block(lines, at):
        at += 1
    return at


def _starts_a_block(lines: list[str], at: int) -> bool:
    """Whether this line ends the paragraph above it without a blank line between."""
    line = lines[at]
    return bool(
        _FENCE.match(line) or _HEADING.match(line) or _ITEM_AFTER_TEXT.match(line)
    ) or _maths_end(lines, at) is not None


def _fence_end(lines: list[str], at: int) -> int:
    """A fence closes on a line of its own character, at least as long. Unclosed, it runs to the end."""
    opener = lines[at].lstrip()
    mark = opener[0]
    length = len(opener) - len(opener.lstrip(mark))
    for index in range(at + 1, len(lines)):
        closer = lines[index].strip()
        if len(closer) >= length and set(closer) == {mark}:
            return index + 1
    return len(lines)


def _maths_end(lines: list[str], at: int) -> int | None:
    """
    Where the display maths opening on this line ends, or None when the line
    opens none. Maths left unclosed is None as well: it is then a paragraph
    that ends at a blank line, not a block that swallows the rest of the page.
    """
    opener = lines[at].lstrip()
    if opener.startswith("$$"):
        closer, rest = "$$", opener[2:]
    elif opener.startswith("\\["):
        closer, rest = "\\]", opener[2:]
    elif begin := _BEGIN.match(opener):
        closer, rest = "\\end{" + begin.group(1) + "}", opener[begin.end() :]
    else:
        return None
    if closer in rest:
        return at + 1
    for index in range(at + 1, len(lines)):
        if closer in lines[index]:
            return index + 1
    return None


def _list_end(lines: list[str], at: int) -> int:
    """
    A list holds its nested items, its continuation paragraphs and any fenced
    code inside an item. After a blank line it goes on only into an indented
    line or another item.
    """
    at += 1
    while at < len(lines):
        line = lines[at]
        if not line.strip():
            after = at
            while after < len(lines) and not lines[after].strip():
                after += 1
            if after == len(lines) or not (
                lines[after].startswith(("  ", "\t")) or _LIST_ITEM.match(lines[after])
            ):
                return at
            at = after
        elif not line.startswith(("  ", "\t")) and (
            _FENCE.match(line) or _HEADING.match(line) or _maths_end(lines, at) is not None
        ):
            return at
        elif _FENCE.match(line.lstrip()):
            at = _fence_end(lines, at)
        else:
            at += 1
    return at
