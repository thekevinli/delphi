import assert from "node:assert/strict";
import test from "node:test";
import { deletedCounts, provenanceCounts, sourceGroups } from "../app/lib/provenance.ts";
import type { MemoryAuthor, MemoryCitation, MemorySource } from "../app/lib/api.ts";

const source = (paperId: string, available = true): MemorySource => ({
  paperId, projectId: available ? "p" : null, title: paperId.toUpperCase(), passages: 1, pages: [], sections: [], available,
});
const author = (removed: boolean): MemoryAuthor =>
  ({ kind: "document", id: "a", projectId: null, title: "A", firstAt: "2026-09-12T00:00:00Z", note: null, removed });
const cite = (id: number, fields: Partial<MemoryCitation>): MemoryCitation => ({ id, claimType: "author-claim", ...fields });

test("passages sit under the document they cite, captures under their capture, and inference after", () => {
  const groups = sourceGroups([
    cite(1, { paperId: "llada", page: 2 }), cite(2, { paperId: "gone", page: 3 }), cite(3, { paperId: "llada", page: 2 }),
    cite(4, { claimType: "external", evidenceId: "x1", section: "intro" }),
    cite(5, { claimType: "external", evidenceId: "x1", section: "results", captured: false }),
    cite(6, { claimType: "derived" }),
  ], [source("llada"), source("gone", false)]);
  assert.deepEqual(groups.documents.map(({ source, sections }) => [source.paperId, sections]), [
    ["llada", [{ section: "p. 2", ids: [1, 3] }]],
    ["gone", [{ section: "p. 3", ids: [2] }]],
  ]);
  // Two passages of one capture are one source; one of them no longer kept makes it gone.
  assert.deepEqual(groups.outside, [
    { evidenceId: "x1", captured: false, sections: [{ section: "§intro", ids: [4] }, { section: "§results", ids: [5] }] },
  ]);
  assert.deepEqual(groups.rest, [{ section: "Delphi’s inference", ids: [6] }]);
});

test("the folded strip counts each group in the order it opens, and leaves an empty one out", () => {
  const groups = sourceGroups([cite(1, { paperId: "llada" }), cite(2, { paperId: "gone" })], [source("llada"), source("gone", false)]);
  assert.deepEqual(provenanceCounts(groups, [author(false), author(true)], 3), [
    { count: 2, noun: "sources" }, { count: 2, noun: "authors" }, { count: 3, noun: "references" },
  ]);
  // A source page: one document, no authors, one page that refers to it.
  const own = sourceGroups([cite(1, { paperId: "llada" })], [source("llada")]);
  assert.deepEqual(provenanceCounts(own, [], 1), [{ count: 1, noun: "source" }, { count: 1, noun: "reference" }]);
});

test("what is deleted is said on hover, and nothing when nothing is", () => {
  const groups = sourceGroups([cite(1, { paperId: "llada" }), cite(2, { paperId: "gone" })], [source("llada"), source("gone", false)]);
  assert.equal(deletedCounts(groups, [author(true), author(true)]), "1 source and 2 authors deleted");
  assert.equal(deletedCounts(sourceGroups([], []), [author(false)]), "");
});
