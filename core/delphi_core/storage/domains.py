"""
A domain's job, as both stores hold it.

A domain's page says how the pages filed under the domain relate, so it is
owed a composition when that changes and not otherwise: a page joins or leaves
the domain, a member's summary changes, or the reader renames the domain. An
edit that leaves a member's summary alone queues nothing. Each such change
enqueues the domain's one job again, in the write that makes the change, and
each enqueue pushes the job's wait forward (`Storage.enqueue_memory_job`),
so a burst of changes settles into one composition.

A domain is a place pages are filed, so a change that takes the last page
out of one removes it: a page deleted, moved into another domain, or written
into another one. The domain goes in the same write or under the same lock as
the change, with its own page, if it has one, and its queued job. Its own page
is the one its job composes; it describes the members and is not one of them.
Only a page leaving does this. A domain the reader has just named holds
nothing yet and stays until something has been filed into it and has left.

A domain the reader deletes takes its pages with it, all in one write: each
document's own page moves to the domain the reader chose for it, and every
other page is deleted, as `delete_memory_page` deletes one
(`plan_domain_delete`). `general` is never a domain to the reader: it is
where a document's page waits until the document is filed, so nothing moves
into it and it is not deleted.

What is written here is the same in both stores, so the two cannot hold a
domain differently: which domains a page write leaves owed, which a change
leaves holding nothing, and the enqueue.
"""

from collections.abc import Collection, Iterable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException

from ..memory_maintenance.jobs import DOMAIN, domain_change, domain_marker
from ..memory_maintenance.staging import UNSORTED_DOMAIN

#: `Storage.domain_settle_seconds` where nothing sets it: `Settings.memory_domain_settle_seconds`.
DOMAIN_SETTLE_SECONDS = 600.0


def domain_job(slug: str, *, settle_seconds: float) -> dict[str, Any]:
    """
    The arguments of the enqueue one change to a domain makes.

    The payload's fingerprint names this change alone (`domain_change`), and
    the job may not be claimed until the domain has gone `settle_seconds`
    without another, unless it is released first (`release_memory_jobs`).
    """
    now = datetime.now(UTC)
    return {
        "kind": DOMAIN,
        "marker": domain_marker(slug),
        "payload": {"domain": slug, "fingerprint": domain_change(slug, now.isoformat())},
        "not_before": (now + timedelta(seconds=max(0.0, settle_seconds))).isoformat(),
    }


def domains_owed(prior: Mapping[str, Any] | None, written: Mapping[str, Any]) -> list[str]:
    """
    The domains a page write leaves owed a composition, given the page as it was.

    A new page joins its domain. A page written into another domain leaves
    one and joins the other. A page whose summary changed is described
    differently to its domain. Anything else, a body edited under the same
    summary included, owes nothing. Writing a domain's own page never does.
    """
    domain = written.get("domain")
    if written.get("kind") == "domain" and written.get("slug") == domain:
        return []
    if not prior or not prior.get("revision"):
        return [domain] if domain else []
    if prior.get("domain") != domain:
        return [slug for slug in (prior.get("domain"), domain) if slug]
    return [domain] if domain and (prior.get("summary") or "") != (written.get("summary") or "") else []


def is_domain_page(page: Mapping[str, Any], slug: str | None) -> bool:
    """Whether `page` is the domain `slug`'s own page: the one its job composes, never one of its members."""
    return bool(slug) and page.get("kind") == "domain" and page.get("slug") == slug and page.get("domain") == slug


def domain_left(prior: Mapping[str, Any] | None, written: Mapping[str, Any] | None) -> str | None:
    """
    The domain a change takes one page out of, given the page as it was and
    as it is after (None when it is deleted); None when it leaves none.

    A page that did not exist left nothing, a page written back into the
    domain it was in stays there, and a domain's own page is not a member,
    so writing or deleting it takes nothing out of the domain.
    """
    if not prior or not prior.get("revision"):
        return None
    domain = prior.get("domain")
    if not domain or is_domain_page(prior, domain):
        return None
    if written is not None and written.get("domain") == domain:
        return None
    return str(domain)


def domains_emptied(left: Iterable[str | None], pages: Iterable[Mapping[str, Any]]) -> list[str]:
    """
    Of the domains a change took pages out of (`domain_left`), the ones it
    left holding none, given every page of the account as the change left it.

    These are removed with their own pages, in the change's write. A domain
    holds a page when any page but its own is filed in it, which is exactly
    when `Storage.delete_memory_domain` refuses without `members` or `moves`.
    Only a domain named in `left`
    is ever answered, so a domain that was empty before the change, such as
    one the reader has just named, is never removed by it.
    """
    named = list(dict.fromkeys(slug for slug in left if slug))
    if not named:
        return []
    held = {page.get("domain") for page in pages if not is_domain_page(page, page.get("domain"))}
    return [slug for slug in named if slug not in held]


def plan_domain_delete(
    slug: str,
    pages: Iterable[Mapping[str, Any]],
    domains: Collection[str],
    *,
    members: Collection[str],
    moves: Mapping[str, str],
) -> tuple[dict[str, list[str]], list[Mapping[str, Any]]]:
    """
    What deleting the domain `slug` does to the pages filed in it, given every
    page and every domain of the account: the source pages to move, by the
    domain each moves into, and the pages to delete. Raises before anything is
    written.

    `members` are the pages the reader was shown in the domain, its own page
    aside. A domain whose pages are not exactly those is refused with 409:
    filing may have added one since, and deleting a page nobody was shown is
    the one thing this must never do. `moves` names a domain for every source
    page and for nothing else (422 otherwise): a source page is its document's
    page and outlives the domain, while a concept page goes with it. A source
    cannot move into the domain being deleted, into one that does not exist,
    or into `general` (422).
    """
    if slug == UNSORTED_DOMAIN:
        raise HTTPException(422, "Pages waiting to be filed are not a domain")
    held = [page for page in pages if page.get("domain") == slug and not is_domain_page(page, slug)]
    if {page["slug"] for page in held} != set(members):
        raise HTTPException(409, "This domain's pages have changed; look at it again before deleting it")
    sources = sorted(page["slug"] for page in held if page.get("kind") == "source")
    if set(moves) != set(sources):
        raise HTTPException(422, "Name a domain for each document page, and only for those")
    by_destination: dict[str, list[str]] = {}
    for source in sources:
        destination = moves[source]
        if destination in (slug, UNSORTED_DOMAIN) or destination not in domains:
            raise HTTPException(422, f"{source} cannot move into {destination or 'nothing'}")
        by_destination.setdefault(destination, []).append(source)
    return by_destination, [page for page in held if page.get("kind") != "source"]
