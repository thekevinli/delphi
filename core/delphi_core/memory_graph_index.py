"""Revision-keyed, process-local index for active Memory graphs.

The persisted page/link/domain rows remain authoritative.  This is a derived
read accelerator: a cheap account revision check makes it safe across Cloud Run
instances, and rebuilding is linear in pages plus edges.  Nothing here changes
the one-hop prompt contract or the character ceiling that bounds it.
"""

from __future__ import annotations

from collections import OrderedDict, deque
from dataclasses import dataclass
import re
import threading
from typing import Any

from .storage.base import Storage, alias_index, alias_key

_TOKEN = re.compile(r"[a-z0-9]+")
_CACHE_LIMIT = 32
_CACHE_LOCK = threading.Lock()
_CACHE: OrderedDict[tuple[object, str, int], "MemoryGraphIndex"] = (
    OrderedDict()
)


def _storage_scope(storage: Storage) -> object:
    """Stable backend identity across FastAPI's per-request wrappers."""
    root = getattr(storage, "root", None)
    if root is not None:
        return (storage.kind, str(root))
    factory = getattr(storage, "_session_factory", None)
    bind = getattr(factory, "kw", {}).get("bind") if factory is not None else None
    return (storage.kind, id(bind) if bind is not None else id(factory))


def _slug_tokens(value: str) -> set[str]:
    return set(_TOKEN.findall((value or "").lower()))


@dataclass(frozen=True)
class MemoryGraphIndex:
    revision: int
    pages: tuple[dict[str, Any], ...]
    domains: tuple[dict[str, Any], ...]
    links: tuple[dict[str, str], ...]
    pages_by_slug: dict[str, dict[str, Any]]
    source_page_by_paper_id: dict[str, dict[str, Any]]
    adjacency: dict[str, frozenset[str]]
    domain_members: dict[str, frozenset[str]]
    aliases: dict[str, str]
    recency: tuple[str, ...]
    slug_token_index: dict[str, frozenset[str]]
    unresolved: frozenset[str]

    @classmethod
    def build(
        cls,
        *,
        revision: int,
        pages: list[dict[str, Any]],
        domains: list[dict[str, Any]],
        links: list[dict[str, str]],
    ) -> "MemoryGraphIndex":
        pages_by_slug = {page["slug"]: page for page in pages}
        adjacency: dict[str, set[str]] = {slug: set() for slug in pages_by_slug}
        for edge in links:
            source = edge.get("from") or ""
            target = edge.get("to") or ""
            if not source or not target:
                continue
            adjacency.setdefault(source, set()).add(target)
            adjacency.setdefault(target, set()).add(source)

        source_by_paper: dict[str, dict[str, Any]] = {}
        for page in sorted(pages, key=lambda item: item["slug"]):
            paper_id = page.get("sourcePaperId")
            if not paper_id or page.get("kind") != "source":
                continue
            source_by_paper.setdefault(paper_id, page)

        domain_members: dict[str, set[str]] = {}
        for page in pages:
            domain_members.setdefault(page.get("domain") or "general", set()).add(
                page["slug"]
            )

        token_index: dict[str, set[str]] = {}
        for page in pages:
            for token in _slug_tokens(
                f"{page.get('slug', '')} {page.get('title', '')}"
            ):
                token_index.setdefault(token, set()).add(page["slug"])

        ordered = sorted(
            pages,
            key=lambda page: (
                page.get("updatedAt") or "",
                page.get("linkDegree", 0),
                page["slug"],
            ),
            reverse=True,
        )
        return cls(
            revision=revision,
            pages=tuple(pages),
            domains=tuple(domains),
            links=tuple(links),
            pages_by_slug=pages_by_slug,
            source_page_by_paper_id=source_by_paper,
            adjacency={slug: frozenset(neighbors) for slug, neighbors in adjacency.items()},
            domain_members={slug: frozenset(members) for slug, members in domain_members.items()},
            aliases=alias_index(pages),
            recency=tuple(page["slug"] for page in ordered),
            slug_token_index={
                token: frozenset(slugs) for token, slugs in token_index.items()
            },
            unresolved=frozenset(set(adjacency) - set(pages_by_slug)),
        )

    @property
    def statistics(self) -> dict[str, int]:
        return {
            "pages": len(self.pages),
            "links": len(self.links),
            "domains": len(self.domains),
            "unresolvedTargets": len(self.unresolved),
        }

    def resolve_slug(self, slug: str) -> str:
        """The page a name means: its own slug first, then an alias.

        Aliases are compared as `alias_key` compares names, so "Self-Attention"
        and `self-attention` reach the page that lists either. A name nothing
        answers to is returned as it came, for the caller to find missing.
        """
        if slug in self.pages_by_slug:
            return slug
        return self.aliases.get(alias_key(slug), slug)

    def qualified_graph(self) -> dict[str, Any]:
        """The existing graph visibility rule, without another storage scan."""
        counts: dict[str, int] = {}
        for page in self.pages:
            if page.get("kind") == "domain" and page.get("slug") == page.get("domain"):
                continue
            domain = page.get("domain") or "general"
            counts[domain] = counts.get(domain, 0) + 1
        qualified = set(counts)
        pages = [page for page in self.pages if page.get("domain") in qualified]
        visible = {page["slug"] for page in pages}
        domains = [
            {**domain, "pages": counts[domain["slug"]]}
            for domain in self.domains
            if domain.get("slug") in qualified
        ]
        links = [edge for edge in self.links if edge.get("from") in visible]
        return {"domains": domains, "pages": pages, "links": links}

    def walk(
        self, slug: str, hops: int, *, through_domains: bool = False
    ) -> dict[str, tuple[int, frozenset[str]]]:
        """
        What is within `hops` links of a page, and through which pages.

        Returns `{slug: (distance, via)}` without the centre. Unlike
        `neighborhood`, which draws the rail, this is for *finding related
        pages*, so a domain's page is reached but never walked through: every
        page in a domain links to its domain page, and two hops through one is the whole
        domain rather than the pages that share an idea. A `[[target]]` with no
        page is kept and walked through — two pages naming the same missing
        concept are related by exactly that.

        `through_domains` lifts the domain rule for a chat's `memory_links`: a
        domain page says how its pages relate, which is how an answer finds the
        next step. Maintenance keeps the rule.
        """
        center = self.resolve_slug(slug)
        reached: dict[str, tuple[int, frozenset[str]]] = {}
        frontier = [center]
        for distance in range(1, hops + 1):
            found: dict[str, set[str]] = {}
            for current in frontier:
                if current != center and not through_domains and self.is_domain_page(current):
                    continue
                for neighbor in self.adjacency.get(current, ()):
                    if neighbor != center and neighbor not in reached:
                        found.setdefault(neighbor, set()).add(current)
            for neighbor, via in found.items():
                reached[neighbor] = (distance, frozenset(via))
            frontier = sorted(found)
        return reached

    def is_domain_page(self, slug: str) -> bool:
        page = self.pages_by_slug.get(slug)
        return bool(page) and page.get("kind") == "domain"

    def neighborhood(self, slug: str, hops: int) -> dict[str, Any]:
        center_slug = self.resolve_slug(slug)
        distances: dict[str, int] = {center_slug: 0}
        queue: deque[str] = deque([center_slug])
        while queue:
            current = queue.popleft()
            distance = distances[current]
            if distance >= hops:
                continue
            for neighbor in sorted(self.adjacency.get(current, ())):
                if neighbor in distances:
                    continue
                distances[neighbor] = distance + 1
                queue.append(neighbor)

        reached = set(distances)
        pages = [page for page in self.pages if page["slug"] in reached]
        links = [
            edge
            for edge in self.links
            if edge.get("from") in reached and edge.get("to") in reached
        ]
        domain_slugs = {page.get("domain") for page in pages}
        domains = [
            domain for domain in self.domains if domain.get("slug") in domain_slugs
        ]
        return {
            "revision": self.revision,
            "statistics": self.statistics,
            "center": self.pages_by_slug.get(center_slug),
            "distances": distances,
            "domains": domains,
            "pages": pages,
            "links": links,
        }

def memory_path(page: dict[str, Any]) -> str:
    """A page's place in the Memory tree, which is also how the tools name it."""
    return f"{page.get('domain') or 'general'}/{page.get('kind') or 'concept'}/{page['slug']}"


def get_memory_graph_index(
    storage: Storage, username: str, *, max_pages: int
) -> MemoryGraphIndex:
    revision = storage.memory_graph_revision(username)
    scope = _storage_scope(storage)
    key = (scope, username, revision)
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached is not None:
            _CACHE.move_to_end(key)
            return cached

    pages = storage.list_memory_pages(username, limit=max_pages)
    domains = storage.memory_domains(username)
    links = storage.list_memory_links(username)
    return prime_memory_graph_index(
        storage,
        username,
        revision=revision,
        pages=pages,
        domains=domains,
        links=links,
    )


def prime_memory_graph_index(
    storage: Storage,
    username: str,
    *,
    revision: int | None = None,
    pages: list[dict[str, Any]],
    domains: list[dict[str, Any]],
    links: list[dict[str, str]],
) -> MemoryGraphIndex:
    """Publish an index from listings a caller already had to read."""
    current_revision = (
        revision if revision is not None else storage.memory_graph_revision(username)
    )
    scope = _storage_scope(storage)
    key = (scope, username, current_revision)
    built = MemoryGraphIndex.build(
        revision=current_revision,
        pages=pages,
        domains=domains,
        links=links,
    )
    with _CACHE_LOCK:
        # Drop prior revisions for this storage/account before inserting the
        # new one.  The outer LRU bounds accounts too.
        for stale in [
            held
            for held in _CACHE
            if held[0] == scope and held[1] == username and held != key
        ]:
            _CACHE.pop(stale, None)
        _CACHE[key] = built
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_LIMIT:
            _CACHE.popitem(last=False)
    return built

