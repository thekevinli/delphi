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

export const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm, remarkMath, remarkLatex];
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
