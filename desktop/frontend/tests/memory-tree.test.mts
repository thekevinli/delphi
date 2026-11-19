import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryDomain, MemoryPageSummary } from "../app/lib/api.ts";
import {
  buildMemoryTree,
  chooseParents,
  treeSlugs,
  type TreeNode,
} from "../app/lib/memory-tree.ts";

function page(
  slug: string,
  overrides: Partial<MemoryPageSummary> = {},
): MemoryPageSummary {
  return {
    id: slug,
    slug,
    kind: "concept",
    domain: "ml",
    title: slug,
    summary: "",
    tags: [],
    revision: 1,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    linkDegree: 0,
    ...overrides,
  } as MemoryPageSummary;
}

function record(slug: string, overrides: Partial<MemoryDomain> = {}): MemoryDomain {
  return {
    slug,
    domain: slug,
    title: slug,
    summary: null,
    origin: "model",
    position: 0,
    pages: 0,
    ...overrides,
  };
}

function find(tree: TreeNode[], slug: string): TreeNode | undefined {
  for (const node of tree) {
    if (node.slug === slug) return node;
    const hit = find(node.children, slug);
    if (hit) return hit;
  }
  return undefined;
}

test("a page hangs under the strongest page it links to in its own domain", () => {
  const pages = [
    page("training", { kind: "domain", domain: "ml" }),
    page("distillation"),
    page("sft"),
    page("temperature"),
  ];
  // `training` is reached by everything, so it is the highest-degree node; `temperature` only
  // touches `distillation`, so it nests one level deeper.
  const links = [
    { from: "distillation", to: "training" },
    { from: "sft", to: "training" },
    { from: "temperature", to: "distillation" },
  ];

  const parents = chooseParents(pages, links);
  assert.equal(parents.get("distillation"), "training");
  assert.equal(parents.get("sft"), "training");
  assert.equal(parents.get("temperature"), "distillation");
  // A domain's own domain page is the root of its domain and never nests.
  assert.equal(parents.get("training"), null);
});

test("a link into another domain never becomes a parent", () => {
  // The edge is real and the graph view shows it, but using it here would file
  // a page under a heading it does not belong to.
  const pages = [
    page("overview", { kind: "domain", domain: "ml" }),
    page("distillation", { domain: "ml" }),
    page("practice", { domain: "guitar" }),
  ];
  const links = [
    { from: "distillation", to: "overview" },
    { from: "practice", to: "overview" },
    { from: "practice", to: "distillation" },
  ];

  const parents = chooseParents(pages, links);
  assert.equal(parents.get("practice"), null);
});

test("two equally connected leaves do not adopt each other", () => {
  // Only a strictly stronger page may be a parent. Without that rule both of
  // these disappear from the tree by nesting inside one another.
  const pages = [page("alpha"), page("beta")];
  const parents = chooseParents(pages, [{ from: "alpha", to: "beta" }]);

  assert.equal(parents.get("alpha"), null);
  assert.equal(parents.get("beta"), null);
});

test("an explicit parent wins over the derived one", () => {
  // The extension point: nothing fills this map today, and when a stored
  // parent arrives it is a data change rather than a rewrite.
  const pages = [
    page("overview", { kind: "domain" }),
    page("distillation"),
    page("temperature"),
  ];
  const links = [
    { from: "distillation", to: "overview" },
    { from: "temperature", to: "overview" },
  ];

  const parents = chooseParents(pages, links, { temperature: "distillation" });
  assert.equal(parents.get("temperature"), "distillation");
});

test("a cycle re-hangs its pages on the domain instead of losing them", () => {
  // Showing a page one level too high is a far smaller failure than a page
  // that never renders because its ancestry never terminates.
  const pages = [page("a"), page("b"), page("c")];
  const parents = chooseParents(pages, [], { a: "b", b: "c", c: "a" });

  const tree = buildMemoryTree(pages, [], [record("ml")], {
    parents: { a: "b", b: "c", c: "a" },
  });
  assert.ok([...parents.values()].some((value) => value === null));
  assert.deepEqual(treeSlugs(tree).sort(), ["a", "b", "c", "ml"]);
});

test("a node counts every page beneath it, not just its own children", () => {
  const pages = [
    page("training", { kind: "domain" }),
    page("distillation"),
    page("temperature"),
  ];
  const links = [
    { from: "distillation", to: "training" },
    { from: "temperature", to: "distillation" },
  ];

  const tree = buildMemoryTree(pages, links, [record("ml", { title: "Machine learning" })]);
  assert.equal(tree[0].title, "Machine learning");
  // Three pages sit under the domain: the domain page, the concept and its leaf.
  assert.equal(tree[0].count, 3);
  assert.equal(find(tree, "distillation")?.count, 1);
  assert.equal(find(tree, "temperature")?.count, 0);
});

test("an empty domain the reader just named stays in the tree", () => {
  // Create must confirm immediately: hiding empty destinations until Update
  // filed something into them made the sidebar look like Create had failed.
  const tree = buildMemoryTree(
    [],
    [],
    [record("roman-history", { title: "Roman history", origin: "reader" })],
  );
  assert.equal(tree.length, 1);
  assert.equal(tree[0].slug, "roman-history");
  assert.equal(tree[0].title, "Roman history");
  assert.equal(tree[0].count, 0);
  assert.equal(tree[0].openable, false);
});

test("a domain page with no children still keeps its heading", () => {
  // The domain page *is* the domain — openable, even alone — so filtering empty
  // headings must not drop a real page.
  const tree = buildMemoryTree(
    [page("ml", { kind: "domain", domain: "ml", title: "Machine learning" })],
    [],
    [record("ml", { title: "Machine learning" })],
  );
  assert.equal(tree.length, 1);
  assert.equal(tree[0].slug, "ml");
  assert.equal(tree[0].openable, true);
  assert.equal(tree[0].count, 0);
});

test("a domain heading is its record, and opens only the page written for it", () => {
  const members = [page("vae", { domain: "ml" }), page("elbo", { domain: "ml" })];
  const ml = record("ml", { title: "Machine Learning", summary: "How models are trained.", pages: 2 });

  // No page has been written for the domain: the heading shows what is filed
  // under it, and asking for a page at its slug would find none.
  const [bare] = buildMemoryTree(members, [], [ml]);
  assert.equal(bare.title, "Machine Learning");
  assert.equal(bare.kind, "domain");
  assert.equal(bare.heading, true);
  assert.equal(bare.openable, false);
  assert.deepEqual(bare.children.map((child) => child.slug), ["elbo", "vae"]);
  assert.equal(bare.count, 2);

  // Written: the same heading, under the record's name, now opens that page,
  // which is not also a row beneath it.
  const written = page("ml", { kind: "domain", domain: "ml", title: "machine learning" });
  const [composed] = buildMemoryTree([...members, written], [], [ml], { changedSlugs: new Set(["ml"]) });
  assert.equal(composed.title, "Machine Learning");
  assert.equal(composed.openable, true);
  assert.equal(composed.changed, true);
  assert.deepEqual(composed.children.map((child) => child.slug), ["elbo", "vae"]);
  assert.equal(composed.count, 2);

  // With no record to name it, the written page does.
  const [unrecorded] = buildMemoryTree([written], [], []);
  assert.equal(unrecorded.title, "machine learning");
  assert.equal(unrecorded.openable, true);
});

test("a page whose domain has no record still gets a heading", () => {
  // A page dropped for want of a heading is a page the reader cannot reach.
  const tree = buildMemoryTree([page("orphan", { domain: "astronomy" })], [], []);
  assert.deepEqual(treeSlugs(tree).sort(), ["astronomy", "orphan"]);
});

test("domains follow the order the reader set, not their size", () => {
  const pages = [
    page("one", { domain: "ml" }),
    page("two", { domain: "ml" }),
    page("solo", { domain: "guitar" }),
  ];
  const tree = buildMemoryTree(pages, [], [
    record("guitar", { position: -1 }),
    record("ml", { position: 0 }),
  ]);
  assert.deepEqual(
    tree.map((node) => node.slug),
    ["guitar", "ml"],
  );
});

test("a change anywhere below a domain surfaces on the collapsed domain", () => {
  const pages = [page("training", { kind: "domain" }), page("distillation")];
  const tree = buildMemoryTree(
    pages,
    [{ from: "distillation", to: "training" }],
    [record("ml")],
    { changedSlugs: new Set(["distillation"]) },
  );

  assert.equal(tree[0].changed, true);
  assert.equal(find(tree, "distillation")?.changed, true);
  assert.equal(find(tree, "training")?.changed, true);
});

test("the same input always produces the same tree", () => {
  // A sidebar that reshuffles between two visits is one nobody can build a
  // habit around, so nothing here may depend on recency or insertion order.
  const pages = [page("beta"), page("alpha"), page("overview", { kind: "domain" })];
  const links = [
    { from: "alpha", to: "overview" },
    { from: "beta", to: "overview" },
  ];
  const first = buildMemoryTree(pages, links, [record("ml")]);
  const second = buildMemoryTree([...pages].reverse(), [...links].reverse(), [
    record("ml"),
  ]);
  assert.deepEqual(treeSlugs(first), treeSlugs(second));
});
