/**
 * The three pure pieces the Health and Log tabs share.
 *
 * They are one system on purpose: both read the event log for what a pass
 * touched, and without a single reconciliation of the new `edits` array with
 * the old `pages: string[]` each would grow its own compatibility branch and
 * the two would then drift about what "changed" means.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryEdit, MemoryEvent } from "../app/lib/api.ts";
import {
  eventEdits,
  groupEditsByDay,
  splitFindings,
} from "../app/lib/memory.ts";

function edit(slug: string, overrides: Partial<MemoryEdit> = {}): MemoryEdit {
  return {
    slug,
    title: slug,
    kind: "concept",
    action: "revised",
    note: null,
    ...overrides,
  };
}

function event(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    kind: "ingest",
    createdAt: "2026-08-07T10:00:00Z",
    summary: "Filed one concept.",
    ...overrides,
  };
}

test("an event with edits carries them through unchanged", () => {
  const rows = [edit("kl-divergence", { action: "created", note: "wrote it" })];

  assert.deepEqual(eventEdits(event({ edits: rows, pages: ["kl-divergence"] })), rows);
});

test("an event written before edits existed still yields one row per page", () => {
  // The whole point of having one reconciliation: every event already in a
  // reader's log predates `edits`, and none of them may vanish from the Log or
  // stop counting toward the census.
  const rows = eventEdits(event({ pages: ["kl-divergence", "vae"] }));

  assert.deepEqual(
    rows.map((row) => row.slug),
    ["kl-divergence", "vae"],
  );
  // No note, so the row falls back to the pass's own summary at render.
  assert.equal(rows[0].note, null);
});

test("an old event claims no kind and no action, because it recorded neither", () => {
  // The failure this whole change exists to stop, in miniature: a row reading
  // "Revised · concept page" about a source page nobody revised is a small lie
  // told confidently. Null renders as silence.
  const [row] = eventEdits(event({ pages: ["kl-divergence"] }));

  assert.equal(row.action, null);
  assert.equal(row.kind, null);
  assert.equal(row.title, "kl divergence");
});

test("a page that still exists lends the old event its real title and kind", () => {
  const pages = new Map([
    [
      "deepseek-r1",
      { slug: "deepseek-r1", title: "DeepSeek R1", kind: "source" },
    ],
  ] as const);

  const [row] = eventEdits(
    event({ pages: ["deepseek-r1"] }),
    pages as never,
  );

  assert.equal(row.title, "DeepSeek R1");
  assert.equal(row.kind, "source");
  // Still no action: the page list knows what the page is, never what a
  // particular pass did to it.
  assert.equal(row.action, null);
});

test("a pass that filed nothing produces no rows at all", () => {
  assert.deepEqual(eventEdits(event({ kind: "lint", pages: [] })), []);
});

test("passes are grouped under the day they ran, not the day of an edit", () => {
  // An edit has no clock of its own, so a card whose rows straddled a heading
  // would be claiming one it does not have.
  const now = Date.parse("2026-08-07T18:00:00Z");
  const groups = groupEditsByDay(
    [
      { at: "2026-08-07T10:00:00Z", edits: [edit("a"), edit("b")] },
      { at: "2026-08-07T09:00:00Z", edits: [edit("c")] },
      { at: "2026-08-06T09:00:00Z", edits: [edit("d")] },
    ],
    now,
  );

  assert.deepEqual(
    groups.map((group) => group.label),
    ["Today", "Yesterday"],
  );
  assert.equal(groups[0].edits.length, 3);
  // Both passes stay separable, which is what keeps one pass's rows in one card.
  assert.equal(groups[0].entries.length, 2);
});

test("a day inside the last week is named by its weekday", () => {
  const now = Date.parse("2026-08-07T18:00:00Z");
  const [group] = groupEditsByDay(
    [{ at: "2026-08-04T09:00:00Z", edits: [edit("a")] }],
    now,
  );

  assert.notEqual(group.label, "Today");
  assert.match(group.label, /day$/);
});

test("an unparseable timestamp is grouped rather than dropped", () => {
  const [group] = groupEditsByDay([{ at: "not a date", edits: [edit("a")] }]);

  assert.equal(group.label, "Earlier");
  assert.equal(group.edits.length, 1);
});

test("findings split into cards, then chips, then a count", () => {
  // A findings list has no natural length: three unresolved links is a list and
  // forty is a wall, so only the first few get room to explain themselves.
  const items = Array.from({ length: 11 }, (_value, index) => index);

  const split = splitFindings(items);
  assert.deepEqual(split.cards, [0, 1, 2, 3]);
  assert.deepEqual(split.chips, [4, 5, 6, 7]);
  assert.deepEqual(split.rest, [8, 9, 10]);
});

test("a short list is all cards and nothing is hidden behind a count", () => {
  const split = splitFindings([1, 2]);

  assert.deepEqual(split.cards, [1, 2]);
  assert.deepEqual(split.chips, []);
  assert.deepEqual(split.rest, []);
});
