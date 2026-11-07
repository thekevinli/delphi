/**
 * The causes a filing can fail on, as every surface says them: few enough to
 * keep in mind, each a short title, one line and a fix.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  FAILURE_CAUSES,
  causeOf,
  failureSentence,
  groupByCause,
} from "../app/lib/filing-failure.ts";

test("seven causes, each a short title, one short line and its fix", () => {
  assert.deepEqual(Object.keys(FAILURE_CAUSES), ["check", "answer", "provider", "signin", "interrupted", "document", "unknown"]);
  for (const [cause, copy] of Object.entries(FAILURE_CAUSES)) {
    assert.ok(copy.title.split(" ").length <= 4, `${cause}: "${copy.title}" is a title, not a sentence`);
    // One sentence, said once: no second clause strung on with commas.
    assert.ok(copy.line.length <= 56 && (copy.line.match(/,/g) ?? []).length <= 1, `${cause}: "${copy.line}"`);
    assert.match(copy.line, /\.$/);
  }
  // Only a refused sign-in is fixed somewhere else, and only an unreadable document by opening it.
  assert.deepEqual(
    Object.entries(FAILURE_CAUSES).filter(([, copy]) => copy.fix !== "retry").map(([cause, copy]) => [cause, copy.fix]),
    [["signin", "connection"], ["document", "open"]],
  );
});

test("the cause is the server's, and a row from before causes were is unknown", () => {
  assert.equal(causeOf({ failure: { cause: "signin", failedAt: "2026-10-30T08:00:00Z", pages: [] } }), "signin");
  assert.equal(causeOf({ failure: null }), "unknown");
  assert.equal(causeOf({}), "unknown");
  assert.equal(causeOf({ failure: { cause: "gremlins" as never, failedAt: "2026-10-30T08:00:00Z", pages: [] } }), "unknown");
  assert.equal(failureSentence("provider"), "Provider unavailable. Busy, down or past your plan’s limit.");
});

test("documents group by cause in the catalogue's order, leaving out causes none has", () => {
  const groups = groupByCause([
    { title: "a", cause: "unknown" as const },
    { title: "b", cause: "check" as const },
    { title: "c", cause: "provider" as const },
    { title: "d", cause: "check" as const },
  ]);
  assert.deepEqual(
    groups.map(({ cause, items }) => [cause, items.map((item) => item.title)]),
    [["check", ["b", "d"]], ["provider", ["c"]], ["unknown", ["a"]]],
  );
});
