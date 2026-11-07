"""
The parts of a page write that the write tools and the domain composer's answer take, said once.

A provider's strict schema has no optional argument and no free-form key, so
every field here is always sent and has a fixed shape: an empty string, a zero
or an empty list is how a call says "none". `stored` turns each back into the
mapping the edit engine reads (`memory_maintenance.ops`), with None for none.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from ..memory_maintenance.validate import REASONS
from .tool import ToolArguments


class Citation(ToolArguments):
    """New evidence the text cites. Give only the fields its claimType takes; leave the others empty."""

    ref: str = Field(description="N1, N2, …: the text cites it as [N1].")
    claimType: Literal["author-claim", "external", "derived", "reader-note"] = Field(
        description=(
            "author-claim: what a document says (paperId, with page for a PDF or section for a "
            "saved page). external: what a captured outside source says (evidenceId and section). "
            "reader-note: the reader's own note (paperId and noteId). derived: your own inference "
            "or arithmetic, which names no source."
        )
    )
    paperId: str = Field(description="A document id from the evidence, or an empty string.")
    page: int = Field(description="The page of a PDF, counted from 1, or 0.")
    section: str = Field(description="A section anchor from the evidence, or an empty string.")
    noteId: str = Field(description="A note id from the evidence, or an empty string.")
    evidenceId: str = Field(description="An outside source's id from the evidence, or an empty string.")

    def stored(self) -> dict[str, Any]:
        return {name: value or None for name, value in self.model_dump().items()}


class CalculationInput(ToolArguments):
    name: str = Field(description="One word, as the expression uses it, such as d_model.")
    value: float
    unit: str = Field(description="The unit, or an empty string for a pure number.")
    citation: str = Field(description="Where the number comes from: N1 for a new citation, E3 for one the page has.")


class Calculation(ToolArguments):
    """A number you derived, to be recomputed. A number a source reports is cited, not listed here."""

    expression: str = Field(description="Arithmetic over the named inputs: + - * / ** and parentheses.")
    inputs: list[CalculationInput]
    result: float = Field(description="The result as the text states it.")
    unit: str = Field(description="The result's unit, or an empty string.")


class Operation(ToolArguments):
    """One change. Fill the fields its `op` uses and leave the rest empty."""

    op: Literal["insert_after", "replace", "delete", "replace_text"] = Field(
        description=(
            "insert_after: put `markdown` after `block`. replace: put `markdown` in place of "
            "`blocks`, one block or an unbroken run. delete: remove `blocks`. replace_text: in "
            "`block`, change `find`, which must occur exactly once there, to `with`."
        )
    )
    block: str = Field(description='A block label such as b14, or "start" to insert before the first block.')
    blocks: list[str] = Field(description="Block labels, for replace and delete.")
    markdown: str = Field(description="The new Markdown, without block labels. New evidence is cited as [N1].")
    find: str = Field(description="For replace_text: the exact text to change.")
    with_: str = Field(alias="with", description="For replace_text: what to put in its place.")
    reason: Literal["", *REASONS] = Field(
        description=(
            "Why text is removed. Required for a delete, and for a replace that drops a citation "
            "or a [[link]]; otherwise an empty string. `moved` means the same text is inserted "
            "elsewhere in this call."
        )
    )
    evidence: list[str] = Field(
        description="For superseded and contradicted: the citations that show it, such as N2 or E3."
    )

    def stored(self) -> dict[str, Any]:
        blocks = self.blocks or ([self.block] if self.block else [])
        block = self.block or (self.blocks[0] if len(self.blocks) == 1 else "")
        if self.op == "insert_after":
            return {"op": self.op, "block": block, "markdown": self.markdown}
        if self.op == "replace_text":
            return {"op": self.op, "block": block, "find": self.find, "with": self.with_}
        made = {"op": self.op, "blocks": blocks, "evidence": self.evidence}
        if self.reason:
            made["reason"] = self.reason
        return {**made, "markdown": self.markdown} if self.op == "replace" else made


def stored(items: list[Any]) -> list[dict[str, Any]]:
    """Parsed citations or calculations, as the mappings the edit engine reads."""
    return [item.stored() if isinstance(item, Citation | Operation) else item.model_dump() for item in items]
