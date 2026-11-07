"""A conservative line gate in front of visible text and its trace offsets.

Only server-minted standalone references can introduce executable fences. Every
authored spelling of the reserved marker is removed, including inside quoted
or nested examples. CommonMark owns a published reference's block context;
delimiter guesses cannot distinguish a list's closing fence from a new one.
Literal prose streams progressively; ambiguous Markdown stays line-buffered.
An unfinished line is bounded; a failed stream retains plain prose but never
an unfinished fence or reference. Only model line endings are normalized.
"""

import html
import re

from markdown_it import MarkdownIt

from .session import ArtifactSession
from .types import SOURCE_MAX

REFERENCE = re.compile(r" {0,3}\[\[delphi-artifact:(a_[a-f0-9]{16}):([1-9]\d{0,2})\]\]\s*$")
CONTAINER_FENCE = re.compile(r"^(?: {0,3}(?:> ?|(?:[-+*]|\d{1,9}[.)]) ))* {0,3}(`{3,}|~{3,})(.*)$")
FALLBACK = "The visualization could not be validated, so it is not included.\n"
DELIVERY_FALLBACK = "A visualization passed rendering checks but was not included because its delivery reference was missing or unusable.\n"
REFERENCE_FALLBACK = "An invalid or repeated visualization reference was omitted.\n"
PREFIX_MAX = 4 * SOURCE_MAX
REFERENCE_CHECKS_MAX = 2
RESERVED = "delphi-artifact"
_MARKDOWN = MarkdownIt("commonmark")
_PROSE_START = re.compile(r"^(?: {0,3}(?:> ?|(?:[-+*]|\d{1,9}[.)]) ))* {0,3}(?:\#{1,6} +)?[*_]*[^\W\d_]", re.UNICODE)
_ENTITY = re.compile(r"&(?:\#[0-9]+;?|\#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)")
_ENTITY_TAIL = re.compile(r"&(?:\#(?:[0-9]*|[xX][0-9a-fA-F]*)|[A-Za-z0-9]*)$")
_ESCAPE = re.compile(r"\\([^\w\s])")


def _decoded(line: str) -> str:
    # CommonMark unescapes punctuation and entities in fence info strings.
    # Repeating entity decoding is deliberately more conservative than it.
    for _ in range(3):
        line = html.unescape(line)
    return _ESCAPE.sub(r"\1", line).lower()


def _safe_prefix_end(text: str) -> int:
    """Hold only a possible marker/unfinished escape, not the whole paragraph.

    Decoded characters retain their raw offsets, so an encoded marker prefix
    is withheld in full while ordinary entities and LaTeX keep streaming.
    The same three decoding passes as `_decoded` cover nested entities.
    """
    end = len(text)
    if "&" not in text and "\\" not in text:
        lowered = text.lower()
        for length in range(min(len(text), len(RESERVED) - 1), 0, -1):
            if lowered.endswith(RESERVED[:length]):
                return end - length
        return end
    decoded, offsets = text, list(range(len(text)))
    for _ in range(3):
        if "&" not in decoded:
            break
        if tail := _ENTITY_TAIL.search(decoded):
            end = min(end, offsets[tail.start()])
        pieces, mapped, previous = [], [], 0
        for match in _ENTITY.finditer(decoded):
            replacement = html.unescape(match[0])
            pieces.extend((decoded[previous:match.start()], replacement))
            mapped.extend(offsets[previous:match.start()])
            mapped.extend([offsets[match.start()]] * len(replacement))
            previous = match.end()
        pieces.append(decoded[previous:])
        mapped.extend(offsets[previous:])
        decoded, offsets = "".join(pieces), mapped
    if decoded.endswith("\\"):
        end = min(end, offsets[-1])
    pieces, mapped, previous = [], [], 0
    for match in _ESCAPE.finditer(decoded):
        pieces.extend((decoded[previous:match.start()], match[1]))
        mapped.extend(offsets[previous:match.start()])
        mapped.append(offsets[match.start()])
        previous = match.end()
    pieces.append(decoded[previous:])
    mapped.extend(offsets[previous:])
    decoded = "".join(pieces)
    # Stop before an incomplete entity/escape even if one decoding pass could
    # already interpret it: the next chunk can extend a numeric character ref.
    prefix = [(char.lower(), offset) for char, offset in zip(decoded, mapped) if offset < end]
    lowered = "".join(char for char, _ in prefix)
    for length in range(min(len(prefix), len(RESERVED) - 1), 0, -1):
        if lowered.endswith(RESERVED[:length]):
            end = prefix[-length][1]
            break
    return end


class Delivery:
    def __init__(self, session: ArtifactSession) -> None:
        self.session = session
        self.pending = ""
        self.blocked_fence = ""
        self.blocked = False
        self.discard_line = False
        self.prose = False
        self.line_visible = False
        self.after_cr = False
        self.emitted: list[str] = []
        self.emitted_chars = 0
        self.prefix_overflow = False
        self.reference_checks = 0

    def _remember(self, text: str) -> str:
        if not self.prefix_overflow:
            self.emitted_chars += len(text)
            if self.emitted_chars > PREFIX_MAX:
                self.prefix_overflow = True
                self.emitted.clear()
            else:
                self.emitted.append(text)
        return text

    def _prose_reference(self, line: str) -> bool:
        # Only the at-most-two eligible published references reach this parse.
        # A large answer keeps streaming, but cannot spend unbounded memory or
        # parser work trying to introduce a visualization near its end.
        if self.prefix_overflow or self.reference_checks >= REFERENCE_CHECKS_MAX:
            return False
        self.reference_checks += 1
        prefix = "".join(self.emitted)
        # Released HTML remains exact, including CR-only lines. CommonMark
        # normalizes those internally, so its line map must count them too.
        reference_line = prefix.count("\n") + prefix.count("\r") - prefix.count("\r\n")
        tokens = _MARKDOWN.parse(prefix + line)
        return any(token.type == "inline" and token.level == 1 and token.map
                   and token.map[0] <= reference_line < token.map[1]
                   for token in tokens)

    def push(self, text: str) -> list[str]:
        if not text:
            return []
        if self.after_cr and text.startswith("\n"):
            text = text[1:]
        self.after_cr = text.endswith("\r")
        # A split CRLF is one boundary; a bare CR is also a boundary. Never
        # normalize the server-released source, which bypasses this input path.
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        self.pending += text
        output: list[str] = []
        while "\n" in self.pending:
            line, self.pending = self.pending.split("\n", 1)
            visible = "" if self.discard_line else self._line(line + "\n", prose=self.prose)
            if not visible and self.line_visible:
                # A forbidden tail cannot retract harmless text already sent.
                # Keep its boundary so the next reference is still standalone.
                visible = "\n"
            if visible:
                output.append(self._remember(visible))
            self.discard_line = self.prose = self.line_visible = False
        if visible := self._progress():
            output.append(self._remember(visible))
        if len(self.pending) > SOURCE_MAX:
            self.pending = ""
            self.discard_line = self.blocked = True
        return output

    def _progress(self) -> str:
        if self.blocked_fence or self.discard_line:
            return ""
        if not self.prose:
            # Start once real text follows ordinary Markdown decoration. A
            # bare container/fence/reference or indented code stays buffered.
            self.prose = _PROSE_START.match(self.pending) is not None
        if not self.prose:
            return ""
        if RESERVED in _decoded(self.pending):
            self.pending = ""
            self.discard_line = self.blocked = True
            return ""
        end = _safe_prefix_end(self.pending)
        visible, self.pending = self.pending[:end], self.pending[end:]
        self.line_visible |= bool(visible)
        return visible

    def _line(self, line: str, *, prose: bool = False) -> str:
        decoded = _decoded(line)
        if self.blocked_fence:
            closing = CONTAINER_FENCE.match(decoded.rstrip("\r\n"))
            if closing and not closing[2].strip() and closing[1][0] == self.blocked_fence[0] and len(closing[1]) >= len(self.blocked_fence):
                self.blocked_fence = ""
            return ""
        match = None if prose else REFERENCE.fullmatch(line)
        if match:
            draft = self.session.drafts.get(match[1])
            eligible = draft and draft.published and not draft.delivered and draft.revision == int(match[2])
            if eligible and self._prose_reference(line):
                released = self.session.release(match[1], int(match[2]))
                if released:
                    return "\n" + released + "\n"
            self.blocked = True
            return ""
        if RESERVED in decoded:
            self.blocked = True
            opening = None if prose else CONTAINER_FENCE.match(decoded.rstrip("\r\n"))
            if opening:
                self.blocked_fence = opening[1]
            return ""
        return line

    def finish(self, *, completed: bool) -> list[str]:
        output = []
        decoded = _decoded(self.pending)
        safe_partial = not CONTAINER_FENCE.match(decoded) and "delphi-art" not in decoded and "[[" not in decoded
        if (completed or safe_partial) and self.pending and not self.discard_line:
            # A completed final line may itself be a valid published reference.
            # Let the normal gate decide before declaring it withheld; marking
            # it blocked here adds a failure notice after a successful release.
            if visible := self._line(self.pending, prose=self.prose):
                output.append(self._remember(visible))
        elif RESERVED in decoded:
            self.blocked = True
        self.pending = ""
        if self.blocked or (self.session.attempted and not any(draft.delivered for draft in self.session.drafts.values())):
            published = [draft for draft in self.session.drafts.values() if draft.published]
            notice = DELIVERY_FALLBACK if any(not draft.delivered for draft in published) else REFERENCE_FALLBACK if published else FALLBACK
            output.append("\n\n" + notice)
        return output
