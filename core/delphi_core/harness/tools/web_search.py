"""Hosted web search. The provider runs it; Delphi offers it and records what it did."""

from ..tool import BudgetClass, Tool, TraceProjection

NAME = "web_search"


def tool() -> Tool:
    return Tool(
        name=NAME,
        # The provider's own tool: no domain filter and no location, so what it
        # may reach is the open web and what it is told is only the question.
        hosted_spec={"type": "web_search", "search_context_size": "medium"},
        # A hosted tool has no description field of ours, so this line is where
        # the rule for when to search is stated.
        guidance=(
            "Search the web when the answer depends on something the reader's "
            "documents and Memory cannot contain: something newer than them, work "
            "they cite but do not explain, a comparison with work outside the "
            "library, or a claim the answer rests on that you are unsure of. Do "
            "not search for what the open document or Memory already settles. Do "
            "not search when the reader asks for an answer from their own sources "
            "only; say what is missing instead. Prefer the primary source (the "
            "paper, the official documentation, the repository) to commentary. A "
            "few well-aimed searches are better than many broad ones."
        ),
        budget=BudgetClass.WEB,
        label="Searching the web",
        trace=TraceProjection(
            keep=(("query", "query"), ("action", "action"), ("url", "url"), ("pattern", "pattern"))
        ),
        item_type="web_search_call",
        # The addresses a search consulted, which the trace lists.
        include=("web_search_call.action.sources",),
    )
