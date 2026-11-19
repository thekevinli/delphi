import assert from "node:assert/strict";
import test from "node:test";

import { parseLocator } from "../app/lib/locators.ts";
import {
  probe,
  registerDocument,
  resetLocatorIndex,
  unregisterDocument,
} from "../app/lib/locator-index.ts";

const WIDTH = 100;
const HEIGHT = 200;
const SIZE = 10;

/**
 * A document proxy shaped like pdf.js's, one text item per line. Enough to
 * exercise the index's own decisions — which pages it reads, in what order, and
 * what it is willing to conclude — without the engine.
 */
function fakeDocument(pages: string[][], broken: number[] = []) {
  return {
    numPages: pages.length,
    getPage: async (page: number) => {
      if (broken.includes(page)) throw new Error("this page will not extract");
      return {
        // pdf.js's own viewport for an unrotated page: y flips, so text whose
        // baseline sits at user-space y = 10 is drawn near the page's bottom.
        getViewport: () => ({ transform: [1, 0, 0, -1, 0, HEIGHT], width: WIDTH, height: HEIGHT }),
        getTextContent: async () => ({
          items: (pages[page - 1] ?? []).map((str, line) => ({
            str,
            width: str.length,
            hasEOL: true,
            transform: [SIZE, 0, 0, SIZE, 5, (line + 1) * SIZE],
          })),
        }),
      };
    },
  };
}

const lend = (id: string, pages: string[][], broken: number[] = []) => {
  resetLocatorIndex();
  registerDocument(id, fakeDocument(pages, broken) as never);
};

const locator = (segment: string) => {
  const parsed = parseLocator(segment);
  assert.ok(parsed);
  return parsed;
};

const ask = (id: string, segment: string, pages: number[]) =>
  probe({ id, fileUrl: `/${id}` }, locator(segment), pages);

test("every page of a cited range is read before a winner is chosen", async () => {
  // The caption is on the *second* page of "pp. 5–6". Stopping at the first
  // match on the first page would settle for the prose mention — which is
  // exactly what "Table 2, pp. 5–6" does in a real paper.
  lend("jit", [
    [], [], [], [],
    ["256×256 resolution in Tab. 2(a). As a reference"],
    ["Table 2.Results of all combinationsof loss space"],
  ]);
  const verdict = await ask("jit", "Table 2", [5, 6]);
  assert.equal(verdict.state, "found");
  assert.equal(verdict.state === "found" && verdict.hit.page, 6);
});

test("a locator spanning the range lands on the page it starts on", async () => {
  lend("jit", [
    ["Table 2.Results of all combinations"],
    ["Table 2.Results continued"],
  ]);
  const verdict = await ask("jit", "Table 2", [1, 2]);
  assert.equal(verdict.state === "found" && verdict.hit.page, 1);
});

test("a locator outside the cited pages is still found, never called absent", async () => {
  lend("jit", [["nothing here"], ["nor here"], ["Table 9.The one we wanted"]]);
  const verdict = await ask("jit", "Table 9", [1]);
  assert.equal(verdict.state, "found");
  assert.equal(verdict.state === "found" && verdict.hit.page, 3);
});

test("absent is claimed only after the whole document reads clean", async () => {
  lend("jit", [["nothing here"], ["nor here"]]);
  assert.equal((await ask("jit", "Table 9", [1])).state, "absent");
});

test("a page that will not extract makes the verdict unknown, not absent", async () => {
  // Deciding "this paper does not contain Table 9" is the only verdict that may
  // move a reader to a different document. A gap in our own extraction must
  // never be mistaken for one in the paper.
  lend("jit", [["nothing here"], ["nor here"], ["unreadable"]], [3]);
  assert.equal((await ask("jit", "Table 9", [1])).state, "unknown");
});

test("a found locator reports where it is as a fraction of the page", async () => {
  lend("jit", [["Table 1:Caption"]]);
  const verdict = await ask("jit", "Table 1", [1]);
  assert.ok(verdict.state === "found");
  const { rect } = verdict.hit;
  assert.equal(rect.x, 5 / WIDTH);
  // Baseline at user y = 10, one font size tall: from HEIGHT-20 to HEIGHT-10.
  assert.ok(Math.abs(rect.y - (HEIGHT - 2 * SIZE) / HEIGHT) < 1e-9);
  assert.ok(Math.abs(rect.h - SIZE / HEIGHT) < 1e-9);
  assert.ok(rect.w > 0 && rect.h > 0);
  assert.ok(rect.x + rect.w <= 1 && rect.y + rect.h <= 1);
});

test("a document handed back is no longer answered from", async () => {
  lend("jit", [["Table 1:Caption"]]);
  assert.equal((await ask("jit", "Table 1", [1])).state, "found");
  unregisterDocument("jit");
  // Nothing is lent any more, so the index would have to open the file itself;
  // there is no file, and the failure must read as unknown rather than as a
  // claim about the paper.
  assert.equal((await ask("jit", "Table 1", [1])).state, "unknown");
});

test("the pages nearest a citation are read before the rest of the document", async () => {
  // A caption sits one page off its citation often enough to be worth a cheap
  // second look. Each page here records when it was asked for, so the order the
  // index widened in is visible rather than inferred.
  const asked: number[] = [];
  resetLocatorIndex();
  registerDocument("jit", {
    numPages: 12,
    getPage: async (page: number) => {
      asked.push(page);
      return {
        getViewport: () => ({ transform: [1, 0, 0, 1, 0, 0], width: WIDTH, height: HEIGHT }),
        getTextContent: async () => ({
          items: (page === 7 ? ["Table 3:Found here"] : ["body text"]).map((str) => ({
            str, width: str.length, hasEOL: true, transform: [SIZE, 0, 0, SIZE, 5, SIZE],
          })),
        }),
      };
    },
  } as never);

  const verdict = await ask("jit", "Table 3", [6]);
  assert.equal(verdict.state === "found" && verdict.hit.page, 7);
  // The cited page first, then its neighbours — and the far end of the document
  // is never reached, because the answer was found before it was needed.
  assert.deepEqual(asked.slice(0, 3), [6, 4, 5]);
  assert.ok(!asked.includes(12), "a near hit must not cost a whole document");
});

test("a document that cannot be opened answers unknown, and is not remembered", async () => {
  // The loading task is published to the entry the moment it exists rather than
  // once the document resolves, so a load that rejects — or an entry evicted
  // while one is still in flight — still has something to destroy. The visible
  // consequence is here: a failure is never cached as an answer about the
  // paper, so the next click tries again instead of inheriting a verdict.
  resetLocatorIndex();
  const first = await probe({ id: "missing", fileUrl: "/nothing-here.pdf" }, locator("Table 1"), [1]);
  assert.equal(first.state, "unknown");
  const second = await probe({ id: "missing", fileUrl: "/nothing-here.pdf" }, locator("Table 1"), [1]);
  assert.equal(second.state, "unknown");
});

test("a page of pictures is missing evidence, not evidence of a missing locator", async () => {
  // A scanned paper extracts to nothing at all. Counting those pages as read
  // let the index claim the locator was not in the document, which is the one
  // verdict allowed to send a reader somewhere else — so an image-only paper
  // could hand its citations to whichever other paper had a table of that
  // number. Nothing was ever searched.
  lend("scanned", [[], [], []]);
  assert.equal((await ask("scanned", "Table 4", [1])).state, "unknown");

  // A page that genuinely holds no text is indistinguishable from a scanned one
  // in extracted text, so it is treated the same way: the rest of the document
  // reading clean is not enough.
  lend("mixed", [["body text"], [], ["more body text"]]);
  assert.equal((await ask("mixed", "Table 4", [1])).state, "unknown");
});

test("a passing mention is held while the pages next door are checked", async () => {
  // "As shown in Table 4" is a reference to the table, not the table. Answering
  // with the first match in the cited window put the reader a page short of the
  // thing they clicked on, which reads exactly like the failure this module
  // replaced.
  lend("jit", [
    ["As shown in Table 4, the ablation removes each term in turn"],
    ["Table 4:Ablation study on FLUX"],
  ]);
  const verdict = await ask("jit", "Table 4", [1]);
  assert.equal(verdict.state === "found" && verdict.hit.page, 2);

  // The cited page keeps its claim when the neighbour has nothing better: a
  // mention on the page the citation named still beats wandering off it.
  lend("pid", [
    ["As shown in Table 4, the ablation removes each term in turn"],
    ["and the remaining terms behave as before"],
  ]);
  const near = await ask("pid", "Table 4", [1]);
  assert.equal(near.state === "found" && near.hit.page, 1);
});

test("a stalled document answers unknown rather than holding the click open", async () => {
  // Resolving before navigating is what puts a citation in the right document,
  // but it also means an extraction that never returns is a click that does
  // nothing at all — the same silence, arriving by a different road.
  resetLocatorIndex();
  registerDocument("stalled", {
    numPages: 3,
    getPage: () => new Promise(() => {}),
  } as never);

  const started = Date.now();
  const verdict = await probe(
    { id: "stalled", fileUrl: "/stalled" },
    locator("Table 4"),
    [1],
    { deadline: started + 60 },
  );
  assert.equal(verdict.state, "unknown");
  assert.ok(Date.now() - started < 1000, "the budget, not the document, ends the wait");
});

test("a superseded click stops scanning", async () => {
  // The next click is waiting on the same single-threaded extraction, so a
  // click nobody wants any more must stop reading rather than finish tidily.
  const asked: number[] = [];
  let superseded = false;
  resetLocatorIndex();
  registerDocument("jit", {
    numPages: 30,
    getPage: async (page: number) => {
      asked.push(page);
      // A newer click arrives once this one is under way.
      if (asked.length >= 2) superseded = true;
      return {
        getViewport: () => ({ transform: [1, 0, 0, 1, 0, 0], width: WIDTH, height: HEIGHT }),
        getTextContent: async () => ({
          items: [{ str: "body text", width: 9, hasEOL: true, transform: [SIZE, 0, 0, SIZE, 5, SIZE] }],
        }),
      };
    },
  } as never);

  const abandoned = await probe(
    { id: "jit", fileUrl: "/jit" },
    locator("Table 9"),
    [1],
    { cancelled: () => superseded },
  );
  // Giving up is never a claim about the paper, however many pages were read
  // before the click was superseded.
  assert.equal(abandoned.state, "unknown");
  assert.ok(asked.length < 30, `a superseded scan read ${asked.length} of 30 pages`);
});

test("a citation covering the whole document still answers with what it found", async () => {
  // A held match needs a later window to be answered in, and a citation that
  // names every page leaves none — so a mention in a one-page paper fell
  // through into "this document does not contain Table 4" and handed the
  // citation to whichever paper did.
  lend("alpha", [["As shown in Table 4, each term is removed in turn"]]);
  const single = await ask("alpha", "Table 4", [1]);
  assert.equal(single.state === "found" && single.hit.page, 1);

  lend("beta", [["body text"], ["As shown in Table 4, each term is removed"]]);
  const spanning = await ask("beta", "Table 4", [1, 2]);
  assert.equal(spanning.state === "found" && spanning.hit.page, 2);
});

test("an abandoned click does not warm the document behind the next one", async () => {
  // Warming the rest of a document is for the click that comes next. Extraction
  // is single-threaded, so a sweep belonging to a superseded click is competing
  // with the click that replaced it.
  const readPages = async (cancelAt: number) => {
    const asked: number[] = [];
    resetLocatorIndex();
    registerDocument("jit", {
      numPages: 30,
      getPage: async (page: number) => {
        asked.push(page);
        return {
          getViewport: () => ({ transform: [1, 0, 0, 1, 0, 0], width: WIDTH, height: HEIGHT }),
          getTextContent: async () => ({
            items: [{
              str: page === 1 ? "Table 4:Ablation study" : "body text",
              width: 20, hasEOL: true, transform: [SIZE, 0, 0, SIZE, 5, SIZE],
            }],
          }),
        };
      },
    } as never);

    let superseded = false;
    const verdict = await probe(
      { id: "jit", fileUrl: "/jit" },
      locator("Table 4"),
      [1],
      { cancelled: () => superseded || (asked.length >= cancelAt && (superseded = true)) },
    );
    assert.equal(verdict.state === "found" && verdict.hit.page, 1);
    // Long enough for a sweep of 27 pages to have run to the end, had it been
    // allowed to start or to continue.
    await new Promise((resolve) => setTimeout(resolve, 60));
    return asked.length;
  };

  // Superseded before the answer: no sweep is started at all.
  assert.ok(await readPages(1) <= 2, "a superseded click must not start a sweep");
  // Superseded while the sweep is under way: it stops where it is.
  assert.ok(await readPages(6) < 30, "a running sweep must notice it was abandoned");
});


/** One caption on a page whose viewport and text direction the test chooses. */
async function captionBox(viewport: { transform: number[]; width: number; height: number }, transform: number[]) {
  resetLocatorIndex();
  registerDocument("turned", {
    numPages: 1,
    getPage: async () => ({
      getViewport: () => viewport,
      getTextContent: async () => ({ items: [{ str: "Table 1: Caption", width: 60, hasEOL: true, transform }] }),
    }),
  } as never);
  const verdict = await ask("turned", "Table 1", [1]);
  assert.ok(verdict.state === "found");
  return verdict.hit.rect;
}

const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
const inside = (rect: { x: number; y: number; w: number; h: number }) =>
  rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= 1 + 1e-9 && rect.y + rect.h <= 1 + 1e-9;

test("a caption on a rotated page stays on the page and covers its text", async () => {
  // A 100x200 page with /Rotate 90 renders 200 wide and 100 tall. pdf.js maps
  // user (x, y) to (y, x) on it; the caption runs 60 units from (20, 150).
  const quarter = await captionBox({ transform: [0, 1, 1, 0, 0, 0], width: 200, height: 100 }, [10, 0, 0, 10, 20, 150]);
  assert.ok(inside(quarter), JSON.stringify(quarter));
  // The run is along user x, which is rendered *down* the page: tall and thin.
  assert.ok(quarter.h > quarter.w, JSON.stringify(quarter));
  near(quarter.x, 150 / 200);
  near(quarter.y, 20 / 100);

  // /Rotate 180: both axes flip, so the text reads leftward from its origin.
  const half = await captionBox({ transform: [-1, 0, 0, 1, 100, 0], width: 100, height: 200 }, [10, 0, 0, 10, 20, 150]);
  assert.ok(inside(half), JSON.stringify(half));
  near(half.x, (100 - 20 - 60) / 100);
  near(half.w, 60 / 100);
});

test("a caption set sideways on an upright page is boxed where it is printed", async () => {
  // Text rotated 90° counter-clockwise: it runs up the page from (40, 20).
  const box = await captionBox({ transform: [1, 0, 0, -1, 0, HEIGHT], width: WIDTH, height: HEIGHT }, [0, 10, -10, 0, 40, 20]);
  assert.ok(inside(box), JSON.stringify(box));
  assert.ok(box.h > box.w, JSON.stringify(box));
  near(box.x, (40 - SIZE) / WIDTH);
  near(box.y, (HEIGHT - 20 - 60) / HEIGHT);
});

/**
 * A Letter page as pdf.js really delivers one: each piece of text where it is
 * drawn, in drawing order, with `hasEOL` only where pdf.js sets it. `y` is the
 * baseline in user space, from the bottom of the page.
 */
type Piece = { str: string; x: number; y: number; size?: number; width?: number; eol?: boolean };
const LETTER = { width: 612, height: 792 };

function drawn(pages: Piece[][], extra: Record<string, unknown> = {}) {
  return {
    numPages: pages.length,
    getPage: async (page: number) => ({
      getViewport: () => ({ transform: [1, 0, 0, -1, 0, LETTER.height], ...LETTER }),
      getTextContent: async () => ({
        items: (pages[page - 1] ?? []).map(({ str, x, y, size = 10, width = str.length * size * 0.5, eol = false }) => ({
          str, width, hasEOL: eol, transform: [size, 0, 0, size, x, y],
        })),
      }),
    }),
    ...extra,
  };
}

const lendDrawn = (id: string, pages: Piece[][], extra: Record<string, unknown> = {}) => {
  resetLocatorIndex();
  registerDocument(id, drawn(pages, extra) as never);
};

/** A paragraph of body text: one item per line, each line ending in `hasEOL`. */
const paragraph = (top: number, lines: string[], x = 72): Piece[] =>
  lines.map((str, row) => ({ str, x, y: top - row * 12.7, eol: true }));

const filler = (count: number): Piece[][] =>
  Array.from({ length: count }, () => paragraph(700, ["Body text that mentions nothing in particular at all."]));

test("a caption drawn straight after a figure's last label is a line of its own", async () => {
  // Chinchilla, page 6: pdf.js hands over the figure's last tick label and the
  // caption under it with no line end between them, so the caption arrived as
  // "1.4TFigure 3 j IsoFLOP curves." — no word boundary before "Figure", and
  // not at the start of its line. The prose line below it, which opens with
  // "Figure 3 (left).", was all that matched, and it was boxed instead.
  lendDrawn("chinchilla", [[
    { str: "1.4T", x: 400, y: 690, size: 7 },
    { str: "Figure 3", x: 60, y: 572 },
    { str: " ", x: 104, y: 572 },
    { str: "j", x: 108, y: 572 },
    { str: " ", x: 112, y: 572 },
    { str: "IsoFLOP curves. For various model sizes, we choose the number of tokens", x: 116, y: 572, eol: true },
    ...paragraph(470, [
      "Figure 3 (left). In all cases, we ensure that we have trained a diverse enough set",
      "a clear minimum in the loss. We fit a parabola to each IsoFLOPs curve to directly",
    ], 60),
  ]]);
  const verdict = await ask("chinchilla", "Figure 3", [1]);
  assert.ok(verdict.state === "found");
  assert.equal(verdict.hit.rank, 3);
  near(verdict.hit.rect.y, (792 - 572 - 10) / 792);
  near(verdict.hit.rect.x, 60 / 612);
});

test("a sentence that wraps onto a caption-shaped line is still a sentence", async () => {
  // "Test-Time Scaling Makes Overtraining Compute-Optimal", pages 8 and 9: the
  // table's caption, then a paragraph whose line breaks before "Table 1. This
  // confirms…". Cited a page late, the citation used to stop on the sentence.
  lendDrawn("t2", [
    [{ str: "Table 1: Comparison of overtrained base models vs Chinchilla", x: 230, y: 585, eol: true }],
    paragraph(300, [
      "performance improves across the board compared to the same analysis on",
      "Table 1. This confirms that our findings with T2 scaling persist after post-training.",
    ], 108),
  ]);
  const verdict = await ask("t2", "Table 1", [2]);
  assert.equal(verdict.state === "found" && verdict.hit.page, 1);
});

test("a page number or an axis tick never stands in for a section heading", async () => {
  // The same paper: "4 Experiments" is on page 6 and a bare "4" is page 4's
  // footer. The footer was boxed for "§4, p. 6", because a number alone in its
  // run counted as a heading and the heading itself, with no dot, did not.
  lendDrawn("t2", [
    ...filler(3),
    [...paragraph(700, ["Some text on the fourth page of the paper, then its footer."]), { str: "4", x: 303, y: 42, eol: true }],
    filler(1)[0],
    [...paragraph(700, ["The end of the previous section of the paper."]), { str: "4", x: 72, y: 440, size: 12 }, { str: " ", x: 80, y: 440, size: 12 }, { str: "Experiments", x: 90, y: 440, size: 12, eol: true }],
  ]);
  const verdict = await ask("t2", "§4", [6]);
  assert.ok(verdict.state === "found");
  assert.equal(verdict.hit.page, 6);
  near(verdict.hit.rect.y, (792 - 440 - 12) / 792);

  // Chinchilla: a tick labelled "3.2" tops the figure on page 6; the heading
  // "3.2. Approach 2: IsoFLOP profiles" is on page 5.
  lendDrawn("chinchilla", [
    ...filler(4),
    paragraph(250, ["3.2. Approach 2: IsoFLOP profiles"]),
    [{ str: "3.0", x: 62, y: 690, size: 7, eol: true }, { str: "3.2", x: 62, y: 705, size: 7, eol: true }],
  ]);
  const late = await ask("chinchilla", "§3.2", [6]);
  assert.equal(late.state === "found" && late.hit.page, 5);
});

test("a mention away from the cited pages does not move the citation off them", async () => {
  // "Appendix F, pp. 27–28" once landed on page 4, whose footnote reads "as
  // described in Appendix F", because the appendix's heading went unread and
  // any match anywhere answered. Away from the cited pages only a caption may.
  const pages = filler(30);
  pages[3] = paragraph(80, ["3We compute FLOPs as described in Table 9."]);
  pages[27] = paragraph(700, ["Unreadable caption artwork with the rest of the appendix."]);
  lendDrawn("chinchilla", pages);
  const verdict = await ask("chinchilla", "Table 9", [27, 28]);
  // `unknown` lands on the page the citation gave and keeps its document.
  assert.equal(verdict.state, "unknown");

  // The document does name it, so this is never `absent`, cited page or not;
  // with no page to stand on, the mention is the best there is.
  const anywhere = await ask("chinchilla", "Table 9", []);
  assert.equal(anywhere.state === "found" && anywhere.hit.page, 4);

  // A caption elsewhere still displaces the cited page, as it always did.
  pages[19] = [{ str: "Table 9: The table itself", x: 72, y: 600, eol: true }];
  lendDrawn("chinchilla", pages);
  const caption = await ask("chinchilla", "Table 9", [27, 28]);
  assert.equal(caption.state === "found" && caption.hit.page, 20);
});

test("an equation's number at the margin outranks a reference list's issue number", async () => {
  // Chinchilla's Eq. (1) is on page 2; on page 18 a reference reads
  // "(1):73–101, Mar. 1964", wrapped so that it opens its line. With no page
  // cited, the reference used to win.
  lendDrawn("chinchilla", [
    filler(1)[0],
    [{ str: "L(N, D) = E + A/N", x: 200, y: 450 }, { str: "(1)", x: 520, y: 450, eol: true }],
    ...filler(15),
    paragraph(600, ["(1):73–101, Mar. 1964. ISSN 0003-4851, 2168-8990. doi: 10.1214/aoms/1177703732. URL"]),
  ]);
  const verdict = await ask("chinchilla", "Eq. 1", []);
  assert.ok(verdict.state === "found");
  assert.equal(verdict.hit.page, 2);
  near(verdict.hit.rect.x, 520 / 612);
});

test("a heading-shaped legend in a figure's small type is not a heading", async () => {
  // "Small-Scale Experiments: Are We There Yet?", page 5: a legend reading
  // "4 Configurations" sits above the heading "4 Understanding the
  // Hyperparameter Loss Surface Across Scales" on the same page.
  lendDrawn("small", [[
    { str: "4 Configurations", x: 120, y: 700, size: 7, eol: true },
    ...paragraph(640, ["Body text set at the page's ordinary size for a few lines.", "More body text at the same ordinary size as the line above."]),
    ...paragraph(560, ["Further body text, so the page's own size is plain to see."]),
    { str: "4", x: 72, y: 490, size: 12.6 },
    { str: " ", x: 82, y: 490, size: 12.6 },
    { str: "Understanding the Hyperparameter Loss Surface Across Scales", x: 92, y: 490, size: 12.6, eol: true },
  ]]);
  const verdict = await ask("small", "§4", [1]);
  assert.ok(verdict.state === "found");
  near(verdict.hit.rect.y, (792 - 490 - 12.6) / 792);
});

/** A document whose table of contents points where the test says. */
function outlined(outline: unknown[], destinations: Record<string, unknown[]>) {
  return {
    getOutline: async () => outline,
    getDestination: async (name: string) => destinations[name] ?? null,
    getPageIndex: async (ref: { num: number }) => ref.num - 100,
  };
}

test("a section in the document's own table of contents lands where the outline says", async () => {
  // Nothing on any page reads as the heading, so only the outline can place it.
  // Its destination is an XYZ point on page 7, whatever page the citation gave.
  const pages = filler(9);
  lendDrawn("outlined", pages, outlined([
    { title: "1 Introduction", dest: "s1", items: [] },
    { title: "3 Method", dest: "s3", items: [
      { title: "3.21 A longer number", dest: "s321", items: [] },
      { title: "3.2 Approach", dest: "s32", items: [] },
    ] },
    { title: "13.2 Elsewhere", dest: "s132", items: [] },
  ], {
    s1: [{ num: 100 }, { name: "XYZ" }, 72, 700, null],
    s3: [{ num: 104 }, { name: "XYZ" }, 72, 700, null],
    s321: [{ num: 105 }, { name: "XYZ" }, 72, 700, null],
    s32: [{ num: 106 }, { name: "XYZ" }, 72, 500, null],
    s132: [{ num: 108 }, { name: "XYZ" }, 72, 700, null],
  }));
  const verdict = await ask("outlined", "§3.2", [2]);
  assert.ok(verdict.state === "found");
  assert.equal(verdict.hit.page, 7);
  assert.equal(verdict.hit.rank, 3);
  near(verdict.hit.rect.y, (792 - 500) / 792);
  near(verdict.hit.rect.x, 0);
  near(verdict.hit.rect.w, 1);
  assert.ok(verdict.hit.rect.h > 0 && verdict.hit.rect.h < 0.1, JSON.stringify(verdict.hit.rect));
});

test("an outline destination at the foot of the page before still lands on the heading as printed", async () => {
  // Chinchilla's own outline sets §3.1's destination at the bottom of p. 4,
  // for a heading printed at the top of p. 5: the band used to land there,
  // overruling the page the citation gave.
  const pages = filler(6);
  pages[4] = [{ str: "3.1. Approach 1: Fix model sizes", x: 72, y: 700, eol: true }, ...paragraph(660, ["Body text under the heading."])];
  lendDrawn("foot", pages, outlined([{ title: "3.1 Approach 1", dest: "s31", items: [] }], {
    s31: [{ num: 103 }, { name: "XYZ" }, 72, 60, null],
  }));
  for (const cited of [[5], []]) {
    const verdict = await ask("foot", "§3.1", cited);
    assert.ok(verdict.state === "found");
    assert.equal(verdict.hit.page, 5, String(cited));
    near(verdict.hit.rect.y, (792 - 700 - 10) / 792);
  }
});

test("an appendix marked a part page or two before its heading still lands on the heading", async () => {
  // Chinchilla's Appendix D is marked on p. 22, two pages before it prints.
  const pages = filler(6);
  pages[3] = [{ str: "D. Details on the scaling analyses", x: 72, y: 700, eol: true }, ...paragraph(660, ["Body text under the heading."])];
  lendDrawn("part", pages, outlined([{ title: "Appendix D: Details on the scaling analyses", dest: "d", items: [] }], {
    d: [{ num: 101 }, { name: "XYZ" }, 72, 700, null],
  }));
  const verdict = await ask("part", "Appendix D", []);
  assert.ok(verdict.state === "found");
  assert.equal(verdict.hit.page, 4);
});

test("an outline destination is drawn at the heading's own text when it is there", async () => {
  // A destination marks the space above a heading; the heading's number just
  // under it is the better box.
  const pages = filler(3);
  pages[1] = [
    ...paragraph(700, ["The end of the previous section of the paper."]),
    { str: "F.", x: 72, y: 505, size: 12 }, { str: " ", x: 84, y: 505, size: 12 },
    { str: "FLOPs computation", x: 90, y: 505, size: 12, eol: true },
  ];
  lendDrawn("outlined", pages, outlined([
    { title: "A Training dataset", dest: "a", items: [] },
    { title: "F FLOPs computation", dest: "f", items: [] },
  ], {
    a: [{ num: 100 }, { name: "XYZ" }, 72, 700, null],
    f: [{ num: 101 }, { name: "XYZ" }, 72, 525, null],
  }));
  const verdict = await ask("outlined", "Appendix F", [3]);
  assert.ok(verdict.state === "found");
  assert.equal(verdict.hit.page, 2);
  near(verdict.hit.rect.x, 72 / 612);
  near(verdict.hit.rect.y, (792 - 505 - 12) / 792);
});

test("an outline that cannot answer leaves the text to decide", async () => {
  // The heading is printed on page 5 in every case below.
  const pages = filler(6);
  pages[4] = paragraph(400, ["3.2 Approach 2: IsoFLOP profiles"]);
  const heading = async (extra: Record<string, unknown>, segment = "§3.2") => {
    lendDrawn("fallback", pages, extra);
    const verdict = await ask("fallback", segment, [5]);
    return verdict.state === "found" ? verdict.hit.page : verdict.state;
  };

  // No outline at all, an empty one, and one without this section.
  assert.equal(await heading({ getOutline: async () => null }), 5);
  assert.equal(await heading({ getOutline: async () => [] }), 5);
  assert.equal(await heading(outlined([{ title: "1 Introduction", dest: "s1", items: [] }], { s1: [{ num: 100 }, { name: "XYZ" }, 72, 700, null] })), 5);
  // A destination that will not resolve, or an outline that throws.
  assert.equal(await heading(outlined([{ title: "3.2 Approach", dest: "gone", items: [] }], {})), 5);
  assert.equal(await heading({ getOutline: async () => { throw new Error("broken outline"); } }), 5);
  assert.equal(await heading({
    getOutline: async () => [{ title: "3.2 Approach", dest: "s32", items: [] }],
    getDestination: async () => { throw new Error("broken destination"); },
  }), 5);

  // An unnumbered outline's "A Phenomenological Model…" opens with an article:
  // it is no answer for Appendix A, which is printed on page 6.
  pages[5] = paragraph(600, ["A Related Work"]);
  assert.equal(await heading(outlined([
    { title: "Introduction", dest: "i", items: [] },
    { title: "A Phenomenological Model Predicts Larger Models Learn More", dest: "p", items: [] },
  ], {
    i: [{ num: 100 }, { name: "XYZ" }, 72, 700, null],
    p: [{ num: 101 }, { name: "XYZ" }, 72, 700, null],
  }), "Appendix A"), 6);
});
