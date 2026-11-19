import assert from "node:assert/strict";
import test from "node:test";

import { cutOffNotice, incompleteOf } from "../app/lib/answer-ending.ts";

test("a cut-off answer says why in words, and an unknown reason still says it was cut off", () => {
  assert.equal(cutOffNotice("max_output_tokens"), "This answer was cut off before it finished.");
  assert.equal(cutOffNotice("deadline"), "This answer ran out of time before it finished.");
  assert.equal(cutOffNotice("content_filter"), "This answer was cut off before it finished.");
  assert.equal(cutOffNotice(undefined), "This answer was cut off before it finished.");
});

test("only a stored reason marks an answer as cut off", () => {
  assert.deepEqual(incompleteOf({ reason: "deadline" }), { reason: "deadline" });
  assert.equal(incompleteOf(null), undefined);
  assert.equal(incompleteOf({}), undefined);
  assert.equal(incompleteOf({ reason: "" }), undefined);
  assert.equal(incompleteOf("max_output_tokens"), undefined);
  assert.equal(incompleteOf({ reason: "x".repeat(200) })?.reason.length, 80);
});
