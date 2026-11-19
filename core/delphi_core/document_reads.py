"""
What a model may read from the reader's documents, and how each read answers.

Three reads, and the discovery that precedes them: exact pages of a stored PDF,
sections of a web snapshot, and a search that says which document holds
something and where. They are the work behind the `read_paper`,
`read_webpage` and `search_library` tools (`harness/tools/`), kept here so a
route or a job can make the same read without going through a model.

Every failure is prose, never an exception (invariant 15): "no such anchor,
here are the ones that exist" lets the model correct itself on its next round,
while a raise would take the answer down with it.
"""

import json
from typing import Any

from fastapi import HTTPException

from .config import Settings
from .document_index import PAGE_MARKER
from .storage import ObjectStore, Storage, is_web, paper_key


def asked_document(arguments: str) -> str:
    """The document a call names, by either of the names the reading tools use."""
    try:
        asked = json.loads(arguments or "{}")
    except json.JSONDecodeError:
        return ""
    if not isinstance(asked, dict):
        return ""
    return str(asked.get("paper_id") or asked.get("doc_id") or "")


def document_kind(paper: dict[str, Any]) -> str:
    return "web-page" if is_web(paper) else "pdf"


def read_result_header(paper_id: str, title: str, kind: str, what: str) -> str:
    """
    The first line of anything a reading tool returns: whose text follows.

    A dozen reads in, a section is only as attributable as its own first line.
    The id is the one the project library and `<open_document>` use, so a read
    can be matched to its document without the title having to be unique.
    """
    detail = f" · {what}" if what else ""
    return f'From "{title}" (paper_id {paper_id} · {kind}{detail}):\n\n'


def read_webpage(
    doc_id: str,
    anchor: str,
    web_documents: dict[str, dict[str, Any]],
    titles: dict[str, str],
    max_chars: int,
) -> str:
    """
    Serve one section of a snapshot back to the model.

    Every failure here returns prose rather than raising. A tool that errors
    mid-stream would take the whole answer down; a tool that says "no such
    anchor, here are the ones that exist" lets the model correct itself on the
    next turn, which is the behaviour we actually want.
    """
    anchor = anchor.strip().lstrip("#§")
    document = web_documents.get(doc_id)
    if document is None:
        available = ", ".join(f"{key} ({titles.get(key, '?')})" for key in web_documents)
        return (
            f"Error: no web document with doc_id {doc_id!r} is attached to this "
            f"question. Attached: {available or 'none'}."
        )

    sections = document["sections"]
    title = titles.get(doc_id, document.get("title", "the page"))
    if anchor.lower() == "all":
        chosen = sections
    else:
        needle = anchor.lower()
        chosen = [item for item in sections if item["anchor"].lower() == needle]
        if not chosen:
            chosen = [
                item
                for item in sections
                if item["anchor"].lower().startswith(needle)
                or needle in item["title"].lower()
            ]
        if not chosen:
            return (
                f"Error: {title!r} has no section {anchor!r}. Its anchors are: "
                + ", ".join(item["anchor"] for item in sections)
                + "."
            )

    parts = [
        f"§{item['anchor']} — {item['title']}\n\n{item['markdown']}" for item in chosen
    ]
    body = "\n\n".join(parts)
    if len(body) > max_chars:
        body = (
            body[:max_chars]
            + "\n\n…[truncated. Call read_webpage again with a narrower anchor.]"
        )
    return (
        read_result_header(doc_id, title, "web page", document.get("url", ""))
        + body
    )


#: Hits a search of one document returns: a few hundred tokens, against tens of thousands for the document.
DOCUMENT_SEARCH_HITS = 5


def search_library(
    query: str,
    storage: Storage,
    username: str,
    project_id: str,
    settings: Settings,
    *,
    offered: frozenset[str] = frozenset(),
    web_ids: frozenset[str] | None = frozenset(),
    pdf_ids: frozenset[str] | None = frozenset(),
    attached_pdf_ids: frozenset[str] = frozenset(),
    paper_id: str = "",
) -> str:
    """
    Answer the discovery half of the reading tools.

    Returns pointers, never prose: paper id, locator, and a snippet showing why
    it matched. The model then descends one more rung with `read_paper` or
    `read_webpage`, which is what keeps a thirty-document question affordable —
    a search costs a few hundred tokens; loading the corpus costs everything.

    A hit is printed with the call that opens it only when this conversation
    can make that call: the tool is in `offered` and the document is one it
    reads (`web_ids` and `pdf_ids`, where None means any such document in the
    account). A
    search reaches further than a read does, and a hit that names a call which
    will be refused costs a round and teaches the model nothing.

    A hit in a PDF the request carries whole (`attached_pdf_ids`) is neither:
    there is nothing to open, and saying it cannot be opened would tell the
    model not to quote the document it is holding.
    """
    query = query.strip()
    if not query:
        return "Error: a library search needs a query."
    # A conversation asked beside a project searches that project; one with
    # no project searches the account; a reader of one document, only that
    # document. Never the model's choice.
    scope = "document" if paper_id else "project" if project_id else "account"
    where = {"document": "in this document", "project": "in this project", "account": "across the whole library"}[scope]
    try:
        hits = storage.search_documents(
            username,
            query,
            project_id=project_id or None,
            # In one document the first few hits are the pages that matter.
            limit=min(settings.library_tool_max_results, DOCUMENT_SEARCH_HITS) if paper_id else settings.library_tool_max_results,
            **({"paper_id": paper_id} if paper_id else {}),
        )
    except HTTPException as error:
        return f"Error: {error.detail}"
    if not hits:
        return (
            f"No stored document matches {query!r}"
            + {"document": " in this document.", "project": " in this project.", "account": " in this library."}[scope]
            + " Try fewer or more general words; the search is lexical, so it "
            "matches the authors' vocabulary rather than the meaning."
        )
    lines = [f"{len(hits)} match(es) for {query!r} {where}:"]
    unopened = False
    for hit in hits:
        if hit["kind"] == "section":
            opens = "read_webpage" in offered and (
                web_ids is None or hit["paperId"] in web_ids
            )
            call = f'read_webpage(doc_id="{hit["paperId"]}", anchor="{hit["locator"]}")'
        else:
            opens = "read_paper" in offered and (
                pdf_ids is None or hit["paperId"] in pdf_ids
            )
            call = f'read_paper(paper_id="{hit["paperId"]}", pages=[{hit["locator"]}])'
        attached = hit["kind"] != "section" and hit["paperId"] in attached_pdf_ids
        unopened = unopened or not (opens or attached)
        if scope == "document":
            # One document: its title and project would only repeat on every hit.
            lines.append(f"\n· {hit['locatorLabel']}: {hit['snippet'][: settings.library_tool_snippet_chars]}\n  Open with: {call}")
            continue
        lines.append(
            f'\n· "{hit["paperTitle"]}" — {hit["locatorLabel"]} '
            f'(project "{hit["projectName"]}"'
            + (", finished" if hit.get("done") else "")
            + f")\n  {hit['snippet'][: settings.library_tool_snippet_chars]}\n  "
            + (
                "Already here: this PDF is attached whole. Read that page of it."
                if attached
                else f"Open with: {call}"
                if opens
                else "Cannot be opened from this conversation."
            )
        )
    if unopened:
        lines.append(
            "\nA hit that cannot be opened tells the reader where to look. Say "
            "which document and project it is in rather than quoting it as if "
            "you had read it."
        )
    return "\n".join(lines)


def resolve_account_paper(
    storage: Storage | None, username: str, paper_id: str
) -> tuple[str, dict[str, dict[str, Any]]]:
    """
    Find which project holds a PDF, for a request that is not scoped to one.

    A scan over the account's projects rather than an index: the Memory chat
    is the only caller, it reads at most a handful of documents per answer, and
    an index here would be a second thing that can disagree with the record.
    Returns the project and a one-entry manifest, so `read_paper` still refuses
    anything it was not handed.
    """
    if not storage or not paper_id:
        return "", {}
    for summary in storage.list_projects(username):
        project = storage.get_project(username, summary["id"])
        for paper in project.get("papers", []):
            if paper["id"] == paper_id and not is_web(paper):
                return project["id"], {paper_id: paper}
    return "", {}


def resolve_account_webpage(
    storage: Storage | None,
    objects: ObjectStore | None,
    username: str,
    doc_id: str,
) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    """
    Find and load a web document anywhere in the account, for a request that
    is not scoped to one project: `resolve_account_paper`'s twin.

    Without it the Memory chat could read every PDF the reader holds and none
    of their web pages. Its `search_library` found the page, printed that it
    could not be opened, and the model read the public original instead and
    cited the open web for a page in the library. Returns a one-entry manifest
    and its title, so `read_webpage` still refuses anything it was not handed;
    a snapshot that cannot be read is no document, never an exception.
    """
    if not storage or not objects or not doc_id:
        return {}, {}
    for summary in storage.list_projects(username):
        project = storage.get_project(username, summary["id"])
        for paper in project.get("papers", []):
            if paper["id"] != doc_id or not is_web(paper):
                continue
            try:
                document = json.loads(objects.get_text(paper_key(username, project["id"], doc_id, "web")))
            except Exception:
                return {}, {}
            return {doc_id: document}, {doc_id: paper.get("title") or document.get("title") or ""}
    return {}, {}


def read_paper(
    paper_id: str,
    pages: list[int],
    objects: ObjectStore,
    username: str,
    project_id: str,
    papers: dict[str, dict[str, Any]],
    max_pages: int,
    max_chars: int,
) -> str:
    """Return exact stored page text; every invalid target becomes corrective prose."""
    paper = papers.get(paper_id)
    if paper is None:
        available = ", ".join(
            f"{item_id} ({item.get('title', '?')})" for item_id, item in papers.items()
        )
        return (
            f"Error: no PDF with paper_id {paper_id!r} is attached to this project "
            f"question. Available PDFs: {available or 'none'}."
        )
    if (
        not isinstance(pages, list)
        or not pages
        or len(pages) > max_pages
        or any(not isinstance(page, int) for page in pages)
    ):
        return f"Error: pages must contain one to {max_pages} integer page numbers."
    ordered = list(dict.fromkeys(pages))
    invalid = [page for page in ordered if not 1 <= page <= paper["pages"]]
    if invalid:
        return (
            f"Error: {paper['title']!r} has pages 1–{paper['pages']}; "
            f"invalid request: {invalid}."
        )
    try:
        raw = objects.get_text(
            paper_key(username, project_id, paper_id, "txt")
        )
    except Exception as exc:
        return f"Error: exact text for {paper['title']!r} is unavailable: {exc}"
    by_page = {
        int(match.group("page")): match.group("text").strip()
        for match in PAGE_MARKER.finditer(raw)
    }
    missing = [page for page in ordered if page not in by_page]
    if missing:
        return (
            f"Error: stored text for {paper['title']!r} has no page markers for "
            f"{missing}."
        )
    body = "\n\n".join(
        f"--- Page {page} ---\n\n{by_page[page]}" for page in ordered
    )
    if len(body) > max_chars:
        body = (
            body[:max_chars]
            + "\n\n…[truncated. Request fewer pages or a different page range.]"
        )
    return (
        read_result_header(
            paper_id,
            paper["title"],
            "PDF",
            "exact stored text of page"
            + ("s " if len(ordered) > 1 else " ")
            + ", ".join(str(page) for page in ordered),
        )
        + body
    )


def document_result(paper: dict[str, Any] | None, paper_id: str) -> list[dict[str, Any]]:
    """The document a read opened, as the trace lists it."""
    if not paper:
        return []
    return [
        {
            "paperId": paper_id,
            "title": paper.get("title") or "Untitled paper",
            "kind": document_kind(paper),
        }
    ]
