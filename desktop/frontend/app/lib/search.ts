/**
 * Turning a search hit into somewhere to go, a result set into a list, and a
 * query into the spans a result paints bold.
 *
 * Nothing here is new routing. A document hit is a library hit and goes through
 * `libraryHitPath`; a conversation hit is a Dashboard conversation and goes
 * through `conversationDestination`. Both of those already know things this
 * module should not have to re-learn — that a page locator is `?focusPage` and
 * an anchor is `?focusSection`, that a project chat wants `?chat=project`, that
 * a Memory chat has no document to open. Search's own contribution is
 * one line: a wiki page is `/memory?page=<slug>`.
 *
 * Highlighting is the same term list the backend scored with, applied to the
 * displayed string: a match the ranker would not have counted is not painted,
 * and a prefix the ranker would have counted (`att` → `attention`) is. The
 * overlay then only has to wrap the `match` spans.
 *
 * JSX-free with explicit `.ts` import extensions, so `node --test` can strip
 * types and unit-test the parts that decide where a keypress lands.
 */

import { conversationDestination } from "./dashboard.ts";
import { libraryHitPath } from "./routes.ts";

/** The three things an account holds that a person searches for by name. */
export type SearchKind = "memory" | "document" | "conversation";

/** What every row carries, whatever it names — one shape, one renderer. */
export interface SearchResult {
  kind: SearchKind;
  title: string;
  subtitle: string;
  snippet: string;
  score: number;
  /**
   * How many places inside this thing matched the whole query.
   *
   * The second half of its rank, computed on the server: a document is one row
   * however often it says the word, quoted at the first place it said it, and
   * the count is what separates a document about the question from one that
   * mentions it in passing.
   */
  occurrences: number;
  // Memory
  slug?: string;
  pageKind?: string;
  // document
  paperId?: string;
  paperSlug?: string;
  projectId?: string;
  projectSlug?: string;
  documentKind?: string;
  locator?: string;
  locatorKind?: "page" | "section";
  done?: boolean;
  // conversation
  conversationId?: string;
  conversationKind?: string;
  lastDocumentSlug?: string;
  lastEngagedAt?: string;
}

export interface SearchResults {
  memory: SearchResult[];
  documents: SearchResult[];
  conversations: SearchResult[];
}

export interface SearchResponse {
  query: string;
  results: SearchResults;
}

export const EMPTY_RESULTS: SearchResults = {
  memory: [],
  documents: [],
  conversations: [],
};

/**
 * Below this a query is a fragment that matches most of a library.
 *
 * Also what keeps the first keystroke from being a request: a reader typing
 * "metaquery" would otherwise spend nine of them on answers nobody reads.
 */
export const MIN_QUERY = 2;

export type SearchFilter = "all" | SearchKind;

/** The chips, in the order they are drawn. `all` first — it is the default. */
export const FILTERS: SearchFilter[] = [
  "all",
  "memory",
  "document",
  "conversation",
];

const FILTER_LABELS: Record<SearchFilter, string> = {
  all: "All",
  memory: "Memory",
  document: "Documents",
  conversation: "Chats",
};

export function filterLabel(filter: SearchFilter): string {
  return FILTER_LABELS[filter];
}

/** The section heading a group of results sits under. */
export const GROUP_LABELS: Record<SearchKind, string> = {
  memory: "Memory",
  document: "Documents",
  conversation: "Chats",
};

export function groupOf(results: SearchResults, kind: SearchKind): SearchResult[] {
  if (kind === "memory") return results.memory;
  if (kind === "document") return results.documents;
  return results.conversations;
}

/**
 * How many of each kind matched, for the chips.
 *
 * Counted from the response the list is drawn from rather than asked for
 * separately, so a chip can never promise a number the list does not contain.
 */
export function chipCounts(results: SearchResults): Record<SearchFilter, number> {
  const memory = results.memory.length;
  const document = results.documents.length;
  const conversation = results.conversations.length;
  return {
    all: memory + document + conversation,
    memory,
    document,
    conversation,
  };
}

/**
 * The rows on screen, in order, as one flat list.
 *
 * Flat because the selection is: ↓ from the last Memory hit lands on the
 * first document, which is what a reader means by "next", and a per-section
 * index would have to special-case every boundary to say the same thing.
 */
export function visibleResults(
  results: SearchResults,
  filter: SearchFilter,
): SearchResult[] {
  if (filter !== "all") return groupOf(results, filter);
  return [...results.memory, ...results.documents, ...results.conversations];
}

/**
 * Where the next arrow key points.
 *
 * Wraps in both directions, and answers `-1` for an empty list rather than a
 * position that does not exist — pressing ↓ with nothing found should stay
 * nowhere, not select the void.
 */
export function moveSelection(
  current: number,
  delta: number,
  count: number,
): number {
  if (count <= 0) return -1;
  const next = current + delta;
  if (next < 0) return count - 1;
  if (next >= count) return 0;
  return next;
}

/**
 * One run of a result line: either the query, or the text around it.
 *
 * Produced here rather than as JSX so the overlay can paint it and a test can
 * name the marked substring without mounting a dialog.
 */
export interface HighlightSpan {
  text: string;
  match: boolean;
}

/**
 * Kept in step with the backend document index. A second copy is the cost of this
 * module staying JSX-free and importable from `node --test`; the search tests
 * pin the behaviour that would drift if the two copies disagreed about what a
 * term is.
 */
const WORD = /[a-z0-9][a-z0-9'’_-]*/g;
const STOP_WORDS = new Set(["the", "a", "an", "of", "and"]);
const MIN_TERM = 2;
const MIN_PREFIX = 3;

function fold(value: string): string {
  return Array.from(value.normalize("NFKD"))
    .filter((char) => !/\p{M}/u.test(char))
    .join("")
    .toLowerCase();
}

function queryTerms(query: string): string[] {
  const seen: string[] = [];
  for (const match of fold(query).matchAll(WORD)) {
    const term = match[0];
    if (term.length < MIN_TERM || STOP_WORDS.has(term)) continue;
    if (!seen.includes(term)) seen.push(term);
  }
  return seen;
}

function termMatches(word: string, term: string): boolean {
  return term.length >= MIN_PREFIX ? word.startsWith(term) : word === term;
}

/**
 * Folded text plus, for each folded character, the original offset it came
 * from — so a match found after folding (`renyi` for `Rényi`) can be sliced
 * out of the string the reader actually sees.
 */
function foldMap(value: string): { folded: string; from: number[] } {
  let folded = "";
  const from: number[] = [];
  let index = 0;
  for (const char of value) {
    for (const piece of fold(char)) {
      folded += piece;
      from.push(index);
    }
    index += char.length;
  }
  return { folded, from };
}

function originalRange(
  text: string,
  from: number[],
  start: number,
  end: number,
): [number, number] {
  if (end <= start || start >= from.length) return [0, 0];
  const origin = from[Math.min(end, from.length) - 1];
  return [from[start], origin + (text.codePointAt(origin)! > 0xffff ? 2 : 1)];
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const ordered = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ordered) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/**
 * Split `text` into the runs a result should paint, marking every place a
 * query term matches the way the search box itself does.
 *
 * Case and accents are folded for comparison and restored for display, so
 * "metamorph" bolds `Metamorph` and "pixel" bolds the `Pixel` in `PixelDiT`.
 * Short terms still have to be whole words — the same `MIN_PREFIX` gate the
 * ranker uses, so highlighting cannot claim a hit the list would not have
 * returned.
 */
export function highlightMatches(text: string, query: string): HighlightSpan[] {
  if (!text) return [];
  const terms = queryTerms(query);
  if (!terms.length) return [{ text, match: false }];

  const { folded, from } = foldMap(text);
  const ranges: Array<[number, number]> = [];
  for (const match of folded.matchAll(WORD)) {
    const word = match[0];
    const at = match.index ?? 0;
    let longest = 0;
    for (const term of terms) {
      if (term.length > longest && termMatches(word, term)) longest = term.length;
    }
    if (!longest) continue;
    ranges.push(originalRange(text, from, at, at + longest));
  }
  if (!ranges.length) return [{ text, match: false }];

  const spans: HighlightSpan[] = [];
  let cursor = 0;
  for (const [start, end] of mergeRanges(ranges)) {
    if (start > cursor) spans.push({ text: text.slice(cursor, start), match: false });
    spans.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor), match: false });
  return spans;
}

/**
 * The address a result opens.
 *
 * Empty string for a row that cannot be addressed — a document whose project
 * route is missing, a conversation whose document was deleted out from under
 * it. The caller renders those as text rather than as a link that goes
 * nowhere, which is the same answer `conversationDestination` already gives by
 * falling back to `/reader`.
 */
export function searchHref(username: string, result: SearchResult): string {
  if (result.kind === "memory") {
    return result.slug
      ? `/memory?page=${encodeURIComponent(result.slug)}`
      : "";
  }
  if (result.kind === "document") {
    if (!result.projectSlug || !result.paperSlug) return "";
    return libraryHitPath(username, {
      projectSlug: result.projectSlug,
      paperSlug: result.paperSlug,
      kind: result.locatorKind === "section" ? "section" : "page",
      locator: result.locator ?? "",
    });
  }
  return conversationDestination(username, {
    id: result.conversationId ?? "",
    kind: result.conversationKind ?? "",
    projectSlug: result.projectSlug ?? null,
    paperSlug: result.paperSlug ?? null,
    lastDocumentSlug: result.lastDocumentSlug ?? null,
  } as Parameters<typeof conversationDestination>[1]);
}
