import assert from "node:assert/strict";
import test from "node:test";
import { pdfFindMatches } from "../app/lib/pdf-find.ts";

test("PDF find counts all pages and phrases split across text runs", () => {
  assert.deepEqual(pdfFindMatches(["A neural\n network and a Neural Network", "", "neural network"], "NEURAL network"), [
    { page: 1, occurrence: 0 }, { page: 1, occurrence: 1 }, { page: 3, occurrence: 0 },
  ]);
  assert.deepEqual(pdfFindMatches(["hello"], "missing"), []);
  assert.deepEqual(pdfFindMatches(["hello"], "  "), []);
});
