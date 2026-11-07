import assert from "node:assert/strict";
import test from "node:test";

import type { Paper } from "../app/lib/api.ts";
import { PAPER_MARK_LABEL, paperMark } from "../app/lib/paper-kind.ts";

const paper = (fields: Partial<Paper>): Paper => ({
  id: "paper", title: "Paper", slug: "paper", filename: "paper.pdf", pages: 1, tokens: 1, ...fields,
});

test("a document's mark comes from its stored source type, not its title", () => {
  // An arXiv id in the title is not evidence of either kind.
  assert.equal(paperMark(paper({ kind: "web", title: "SGLang (2312.07104v2)", filename: "2312.07104v2.html" })), "web");
  assert.equal(paperMark(paper({ kind: "pdf", filename: "A blog post - Wikipedia.pdf" })), "pdf");
  // A linked PDF is stored through the web contract and read as a PDF.
  assert.equal(paperMark(paper({ kind: "web", filename: "Paper.PDF" })), "pdf");
  // Papers stored before web documents existed carry no kind.
  assert.equal(paperMark(paper({ filename: "old.pdf" })), "pdf");
  assert.equal(paperMark(paper({})), "pdf");
});

test("each mark has the words a list prints beside it", () => {
  assert.deepEqual(PAPER_MARK_LABEL, { web: "Web page", pdf: "PDF" });
});
