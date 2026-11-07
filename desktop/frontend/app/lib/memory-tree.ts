/**
 * The structure the wiki has but has never shown.
 *
 * Memory is a flat set of pages plus a `[[slug]]` edge list. That is
 * the right storage shape — a page belongs to a domain, not to a folder — but it
 * makes a poor sidebar: fifty-seven pages under one heading is a list nobody
 * scans. The tree here is *derived*, not stored, and the derivation is the whole
 * design decision, so it is worth being explicit about.
 *
 * A page's parent is the strongest page it is connected to within its own domain:
 * the neighbour with the highest link degree, which is the highest-degree node by definition,
 * broken toward the one that already has more children and then alphabetically.
 * That is deterministic — the same pages and edges always produce the same tree,
 * so the sidebar does not reshuffle between two visits — and it is honest, in
 * that every section is a real page the reader can open rather than a category
 * invented for the occasion. The roots are the domains, each drawn from its
 * record; a domain's composed page, when one has been written, is what its
 * heading opens.
 *
 * **`parents` is the extension point.** A caller-supplied slug → slug map wins
 * over the derivation, per page. Nothing fills it today. When a stored parent
 * arrives — a reader dragging a page, or an ingest that assigns one — it fills
 * this map and the rest of the module does not change. Deriving *and* honouring
 * from the start is what keeps that a data change rather than a rewrite.
 *
 * JSX-free so `node --test --experimental-strip-types` can load it.
 */

import type { MemoryDomain, MemoryKind, MemoryPageSummary } from "./api.ts";

export type TreeNode = {
  slug: string;
  title: string;
  /** `domain` for a domain root, whether or not a page stands behind it. */
  kind: MemoryKind;
  domain: string;
  /** Touched by an event inside the changed window the caller passed. */
  changed: boolean;
  /** How many pages sit at or below this node, excluding the node itself. */
  count: number;
  /** 0 for a domain, 1 for a section under it, 2+ for a leaf. */
  depth: number;
  /** True when this row is a domain heading, whether or not a page backs it. */
  heading: boolean;
  /**
   * False for a domain with no composed page: its heading shows the pages
   * filed under it, and there is nothing else to open.
   */
  openable: boolean;
  children: TreeNode[];
};

type Edge = { from: string; to: string };

/**
 * Undirected adjacency over `[[slug]]` edges, restricted to pages that exist.
 *
 * Undirected because a wiki link is a statement of relatedness in both
 * directions: a concept page naming its domain and a domain page listing its
 * concepts are the same fact written from two ends, and a directed walk would
 * see only one of them depending on which page the model happened to write.
 */
function adjacency(links: Edge[], known: Set<string>): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const edge of links) {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) {
      continue;
    }
    for (const [a, b] of [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ]) {
      const set = map.get(a) ?? new Set<string>();
      set.add(b);
      map.set(a, set);
    }
  }
  return map;
}

/**
 * Pick each page's parent, or `null` for one that hangs off its domain directly.
 *
 * Exported for its own tests: this is the only interesting decision in the
 * module, and testing it through the assembled tree would mean asserting on
 * nesting to find out what it chose.
 */
export function chooseParents(
  pages: MemoryPageSummary[],
  links: Edge[],
  explicit: Record<string, string> = {},
): Map<string, string | null> {
  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  const neighbours = adjacency(links, new Set(bySlug.keys()));
  const degree = (slug: string) => neighbours.get(slug)?.size ?? 0;
  const chosen = new Map<string, string | null>();

  for (const page of pages) {
    // A domain's own domain page is the root of its domain and never sits under
    // another page, however well connected that page is.
    if (page.kind === "domain") {
      chosen.set(page.slug, null);
      continue;
    }
    const override = explicit[page.slug];
    if (override && bySlug.has(override) && override !== page.slug) {
      chosen.set(page.slug, override);
      continue;
    }
    const candidates = [...(neighbours.get(page.slug) ?? [])]
      .filter((slug) => {
        const other = bySlug.get(slug);
        // Same domain only. A cross-domain link is real and the graph view shows
        // it, but using one as a parent would file a page under a heading it
        // does not belong to.
        return other && other.domain === page.domain;
      })
      .sort((left, right) => {
        const byDegree = degree(right) - degree(left);
        if (byDegree !== 0) return byDegree;
        // A domain page outranks an equally-connected leaf, so a domain's own page
        // wins ties and the tree gains a level instead of going flat.
        const leftDomain = bySlug.get(left)?.kind === "domain" ? 1 : 0;
        const rightDomain = bySlug.get(right)?.kind === "domain" ? 1 : 0;
        if (leftDomain !== rightDomain) return rightDomain - leftDomain;
        return left.localeCompare(right);
      });
    const best = candidates[0];
    // A domain's own page is its root by construction, so it is always eligible.
    // Anything else has to be *strictly* better connected: without that, two
    // leaves of equal degree adopt each other and both vanish from the tree,
    // and a concept linking to its domain page — which gives them the same degree —
    // would be stranded at the top level rather than nested under it.
    const eligible =
      best !== undefined &&
      (bySlug.get(best)?.kind === "domain" || degree(best) > degree(page.slug));
    chosen.set(page.slug, eligible ? best : null);
  }

  // A cycle would make the tree lose every page in it. Any page whose ancestry
  // does not terminate is re-hung on its domain instead — the sidebar showing it
  // one level too high is a far smaller failure than not showing it at all.
  for (const page of pages) {
    const seen = new Set<string>([page.slug]);
    let cursor = chosen.get(page.slug) ?? null;
    while (cursor) {
      if (seen.has(cursor)) {
        chosen.set(page.slug, null);
        break;
      }
      seen.add(cursor);
      cursor = chosen.get(cursor) ?? null;
    }
  }
  return chosen;
}

/**
 * The sidebar's tree: domains at the root, pages nested under their parent.
 *
 * `changedSlugs` are the pages a recent event touched; a node reports `changed`
 * when it or anything under it did, so a collapsed domain still shows that
 * something inside it moved.
 */
export function buildMemoryTree(
  pages: MemoryPageSummary[],
  links: Edge[],
  domains: MemoryDomain[],
  options: {
    parents?: Record<string, string>;
    changedSlugs?: Set<string>;
  } = {},
): TreeNode[] {
  const changed = options.changedSlugs ?? new Set<string>();
  const parents = chooseParents(pages, links, options.parents ?? {});
  const node = (page: MemoryPageSummary, heading: boolean): TreeNode => ({
    slug: page.slug,
    title: page.title,
    kind: page.kind,
    domain: page.domain,
    changed: changed.has(page.slug),
    count: 0,
    depth: 0,
    heading,
    openable: true,
    children: [],
  });

  // A domain's composed page is what its heading opens, not a row under it.
  // The slug of a `domain`-kind page and the domain it sits in are the same
  // string.
  const domainPages = new Map<string, MemoryPageSummary>();
  for (const page of pages) {
    if (page.kind === "domain" && page.slug === page.domain) {
      domainPages.set(page.domain, page);
    }
  }

  const nodes = new Map<string, TreeNode>();
  for (const page of pages) {
    if (domainPages.get(page.domain)?.slug === page.slug) continue;
    nodes.set(page.slug, node(page, false));
  }

  // Domains come from the domain records, including empty ones the reader just
  // named. Hiding those until something was filed made Create look broken —
  // refresh did not help, and only Update revealed the domain as a refile
  // destination. An empty heading with count 0 is the confirmation Create
  // worked. Any domain a page claims but no record covers is still added, so
  // a page can never be dropped for want of a heading.
  const roots = new Map<string, TreeNode>();
  // The name is the record's, which is the one the reader renames; the
  // composed page lends only whether there is something to open and whether
  // it changed.
  const heading = (slug: string, title: string): TreeNode => ({
    slug,
    title,
    kind: "domain",
    domain: slug,
    changed: changed.has(slug),
    count: 0,
    depth: 0,
    heading: true,
    openable: domainPages.has(slug),
    children: [],
  });
  const ordered = [...domains].sort(
    (left, right) => left.position - right.position || left.slug.localeCompare(right.slug),
  );
  for (const domain of ordered) {
    roots.set(domain.slug, heading(domain.slug, domain.title));
  }
  for (const page of pages) {
    if (roots.has(page.domain)) continue;
    // No record covers it: the composed page names it, or failing that its slug.
    roots.set(page.domain, heading(page.domain, domainPages.get(page.domain)?.title ?? page.domain));
  }

  for (const page of pages) {
    const entry = nodes.get(page.slug);
    if (!entry) continue;
    const parent = parents.get(page.slug);
    // A parent that turned out to be the domain page is the domain heading itself.
    const under =
      (parent && parent !== domainPages.get(page.domain)?.slug
        ? nodes.get(parent)
        : undefined) ?? roots.get(page.domain);
    under?.children.push(entry);
  }

  const settle = (item: TreeNode, depth: number): number => {
    item.depth = depth;
    item.children.sort((left, right) => {
      // Sections before leaves, so the shape of a domain is visible before its
      // detail; then alphabetically, because any recency order would reshuffle
      // the sidebar between two visits.
      const byShape = (right.children.length > 0 ? 1 : 0) - (left.children.length > 0 ? 1 : 0);
      return byShape || left.title.localeCompare(right.title);
    });
    let total = 0;
    for (const child of item.children) {
      total += settle(child, depth + 1) + 1;
      if (child.changed) item.changed = true;
    }
    item.count = total;
    return total;
  };
  const tree = [...roots.values()];
  for (const root of tree) settle(root, 0);
  return tree;
}

/**
 * The ancestors of one page, domain first — the breadcrumb over the reading pane.
 *
 * Read off the same tree the sidebar draws rather than recomputed, so the two
 * can never disagree about where a page sits.
 */
export function treePath(tree: TreeNode[], slug: string): TreeNode[] {
  const walk = (nodes: TreeNode[], trail: TreeNode[]): TreeNode[] | null => {
    for (const node of nodes) {
      if (node.slug === slug) return trail;
      const deeper = walk(node.children, [...trail, node]);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(tree, []) ?? [];
}

/** Every slug in a tree, for expand-all and for counting. */
export function treeSlugs(tree: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode) => {
    out.push(node.slug);
    node.children.forEach(walk);
  };
  tree.forEach(walk);
  return out;
}
