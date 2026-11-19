import assert from "node:assert/strict";
import test from "node:test";

import type { Paper } from "../app/lib/api.ts";
import { segmentCitations, type CitationTarget } from "../app/lib/citations.ts";
import { routeCitation } from "../app/lib/citation-route.ts";
import { forgetProjectAnchors, librarySectionOwners, sectionOwnerLookup, type AnchorMap } from "../app/lib/anchor-index.ts";

const paper = (id: string, title: string, kind = "pdf") => ({ id, title, kind }) as Paper;
const lingbot = paper("lingbot", "LingBot-VA 2.0");
const pi = paper("pi", "π0.7: steerable generalist", "web");
const notes = paper("notes", "Reading notes", "web");
const papers = [lingbot, pi, notes];

const cite = (source: string): CitationTarget => {
  const piece = segmentCitations(source, null).find((item) => item.kind === "citation");
  assert.ok(piece);
  return piece.target;
};
const soon = () => Date.now() + 2000;

test("a bare §anchor opens the document that owns it, not the one on screen", async () => {
  forgetProjectAnchors("p1");
  const owners = sectionOwnerLookup("p1", papers, async () => ({ pi: ["leveraging-more-data-with-diverse-conditioning"] }));
  const target = cite("steerable (§leveraging-more-data-with-diverse-conditioning).");
  const route = await routeCitation(target, papers, lingbot, (item) => `/${item.id}`, [], undefined, owners);
  assert.equal(route?.paper.id, "pi");
});

test("an anchor two documents share goes to the one the reader already has open", async () => {
  forgetProjectAnchors("p2");
  const owners = sectionOwnerLookup("p2", papers, async () => ({ pi: ["introduction"], notes: ["introduction"] }));
  const route = await routeCitation(cite("see (§introduction)."), papers, notes, (item) => `/${item.id}`, [], undefined, owners);
  assert.equal(route?.paper.id, "notes");
});

test("an index that cannot answer relocates nothing", async () => {
  forgetProjectAnchors("p3");
  const failing = sectionOwnerLookup("p3", papers, async () => { throw new Error("offline"); });
  const target = cite("see (§leveraging-more-data-with-diverse-conditioning).");
  assert.equal((await routeCitation(target, papers, lingbot, (item) => `/${item.id}`, [], undefined, failing))?.paper.id, "lingbot");
  const unowned = sectionOwnerLookup("p3", [...papers], async () => ({ pi: ["something-else"] }));
  forgetProjectAnchors("p3");
  assert.equal((await routeCitation(target, papers, lingbot, (item) => `/${item.id}`, [], undefined, unowned))?.paper.id, "lingbot");
});

test("a slow index answers unknown at the deadline instead of holding the click", async () => {
  forgetProjectAnchors("p4");
  const owners = sectionOwnerLookup("p4", papers, () => new Promise<AnchorMap>(() => {}));
  const started = Date.now();
  assert.equal(await owners("introduction", Date.now() + 50), null);
  assert.ok(Date.now() - started < 1000);
});

test("a failed lookup is asked again, and a re-snapshot is forgotten on request", async () => {
  forgetProjectAnchors("p5");
  let calls = 0;
  const flaky = async (): Promise<AnchorMap> => {
    calls += 1;
    if (calls === 1) throw new Error("once");
    return { pi: calls === 2 ? ["old-section"] : ["old-section", "new-section"] };
  };
  const owners = sectionOwnerLookup("p5", papers, flaky);
  assert.equal(await owners("old-section", soon()), null);
  assert.deepEqual([...(await owners("old-section", soon())) ?? []], ["pi"]);
  // Cached: the section added by a refresh is invisible until the project is forgotten.
  assert.deepEqual([...(await owners("new-section", soon())) ?? []], []);
  forgetProjectAnchors("p5");
  assert.deepEqual([...(await owners("new-section", soon())) ?? []], ["pi"]);
  assert.equal(calls, 3);
});

test("adding a document to the project asks again", async () => {
  forgetProjectAnchors("p6");
  let calls = 0;
  const load = async (): Promise<AnchorMap> => { calls += 1; return {}; };
  await sectionOwnerLookup("p6", [lingbot], load)("a", soon());
  await sectionOwnerLookup("p6", [lingbot], load)("a", soon());
  await sectionOwnerLookup("p6", [lingbot, pi], load)("a", soon());
  assert.equal(calls, 2);
});

test("a Memory chat asks every project its library spans, and any one that knows answers", async () => {
  const library = [
    { ...lingbot, projectId: "robots" },
    { ...pi, projectId: "robots" },
    { ...notes, projectId: "reading" },
  ];
  const asked: string[] = [];
  const owners = librarySectionOwners(library, async (projectId) => {
    asked.push(projectId);
    if (projectId === "reading") throw new Error("offline");
    return { pi: ["introduction"] };
  });
  assert.deepEqual([...(await owners("introduction", soon())) ?? []], ["pi"]);
  assert.deepEqual(asked.sort(), ["reading", "robots"]);
  // When no project can answer in time, nothing is known and nothing moves.
  const silent = librarySectionOwners([{ ...notes, projectId: "quiet" }], async () => { throw new Error("offline"); });
  assert.equal(await silent("introduction", soon()), null);
});
