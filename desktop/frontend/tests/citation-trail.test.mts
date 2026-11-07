import assert from "node:assert/strict";
import test from "node:test";

import {
  clearTrail,
  popTrail,
  pushTrail,
  trailWithin,
  type TrailEntry,
} from "../app/lib/citation-trail.ts";

const P = "aaaaaaaaaaaa";
const A: TrailEntry = { path: `/proj-${P}/a-111111111111`, title: "Paper A", projectId: P };
const B: TrailEntry = { path: `/proj-${P}/b-222222222222`, title: "Paper B", projectId: P };
const C: TrailEntry = { path: `/proj-${P}/c-333333333333`, title: "Paper C", projectId: P };

test("following A to B to C walks all the way back", () => {
  // The bug this replaces: the trail was one slot, so arriving at C overwrote
  // the note that said "you came from A" and the way back stopped at B.
  let trail: TrailEntry[] = [];
  trail = pushTrail(trail, A, B.path);
  trail = pushTrail(trail, B, C.path);

  const first = popTrail(trail);
  assert.equal(first.to?.title, "Paper B");

  const second = popTrail(first.rest);
  assert.equal(second.to?.title, "Paper A");

  const exhausted = popTrail(second.rest);
  assert.equal(exhausted.to, null);
});

test("the way back carries the thread it was on", () => {
  // The path includes the query, so returning to a document that was being read
  // in project-thread mode returns to that thread rather than the paper's.
  const withScope: TrailEntry = {
    path: `/proj-${P}/a-111111111111?chat=project`,
    title: "Paper A",
    projectId: P,
  };
  const trail = pushTrail([], withScope, B.path);
  assert.equal(popTrail(trail).to?.path, `/proj-${P}/a-111111111111?chat=project`);
});

test("bouncing between two documents does not pile up", () => {
  // A cites B, B cites A, A cites B… the honest way back from the second B is
  // still A, and the trail must not grow without bound.
  let trail: TrailEntry[] = [];
  trail = pushTrail(trail, A, B.path);
  trail = pushTrail(trail, B, A.path);
  assert.deepEqual(trail, []);

  trail = pushTrail(trail, A, B.path);
  assert.deepEqual(trail, [A]);
});

test("arriving back at somewhere mid-trail unwinds to it", () => {
  let trail: TrailEntry[] = [];
  trail = pushTrail(trail, A, B.path);
  trail = pushTrail(trail, B, C.path);
  // A citation in C that points back at A: the trail should read as if the
  // detour through B never happened, not stack a third entry.
  trail = pushTrail(trail, C, A.path);
  assert.deepEqual(trail, []);
});

test("a deliberate move clears the trail", () => {
  const trail = pushTrail([], A, B.path);
  assert.deepEqual(clearTrail(trail), []);
});

test("clearing an empty trail returns the same array", () => {
  // Called from an effect on every project change; returning a fresh [] each
  // time would re-render forever.
  const empty: TrailEntry[] = [];
  assert.equal(clearTrail(empty), empty);
});

test("popping an empty trail is not an error", () => {
  assert.deepEqual(popTrail([]), { to: null, rest: [] });
});

test("a trail from another project is not offered back", () => {
  // Replaces an effect that cleared the trail whenever the project changed.
  // Filtering says the same thing without a second render pass — and survives a
  // back-button move into another project, which no handler would have seen.
  const other: TrailEntry = {
    path: "/other-bbbbbbbbbbbb/z-999999999999",
    title: "Elsewhere",
    projectId: "bbbbbbbbbbbb",
  };
  const mixed = [other, A];
  assert.deepEqual(trailWithin(mixed, P), [A]);
  assert.deepEqual(trailWithin(mixed, "bbbbbbbbbbbb"), [other]);
  assert.deepEqual(trailWithin(mixed, null), []);
  assert.deepEqual(trailWithin(mixed, "cccccccccccc"), []);
});
