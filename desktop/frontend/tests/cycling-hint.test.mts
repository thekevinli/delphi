import assert from "node:assert/strict";
import test from "node:test";

import { hintAt } from "../app/lib/cycling-hint.ts";

test("hints take turns in their own order from wherever they start, and round again", () => {
  const hints = ["one", "two", "three"];
  assert.deepEqual([0, 1, 2, 3, 4].map((step) => hintAt(hints, 1, step)), ["two", "three", "one", "two", "three"]);
  assert.equal(hintAt(["only"], 5, 9), "only");
  assert.equal(hintAt([], 0, 0), "");
});
