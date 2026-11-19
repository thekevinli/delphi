"""
Hand the next run of a document's filing what this run had no room for.

Each item names the digest evidence it rests on, as the brief shows its lines
(`E7`), and the names are the schema's enum: a run is offered the tool built
for its own digest (`Options.evidence`), so a line the digest does not have is
unsayable rather than refused (invariant 36b). A digest with no line to name
gives an item no `evidence` field at all, rather than every line. What the
next run is handed is a typed list (`staging.LeftItem`), never prose to parse.
"""

import functools
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import Field, create_model

from ...memory_maintenance.staging import LEFT_MAX_ITEMS, LeftItem
from ..tool import BudgetClass, Tool, ToolArguments, ToolContext, ToolResult, TraceProjection

NAME = "leave_for_later"

#: Every line a digest may index (`research_digest.DigestCitation.id`): the
#: catalogue's schema, before a run names its own digest's lines.
_ANY_LINE = tuple(range(1, 100))
#: How many of the lines still unaccounted for a call's answer names.
_SHOWN_LINES = 12


@dataclass(frozen=True)
class Options:
    #: The ids of the lines of this run's digest evidence index: what an item may
    #: name. None is the catalogue's tool, before any run names its digest; empty
    #: is a digest with no line to name.
    evidence: tuple[int, ...] | None = None


@functools.lru_cache(maxsize=256)
def _arguments(lines: tuple[int, ...]) -> type[ToolArguments]:
    """The arguments for a digest with these lines, one class per set of lines."""
    fields: dict[str, Any] = {
        "target": (str, Field(description="The slug of an existing page to change, or the title of a page to create.")),
        "what": (str, Field(description="One or two sentences: what the page should get from those lines.")),
    }
    if lines:
        line = Literal[tuple(f"E{number}" for number in lines)]  # type: ignore[valid-type]
        fields["evidence"] = (list[line], Field(  # type: ignore[valid-type]
            min_length=1, description="The digest evidence lines it rests on, as the brief names them (E7).",
        ))
    item: Any = create_model("_Item", __base__=ToolArguments, **fields)
    return create_model(
        "Arguments", __base__=ToolArguments,
        items=(list[item], Field(description="Everything that should still change, most important first.",
                                 max_length=LEFT_MAX_ITEMS)),
    )


Arguments = _arguments(_ANY_LINE)


def tool(options: Options = Options()) -> Tool:
    return Tool(
        name=NAME,
        arguments=_arguments(_ANY_LINE if options.evidence is None else tuple(sorted(set(options.evidence)))),
        description=(
            "Hand what this run had no room for to the next run of this document's filing, each item "
            "with the digest evidence lines it rests on. That run starts from this list, with the pages "
            "it names open. A second call replaces the first, so it repeats every item still wanted; an "
            "empty list hands nothing on. The answer names the lines still on no page and not handed on."
        ),
        guidance=(
            "`leave_for_later(items)` hands the next run of this document what should still change "
            "once this run's pages are staged: each page or new idea, what it should get and the "
            "digest lines it rests on. Call it before you finish whenever `<unfiled_evidence>` holds "
            "more worth a page than this run may write."
        ),
        budget=BudgetClass.HANDOFF,
        label="Noting what is left for a later pass",
        trace=TraceProjection(),
        run=_run,
        needs=("draft",),
    )


async def _run(args: Any, ctx: ToolContext) -> ToolResult:
    # `args` is an instance of this run's `_arguments(...)`, whose class is made per digest.
    draft = ctx.draft
    items = tuple(
        LeftItem(
            " ".join(item.target.split()), " ".join(item.what.split()),
            tuple(dict.fromkeys(int(name[1:]) for name in getattr(item, "evidence", ()))),
        )
        for item in args.items if item.target.strip()
    )
    draft.handed_on = tuple({item.target: item for item in items}.values())
    if not draft.handed_on:
        return ToolResult("Nothing is handed on: no later run will be queued for this list.")
    named = ", ".join(f"`{item.target}`" for item in draft.handed_on)
    left = draft.unaccounted()
    if not left:
        return ToolResult(
            f"Handed on to the next run of this document: {named}. Every line of the digest's evidence is on "
            "a page, staged or handed on. Finish when what you staged is done."
        )
    more = f"\n…and {len(left) - _SHOWN_LINES} more." if len(left) > _SHOWN_LINES else ""
    return ToolResult(
        f"Handed on to the next run of this document: {named}. These lines are on no page, staged or "
        "stored, and nothing handed on names them:\n"
        + "\n".join(line.shown() for line in left[:_SHOWN_LINES]) + more
        + "\nAdd to this list what of them is worth a page, calling again with every item, or finish."
    )
