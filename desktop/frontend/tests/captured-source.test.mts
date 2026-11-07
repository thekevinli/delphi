import assert from "node:assert/strict";
import test from "node:test";
import { quoteRange } from "../app/lib/quote-range.ts";

test("a quote is found in a captured section whatever marks and spacing the capture kept", () => {
  const text = "We show that a *block multiplier* of 1/√depth keeps\nfeatures moving — “the unique scaling”. More follows.";
  const range = quoteRange(text, "a block multiplier of 1/√depth keeps features moving");
  assert.ok(range);
  assert.equal(text.slice(...range), "a *block multiplier* of 1/√depth keeps\nfeatures moving");
  // Not there, and too short to mean anything.
  assert.equal(quoteRange(text, "a block multiplier of two keeps features still"), null);
  assert.equal(quoteRange(text, "features moving"), null);
  // A quote is text, never a pattern.
  assert.equal(quoteRange("cost is $5 (five) [sic].", "cost is $5 (five) [sic]")?.[0], 0);
});
