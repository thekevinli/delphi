import assert from "node:assert/strict";
import test from "node:test";

import type { Paper } from "../app/lib/api.ts";
import { segmentCitations, type CitationTarget } from "../app/lib/citations.ts";
import { routeCitation } from "../app/lib/citation-route.ts";
import { registerDocument, resetLocatorIndex } from "../app/lib/locator-index.ts";

const paper = (id: string, title: string) => ({ id, title, kind: "pdf" }) as Paper;

function lend(id: string, pages: string[][], broken: number[] = []) {
  registerDocument(id, {
    numPages: pages.length,
    getPage: async (page: number) => {
      if (broken.includes(page)) throw new Error("this page will not extract");
      return {
        getViewport: () => ({ transform: [1, 0, 0, 1, 0, 0], width: 100, height: 200 }),
        getTextContent: async () => ({
          items: (pages[page - 1] ?? []).map((str, line) => ({
            str,
            width: str.length,
            hasEOL: true,
            transform: [10, 0, 0, 10, 5, (line + 1) * 10],
          })),
        }),
      };
    },
  } as never);
}

const cite = (source: string, inferred: string | null = null): CitationTarget => {
  const piece = segmentCitations(source, inferred).find((item) => item.kind === "citation");
  assert.ok(piece);
  return piece.target;
};

const route = (
  target: CitationTarget,
  papers: Paper[],
  current: Paper | null,
  mentioned: Paper[] = [],
) => routeCitation(target, papers, current, (cited) => `/${cited.id}`, mentioned);

test("a paper the model named keeps the citation even when the locator is missing", async () => {
  // An extraction gap in our own text is not evidence about what the model
  // meant. Landing on the page of the right paper beats landing precisely in
  // the wrong one.
  resetLocatorIndex();
  const jit = paper("jit", "Back to Basics - JiT"), pid = paper("pid", "PiD");
  lend("jit", [[], [], ["nothing useful here"]]);
  lend("pid", [[], [], ["Table 4:Ablation study"]]);

  const found = await route(cite("(Back to Basics - JiT, Table 4, p. 3)"), [jit, pid], pid);
  assert.equal(found?.paper.id, "jit");
  assert.equal(found?.hit, null);
});

test("a name two papers share identifies neither", async () => {
  // 80 is a match class — a shared prefix — not a confidence percentage.
  resetLocatorIndex();
  const methods = paper("m", "Alpha Methods"), results = paper("r", "Alpha Results");
  lend("m", [["nothing"]]);
  lend("r", [["Table 2.The one that exists"]]);

  // Neither is identified, so the index is allowed to rule one out.
  const found = await route(cite("(Alpha, Table 2)"), [methods, results], methods, [methods, results]);
  assert.equal(found?.paper.id, "r");
});

test("a nameless citation leaves the open paper when the locator is not in it", async () => {
  // The failure this whole module exists for: an answer comparing two papers
  // cites the other one's table, and every such citation used to open the paper
  // the reader happened to have on screen.
  resetLocatorIndex();
  const jit = paper("jit", "Back to Basics - JiT"), pid = paper("pid", "PiD");
  lend("jit", Array.from({ length: 14 }, () => ["ordinary body text"]));
  lend("pid", [...Array.from({ length: 13 }, () => ["body"]), ["Table 4:Ablation study"]]);

  const found = await route(cite("(Table 4, p. 14)"), [jit, pid], jit, [jit, pid]);
  assert.equal(found?.paper.id, "pid");
  assert.equal(found?.hit?.page, 14);
});

test("a paper the answer never named is not somewhere a citation may be sent", async () => {
  // The library is full of papers with a Table 4. Only the ones this answer
  // actually talked about are candidates; the rest were never pointed at, and
  // landing in one of them would be a guess dressed up as a resolution.
  resetLocatorIndex();
  const jit = paper("jit", "Back to Basics - JiT"), other = paper("other", "Unrelated Survey");
  lend("jit", Array.from({ length: 14 }, () => ["ordinary body text"]));
  lend("other", [...Array.from({ length: 13 }, () => ["body"]), ["Table 4:Something else entirely"]]);

  const found = await route(cite("(Table 4, p. 14)"), [jit, other], jit, []);
  assert.equal(found?.paper.id, "jit");
  assert.equal(found?.hit, null);
});

test("a linked PDF is indexed like any other PDF", async () => {
  // It is served from a different route, but `PdfViewer` renders it and a
  // citation into one deserves the same caption box.
  resetLocatorIndex();
  const linked = { ...paper("linked", "Linked Paper"), kind: "web", filename: "paper.pdf" } as Paper;
  lend("linked", [["Table 1:The caption"]]);
  const found = await route(cite("(Linked Paper, Table 1, p. 1)"), [linked], linked);
  assert.equal(found?.hit?.page, 1);
});

test("an unreadable page keeps the citation where it was, rather than moving it", async () => {
  resetLocatorIndex();
  const jit = paper("jit", "Back to Basics - JiT"), pid = paper("pid", "PiD");
  lend("jit", [["body"], ["body"]], [2]);
  lend("pid", [["Table 4:Ablation study"]]);

  const found = await route(cite("(Table 4, p. 1)"), [jit, pid], jit);
  assert.equal(found?.paper.id, "jit");
  assert.equal(found?.hit, null);
});

test("the paper the surrounding prose named is asked before the one on screen", async () => {
  resetLocatorIndex();
  const jit = paper("jit", "Back to Basics - JiT"), pid = paper("pid", "PiD");
  lend("jit", [["Table 1:Both papers have one"]]);
  lend("pid", [["Table 1:Both papers have one"]]);

  const inferred = await route(cite("(Table 1, p. 1)", "PiD"), [jit, pid], jit);
  assert.equal(inferred?.paper.id, "pid");
  // Without the prose, the same citation stays with the open paper: a locator
  // both papers contain identifies neither of them.
  const bare = await route(cite("(Table 1, p. 1)"), [jit, pid], jit);
  assert.equal(bare?.paper.id, "jit");
});

test("a page-only citation follows the prose, and never reads a document", async () => {
  resetLocatorIndex();
  const jit = paper("jit", "Back to Basics - JiT"), pid = paper("pid", "PiD");
  const found = await route(cite("(pp. 5–8)", "PiD"), [jit, pid], jit);
  assert.equal(found?.paper.id, "pid");
  assert.equal(found?.hit, null);
});

test("a scanned paper keeps its citations instead of donating them", async () => {
  // Astra's reproduction: the prose is about a paper that extracts to nothing,
  // and the only paper with a Table 4 in readable text is the other one. An
  // image-only page is missing searchable evidence, not evidence that the
  // paper lacks the table, so it may not hand its citation away.
  resetLocatorIndex();
  const alpha = paper("alpha", "Scanned Alpha"), beta = paper("beta", "Beta");
  lend("alpha", [[], [], []]);
  lend("beta", [[], [], ["Table 4:Ablation study"]]);

  const found = await route(cite("(Table 4, p. 3)", "Scanned Alpha"), [alpha, beta], beta, [alpha, beta]);
  assert.equal(found?.paper.id, "alpha");
  assert.equal(found?.hit, null);
});

test("a page number never lands in a web page, and falls to the one paged document", async () => {
  // A project chat comparing a PDF with a web page, the web page on screen: a
  // nameless "(pp. 1–2, 5)" used to "jump" to the page already open, which
  // cannot have pages, so nothing moved and no way back was offered.
  resetLocatorIndex();
  const pdf = paper("pdf", "Native Video-Action Pretraining");
  const web = { ...paper("web", "A Steerable Model"), kind: "web", filename: "post.html" } as Paper;
  const found = await route(cite("(pp. 1–2, 5)"), [pdf, web], web);
  assert.equal(found?.paper.id, "pdf");
  // With two paged documents and nothing naming either, there is no answer.
  const second = paper("other", "Another PDF");
  assert.equal(await route(cite("(pp. 1–2, 5)"), [pdf, second, web], web), null);
  // A section slug is still the web page's to answer.
  assert.equal((await route(cite("(§leveraging-more-data)"), [pdf, web], web))?.paper.id, "web");
});

test("a click that cannot be resolved still goes somewhere", async () => {
  // Resolution is bounded. A document that never finishes loading used to mean
  // a click that did nothing at all: no navigation, no guide, no explanation.
  resetLocatorIndex();
  const jit = paper("jit", "Back to Basics - JiT");
  registerDocument("jit", { numPages: 3, getPage: () => new Promise(() => {}) } as never);

  const started = Date.now();
  const found = await route(cite("(Back to Basics - JiT, Table 4, p. 2)"), [jit], jit);
  assert.equal(found?.paper.id, "jit");
  assert.equal(found?.hit, null);
  assert.ok(Date.now() - started < 10000, "the budget ends the wait, not the document");
});

/**
 * Text as pdf.js delivers it from a real figure page: the figure's last label,
 * then the caption under it, with no `hasEOL` between them. Each piece is
 * `[text, x, y, size]` on a Letter page, `y` from the bottom.
 */
function lendDrawn(id: string, pages: Array<Array<[string, number, number, number?]>>) {
  registerDocument(id, {
    numPages: pages.length,
    getPage: async (page: number) => ({
      getViewport: () => ({ transform: [1, 0, 0, -1, 0, 792], width: 612, height: 792 }),
      getTextContent: async () => ({
        items: (pages[page - 1] ?? []).map(([str, x, y, size = 10]) => ({
          str, width: str.length * size * 0.5, hasEOL: false, transform: [size, 0, 0, size, x, y],
        })),
      }),
    }),
  } as never);
}

test("a caption glued to its figure's labels keeps a nameless citation in its paper", async () => {
  // "Scaling Native Multimodal Pre-Training From Scratch", page 4: the legend's
  // "r = 0.3" and the caption "Figure 3: Compute-optimal allocation…" arrive
  // as one run. The caption went unread, the paper was called `absent`, and a
  // nameless "(Figure 3, p. 4)" read beside it was sent to Chinchilla's
  // Figure 3 instead, because the answer had mentioned Chinchilla.
  resetLocatorIndex();
  const native = paper("native", "Scaling Native Multimodal Pre-Training From Scratch (2607.22043v1)");
  const chinchilla = paper("chinchilla", "Chinchilla (2203.15556v1)");
  const body: [string, number, number] = ["Body text on a page that names no figure at all.", 72, 700];
  lendDrawn("native", [[body], [body], [body], [
    ["r = 0.3", 400, 690, 7],
    ["Figure 3:", 72, 600],
    [" Compute-optimal allocation (language objective).", 120, 600],
  ], [body]]);
  lendDrawn("chinchilla", [[body], [["Figure 3 j IsoFLOP curves.", 72, 600]]]);

  const found = await route(cite("(Figure 3, p. 4)"), [native, chinchilla], native, [native, chinchilla]);
  assert.equal(found?.paper.id, "native");
  assert.equal(found?.hit?.page, 4);
});
