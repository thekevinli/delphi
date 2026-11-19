import type { PdfRect } from "./api";
import { loadPdfEngine, type PdfDocument } from "./pdf-engine.ts";
import { CAPTION, matchLocator, type Locator } from "./locators.ts";

/**
 * Where a locator actually sits in a document.
 *
 * The reader used to answer that question by searching the *rendered* text
 * layer for the noun the model wrote, which could not work (see `locators.ts`)
 * and, when it failed, withheld the scroll for 3.6 seconds before outlining the
 * whole page. This reads the document's own text through pdf.js instead, so a
 * citation arrives at a coordinate that is already known and the viewer never
 * searches for anything.
 */

export type LocatorHit = { page: number; rect: PdfRect; rank: number };

/**
 * `absent` is a strong claim — it is the only verdict that may move a reader to
 * a different paper — so it is earned rather than assumed. Finding nothing in
 * the pages a citation named is `unknown`; so is any page whose text could not
 * be extracted. Only a complete, clean scan of the whole document with no match
 * is `absent`.
 */
export type Verdict =
  | { state: "found"; hit: LocatorHit }
  | { state: "absent" }
  | { state: "unknown" };

export type IndexTarget = { id: string; fileUrl: string };

/** One line of extracted text, and where each of its pieces sits on the page. */
type Run = {
  text: string;
  parts: Array<{ at: number; to: number; rect: PdfRect }>;
  /** Where the line starts, in its own text space; null until a visible piece arrives. */
  head: Pen | null;
  /** The line carries on a sentence the line above left unfinished (`RunContext`). */
  continues: boolean;
  /** The line is set smaller than the page's text (`RunContext`). */
  small: boolean;
};

/**
 * A text item's place in user space: its origin, the unit vectors it is set
 * along and up, its type size, and how far it extends along its line.
 */
type Pen = { x: number; y: number; ax: number; ay: number; ux: number; uy: number; size: number; width: number };

function pen(transform: number[], width: number): Pen {
  const [a, b, c, d, e, f] = transform;
  const along = Math.hypot(a, b) || 1;
  const size = Math.hypot(c, d) || 1;
  return { x: e, y: f, ax: a / along, ay: b / along, ux: c / size, uy: d / size, size, width };
}

/**
 * Whether `next` starts a new line rather than continuing the one `last` is on.
 *
 * pdf.js marks most line ends with `hasEOL`, but not all of them: between two
 * separately drawn blocks — a figure's last tick label, then the caption set
 * under it — it hands the pieces over back to back, and the caption arrived as
 * "1.4TFigure 3 j IsoFLOP curves", which neither opens with its label nor has
 * a word boundary before it. So a line also ends where the text turns, drops
 * or rises by most of a line, steps back to the left, or jumps forward across
 * a gap no word space spans — a table's next column, an equation's number at
 * the margin. Sub- and superscripts move by well under that.
 */
function newLine(last: Pen, next: Pen): boolean {
  if (last.ax * next.ax + last.ay * next.ay < 0.9) return true;
  const dx = next.x - last.x;
  const dy = next.y - last.y;
  const along = dx * last.ax + dy * last.ay;
  const rise = dx * last.ux + dy * last.uy;
  const em = Math.max(last.size, next.size);
  return Math.abs(rise) > 0.8 * em || along < -em || along - last.width > 3 * em;
}

/**
 * Whether `run` is the next line of a sentence `above` left unfinished: the
 * line above is a line of prose that stops on a lowercase word, a comma or a
 * hyphen, and this one starts at the same margin, in the same type, one line
 * further down. A caption or a heading is set apart from the paragraph before
 * it; a wrapped line is not. A short line above is a heading, whose last word
 * is lowercase as often as not — "7 Related Work" over "7.1 Scaling Laws".
 */
function wraps(above: Run, run: Run): boolean {
  const a = above.head, b = run.head;
  const text = above.text.trim();
  if (!a || !b || text.length < 30 || !/[\p{Ll},\u2010-\u2013-]$/u.test(text)) return false;
  if (a.ax * b.ax + a.ay * b.ay < 0.9 || Math.abs(a.size - b.size) > 0.15 * a.size) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const across = dx * a.ax + dy * a.ay;
  const down = -(dx * a.ux + dy * a.uy);
  return Math.abs(across) < 2 * a.size && down > 0.5 * a.size && down < 1.7 * a.size;
}

type Entry = {
  key: string;
  document: Promise<PdfDocument>;
  /** Set when this module opened the document and must therefore destroy it. */
  release: (() => void) | null;
  runs: Map<number, Run[]>;
  failed: Set<number>;
  /**
   * Pages that read clean but held no text at all. A scanned page is a picture
   * of words: it is missing searchable evidence, not evidence of a missing
   * locator, and counting it as scanned is how an image-only paper talked the
   * index into saying "not here" and sent a citation into a different document.
   */
  barren: Set<number>;
  pages: number;
  /** Cleared on eviction so a background sweep stops touching a dead document. */
  live: boolean;
  /** The document's own table of contents, read once (`readOutline`). */
  outline: Promise<Mark[]> | null;
};

/** One entry of a document's table of contents, flattened in reading order. */
type Mark = { title: string; dest: unknown };

/**
 * The part of pdf.js's document proxy that reads a table of contents, typed
 * loosely enough that a document without one — or a test's stand-in — is
 * simply a document with no outline.
 */
type OutlineItem = { title?: string; dest?: unknown; items?: OutlineItem[] | null };
type OutlineSource = {
  getOutline?: () => Promise<OutlineItem[] | null>;
  getDestination?: (id: string) => Promise<unknown[] | null>;
  getPageIndex?: (ref: unknown) => Promise<number>;
  getPage: (page: number) => Promise<{ getViewport: (options: { scale: number }) => { transform: number[]; height: number } }>;
};

/**
 * The paper on screen is already open in `PdfViewer`, which owns its loading
 * task and destroys it on cleanup. Borrowing that proxy avoids parsing the same
 * file twice; the index never destroys a borrowed document.
 */
const borrowed = new Map<string, PdfDocument>();

export function registerDocument(id: string, document: PdfDocument) {
  borrowed.set(id, document);
}

export function unregisterDocument(id: string) {
  borrowed.delete(id);
  for (const [key, entry] of entries) if (entry.key.startsWith(`${id}\n`) && !entry.release) evict(key);
}

/** Four documents is a conversation's worth of cross-references, not a cache. */
const LIMIT = 4;
const entries = new Map<string, Entry>();

function evict(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  entry.live = false;
  entry.release?.();
}

function open(target: IndexTarget): Entry {
  const key = `${target.id}\n${target.fileUrl}`;
  const existing = entries.get(key);
  if (existing) {
    // Re-insert so the map's own order is the recency order.
    entries.delete(key);
    entries.set(key, existing);
    return existing;
  }

  const lent = borrowed.get(target.id);
  const entry: Entry = { key, document: Promise.resolve(lent as PdfDocument), release: null, runs: new Map(), failed: new Set(), barren: new Set(), pages: 0, live: true, outline: null };
  if (!lent) {
    entry.document = loadPdfEngine().then(module => {
      const task = module.getDocument({ url: target.fileUrl, withCredentials: true });
      // Published before the document is awaited, not after: a load that
      // rejects still holds a task, and an entry evicted mid-load would
      // otherwise leave it running with nobody left to destroy it.
      entry.release = () => void task.destroy();
      if (!entry.live) entry.release();
      return task.promise as Promise<PdfDocument>;
    });
  }
  // Evict a document that failed to open rather than caching the failure, which
  // would make every later click on that paper answer `unknown`.
  void entry.document.then(
    doc => {
      entry.pages = doc.numPages;
      if (!entry.live) entry.release?.();
    },
    () => evict(key),
  );

  entries.set(key, entry);
  while (entries.size > LIMIT) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    evict(oldest);
  }
  return entry;
}

/**
 * Where a text item sits on the page, as fractions of the rendered viewport.
 *
 * Built from the item's four corners rather than from its origin plus a width
 * to the right and a height upward: that shortcut is only true of upright text
 * on an unrotated page. A page with `/Rotate 90` or a caption set sideways put
 * the box off the page's edge and still reported it as a hit. The run extends
 * `width` along the text's own direction and one font size along its up
 * vector, both in user space; the viewport then carries each corner into the
 * rendered page, rotation and all, and the box is their bounding rectangle.
 */
function itemRect(
  viewport: { transform: number[]; width: number; height: number },
  transform: number[],
  width: number,
): PdfRect {
  const [a, b, c, d, e, f] = transform;
  const along = Math.hypot(a, b) || 1;
  const size = Math.hypot(c, d) || 1;
  const corners = [[0, 0], [width, 0], [0, size], [width, size]].map(([s, t]) => {
    const x = e + (a / along) * s + (c / size) * t;
    const y = f + (b / along) * s + (d / size) * t;
    const m = viewport.transform;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  });
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const left = clamp(Math.min(...corners.map(([x]) => x)) / viewport.width);
  const right = clamp(Math.max(...corners.map(([x]) => x)) / viewport.width);
  const top = clamp(Math.min(...corners.map(([, y]) => y)) / viewport.height);
  const bottom = clamp(Math.max(...corners.map(([, y]) => y)) / viewport.height);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * A page's text as lines, with the position of every piece that made one.
 *
 * pdf.js hands back a line as a series of items with no separator of their own,
 * so they are concatenated verbatim — which is why real extracted text reads
 * "Algorithm 1Training step". Matching against anything else would be matching
 * against a string this document does not contain. Where a line ends is taken
 * from `hasEOL` and from where the next piece is drawn (`newLine`), since the
 * flag alone misses the line under a figure.
 */
async function readPage(entry: Entry, page: number): Promise<Run[] | null> {
  const cached = entry.runs.get(page);
  if (cached) return cached;
  if (entry.failed.has(page)) return null;
  try {
    const document = await entry.document;
    const loaded = await document.getPage(page);
    const viewport = loaded.getViewport({ scale: 1 });
    const content = await loaded.getTextContent();
    const runs: Run[] = [];
    const fresh = (): Run => ({ text: "", parts: [], head: null, continues: false, small: false });
    // How much of the page is set at each size, to tell its text from a
    // figure's labels.
    const inked = new Map<number, number>();
    let current = fresh();
    const close = () => {
      if (current.text.trim()) runs.push(current);
      current = fresh();
    };
    // The last piece that put ink on the line: spaces and empty markers carry
    // positions of their own that say nothing about where the line goes.
    let last: Pen | null = null;
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const visible = item.str.trim() !== "";
      const here = visible ? pen(item.transform, item.width) : null;
      if (here && last && current.head && newLine(last, here)) close();
      const rect = itemRect(viewport, item.transform, item.width);
      const at = current.text.length;
      current.text += item.str;
      current.parts.push({ at, to: current.text.length, rect });
      if (here) {
        current.head ??= here;
        last = here;
        const size = Math.round(here.size * 2) / 2;
        inked.set(size, (inked.get(size) ?? 0) + item.str.length);
      }
      if (item.hasEOL) close();
    }
    close();
    const text = [...inked].reduce((most, entry) => (entry[1] > most[1] ? entry : most), [0, 0])[0];
    runs.forEach((run, index) => {
      run.continues = index > 0 && wraps(runs[index - 1], run);
      run.small = Boolean(run.head && text && run.head.size < 0.85 * text);
    });
    entry.runs.set(page, runs);
    if (!runs.length) entry.barren.add(page);
    return runs;
  } catch {
    // A page that will not extract makes the whole verdict `unknown`; it must
    // never read as "this paper does not contain the locator".
    entry.failed.add(page);
    return null;
  }
}

/**
 * What a caller is willing to spend on an answer.
 *
 * Every await in here — opening a document, extracting a page — belongs to
 * something outside this process, and a click that waits on one of them without
 * a limit is a click that does nothing at all. When the budget runs out, or the
 * caller says it no longer cares, the verdict is `unknown`: it is the verdict
 * that changes nothing, which is exactly right for "we did not find out".
 */
export type ProbeLimit = {
  /** `Date.now()` past which this resolution is no longer worth having. */
  deadline?: number;
  /** True once a newer click has superseded this one. */
  cancelled?: () => boolean;
};

const OUT_OF_TIME = Symbol("out of time");

async function within<T>(work: Promise<T>, limit: ProbeLimit): Promise<T | typeof OUT_OF_TIME> {
  if (limit.deadline === undefined) return work;
  const left = limit.deadline - Date.now();
  if (left <= 0) return OUT_OF_TIME;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof OUT_OF_TIME>(resolve => {
        timer = setTimeout(() => resolve(OUT_OF_TIME), left);
      }),
    ]);
  } finally {
    // The work itself carries on in the background: a page this click no longer
    // has time for is still a page the next click would like already read.
    clearTimeout(timer);
  }
}

const spent = (limit: ProbeLimit) =>
  limit.cancelled?.() === true ||
  (limit.deadline !== undefined && Date.now() >= limit.deadline);

/** The union of the pieces a match spans, as a fraction of the page. */
function spanRect(run: Run, at: number, to: number): PdfRect | null {
  const touched = run.parts.filter(part => part.to > at && part.at < to);
  if (!touched.length) return null;
  const left = Math.min(...touched.map(p => p.rect.x));
  const top = Math.min(...touched.map(p => p.rect.y));
  const right = Math.max(...touched.map(p => p.rect.x + p.rect.w));
  const bottom = Math.max(...touched.map(p => p.rect.y + p.rect.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * The printed number a table-of-contents entry opens with: "3.2" of "3.2
 * Approach 2: IsoFLOP profiles", "D.2" of "D.2 Approach 3", "F" of "Appendix
 * F: FLOPs computation". The whole token, so "3.21" and "13.2" are never 3.2.
 */
function markNumber(title: string): { number: string; appendix: boolean } | null {
  const noun = /^\s*(appendix|section|\u00a7)\s*/i.exec(title);
  const rest = noun ? title.slice(noun[0].length) : title.trimStart();
  const token = /^([A-Z]?\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)(?=\.?(?:\s|:|$))/.exec(rest);
  return token ? { number: token[1], appendix: /^appendix$/i.test(noun?.[1] ?? "") } : null;
}

function readOutline(entry: Entry): Promise<Mark[]> {
  entry.outline ??= entry.document.then(async document => {
    const source = document as unknown as OutlineSource;
    const marks: Mark[] = [];
    const walk = (items: OutlineItem[] | null | undefined) => {
      for (const item of items ?? []) {
        marks.push({ title: item.title ?? "", dest: item.dest });
        walk(item.items);
      }
    };
    walk(typeof source.getOutline === "function" ? await source.getOutline() : null);
    return marks;
  }).catch(() => []);
  return entry.outline;
}

/**
 * How tall the band drawn at an outline destination is. A destination marks
 * the top of the space above a heading, about a line over its text, so the
 * band reaches down far enough to take the heading in.
 */
const MARK_HEIGHT = 0.05;

/**
 * Where a section's heading is, read from the document's own table of contents.
 *
 * A typeset paper's outline is the author's statement of where every section
 * starts — a page and the height of its heading — so for a section or an
 * appendix it is asked before any text is ranked, and what it says stands
 * whatever page the citation gave: a heading is exactly where the section is.
 *
 * Only an entry that *prints* the cited number counts. An outline without
 * numbers ("Introduction", "Background") is common and is no answer here,
 * and a lettered entry needs an outline that numbers its sections, or the word
 * "Appendix": in an unnumbered outline "A Phenomenological Model" opens with an
 * article, not appendix A. Anything missing, unmatched or unresolvable gives
 * null, and the text decides as it always did — the outline can find a
 * section, never rule one out.
 */
async function outlineHit(entry: Entry, locator: Locator): Promise<{ hit: LocatorHit; confirmed: boolean } | null> {
  if (locator.kind !== "section" && locator.kind !== "appendix") return null;
  try {
    const marks = await readOutline(entry);
    const read = marks.map(mark => ({ mark, printed: markNumber(mark.title) }));
    const numbered = read.some(({ printed }) => printed && /^\d/.test(printed.number));
    const found = read.find(({ printed }) => {
      if (!printed || printed.number !== locator.number) return false;
      if (/^[A-Z]/.test(printed.number) && !printed.appendix && !numbered) return false;
      // "Appendix 2" is not section 2.
      return locator.kind === "section" || printed.appendix || /^[A-Z]/.test(printed.number);
    });
    if (!found) return null;

    const document = (await entry.document) as unknown as OutlineSource;
    const dest = typeof found.mark.dest === "string"
      ? await document.getDestination?.(found.mark.dest)
      : found.mark.dest;
    if (!Array.isArray(dest) || !dest.length) return null;
    const [ref, fit, ...args] = dest as [unknown, { name?: string } | undefined, ...unknown[]];
    const index = typeof ref === "number" ? ref : await document.getPageIndex?.(ref);
    if (typeof index !== "number") return null;
    const page = index + 1;
    if (page < 1 || page > entry.pages) return null;

    // The destination's height, where its kind carries one; a page-level
    // destination stands for the top of the page.
    const name = fit?.name;
    const at = (value: unknown) => (typeof value === "number" ? value : null);
    const left = (name === "XYZ" || name === "FitR" ? at(args[0]) : null) ?? 0;
    const top = name === "XYZ" ? at(args[1]) : name === "FitH" || name === "FitBH" ? at(args[0]) : name === "FitR" ? at(args[3]) : null;
    let y = 0;
    if (top !== null) {
      const viewport = (await document.getPage(page)).getViewport({ scale: 1 });
      const m = viewport.transform;
      y = Math.min(1, Math.max(0, (m[1] * left + m[3] * top + m[5]) / viewport.height));
    }
    // A destination is where the author's anchor was set, which is not always
    // where the heading prints: Chinchilla's often sit at the foot of the page
    // before, so §3.1 marked the bottom of p. 4 for a heading on p. 5. The
    // heading itself is looked for below the destination, then on the next
    // two pages, and its own box is what the reader gets.
    const heading = async (on: number, from: number) => {
      for (const run of (await readPage(entry, on)) ?? []) {
        const match = matchLocator(run.text, locator, { continues: run.continues, small: run.small });
        const rect = match && match.rank >= CAPTION ? spanRect(run, match.index, match.index + match.length) : null;
        if (rect && rect.y >= from) return { page: on, rect, rank: CAPTION };
      }
      return null;
    };
    // An appendix may follow a part page or two: Chinchilla's Appendix D is
    // marked two pages before its heading.
    let printed = await heading(page, y - 0.02);
    for (let after = page + 1; !printed && after <= Math.min(entry.pages, page + 2); after++) printed = await heading(after, 0);
    if (printed) return { hit: printed, confirmed: true };
    return { hit: { page, rect: { x: 0, y, w: 1, h: Math.min(MARK_HEIGHT, 1 - y) }, rank: CAPTION }, confirmed: false };
  } catch {
    return null;
  }
}

async function best(entry: Entry, locator: Locator, pages: number[], limit: ProbeLimit) {
  let hit: LocatorHit | null = null;
  let stopped = false;
  // Every page in the range is read before a winner is chosen. Stopping at the
  // first hit would settle for a prose mention on the first page when the
  // caption is on the last — which is exactly the shape of "Table 2, pp. 5–6".
  for (const page of pages) {
    if (spent(limit)) { stopped = true; break; }
    const runs = await within(readPage(entry, page), limit);
    if (runs === OUT_OF_TIME) { stopped = true; break; }
    if (!runs) continue;
    for (const run of runs) {
      const match = matchLocator(run.text, locator, { continues: run.continues, small: run.small });
      if (!match) continue;
      const rect = spanRect(run, match.index, match.index + match.length);
      if (!rect) continue;
      // Rank first, then the earlier page: a table that starts on the first
      // cited page and continues onto the second belongs to the first.
      if (!hit || match.rank > hit.rank) hit = { page, rect, rank: match.rank };
    }
  }
  return { hit, stopped };
}

/**
 * Find a locator, preferring the pages the citation named.
 *
 * The named pages are read first and answered from, so a cross-document click
 * costs as many text extractions as the citation had pages rather than a whole
 * document — a resolution that waited for a full scan would time out and fall
 * back to the naive routing this module exists to replace. The rest of the
 * document is swept afterwards, so the next click on the same paper is warm.
 */
export async function probe(
  target: IndexTarget,
  locator: Locator,
  pages: number[],
  limit: ProbeLimit = {},
): Promise<Verdict> {
  const entry = open(target);
  let opened;
  try { opened = await within(entry.document, limit); } catch { return { state: "unknown" }; }
  // A document that is still loading when the budget runs out has told us
  // nothing about itself, and neither has one belonging to a click that has
  // been superseded.
  if (opened === OUT_OF_TIME || !entry.live) return { state: "unknown" };

  const all = Array.from({ length: entry.pages }, (_, index) => index + 1);
  const cited = pages.filter(page => page >= 1 && page <= entry.pages);

  // A section in the document's own table of contents is where its heading
  // prints, found from there (`outlineHit`). A destination the text does not
  // confirm stands only where the citation gave no other page; off the cited
  // pages the text decides first, and the outline is the fallback that keeps
  // a section the document lists from ever being called absent.
  const listed = await within(outlineHit(entry, locator), limit);
  const outline = listed && listed !== OUT_OF_TIME && entry.live ? listed : null;
  if (outline && (outline.confirmed || !cited.length || cited.includes(outline.hit.page))) {
    return { state: "found", hit: outline.hit };
  }
  const verdict = await fromText(entry, locator, all, cited, limit);
  return verdict.state !== "found" && outline ? { state: "found", hit: outline.hit } : verdict;
}

/** Where the extracted text puts a locator, the cited pages first (`probe`). */
async function fromText(entry: Entry, locator: Locator, all: number[], cited: number[], limit: ProbeLimit): Promise<Verdict> {
  // Widen in stages: the pages named, then their immediate neighbours, then the
  // whole document. A caption sits one page off its citation often enough to be
  // worth a cheap second look, and only a citation that is wrong about its
  // document pays for a full scan — which is the price of being allowed to say
  // "not here" and send the reader somewhere better.
  const near = cited.flatMap(page => [page - 2, page - 1, page + 1, page + 2])
    .filter(page => page >= 1 && page <= entry.pages && !cited.includes(page));
  const rest = all.filter(page => !cited.includes(page) && !near.includes(page));

  // Warming the rest of the document is for the *next* click. A click that has
  // been superseded, or that ran out of time, does not get to spend the
  // extraction that click is waiting on.
  const answer = (hit: LocatorHit, warm: number[]): Verdict => {
    if (!spent(limit)) void sweep(entry, warm, limit);
    return { state: "found", hit };
  };

  // A weaker-than-caption match is held rather than answered with. Papers write
  // "as shown in Table 4" a page before Table 4 itself, and a citation naming a
  // table is asking for the table: one cheap look at the pages next door is
  // worth it, and only a caption there may displace what the cited pages said.
  //
  // Away from the cited pages *only* a caption may: a page the citation named
  // and the index could not place the locator on is still the better place to
  // stand than a passing mention somewhere else. A footnote "as described in
  // Appendix F" on page 4 used to win over "Appendix F, pp. 27–28" because the
  // appendix's own heading went unread.
  let held: LocatorHit | null = null;
  let mentioned = false;
  const windows = [cited, [...new Set(near)].sort((a, b) => a - b), rest];
  for (const [index, window] of windows.entries()) {
    // A mention on a cited page has had its look next door; the far end of the
    // document is not worth a full scan to second-guess it.
    if (index === 2 && held) break;
    if (!window.length) continue;
    const found = await best(entry, locator, window, limit);
    if (found.hit) mentioned = true;
    // With no page named there is nothing to displace, and the best match
    // anywhere is the answer.
    if (found.hit && (found.hit.rank >= CAPTION || !cited.length)) {
      return answer(found.hit, index < 2 ? rest : []);
    }
    if (index === 0) held = found.hit;
    // Out of time or no longer wanted: what has not been read cannot be spoken
    // for, however much of the document happens to be cached already.
    if (found.stopped) return held ? answer(held, []) : { state: "unknown" };
  }
  // A citation that names every page of a short document leaves no later window
  // to answer in, so a held match has to be answered with here — falling through
  // would turn a locator we actually found into a claim that the document does
  // not contain it, and send the reader to a different paper.
  if (held) return answer(held, rest);
  // Named somewhere, but nowhere a reader should be put down in place of the
  // page the citation gave: `unknown` keeps the paper and lands on that page.
  // It is never `absent`, which would send the citation to another document.
  if (mentioned) return { state: "unknown" };
  const complete = all.every(page => entry.runs.has(page));
  return {
    state: complete && !entry.failed.size && !entry.barren.size ? "absent" : "unknown",
  };
}

/**
 * Warm the remaining pages without holding anybody's click open.
 *
 * It stops for a dead document and for a click nobody is waiting on any more:
 * extraction is single-threaded, so a sweep that keeps going after its own
 * click was superseded is competing with the click that replaced it.
 */
async function sweep(entry: Entry, pages: number[], limit: ProbeLimit) {
  for (const page of pages) {
    if (!entry.live || limit.cancelled?.() === true) return;
    await readPage(entry, page);
  }
}

/** Tests only: forget every cached document. */
export function resetLocatorIndex() {
  for (const key of [...entries.keys()]) evict(key);
  borrowed.clear();
}
