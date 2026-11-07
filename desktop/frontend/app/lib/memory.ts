import type { ConversationSummary } from "./conversation-session.ts";
/**
 * Memory's pure vocabulary.
 *
 * JSX-free on purpose: `node --test --experimental-strip-types` cannot strip
 * types out of a `.tsx`, so anything that needs a unit test has to stay here.
 * The `.ts` extensions on the imports below are the same rule — type-stripping
 * resolves them literally.
 */

import {
  API_BASE,
  type ComposerChoice,
  type MemoryDomain,
  type MemoryCitation,
  type MemoryEdit,
  type MemoryEvent,
  type MemoryFigure,
  type MemoryKind,
  type MemoryPageSummary,
} from "./api.ts";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 60;
/** `[[slug]]` or `[[slug|shown text]]`, the way a wiki has always written one. */
const WIKI_LINK = /\[\[([^\[\]|]{1,120})(?:\|([^\[\]]{0,120}))?\]\]/g;
/** A Delphi figure locator. A remote address is never one. */
const FIGURE_SRC = /^figure:([A-Za-z0-9_-]{1,32})$/;

/**
 * The route alphabet, mirrored from the backend's `route_slug`.
 *
 * A slug crosses the wire in both directions — the model types one into a page
 * body, the reader clicks one — so the browser has to be able to normalise a
 * `[[Link]]` written in prose without asking the server what it meant.
 */
export function memorySlug(value: string): string {
  const folded = (value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['‘’ʼ]/g, "")
    .toLowerCase();
  const slug = folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length <= SLUG_MAX) return slug;
  const clipped = slug.slice(0, SLUG_MAX);
  const boundary = clipped.lastIndexOf("-");
  return (boundary > 0 ? clipped.slice(0, boundary) : clipped).replace(/-+$/, "");
}

export function isMemorySlug(value: string): boolean {
  return value.length <= SLUG_MAX && SLUG.test(value);
}

export function memoryPath(slug: string): string {
  return `/memory?page=${encodeURIComponent(slug)}`;
}

/**
 * Longest question `?q=` may carry into the wiki conversation.
 *
 * Bounded because anyone can write the address. The wiki drops `q` once the
 * turn is sent, which is what stops a reload spending another model call
 * (invariant 46).
 */
export const MAX_SEEDED_QUESTION = 400;

/**
 * The address of the wiki rail conversation, optionally seeded with one
 * question. The Memory shell itself no longer navigates here: the map and
 * Health dock the conversation where the question was asked.
 */
export function memoryAskHref(question = ""): string {
  const seed = question.trim().slice(0, MAX_SEEDED_QUESTION);
  if (!seed) return "/memory?ask=1";
  return `/memory?ask=1&q=${encodeURIComponent(seed)}`;
}

export type MemoryAskHandoff = {
  conversation?: ConversationSummary;
  requestId?: string;
  prompt: string;
  imageIds: string[];
  /** Present only when the question carries a submitted composer selection. */
  personaId?: string;
  /**
   * The composer's pills. Held here with the question because the shell that
   * answers it can be a remount, whose own pills start from defaults.
   */
  choice?: ComposerChoice;
};

let pendingAsk: MemoryAskHandoff | null = null;

export function holdMemoryAsk(draft: MemoryAskHandoff): void {
  const prompt = draft.prompt.trim().slice(0, MAX_SEEDED_QUESTION);
  const imageIds = draft.imageIds.filter((id) => id.length > 0);
  pendingAsk = prompt || imageIds.length
    ? {
      prompt,
      imageIds,
      ...(draft.personaId ? { personaId: draft.personaId } : {}),
      ...(draft.conversation ? { conversation: draft.conversation } : {}),
      ...(draft.requestId ? { requestId: draft.requestId } : {}),
      ...(draft.choice ? { choice: draft.choice } : {}),
    }
    : null;
}

export function peekMemoryAsk(): MemoryAskHandoff | null {
  return pendingAsk;
}

export function clearMemoryAsk(): void {
  pendingAsk = null;
}

export type WikiSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; slug: string; label: string };

/**
 * Split prose into text and `[[links]]`.
 *
 * Returns segments rather than HTML so the caller decides what a link *is* —
 * an anchor in the page view, plain text in a chat answer. Building markup here
 * would put the decision in the wrong place and put model-authored text one
 * step closer to `dangerouslySetInnerHTML`.
 */
export function splitWikiLinks(body: string): WikiSegment[] {
  const segments: WikiSegment[] = [];
  let cursor = 0;
  for (const match of (body ?? "").matchAll(WIKI_LINK)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({ kind: "text", text: body.slice(cursor, start) });
    }
    const slug = memorySlug(match[1]);
    if (slug) {
      segments.push({ kind: "link", slug, label: match[2] || match[1] });
    } else {
      segments.push({ kind: "text", text: match[0] });
    }
    cursor = start + match[0].length;
  }
  if (cursor < (body ?? "").length) {
    segments.push({ kind: "text", text: body.slice(cursor) });
  }
  return segments;
}

/**
 * Sent on `window` once a reader's delete has removed Memory pages, so a chat
 * already on screen reads its pages again and a name it drew as a link to one
 * of them becomes words, never a link that opens nothing.
 */
export const MEMORY_PAGES_CHANGED = "delphi-memory-pages-changed";

/** What a `[[slug]]` in a body needs to be drawn as a link: the page it names. */
export type KnownPage = Pick<MemoryPageSummary, "title" | "kind"> & { summary?: string };
export type KnownPages = ReadonlyMap<string, KnownPage>;

/** The pages a body can link to, by slug. */
export function knownPages(pages: Array<Pick<MemoryPageSummary, "slug" | "title" | "kind"> & { summary?: string }>): KnownPages {
  return new Map(pages.map((page) => [page.slug, { title: page.title, kind: page.kind, ...(page.summary ? { summary: page.summary } : {}) }]));
}

/** The earlier map when nothing a link draws has changed, so answers keep their identity. */
export function samePages(known: KnownPages, next: KnownPages): KnownPages {
  if (known.size !== next.size) return next;
  for (const [slug, page] of next) {
    const was = known.get(slug);
    if (!was || was.title !== page.title || was.kind !== page.kind || was.summary !== page.summary) return next;
  }
  return known;
}

/**
 * What a wiki link reads as. The author's own words when they wrote some
 * (`[[slug|words]]`); otherwise the page's title, since a body names pages by
 * slug and a slug is an address, not a name; and for a name with no page, the
 * name as written, with a bare slug turned into words.
 */
export function wikiLinkText(link: { slug: string; label: string }, page?: KnownPage): string {
  const authored = link.label !== link.slug && memorySlug(link.label) !== link.slug;
  if (authored) return link.label;
  if (page) return page.title;
  // With no page to name it, the words the author wrote are kept as written.
  return link.label === link.slug ? link.slug.replace(/-/g, " ") : link.label;
}

/**
 * Text with each `[[slug]]` replaced by what it reads as. For the one place a
 * wiki link cannot be drawn as a link: inside a link the author already wrote.
 */
export function wikiLinkWords(text: string, pages: KnownPages): string {
  return splitWikiLinks(text)
    .map((segment) => (segment.kind === "text" ? segment.text : wikiLinkText(segment, pages.get(segment.slug))))
    .join("");
}

/**
 * Resolve an image `src` to a Delphi figure route, or refuse it.
 *
 * Refusing is the point. A page body is model-authored text entering the
 * reader's DOM, and a remote address in it is the favicon problem with a much
 * larger blast radius: it leaks the reader's IP and referrer to whichever host
 * the model happened to name, and it rots. `figure:<id>` or nothing.
 */
export function figureSrc(src: string | undefined): string | null {
  const match = FIGURE_SRC.exec(src ?? "");
  // Through `API_BASE`, like every other call: empty in a deployed build where
  // the Worker proxies `/api/*` same-origin, absolute locally where the backend
  // is a separate process on :8000. A relative path here renders as a broken
  // image on every local install and on no deployed one, which is the worst
  // possible place for the difference to hide.
  return match ? `${API_BASE}/api/memory/figures/${match[1]}` : null;
}

export function figureById(
  figures: MemoryFigure[],
  src: string | undefined,
): MemoryFigure | null {
  const match = FIGURE_SRC.exec(src ?? "");
  if (!match) return null;
  return figures.find((figure) => figure.id === match[1]) ?? null;
}

/** Kind vocabulary: a closed set, because each one picks an icon and a colour. */
export const MEMORY_KINDS: MemoryKind[] = [
  "domain",
  "concept",
  "source",
];

export const KIND_LABELS: Record<MemoryKind, string> = {
  // One word for the page kind, the record a reader creates and the heading
  // in the tree: every surface reads its label from this map, where the badge
  // on an open page once special-cased its own and the others disagreed.
  domain: "Domain",
  concept: "Concept",
  source: "Source",
};

export type GraphNode = {
  slug: string;
  title: string;
  /** Already present in the overview; graph previews must never fetch a page. */
  summary: string;
  kind: MemoryKind;
  domain: string;
  degree: number;
  x: number;
  y: number;
  /** Drawn radius, in the same units as `x`/`y` — the collision pass needs it. */
  r: number;
  /**
   * False for a domain with no composed page: the node stands for the domain
   * record, and there is nothing behind it to open.
   */
  openable?: boolean;
};

export type GraphEdge = { from: string; to: string };

export type RelatedMemory = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  distances: Map<string, number>;
  pages: MemoryPageSummary[];
};

const RELATED_KIND_ORDER: Record<MemoryKind, number> = {
  source: 0,
  concept: 1,
  domain: 2,
};

/** Project the server-owned neighborhood into drawable nodes and a page list. */
export function relatedMemory(
  currentSlug: string,
  pages: MemoryPageSummary[],
  links: Array<{ from: string; to: string }>,
  domains: Array<Pick<MemoryDomain, "slug" | "title">>,
  serverDistances: Record<string, number>,
): RelatedMemory {
  const graph = buildGraph(pages, links, domains, { includeMembership: false });
  const distances = new Map(Object.entries(serverDistances));
  const nodeSlugs = new Set(distances.keys());
  const nodes = graph.nodes.filter((node) => nodeSlugs.has(node.slug));
  const edges = graph.edges.filter(
    (edge) => nodeSlugs.has(edge.from) && nodeSlugs.has(edge.to),
  );
  const relatedPages = pages
    .filter((page) => page.slug !== currentSlug && distances.has(page.slug))
    .slice()
    .sort((left, right) => {
      const byDistance =
        (distances.get(left.slug) ?? Infinity) -
        (distances.get(right.slug) ?? Infinity);
      if (byDistance) return byDistance;
      const byKind = RELATED_KIND_ORDER[left.kind] - RELATED_KIND_ORDER[right.kind];
      if (byKind) return byKind;
      return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    });
  return { nodes, edges, distances, pages: relatedPages };
}

/** A deliberately small, overview-only taste of a page — never a detail read. */
/**
 * Where a cited passage sits in its source, in the words a reader would look
 * for it by: the digest's section heading when there is one, otherwise the
 * section number or page. A reader's note and Delphi's own inference are said
 * outright; an inference names no source, so it has no locator to fall back on.
 */
export function citationSection(citation: MemoryCitation): string {
  if (citation.claimType === "derived") return "Delphi’s inference";
  if (citation.claimType === "reader-note") return "From your note";
  if (citation.sectionTitle) return citation.sectionTitle;
  if (citation.section) return `§${citation.section}`;
  if (citation.page) return `p. ${citation.page}`;
  return citation.claimType === "external" ? "Outside source" : "Whole document";
}

/**
 * A page's evidence grouped by where it sits in the source, sections in the
 * order the page first cites them. Six markers that all say "Overview" read as
 * six identical rows; one row with six markers says the page leans on one part.
 */
export function citationsBySection(citations: MemoryCitation[]): Array<{ section: string; ids: number[] }> {
  const groups = new Map<string, number[]>();
  for (const citation of citations) {
    const section = citationSection(citation);
    groups.set(section, [...(groups.get(section) ?? []), citation.id]);
  }
  return [...groups].map(([section, ids]) => ({ section, ids }));
}

/**
 * A summary as the words a reader sees. Summaries are written in Markdown, and
 * an excerpt is drawn as plain text, so `**Central takeaway.**` would otherwise
 * show its asterisks. Only inline marks go; the words are all kept.
 */
export function plainSummary(summary: string): string {
  return (summary ?? "")
    .replace(WIKI_LINK, (_, slug: string, shown?: string) => (shown ?? slug).trim())
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1");
}

/**
 * Whether a page's summary is only its body's opening, repeated.
 *
 * A source page's summary is its digest's first prose paragraph — the card
 * subtitle hovers and lists show — so on the page itself it printed the same
 * sentences twice, above the body that starts with them. Compared as words, so
 * Markdown marks and a leading heading do not hide the repeat.
 */
export function summaryRepeatsBody(summary: string, body: string): boolean {
  const words = (text: string) => plainSummary(text).replace(/[\u2026.]+\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
  const opening = words(summary).slice(0, 80);
  return opening.length >= 20 && words(body).slice(0, 600).includes(opening);
}

export function graphPreviewExcerpt(summary: string, wordLimit = 22): string {
  const words = plainSummary(summary).trim().split(/\s+/).filter(Boolean);
  if (words.length <= wordLimit) return words.join(" ");
  return `${words.slice(0, wordLimit).join(" ")}…`;
}


/** How far past the outermost nodes the view's centre may travel, as a
 *  multiple of the graph's half-extent. Past that there is only empty field. */
const PAN_SLACK = 1.25;
/** A graph of one or two nodes has almost no extent; it still pans this far. */
const MIN_PAN_REACH = 12;

/** A camera over the canvas graph: its top-left corner and visible height, in layout units. */
export type GraphView = { x: number; y: number; size: number };

/**
 * The view with its centre held inside the graph's relaxed bounding box.
 *
 * Measured against where the view came from rather than applied outright: a
 * view that starts outside the box (the full graph's fixed home can) may only
 * move back toward it, so the first drag never snaps it somewhere else.
 */
export function boundedView(next: GraphView, previous: GraphView, positions: Float32Array, aspect: number): GraphView {
  if (positions.length < 2) return next;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let index = 0; index < positions.length; index += 2) {
    minX = Math.min(minX, positions[index]); maxX = Math.max(maxX, positions[index]);
    minY = Math.min(minY, positions[index + 1]); maxY = Math.max(maxY, positions[index + 1]);
  }
  const clampAxis = (centre: number, before: number, low: number, high: number) => {
    const middle = (low + high) / 2;
    const reach = Math.max(MIN_PAN_REACH, ((high - low) / 2) * PAN_SLACK);
    const lo = Math.min(middle - reach, before);
    const hi = Math.max(middle + reach, before);
    return Math.max(lo, Math.min(hi, centre));
  };
  const width = next.size * aspect;
  const cx = clampAxis(next.x + width / 2, previous.x + (previous.size * aspect) / 2, minX, maxX);
  const cy = clampAxis(next.y + next.size / 2, previous.y + previous.size / 2, minY, maxY);
  return { x: cx - width / 2, y: cy - next.size / 2, size: next.size };
}

/**
 * The graph is laid out in the SVG's own viewBox units, so nothing rescales.
 * Height is the reference axis; the wide 16:9 field leaves room for the graph
 * beside its reserved legend rail.
 */
export const GRAPH_HEIGHT = 90;
export const GRAPH_WIDTH = 160;
export const GRAPH_ASPECT = GRAPH_WIDTH / GRAPH_HEIGHT;
/** Short-axis size — zoom/`view.size` are measured in this unit. */
export const GRAPH_SIZE = GRAPH_HEIGHT;

/**
 * The graph's own camera: what rectangle of its layout the SVG's `viewBox`
 * currently shows. `size` is the visible *height*; width is `size * GRAPH_ASPECT`
 * so the camera keeps the canvas aspect under pan and zoom.
 */
export type GraphViewBox = { x: number; y: number; size: number };

export const GRAPH_VIEW_HOME: GraphViewBox = { x: 0, y: 0, size: GRAPH_HEIGHT };

// Past an eighth of the full height, a single node's own circle already
// fills the screen — more scale would just show empty space around it. The
// pad on the other end lets a node sitting at the rim be panned to the
// centre of the canvas rather than stopping dead at the graph's own edge.
const GRAPH_VIEW_MIN_SIZE = GRAPH_HEIGHT / 8;
const GRAPH_VIEW_MAX_SIZE = GRAPH_HEIGHT * 1.15;
const GRAPH_VIEW_PAD = GRAPH_HEIGHT * 0.4;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function clampGraphView(view: GraphViewBox): GraphViewBox {
  const size = clamp(view.size, GRAPH_VIEW_MIN_SIZE, GRAPH_VIEW_MAX_SIZE);
  const width = size * GRAPH_ASPECT;
  const loX = -GRAPH_VIEW_PAD;
  const hiX = GRAPH_WIDTH + GRAPH_VIEW_PAD - width;
  const loY = -GRAPH_VIEW_PAD;
  const hiY = GRAPH_HEIGHT + GRAPH_VIEW_PAD - size;
  return {
    size,
    x: clamp(view.x, loX, Math.max(loX, hiX)),
    y: clamp(view.y, loY, Math.max(loY, hiY)),
  };
}

/**
 * Zoom by `factor` (>1 zooms in) around `anchor`, an (x, y) already in the
 * graph's own coordinates — the point under the cursor or the two fingers,
 * so it is the point that stays put. Scaling around the view's centre
 * instead is what makes a map feel like it is sliding out from under a
 * pinch rather than growing from underneath it.
 */
export function zoomGraphView(
  view: GraphViewBox,
  factor: number,
  anchor: { x: number; y: number },
): GraphViewBox {
  // A bigger `factor` shows less of the graph, not more — the viewBox
  // shrinks as the zoom grows, which is why this divides rather than
  // multiplies.
  const size = clamp(view.size / factor, GRAPH_VIEW_MIN_SIZE, GRAPH_VIEW_MAX_SIZE);
  const ratio = size / view.size;
  return clampGraphView({
    size,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  });
}

/** Pan by (dx, dy), already converted into the graph's own coordinate units. */
export function panGraphView(view: GraphViewBox, dx: number, dy: number): GraphViewBox {
  return clampGraphView({ size: view.size, x: view.x + dx, y: view.y + dy });
}

/**
 * How big a node is drawn, from how connected it is.
 *
 * Exported because the layout and the renderer must agree on it exactly: the
 * collision pass separates circles by this radius, and a renderer using a
 * different one would draw overlaps the layout believed it had removed.
 */
export function nodeRadius(degree: number): number {
  return 1.25 + Math.sqrt(Math.min(degree, 24)) * 0.58;
}

/**
 * The force-layout seed: every page, every wiki link, and every domain.
 *
 * Seeded from each slug rather than randomly, so `relaxGraph` starts from the
 * same picture every time and therefore settles into the same one. That is what
 * makes "the cluster on the left" a thing a reader can say twice; a simulation
 * seeded from `Math.random` puts the same wiki somewhere different on every
 * visit.
 *
 * Only pages are nodes, and only a link between two pages is an edge. A
 * `[[slug]]` naming no page is plain words where it is read, so it is not a
 * place here either.
 *
 * A domain is drawn from its record: the name the reader gave it and its
 * summary, whether or not a page has been composed for it. The composed page,
 * when there is one, is what the node opens. Membership edges (page → its
 * domain) keep the clusters honest without inventing wiki links the bodies do
 * not carry.
 */
export function buildGraph(
  pages: MemoryPageSummary[],
  links: Array<{ from: string; to: string }>,
  domains: Array<Pick<MemoryDomain, "slug" | "title"> & { summary?: string | null }> = [],
  { includeMembership = true }: { includeMembership?: boolean } = {},
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const pageBySlug = new Map(pages.map((page) => [page.slug, page]));
  const known = new Map(pageBySlug);
  // A domain's page, when one exists: kind `domain` whose slug is the domain.
  const domainPages = new Map<string, MemoryPageSummary>();
  for (const page of pages) {
    if (page.kind === "domain" && page.slug === page.domain) {
      domainPages.set(page.domain, page);
    }
  }

  const degrees = new Map<string, number>();
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    const key = from < to ? `${from}\0${to}` : `${to}\0${from}`;
    // Undirected for dedupe: a wiki link and a membership edge naming the
    // same pair must not double-count the degree or draw two lines.
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to });
    degrees.set(from, (degrees.get(from) ?? 0) + 1);
    degrees.set(to, (degrees.get(to) ?? 0) + 1);
  };

  // Every domain that actually holds pages is a node, so an empty named
  // domain does not appear as a lonely circle before anything has been filed
  // into it. A domain a page claims and no record covers is named by its slug.
  const records = new Map(domains.map((domain) => [domain.slug, domain]));
  const held = new Set(pages.map((page) => page.domain));

  // Dropped at the edge rather than at the node: a node filtered out later
  // would leave its lines drawn to nowhere, and would still have counted
  // toward every degree the radii and the seed layout are scaled from.
  for (const link of links) {
    if (!pageBySlug.has(link.from) || !pageBySlug.has(link.to)) continue;
    addEdge(link.from, link.to);
  }
  for (const slug of held) {
    if (!includeMembership) continue;
    if (known.has(slug)) continue;
    const record = records.get(slug);
    known.set(slug, {
      id: slug,
      slug,
      kind: "domain",
      domain: slug,
      title: record?.title ?? slug,
      summary: record?.summary ?? "",
      tags: [],
      revision: 0,
      createdAt: "",
      updatedAt: "",
      linkDegree: 0,
    });
  }

  for (const page of pages) {
    if (!includeMembership) continue;
    if (domainPages.get(page.domain)?.slug === page.slug) continue;
    // Membership, not a citation: the domain is where the page is filed, which
    // is exactly the fact the tree already shows and the graph was dropping.
    addEdge(page.slug, page.domain);
  }

  const maxDegree = Math.max(1, ...[...known.keys()].map((slug) => degrees.get(slug) ?? 0));
  const nodes = [...known.values()].map((page) => {
    const slug = page.slug;
    // A composed domain page keeps the name on its record, which is the one
    // the reader renames.
    const record = domainPages.get(slug) === page ? records.get(slug) : undefined;
    const degree = degrees.get(slug) ?? 0;
    const angle = ((hash(slug) % 3600) / 3600) * Math.PI * 2;
    // High-degree nodes start inwards, so the simulation begins from roughly the shape it
    // is trying to reach and settles in a second rather than in ten. `sqrt`
    // keeps one very well-connected page from pushing everything else onto the
    // rim, and the jitter — a second hash of the same slug — stops equal-degree
    // pages from all landing on one ring and reading as a bullseye.
    const jitter = (hash(`${slug}:r`) % 1000) / 1000 - 0.5;
    const radius = Math.min(
      1,
      Math.max(0.2, 1 - Math.sqrt(degree / maxDegree) * 0.7 + jitter * 0.3),
    );
    const halfX = GRAPH_WIDTH / 2;
    const halfY = GRAPH_HEIGHT / 2;
    return {
      slug,
      title: record?.title ?? page.title,
      summary: page.summary,
      kind: page.kind,
      domain: page.domain,
      degree,
      x: halfX + Math.cos(angle) * radius * halfX * 0.9,
      y: halfY + Math.sin(angle) * radius * halfY * 0.9,
      r: nodeRadius(degree),
      openable: pageBySlug.has(slug),
    };
  });
  return { nodes, edges };
}

/**
 * One step of a spring-electrical layout, with overlap treated as a hard
 * constraint rather than as another force.
 *
 * The separation pass runs *after* the forces and moves circles apart until
 * they do not intersect, which is the difference between "usually readable" and
 * readable. Written as a repulsion term instead, two nodes pulled together by a
 * strong edge sit on top of each other at equilibrium — and the pile-ups happen
 * exactly where the graph is densest, which is where a reader most wants to
 * look.
 *
 * Pure and in-place on a copy: same input, same output, so the settled layout
 * can be asserted in a unit test without a browser or a clock.
 */
export function relaxGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  alpha: number,
): GraphNode[] {
  const next = nodes.map((node) => ({ ...node }));
  const at = new Map(next.map((node) => [node.slug, node]));
  const centreX = GRAPH_WIDTH / 2;
  const centreY = GRAPH_HEIGHT / 2;
  // The distance a well-spread graph would put between neighbours. Scaling by
  // 1/sqrt(n) is what keeps a four-page wiki from flying apart and a
  // four-hundred-page one from collapsing into a dot. Uses the long axis so a
  // wider canvas still opens enough to fill it.
  const ideal = (GRAPH_WIDTH * 0.5) / Math.sqrt(Math.max(next.length, 2));

  for (let i = 0; i < next.length; i += 1) {
    for (let j = i + 1; j < next.length; j += 1) {
      const a = next[i];
      const b = next[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distance = Math.hypot(dx, dy);
      if (distance < 0.01) {
        // Two nodes at the same point have no direction to separate along, so
        // one is nudged off the axis deterministically rather than randomly.
        dx = ((hash(a.slug) % 100) / 100 - 0.5) * 0.1 + 0.01;
        dy = ((hash(b.slug) % 100) / 100 - 0.5) * 0.1 + 0.01;
        distance = Math.hypot(dx, dy);
      }
      // Coulomb, capped: an uncapped 1/d² sends a pair that happens to start
      // close flying to opposite corners on the first frame.
      const push = Math.min((ideal * ideal) / (distance * distance), ideal * 2);
      const fx = (dx / distance) * push * alpha;
      const fy = (dy / distance) * push * alpha;
      a.x += fx;
      a.y += fy;
      b.x -= fx;
      b.y -= fy;
    }
  }

  for (const edge of edges) {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (!from || !to || from === to) continue;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.max(Math.hypot(dx, dy), 0.01);
    const pull = ((distance - ideal) / distance) * alpha * 0.12;
    from.x += dx * pull;
    from.y += dy * pull;
    to.x -= dx * pull;
    to.y -= dy * pull;
  }

  for (const node of next) {
    // A weak pull home, so a component with no edges at all does not drift off
    // the canvas on repulsion alone.
    node.x += (centreX - node.x) * alpha * 0.02;
    node.y += (centreY - node.y) * alpha * 0.02;
  }

  separate(next);
  fill(next);

  for (const node of next) {
    // Clamped last, so a node pinned to the wall by the clamp is still pushed
    // off it by the next frame's separation rather than being buried under a
    // neighbour there.
    node.x = Math.min(GRAPH_WIDTH - node.r, Math.max(node.r, node.x));
    node.y = Math.min(GRAPH_HEIGHT - node.r, Math.max(node.r, node.y));
  }
  return next;
}

/**
 * Grow the settled layout until it uses the canvas it was given.
 *
 * Separation sets a hard floor on how close two nodes may be, and that floor —
 * not the repulsion — is what ends up deciding the size of a dense graph. Fifty
 * pages therefore settle into a tight ball in the middle of a large empty
 * card, which wastes the whole reason for making this pane wide.
 *
 * Only ever scales **up**. Scaling down would pull circles back through each
 * other and undo the separation that just ran, so the one direction that can
 * silently reintroduce overlap is the one direction this will not go.
 */
function fill(nodes: GraphNode[]): void {
  if (nodes.length < 2) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.r);
    minY = Math.min(minY, node.y - node.r);
    maxX = Math.max(maxX, node.x + node.r);
    maxY = Math.max(maxY, node.y + node.r);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) return;
  const usableW = GRAPH_WIDTH - GRAPH_MARGIN * 2;
  const usableH = GRAPH_HEIGHT - GRAPH_MARGIN * 2;
  // Per axis, not one scale for both. A single uniform factor is capped by
  // whichever direction fills first, so a blob 90% as tall as the canvas stops
  // growing while it is still only 70% as wide — which is most of the empty
  // space this exists to remove. Anisotropy is bounded so the picture is never
  // visibly stretched, and since neither axis ever shrinks, separation cannot
  // be undone by it.
  const wide = Math.max(1, usableW / width);
  const tall = Math.max(1, usableH / height);
  // Neither axis may outrun the other by more than a quarter, so the graph
  // fills its rectangle without being visibly pulled into an ellipse.
  const cap = Math.min(wide, tall) * 1.25;
  // Eased rather than applied outright, so the spread is part of the settle a
  // reader watches instead of a jump on the frame it first fits.
  const ease = (target: number) => 1 + (Math.min(target, cap) - 1) * 0.18;
  const scaleX = ease(wide);
  const scaleY = ease(tall);
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const halfX = GRAPH_WIDTH / 2;
  const halfY = GRAPH_HEIGHT / 2;
  for (const node of nodes) {
    node.x = halfX + (node.x - centreX) * scaleX;
    node.y = halfY + (node.y - centreY) * scaleY;
  }
}

/** Breathing room kept between the outermost node and the canvas edge. */
const GRAPH_MARGIN = 3;

/**
 * The gap left between two circles that have just been pushed apart.
 *
 * Generous, because "not overlapping" and "readable" are different bars. At a
 * hair's clearance fifty tangent circles read as one shape with seams in it,
 * which is no easier to pick a node out of than a pile.
 */
const NODE_GAP = 1.6;

function separate(nodes: GraphNode[]): void {
  // Several passes, because moving one pair apart can push either half into a
  // third node. Four is enough for the densities a personal wiki reaches and
  // is a fixed cost rather than a loop that might not terminate.
  for (let pass = 0; pass < 4; pass += 1) {
    let moved = false;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const minimum = a.r + b.r + NODE_GAP;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= minimum) continue;
        moved = true;
        const unitX = distance < 0.01 ? 1 : dx / distance;
        const unitY = distance < 0.01 ? 0 : dy / distance;
        const shift = (minimum - distance) / 2;
        a.x -= unitX * shift;
        a.y -= unitY * shift;
        b.x += unitX * shift;
        b.y += unitY * shift;
      }
    }
    if (!moved) return;
  }
}

/**
 * Run the layout to rest.
 *
 * The component animates the same steps one frame at a time to get the settle
 * a reader can watch; this is the same computation with the clock removed, so a
 * test can assert the property that actually matters — that nothing overlaps.
 */
export function settleGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  steps = 260,
): GraphNode[] {
  let current = nodes;
  for (let step = 0; step < steps; step += 1) {
    current = relaxGraph(current, edges, coolingAt(step, steps));
  }
  return current;
}

/**
 * How hard a given step pushes. High and falling, so the graph flings itself
 * open and then eases into place — which is the wobble that makes a settling
 * graph legible: you see which nodes came from where.
 */
export function coolingAt(step: number, steps: number): number {
  return 0.06 + 0.94 * Math.pow(1 - step / Math.max(steps, 1), 2.2);
}

/** Longest label drawn on the graph, and the em-width its font measures at. */
export const LABEL_CHARS = 18;
const LABEL_EM = 1.9;
const LABEL_CHAR_WIDTH = LABEL_EM * 0.52;
const LABEL_HEIGHT = LABEL_EM * 1.15;

export function labelText(title: string): string {
  return title.length > LABEL_CHARS ? `${title.slice(0, LABEL_CHARS - 1)}…` : title;
}

/**
 * Which nodes get their name drawn beside them.
 *
 * Only the highest-degree nodes, and only where the name actually fits. Every label is checked
 * against every *circle* as well as against every label already placed —
 * checking labels against each other alone is what produced names lying across
 * the middle of unrelated nodes, which is worse than no label at all because it
 * damages two things to say one.
 *
 * Returns where each label goes rather than only which ones survive, because
 * the slot a label won is part of the answer — a name that cleared the crowd by
 * sitting to the right has to be *drawn* to the right. Lives here rather than
 * in the component so the collision rule can be asserted without a DOM.
 */
export function placeLabels(
  nodes: GraphNode[],
  max = 8,
): Map<string, LabelPlacement> {
  const ranked = [...nodes].sort((a, b) => {
    // Domains first: a domain page is the name the tree already uses for a
    // cluster, and ranking by degree alone buried a new domain under whatever
    // older page still collected the most wiki links.
    const isDomain = (node: GraphNode) => (node.kind === "domain" ? 1 : 0);
    return isDomain(b) - isDomain(a) || b.degree - a.degree || a.slug.localeCompare(b.slug);
  });
  const boxes: Box[] = [];
  const placed = new Map<string, LabelPlacement>();

  for (const node of ranked) {
    if (placed.size >= max) break;
    // Domain pages always try for a label — a domain with one page still needs
    // its name on the map. Everything else keeps the degree floor so a sparse
    // graph does not fill with noise.
    if (node.kind !== "domain" && node.degree < 2) continue;
    const box = labelBoxes(node).find(
      (candidate) =>
        candidate.x0 >= 0 &&
        candidate.x1 <= GRAPH_WIDTH &&
        candidate.y0 >= 0 &&
        candidate.y1 <= GRAPH_HEIGHT &&
        !boxes.some((already) => boxesOverlap(already, candidate)) &&
        !nodes.some(
          (other) => other.slug !== node.slug && circleHitsBox(other, candidate),
        ),
    );
    if (!box) continue;
    boxes.push(box);
    placed.set(node.slug, labelAnchor(node, box));
  }
  return placed;
}

export type LabelPlacement = {
  x: number;
  y: number;
  anchor: "middle" | "start" | "end";
};

/**
 * Where a node's name could go, best first: below, then above, then out to
 * either side.
 *
 * One fixed position was tried first and it inverted the whole point of
 * labelling. The highest-degree node is by definition the one with the most neighbours crowded
 * around it, so it is the node whose one candidate slot is most likely to be
 * occupied — and the labels all ended up on the sparse *rim*, under a legend
 * promising that the highest-degree nodes carry their names.
 */
export function labelBoxes(node: GraphNode): Box[] {
  return labelSlots({
    x: node.x,
    y: node.y,
    clear: node.r + 0.6,
    width: labelText(node.title).length * LABEL_CHAR_WIDTH,
    height: LABEL_HEIGHT,
  });
}

/**
 * Where a name could sit beside a dot, best first, in whatever units the
 * caller measures in.
 *
 * Unit-free on purpose: the rail lays the graph out in its own 160×90 space
 * and the whole-account canvas works in screen pixels at whatever zoom the
 * reader has chosen, and the two must not each grow their own idea of where a
 * label may go. Both call this; only the numbers differ.
 *
 * Four orthogonal slots, then the four diagonals. The orthogonals come first
 * because a name reads best directly under or beside its dot, and the
 * diagonals exist because a dense cluster occupies all four of them at once —
 * which on a 97-node graph is most of the middle. Ordering matters more than
 * the count: the first slot that clears is taken, so a label only reaches a
 * corner when nothing squarer was free.
 */
export function labelSlots(at: {
  x: number;
  y: number;
  clear: number;
  width: number;
  height: number;
}): Box[] {
  const { x, y, clear, width, height } = at;
  const centred = (cx: number, cy: number): Box => ({
    x0: cx - width / 2,
    y0: cy,
    x1: cx + width / 2,
    y1: cy + height,
  });
  const beside = (x0: number, cy: number): Box => ({
    x0,
    y0: cy - height / 2,
    x1: x0 + width,
    y1: cy + height / 2,
  });
  const diagonal = clear * 0.72;
  return [
    centred(x, y + clear),
    centred(x, y - clear - height),
    beside(x + clear, y),
    beside(x - clear - width, y),
    beside(x + diagonal, y + diagonal + height / 2),
    beside(x - diagonal - width, y + diagonal + height / 2),
    beside(x + diagonal, y - diagonal - height / 2),
    beside(x - diagonal - width, y - diagonal - height / 2),
  ];
}

/** Where a label was actually placed, so the renderer draws it in that slot. */
export function labelAnchor(node: GraphNode, box: Box): LabelPlacement {
  // Baseline sits near the bottom of the box; SVG text grows upward from it.
  const y = box.y1 - LABEL_EM * 0.25;
  if (Math.abs(box.x0 + box.x1 - node.x * 2) < 0.01) {
    return { x: node.x, y, anchor: "middle" };
  }
  return box.x0 > node.x
    ? { x: box.x0, y, anchor: "start" }
    : { x: box.x1, y, anchor: "end" };
}

export type Box = { x0: number; y0: number; x1: number; y1: number };

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/**
 * Does a dot intrude on a name's box?
 *
 * Checking labels against each other alone is what produced names lying across
 * the middle of unrelated nodes — worse than no label, because it damages two
 * things to say one.
 */
export function circleHitsBox(
  circle: { x: number; y: number; r: number },
  box: Box,
): boolean {
  return circleReach(circle, box) > 0;
}

/** How far a circle reaches into a box; zero when it stays clear. */
export function circleReach(
  circle: { x: number; y: number; r: number },
  box: Box,
): number {
  const nearestX = Math.max(box.x0, Math.min(circle.x, box.x1));
  const nearestY = Math.max(box.y0, Math.min(circle.y, box.y1));
  return Math.max(0, circle.r - Math.hypot(circle.x - nearestX, circle.y - nearestY));
}

type Ring = { x: number; y: number; r: number };

/**
 * How much larger a map's dots and names are drawn for the room it has.
 *
 * One in the field a 14-inch screen gives that map (`reference`, the field's
 * √area in CSS pixels there), growing with the field's linear size and
 * stopping at twice that, so a 30-inch screen gets legible type rather than a
 * poster. Every placement rule takes its sizes from this, never a second idea
 * of scale.
 */
export function graphScale(width: number, height: number, reference: number): number {
  if (!(width > 0) || !(height > 0)) return 1;
  return Math.max(1, Math.min(2, Math.sqrt(width * height) / reference));
}

/**
 * Where a domain's name goes on the graph, in screen pixels; null when no place
 * by its ring is on the field, as for a domain zoomed out of view or a big ring
 * whose only visible arc lies far below its top: a name there labels nothing.
 *
 * A name stays against its own ring, where it reads as that domain's: above
 * it, else below, slid along it, a row further out or broken onto two lines.
 * Each place is scored by how far it strays and by what it would cover: a
 * name already placed above all, then another domain's dots, then how deep it
 * reaches into another domain's ring, so a name grazing a neighbour stays
 * home rather than wandering across the field.
 */
export function placeDomainName(name: {
  text: string;
  ring: Ring;
  /** How far above its ring the name floats. */
  lift: number;
  /** `graphScale`: the pill's padding grows with its type. */
  scale?: number;
  field: { width: number; height: number };
  measure: (line: string) => number;
  placed: Box[];
  /** Other domains' dots and rings. */
  dots: Ring[];
  rings: Ring[];
}): (Box & { lines: string[] }) | null {
  const { text, ring, lift, measure, placed } = name;
  const scale = name.scale ?? 1;
  const { width, height } = name.field;
  if (!circleHitsBox(ring, { x0: 0, y0: 0, x1: width, y1: height })) return null;
  // The name on one line, and broken at whichever space evens its halves.
  const words = text.split(" ");
  const broken = words.slice(1).map((_, at) => [words.slice(0, at + 1).join(" "), words.slice(at + 1).join(" ")])
    .sort((left, right) => Math.max(...left.map(measure)) - Math.max(...right.map(measure)))[0];
  // A slide of half the name strays about as far as a row, going below the
  // ring half as far again, two lines a little more.
  const slots = [[text], ...(broken ? [broken] : [])].flatMap((lines, wrapped) => {
    const half = Math.max(...lines.map(measure)) / 2 + 9 * scale;
    const tall = (lines.length * 6 + 4) * scale;
    const reach = ring.r + lift - 10 * scale + tall;
    return [-1, 1].flatMap((side) => [0, 1, 2].flatMap((row) => [0, -0.5, 0.5, -1, 1].flatMap((slide) => {
      // Nudged in from the side, as the hover bubble is, rather than lost;
      // but never so far that it leaves its ring.
      const x = Math.max(half, Math.min(width - half, ring.x + slide * half));
      const y = ring.y + side * (reach + row * tall * 2);
      const slot = { lines, x0: x - half, y0: y - tall, x1: x + half, y1: y + tall, stray: row + Math.abs(slide) + (side > 0 ? 0.5 : 0) + wrapped * 0.75 };
      return circleHitsBox({ ...ring, r: reach + tall * 4 }, slot) ? [slot] : [];
    })));
  });
  if (!slots.length) return null;
  // Only what lies within reach of some place can cost anything.
  const area = slots.reduce<Box>((all, slot) => ({
    x0: Math.min(all.x0, slot.x0), y0: Math.min(all.y0, slot.y0), x1: Math.max(all.x1, slot.x1), y1: Math.max(all.y1, slot.y1),
  }), slots[0]);
  const dots = name.dots.filter((dot) => circleHitsBox(dot, area));
  const rings = name.rings.filter((other) => circleHitsBox(other, area));
  const fits = (box: Box) => box.x0 >= 0 && box.x1 <= width && box.y0 >= 0 && box.y1 <= height;
  const overlap = (box: Box) => placed.reduce((sum, already) =>
    sum + Math.max(0, Math.min(box.x1, already.x1) - Math.max(box.x0, already.x0))
      * Math.max(0, Math.min(box.y1, already.y1) - Math.max(box.y0, already.y0)), 0);
  const costs = slots.map((slot) =>
    (fits(slot) ? 0 : 1e6) + overlap(slot) * 4 + slot.stray * 10
    + dots.filter((dot) => circleHitsBox(dot, slot)).length * 40
    + rings.reduce((sum, other) => sum + circleReach(other, slot) * 2, 0));
  const { lines, x0, y0, x1, y1 } = slots[costs.indexOf(Math.min(...costs))];
  return x1 < 0 || x0 > width || y1 < 0 || y0 > height ? null : { lines, x0, y0, x1, y1 };
}

function hash(value: string): number {
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    total = (total * 31 + value.charCodeAt(index)) >>> 0;
  }
  return total;
}

/**
 * The one place the new `edits` array and the old `pages: string[]` reconcile.
 *
 * Two surfaces read events for what they touched — the Log, and the "changed
 * today" census — and without this each would grow its own compatibility
 * branch, which would then drift. An event written before `edits` existed
 * still yields one row per slug; it simply has no title, kind or action to
 * show, so it renders as the pass's own summary.
 */
export function eventEdits(
  event: MemoryEvent,
  pages?: Map<string, MemoryPageSummary>,
): MemoryEdit[] {
  if (event.edits?.length) return event.edits;
  return (event.pages ?? []).map((slug) => {
    const page = pages?.get(slug);
    return {
      slug,
      title: page?.title ?? slug.replaceAll("-", " "),
      // Null, not a guess. The old shape recorded a slug and nothing else, so
      // the kind and the action are facts this event does not hold — and a row
      // that says "concept page" about a source is a small lie told
      // confidently, which is the failure mode this whole change exists to
      // stop. The page list fills in what it can; the rest is left unsaid.
      kind: page?.kind ?? null,
      action: null,
      note: null,
    };
  });
}

export type EditGroup<T> = {
  key: string;
  label: string;
  /** Every edit under this heading, for the `TODAY • 3 EDITS` count. */
  edits: MemoryEdit[];
  /** The passes themselves, kept so a day's card can still tell them apart. */
  entries: T[];
};

/**
 * Group passes under the day they ran, newest day first.
 *
 * The day comes off the *pass*, not off an edit: an edit carries no clock of
 * its own, and a card whose rows straddled a heading would claim otherwise.
 *
 * Within the last week the weekday is what a reader orients by ("Tuesday"),
 * and beyond it a date is — a weekday three weeks back names four different
 * days. Order is preserved, so groups arrive in whatever order the log served.
 */
export function groupEditsByDay<T extends { at: string; edits: MemoryEdit[] }>(
  entries: T[],
  now = Date.now(),
): Array<EditGroup<T>> {
  const groups: Array<EditGroup<T>> = [];
  const byKey = new Map<string, EditGroup<T>>();
  const today = startOfDay(now);
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    const key = Number.isNaN(at) ? "unknown" : new Date(startOfDay(at)).toISOString();
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: dayLabel(at, today), edits: [], entries: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.edits.push(...entry.edits);
    group.entries.push(entry);
  }
  return groups;
}

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayLabel(at: number, today: number): string {
  if (Number.isNaN(at)) return "Earlier";
  const days = Math.round((today - startOfDay(at)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(at);
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

/**
 * Edits per day for the last `days` days, oldest first, ending today.
 *
 * Counted the way the log counts rows: a pass that filed nothing is still one
 * thing that happened. Days without a pass are zeros rather than gaps, so a
 * chart drawn from this keeps one bar per day.
 */
export function dailyEditCounts<T extends { at: string; edits: MemoryEdit[] }>(
  entries: T[],
  days = 14,
  now = Date.now(),
): Array<{ start: number; count: number }> {
  const today = startOfDay(now);
  const counts = Array.from({ length: days }, (_, index) => ({
    start: startOfDay(today - (days - 1 - index) * 86_400_000 + 43_200_000),
    count: 0,
  }));
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) continue;
    const day = startOfDay(at);
    const slot = counts.find((candidate) => candidate.start === day);
    if (slot) slot.count += Math.max(entry.edits.length, 1);
  }
  return counts;
}

/**
 * Cards, then chips, then the rest — the Health column's one shape.
 *
 * A findings list has no natural length: three orphaned pages is a list, and
 * forty is a wall. The first few get room to say who named them, the next few
 * are chips, and everything after that stays behind a count until asked for.
 */
export function splitFindings<T>(
  items: T[],
  cards = 4,
  chips = 4,
): { cards: T[]; chips: T[]; rest: T[] } {
  return {
    cards: items.slice(0, cards),
    chips: items.slice(cards, cards + chips),
    rest: items.slice(cards + chips),
  };
}

