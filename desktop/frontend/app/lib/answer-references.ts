/**
 * Everything an answer rests on, in the order it first cites each: the Memory
 * pages it names, the passages of documents it cites, and the web pages the
 * provider found. Read from the markdown the answer renders, walked the way
 * the renderer walks it, so a row exists exactly where a link does.
 * JSX-free so `node --test --experimental-strip-types` can load it.
 */
import type { Nodes, Parents, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { MemoryKind, Paper } from "./api";
import {
  blockContext,
  citationCandidates,
  type CitationTarget,
  identifiedPaper,
  libraryLink,
  mentionedPapers,
  normalizeCitationMarkup,
  type PaperAlias,
  segmentCitations,
  wholeCitation,
} from "./citations.ts";
import { type KnownPages, splitWikiLinks } from "./memory.ts";
import { REMARK_PLUGINS } from "./markdown-pipeline.ts";
import { citationCounts, cleanSourceTitle, pageName, siteName, unwrapCitedLinks, type WebSource } from "./web-sources.ts";

export type MemoryReference = { slug: string; title: string; kind: MemoryKind; summary: string; cited: number };
export type PassageReference = { key: string; target: CitationTarget; label: string; document: string; mark: string; cited: number };
export type WebReference = { url: string; site: string; title: string; detail: string; cited: number };
export type AnswerReferences = { memory: MemoryReference[]; passages: PassageReference[]; web: WebReference[] };

export type ReferenceScope = {
  sources?: WebSource[];
  pages: KnownPages;
  /** The library a citation can be followed into: the project's, or for Memory the account's. */
  papers?: Paper[];
  aliases?: PaperAlias[];
  /** The document a citation that names none opens, when one is open. */
  current?: string;
};

const BLOCKS = new Set(["paragraph", "listItem", "tableCell"]);
const parser = unified().use(remarkParse).use(REMARK_PLUGINS);

/**
 * The markdown an answer is drawn from. Citation markup is normalized and
 * cited links come out of their parentheses before anything reads offsets, so
 * the renderer and this list measure blocks against the same string.
 */
export function answerMarkdown(content: string, sources: WebSource[] | undefined): string {
  return unwrapCitedLinks(normalizeCitationMarkup(content), sources);
}

/** About one chat's parsed answers, by their text: a new page list re-walks a tree, never re-parses it. */
const trees = new Map<string, Root>();

function tree(markdown: string): Root {
  let parsed = trees.get(markdown);
  if (!parsed) {
    parsed = parser.runSync(parser.parse(markdown)) as Root;
    if (trees.size >= 32) trees.delete(trees.keys().next().value!);
    trees.set(markdown, parsed);
  }
  return parsed;
}

/** Sorted pages as their runs: [1, 2, 7, 8, 9] reads "1–2, 7–9". */
function pageRuns(pages: number[]): string {
  const runs: string[] = [];
  for (let start = 0; start < pages.length;) {
    let end = start;
    while (end + 1 < pages.length && pages[end + 1] === pages[end] + 1) end++;
    runs.push(end > start ? `${pages[start]}–${pages[end]}` : String(pages[start]));
    start = end + 1;
  }
  return runs.join(", ");
}

/** "Table 2", "Pages 5–6", "§ setup": what a citation points at, in a row. */
function passageLabel(target: CitationTarget): string {
  if (target.locator?.label) return target.locator.label;
  if (target.anchor) return `§ ${target.anchor}`;
  // Runs, as the answer wrote them: "pp. 7, 10, 24" is three pages, and
  // reading it "Pages 7–24" claimed eighteen.
  if (target.pages.length > 1) return `Pages ${pageRuns(target.pages)}`;
  if (target.pages.length) return `Page ${target.pages[0]}`;
  return target.text;
}

/** What a node reads as, its markup taken off. */
function words(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  return "children" in node ? (node as Parents).children.map((child) => words(child as Nodes)).join("") : "";
}

/** One citation as the answer draws it: what it points at, and the document a click opens first. */
export type AnswerCitation = { target: CitationTarget; document: string };

/**
 * Walk an answer the way the renderer walks it: the Memory pages it names, the
 * links it carries, and every citation it draws as a link, in order.
 */
function walk(markdown: string, scope: ReferenceScope) {
  const source = answerMarkdown(markdown, scope.sources);
  const memory = new Map<string, MemoryReference>();
  const citations: AnswerCitation[] = [];
  const links: string[] = [];
  const followable = Boolean(scope.papers);
  const papers = scope.papers ?? [];
  const current = papers.find((paper) => paper.title === scope.current) ?? null;
  const mentioned = mentionedPapers(source, papers);

  /** Where a citation's link would go, or nothing: one with nowhere to go is drawn as prose (`citationCandidates`). */
  const draw = (target: CitationTarget) => {
    const candidates = citationCandidates(target, papers, current, mentioned);
    if (!candidates.length) return;
    const named = target.paperName ?? target.inferredName;
    const document = (named && identifiedPaper(named, papers)?.title) || named || scope.current || candidates[0]?.title || "This document";
    citations.push({ target, document });
  };

  const visit = (node: Nodes, block: { start?: number; end?: number } | null, cites: boolean, inLink: boolean) => {
    if (node.type === "link") {
      links.push(node.url);
      // A link to a page the library holds is a citation of its copy (`libraryLink`).
      const kept = followable && cites && !inLink ? libraryLink(node.url, words(node), papers) : null;
      if (kept) draw(kept);
    }
    // A code span that is one citation and nothing else is drawn as it (`CitedCode`).
    if (node.type === "inlineCode" && !inLink && cites && followable) {
      const context = blockContext(source, scope.aliases ?? [], block?.start, block?.end);
      const target = wholeCitation(node.value, context.paper, context);
      if (target) draw(target);
    }
    if (node.type === "text" && !inLink) {
      for (const piece of splitWikiLinks(node.value)) {
        if (piece.kind === "link") {
          const page = scope.pages.get(piece.slug);
          if (!page) continue;
          const seen = memory.get(piece.slug);
          if (seen) seen.cited += 1;
          else memory.set(piece.slug, { slug: piece.slug, title: page.title, kind: page.kind, summary: page.summary ?? "", cited: 1 });
        } else if (cites && followable) {
          const context = blockContext(source, scope.aliases ?? [], block?.start, block?.end);
          for (const cited of segmentCitations(piece.text, context.paper, context)) {
            if (cited.kind === "citation") draw(cited.target);
          }
        }
      }
    }
    if (!("children" in node)) return;
    const parent = node as Parents;
    parent.children.forEach((child, index) => {
      // A tight list item is drawn without its paragraph, so its text reads
      // the whole item's range, as the renderer's does.
      const tight = child.type === "paragraph" && parent.type === "listItem" && !parent.spread;
      const own = BLOCKS.has(child.type) && !tight
        ? { start: child.position?.start.offset, end: child.position?.end.offset }
        : block;
      // A heading names things, and a header row labels columns: neither is
      // where an answer cites a page. Struck text is retracted, and never cites.
      const header = parent.type === "table" && index === 0;
      const uncited = child.type === "heading" || child.type === "delete" || header;
      // What is under a link is not prose; the link itself may still cite (`libraryLink`).
      visit(child, own, cites && !uncited, inLink || parent.type === "link" || parent.type === "linkReference");
    });
  };
  visit(tree(source), null, true, false);
  return { memory, citations, links };
}

/** Every citation an answer draws as a link, in the order it draws them. */
export function answerCitations(markdown: string, scope: ReferenceScope): AnswerCitation[] {
  return walk(markdown, scope).citations;
}

export function answerReferences(markdown: string, scope: ReferenceScope): AnswerReferences {
  const { memory, citations, links } = walk(markdown, scope);
  const passages = new Map<string, PassageReference>();
  for (const { target, document } of citations) {
    const label = passageLabel(target);
    const key = `${document}\u0000${label}\u0000${target.pages.join(",")}`;
    const seen = passages.get(key);
    if (seen) seen.cited += 1;
    else passages.set(key, { key, target, label, document, mark: target.pages.length ? String(target.pages[0]) : "§", cited: 1 });
  }

  const sources = scope.sources ?? [];
  const counts = citationCounts(links, sources);
  return {
    memory: [...memory.values()],
    passages: [...passages.values()],
    web: sources.map((page) => {
      const { title, detail } = cleanSourceTitle(page);
      const path = pageName(page.url).slice(siteName(page.url).length).replace(/^\//, "");
      return { url: page.url, site: siteName(page.url), title, detail: detail || path, cited: counts.get(page.url) ?? 0 };
    }),
  };
}

export function referenceCount(references: AnswerReferences): number {
  return references.memory.length + references.passages.length + references.web.length;
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/**
 * The folded list's one line: what kinds it holds, or for web pages alone,
 * which sites.
 */
export function referenceSummary({ memory, passages, web }: AnswerReferences): string {
  if (!memory.length && !passages.length) {
    const sites = [...new Set(web.map((page) => page.site))];
    const more = sites.length > 2 ? ` +${sites.length - 2}` : "";
    return `${plural(web.length, "page")} · ${sites.slice(0, 2).join(", ")}${more}`;
  }
  return [
    memory.length ? plural(memory.length, "Memory page") : "",
    passages.length ? plural(passages.length, "passage") : "",
    web.length ? plural(web.length, "web page") : "",
  ].filter(Boolean).join(" · ");
}
