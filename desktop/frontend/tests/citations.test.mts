import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import type { Paper } from "../app/lib/api.ts";
import {
  blockContext,
  citationCandidates,
  identifiedPaper,
  libraryLink,
  normalizeCitationMarkup,
  paperAliases,
  rankCitedPapers,
  segmentCitations,
  soleMentionedPaper,
  wholeCitation,
} from "../app/lib/citations.ts";

test("a PDF parenthetical becomes a followable citation", () => {
  const pieces = segmentCitations("See (LingBot-VA 2.0, Table 1, p. 19) above.");
  const citation = pieces.find((piece) => piece.kind === "citation");
  assert.ok(citation);
  assert.equal(citation.target.paperName, "LingBot-VA 2.0");
  assert.deepEqual(citation.target.pages, [19]);
  assert.equal(citation.target.locator?.label, "Table 1");
});

test("a list of anchors is one link per anchor, not one link to the first", () => {
  const written =
    "(“Notes on the Industry Job Search”, §block-6, §block-14, §block-46 and §block-66)";
  const pieces = segmentCitations(`She writes candidly ${written}.`);
  const citations = pieces.flatMap((piece) => (piece.kind === "citation" ? [piece.target] : []));
  assert.deepEqual(
    citations.map((target) => [target.text, target.anchor, target.paperName]),
    [
      ["“Notes on the Industry Job Search”, §block-6", "block-6", "“Notes on the Industry Job Search”"],
      ["§block-14", "block-14", "“Notes on the Industry Job Search”"],
      ["§block-46", "block-46", "“Notes on the Industry Job Search”"],
      ["§block-66", "block-66", "“Notes on the Industry Job Search”"],
    ],
  );
  // The sentence still reads exactly as the model wrote it.
  assert.equal(
    pieces.map((piece) => (piece.kind === "text" ? piece.text : piece.target.text)).join(""),
    `She writes candidly ${written}.`,
  );
});

test("a web section citation keeps its anchor", () => {
  const pieces = segmentCitations(
    "As argued (Why We Think, §thinking-in-tokens).",
  );
  const citation = pieces.find((piece) => piece.kind === "citation");
  assert.ok(citation);
  assert.equal(citation.target.paperName, "Why We Think");
  assert.equal(citation.target.anchor, "thinking-in-tokens");
  assert.deepEqual(citation.target.pages, []);
});

test("a title with nested parentheses still linkifies", () => {
  // The model names sources the way the library does — and many of those
  // titles already carry a parenthetical. A flat `[^()]` match ate the inner
  // "(FS Blog)" and left the whole citation as plain text.
  const source =
    "(Habits vs. Goals (FS Blog), §the-problems-with-goals; §the-benefits-of-habits)";
  const pieces = segmentCitations(source);
  const citations = pieces.filter((piece) => piece.kind === "citation");
  assert.equal(citations.length, 2);
  assert.equal(citations[0].target.paperName, "Habits vs. Goals (FS Blog)");
  assert.equal(citations[0].target.anchor, "the-problems-with-goals");
  assert.equal(citations[1].target.paperName, "Habits vs. Goals (FS Blog)");
  assert.equal(citations[1].target.anchor, "the-benefits-of-habits");
  assert.equal(pieces.map((piece) => piece.kind === "text" ? piece.text : piece.target.text).join(""), source);
});

test("several equation locators stay separate without changing their prose", () => {
  const source =
    "(Eq. 11 and accompanying note, p. 5;Eq. 10, p. 5)";
  const pieces = segmentCitations(source);
  const citations = pieces.filter((piece) => piece.kind === "citation");

  assert.equal(citations.length, 2);
  assert.deepEqual(
    citations.map((piece) => ({
      pages: piece.target.pages,
      label: piece.target.locator?.label,
      paperName: piece.target.paperName,
    })),
    [
      { pages: [5], label: "Equation 11", paperName: null },
      { pages: [5], label: "Equation 10", paperName: null },
    ],
  );
  assert.equal(
    pieces
      .map((piece) =>
        piece.kind === "text" ? piece.text : piece.target.text,
      )
      .join(""),
    source,
  );
});

test("a compound citation may switch documents halfway through", () => {
  const source =
    "(MoE paper, pp. 4, 6–7; “Scaling Laws, Carefully,” §chinchilla-scaling-laws)";
  const citations = segmentCitations(source).filter(
    (piece) => piece.kind === "citation",
  );
  assert.equal(citations.length, 2);
  assert.equal(citations[0].target.paperName, "MoE paper");
  assert.deepEqual(citations[0].target.pages, [4, 6, 7]);
  assert.equal(citations[1].target.paperName, "“Scaling Laws, Carefully,”");
  assert.equal(citations[1].target.anchor, "chinchilla-scaling-laws");
});

test("a meaningful short source alias resolves across documents", () => {
  const current = {
    id: "blog",
    title: "Scaling Laws, Carefully",
    kind: "web",
  } as Parameters<typeof rankCitedPapers>[1][number];
  const moe = {
    id: "moe",
    title: "Scaling Laws for Efficient MoE Language Models - Ant Group",
  } as Parameters<typeof rankCitedPapers>[1][number];
  assert.equal(rankCitedPapers("MoE paper", [current, moe])[0]?.paper.id, "moe");
});

test("a document still answers to its file's name after its digest gave it a title", () => {
  type Candidate = Parameters<typeof rankCitedPapers>[1][number];
  const ntk = {
    id: "ntk",
    title: "Neural Tangent Kernel: Convergence and Generalization in Neural Networks",
    filename: "ntk.pdf",
  } as Candidate;
  const mup = {
    id: "mup",
    title: "Tensor Programs V: Tuning Large Neural Networks via Zero-Shot Hyperparameter Transfer",
    filename: "mup.pdf",
  } as Candidate;
  // An answer written while it was still called "ntk" keeps resolving.
  assert.equal(rankCitedPapers("ntk", [mup, ntk])[0]?.paper.id, "ntk");
  assert.equal(rankCitedPapers("ntk", [mup, ntk])[0]?.score, 100);
  // A short stem claims only an exact citation, never one it merely prefixes.
  const short = { id: "mo", title: "A survey", filename: "mo.pdf" } as Candidate;
  assert.equal(rankCitedPapers("MoE paper", [short]).length, 0);
});

test("a parenthetical that points nowhere stays plain text", () => {
  const pieces = segmentCitations("A short note (FS Blog) in passing.");
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].kind, "text");
});

test("a locator alone is a citation, with no page to stand on", () => {
  // This used to be prose. `locates()` asked for a page or an anchor, so a
  // model that wrote the most natural thing — the name of the table — got an
  // unclickable sentence back.
  const pieces = segmentCitations("as shown in (JiT, Table 2).");
  const citation = pieces.find((piece) => piece.kind === "citation");
  assert.ok(citation);
  assert.equal(citation.target.paperName, "JiT");
  assert.deepEqual(citation.target.pages, []);
  assert.equal(citation.target.locator?.kind, "table");
  assert.equal(citation.target.locator?.number, "2");
});

test("a numbered section sign is a locator, never a web anchor", () => {
  // The anchor class stopped at the dot, so "§3.2" became the anchor "3" —
  // which the PDF branch cannot use, and answered with page 1.
  const citation = segmentCitations("(JiT, §3.2)").find(
    (piece) => piece.kind === "citation",
  );
  assert.ok(citation);
  assert.equal(citation.target.anchor, null);
  assert.equal(citation.target.locator?.label, "Section 3.2");
});

test("one jump target per segment, however many locators it names", () => {
  const citation = segmentCitations("(Eq. 6 and Algorithm 1, p. 7)").find(
    (piece) => piece.kind === "citation",
  );
  assert.ok(citation);
  assert.equal(citation.target.locator?.label, "Equation 6");
});

test("a locator-only continuation links beside its page-bearing sibling", () => {
  const citations = segmentCitations("(JiT, p. 3; Table 2)").filter(
    (piece) => piece.kind === "citation",
  );
  assert.equal(citations.length, 2);
  assert.deepEqual(citations[0].target.pages, [3]);
  assert.equal(citations[1].target.paperName, "JiT");
  assert.equal(citations[1].target.locator?.label, "Table 2");
});

test("a page range is kept whole", () => {
  const target = segmentCitations("(Table 2, pp. 5–6)").find(
    (piece) => piece.kind === "citation",
  )?.target;
  assert.deepEqual(target?.pages, [5, 6]);
  const scattered = segmentCitations("(pp. 1–2, 7–9)").find(
    (piece) => piece.kind === "citation",
  )?.target;
  assert.deepEqual(scattered?.pages, [1, 2, 7, 8, 9]);
});

test("a block's inferred paper stays separate from one the model named", () => {
  const named = segmentCitations("(JiT, p. 3)", "PiD").find(
    (piece) => piece.kind === "citation",
  )?.target;
  assert.equal(named?.paperName, "JiT");
  assert.equal(named?.inferredName, "PiD");

  const nameless = segmentCitations("(pp. 5–8)", "PiD").find(
    (piece) => piece.kind === "citation",
  )?.target;
  assert.equal(nameless?.paperName, null);
  assert.equal(nameless?.inferredName, "PiD");
});

test("the same parenthetical in two blocks follows each block's own paper", () => {
  // Keyed by the text it is written as, "(pp. 5–8)" in one block would
  // overwrite "(pp. 5–8)" in another and both would open one paper. The block
  // is the unit, so identical citations stay independent.
  const aliases = paperAliases([
    { title: "Back to Basics - JiT (2511.13720v2)" },
    { title: "PiD (2605.23902v1)" },
  ]);
  const first = soleMentionedPaper("JiT tests all nine combinations (pp. 5–8).", aliases);
  const second = soleMentionedPaper("PiD trains its 2K pixel prior (pp. 5–8).", aliases);
  assert.equal(first, "Back to Basics - JiT (2511.13720v2)");
  assert.equal(second, "PiD (2605.23902v1)");
});

test("prose that names two papers, or none, infers nothing", () => {
  const aliases = paperAliases([
    { title: "Back to Basics - JiT (2511.13720v2)" },
    { title: "PiD (2605.23902v1)" },
  ]);
  assert.equal(soleMentionedPaper("PiD limits JiT’s strongest reading.", aliases), null);
  assert.equal(soleMentionedPaper("Prediction and loss space are separate.", aliases), null);
});

test("only coined names count as aliases, never ordinary words from a title", () => {
  // "Back" and "Basics" are in a real title here. A paragraph that happens to
  // use one of them is not a paragraph about that paper.
  const aliases = paperAliases([
    { title: "Back to Basics - JiT (2511.13720v2)" },
    { title: "PiD (2605.23902v1)" },
  ]);
  assert.equal(soleMentionedPaper("Back to the question of loss space.", aliases), null);
  assert.equal(soleMentionedPaper("The JiT recipe is direct x-prediction.", aliases),
    "Back to Basics - JiT (2511.13720v2)");
});

test("an alias two papers share is dropped, because it identifies neither", () => {
  const aliases = paperAliases([{ title: "PiD v1 (2605.23902v1)" }, { title: "PiD v2" }]);
  assert.equal(soleMentionedPaper("PiD reports a 2K decode.", aliases), null);
});

test("a uniquely named paper is identified; a tied prefix is not", () => {
  const papers = [
    { id: "m", title: "Alpha Methods" },
    { id: "r", title: "Alpha Results" },
  ] as Parameters<typeof identifiedPaper>[1];
  assert.equal(identifiedPaper("Alpha", papers), null);
  assert.equal(identifiedPaper("Alpha Methods", papers)?.id, "m");
});

test("a page number that is not a page is not believed", () => {
  // Past 2^53 a float cannot count: `page++` returns what it started from, so
  // expanding this range span spun the renderer forever.
  const runaway = segmentCitations("(pp. 9007199254740992–9007199254740992)");
  assert.deepEqual(
    runaway.flatMap((piece) => (piece.kind === "citation" ? piece.target.pages : [])),
    [],
  );
  assert.deepEqual(
    segmentCitations("(p. 99999)").flatMap((piece) =>
      piece.kind === "citation" ? piece.target.pages : [],
    ),
    [],
  );
  // A sane range beside a nonsensical one keeps the part that means something.
  assert.deepEqual(
    segmentCitations("(pp. 4–5, 9007199254740993)").flatMap((piece) =>
      piece.kind === "citation" ? piece.target.pages : [],
    ),
    [4, 5],
  );
});

test("a slug that starts with a digit is still an anchor, and a section number is not", () => {
  const target = (source: string) => {
    const piece = segmentCitations(source).find((item) => item.kind === "citation");
    assert.ok(piece && piece.kind === "citation");
    return piece.target;
  };
  const slug = target("Results hold (Paper, §3-results).");
  assert.equal(slug.anchor, "3-results");
  assert.equal(slug.locator, null, "one anchor, not also Section 3");
  const numbered = target("Results hold (Paper, §3.2).");
  assert.equal(numbered.anchor, null);
  assert.equal(numbered.locator?.kind, "section");
  assert.equal(numbered.locator?.number, "3.2");
  assert.equal(target("See (Paper, §3).").anchor, null);
  // A lettered section is a section too, and never the web anchor "B".
  const lettered = target("See (Paper, §B.1).");
  assert.equal(lettered.anchor, null);
  assert.equal(lettered.locator?.label, "Section B.1");
  assert.equal(target("See §A1.2 there.").anchor, null);
});

test("a citation whose title the model put in italics or bold still linkifies", () => {
  // Plan 2's live journey L1: every answer beside the paper cited as
  // "(*mup*, pp. 8–9.)", the emphasis split the parenthetical, and not one page link showed.
  for (const written of ["(*mup*, pp. 8–9.)", "(**mup**, p. 3)", "(_Why We Think_, §`thinking-in-tokens`)"]) {
    const pieces = segmentCitations(normalizeCitationMarkup(`As shown ${written}`));
    const citation = pieces.find((piece) => piece.kind === "citation");
    assert.ok(citation, written);
  }
  const citation = segmentCitations(normalizeCitationMarkup("As shown (*mup*, pp. 8–9.)")).find((piece) => piece.kind === "citation");
  assert.equal(citation?.kind === "citation" && citation.target.paperName, "mup");
  assert.deepEqual(citation?.kind === "citation" && citation.target.pages, [8, 9]);
  // Emphasis anywhere else is the author's, and stays.
  assert.equal(normalizeCitationMarkup("This is *not* a citation (see *below*)."), "This is *not* a citation (see *below*).");
});

test("any markup inside a citation comes off, whatever the title holds and wherever the markup sits", () => {
  const targets = (written: string) =>
    segmentCitations(normalizeCitationMarkup(`As shown ${written}.`)).flatMap((piece) =>
      piece.kind === "citation" ? [[piece.target.paperName, piece.target.pages.join(","), piece.target.locator?.label ?? null]] : [],
    );
  const VLLM = "vLLM-Omni tech report (2610.09307v1)";
  for (const [written, expected] of [
    // A live answer, 2026-10-17: a title carrying its arXiv id in parentheses,
    // italicised. The old rule's title could not hold "(", and no citation in
    // the answer linked.
    [`(*${VLLM}*, pp. 4–7.)`, [[VLLM, "4,5,6,7", null]]],
    [`(*${VLLM}*, p. 24, Table 6.)`, [[VLLM, "24", "Table 6"]]],
    [`(**${VLLM}**, pp. 7, 10, 24)`, [[VLLM, "7,10,24", null]]],
    [`(*Habits vs. Goals (FS Blog)*, §the-benefits)`, [["Habits vs. Goals (FS Blog)", "", null]]],
    // A locator rather than a page right after the title.
    ["(*mup*, Table 4, p. 9)", [["mup", "9", "Table 4"]]],
    ["(*mup*, Fig. 2)", [["mup", "", "Figure 2"]]],
    ["(*mup* p. 9)", [["mup", "9", null]]],
    // Markup on the locator, not the title.
    ["(mup, *p. 9*)", [["mup", "9", null]]],
    ["(mup, **Table 4**, p. 9)", [["mup", "9", "Table 4"]]],
    // A code span and bold italics are elements too.
    ["(`mup`, p. 9)", [["mup", "9", null]]],
    ["(` mup `, p. 9)", [["mup", "9", null]]],
    ["(***mup***, p. 9)", [["mup", "9", null]]],
    // A second document after the semicolon.
    [`(mup, p. 4; *${VLLM}*, p. 7)`, [["mup", "4", null], [VLLM, "7", null]]],
  ] as const) assert.deepEqual(targets(written), expected, written);
});

test("markup outside a citation, and literal text inside one, is left as written", () => {
  for (const written of [
    "(**Bold aside** with no locator)",
    "a snake_case_name (mup, p. 3) and *emphasis* after it",
    "(\\*not emphasis\\*, p. 3)",
    "Use `f(*x*, p. 3)` here.",
    "```\n(*mup*, p. 9)\n```\n",
    "~~~python\nprint('(*mup*, p. 9)')\n~~~",
    // Struck text is retracted and never cites, so a citation holding any
    // keeps all its markup: unwrapped, the first would cite the page it
    // retracts and the last would open page 8.
    "Retracted (~~p. 2~~).",
    "(~~mup~~, p. 9)",
    "(*mup*, ~~p. 8~~ p. 9)",
  ]) assert.equal(normalizeCitationMarkup(written), written);
  // A URL's underscores and a formula's stars are not emphasis, even in a citation.
  assert.equal(normalizeCitationMarkup("(see [*mup*](https://x.org/_a_b_), p. 3)"), "(see [mup](https://x.org/_a_b_), p. 3)");
  assert.equal(normalizeCitationMarkup("(mup, $x_*$ and *Table 2*, p. 3)"), "(mup, $x_*$ and Table 2, p. 3)");
  // Prose after a fenced block is prose again.
  assert.equal(
    normalizeCitationMarkup("A (*mup*, p. 9)\n\n```\n(*mup*, p. 9)\n```\nB (*mup*, p. 2)"),
    "A (mup, p. 9)\n\n```\n(*mup*, p. 9)\n```\nB (mup, p. 2)",
  );
});

/** What a run of text draws: each citation as "[text | locator | pages | #anchor]", prose between. */
const drawn = (text: string, outside = false) =>
  segmentCitations(text, null, { outside }).map((piece) =>
    piece.kind === "text"
      ? piece.text
      : `[${piece.target.text} | ${piece.target.locator?.label ?? "-"} | ${piece.target.pages.join(",")}${piece.target.anchor ? ` | #${piece.target.anchor}` : ""}]`,
  ).join("");

test("a locator a sentence names is a link, parenthetical or not", () => {
  // A live reading plan, 2026-10-30: 35 locators in bold prose and in lists,
  // none in a parenthetical, and not one of them linked.
  for (const [written, expected] of [
    ["§§3.2–3.4, pp. 5–8", "[§§3.2–3.4, pp. 5–8 | Section 3.2 | 5,6,7,8]"],
    ["Table 1, p. 2; Table 2, p. 3; §4.2, p. 6", "[Table 1, p. 2 | Table 1 | 2]; [Table 2, p. 3 | Table 2 | 3]; [§4.2, p. 6 | Section 4.2 | 6]"],
    ["Equations (1)–(2), p. 3", "[Equations (1)–(2), p. 3 | Equation 1 | 3]"],
    ["especially Figure 3 and Equation (4).", "especially [Figure 3 | Figure 3 | ] and [Equation (4) | Equation 4 | ]."],
    ["Chinchilla's Figure 3 caption, p. 6.", "Chinchilla's [Figure 3 caption, p. 6 | Figure 3 | 6]."],
    ["Fig. 3 (p. 4) shows the consequence", "[Fig. 3 (p. 4) | Figure 3 | 4] shows the consequence"],
    ["In Table A4, that calculation is", "In [Table A4 | Table A4 | ], that calculation is"],
    ["§5.3, pp. 19–21: Figs. 8 and 9.", "[§5.3, pp. 19–21 | Section 5.3 | 19,20,21]: [Figs. 8 and 9 | Figure 8 | ]."],
    ["Put Fig. 9d next to it.", "Put [Fig. 9d | Figure 9 | ] next to it."],
    ["Table 6’s chunking ablation", "[Table 6 | Table 6 | ]’s chunking ablation"],
    ["while p. 5 says just that", "while [p. 5 | - | 5] says just that"],
    ["Theorem 3.1 and Lemma 2 carry it.", "[Theorem 3.1 | Theorem 3.1 | ] and [Lemma 2 | Lemma 2 | ] carry it."],
  ] as const) assert.equal(drawn(written), expected, written);
});

test("a page on its own lines up with the locator before it only across a comma or one word", () => {
  assert.equal(drawn("Figure 1 / §2.1"), "[Figure 1 | Figure 1 | ] / [§2.1 | Section 2.1 | ]");
  assert.equal(drawn("Table 2 compares methods, p. 5 has more"), "[Table 2 | Table 2 | ] compares methods, [p. 5 | - | 5] has more");
});

test("words that only look like a locator stay prose", () => {
  for (const written of ["Section I of the treaty", "table stakes", "tab 2 of the browser", "at 5 p.m. sharp", "step. 3"]) {
    assert.equal(drawn(written), written, written);
  }
});

test("pages spelled out, or as pg., are pages", () => {
  assert.equal(drawn("(Paper, pg. 5)"), "([Paper, pg. 5 | - | 5])");
  assert.equal(drawn("read pages 2–3 first"), "read [pages 2–3 | - | 2,3] first");
});

test("an equation is read as the paper prints it, with its parentheses", () => {
  // The system prompt asks for `Eq. (6)`, which used to parse to no locator.
  const target = segmentCitations("(Chinchilla, Eq. (6), p. 3)").find((piece) => piece.kind === "citation");
  assert.ok(target?.kind === "citation");
  assert.equal(target.target.locator?.label, "Equation 6");
  assert.equal(target.target.paperName, "Chinchilla");
});

test("a doubled section sign lists one anchor per slug", () => {
  assert.equal(
    drawn("(“On-Policy Distillation”, §§block-25, block-29 and block-35.)"),
    "([“On-Policy Distillation”, §§block-25 | - |  | #block-25], [block-29 | - |  | #block-29] and [block-35. | - |  | #block-35])",
  );
  // The list stops at the first word that is not a slug.
  assert.equal(drawn("§§intro, and then we go"), "[§§intro | - |  | #intro], and then we go");
});

test("the space after a semicolon is the sentence's, not the next link's", () => {
  assert.equal(drawn("(§2.5, p. 10; §3.3, p. 11)"), "([§2.5, p. 10 | Section 2.5 | 10]; [§3.3, p. 11 | Section 3.3 | 11])");
});

test("in a block that cites only the web, its prose locators are the web source's", () => {
  const aliases = paperAliases([{ title: "Chinchilla (2203.15556v1)" }]);
  const block = "I found the ERNIE 5.0 report. Inspect **Figure 1 / §2.1**, an application of the trade-off Chinchilla measured. ([arxiv.org](https://arxiv.org/html/2602.04705v1))";
  const context = blockContext(block, aliases, 0, block.length);
  assert.deepEqual(context, { paper: "Chinchilla (2203.15556v1)", outside: true });
  assert.equal(drawn("Figure 1 / §2.1, and p. 7", context.outside), "Figure 1 / §2.1, and p. 7");
  // A parenthetical says whose it is, there as anywhere.
  assert.equal(drawn("as Chinchilla shows (Chinchilla, p. 7)", context.outside), "as Chinchilla shows ([Chinchilla, p. 7 | - | 7])");
  // A block whose citation names a library document is that document's, link or no link.
  const named = "Figure 1 shows it (Chinchilla, p. 3); see also [a blog](https://example.org).";
  assert.equal(blockContext(named, aliases, 0, named.length).outside, false);
});

test("a code span that is one citation is that citation, and any other stays code", () => {
  assert.equal(wholeCitation("Table 3, p. 7")?.locator?.label, "Table 3");
  assert.equal(wholeCitation("Eq. (6)")?.locator?.label, "Equation 6");
  assert.equal(wholeCitation("§3.1 last paragraph")?.locator?.label, "Section 3.1");
  assert.equal(wholeCitation("x = table[3]"), null);
  assert.equal(wholeCitation("see Table 3, then Table 4"), null);
});

test("a citation with nowhere to go has no candidates, so it is drawn as prose", () => {
  const pdf = { id: "c", title: "Chinchilla (2203.15556v1)", filename: "chinchilla.pdf" } as Paper;
  const web = { id: "w", title: "On-Policy Distillation", kind: "web", filename: "thinkingmachines.ai/blog/on-policy-distillation" } as Paper;
  const blog = { id: "b", title: "Scaling Laws, Carefully", kind: "web", filename: "lilianweng.github.io/posts/scaling-laws" } as Paper;
  const page = (text: string) => {
    const piece = segmentCitations(text).find((item) => item.kind === "citation");
    assert.ok(piece?.kind === "citation");
    return piece.target;
  };
  // A Memory chat names a paper the library does not hold, with nothing on screen.
  assert.deepEqual(citationCandidates(page("(Kaplan et al., p. 5)"), [pdf], null, []), []);
  // Pages of a PDF the model read on the web, beside a web page, in a library of web pages.
  assert.deepEqual(citationCandidates(page("Fig. 3 (p. 4)"), [web, blog], web, []), []);
  // The one paged document is the only place a page can mean.
  assert.deepEqual(citationCandidates(page("Fig. 3 (p. 4)"), [web, pdf], web, []).map((paper) => paper.id), ["c"]);
  // A web anchor is not ruled out by having no pages.
  assert.deepEqual(citationCandidates(page("(§block-29)"), [web], web, []).map((paper) => paper.id), ["w"]);
});

test("a title's name before its colon is an alias when it is a coined name", () => {
  const aliases = paperAliases([{ title: "Kimi K3: Open Agentic Intelligence (2611.02417v1)" }, { title: "Scaling Laws: A Survey" }]);
  assert.equal(soleMentionedPaper("Kimi K3 uses Per-Head Muon (§2.5, p. 10).", aliases), "Kimi K3: Open Agentic Intelligence (2611.02417v1)");
  assert.equal(soleMentionedPaper("Scaling Laws tell us little here.", aliases), null);
});

/**
 * The model cites as its instructions show it, so every locator they show must
 * be one this parser reads. Quoted from the prompts verbatim: an edit there
 * that drops one fails here and asks for the example to be checked again.
 */
test("every citation the system prompt teaches is one the parser reads", () => {
  const prompts = ["personas.py", "harness/prompts.py", "harness/association.py"]
    .map((file) => readFileSync(new URL(`../../../core/delphi_core/${file}`, import.meta.url), "utf8"))
    .join("\n");
  for (const example of [
    "(Title, §anchor)",
    "(p. 6)",
    "(p. 3)",
    "(Table 3, p. 7)",
    "§4.2 gives accuracy",
    "so Table 2's",
    "§4 is about ten minutes",
    "Read Table 2's caption",
    "§3.2 works the derivation",
    "Read the last paragraph of §3.1",
    "Skip §5, it restates §3",
    "the caption of Table 2",
    "The convergence proof in §4",
  ]) {
    assert.ok(prompts.includes(example), `the prompt still says ${example}`);
    assert.ok(segmentCitations(example).some((piece) => piece.kind === "citation"), example);
  }
  for (const quoted of ["Table 3, p. 7", "Eq. (6)", "Fig. 2", "§3.1 last paragraph", "Equation 6", "Section 3.2"]) {
    assert.ok(prompts.includes(`\`${quoted}\``), `the prompt still quotes ${quoted}`);
    assert.ok(wholeCitation(quoted), quoted);
  }
});

test("a block that names no paper is about its section's, and a name made an adjective names no paper", () => {
  // A live Memory answer, 2026-10-30: a section per paper, each with a table of
  // places to open that never says whose they are. Read by the cell alone,
  // every one opened the first paper the answer mentioned.
  const aliases = paperAliases([
    { title: "Chinchilla (2203.15556v1)" },
    { title: "Scaling Laws for Native Multimodal Models (2504.07951v4)" },
    { title: "Test-Time Scaling Makes Overtraining Compute-Optimal" },
  ]);
  const answer = [
    "## 1. Chinchilla: minimize pretraining loss",
    "",
    "| Open here | What it establishes |",
    "|---|---|",
    "| **Eq. (1), p. 2** | The objective. |",
    "",
    "## 2. Scaling Laws for Native Multimodal Models: the same trade-off",
    "",
    "### Where the allocation is established",
    "",
    "| Open here | What it establishes |",
    "|---|---|",
    "| **Table 1 and §2.2, p. 2** | Definitions. |",
    "",
    "## 3. Test-Time Scaling Makes Overtraining Compute-Optimal",
    "",
    "Table 1 compares overtrained versus Chinchilla-optimal checkpoints.",
    "",
    "Unlike Chinchilla’s Table 2, this paper's Table 1 reports pass@k.",
    "",
    "**Comparing Chinchilla with Test-Time Scaling Makes Overtraining Compute-Optimal**",
    "",
    "See Table 3.",
    "",
    "## Summary",
    "",
    "Read Table 2 first.",
  ].join("\n");
  const cellAt = (text: string) => {
    const start = answer.indexOf(text);
    return blockContext(answer, aliases, start, start + text.length).paper;
  };
  assert.equal(cellAt("**Eq. (1), p. 2**"), "Chinchilla (2203.15556v1)");
  assert.equal(cellAt("**Table 1 and §2.2, p. 2**"), "Scaling Laws for Native Multimodal Models (2504.07951v4)");
  // "Chinchilla-optimal" is an idea, not the paper: the section decides.
  assert.equal(cellAt("Table 1 compares overtrained versus Chinchilla-optimal checkpoints."), "Test-Time Scaling Makes Overtraining Compute-Optimal");
  // A possessive takes its own locator, and leaves the rest to the section.
  const sentence = "Unlike Chinchilla’s Table 2, this paper's Table 1 reports pass@k.";
  assert.equal(cellAt(sentence), "Test-Time Scaling Makes Overtraining Compute-Optimal");
  const cited = segmentCitations(sentence, cellAt(sentence)).flatMap((piece) => (piece.kind === "citation" ? [[piece.target.text, piece.target.paperName]] : []));
  // The sentence's opening word comes with the name, and matching drops it.
  assert.deepEqual(cited, [["Table 2", "Unlike Chinchilla"], ["Table 1", null]]);
  assert.equal(identifiedPaper("Unlike Chinchilla", [{ id: "c", title: "Chinchilla (2203.15556v1)" }] as Paper[])?.id, "c");
  // A bold title comparing two papers is about neither: the section that
  // holds it, Test-Time Scaling's, decides.
  assert.equal(cellAt("See Table 3."), "Test-Time Scaling Makes Overtraining Compute-Optimal");
  // A section that names no paper does not borrow the one before it.
  assert.equal(cellAt("Read Table 2 first."), null);
});

test("a section anchor in any script is an anchor, and a list of them is one link each", () => {
  assert.equal(
    drawn("(Muon优化器赏析, §§迭代求解, 范数视角, 矩阵范数.)"),
    "([Muon优化器赏析, §§迭代求解 | - |  | #迭代求解], [范数视角 | - |  | #范数视角], [矩阵范数. | - |  | #矩阵范数])",
  );
  assert.equal(drawn("§算法初探 motivates it"), "[§算法初探 | - |  | #算法初探] motivates it");
});

test("a title in any script is named by its own letters", () => {
  const papers = [
    { id: "a", title: "Muon优化器赏析：从向量到矩阵的本质跨越" },
    { id: "b", title: "慢即是快：1. Shampoo的尽头是Muon" },
  ] as Paper[];
  assert.equal(identifiedPaper("Muon优化器赏析：从向量到矩阵的本质跨越", papers)?.id, "a");
});

test("a link to a page the library holds cites the library's copy, at the section it names", () => {
  const papers = [{ title: "Muon blog", url: "https://kellerjordan.github.io/posts/muon/" }, { title: "Muon赏析", url: "https://kexue.fm/archives/10592" }];
  assert.deepEqual(libraryLink("https://kellerjordan.github.io/posts/muon/#definition", "§Definition", papers), {
    text: "§Definition", paperName: "Muon blog", inferredName: null, pages: [], anchor: "definition", locator: null,
  });
  assert.equal(libraryLink("https://www.kexue.fm/archives/10592#%E7%AE%97%E6%B3%95%E5%88%9D%E6%8E%A2", "§算法初探", papers)?.anchor, "算法初探");
  assert.equal(libraryLink("https://kexue.fm/archives/10592#:~:text=Muon", "the post", papers)?.anchor, null);
  assert.equal(libraryLink("https://kexue.fm/archives/10593", "another post", papers), null);
  assert.equal(libraryLink("mailto:someone@example.org", "mail", papers), null);
});

test("a name inside a longer one is part of it, and a title's one-word head names it when no other title has the word", () => {
  const aliases = paperAliases([
    { title: "Chinchilla (2203.15556v1)" },
    { title: "Chimera: Designing and Chinchilla-Scaling Hybrid Visual Diffusion Transformers" },
    { title: "Muon: An optimizer for hidden layers" },
    { title: "Muon优化器赏析" },
  ]);
  assert.equal(soleMentionedPaper("## 1. Chimera: Designing and Chinchilla-Scaling Hybrid Visual Diffusion Transformers", aliases),
    "Chimera: Designing and Chinchilla-Scaling Hybrid Visual Diffusion Transformers");
  assert.equal(soleMentionedPaper("Chimera fits its loss on log residuals.", aliases),
    "Chimera: Designing and Chinchilla-Scaling Hybrid Visual Diffusion Transformers");
  // "Muon" heads one title and is in another: it names neither.
  assert.equal(soleMentionedPaper("Muon orthogonalizes the update.", aliases), null);
});

test("a block that names several papers is the one its own citation names, or its section's", () => {
  const aliases = paperAliases([
    { title: "Chimera: Designing and Chinchilla-Scaling Hybrid Visual Diffusion Transformers" },
    { title: "Scaling Laws for Efficient MoE Language Models - Ant Group (2507.17702v2)" },
  ]);
  const answer = [
    "## 2. Scaling Laws for Efficient MoE Language Models - Ant Group (2507.17702v2)",
    "",
    "Figure 9 is the key place, with no recipe comparable to Chimera’s. (*Scaling Laws for Efficient MoE Language Models - Ant Group (2507.17702v2)*, §4.2.2, p. 15.)",
    "",
    "Figure 10 compares Chimera with Scaling Laws for Efficient MoE Language Models - Ant Group (2507.17702v2).",
    "",
    "## Summary",
    "",
    "Figure 11 compares Chimera with Scaling Laws for Efficient MoE Language Models - Ant Group (2507.17702v2).",
  ].join("\n");
  // A paragraph is its whole line here.
  const at = (opening: string) => {
    const start = answer.indexOf(opening);
    const end = answer.indexOf("\n", start);
    return blockContext(answer, aliases, start, end < 0 ? answer.length : end).paper;
  };
  const moe = "Scaling Laws for Efficient MoE Language Models - Ant Group (2507.17702v2)";
  assert.equal(at("Figure 9 is the key place"), moe);
  // No citation of its own: the section decides, when its paper is one of those named.
  assert.equal(at("Figure 10 compares Chimera"), moe);
  assert.equal(at("Figure 11 compares Chimera"), null);
});

test("a title names its section's paper only when it opens with it", () => {
  // Beside Test-Time Scaling, a section comparing it with Chinchilla is still
  // about the paper on screen: its tables are not Chinchilla's.
  const aliases = paperAliases([{ title: "Chinchilla (2203.15556v1)" }, { title: "Test-Time Scaling Makes Overtraining Compute-Optimal" }]);
  const answer = "### How it differs from Chinchilla\n\nThis paper's **Table 3, p. 7** fits a different objective.\n\n## 2. *Chinchilla*: the baseline\n\nSee **Table 3, p. 8**.";
  const at = (opening: string) => {
    const start = answer.indexOf(opening);
    const end = answer.indexOf("\n", start);
    return blockContext(answer, aliases, start, end < 0 ? answer.length : end).paper;
  };
  assert.equal(at("This paper's"), null);
  assert.equal(at("See **Table 3"), "Chinchilla (2203.15556v1)");
});

test("a possessive names its paper through the sentence's words, and one the library lacks has nowhere to go", () => {
  const chinchilla = { id: "c", title: "Chinchilla (2203.15556v1)", filename: "c.pdf" } as Paper;
  const open = { id: "t", title: "Test-Time Scaling Makes Overtraining Compute-Optimal", filename: "t.pdf" } as Paper;
  const prose = (text: string) => {
    const piece = segmentCitations(text).find((item) => item.kind === "citation");
    assert.ok(piece?.kind === "citation");
    return piece.target;
  };
  assert.deepEqual(citationCandidates(prose("Notably Chinchilla's Table 3 fits it."), [chinchilla, open], open, []).map((paper) => paper.id), ["c", "t"]);
  // Kaplan's table is Kaplan's, and Kaplan is not in the library: not the open paper's Table 2.
  assert.deepEqual(citationCandidates(prose("Kaplan's Table 2 says otherwise."), [chinchilla, open], open, []), []);
});

test("a section sign followed by a space is prose, and an anchor with nowhere to go is too", () => {
  assert.equal(drawn("the § sign marks a section"), "the § sign marks a section");
  const web = { id: "w", title: "Scaling Laws, Carefully", kind: "web", filename: "lilianweng.github.io/posts/scaling-laws" } as Paper;
  const anchor = segmentCitations("(§scaling-laws)").find((item) => item.kind === "citation");
  assert.ok(anchor?.kind === "citation");
  // A Memory chat with nothing open, nothing named and nothing mentioned.
  assert.deepEqual(citationCandidates(anchor.target, [web], null, []), []);
});

test("a code span written in lowercase is a program's, not a citation", () => {
  assert.equal(wholeCitation("table 1"), null);
  assert.equal(wholeCitation("page 2"), null);
  assert.equal(wholeCitation("p. 3")?.pages[0], 3);
});

test("a block reads its section from titles read once per answer, so a streamed answer stays cheap", () => {
  // Read per block, every render of an 8 KB answer re-parsed the whole answer
  // once a block: 330 ms a render, and a render a token while it streamed.
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/recorded-answers.json", import.meta.url), "utf8")) as Array<{ answer: string; papers: Array<{ title: string }> }>;
  const longest = recorded.reduce((a, b) => (b.answer.length > a.answer.length ? b : a));
  const aliases = paperAliases(longest.papers);
  const render = (source: string) => {
    let start = 0;
    for (const block of source.split(/\n\n+/)) {
      blockContext(source, aliases, start, start + block.length);
      start += block.length + 2;
    }
  };
  render(`${longest.answer} `);
  // The next token is a new answer string, as it is while the answer streams.
  const began = performance.now();
  render(longest.answer);
  assert.ok(performance.now() - began < 80, `${Math.round(performance.now() - began)} ms`);
});

test("an author's name and 'et al.' match no paper, however far a name is shortened", () => {
  // Shortened word by word to find "Chinchilla" in "Notably Chinchilla", the
  // name "Hoffmann et al." became "al.", and every "Scaling…" title holds that.
  const papers = [
    { id: "s", title: "Scaling Native Multimodal Pre-Training From Scratch (2607.22043v1)" },
    { id: "c", title: "Chinchilla (2203.15556v1)" },
  ] as Paper[];
  for (const name of ["Hoffmann et al.", "Kaplan et al.", "see the appendix of Hoffmann et al.", "Wei et al., 2022"]) {
    assert.deepEqual(rankCitedPapers(name, papers), [], name);
  }
  assert.equal(identifiedPaper("Notably Chinchilla", papers)?.id, "c");
});

test("a title comparing two papers is about neither", () => {
  const aliases = paperAliases([
    { title: "Chimera: Designing and Chinchilla-Scaling Hybrid Visual Diffusion Transformers" },
    { title: "Chinchilla (2203.15556v1)" },
  ]);
  const answer = "## Chimera vs. Chinchilla\n\nSee Table 3, p. 7.";
  const start = answer.indexOf("See");
  assert.equal(blockContext(answer, aliases, start, answer.length).paper, null);
});
