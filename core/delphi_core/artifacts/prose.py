"""Assistant text for downstream prompts; never a rewrite of the saved answer."""

import json
import re

from markdown_it import MarkdownIt

_MARKDOWN = MarkdownIt("commonmark")
_INFO = re.compile(r"^delphi-artifact(?:[\t ]+(.*))?$")
_TITLE_MAX = 160


def assistant_prose(text: str) -> str:
    """Replace actual artifact code nodes before clipping or scanning citations.

    CommonMark distinguishes fences from inline mentions, HTML and examples
    nested in ordinary code fences. Source slices preserve all other text,
    including its line endings. Callers apply this only to assistant answers;
    user code and persisted/UI source are not projections. A title is context,
    not the old diagram's implementation or its current interactive state.
    """
    if "delphi-artifact" not in text:
        return text
    boundaries = [0, *(match.end() for match in re.finditer(r"\r\n|\r|\n", text))]
    if boundaries[-1] != len(text):
        boundaries.append(len(text))
    output: list[str] = []
    previous = 0
    for token in _MARKDOWN.parse(text):
        if token.type != "fence" or not token.map or not (info := _INFO.fullmatch(token.info)):
            continue
        start, end = (boundaries[line] for line in token.map)
        # Keep an opening list/quote prefix; the code node owns the rest of
        # these lines, not the surrounding paragraph or a neighbouring item.
        start += text[start:end].find(token.markup)
        metadata = (info[1] or "").strip()
        title = re.sub(r"""^title=(?:"([^"]*)"|'([^']*)')$""", r"\1\2", metadata)
        title = " ".join(re.sub(r"[\x00-\x1f\x7f]", "", title).split())[:_TITLE_MAX] or "Interactive visualization"
        newline = re.search(r"(?:\r\n|\r|\n)$", text[start:end])
        output.extend((text[previous:start],
                       f"[Visualization: {json.dumps(title, ensure_ascii=False)}; source and UI state omitted]",
                       newline[0] if newline else ""))
        previous = end
    return "".join((*output, text[previous:]))
