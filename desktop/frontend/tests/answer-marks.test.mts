import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Paper } from "../app/lib/api.ts";
import { answerReferences } from "../app/lib/answer-references.ts";
import {
  chipLabels,
  citableDocuments,
  citedDocument,
  type CitationTarget,
  libraryLink,
  mentionedPapers,
  paperAliases,
  segmentCitations,
} from "../app/lib/citations.ts";
import { knownPages } from "../app/lib/memory.ts";
import { render } from "./markdown-test.ts";

const open = { id: "o", title: "Small-Scale Experiments" } as Paper;
const scaling = { id: "s", title: "Scaling Laws for Neural Language Models" } as Paper;
const web = { id: "w", title: "Why We Think", url: "https://lilianweng.github.io/posts/2025-05-01-thinking/", type: "web" } as unknown as Paper;
const papers = [open, scaling, web];

/** The one citation a run of text holds. */
function cited(text: string, inferred: string | null = null): CitationTarget {
  const piece = segmentCitations(text, inferred).find((item) => item.kind === "citation");
  assert.ok(piece && piece.kind === "citation", text);
  return piece.target;
}

/** What the chips of one parenthetical say, beside `current` or with nothing on screen; null for one that is not a chip at all. */
function chips(text: string, current: Paper | null, answer = text, library = papers): Array<string | null> {
  const targets = segmentCitations(text).flatMap((piece) => (piece.kind === "citation" ? [piece.target] : []));
  const found = targets.map((target) => ({ target, cited: citedDocument(target, library, current, mentionedPapers(answer, library)) }));
  return chipLabels(found).map((label) => (label ? (label.document ? `${label.document} · ${label.words}` : label.words) : null));
}
const chip = (text: string, current: Paper | null, answer = text) => chips(text, current, answer)[0];

test("a chip names a document the library holds, unless it is the one on screen", () => {
  // The open document: its name would only repeat the reader panel.
  assert.equal(chip("(Small-Scale Experiments, pp. 4–5, 23)", open), "pp. 4–5, 23");
  // Another document in the library, by its title, then the words the model wrote after its name.
  assert.equal(chip("(Scaling Laws for Neural Language Models, Fig. 4, p. 11)", open), `${scaling.title} · Fig. 4, p. 11`);
  // A shortened name the library identifies is still that document.
  assert.equal(chip("(Scaling Laws, p. 7)", open), `${scaling.title} · p. 7`);
  // No document named beside a paper is that paper's.
  assert.equal(chip("(Table 3, p. 7)", open), "Table 3, p. 7");
  // No document named and nothing on screen, as in Memory: the one the answer names.
  assert.equal(chip("(Table 3, p. 7)", null, "Small-Scale Experiments shows it (Table 3, p. 7)."), "Small-Scale Experiments · Table 3, p. 7");
  // A saved web page by its section.
  assert.equal(chip("(Why We Think, §thinking-in-tokens)", open), "Why We Think · §thinking-in-tokens");
  // A paper the library does not hold has nowhere to go, and is not a chip at all.
  assert.equal(citedDocument(cited("(Kaplan et al., p. 5)"), [web], null, []), null);
});

test("a chip says what the model wrote, never a place rebuilt from what was parsed", () => {
  for (const written of [
    "pp. 7–9, with the protocol in Appendix C, pp. 38–40",
    "Table 1 and §2.2, p. 2",
    "Fig. 9d, p. 4",
    "§§3.2–3.4, pp. 5–8",
    "Eq. 6 and Algorithm 1, p. 7",
    "Table 3 caption, p. 6",
    "p. 7, last paragraph",
  ]) assert.equal(chip(`(${written})`, open), written);
  // Words before a place that name no document the library holds are the model's, and stay.
  assert.equal(chip("(see Table 3, p. 7)", open), "see Table 3, p. 7");
  assert.equal(chip("(e.g., Table 3, p. 7)", open), "e.g., Table 3, p. 7");
  assert.equal(chip("(Kaplan et al., p. 5)", open), "Kaplan et al., p. 5");
  // A link to a web page the library holds is a chip in its own words, and words that are only its name say it once.
  const link = (text: string) => {
    const target = libraryLink(`${web.url}#thinking-in-tokens`, text, papers)!;
    return chipLabels([{ target, cited: citedDocument(target, papers, open, [])! }])[0];
  };
  assert.deepEqual(link("lilianweng.github.io"), { document: web.title, words: "lilianweng.github.io" });
  assert.deepEqual(link(web.title), { document: null, words: web.title });
});

test("a parenthetical names each document once, and never lets a place read as the wrong one's", () => {
  // The open document first goes unnamed, as a chip of its own does; the next names its document.
  assert.deepEqual(chips("(Small-Scale Experiments, p. 4; Scaling Laws, p. 7)", open), ["p. 4", `${scaling.title} · p. 7`]);
  // After another document's chip, the open one is named: unnamed, "p. 4" would read as Scaling Laws' page.
  assert.deepEqual(chips("(Scaling Laws, p. 7; Small-Scale Experiments, p. 4)", open), [`${scaling.title} · p. 7`, `${open.title} · p. 4`]);
  // A second place in the same document is only its place.
  assert.deepEqual(chips("(Scaling Laws, p. 7; Scaling Laws, Fig. 2, p. 9)", open), [`${scaling.title} · p. 7`, "Fig. 2, p. 9"]);
  // A name the library cannot place between them is its words, and the document after it is named again.
  assert.deepEqual(chips("(Scaling Laws, p. 7; Kaplan et al., p. 5; Scaling Laws, p. 9)", open),
    [`${scaling.title} · p. 7`, "Kaplan et al., p. 5", `${scaling.title} · p. 9`]);
  // After a name the library cannot place, the open document is named too, or its place would read as that name's.
  assert.deepEqual(chips("(Kaplan et al., p. 5; Small-Scale Experiments, p. 4)", open), ["Kaplan et al., p. 5", `${open.title} · p. 4`]);
  // A citation with nowhere to go between two of one document's places parts them, as in Memory with no Kaplan held.
  assert.deepEqual(chips("(Scaling Laws, p. 7; Kaplan et al., p. 5; Scaling Laws, p. 9)", null, undefined, [open, scaling]),
    [`${scaling.title} · p. 7`, null, `${scaling.title} · p. 9`]);
});

test("a project conversation cites the whole library, and a title its project holds means its own copy", () => {
  const elsewhere = { id: "x", title: "Out of Project Study" } as Paper;
  const twin = { id: "t", title: scaling.title } as Paper;
  const library = citableDocuments([open, scaling], [twin, open, elsewhere]);
  assert.deepEqual(library.map((paper) => paper.id), ["o", "s", "x"]);
  // Another project's document is a chip like any other, and a shortened title is still this project's copy.
  assert.equal(chips("(Out of Project Study, p. 2)", open, undefined, library)[0], `${elsewhere.title} · p. 2`);
  assert.deepEqual(citedDocument(cited("(Scaling Laws, p. 7)"), library, scaling, []), { title: scaling.title, held: true, open: true });
  assert.equal(chips("(Scaling Laws, p. 7)", scaling, undefined, library)[0], "p. 7");
});

test("the chip and the Sources row name the same document", () => {
  const paragraphs = ["Loss falls with size (Scaling Laws for Neural Language Models, Fig. 4, p. 11).", "The small runs agree (Table 3, p. 7)."];
  const answer = paragraphs.join("\n\n");
  const scope = { pages: knownPages([]), papers, aliases: paperAliases(papers), current: open.title };
  const rows = answerReferences(answer, scope).passages.map((row) => row.document);
  const chips = paragraphs.flatMap((paragraph) => segmentCitations(paragraph).flatMap((piece) =>
    piece.kind === "citation" ? [citedDocument(piece.target, papers, open, mentionedPapers(answer, papers))?.title] : []));
  assert.deepEqual(rows, chips);
  assert.deepEqual(rows, [scaling.title, open.title]);
});

test("a parenthetical is an aside; a place the sentence names is not", () => {
  const roles = (text: string) => segmentCitations(text).flatMap((piece) =>
    piece.kind === "citation" ? [`${piece.target.text}:${piece.aside ? "aside" : "inline"}`] : []);
  assert.deepEqual(roles("It holds (Table 3, p. 7)."), ["Table 3, p. 7:aside"]);
  assert.deepEqual(roles("Table 6, p. 11 reports it, and Fig. 3 (p. 4) shows why."), ["Table 6, p. 11:inline", "Fig. 3 (p. 4):inline"]);
  assert.deepEqual(roles("Chinchilla's Table 3 disagrees."), ["Table 3:inline"]);
  // Two documents in one parenthetical are two asides, and every mark between them is the aside's.
  const pieces = segmentCitations("Both agree (Small-Scale Experiments, p. 4; Scaling Laws, p. 7).");
  assert.deepEqual(pieces.filter((piece) => piece.aside).map((piece) => piece.kind === "text" ? piece.text : "chip"), ["(", "chip", ";", " ", "chip", ")"]);
});

test("only bold that opens a paragraph or an item as its label is a lead-in", () => {
  const leads = (markdown: string) => [...render(markdown).matchAll(/<strong( class="lead")?>([^<]*)<\/strong>/g)].map((match) => `${match[2]}:${match[1] ? "lead" : "plain"}`);
  assert.deepEqual(leads("**Lead with the answer.** The first line is the claim."), ["Lead with the answer.:lead"]);
  assert.deepEqual(leads("1. **Short horizon**: the loss is greedy.\n2. **Bias** — it compounds."), ["Short horizon:lead", "Bias:lead"]);
  assert.deepEqual(leads("- **Bias** - it compounds.\n- **Drift**—it grows.\n- **Why?** Because."), ["Bias:lead", "Drift:lead", "Why?:lead"]);
  // A label alone on its line, after a soft or a hard break, or the whole paragraph.
  assert.deepEqual(leads("**Summary**\nThe result holds."), ["Summary:lead"]);
  assert.deepEqual(leads("**Summary**  \nThe result holds."), ["Summary:lead"]);
  assert.deepEqual(leads("**Key result**"), ["Key result:lead"]);
  // A tight item and a loose one alike.
  assert.deepEqual(leads("- **Tight.** One.\n\n- **Loose.** Two."), ["Tight.:lead", "Loose.:lead"]);
  // A place or a number the model bolded is part of its sentence.
  assert.deepEqual(leads("**Table 6, p. 11** reports it."), ["Table 6, p. 11:plain"]);
  assert.deepEqual(leads("Error rises from **7.9% at 4M to 28.1% at 134M** as the model grows."), ["7.9% at 4M to 28.1% at 134M:plain"]);
  assert.deepEqual(leads("It is a **theoretical proposal.** Nothing more."), ["theoretical proposal.:plain"]);
  // Bold inside italics leads as well.
  assert.deepEqual(leads("***Lead.*** The rest."), ["Lead.:lead"]);
  // A dash that opens a range is the number's, not a label's.
  assert.deepEqual(leads("**2019**–2021 saw growth."), ["2019:plain"]);
  assert.deepEqual(leads("**4M**–**134M** parameters."), ["4M:plain", "134M:plain"]);
  assert.deepEqual(leads("**4M** - 134M parameters."), ["4M:plain"]);
  // A label before a dash and a number is still a label.
  assert.deepEqual(leads("**Bias** — 2 factors compound."), ["Bias:lead"]);
  assert.deepEqual(leads("- **Throughput** — 3× higher"), ["Throughput:lead"]);
  // A label with a number in its name is still a label.
  assert.deepEqual(leads("- **GPT-4** — 86% accuracy\n- **Llama 2 (7B)** — 45.3%\n- **Step 2** — 3 runs"), ["GPT-4:lead", "Llama 2 (7B):lead", "Step 2:lead"]);
  // Headings and table cells are not paragraphs: their bold is never a lead-in.
  assert.deepEqual(leads("## **Results.** Here"), ["Results.:plain"]);
  assert.deepEqual(leads("| A | B |\n|---|---|\n| **best.** | 2 |"), ["best.:plain"]);
});

test("every recorded answer's chips say only what it wrote, and name only documents its library holds", () => {
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/recorded-answers.json", import.meta.url), "utf8")) as Array<{ answer: string; papers: Array<{ title: string }>; current: string | null }>;
  let chips = 0;
  for (const { answer, papers: library, current } of recorded) {
    const shelf = library.map((paper, index) => ({ id: String(index), ...paper })) as Paper[];
    const here = shelf.find((paper) => paper.title === current) ?? null;
    const mentioned = mentionedPapers(answer, shelf);
    for (const piece of segmentCitations(answer)) {
      if (piece.kind !== "citation" || !piece.aside) continue;
      const found = citedDocument(piece.target, shelf, here, mentioned);
      if (!found) continue;
      const [label] = chipLabels([{ target: piece.target, cited: found }]);
      chips++;
      assert.ok(label.words && piece.target.text.includes(label.words), `${piece.target.text} → ${label.words}`);
      if (label.document) assert.ok(shelf.some((paper) => paper.title === label.document) && label.document !== here?.title, label.document);
    }
  }
  assert.ok(chips > 50, `only ${chips} chips`);
});
