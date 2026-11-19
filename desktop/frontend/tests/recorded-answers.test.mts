import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Paper } from "../app/lib/api.ts";
import { answerCitations, answerMarkdown } from "../app/lib/answer-references.ts";
import { paperAliases } from "../app/lib/citations.ts";
import type { WebSource } from "../app/lib/web-sources.ts";

/**
 * Whole answers, as models wrote them in a reader's own library, and the one
 * property the reader relies on: every place an answer points at is a link,
 * and nothing it cannot open is.
 *
 * Every earlier fix to citation linking was written against the one shape that
 * had just failed, and the next answer wrote another — on 2026-10-30 a reading
 * plan wrote 35 locators in bold prose, not one in a parenthetical, and none
 * linked. So the references here are found by a detector that shares nothing
 * with the parser: a shape the parser misses fails this test instead of
 * reaching a reader. The answers are the model's alone; no question is kept.
 *
 * Each case says what must stay prose and why: an outside report cited by its
 * link (`outside`), or an answer about a paper the library does not hold
 * (`outsideLibrary`), whose pages have nowhere to open.
 */

type Recorded = {
  name: string;
  scope: "document" | "memory";
  current: string | null;
  papers: Array<{ title: string; filename?: string | null; kind?: string | null; url?: string }>;
  sources: WebSource[];
  /** Verbatim stretches of the answer whose locators belong to an outside source. */
  outside?: string[];
  /** The answer cites only documents the library does not hold. */
  outsideLibrary?: boolean;
  /** Where a citation, by its text, must open first. */
  opens?: Record<string, string>;
  answer: string;
};

const recorded: Recorded[] = JSON.parse(readFileSync(new URL("./fixtures/recorded-answers.json", import.meta.url), "utf8"));

/** Anything that points into a document, however a model spells it. Independent of `locators.ts` on purpose. */
const REFERENCE = /(?:§§?\s*|(?<![\w.])(?:Tables?|Tab\.|Figures?|Figs?\.?|Sections?|Sec\.|Equations?|Eqs?\.|Eqns?\.|Algorithms?|Alg\.|Appendix|App\.|Theorems?|Lemmas?|Propositions?|Corollar(?:y|ies)|Definitions?)\s*)(?:\(\d+\)|[A-Z]?\d+(?:\.\d+)*|[A-Z]\b)|(?<![\w.])(?:pp?\.|pgs?\.|[Pp]ages?)\s*\d+/g;

/** Where a web address points, as host and path. */
const place = (url: string | undefined) => url?.replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();

/**
 * The answer's prose: what is left once code, links, headings and struck text
 * are taken out. A link to a page the library holds stays, as its words: it
 * points at a place in the library as surely as "§definition" does.
 */
function prose(markdown: string, papers: Recorded["papers"]): string {
  const held = new Set(papers.map((paper) => place(paper.url)).filter(Boolean));
  return markdown
    .replace(/^(```|~~~)[\s\S]*?^\1/gm, " ")
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, (_, text: string, url: string) => (held.has(place(url)) ? text : " "))
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^#{1,6} .*$/gm, " ")
    .replace(/~~[^~]*~~/g, " ");
}

function scopeOf(answer: Recorded) {
  const papers = answer.papers.map((paper, index) => ({ id: `p${index}`, slug: `p${index}`, ...paper }) as Paper);
  return { pages: new Map(), papers, aliases: paperAliases(papers), current: answer.current ?? undefined, sources: answer.sources };
}

for (const answer of recorded) {
  test(`${answer.name}: every place it points at is a link, and nothing else is`, () => {
    const drawn = answerCitations(answer.answer, scopeOf(answer));
    if (answer.outsideLibrary) {
      // A web anchor still opens the library's web page; a page cannot open a paper that is not there.
      assert.deepEqual(drawn.filter(({ target }) => !target.anchor).map(({ target }) => target.text), []);
      return;
    }
    let left = prose(answerMarkdown(answer.answer, answer.sources), answer.papers);
    for (const outside of answer.outside ?? []) {
      assert.ok(left.includes(outside), `${outside} is in the answer`);
      left = left.split(outside).join(" \u0000 ");
    }
    for (const { target } of drawn) {
      const written = target.text;
      const at = left.indexOf(written);
      assert.ok(at >= 0, `"${written}" is drawn as a link but is not the answer's own prose, or is an outside source's`);
      left = `${left.slice(0, at)} ${left.slice(at + written.length)}`;
    }
    // A code span is prose when it is one citation, consumed above; any other is code.
    left = left.replace(/`[^`\n]*`/g, " ");
    const missed = [...left.matchAll(REFERENCE)].map((match) =>
      `…${left.slice(Math.max(0, match.index - 40), match.index + match[0].length + 20).replace(/\s+/g, " ")}…`);
    assert.deepEqual(missed, [], "every reference in the answer's prose is a link");
  });

  if (answer.opens) {
    test(`${answer.name}: each citation opens the document its block is about`, () => {
      const drawn = answerCitations(answer.answer, scopeOf(answer));
      for (const [written, document] of Object.entries(answer.opens ?? {})) {
        const citation = drawn.find(({ target }) => target.text === written);
        assert.ok(citation, `"${written}" is a link`);
        assert.equal(citation.document, document, written);
      }
    });
  }
}

test("the recorded answers hold no question a reader asked", () => {
  for (const answer of recorded) assert.deepEqual(Object.keys(answer).filter((key) => /question|user|prompt/i.test(key)), []);
});
