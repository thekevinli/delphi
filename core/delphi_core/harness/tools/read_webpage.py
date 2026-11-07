"""Read sections of a web document this turn loaded. It never fetches a page."""

from dataclasses import dataclass
from functools import partial

from pydantic import Field

from ...document_reads import document_result, read_webpage, resolve_account_webpage
from ..evidence import captured_document
from ..tool import BudgetClass, Tool, ToolArguments, ToolContext, ToolResult, TraceProjection

NAME = "read_webpage"


class Arguments(ToolArguments):
    # One schema in every profile: an outline gives these where a page is
    # attached, and a `search_library` hit where it is not.
    doc_id: str = Field(description="The page's doc_id (its paper_id), from its outline or a search_library hit.")
    anchor: str = Field(
        description=(
            "A section anchor from the outline or a search_library hit, or "
            "'all' to read the whole page when it is short."
        )
    )


@dataclass(frozen=True)
class Options:
    #: A captured outside source a digest or a page cites opens by its
    #: evidence id too. A maintenance run reads its event's document and no
    #: other, so it is offered the tool without that.
    captures: bool = True
    #: The account-wide chat reads any web page the reader holds, found where
    #: it is filed, as `read_paper` finds a PDF there. Nothing else does: a
    #: document question reads its project's pages, and a maintenance run one.
    account: bool = False


def tool(options: Options = Options()) -> Tool:
    return Tool(
        name=NAME,
        arguments=Arguments,
        description=(
            "Read one section of a web page in the reader's library, in whichever "
            "project it is filed, from the library's stored copy. Returns the full "
            "text of that section. Prefer several narrow reads over asking for the "
            "whole page."
            if options.account
            else "Read one section of an attached web document. Web documents arrive as "
            "an outline of section anchors; this returns the full text of one of "
            "them. Prefer several narrow reads over asking for the whole page."
        ),
        guidance=(
            (
                "A web page in the library is read by section, never whole: "
                "`read_webpage(doc_id, anchor)`, with the `paper_id` and anchor a "
                "`search_library` hit prints. Read the library's copy rather than "
                "fetching the page again from the web."
                if options.account
                else "A web page reaches you as an outline, never its text. Open the "
                "sections you need with `read_webpage(doc_id, anchor)` before relying "
                "on them; `doc_id` is the document's `paper_id`."
            )
            + (" A captured outside source a page cites opens the same way, by its evidence id." if options.captures else "")
        ),
        budget=BudgetClass.DOCUMENT,
        label="Reading the page",
        trace=TraceProjection(keep=(("doc_id", "paperId"), ("anchor", "anchor"))),
        run=partial(_run, options),
    )


async def _run(options: Options, args: Arguments, ctx: ToolContext) -> ToolResult:
    documents, titles = ctx.web_documents, ctx.titles
    if args.doc_id not in documents and options.account and not ctx.project_id:
        # Without a project the page has to be found where it is filed.
        found, named = await ctx.in_thread(
            resolve_account_webpage, ctx.storage, ctx.objects, ctx.username, args.doc_id
        )
        if found:
            documents, titles = found, named
    if args.doc_id not in documents and options.captures:
        # Not a document of this turn: it may be a captured outside source a
        # digest or a Memory page cites, which is read the same way.
        captured = await ctx.in_thread(
            captured_document, ctx.storage, ctx.objects, ctx.username, args.doc_id
        )
        if captured is not None:
            documents, titles = {args.doc_id: captured}, {args.doc_id: captured["title"]}
    text = await ctx.in_thread(
        read_webpage, args.doc_id, args.anchor, documents, titles,
        ctx.settings.webpage_read_max_chars,
    )
    served = (
        {"kind": "web", "title": titles.get(args.doc_id) or documents[args.doc_id].get("title")}
        if args.doc_id in documents
        else None
    )
    return ToolResult(text, document=document_result(served, args.doc_id))
