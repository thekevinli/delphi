import assert from "node:assert/strict";
import test from "node:test";

import { evidencePassageQuote } from "../app/lib/evidence-passage.ts";

const section = (anchor: string, markdown: string) => ({ anchor, title: "Passage", level: 2, markdown, words: 0 });
const evidence = (url: string) => ({
  kind: "html",
  url,
  document: { sections: [section("block-91", "Training LLMs often feels like alchemy, but understanding it need not be.")] },
});

test("evidence from the document's own page lands on the live page, at the passage", () => {
  assert.deepEqual(
    evidencePassageQuote(evidence("https://jax-ml.github.io/scaling-book/#intro"), "https://jax-ml.github.io/scaling-book", "block-91"),
    // The whole passage, with its opening words as the fallback.
    {
      quote: "Training LLMs often feels like alchemy, but understanding it need not be.",
      lead: "Training LLMs often feels like alchemy,",
    },
  );
});

test("evidence from another page keeps its captured view", () => {
  assert.equal(evidencePassageQuote(evidence("https://jax-ml.github.io/scaling-book/roofline/"), "https://jax-ml.github.io/scaling-book/", "block-91"), null);
});

test("a passage the evidence does not hold, or an image, has nothing to point at", () => {
  assert.equal(evidencePassageQuote(evidence("https://jax-ml.github.io/scaling-book/"), "https://jax-ml.github.io/scaling-book/", "block-7"), null);
  assert.equal(evidencePassageQuote({ ...evidence("https://jax-ml.github.io/scaling-book/"), kind: "image" }, "https://jax-ml.github.io/scaling-book/", "block-91"), null);
});
