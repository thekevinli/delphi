"""
What is wrong with the wiki's shape — computed, never narrated.

Sibling of `answer_trace.py` and the same charter, applied to a different
disclosure. A health finding Delphi can compute is computed here, from the
pages, the figure rows and the newest filing events; the model is asked only for
what only it can see, which is what two pages *mean* when they disagree.

The reason is recorded rather than aesthetic. The one lint bug this repository
has on record was a model handed a mislabelled input — the unresolved half of
the link graph under a heading that said "link graph" — concluding, honestly
and wrongly, that every page in the base was an orphan. Orphan-hood is
`linkDegree == 0`. Every listing already carries it. Nothing about that
question needs a language model, and asking one for it buys a number that
cannot be checked.

Split, then, along what is checkable:

* **orphans, uncaptured figures, dropped targets** — arithmetic
  over records. Always live, no provider needed, correct before anyone presses
  anything.
* **contradictions** — real judgement about content. Those stay in
  `lint_memory`, arrive on the lint event, and are stamped with when they
  last ran, because "none found" and "never looked" are different facts. Lint
  reports them and queues a `reconcile` job for each; it writes no page.

`lint_memory` calls this once and uses it twice — as the model's input and
as the event's record — which is why none of it is re-implemented in the
browser.
"""

from collections.abc import Mapping
from typing import Any

from .config import Settings
from .memory_maintenance.jobs import DOCUMENT, document_marker, read_marker
from .storage import Storage, utc_now


def build_memory_health(
    storage: Storage, username: str, *, settings: Settings
) -> dict[str, Any]:
    """
    The deterministic half of a health check, in three reads.
    """
    pages = storage.list_memory_pages(username, limit=settings.memory_max_pages)
    figures = storage.list_memory_figures(username)
    return {
        "pages": len(pages),
        "computedAt": utc_now(),
        "orphans": orphan_pages(pages),
        "uncapturedFigures": uncaptured_figures(pages, figures),
        # The whole log, not a window of it: what a job could not write stays
        # reported until a later job for the same document says otherwise.
        "droppedTargets": dropped_targets(storage.latest_marker_events(username)),
    }


def dropped_targets(events: Mapping[str, Mapping[str, Any]]) -> list[dict[str, Any]]:
    """
    What each document's last job staged and could not write.

    `events` is the newest event per job marker (`latest_marker_events`). A
    document's markers are its own and its follow-ups', and the newest event
    among them speaks for the document: a later job that wrote everything it
    staged clears the report with no flag to go stale. Each row is a target
    the checker refused twice, `{slug, title, action, reason, quote}`, with
    the document and the marker a retry names.
    """
    last: dict[str, Mapping[str, Any]] = {}
    for marker, event in events.items():
        named = read_marker(marker)
        if named is None or named.kind != DOCUMENT:
            continue
        held = last.get(named.paper_id)
        if held is None or str(event.get("createdAt") or "") > str(held.get("createdAt") or ""):
            last[named.paper_id] = event
    rows = [
        {
            **{key: item.get(key) for key in ("slug", "title", "action", "reason", "quote")},
            "paperId": paper_id,
            "projectId": event.get("projectId"),
            "marker": document_marker(paper_id),
            "filedAt": event.get("createdAt"),
        }
        for paper_id, event in last.items()
        for item in event.get("dropped") or ()
    ]
    return sorted(rows, key=lambda row: (str(row["paperId"]), str(row["slug"])))


def orphan_pages(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Pages no `[[link]]` touches in either direction.

    `linkDegree` counts both columns, which is the whole correction: a page
    that is only ever linked *to* is not an orphan, it is a destination.
    """
    return [
        {
            "slug": page["slug"],
            "title": page["title"],
            "kind": page["kind"],
            "domain": page["domain"],
        }
        for page in pages
        if not page.get("linkDegree")
    ]


def uncaptured_figures(
    pages: list[dict[str, Any]], figures: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """
    Figures kept as a link rather than captured — the ones that rot.

    The page slug travels with them so the reader can reach the page that shows
    the hole, which a figure id alone does not let them do.
    """
    slugs = {page["id"]: page["slug"] for page in pages}
    return [
        {
            "id": figure["id"],
            "caption": figure["caption"],
            "sourceUrl": figure.get("sourceUrl"),
            "pageSlug": slugs.get(figure.get("pageId")),
        }
        for figure in figures
        if not figure.get("captured")
    ]
