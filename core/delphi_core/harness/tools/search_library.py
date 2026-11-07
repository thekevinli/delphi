"""Find which stored document holds something, and where. Pointers, never text."""

from dataclasses import dataclass
from functools import partial
from typing import Literal

from pydantic import Field

from ...document_reads import search_library
from ..tool import BudgetClass, Tool, ToolArguments, ToolContext, ToolResult, TraceProjection

NAME = "search_library"


@dataclass(frozen=True)
class Options:
    #: Where a search may look is the conversation's, not the model's to choose.
    #: A question beside a project is answered from that project and reaches
    #: the rest of the account only through Memory; Memory chat is the
    #: account's, and its search covers every project. A maintenance run reads
    #: one document, the one its event is about, and searches only that.
    scope: Literal["project", "account", "document"] = "project"


class Arguments(ToolArguments):
    query: str = Field(
        max_length=200,
        description=(
            "Words as the authors would have written them. The search is lexical, "
            "not semantic, so prefer the technical term over a paraphrase of it."
        ),
    )


_DESCRIPTION = {
    "project": (
        "Find which document in this project discusses something, and where. "
        "Searches the extracted text of every document in the project and "
        "returns paper ids, page numbers or section anchors, and matching "
        "snippets. Use it when the digests do not tell you where the evidence "
        "is. Each hit names the call that opens it, or says that this "
        "conversation cannot open it."
    ),
    "account": (
        "Find which stored documents discuss something, before opening any of "
        "them. Searches the extracted text of every document in every project "
        "of this reader's library and returns paper ids, page numbers or "
        "section anchors, and matching snippets. Use it whenever you do not "
        "already know where the evidence is. Each hit names the call that "
        "opens it, or says that this conversation cannot open it."
    ),
    "document": (
        "Find where in the document this event is about something is printed. "
        "Searches that document's extracted text and returns page numbers or "
        "section anchors with matching snippets, never the text itself. Use it "
        "when the digest does not say where something is, or says a page that "
        "does not hold it."
    ),
}
_GUIDANCE = {
    "project": (
        "`search_library(query)` finds which document in this project, and "
        "which page or section, holds something when the digests do not tell "
        "you. It matches words, not meaning. Each hit names the call that "
        "opens it."
    ),
    "account": (
        "`search_library(query)` finds which document anywhere in the reader's "
        "library, and which page or section, holds something. It matches "
        "words, not meaning. Each hit names the call that opens it."
    ),
    "document": (
        "`search_library(query)` finds which page or section of the event's "
        "document prints something. It matches words, not meaning: search for "
        "a number or the authors' own term. Each hit names the call that opens it."
    ),
}


def tool(options: Options = Options()) -> Tool:
    return Tool(
        name=NAME,
        arguments=Arguments,
        description=_DESCRIPTION[options.scope],
        guidance=_GUIDANCE[options.scope],
        budget=BudgetClass.DOCUMENT,
        label="Searching the document" if options.scope == "document" else "Searching your library",
        trace=TraceProjection(keep=(("query", "query"),)),
        run=partial(_run, options),
        needs=("storage",),
    )


async def _run(options: Options, args: Arguments, ctx: ToolContext) -> ToolResult:
    readable = [*ctx.paper_documents, *ctx.web_documents]
    if options.scope == "document" and len(readable) != 1:
        return ToolResult("Error: this run has no document to search.")
    text = await ctx.in_thread(
        lambda: search_library(
            args.query, ctx.storage, ctx.username,
            # Never the model's choice, and never inferred: the profile says.
            ctx.project_id if options.scope != "account" else "",
            ctx.settings,
            offered=ctx.offered,
            # A request with no project reads any web page and any PDF the
            # account holds (`read_webpage`, `read_paper`).
            web_ids=frozenset(ctx.web_documents) if ctx.project_id else None,
            attached_pdf_ids=ctx.attached_pdf_ids,
            pdf_ids=frozenset(ctx.paper_documents) if ctx.project_id else None,
            paper_id=readable[0] if options.scope == "document" else "",
        )
    )
    return ToolResult(text)
