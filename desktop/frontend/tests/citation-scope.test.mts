import assert from "node:assert/strict";
import test from "node:test";
import { createContext, createElement, type ReactNode, useContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { blockPaper, paperAliases } from "../app/lib/citations.ts";

const ALIASES = paperAliases([
  { title: "Back to Basics - JiT (2511.13720v2)" },
  { title: "PiD (2605.23902v1)" },
]);
const short = (title: string | null) =>
  title ? (title.startsWith("Back") ? "JiT" : title.split(" ")[0]) : null;

type Node = { position?: { start?: { offset?: number }; end?: { offset?: number } } };

/**
 * Parse with the real markdown pipeline and resolve each element the way the
 * renderer does: a block element from its own source range, an inline one from
 * the block it sits in.
 *
 * `blockPaper` is the shipped decision — the part that was wrong. The
 * inheritance is React context, and this mirrors it rather than importing it,
 * because the test runner strips types but cannot load the `.tsx` the wiring
 * lives in. It must be context and not a stack kept by hand: React renders
 * children after their parent returns, so a parent cannot know when its own
 * subtree is finished.
 */
const Scope = createContext<string | null>(null);

function inferredPapers(source: string) {
  const found: Array<[string, string | null]> = [];
  const element = (tag: string, block: boolean) =>
    function Tag({ node, children }: { node?: Node; children?: ReactNode }) {
      const inherited = useContext(Scope);
      const inferred = block
        ? blockPaper(source, ALIASES, node?.position?.start?.offset, node?.position?.end?.offset)
        : inherited;
      found.push([tag, short(inferred)]);
      const content = block
        ? createElement(Scope.Provider, { value: inferred }, children)
        : children;
      return createElement(tag, null, content);
    };
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm],
      components: {
        p: element("p", true),
        li: element("li", true),
        td: element("td", true),
        em: element("em", false),
        strong: element("strong", false),
      },
      children: source,
    } as never),
  );
  return found;
}

test("emphasis around a citation does not cost it the sentence it sits in", () => {
  // `**(pp. 5-8)**` is a `strong` whose own source range is the citation and
  // nothing else. Read literally, the paper naming the sentence falls outside
  // it — and formatting alone would decide which document opened.
  assert.deepEqual(inferredPapers("PiD reports this (pp. 5–8)."), [["p", "PiD"]]);
  assert.deepEqual(inferredPapers("PiD reports this **(pp. 5–8)**."), [
    ["p", "PiD"],
    ["strong", "PiD"],
  ]);
  assert.deepEqual(inferredPapers("PiD reports this _(pp. 5–8)_."), [
    ["p", "PiD"],
    ["em", "PiD"],
  ]);
});

test("a blockquote's paragraph keeps its paper across the lines it wraps over", () => {
  // One markdown paragraph over several `>` lines. Guessing block boundaries a
  // line at a time splits it and loses the sentence that named the paper; the
  // markdown tree carries the paragraph's real extent, so it decides.
  assert.deepEqual(inferredPapers("> PiD reports this\n> (pp. 5–8)."), [["p", "PiD"]]);
  assert.deepEqual(inferredPapers("> PiD reports this\n> **(pp. 5–8)**."), [
    ["p", "PiD"],
    ["strong", "PiD"],
  ]);
  // The same shape without the quote, and a soft-wrapped paragraph too.
  assert.deepEqual(inferredPapers("PiD reports this\n**(pp. 5–8)**."), [
    ["p", "PiD"],
    ["strong", "PiD"],
  ]);
});

test("each list item keeps its own paper, emphasis and all", () => {
  // The real shape of a comparison answer. Widening to the whole message would
  // name both papers here and so identify neither, losing the inference where
  // it is most needed.
  assert.deepEqual(
    inferredPapers(
      "- JiT’s comparison uses a plain JiT-B/16 (Table 2, pp. 5–6).\n" +
        "- PiD uses a pretrained PixelDiT **(pp. 5–8)**.\n" +
        "- PiD is primarily a decoder (pp. 5–7).",
    ),
    [
      ["li", "JiT"],
      ["li", "PiD"],
      ["strong", "PiD"],
      ["li", "PiD"],
    ],
  );
});

test("prose naming two papers, or none, infers neither", () => {
  assert.deepEqual(inferredPapers("PiD limits JiT’s strongest reading (pp. 5–8)."), [["p", null]]);
  assert.deepEqual(inferredPapers("Prediction and loss space differ (pp. 5–8)."), [["p", null]]);
});

test("a block with no source position infers nothing rather than guessing", () => {
  assert.equal(blockPaper("PiD reports this.", ALIASES, undefined, undefined), null);
});
