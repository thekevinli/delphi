"""
Gather for a `domain` job: the domain, its member pages, and what moved since its page was composed.

A domain's page says how the pages filed under the domain relate, so what
the composer is given is those pages and nothing else (`gather_domain`):

- the domain's record, whose name the reader may have written;
- every member page: its kind, title and summary, the headings of its body
  and how the body opens;
- the links among the members;
- what changed since the page was last composed. The domain's last event
  holds each member's slug and revision as that composition read them, so a
  member the event does not name was added, one it names that is no longer
  here was removed or moved away, and one at another revision was written
  again. An edited concept page's newest version row says why, in one read
  for all of them (`page_history`). Only the newest note of a page edited
  more than once is given.

What the page may cite is the documents its members cite: that is its closed
evidence set, and each is read as `gather_reconcile` reads the documents two
pages cite. The domain's own page is not in the brief. The composer's stage
opens it as an edit addresses it.

**When there is nothing to compose** the set comes back `settled`, and the job
ends with no event and no model call: the domain is the unsorted one
(`general`, a place pages wait and not a field), the domain is gone, it has
fewer member
pages than a domain page is written from, another kind of page has its slug,
or its members are exactly what the page was last composed from. The last is
decided by the fingerprint (`jobs.domain_fingerprint`), which is what makes
composing unchanged members twice a no-op.

Blocking, like the stores. No model.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any

from fastapi import HTTPException

from ..config import Settings
from ..memory import is_domain_page
from ..storage import ObjectStore, Storage
from . import brief as tags
from .gather import Passages, external_sources, library_cross_references
from .gather_crossref import MAX_PASSAGES
from .gather_reconcile import cited_documents
from .jobs import DOMAIN, DOMAIN_MEMBER_KINDS, DOMAIN_MIN_MEMBERS, UNSORTED_DOMAIN, domain_fingerprint
from .run import EvidenceSet

#: Members read in full, most recently written first. A domain with more
#: lists the rest by title and summary.
MEMBERS_READ = 60
#: How much of all the members' openings a brief carries, and of one of them.
OPENINGS_TOTAL_CHARS = 36_000
OPENING_MAX_CHARS = 600
OPENING_MIN_CHARS = 120
HEADINGS_MAX = 12
SUMMARY_CHARS = 400
NOTE_CHARS = 300
_HEADING = re.compile(r"^ {0,3}(#{1,6})[ \t]+(.+?)[ \t#]*$", re.M)
_FENCED = re.compile(r"(?ms)^ {0,3}(`{3,}|~{3,}).*?(?:^ {0,3}\1[`~]*[ \t]*$|\Z)")


def _settled(marker: str, reason: str, fingerprint: str = "") -> EvidenceSet:
    return EvidenceSet(kind=DOMAIN, marker=marker, fingerprint=fingerprint, skipped=reason, settled=True)


def _member_text(page: Mapping[str, Any], opening: int) -> str:
    body = str(page.get("body") or "")
    headings = [f"{found[1]} {found[2]}" for found in _HEADING.finditer(_FENCED.sub("", body))]
    more = f" (and {len(headings) - HEADINGS_MAX} more)" if len(headings) > HEADINGS_MAX else ""
    lines = [
        f"title: {tags.clip(str(page.get('title') or page['slug']), 200)}",
        f"summary: {tags.clip(' '.join(str(page.get('summary') or '').split()), SUMMARY_CHARS)}",
    ]
    if page.get("aliases"):
        lines.append("also called: " + "; ".join(tags.clip(str(alias), 120) for alias in page["aliases"]))
    if "body" in page:
        lines.append("headings: " + (" | ".join(headings[:HEADINGS_MAX]) + more if headings else "none"))
        lines.append("how it opens:\n" + tags.clip(body.strip(), opening))
    return "\n".join(lines)


def _changes(
    storage: Storage, username: str, members: Mapping[str, Mapping[str, Any]], before: Mapping[str, Any]
) -> list[str]:
    """What moved since the page was composed, a line for each member, with the newest note of an edited one."""
    added = [slug for slug in members if slug not in before]
    removed = [slug for slug in before if slug not in members]
    edited = [slug for slug in members if slug in before and int(before[slug] or 0) != int(members[slug].get("revision") or 0)]
    history = storage.page_history(username, edited) if edited else {}
    lines = [f"[[{slug}]] was added to the domain." for slug in added]
    lines += [f"{slug} is no longer in the domain: it was deleted or moved to another." for slug in removed]
    for slug in edited:
        latest = (history.get(slug) or {}).get("latest") or {}
        note = " ".join(str(latest.get("note") or "").split())
        lines.append(tags.fence(
            tags.MEMBER_CHANGE, tags.clip(note, NOTE_CHARS) if note else "No note was left with this change.",
            slug=slug, cause=latest.get("trigger"),
        ))
    return lines


def _domain_brief(
    domain: Mapping[str, Any], members: list[Mapping[str, Any]], links: list[tuple[str, str]], sources: list[Any],
    changes: list[str] | None, has_page: bool, references: str = "",
) -> str:
    opening = max(OPENING_MIN_CHARS, min(OPENING_MAX_CHARS, OPENINGS_TOTAL_CHARS // max(1, len(members))))
    parts = [
        f"The page of the domain `{domain['slug']}` is to be "
        + ("brought up to date: it is open below, as an edit addresses it." if has_page else "written: the domain has no page yet."),
        tags.fence(
            tags.DOMAIN_RECORD,
            f"title: {tags.clip(str(domain.get('title') or domain['slug']), 200)}\n"
            f"summary: {tags.clip(str(domain.get('summary') or ''), SUMMARY_CHARS) or 'none'}",
            slug=domain["slug"],
        ),
        f"The {len(members)} pages filed under the domain, each linked as [[slug]]:",
        *(
            tags.fence(tags.MEMBER_PAGE, _member_text(page, opening), slug=page["slug"], kind=page.get("kind"), revision=page.get("revision"))
            for page in members
        ),
        "Links among these pages, as their bodies have them:\n"
        + ("\n".join(f"[[{source}]] links to [[{target}]]" for source, target in links) or "none"),
        "What the page may be cited from, and nothing else. These are the documents the member pages cite:\n"
        + ("\n".join(tags.describe_source(source) for source in sources) or "- nothing: the member pages cite no document that can still be read"),
        *([references] if references else []),
    ]
    if changes is not None:
        parts.append(
            "What changed since the page was last composed:\n"
            + ("\n".join(changes) or "No member changed; the domain was renamed or its summary rewritten.")
        )
    elif has_page:
        parts.append("Nothing records what the page was last composed from, so read it against every member.")
    return f"<{tags.EVENT} kind=\"{DOMAIN}\">\n" + "\n\n".join(parts) + f"\n</{tags.EVENT}>"


def gather_domain(
    storage: Storage, objects: ObjectStore, username: str, settings: Settings, job: Mapping[str, Any]
) -> EvidenceSet:
    """
    The evidence set of a `domain` job (see the module docstring).

    `start_slugs` is the domain's page when it has one. `record` is what the
    job's event keeps for the next composition: the domain and each member's
    revision as read here.
    """
    marker = str(job.get("marker") or "")
    slug = str((job.get("payload") or {}).get("domain") or marker.removeprefix(f"{DOMAIN}:"))
    if slug == UNSORTED_DOMAIN:
        return _settled(marker, "Pages wait unsorted here; they are not a field, and no page says how they relate.")
    domain = next((entry for entry in storage.memory_domains(username) if entry["slug"] == slug), None)
    if domain is None:
        return _settled(marker, f"The domain {slug} is no longer in Memory.")
    listed = storage.list_memory_pages(username, domains=[slug], limit=max(1, settings.memory_max_pages))
    held = [page for page in listed if page["slug"] != slug and page.get("kind") in DOMAIN_MEMBER_KINDS]
    revisions = {page["slug"]: int(page.get("revision") or 0) for page in held}
    fingerprint = domain_fingerprint(domain.get("title") or "", domain.get("summary") or "", revisions)
    if len(held) < DOMAIN_MIN_MEMBERS:
        return _settled(marker, f"The domain has {len(held)} member pages; its page is written from {DOMAIN_MIN_MEMBERS}.", fingerprint)
    try:
        current = storage.get_memory_page(username, slug)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        current = None
    if current is not None and not is_domain_page(current, slug):
        return _settled(marker, f"Another page already has the slug {slug}, so the domain can have no page of its own.", fingerprint)
    last = storage.latest_marker_events(username, [marker]).get(marker) or {}
    if last.get("fingerprint") == fingerprint and last.get("outcome") != "failed" and (current is not None or last.get("outcome") == "nothing"):
        return _settled(marker, "The domain's members are as its page was last composed from.", fingerprint)

    held.sort(key=lambda page: str(page.get("updatedAt") or ""), reverse=True)
    members: list[Mapping[str, Any]] = []
    for page in held:
        try:
            members.append(storage.get_memory_page(username, page["slug"]) if len(members) < MEMBERS_READ else page)
        except HTTPException:
            continue
    read = [page for page in members if "body" in page]
    inside = set(revisions)
    links = sorted({
        (edge["from"], edge["to"]) for edge in storage.list_memory_links(username)
        if edge["from"] in inside and edge["to"] in inside and edge["from"] != edge["to"]
    })
    passages = Passages(objects, username)
    cited = [*read, *([current] if current else [])]
    sources = cited_documents(storage, objects, username, cited, passages)
    if settings.memory_web_evidence:
        captured = (str(c["evidenceId"]) for page in cited for c in page.get("citations") or () if c.get("evidenceId"))
        sources += [source for source, _ in external_sources(storage, objects, username, captured, passages)]
    before = (last.get("read") or {}).get("members") if current is not None else None
    changes = _changes(storage, username, {page["slug"]: page for page in members}, before) if isinstance(before, Mapping) else None
    title = str(domain.get("title") or slug)
    documents = {source.id: passages.texts(source, MAX_PASSAGES) for source in sources if source.kind == "document"}
    # Where one of these documents reports a value of another: the composer compares the two.
    references = library_cross_references(storage, username, settings, documents, among=documents)
    return EvidenceSet(
        kind=DOMAIN,
        marker=marker,
        title=f"The domain {json.dumps(tags.clip(title, 200), ensure_ascii=False)}",
        start_slugs=(slug,) if current is not None else (),
        sources=tuple(sources),
        brief=_domain_brief(domain, members, links, sources, changes, current is not None, references),
        fingerprint=fingerprint,
        record={"domain": slug, "title": title, "members": revisions},
        passage=passages,
    )
