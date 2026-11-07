/**
 * Repair the math convention used by early research digests.
 *
 * The v2 digest prompt asked for Markdown but did not say how to delimit maths,
 * so models often put equations in inline-code spans. Keep genuine identifiers
 * as code while handing spans with strong mathematical signals to remark-math.
 */

import type { Plugin } from "unified";
import type { Root, Nodes, PhrasingContent, Link } from "mdast";
import { mathNode } from "./remark-latex.ts";

const SUBSCRIPTS: Record<string, string> = {
  "₀": "0",
  "₁": "1",
  "₂": "2",
  "₃": "3",
  "₄": "4",
  "₅": "5",
  "₆": "6",
  "₇": "7",
  "₈": "8",
  "₉": "9",
  "ₐ": "a",
  "ₑ": "e",
  "ₕ": "h",
  "ᵢ": "i",
  "ⱼ": "j",
  "ₖ": "k",
  "ₗ": "l",
  "ₘ": "m",
  "ₙ": "n",
  "ₒ": "o",
  "ₚ": "p",
  "ᵣ": "r",
  "ₛ": "s",
  "ₜ": "t",
  "ᵤ": "u",
  "ᵥ": "v",
  "ₓ": "x",
};

const SUPERSCRIPTS: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
};

const MATH_SIGNAL =
  /[Α-ωϑϕϵ∑∏√∞≈≠≤≥‖−×·∈∉₀-₉ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ⁰¹²³⁴⁵⁶⁷⁸⁹\u0300-\u036f]|\\(?:frac|hat|mathbf|mathrm|mathbb|mathcal|operatorname)\b/;

function scripted(
  expression: string,
  pattern: RegExp,
  values: Record<string, string>,
  marker: "_" | "^",
) {
  return expression.replace(pattern, (run) => {
    const value = [...run].map((character) => values[character]).join("");
    return `${marker}{${value}}`;
  });
}

function latexify(expression: string) {
  let result = expression
    .replace(/ẑ/g, String.raw`\hat{z}`)
    .replace(/([A-Za-zΑ-ω])\u0302/g, String.raw`\hat{$1}`)
    .replace(/‖([^‖]+)‖/g, String.raw`\lVert $1 \rVert`)
    .replace(/−/g, "-")
    .replace(/\s~\s/g, String.raw` \sim `);
  result = scripted(result, /[₀-₉ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ]+/g, SUBSCRIPTS, "_");
  return scripted(result, /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, SUPERSCRIPTS, "^");
}

type DigestEvidence = {
  id: number;
  claimType: "author-claim" | "digest-inference" | "external";
  page: number | null;
  section: string | null;
  evidenceId?: string | null;
};

function evidenceLocator(item: DigestEvidence) {
  if (item.page) return `p. ${item.page}`;
  if (item.section) return `§${item.section.replace(/^#|^§/, "")}`;
  return "location unavailable";
}

const EVIDENCE_LABEL = /^e\d+$/i;
const titleKey = (title: string) => title.normalize("NFKC").replace(/\[E\d+\]/gi, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
// An evidence marker is no part of a title, written as text or, beside its `[E1]: …` line, as a reference.
const plainText = (node: Nodes): string => node.type === "linkReference" && EVIDENCE_LABEL.test(node.identifier) ? ""
  : "value" in node ? node.value : "children" in node ? node.children.map(plainText).join("") : "";

/** Whether a digest's title only repeats the name the reader's header shows.
 * The name often carries what the paper does not print, such as an arXiv id or
 * a publisher (`Why Larger Models Learn More (2605.29548v2)`), so a title the
 * name begins with, up to a word boundary, is the same title. */
export function repeatsHeaderTitle(title: string, headerTitle: string) {
  const heading = titleKey(title), header = titleKey(headerTitle);
  return Boolean(heading) && header.startsWith(heading) && !/[\p{L}\p{N}]/u.test(header.charAt(heading.length));
}

/** The digest's own conventions, applied to the parsed document.
 *
 * - An opening level-one heading is the digest's title. It goes only when it
 *   repeats `headerTitle`, the name the reader's header already shows above a
 *   PDF; a web page's header names none, so there it always stays. A kept
 *   title is marked `digest-title`. Anything else that opens the digest, a
 *   level-two heading or the next heading after a dropped title, is a section.
 * - `[E<n>]` in prose is evidence: runs group into one locator link. The label
 *   is reserved, so where CommonMark read `[E1]: claim` as a link definition
 *   the line is prose again. Code, math, HTML and destinations are untouched.
 * - Early digests wrote equations as inline code; a span with mathematical
 *   signals is math, an identifier stays code.
 * - Figures come only from the structured assets, so every image embed goes.
 */
export const remarkDigestMarkdown: Plugin<[{ citations: DigestEvidence[]; headerTitle?: string }], Root> = function ({ citations, headerTitle }) {
  const evidence = new Map(citations.map(citation => [citation.id, citation]));
  const links = (markers: string): PhrasingContent[] => {
    const found = [...markers.matchAll(/\[E(\d+)\]/g)].map(match => evidence.get(Number(match[1])))
      .filter((item): item is DigestEvidence => !!item);
    const groups: DigestEvidence[][] = [];
    for (const item of found) {
      const last = groups.at(-1);
      if (last?.[0].claimType === item.claimType) last.push(item);
      else groups.push([item]);
    }
    return groups.flatMap((group, index): PhrasingContent[] => {
      const pages = [...new Set(group.flatMap(item => item.page ? [item.page] : []))];
      const sections = [...new Set(group.filter(item => !item.page).map(evidenceLocator))];
      const location = [pages.length ? `${pages.length > 1 ? "pp." : "p."} ${pages.join(", ")}` : "", ...sections].filter(Boolean).join("; ");
      // An outside claim says so in its chip: it is not a place in this document.
      const label = group[0].claimType === "external" ? "outside source" : `${location}${group[0].claimType === "digest-inference" ? " · inference" : ""}`;
      const link: Link = { type: "link", url: `#digest-evidence-${group.map(item => item.id).join("-")}`, children: [{ type: "text", value: `(${label})` }] };
      return index ? [{ type: "text", value: " " }, link] : [link];
    });
  };
  return (tree, file) => {
    const source = String(file);
    const raw = (node: Nodes) => source.slice(node.position!.start.offset, node.position!.end.offset);
    // Decided here, once: the view's contents and the stylesheet read the class, never the position.
    const first = tree.children[0];
    if (first?.type === "heading" && first.depth === 1) {
      if (headerTitle && repeatsHeaderTitle(plainText(first), headerTitle)) tree.children.shift();
      else first.data = { ...first.data, hProperties: { ...first.data?.hProperties, className: ["digest-title"] } };
    }
    // Evidence never nests a link inside a link, so labels there stay text.
    const rewrite = (node: Nodes, inLink = false): Nodes[] => {
      if (node.type === "image" || node.type === "imageReference") return [];
      if (node.type === "inlineCode") {
        const expression = node.value.trim();
        return !expression.includes("$") && (MATH_SIGNAL.test(expression) || /^[A-Z]$/.test(expression)) ? [{ ...mathNode(latexify(expression)), position: node.position }] : [node];
      }
      // Escaping the bracket is how Markdown itself spells "this is not a definition".
      if (node.type === "definition" && EVIDENCE_LABEL.test(node.identifier)) {
        return (this.parse("\\" + raw(node)) as Root).children.flatMap(child => rewrite(child));
      }
      if (node.type === "linkReference" && node.referenceType === "shortcut" && EVIDENCE_LABEL.test(node.identifier) && !inLink) return links(raw(node));
      if (node.type === "text" && !inLink) {
        const parts: PhrasingContent[] = [];
        let cursor = 0;
        for (const run of node.value.matchAll(/\[E\d+\](?:[ \t]*\[E\d+\])*/g)) {
          if (run.index > cursor) parts.push({ type: "text", value: node.value.slice(cursor, run.index) });
          parts.push(...links(run[0]));
          cursor = run.index + run[0].length;
        }
        if (!cursor) return [node];
        if (cursor < node.value.length) parts.push({ type: "text", value: node.value.slice(cursor) });
        return parts;
      }
      if ("children" in node) {
        node.children = node.children.flatMap(child => rewrite(child, inLink || node.type === "link" || node.type === "linkReference")) as typeof node.children;
        // A paragraph that held only a removed embed is not a paragraph.
        if (node.type === "paragraph" && node.children.every(child => child.type === "text" && !child.value.trim())) return [];
      }
      return [node];
    };
    rewrite(tree);
  };
};

/** Only locator-shaped code becomes a citation; identifiers remain real code. */
export function digestCodeLocator(value: string): { label: string; page?: number; section?: string } | null {
  const text = value.trim().replace(/^\((.*)\)$/, "$1");
  if (!/^(?:(?:pp?\.|pages?)\s*\d[\d\s,–—-]*|(?:(?:Fig\.|Table|Eq\.|Sec\.|Section)\s*[\w.()–—-]+)(?:,?\s*p\.\s*\d+)?|§[^\n]+)(?:\s*·\s*inference)?$/i.test(text)) return null;
  const page = text.match(/(?:^|[ ,])(?:pp?\.|pages?)\s*(\d+)/i);
  return { label: `(${text})`, page: page ? Number(page[1]) : undefined, section: text.startsWith("§") ? text.slice(1).replace(/\s*·.*$/, "") : undefined };
}

// A structural subset of mdast keeps this transform independent of parser types.
type DigestNode = {
  type: string;
  depth?: number;
  url?: string;
  value?: string;
  children?: DigestNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
};

/** Assign stable heading anchors and place structured figures after whole blocks.
 * Walking the Markdown tree preserves fences, nested lists and display maths. */
export function remarkDigestDocument({ assets }: { assets: Array<{ id: string; afterEvidenceId: number }> }) {
  return (tree: DigestNode) => {
    let heading = 0;
    const placed = new Set<string>();
    const result: DigestNode[] = [];
    for (const block of tree.children ?? []) {
      const evidence = new Set<number>();
      const visit = (node: DigestNode) => {
        if (node.type === "heading") node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: `digest-section-${heading++}` } };
        if (node.type === "link" && node.url?.startsWith("#digest-evidence-")) {
          node.url.slice("#digest-evidence-".length).split("-").forEach(id => evidence.add(Number(id)));
        }
        node.children?.forEach(visit);
      };
      visit(block);
      result.push(block);
      for (const asset of assets) {
        if (placed.has(asset.id) || !evidence.has(asset.afterEvidenceId)) continue;
        placed.add(asset.id);
        result.push({ type: "digestAsset", data: { hName: "figure", hProperties: { "data-digest-asset": asset.id } } });
      }
    }
    for (const asset of assets) {
      if (!placed.has(asset.id)) result.push({ type: "digestAsset", data: { hName: "figure", hProperties: { "data-digest-asset": asset.id } } });
    }
    tree.children = result;
  };
}

type MathElement = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MathElement[];
};

/** MathML Core does not honor KaTeX's legacy percentage-width tag cells.
 * Give a display's number its own layout box while keeping the equation MathML. */
export function rehypeDigestMath() {
  return (tree: MathElement) => {
    const visit = (node: MathElement) => {
      const math = node.tagName === "span" ? node.children?.find(child => child.tagName === "math" && child.properties?.display === "block") : undefined;
      if (math) {
        const classes = Array.isArray(node.properties?.className) ? node.properties.className : [];
        node.properties = { ...node.properties, className: [...classes, "digest-display-equation"] };
        const semantics = math.children?.find(child => child.tagName === "semantics");
        const table = semantics?.children?.[0];
        const cells = table?.tagName === "mtable" && table.properties?.width === "100%" ? table.children?.[0]?.children : undefined;
        if (cells?.length === 4 && !cells[0].children?.length && !cells[2].children?.length) {
          const text = (item: MathElement): string => item.value ?? item.children?.map(text).join("") ?? "";
          semantics!.children![0] = { type: "element", tagName: "mrow", properties: {}, children: cells[1].children };
          node.children!.push({ type: "element", tagName: "span", properties: { className: ["digest-equation-number"] }, children: [{ type: "text", value: text(cells[3]) }] });
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
