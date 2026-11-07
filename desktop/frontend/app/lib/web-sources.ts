/**
 * The web pages an answer cites.
 *
 * The backend reads them off the provider's citations and stores them with the
 * answer (`sources` on the message, and on the stream's `done` event). The
 * provider also writes each citation into the answer text as an ordinary link,
 * so nothing here holds a position: a link in the text *is* a citation exactly
 * when its address is one of the answer's sources.
 *
 * Only `http` and `https` addresses are ever a source or a link a reader can
 * follow. Everything that turns a string from the wire into an `href` goes
 * through `isWebUrl`.
 *
 * JSX-free so `node --test --experimental-strip-types` can load it.
 */

import { visit } from "unist-util-visit";
import { parseMarkdownSource } from "./markdown-pipeline.ts";

export type WebSource = { url: string; title: string };

const SOURCES_MAX = 40;
const URL_MAX_CHARS = 2048;
const TITLE_MAX_CHARS = 200;

/** Whether a string is an address a reader may be sent to. */
export function isWebUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > URL_MAX_CHARS || value !== value.trim()) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/** The site an address is on, as a reader would say it: no scheme, no `www.`. */
export function siteName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The site and path of a page, for a row that says which page was opened. */
export function pageName(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, "");
    return `${parsed.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}

/** The stored `sources` field as sources: bounded, each address once, web addresses only. */
export function normalizeSources(value: unknown): WebSource[] {
  const sources: WebSource[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    if (sources.length >= SOURCES_MAX) break;
    const url = item !== null && typeof item === "object" ? (item as { url?: unknown }).url : undefined;
    if (!isWebUrl(url) || seen.has(url)) continue;
    const title = (item as { title?: unknown }).title;
    seen.add(url);
    sources.push({ url, title: (typeof title === "string" && title.trim() ? title.trim() : siteName(url)).slice(0, TITLE_MAX_CHARS) });
  }
  return sources;
}

/**
 * An address as compared with a source's. The renderer sees a link's address
 * percent-encoded and the text holds it as written, so both sides are read
 * through `URL` before they meet.
 */
const sameAddress = (url: string) => {
  try { return new URL(url).href; } catch { return url; }
};

/** The source a link in the answer text cites, if its address is one of them. */
export function sourceFor(href: string | undefined, sources: WebSource[] | undefined): WebSource | undefined {
  if (!href) return undefined;
  const key = sameAddress(href);
  return sources?.find((source) => sameAddress(source.url) === key);
}

const read = new WeakMap<object, WebSource[]>();

/**
 * A message's stored sources, the same array every time for the same message.
 * A finished answer is memoized on its props, and a list rebuilt on each
 * render would re-render every answer in the thread on every keystroke.
 */
export function storedSources(value: unknown): WebSource[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  let sources = read.get(value);
  if (!sources) {
    sources = normalizeSources(value);
    read.set(value, sources);
  }
  return sources.length ? sources : undefined;
}

const SUFFIX = /^(.+)\s+[·|—–-]\s+(.+?)$/;
const PREFIX = /^(.+?)\s+[·|—–-]\s+(.+)$/;
const REPO = /^([\w.-]+\/[\w.-]+):\s+(.+)$/;
const comparable = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The parts of a host that name its site: `docs.vllm.ai` is "docs" and "vllm". */
function hostLabels(url: string): string[] {
  const labels = siteName(url).split(".");
  return labels.slice(0, Math.max(1, labels.length - 1)).map(comparable).filter(Boolean);
}

/** Whether a title fragment is just the site's own name, as in "· GitHub". */
function namesSite(fragment: string, url: string): boolean {
  const name = comparable(fragment);
  return Boolean(name) && hostLabels(url).some((label) => name === label || name === comparable(siteName(url)));
}

/**
 * A page's title as a list row says it, and what the rest of it said.
 *
 * Pages title themselves for a browser tab: "GitHub - owner/repo: what it is ·
 * GitHub". The site's name is already on the row, so it comes off either end;
 * a repository's description, and anything after a title's own " · ", moves to
 * the detail line instead of crowding the title.
 */
export function cleanSourceTitle(source: WebSource): { title: string; detail: string } {
  let title = source.title.trim();
  const suffix = SUFFIX.exec(title);
  if (suffix && namesSite(suffix[2], source.url)) title = suffix[1].trim();
  const prefix = PREFIX.exec(title);
  if (prefix && namesSite(prefix[1], source.url)) title = prefix[2].trim();
  const repo = REPO.exec(title);
  if (repo) return { title: repo[1], detail: repo[2] };
  const [head, ...rest] = title.split(" · ");
  if (rest.length && head.trim()) return { title: head.trim(), detail: rest.join(" · ").trim() };
  return { title: title || siteName(source.url), detail: "" };
}

/** Tints a letter mark can take; a site keeps its own across every answer. */
export const SITE_TINTS = 4;

/**
 * The mark a site wears where it has no icon: the first letter of its name on
 * a tint chosen by its host, so two sites rarely look alike and one never
 * changes.
 */
export function siteLetter(url: string): { letter: string; tint: number } {
  const host = siteName(url);
  const label = hostLabels(url).find((part) => part !== "docs" && part !== "en") ?? comparable(host);
  let hash = 0;
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { letter: (label[0] ?? "?").toUpperCase(), tint: hash % SITE_TINTS };
}

/** How many times the answer links each source: a page cited twice says so. */
export function citationCounts(links: string[], sources: WebSource[]): Map<string, number> {
  const counts = new Map(sources.map((source) => [source.url, 0]));
  for (const href of links) {
    const cited = sourceFor(href, sources);
    if (cited) counts.set(cited.url, counts.get(cited.url)! + 1);
  }
  return counts;
}

const WRAPPED_LINK = /\(\s*\[[^\]\n]+\]\(https?:\/\//;
const CLOSING = /\s*\)/y;

/**
 * Take the parentheses off a cited link the provider wrapped in them.
 *
 * Providers write a citation as `([github.com](https://…))`. The link becomes
 * a chip that already reads as an aside, and parentheses around it add a pair
 * of brackets to every claim. Only a link that is one of the answer's sources
 * and stands alone in its parentheses is touched, and only where the renderer
 * reads a link: the same text in code or mathematics is the author's.
 */
export function unwrapCitedLinks(markdown: string, sources: WebSource[] | undefined): string {
  if (!sources?.length || !WRAPPED_LINK.test(markdown)) return markdown;
  let result = "";
  let cursor = 0;
  visit(parseMarkdownSource(markdown), "link", (node) => {
    const start = node.position!.start.offset!;
    const end = node.position!.end.offset!;
    if (markdown[start] !== "[" || !sourceFor(node.url, sources)) return;
    let open = start - 1;
    while (open >= cursor && /\s/.test(markdown[open])) open -= 1;
    CLOSING.lastIndex = end;
    if (open < cursor || markdown[open] !== "(" || markdown[open - 1] === "\\" || !CLOSING.test(markdown)) return;
    result += markdown.slice(cursor, open) + markdown.slice(start, end);
    cursor = CLOSING.lastIndex;
  });
  return result + markdown.slice(cursor);
}
