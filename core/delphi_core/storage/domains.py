"""
A domain's job, as both stores hold it.

A domain's page says how the pages filed under the domain relate, so it is
owed a composition when that changes and not otherwise: a page joins or leaves
the domain, a member's summary changes, or the reader renames the domain. An
edit that leaves a member's summary alone queues nothing. Each such change
enqueues the domain's one job again, in the write that makes the change, and
each enqueue pushes the job's wait forward (`Storage.enqueue_memory_job`),
so a burst of changes settles into one composition.

What is written here is the same in both stores, so the two cannot hold a
domain differently: which domains a page write leaves owed, and the enqueue.
"""

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from ..memory_maintenance.jobs import DOMAIN, domain_change, domain_marker

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
