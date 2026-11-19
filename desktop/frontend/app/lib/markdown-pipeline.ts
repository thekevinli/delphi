/**
 * Shared syntax policy; renderers keep their own citation and trust boundaries.
 * KaTeX CSS (layout.tsx), validation (remark-latex.ts), and rehype-katex must resolve
 * the same release: 0.18 CSS renamed the layout classes emitted by 0.16.
 * The dependency/stylesheet contract in math-rendering.test.mts guards upgrades.
 */
import type { Options } from "react-markdown";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { remarkLatex } from "./remark-latex.ts";
import { visit } from "unist-util-visit";
import type { Paragraph, Root } from "mdast";

/** Ends a lead-in: its own last mark, or what follows it — a mark, a dash before more words, or the end of its line. */
const LEAD_END = /[.:?!]["”’)]?\s*$/;
const LEAD_AFTER = /^(?:[.:?!]|(?:\s*[—–]|\s+-\s)(?=\s*\S)|\s*\n)/;
/** Bold that is only a number, and a dash before another, is a range ("**2019**–2021", "**4M** - 134M"), not a label; "**GPT-4** — 86%" is a label. */
const NUMBER = /^\s*\d[\d.,]*\s*[%×xkKMBT]?\s*$/;
const RANGE_AFTER = /^\s*[—–-]\s*\d/;

/**
 * Marks bold that opens a paragraph or a list item as a lead-in (`strong.lead`):
 * a label the paragraph is about, ending with its own full stop, colon,
 * question mark or exclamation, followed by one of them or a dash, alone on its
 * line, or the whole paragraph — "**Lead with the answer.** The first line…".
 * A chat answer draws only lead-ins bold (globals.css), so a model's habit of
 * bolding numbers and phrases mid-sentence reads as the sentence. Decided from
 * the parsed tree, so it holds however the model writes its emphasis.
 */
export function remarkLeadIn() {
  return (tree: Root) => {
    visit(tree, "paragraph", (paragraph: Paragraph) => {
      const [opening, next] = paragraph.children;
      // `***Lead.***` is bold inside italics.
      const first = opening?.type === "emphasis" && opening.children.length === 1 ? opening.children[0] : opening;
      if (first?.type !== "strong") return;
      const last = first.children.at(-1);
      const lead =
        !next ||
        next.type === "break" ||
        (last?.type === "text" && LEAD_END.test(last.value)) ||
        (next.type === "text" && LEAD_AFTER.test(next.value) &&
          !(first.children.length === 1 && last?.type === "text" && NUMBER.test(last.value) && RANGE_AFTER.test(next.value)));
      if (lead) first.data = { ...first.data, hProperties: { ...first.data?.hProperties, className: ["lead"] } };
    });
  };
}

export const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm, remarkMath, remarkLatex, remarkLeadIn];
export const REHYPE_PLUGINS: Options["rehypePlugins"] = [
  [rehypeKatex, { strict: false, trust: false }],
];

// Source edits read the syntax the renderer reads: remark's parser, not a second grammar.
const sourceParser = unified().use(remarkParse).use(REMARK_PLUGINS);
export function parseMarkdownSource(source: string) {
  return sourceParser.parse(source);
}

/** The parser owns container indentation and delimiter lengths for every consumer. */
export function markdownCodeRanges(source: string, includeInline = false): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  visit(parseMarkdownSource(source), node => {
    if (node.type !== "code" && !(includeInline && node.type === "inlineCode")) return;
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) ranges.push([start, end]);
  });
  return ranges;
}
