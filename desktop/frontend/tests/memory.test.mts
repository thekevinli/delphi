import assert from "node:assert/strict";
import test from "node:test";

import {
  graphScale,
  summaryRepeatsBody,
  boundedView,
  citationSection,
  citationsBySection,
  knownPages,
  wikiLinkText,
  wikiLinkWords,
  GRAPH_ASPECT,
  GRAPH_HEIGHT,
  GRAPH_VIEW_HOME,
  GRAPH_WIDTH,
  buildGraph,
  graphPreviewExcerpt,
  coolingAt,
  figureSrc,
  isMemorySlug,
  memoryPath,
  memoryAskHref,
  MAX_SEEDED_QUESTION,
  holdMemoryAsk,
  peekMemoryAsk,
  clearMemoryAsk,
  memorySlug,
  labelAnchor,
  boxesOverlap,
  circleHitsBox,
  labelBoxes,
  labelSlots,
  placeDomainName,
  panGraphView,
  placeLabels,
  relatedMemory,
  settleGraph,
  splitWikiLinks,
  zoomGraphView,
} from "../app/lib/memory.ts";

test("a slug is the same alphabet the backend mints", () => {
  // A slug crosses the wire in both directions: the model types one into a
  // page body, the reader clicks one. The browser has to be able to normalise
  // a `[[Link]]` written in prose without asking the server what it meant.
  assert.equal(memorySlug("KL Divergence"), "kl-divergence");
  assert.equal(memorySlug("     Rényi's α  "), "renyis");
  assert.equal(memorySlug("!!!"), "");
  assert.ok(memorySlug("x".repeat(200)).length <= 60);
});

test("only a well-formed slug reaches a request", () => {
  assert.equal(isMemorySlug("kl-divergence"), true);
  // `?page=` is a value anyone can write, including someone sending a link.
  assert.equal(isMemorySlug("../../etc/passwd"), false);
  assert.equal(isMemorySlug("Not A Slug"), false);
  assert.equal(isMemorySlug("a".repeat(61)), false);
});

test("a wiki link keeps its shown text and its target apart", () => {
  const segments = splitWikiLinks(
    "Rests on [[KL Divergence]] and [[elbo|the bound]].",
  );

  assert.deepEqual(
    segments.map((segment) =>
      segment.kind === "link" ? [segment.slug, segment.label] : segment.text,
    ),
    [
      "Rests on ",
      ["kl-divergence", "KL Divergence"],
      " and ",
      ["elbo", "the bound"],
      ".",
    ],
  );
});

test("a bracket pair that cannot become a slug stays plain text", () => {
  // Otherwise a piece of prose becomes a button that navigates nowhere.
  const segments = splitWikiLinks("An array index like [[!!!]] is not a link.");

  assert.ok(segments.every((segment) => segment.kind === "text"));
});

test("only a Delphi locator resolves to an image", () => {
  assert.match(figureSrc("figure:abc123") ?? "", /\/api\/memory\/figures\/abc123$/);
  // A remote address in a rendered body is the favicon problem with a much
  // larger blast radius: it leaks the reader's IP and referrer to whichever
  // host the model named, and it rots.
  assert.equal(figureSrc("https://example.test/fig.png"), null);
  assert.equal(figureSrc("/api/memory/figures/abc123"), null);
  // An id outside the safe alphabet is not a locator either — it would be
  // spliced straight into a URL.
  assert.equal(figureSrc("figure:../../etc"), null);
  assert.equal(figureSrc(undefined), null);
});

test("a page address is a query, not a path segment", () => {
  // `/memory` is a static route; making the slug a segment would put
  // it back in competition with the reader's `[project]/[paper]` routes.
  assert.equal(memoryPath("kl-divergence"), "/memory?page=kl-divergence");
  assert.equal(memoryPath("a b"), "/memory?page=a%20b");
});

test("Graph and Health send a question to the wiki rail, not a second chat", () => {
  // Those routes have no rail to dock in. `q` is bounded and the wiki drops
  // it after the turn is sent, so a reload does not spend another model call
  // (invariant 46).
  assert.equal(memoryAskHref(), "/memory?ask=1");
  assert.equal(
    memoryAskHref("does distillation beat RL"),
    "/memory?ask=1&q=does%20distillation%20beat%20RL",
  );
  const seeded = memoryAskHref(`  ${"x".repeat(500)}  `);
  const asked = new URL(seeded, "https://delphi.test").searchParams.get("q");
  assert.equal(asked?.length, MAX_SEEDED_QUESTION);

  holdMemoryAsk({ prompt: "what is ELBO", imageIds: ["a", "", "b"] });
  assert.deepEqual(peekMemoryAsk(), {
    prompt: "what is ELBO",
    imageIds: ["a", "b"],
  });
  clearMemoryAsk();
  assert.equal(peekMemoryAsk(), null);
});

function page(overrides: Partial<import("../app/lib/api.ts").MemoryPageSummary> = {}): import("../app/lib/api.ts").MemoryPageSummary {
  return {
    id: "1",
    slug: "kl-divergence",
    kind: "concept",
    domain: "ml",
    title: "KL divergence",
    summary: "why it appears in the ELBO",
    tags: [],
    revision: 1,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    linkDegree: 0,
    ...overrides,
  };
}

test("a link that points at no page is not a place on any graph", () => {
  const pages = [page({ slug: "vae", title: "VAE" })];
  const links = [{ from: "vae", to: "amortized-inference" }];

  // Where the link is read it is plain words, so it is neither a node nor a
  // line. Dropped at the edge, so nothing is left drawing a line to nowhere,
  // and the degree the radii and the seed layout scale from does not count it.
  const graph = buildGraph(pages, links);
  assert.equal(graph.nodes.find((node) => node.slug === "amortized-inference"), undefined);
  assert.deepEqual(graph.edges, [{ from: "vae", to: "ml" }]);
  assert.equal(graph.nodes.find((node) => node.slug === "vae")?.degree, 1);
  assert.ok(graph.nodes.every((node) => ["domain", "concept", "source"].includes(node.kind)));

  // A rail draws no membership, so the page stands alone.
  const rail = buildGraph(pages, links, [], { includeMembership: false });
  assert.deepEqual(rail.nodes.map((node) => node.slug), ["vae"]);
  assert.deepEqual(rail.edges, []);
});

test("a domain is drawn from its record, and opens only once its page is written", () => {
  const record = { slug: "ml", title: "Machine Learning", summary: "How models are trained." };
  const members = [page({ slug: "vae", title: "VAE" })];

  // No page behind it: the node is the record, and there is nothing to open.
  const bare = buildGraph(members, [], [record]).nodes.find((node) => node.slug === "ml");
  assert.equal(bare?.kind, "domain");
  assert.equal(bare?.title, "Machine Learning");
  assert.equal(bare?.summary, "How models are trained.");
  assert.equal(bare?.openable, false);

  // Composed: the page opens and lends its summary, under the record's name.
  const composed = page({ slug: "ml", kind: "domain", title: "machine learning", summary: "Two papers on one budget." });
  const graph = buildGraph([...members, composed], [{ from: "ml", to: "vae" }], [record]);
  const written = graph.nodes.find((node) => node.slug === "ml");
  assert.equal(written?.title, "Machine Learning");
  assert.equal(written?.summary, "Two papers on one budget.");
  assert.equal(written?.openable, true);
  // Its link to a member and that member's membership are one line.
  assert.deepEqual(graph.edges, [{ from: "ml", to: "vae" }]);

  // A domain nothing is filed under is not on the map; one no record covers is named by its slug.
  const stray = buildGraph([page({ slug: "solo", domain: "guitar" })], [], [record]);
  assert.deepEqual(stray.nodes.map((node) => [node.slug, node.title]).sort(), [["guitar", "guitar"], ["solo", "KL divergence"]]);
});

test("graph previews reuse the overview summary and keep the excerpt short", () => {
  const summary =
    "Training against a checkable answer rather than a learned preference model is the emphasis that separates one reasoning method from another in practice.";
  const { nodes } = buildGraph(
    [page({ slug: "rewards", title: "Verifiable rewards", summary })],
    [],
  );

  assert.equal(nodes.find((node) => node.slug === "rewards")?.summary, summary);
  assert.equal(
    graphPreviewExcerpt(summary, 8),
    "Training against a checkable answer rather than a…",
  );
});

test("graph previews show a Markdown summary as its words, without the marks", () => {
  assert.equal(
    graphPreviewExcerpt("**Central takeaway.** LingBot-VA 2.0 is designed *from scratch* for `robot` control.", 40),
    "Central takeaway. LingBot-VA 2.0 is designed from scratch for robot control.",
  );
  assert.equal(
    graphPreviewExcerpt("See [[flow-matching|flow matching]] and [the paper](https://example.com); snake_case_names stay.", 40),
    "See flow matching and the paper; snake_case_names stay.",
  );
});

test("every domain the tree knows about is a labelled node on the graph", () => {
  // A reader-named domain with pages filed into it but no `domain`-kind page
  // page used to be invisible here: the sidebar drew two domains and the graph
  // labelled one. Membership edges make the domain a real node without inventing
  // wiki links the bodies do not carry.
  const pages = [
    page({ slug: "ml", kind: "domain", domain: "ml", title: "Machine learning" }),
    page({ slug: "distillation", domain: "ml", title: "Distillation" }),
    page({ slug: "kv-cache", domain: "efficiency", title: "KV cache" }),
    page({ slug: "quantization", domain: "efficiency", title: "Quantization" }),
  ];
  const { nodes, edges } = buildGraph(
    pages,
    [{ from: "distillation", to: "ml" }],
    [
      { slug: "ml", title: "Machine learning" },
      { slug: "efficiency", title: "Efficiency & serving" },
    ],
  );

  const efficiency = nodes.find((node) => node.slug === "efficiency");
  assert.ok(efficiency);
  assert.equal(efficiency.kind, "domain");
  assert.equal(efficiency.title, "Efficiency & serving");
  assert.equal(efficiency.openable, false);
  assert.ok(
    edges.some(
      (edge) =>
        (edge.from === "kv-cache" && edge.to === "efficiency") ||
        (edge.from === "efficiency" && edge.to === "kv-cache"),
    ),
  );
  // The real domain page stays openable; the synthetic domain does not.
  assert.equal(nodes.find((node) => node.slug === "ml")?.openable, true);

  const labels = placeLabels(nodes);
  assert.ok(labels.has("ml"));
  assert.ok(labels.has("efficiency"));
});

test("an empty named domain does not appear on the graph", () => {
  // Same filter as the tree: a destination with nothing in it is not a node.
  const { nodes } = buildGraph(
    [page({ slug: "ml", kind: "domain", domain: "ml", title: "Machine learning" })],
    [],
    [
      { slug: "ml", title: "Machine learning" },
      { slug: "empty", title: "Empty domain" },
    ],
  );
  assert.equal(
    nodes.some((node) => node.slug === "empty"),
    false,
  );
});

test("the layout is deterministic so a page keeps its place", () => {
  const pages = [page({ slug: "a" }), page({ slug: "b" }), page({ slug: "c" })];
  const links = [{ from: "a", to: "b" }];

  const first = buildGraph(pages, links);
  const second = buildGraph(pages, links);

  // The forces run from a seed hashed off each slug rather than from
  // `Math.random`, so the same wiki settles into the same picture every visit.
  // Otherwise "the cluster on the left" is a thing nobody can say twice.
  assert.deepEqual(first.nodes, second.nodes);
  assert.deepEqual(
    settleGraph(first.nodes, first.edges, 40),
    settleGraph(second.nodes, second.edges, 40),
  );
});

test("a settled graph has no two nodes overlapping", () => {
  // The property the whole force pass exists for. Circles drawn on top of each
  // other are unreadable exactly where the graph is densest, which is where a
  // reader most wants to look — and a dense wiki is the case that produces it,
  // so the fixture is dense on purpose.
  const pages = Array.from({ length: 40 }, (_, index) =>
    page({ slug: `p${index}`, title: `Page ${index}` }),
  );
  const links = pages.slice(1).map((entry, index) => ({
    from: entry.slug,
    // A few pages collecting most of the edges: the shape a real wiki has, and
    // the one a naive layout piles up.
    to: `p${index % 4}`,
  }));

  const seed = buildGraph(pages, links);
  const settled = settleGraph(seed.nodes, seed.edges);

  for (let i = 0; i < settled.length; i += 1) {
    for (let j = i + 1; j < settled.length; j += 1) {
      const a = settled[i];
      const b = settled[j];
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
      assert.ok(
        gap >= -0.01,
        `${a.slug} and ${b.slug} overlap by ${(-gap).toFixed(2)}`,
      );
    }
  }
});

test("a settled graph stays inside its canvas", () => {
  // Repulsion is what makes a graph readable and also what throws nodes off
  // the edge of it. A node outside the viewBox is not clipped, it is gone.
  const pages = Array.from({ length: 25 }, (_, index) => page({ slug: `n${index}` }));
  const seed = buildGraph(pages, []);
  const settled = settleGraph(seed.nodes, seed.edges);

  for (const node of settled) {
    assert.ok(node.x >= 0 && node.x <= GRAPH_WIDTH, `${node.slug} x=${node.x}`);
    assert.ok(node.y >= 0 && node.y <= GRAPH_HEIGHT, `${node.slug} y=${node.y}`);
  }
});

test("zooming keeps the anchor point fixed on screen", () => {
  // The point under the cursor — or the two fingers — is the point that must
  // not move. Anchoring at the view's own centre instead is what makes a
  // pinch feel like the map sliding out from under you.
  const anchor = { x: 30, y: 70 };
  const zoomedIn = zoomGraphView(GRAPH_VIEW_HOME, 2, anchor);

  assert.ok(zoomedIn.size < GRAPH_VIEW_HOME.size, "zooming in must shrink the view");
  // The anchor's position within the new view, as a fraction of its size,
  // must match its position within the old one.
  const before = {
    x: (anchor.x - GRAPH_VIEW_HOME.x) / (GRAPH_VIEW_HOME.size * GRAPH_ASPECT),
    y: (anchor.y - GRAPH_VIEW_HOME.y) / GRAPH_VIEW_HOME.size,
  };
  const after = {
    x: (anchor.x - zoomedIn.x) / (zoomedIn.size * GRAPH_ASPECT),
    y: (anchor.y - zoomedIn.y) / zoomedIn.size,
  };
  assert.ok(Math.abs(before.x - after.x) < 1e-9);
  assert.ok(Math.abs(before.y - after.y) < 1e-9);
});

test("zoom and pan cannot lose the graph off the edge of its own canvas", () => {
  // A camera that can wander arbitrarily far, or shrink to a point, leaves a
  // reader looking at an empty card with no way back short of a refresh.
  const zoomedIn = zoomGraphView(GRAPH_VIEW_HOME, 1000, { x: 50, y: 50 });
  const zoomedOut = zoomGraphView(GRAPH_VIEW_HOME, 0.0001, { x: 50, y: 50 });
  const panned = panGraphView(GRAPH_VIEW_HOME, 10_000, -10_000);

  for (const view of [zoomedOut, zoomedIn, panned]) {
    assert.ok(view.size > 0, "the view must never collapse to nothing");
    // The camera must still overlap the graph's own layout rectangle, or
    // there is nothing left on screen to pan back from.
    const width = view.size * GRAPH_ASPECT;
    assert.ok(view.x < GRAPH_WIDTH && view.x + width > 0, `x=${view.x} w=${width}`);
    assert.ok(view.y < GRAPH_HEIGHT && view.y + view.size > 0, `y=${view.y} size=${view.size}`);
  }
});

test("panning by zero moves nothing", () => {
  const view = zoomGraphView(GRAPH_VIEW_HOME, 2, { x: 40, y: 60 });
  assert.deepEqual(panGraphView(view, 0, 0), view);
});

test("a label is never drawn across another node", () => {
  // The rule that matters: a name lying over an unrelated circle damages two
  // things in order to say one, so it is dropped rather than drawn. Checking
  // labels only against each other — which is what this did first — leaves
  // exactly that failure in place.
  const pages = Array.from({ length: 30 }, (_, index) =>
    page({ slug: `p${index}`, title: `A fairly long page title ${index}` }),
  );
  const links = pages.slice(1).map((entry, index) => ({
    from: entry.slug,
    to: `p${index % 3}`,
  }));
  const seed = buildGraph(pages, links);
  const settled = settleGraph(seed.nodes, seed.edges);
  const named = placeLabels(settled);

  assert.ok(named.size > 0, "no node was labelled at all");
  const byline = new Map(settled.map((node) => [node.slug, node]));
  for (const [slug, placement] of named) {
    const node = byline.get(slug);
    assert.ok(node);
    // The box the placement came from: whichever of the four candidate slots
    // its anchor identifies.
    const box = labelBoxes(node).find(
      (candidate) =>
        Math.abs(labelAnchor(node, candidate).x - placement.x) < 0.01 &&
        Math.abs(labelAnchor(node, candidate).y - placement.y) < 0.01,
    );
    assert.ok(box, `no candidate slot matches where ${slug} was placed`);
    for (const other of settled) {
      if (other.slug === slug) continue;
      const nearestX = Math.max(box.x0, Math.min(other.x, box.x1));
      const nearestY = Math.max(box.y0, Math.min(other.y, box.y1));
      assert.ok(
        Math.hypot(other.x - nearestX, other.y - nearestY) >= other.r,
        `label for ${slug} lies across ${other.slug}`,
      );
    }
  }
});

test("a node crowded on one side gets its name on another", () => {
  // The failure this exists for: the highest-degree node is by definition the one with the most
  // neighbours around it, so with one fixed slot it is the *least* likely node
  // to keep its label — and the names all migrated to the sparse rim, under a
  // legend saying the highest-degree nodes carry theirs.
  const pages = Array.from({ length: 12 }, (_, index) =>
    page({ slug: `p${index}`, title: `Page ${index}` }),
  );
  const seed = buildGraph(pages, pages.slice(1).map((entry) => ({
    from: entry.slug,
    to: "p0",
  })));
  const settled = settleGraph(seed.nodes, seed.edges);
  const busiest = settled.find((node) => node.slug === "p0");

  assert.ok(busiest);
  // Eleven wiki spokes plus one membership edge to the domain.
  assert.equal(busiest.degree, 12);
  assert.ok(placeLabels(settled).has("p0"), "the busiest node lost its name");
});

test("the settle cools rather than running flat out", () => {
  // The wobble is the point: it opens hard and eases in, so a reader can see
  // which nodes were pulled together by links rather than being handed a
  // finished picture that appeared from nowhere.
  assert.ok(coolingAt(0, 100) > coolingAt(50, 100));
  assert.ok(coolingAt(50, 100) > coolingAt(99, 100));
  assert.ok(coolingAt(100, 100) > 0);
});

test("a self link is not an edge", () => {
  // A page that mentions its own name would otherwise draw a loop and count
  // itself twice toward its own degree. Domain equals slug so membership is
  // the same pair and is skipped the same way.
  const { edges } = buildGraph(
    [page({ slug: "vae", domain: "vae" })],
    [{ from: "vae", to: "vae" }],
  );

  assert.equal(edges.length, 0);
});

test("related Memory renders the server neighborhood and sorts useful pages", () => {
  const pages = [
    page({ slug: "busiest", domain: "ml", kind: "source", title: "Busiest source" }),
    page({ slug: "concept-b", domain: "ml", kind: "concept", title: "Beta" }),
    page({ slug: "concept-a", domain: "ml", kind: "concept", title: "Alpha" }),
    page({ slug: "area", domain: "ml", kind: "domain", title: "Machine learning notes" }),
    page({ slug: "far", domain: "other", kind: "source", title: "Far away" }),
  ];
  const result = relatedMemory(
    "busiest",
    pages,
    [
      { from: "concept-b", to: "busiest" }, // incoming still counts
      { from: "busiest", to: "concept-a" },
      { from: "concept-a", to: "area" },
      { from: "area", to: "unwritten" },
    ],
    [{ slug: "ml", title: "Machine learning" }, { slug: "other", title: "Other" }],
    { busiest: 0, "concept-b": 1, "concept-a": 1, area: 2 },
  );

  assert.equal(result.distances.get("concept-b"), 1);
  assert.equal(result.distances.get("area"), 2);
  assert.ok(!result.nodes.some((node) => node.slug === "ml"), "membership must not create a traversal shortcut");
  assert.ok(!result.nodes.some((node) => node.slug === "unwritten"), "third step leaked in");
  assert.deepEqual(result.pages.map((entry) => entry.slug), [
    "concept-a", "concept-b", "area",
  ]);
});

test("related Memory obeys server distances without inventing domain shortcuts", () => {
  const pages = [page({ slug: "center", domain: "ml" }), page({ slug: "neighbor", domain: "ml" }), page({ slug: "sibling", domain: "ml" })];
  const result = relatedMemory("center", pages,
    [{ from: "neighbor", to: "center" }, { from: "neighbor", to: "sibling" }],
    [{ slug: "ml", title: "ML" }], { center: 0, neighbor: 1 });
  assert.deepEqual(result.pages.map((entry) => entry.slug), ["neighbor"]);
  assert.ok(!result.nodes.some((node) => node.slug === "ml" || node.slug === "sibling"));
});

test("a missing source center never falls back to a concept or a domain", () => {
  const pages = [
    page({ slug: "domain-page", kind: "domain", sourcePaperId: "paper-1" }),
    page({ slug: "concept-b", kind: "concept", sourcePaperId: "paper-1" }),
    page({ slug: "concept-a", kind: "concept", sourcePaperId: "paper-1" }),
  ];

  const result = relatedMemory("", pages, [], [], {});
  assert.equal(result.pages.length, 0);
  assert.equal(result.nodes.length, 0);
});

test("a label tries square slots before corners, and the canvas shares the rule", () => {
  // One rule, two surfaces: the rail lays out in its own 160x90 space and the
  // whole-account canvas works in screen pixels at whatever zoom the reader
  // chose. Both call `labelSlots`; only the numbers differ. Ordering is what
  // matters more than the count — the first slot that clears is taken, so a
  // name only reaches a corner when nothing squarer was free.
  const slots = labelSlots({ x: 0, y: 0, clear: 4, width: 10, height: 2 });
  assert.equal(slots.length, 8);
  // Below, above, right, left — then the diagonals.
  assert.deepEqual(slots[0], { x0: -5, y0: 4, x1: 5, y1: 6 });
  assert.deepEqual(slots[1], { x0: -5, y0: -6, x1: 5, y1: -4 });
  assert.equal(slots[2].x0, 4);
  assert.equal(slots[3].x1, -4);
  // A diagonal is off both axes, which is the whole reason it is offered.
  assert.ok(slots[4].x0 > 0 && slots[4].y0 > 0);

  // The two predicates the placement is built out of.
  assert.ok(boxesOverlap({ x0: 0, y0: 0, x1: 2, y1: 2 }, { x0: 1, y0: 1, x1: 3, y1: 3 }));
  assert.ok(!boxesOverlap({ x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: 2, y0: 2, x1: 3, y1: 3 }));
  // A dot intruding on a name's box is as disqualifying as another name:
  // checking labels against each other alone is what put names across the
  // middle of unrelated nodes.
  assert.ok(circleHitsBox({ x: 0, y: 0, r: 2 }, { x0: 1, y0: -1, x1: 4, y1: 1 }));
  assert.ok(!circleHitsBox({ x: 0, y: 0, r: 1 }, { x0: 3, y0: -1, x1: 5, y1: 1 }));
});

test("a domain's name stays against its own ring, and an unseen domain names nothing", () => {
  const place = (over: Partial<Parameters<typeof placeDomainName>[0]> = {}) => placeDomainName({
    text: "VISION",
    ring: { x: 200, y: 150, r: 40 },
    lift: 0,
    field: { width: 400, height: 300 },
    measure: (line) => line.length * 6,
    placed: [],
    dots: [],
    rings: [],
    ...over,
  });
  const centre = (box: { x0: number; y0: number; x1: number; y1: number } | null) =>
    box && { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
  // Clear, it sits on the top of its ring.
  assert.deepEqual(centre(place()), { x: 200, y: 110 });
  // A name already there, or another domain's dot, sends it under its own ring
  // rather than off along a neighbour's.
  assert.deepEqual(centre(place({ placed: [{ x0: 150, y0: 95, x1: 250, y1: 125 }] })), { x: 200, y: 190 });
  assert.deepEqual(centre(place({ dots: [{ x: 200, y: 110, r: 3 }] })), { x: 200, y: 190 });
  // Grazing a neighbour's ring keeps it home; lying deep in one does not.
  assert.deepEqual(centre(place({ rings: [{ x: 200, y: 60, r: 42 }] })), { x: 200, y: 110 });
  assert.deepEqual(centre(place({ rings: [{ x: 200, y: 60, r: 50 }] })), { x: 200, y: 190 });
  // Too long for the field on one line, it breaks where the halves are even.
  const narrow = place({ text: "DIFFUSION LANGUAGE MODELS", ring: { x: 60, y: 150, r: 30 }, field: { width: 120, height: 300 } });
  assert.deepEqual(narrow?.lines, ["DIFFUSION", "LANGUAGE MODELS"]);
  assert.ok(narrow && narrow.x0 >= 0 && narrow.x1 <= 120);
  // A ring cut by the edge is nudged in; one wholly off the field, as a
  // zoomed view leaves its neighbours, is not named at the edge at all.
  assert.equal(place({ ring: { x: -30, y: 150, r: 40 } })?.x0, 0);
  assert.equal(place({ ring: { x: -100, y: 150, r: 40 } }), null);
  assert.equal(place({ ring: { x: 200, y: 400, r: 40 } }), null);
  // Nor is a big ring centred off the field, whose top would be nudged in at
  // the edge far from the arc that shows.
  assert.equal(place({ ring: { x: -500, y: 700, r: 600 }, field: { width: 1000, height: 800 } }), null);
});

test("the composer's choice survives the in-memory handoff to Memory and clears with it", () => {
  const choice = { mode: "plan", model: "gpt-6-sol", effort: "medium" } as const;
  holdMemoryAsk({ prompt: "Plan a controlled comparison", imageIds: [], choice });
  assert.deepEqual(peekMemoryAsk()?.choice, choice);
  clearMemoryAsk();
  // A question that never passed through the composer carries none.
  holdMemoryAsk({ prompt: "Is this feasible?", imageIds: [] });
  assert.equal(peekMemoryAsk()?.choice, undefined);
  clearMemoryAsk();
});

test("a suggested question does not inherit the previous composer's persona", () => {
  holdMemoryAsk({ prompt: "Explain the bound", imageIds: [], personaId: "mentor" });
  assert.equal(peekMemoryAsk()?.personaId, "mentor");
  assert.equal(peekMemoryAsk()?.choice, undefined);
  // The composer's pills survive the remount with the question.
  const choice = { mode: "chat", model: "gpt-6-sol", effort: "medium" } as const;
  holdMemoryAsk({ prompt: "Explain the bound", imageIds: [], choice });
  assert.deepEqual(peekMemoryAsk()?.choice, choice);

  // Health can submit a question after an earlier composer submission. It
  // supplies no persona, which must remain absent so the saved thread wins.
  holdMemoryAsk({ prompt: "What should I learn next?", imageIds: [] });
  assert.equal(peekMemoryAsk()?.personaId, undefined);
  assert.equal(peekMemoryAsk()?.choice, undefined);
  clearMemoryAsk();
  assert.equal(peekMemoryAsk(), null);
});

test("the canvas graph pans within a relaxed box around its nodes, never into the void", () => {
  // Nodes spanning x 0..40 and y 0..20: half-extents 20 and 10, so the view's
  // centre may travel 25 and 12.5 from the middle (20, 10).
  const positions = Float32Array.from([0, 0, 40, 20, 20, 10]);
  const aspect = 2;
  const start = { x: 10, y: 5, size: 10 }; // centred on (20, 10)
  const far = boundedView({ x: 10_000, y: -10_000, size: 10 }, start, positions, aspect);
  assert.equal(far.x + (far.size * aspect) / 2, 45);
  assert.equal(far.y + far.size / 2, -2.5);
  // Inside the box nothing is changed.
  assert.deepEqual(boundedView({ x: 12, y: 6, size: 10 }, start, positions, aspect), { x: 12, y: 6, size: 10 });
  // A view that starts outside the box is never snapped; it may only come back.
  const outside = { x: 200, y: 5, size: 10 };
  assert.deepEqual(boundedView({ x: 190, y: 5, size: 10 }, outside, positions, aspect), { x: 190, y: 5, size: 10 });
  assert.equal(boundedView({ x: 210, y: 5, size: 10 }, outside, positions, aspect).x, 200);
});

test("a summary that only repeats the body's opening is not printed twice", () => {
  const summary = "Fleetwood's central argument is that inference accelerators should be designed backward from Transformer serving. The governing axiom is to **minimize data movement**.";
  const body = "## Domain-specific architectures for AI inference\n\nFleetwood's central argument is that inference accelerators should be designed backward from Transformer serving. The governing axiom is to **minimize data movement**. The article treats performance per dollar as the objective.";
  assert.ok(summaryRepeatsBody(summary, body));
  // A summary the author wrote apart from the body is still shown.
  assert.ok(!summaryRepeatsBody("ABRA asks how to divide a fixed training budget between parameters and tokens.", "## The allocation question\n\nFor a fixed training-compute budget, ABRA compares larger models."));
  assert.ok(!summaryRepeatsBody("", body));
});

test("a page's evidence is grouped by the section it sits in", () => {
  const cite = (id: number, extra: Record<string, unknown> = {}) => ({ id, claimType: "author-claim" as const, ...extra });
  // The digest's heading first, then the section number, then the page.
  assert.equal(citationSection(cite(1, { sectionTitle: "Overview", section: "2", page: 3 })), "Overview");
  assert.equal(citationSection(cite(1, { section: "4.1", page: 3 })), "§4.1");
  assert.equal(citationSection(cite(1, { page: 3 })), "p. 3");
  assert.equal(citationSection(cite(1)), "Whole document");
  assert.equal(citationSection({ id: 1, claimType: "external" }), "Outside source");
  assert.equal(citationSection({ id: 1, claimType: "reader-note", page: 3 }), "From your note");
  assert.equal(citationSection({ id: 1, claimType: "derived" }), "Delphi’s inference");
  // Sections in the order the page first cites them, each with all its markers.
  assert.deepEqual(citationsBySection([
    cite(1, { sectionTitle: "Overview" }), cite(2, { sectionTitle: "Kernels" }),
    cite(3, { sectionTitle: "Kernels" }), cite(6, { sectionTitle: "Overview" }),
  ]), [{ section: "Overview", ids: [1, 6] }, { section: "Kernels", ids: [2, 3] }]);
});

test("a wiki link reads as its page's title, and a name with no page as words", () => {
  const pages = knownPages([
    { slug: "krea-2-technical-report", title: "Krea 2 Technical Report", kind: "source" },
  ]);
  const page = pages.get("krea-2-technical-report");
  assert.deepEqual(page, { title: "Krea 2 Technical Report", kind: "source" });
  // A body names pages by slug; the reader sees the title.
  assert.equal(wikiLinkText({ slug: "krea-2-technical-report", label: "krea-2-technical-report" }, page), "Krea 2 Technical Report");
  // Written as a title, it is still the page's title.
  assert.equal(wikiLinkText({ slug: "krea-2-technical-report", label: "Krea 2 technical report" }, page), "Krea 2 Technical Report");
  // The author's own words, when they wrote some, are kept.
  assert.equal(wikiLinkText({ slug: "krea-2-technical-report", label: "the Krea 2 report" }, page), "the Krea 2 report");
  // No page: the name in words, for plain text.
  assert.equal(wikiLinkText({ slug: "muon-update-rule", label: "muon-update-rule" }), "muon update rule");
  // With no page, words the author wrote are kept as written, never lower-cased.
  assert.equal(wikiLinkText({ slug: "muon-update-rule", label: "Muon Update Rule" }), "Muon Update Rule");
  // Where a link cannot be drawn, inside a link the author already wrote, the
  // same words stand in the text and no bracket is left behind.
  assert.equal(
    wikiLinkWords("the [[krea-2-technical-report]] and [[muon-update-rule]], or [[krea-2-technical-report|that report]]", pages),
    "the Krea 2 Technical Report and muon update rule, or that report",
  );
  assert.equal(wikiLinkWords("no link here, and [[ unclosed", pages), "no link here, and [[ unclosed");
});


test("a map's dots and names grow with its field, from a 14-inch screen's to at most double", () => {
  assert.equal(graphScale(1000, 1000, 1000), 1);
  // A small field never shrinks them below what was designed.
  assert.equal(graphScale(400, 300, 1000), 1);
  const wide = graphScale(2200, 1350, 1000);
  assert.ok(wide > 1.6 && wide < 1.8);
  assert.equal(graphScale(4000, 2400, 1000), 2);
  assert.equal(graphScale(0, 0, 1000), 1);
});
