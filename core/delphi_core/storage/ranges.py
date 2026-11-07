"""
Byte-range parsing for the PDF route.

Starlette's `FileResponse` handles ranges for a real file, but the deployed
object store hands back a stream, so this has to be done explicitly. pdf.js
depends on ranges to render the first page of a 30 MB paper without pulling the
whole file, which is why this exists at all.

Only the single-range forms are supported. Multi-range requests are answered
with the whole object, which is a legal response and one no PDF viewer asks for.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class ByteRange:
    start: int
    end: int  # inclusive

    @property
    def length(self) -> int:
        return self.end - self.start + 1

    def content_range(self, size: int) -> str:
        return f"bytes {self.start}-{self.end}/{size}"


class UnsatisfiableRange(Exception):
    """The request named a range that lies outside the object."""


def parse_range(header: str | None, size: int) -> ByteRange | None:
    """
    Resolve a Range header against a known object size.

    Returns None when the whole object should be sent — no header, a unit we do
    not speak, or a syntactically unusable value. Raises `UnsatisfiableRange`
    only when the client asked for a well-formed range that does not exist,
    which is the one case owed a 416.
    """
    if not header or size <= 0:
        return None
    unit, _, spec = header.partition("=")
    if unit.strip().lower() != "bytes" or not spec:
        return None
    # A comma means multiple ranges; serve the whole object instead.
    if "," in spec:
        return None

    first, sep, last = spec.strip().partition("-")
    if not sep:
        return None

    try:
        if not first:
            # Suffix form: the final N bytes.
            suffix = int(last)
            if suffix <= 0:
                raise UnsatisfiableRange(header)
            start = max(0, size - suffix)
            end = size - 1
        else:
            start = int(first)
            end = int(last) if last else size - 1
    except ValueError:
        return None

    if start >= size or start < 0 or end < start:
        raise UnsatisfiableRange(header)
    return ByteRange(start, min(end, size - 1))
