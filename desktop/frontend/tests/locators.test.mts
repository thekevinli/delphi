import assert from "node:assert/strict";
import test from "node:test";

import { matchLocator, parseLocator } from "../app/lib/locators.ts";

const locator = (segment: string) => {
  const parsed = parseLocator(segment);
  assert.ok(parsed, `expected ${segment} to name a locator`);
  return parsed;
};
const rank = (run: string, segment: string, context: { continues?: boolean; small?: boolean } = {}) =>
  matchLocator(run, locator(segment), context)?.rank ?? null;

test("a citation's locator is read whatever the model abbreviated it to", () => {
  assert.deepEqual(
    ["Table 2", "Tab. 2", "Fig. 2", "Figure 2", "Sec. 3.2", "§3.2", "Eq. 6", "Alg. 1", "Appendix A"]
      .map((segment) => locator(segment).label),
    ["Table 2", "Table 2", "Figure 2", "Figure 2", "Section 3.2", "Section 3.2",
      "Equation 6", "Algorithm 1", "Appendix A"],
  );
});

test("a segment naming two locators still yields one jump target", () => {
  // Following a citation may not scatter highlights across a page.
  assert.equal(locator("Eq. 6 and Algorithm 1, p. 7").label, "Equation 6");
});

/**
 * The numbers below are the ones that actually went wrong. Interpolated into a
 * pattern unescaped, "3.2" matched "3x2"; closed with `\b`, it matched "3.2.1",
 * because the boundary between "2" and "." is a word boundary.
 */
test("a locator does not match a longer identifier that starts with it", () => {
  for (const [run, segment] of [
    ["x 3x2 y", "Section 3.2"],
    ["3.2.1 Sub-subsection", "Section 3.2"],
    ["13.2 is unrelated", "Section 3.2"],
    ["Table 4.1 shows", "Table 4"],
    ["Table 42:Other", "Table 4"],
    ["Figure 21", "Figure 2"],
    ["Figure 2.3", "Figure 2"],
    ["substituting (16) gives", "Eq. 6"],
    ["Algorithm 10", "Algorithm 1"],
  ] as const) {
    assert.equal(matchLocator(run, locator(segment)), null, `${segment} must not match ${run}`);
  }
});

/**
 * Extracted PDF text is not sentences. pdf.js hands back a line as a series of
 * pieces concatenated with no separator, which is why the real captions below
 * read "Table 4:Ablation studyon FLUX" and "Algorithm 1Training step". A test
 * written against clean prose proves nothing about the text this actually runs
 * on, so these fixtures are the real ones.
 */
test("a caption outranks a mention of the same locator", () => {
  assert.equal(rank("Table 4:Ablation studyon FLUX.1 [dev] decoding (left)", "Table 4"), 3);
  assert.equal(rank("Ablation study.Table 4 studies two key design choices", "Table 4"), 1);

  assert.equal(rank("Table 2.Results of all combinationsof loss space", "Table 2"), 3);
  assert.equal(rank("256×256 resolution in Tab. 2(a). As a reference, we ex-", "Table 2"), 1);

  assert.equal(rank("Figure 2.Toy Experiment:d-dimensional (d= 2) underlying", "Figure 2"), 3);
  assert.equal(rank("as the generator and visualize the results in Fig. 2. We ob-", "Figure 2"), 1);
});

test("a heading is recognised by its number, which is all a PDF prints", () => {
  // "Section 3.2" appears nowhere in a paper that has a section 3.2.
  assert.equal(rank("3.2. Prediction Space and Loss Space", "Section 3.2"), 3);
  assert.equal(rank("as described in Section 3.2, the network", "Section 3.2"), 1);
});

test("what follows the label separates a caption from prose that opens a line", () => {
  // Both start their run, on the same page of the same paper. A caption's title
  // follows its label, glued on or capitalised; a sentence goes on in lower case.
  assert.equal(rank("Algorithm 1Training step", "Algorithm 1"), 3);
  assert.equal(rank("Alg. 1 shows the pseudo-code of a training step, and Alg. 2", "Algorithm 1"), 2);
});

test("an equation number alone at the margin counts as its own caption", () => {
  // Its whole run is the number, which is the only signal such a line carries.
  assert.equal(rank(",(6)", "Eq. 6"), 3);
  assert.equal(rank("Accordingly, the objective in Eq. (6) (v-loss) is written as:", "Eq. 6"), 1);
});

/**
 * The runs below are real extracted lines from the papers in a working library
 * (Chinchilla, "Test-Time Scaling Makes Overtraining Compute-Optimal", "Scaling
 * Laws for Native Multimodal Models", Ling's MoE scaling laws and others). Each
 * pair is a caption or heading and the line that used to outrank it.
 */
test("prose that happens to open a line ranks below the caption it mentions", () => {
  // Spelled out and at the start of a line, these read as captions to a rule
  // that only asked whether the noun was written in full.
  assert.equal(rank("Figure 3 (left). In all cases, we ensure that we have trained a diverse enough", "Figure 3"), 2);
  assert.equal(rank("Figure 21 shows that for text and interleaved multimodal", "Figure 21"), 2);
  assert.equal(rank("Figure 6 for Approach 1 and Figure 7 for Approach 2 . We find that", "Figure 6"), 2);
  assert.equal(rank("Figure 21. Early vs late fusion when initializing the encoder", "Figure 21"), 3);

  // "…compared to the same analysis on" / "Table 1. This confirms that…": the
  // text alone is a caption's; the line above says it is a sentence that wrapped.
  assert.equal(rank("Table 1. This confirms that our findings with T2 scaling persist", "Table 1", { continues: true }), 2);
  assert.equal(rank("Table 1. Definitions of the expressions used throughout the paper.", "Table 1"), 3);
});

test("a caption whose separator extracts as a lone letter is still a caption", () => {
  // DeepMind's caption bar comes out of the font as "j".
  assert.equal(rank("Figure 3 j IsoFLOP curves. For various model sizes, we choose", "Figure 3"), 3);
  assert.equal(rank("Table A4 j FLOP comparison. For a variety of different model sizes", "Table A4"), 3);
  assert.equal(rank("Table 6 j Massive Multitask Language Understanding (MMLU).", "Table 6"), 3);
});

test("a heading reaches caption rank with or without a dot after its number", () => {
  assert.equal(rank("3.3 Inference Cost Correction", "Section 3.3"), 3);
  assert.equal(rank("4 Experiments", "Section 4"), 3);
  assert.equal(rank("4.1 Empirical Study on the Interplay between Efficiency Leverage and MoE Architecture", "§4.1"), 3);
  assert.equal(rank("6.1 Comparison with Previous Works.", "§6.1"), 3);
  // The noun in front of a section number marks a reference: headings print
  // the number alone.
  assert.equal(rank("Section 4.1, we observe that the efficiency advantage of MoE increases", "Section 4.1"), 2);
  assert.equal(rank("Section 5.3. The results show that Ling-mini-beta achieves comparable", "Section 5.3"), 2);
});

test("a number with no title after it is not a section", () => {
  for (const [run, segment] of [
    ["4", "Section 4"], // a page number in the footer
    ["3.2", "Section 3.2"], // an axis tick above a figure
    ["7 Trillion 1.71e+24 4.1 Trillion", "Section 4.1"], // a table row
    ["4.1 Trillion 1.71e+24 4.1 Trillion", "Section 4.1"],
    [" 1.5e-3 1.5e-3 5e-4 4.2e-4 4e-4 3.5e-4", "Section 4.2"],
    ["1FAIR at MSL Meta, 2New York University", "Section 1"], // affiliation marks
    ["2. Expert granularity as a non-linear modulator. Superimposed on this primary trend, expert", "Section 2"],
    ["of 3.2%) than for female or neutral pronouns (increases of 8.3% and 9.2%", "Section 3.2"],
  ] as const) {
    assert.equal(matchLocator(run, locator(segment)), null, `${segment} must not match ${run}`);
  }
  // A heading-shaped line in a figure's small type is its legend, not a heading.
  assert.equal(rank("4 Configurations", "Section 4", { small: true }), null);
  // And a line that carries on the sentence above is not a heading either.
  assert.equal(rank("3.2 Billion parameters were trained on the same mixture", "Section 3.2", { continues: true }), null);
});

test("an appendix is found by the letter its heading prints", () => {
  assert.equal(rank("F. FLOPs computation", "Appendix F"), 3);
  assert.equal(rank("A Related Work", "Appendix A"), 3);
  assert.equal(rank("D.2 Approach 3: Parametric fitting of the loss", "Appendix D.2"), 3);
  assert.equal(rank("B.1 Synthetic Experiment", "§B.1"), 3);
  assert.equal(rank("Appendix F: FLOPs computation", "Appendix F"), 3);
  assert.equal(rank("3We compute FLOPs as described in Appendix F.", "Appendix F"), 1);
  for (const [run, segment] of [
    ["FLOPs computation", "Appendix F"], // "F" is not the start of "FLOPs"
    ["F. Pedregosa, G. Varoquaux, A. Gramfort, V. Michel, B. Thirion", "Appendix F"], // references
    ["D. P. Kingma and J. Ba. Adam: A method for stochastic optimization.", "Appendix D"],
    ["J. Nocedal. Updating Quasi-Newton Matrices with Limited Storage.", "Appendix J"],
    ["A key finding emerges when comparing these laws to those of dense models.", "Appendix A"],
    ["a power-law per-task spectrum", "Appendix A"],
    ["E Number of routable experts.", "Appendix E"], // a notation table
    ["G. This quadratic form in log G directly reflects the log-polynomial pattern observed in our initial", "Appendix G"],
  ] as const) {
    assert.equal(matchLocator(run, locator(segment)), null, `${segment} must not match ${run}`);
  }
});

test("a lettered subsection is read whole, wherever it is cited", () => {
  assert.equal(locator("Appendix D.2").label, "Appendix D.2");
  assert.equal(locator("Section A.2").label, "Section A.2");
  assert.equal(locator("§B.1").label, "Section B.1");
  assert.equal(locator("Appendix F").label, "Appendix F");
  assert.equal(locator("Table A4").label, "Table A4");
});

test("an equation's own number ends its line; a reference list's issue number does not", () => {
  assert.equal(rank("𝛼 ¸ 𝛽  (4)", "Eq. 4"), 3);
  assert.equal(rank("L(N,D,k)s.t. 6ND≤C train and 2Nk≤C inf, (1)", "Eq. 1"), 3);
  assert.equal(rank("(1):73–101, Mar. 1964. ISSN 0003-4851, 2168-8990. doi: 10.1214/aoms/1177703732. URL", "Eq. 1"), 1);
  assert.equal(rank("(1) we first fit the frontier, and (2) we extrapolate it", "Eq. 1"), 1);
  // Prose that ends a line on a bare reference is not the equation either.
  assert.equal(rank("and the same holds for the objective in (1)", "Eq. 1"), 1);
  assert.equal(rank("In this section, we first show how Equation (2) can be derived.", "Eq. 2"), 1);
});
