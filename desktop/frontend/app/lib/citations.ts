import { isWebPaper, isWebPdf, type Paper } from "./api.ts";
import { LOCATOR_AT, LOCATOR_IN_PROSE, NOT_A_NAME, parseLocator, type Locator } from "./locators.ts";
import { markdownCodeRanges } from "./markdown-pipeline.ts";


/**
 * The model cites its evidence as parentheticals that name a paper, a locator
 * and a page — "(LingBot-VA 2.0, Table 1, p. 19; Table 3, p. 21.)" — and just
 * as often in its own sentences: "Then inspect **Table 6, p. 11**", "Fig. 3
 * (p. 4) shows the consequence", "§4.2 gives accuracy". This turns both into
 * jump targets so a citation can be followed into the PDF.
 *
 * A web page has no pages, so it is cited by the anchor of the section the
 * evidence came from — "(Why We Think, §thinking-in-tokens)". Those anchors are
 * the ids the live page already carries, which is what lets the reader panel
 * scroll to one.
 *
 * How a locator is spelled is not this module's business; `locators.ts` owns
 * that, and owns it alone. This one finds parentheticals, splits them, and
 * decides who said what.
 */

export type CitationTarget = {
  /** The segment exactly as written, used as the link's own label. */
  text: string;
  /** Paper the parenthetical names outright, or null when it only locates. */
  paperName: string | null;
  /**
   * The paper the surrounding prose was talking about, when the citation
   * itself named none. Kept apart from `paperName` because the two carry very
   * different authority: one is what the model said, the other is what we
   * guessed from the block around it.
   */
  inferredName: string | null;
  /**
   * Every page cited, in order. A range is kept whole: "pp. 5-6" used to become
   * page 5 alone, and a table cited that way has its caption on 6 as often as
   * on 5.
   */
  pages: number[];
  /** Set for web pages. */
  anchor: string | null;
  /** What to look for once there. One per segment, never a list. */
  locator: Locator | null;
  /**
   * The name came from a possessive in a sentence — "Kaplan's Table 2" — which
   * says outright whose the place is: one the library does not hold has
   * nowhere to go, rather than the open paper's Table 2.
   */
  possessive?: true;
};

export type CitationPiece =
  | { kind: "text"; text: string }
  | { kind: "citation"; target: CitationTarget };

const PAGE_REF = /\b(?:pp?\.|pgs?\.|pages?\s)\s*([\d\s,\u2013\u2014-]*\d)/i;
/**
 * Web anchors are slugs. A section *number* after the same sign — "§3.2" — is
 * not one: the old class stopped at the dot, silently turning it into the
 * anchor "3", which the PDF branch could not use and answered with page 1.
 * Numbers are a locator, and a slug is an anchor — including one that starts
 * with a digit, as "3-results" does when a heading reads "3. Results". What
 * makes it a slug is a letter somewhere in it; "3" and "3.2" have none.
 */
/**
 * A heading's id, in any script: "thinking-in-tokens", "3-results", "迭代求解".
 * A letter somewhere in it is what makes it one; "3" and "3.2" are sections.
 */
const SLUG = String.raw`(?=[\p{L}\p{N}_-]*\p{L})[\p{L}\p{N}][\p{L}\p{N}_-]*`;
// The whole slug, and not a lettered section: "§B.1" is appendix B's section 1.
// No space after the sign: "§thinking-in-tokens" is an anchor, "the § sign" is prose.
const ANCHOR_REF = new RegExp(String.raw`§§?(${SLUG})(?![\p{L}\p{N}_-])(?!\.\d)`, "u");

const ANCHORS = new RegExp(ANCHOR_REF.source, "gu");

/**
 * A slug that carries on a doubled sign's list — "§§block-25, block-29 and
 * block-35", "§§迭代求解, 范数视角", one sign for the lot as "pp." is for pages.
 * Only a slug with a hyphen, a digit or a letter beyond English continues one,
 * so a list never runs on into the next word of an English sentence.
 */
const LISTED = new RegExp(String.raw`^(\s*(?:,|&|\band\b)\s*(?:and\s+)?)((?=[\p{L}\p{N}_-]*(?:[-\d]|[^\x00-\x7F]))${SLUG})`, "u");

/** Every web anchor a stretch of text names, where it is written, and its slug. */
function anchorsIn(text: string): Array<{ start: number; end: number; anchor: string }> {
  const found: Array<{ start: number; end: number; anchor: string }> = [];
  for (const match of text.matchAll(ANCHORS)) {
    let end = match.index + match[0].length;
    found.push({ start: match.index, end, anchor: match[1] });
    if (!match[0].startsWith("§§")) continue;
    for (let next = LISTED.exec(text.slice(end)); next; next = LISTED.exec(text.slice(end))) {
      const start = end + next[1].length;
      end = start + next[2].length;
      found.push({ start, end, anchor: next[2] });
    }
  }
  return found;
}

/**
 * One segment per anchor. A page cited in several places is written as a list —
 * `("Notes on the Industry Job Search", §block-6, §block-14, §block-46)` — and
 * read as one segment that became one link to the first anchor alone, with the
 * others printed inside it. Each anchor is its own segment; the separator
 * before it (`, `, ` and `) stays plain text, and the name stays with the first.
 */
function byAnchor(part: string): Array<{ gap: string; text: string; anchor?: string }> {
  const anchors = anchorsIn(part);
  const pieces: Array<{ gap: string; text: string; anchor?: string }> = [];
  // The space after a `;` is the sentence's, not the next link's.
  let gap = /^\s*/.exec(part)![0], from = gap.length, anchor: string | undefined = anchors[0]?.anchor;
  for (const { start: at, anchor: next } of anchors.slice(1)) {
    const head = part.slice(from, at);
    const separator = /[\s,&]*(?:\band\s+)?$/.exec(head)?.[0] ?? "";
    pieces.push({ gap, text: head.slice(0, head.length - separator.length), anchor });
    gap = separator;
    from = at;
    anchor = next;
  }
  pieces.push({ gap, text: part.slice(from), anchor });
  return pieces;
}

/**
 * A citation is any segment that points somewhere — page, anchor or locator.
 * `listed` is the anchor a segment holds without its own sign, in a `§§` list.
 */
function locate(segment: string, listed?: string) {
  const pages = derivePages(segment);
  const anchor = listed ?? ANCHOR_REF.exec(segment)?.[1] ?? null;
  // "§3-results" is one anchor, not also "Section 3": the section locator would
  // send a PDF search after a heading number the model never cited.
  const parsed = parseLocator(segment);
  const locator = anchor && parsed?.kind === "section" ? null : parsed;
  return pages.length || anchor || locator ? { pages, anchor, locator } : null;
}

/**
 * Balanced `(...)` spans in a run of prose.
 *
 * A flat `[^()]` class misses every citation whose paper title itself carries
 * parentheses — "(Habits vs. Goals (FS Blog), §the-benefits-of-habits)" is a
 * real model output, and the inner "(FS Blog)" used to eat the match so the
 * outer never became a link. Walk with a depth counter instead; skip spans
 * already covered by an earlier (outer) hit in `segmentCitations`.
 */
function findParentheticals(
  input: string,
): Array<{ index: number; inner: string; length: number }> {
  const found: Array<{ index: number; inner: string; length: number }> = [];
  for (let start = 0; start < input.length; start++) {
    if (input[start] !== "(") continue;
    let depth = 0;
    for (let end = start; end < input.length; end++) {
      // Same 3..240 bound the old regex enforced on the inner text.
      if (end - start > 242) break;
      const ch = input[end];
      if (ch === "(") {
        depth += 1;
        continue;
      }
      if (ch !== ")") continue;
      depth -= 1;
      if (depth !== 0) continue;
      const inner = input.slice(start + 1, end);
      if (inner.length >= 3 && inner.length <= 240) {
        found.push({ index: start, inner, length: end - start + 1 });
      }
      break;
    }
  }
  return found;
}

/** A page cap, so a malformed "pp. 1-9999" cannot ask for nine thousand scans. */
const PAGE_SPAN = 40;

/**
 * A page number has to be a real page before it is anything else.
 *
 * Past 2^53 a float cannot count: `page++` returns the value it started from,
 * so a range written "pp. 9007199254740992-9007199254740992" spun the renderer
 * forever. A ceiling is the honest guard — no document has a page number this
 * parser should believe — and it also keeps a typo from proposing a scan of
 * more pages than any paper has.
 */
const PAGE_CEILING = 10000;
const realPage = (page: number) => Number.isSafeInteger(page) && page > 0 && page <= PAGE_CEILING;

/**
 * Every page a segment names: "p. 7" -> [7], "pp. 5-6" -> [5, 6],
 * "pp. 1-2, 7-13" -> [1, 2, 7, 8, ... 13]. En dash, em dash and hyphen all
 * appear in real answers.
 */
function derivePages(segment: string): number[] {
  const written = PAGE_REF.exec(segment)?.[1];
  if (!written) return [];
  const pages = new Set<number>();
  for (const part of written.split(",")) {
    const span = /^\s*(\d+)\s*[\u2013\u2014-]\s*(\d+)\s*$/.exec(part);
    if (span) {
      const from = Number(span[1]), to = Number(span[2]);
      if (!realPage(from)) continue;
      if (realPage(to) && to >= from && to - from < PAGE_SPAN) for (let page = from; page <= to; page++) pages.add(page);
      else pages.add(from);
      continue;
    }
    const single = Number(part.trim());
    if (realPage(single)) pages.add(single);
  }
  return [...pages].sort((a, b) => a - b);
}

function derivePaperName(segment: string): string | null {
  const starts = [PAGE_REF, ANCHOR_REF, LOCATOR_AT]
    .map(pattern => pattern.exec(segment)?.index)
    .filter((index): index is number => typeof index === "number");
  if (!starts.length) return null;
  const lead = segment
    .slice(0, Math.min(...starts))
    .trim()
    .replace(/,\s*$/, "")
    .trim();
  return lead && !NOT_A_NAME.test(lead) ? lead : null;
}

/**
 * Pages as a sentence writes them — "p. 11", "pp. 5–9, 11", "pg. 5", "page 5" — alone
 * or in a parenthesis of their own right after a locator: "Fig. 3 (p. 4)".
 */
const PAGES = String.raw`(?:pp?\.\s*|pgs?\.\s*|[Pp]ages?\s+)\d+(?:\s*[–—-]\s*\d+)?(?:\s*,\s*\d+(?:\s*[–—-]\s*\d+)?)*`;
const PAGES_IN_PROSE = new RegExp(String.raw`\(\s*${PAGES}\.?\s*\)|(?<![\w.])${PAGES}(?![\w])`, "g");
const PAGES_ONLY = new RegExp(String.raw`^\s*${PAGES}\.?\s*$`);

/**
 * What may stand between a locator and the page it is on: nothing, a comma, or
 * one word — "Figure 3 caption, p. 6". Anything longer is a clause, and the
 * page belongs to something else.
 */
const BINDS = /^(?:\s*,?\s*|\s+[a-z]+,?\s+)$/;

type Atom = { start: number; end: number; pages: boolean; anchor?: string };

/** Every locator, web anchor and page a stretch of prose names, in order, none overlapping. */
function proseAtoms(text: string): Atom[] {
  // An anchor first: "§3-results" is one, and must not be read as Section 3.
  const atoms: Atom[] = anchorsIn(text).map(({ start, end, anchor }) => ({ start, end, pages: false, anchor }));
  const free = (start: number, end: number) => atoms.every(atom => end <= atom.start || start >= atom.end);
  for (const pattern of [LOCATOR_IN_PROSE, PAGES_IN_PROSE]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index, end = start + match[0].length;
      if (free(start, end)) atoms.push({ start, end, pages: pattern === PAGES_IN_PROSE });
    }
  }
  return atoms.sort((a, b) => a.start - b.start);
}

/** True when a stretch of prose ends on a locator, so a parenthesised page after it is that locator's. */
function endsOnLocator(text: string): boolean {
  const trimmed = text.replace(/\s+$/, "");
  const last = proseAtoms(trimmed).at(-1);
  return Boolean(last && !last.pages && last.end === trimmed.length);
}

/**
 * The citations a sentence makes outside any parenthetical. Each locator opens
 * one, and the page right after it is its page: "Table 1, p. 2; Table 2, p. 3"
 * is two links, "§§3.2–3.4, pp. 5–8" one, "Figure 1 / §2.1" two. A page with
 * no locator before it is a citation of its own.
 *
 * Nothing here names a paper: which document a sentence means is the block's
 * question (`blockPaper`), as it is for a parenthetical that names none.
 */
function proseCitations(
  text: string,
  inferredName: string | null,
  /** The block cites only the web, so its prose locators are the web source's. */
  outside: boolean,
): CitationPiece[] {
  const groups: Array<{ start: number; end: number; paged: boolean; anchor?: string }> = [];
  for (const atom of proseAtoms(text)) {
    const open = groups.at(-1);
    if (atom.pages && open && !open.paged && BINDS.test(text.slice(open.end, atom.start))) {
      open.end = atom.end;
      open.paged = true;
    } else groups.push({ start: atom.start, end: atom.end, paged: atom.pages, anchor: atom.anchor });
  }
  const pieces: CitationPiece[] = [];
  let cursor = 0;
  for (const group of outside ? [] : groups) {
    const written = text.slice(group.start, group.end);
    const found = locate(written, group.anchor);
    if (!found) continue;
    if (group.start > cursor) pieces.push({ kind: "text", text: text.slice(cursor, group.start) });
    const paperName = POSSESSOR.exec(text.slice(0, group.start))?.[1] ?? null;
    pieces.push({ kind: "citation", target: { text: written, paperName, inferredName, ...found, ...(paperName ? { possessive: true as const } : {}) } });
    cursor = group.end;
  }
  if (cursor < text.length) pieces.push({ kind: "text", text: text.slice(cursor) });
  return pieces;
}

/**
 * Splits a run of text into plain stretches and citation targets. Segment text
 * is preserved verbatim so the rendered sentence still reads as the model
 * wrote it.
 */
export function segmentCitations(
  input: string,
  /** The paper the enclosing block was about, when it named exactly one. */
  inferredName: string | null = null,
  /** What else is known of the enclosing block (`blockContext`). */
  block: { outside?: boolean } = {},
): CitationPiece[] {
  const pieces: CitationPiece[] = [];
  let cursor = 0;
  const prose = (to: number) => {
    if (to > cursor) pieces.push(...proseCitations(input.slice(cursor, to), inferredName, Boolean(block.outside)));
  };

  for (const match of findParentheticals(input)) {
    // Nested hit already covered by an outer citation we emitted.
    if (match.index < cursor) continue;
    // "Fig. 3 (p. 4)": the page is the figure's, and the two are one link.
    if (PAGES_ONLY.test(match.inner) && endsOnLocator(input.slice(cursor, match.index))) continue;
    // Split first, then keep the parenthetical if any part pointed somewhere.
    // The old gate asked a *separate* question from the one the parser went on
    // to ask, and the two disagreed: a parenthetical naming only a table
    // answered "no" here and never reached the parser at all.
    const parts = match.inner
      .split(";")
      .map(part => byAnchor(part).map(piece => ({ ...piece, found: locate(piece.text, piece.anchor) })));
    if (!parts.flat().some(piece => piece.found)) continue;

    prose(match.index);

    let paperName: string | null = null;
    pieces.push({ kind: "text", text: "(" });
    parts.forEach((segments, index) => {
      if (index > 0) pieces.push({ kind: "text", text: ";" });
      for (const part of segments) {
        if (part.gap) pieces.push({ kind: "text", text: part.gap });
        // A compound citation may switch documents halfway through:
        // `(MoE paper, p. 4; Scaling Laws, Carefully, §chinchilla)`. The old
        // parser assigned the first name to every segment, so the web anchor was
        // opened on the PDF. A locator-only continuation still inherits the
        // preceding name, as in `(Paper, p. 4; Table 2, p. 7)`.
        paperName = derivePaperName(part.text) ?? paperName;
        if (!part.found) {
          pieces.push({ kind: "text", text: part.text });
          continue;
        }
        pieces.push({
          kind: "citation",
          target: { text: part.text, paperName, inferredName, ...part.found },
        });
      }
    });
    pieces.push({ kind: "text", text: ")" });

    cursor = match.index + match.length;
  }

  prose(input.length);
  return pieces;
}

/** A web address as the library keeps it: host and path, with no scheme, "www.", query, fragment or trailing slash. */
function address(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A link to a web page the library holds, as a citation of the library's copy:
 * "[§Definition](https://kellerjordan.github.io/posts/muon/#definition)" opens
 * the stored page at its Definition section, in the reader, as a `§definition`
 * citation of it would. A model that read the public original links there,
 * and the reader would otherwise leave the app for a page already in it.
 */
export function libraryLink(
  href: string | undefined,
  text: string,
  papers: ReadonlyArray<{ title: string; url?: string; sourceUrl?: string }>,
): CitationTarget | null {
  const at = address(href);
  if (!href || !at) return null;
  const paper = papers.find((item) => address(item.url ?? item.sourceUrl) === at);
  if (!paper) return null;
  const fragment = new URL(href).hash.slice(1);
  let anchor: string | null = null;
  // A text fragment ("#:~:text=…") points at words, not at a section.
  if (fragment && !fragment.startsWith(":~:")) {
    try { anchor = decodeURIComponent(fragment); } catch { anchor = fragment; }
  }
  return { text, paperName: paper.title, inferredName: null, pages: [], anchor, locator: null };
}

/**
 * The one citation a code span holds, when the span is that citation and at
 * most a few words about it. The system prompt quotes the labels a model
 * should write in code spans — `` `Table 3, p. 7` ``, `` `Eq. (6)` ``,
 * `` `§3.1 last paragraph` `` — so a model may write them the same way. A
 * span with anything else in it, a digit or a symbol, is code and stays code.
 */
export function wholeCitation(
  text: string,
  inferredName: string | null = null,
  block: { outside?: boolean } = {},
): CitationTarget | null {
  const written = text.trim();
  // `table 1` and `page 2` in code are a program's names; a cited place is
  // written as the paper prints it, capitalised, or as a page.
  if (/^\p{Ll}/u.test(written) && !/^(?:pp?|pgs?)\.\s*\d/.test(written)) return null;
  const pieces = segmentCitations(written, inferredName, block);
  const at = pieces.findIndex((piece) => piece.kind === "citation");
  const cited = pieces[at];
  if (!cited || cited.kind !== "citation" || pieces.filter((piece) => piece.kind === "citation").length !== 1) return null;
  const before = pieces.slice(0, at).map((piece) => (piece.kind === "text" ? piece.text : "")).join("");
  const after = pieces.slice(at + 1).map((piece) => (piece.kind === "text" ? piece.text : "")).join("");
  if (!/^[\s(]*$/.test(before) || !/^[\s\p{L}'’.,;:)-]*$/u.test(after)) return null;
  return { ...cited.target, text: written };
}

// Letters of any script: a title in Chinese is named by its Chinese.
const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const GENERIC_SOURCE_WORDS = new Set([
  "article",
  "blog",
  "blogpost",
  "document",
  "paper",
  "post",
  "source",
  "study",
]);

export type PaperMatch = { paper: Paper; score: number };

/**
 * Papers are cited by the name they give themselves ("VERA", "LingBot-VA 2.0"),
 * which rarely equals the filename we stored them under. Score the candidates
 * and keep everything that plausibly matches, best first.
 */
export function rankCitedPapers(
  paperName: string | null,
  papers: Paper[],
): PaperMatch[] {
  if (!paperName) return [];
  // "Notably Chinchilla", "see Chinchilla": a sentence's words before a name
  // are not part of it. A name that matches nothing is tried again without
  // its first word, and again, while what is left still reads as a name: it
  // opens with a capital and has a word of three letters. Shortened past that,
  // "Hoffmann et al." became "al.", which every "Scaling…" title contains.
  const words = paperName.trim().split(/\s+/);
  for (let from = 0; from < words.length; from++) {
    const rest = words.slice(from);
    if (from > 0 && !(/^\p{Lu}/u.test(rest[0]) && rest.some((word) => /\p{L}{3}/u.test(word)))) continue;
    const ranked = rankName(rest.join(" "), papers);
    if (ranked.length) return ranked;
  }
  return [];
}

function rankName(paperName: string, papers: Paper[]): PaperMatch[] {
  const needle = normalize(paperName);
  if (!needle) return [];

  const scoreFor = (title: string): number => {
    if (!title) return 0;
    if (title === needle) return 100;
    if (title.startsWith(needle) || needle.startsWith(title)) return 80;
    if (title.includes(needle) || needle.includes(title)) return 60;
    const words = (paperName.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter(
      (word) => !GENERIC_SOURCE_WORDS.has(word),
    );
    if (!words.length) return 0;
    const hits = words.filter((word) => title.includes(word)).length;
    // A short model-written alias such as "MoE paper" is useful when its
    // meaningful words all identify one library title. Generic nouns do
    // not dilute it, and a partial multiword match still needs the same
    // 45-point threshold as before.
    return hits === words.length ? 55 : 45 * (hits / words.length);
  };

  const matches: PaperMatch[] = [];
  for (const paper of papers) {
    // A document is also known by the file it came from: until its digest
    // read the printed title it was called "ntk", and answers written then
    // still cite it by that name. Only an exact or near-exact file name
    // counts, so a short stem cannot claim a citation by sharing a word.
    const stem = normalize((paper.filename ?? "").replace(/\.[a-z0-9]{2,5}$/i, ""));
    const byFile = !stem || stem === normalize(paper.title)
      ? 0
      : stem === needle
        ? 100
        : stem.length >= 6 && scoreFor(stem) >= 80
          ? scoreFor(stem)
          : 0;
    const score = Math.max(scoreFor(normalize(paper.title)), byFile);
    if (score >= 45) matches.push({ paper, score });
  }
  // Stable, so the first paper still wins a tie exactly as it used to.
  return matches.sort((a, b) => b.score - a.score);
}

/**
 * A linked PDF is served from a different route but is a PDF in every way that
 * matters here — `PdfViewer` renders it, and a citation into one deserves the
 * same caption box as any other. Only a live HTML page has no pages.
 */
const paged = (paper: Paper) => !isWebPaper(paper) || isWebPdf(paper);

/**
 * Where a citation may be sent, best reason first: a paper its name matches,
 * the paper its block is about, the one on screen, then the others the answer
 * names. `routeCitation` asks the locator index about these and nothing else.
 *
 * A page or a locator rules out a document that has no pages: a live web page
 * on screen cannot be where "pp. 1–2" points, however first it stands. When
 * that leaves nothing, the library holds exactly one paged document and the
 * citation names no other, it can only mean that one.
 *
 * Empty means a citation has nowhere to go: "(Kaplan et al., p. 5)" in a
 * Memory chat with no Kaplan in the library, or the pages of a PDF the model
 * read on the web, cited beside a web page. A link that does nothing when
 * clicked is worse than prose, so the renderer draws it as prose.
 */
export function citationCandidates(
  target: CitationTarget,
  papers: Paper[],
  current: Paper | null,
  mentioned: Paper[],
): Paper[] {
  const candidates: Paper[] = [];
  const add = (paper: Paper | null | undefined) => {
    if (paper && !candidates.some((seen) => seen.id === paper.id)) candidates.push(paper);
  };
  const ranked = rankCitedPapers(target.paperName, papers);
  if (target.possessive && !ranked.length) return [];
  for (const match of ranked) add(match.paper);
  add(papers.find((paper) => paper.title === target.inferredName));
  add(current);
  // The other papers an answer names say nothing about a name that matches
  // none of them: "(Kaplan et al., p. 5)" beside them is Kaplan's page 5. The
  // open document stays, because a paper is cited by its authors as often as
  // by its title.
  if (!target.paperName || ranked.length) for (const paper of mentioned) add(paper);
  if (target.anchor || (!target.pages.length && !target.locator)) return candidates;
  const withPages = candidates.filter(paged);
  // A citation that names a paper the library lacks means that paper still.
  const only = target.paperName ? [] : papers.filter(paged);
  return withPages.length || only.length !== 1 ? withPages : only;
}

/**
 * The paper a name identifies beyond doubt — and nothing weaker.
 *
 * The scores are match *classes*, not confidence percentages: 80 means the
 * title and the name share a prefix, which "Alpha" does with both "Alpha
 * Methods" and "Alpha Results". Two papers tied at the top identify neither, so
 * a tie is not an identification and the citation falls through to the ordinary
 * candidate rules instead of picking whichever happened to be first.
 */
export function identifiedPaper(
  paperName: string | null,
  papers: Paper[],
): Paper | null {
  const ranked = rankCitedPapers(paperName, papers);
  const best = ranked[0];
  if (!best || best.score < 80) return null;
  return ranked[1]?.score === best.score ? null : best.paper;
}


/**
 * Names a paper can be called by in prose, when they belong to it alone.
 *
 * Two thirds of the citations in a real conversation name no paper at all — the
 * model writes "(Table 4, p. 14)" because the sentence it sits in already said
 * which paper. Falling back to whatever document is open answers those by
 * opening the wrong one, so the sentence is read instead.
 *
 * Only coined names count: a token carrying an internal capital or a digit
 * ("JiT", "PiD", "SelfFlow", "Tuna2"), plus the title with its arXiv id
 * trimmed. Ordinary words are deliberately excluded — "Back" and "Basics" are
 * in a real title here, and a paragraph that happens to use one of them is not
 * a paragraph about that paper. An alias two papers share is dropped, because
 * it identifies neither.
 */
export type PaperAlias = { title: string; pattern: RegExp };

const escapeAlias = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function paperAliases(papers: ReadonlyArray<{ title: string }>): PaperAlias[] {
  const owners = new Map<string, Set<string>>();
  const claim = (alias: string, title: string) => {
    if (alias.length < 3 || GENERIC_SOURCE_WORDS.has(alias.toLowerCase())) return;
    (owners.get(alias) ?? owners.set(alias, new Set()).get(alias)!).add(title);
  };
  const coined = (token: string) => /[A-Z]/.test(token.slice(1)) || /\d/.test(token);
  for (const paper of papers) {
    const plain = paper.title.replace(/\s*\((?:ar[Xx]iv[: ])?\d{4}\.\d{4,5}(?:v\d+)?\)\s*$/, "").trim();
    if (plain) claim(plain, paper.title);
    // "Kimi K3: Open Agentic Intelligence" is called "Kimi K3", whose coined
    // token alone is too short to claim. The name before a title's colon or
    // dash counts when a coined token makes it a name, as it does there; "Scaling
    // Laws: …" stays a phrase anyone may write.
    const head = plain.split(/\s*(?::|\uff1a|\s[-\u2013\u2014]\s)\s*/)[0];
    // One word before the colon names the paper too — "Chimera: Designing
    // and…" — when no other title in the library has that word at all;
    // "Muon:" heads one of three titles that each say Muon.
    // Anywhere in it: Chinese sets "Muon优化器" with no space to bound a word.
    const word = /^\p{Lu}\p{Ll}{3,}$/u.test(head) && !papers.some((other) =>
      other !== paper && other.title.toLowerCase().includes(head.toLowerCase()));
    if (head !== plain && ((head.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []).some(coined) || word)) claim(head, paper.title);
    for (const token of paper.title.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [])
      if (coined(token)) claim(token, paper.title);
  }
  return [...owners]
    .filter(([, titles]) => titles.size === 1)
    .map(([alias, titles]) => ({
      title: [...titles][0],
      // Case-sensitive: the whole point of a coined name is its shape. A name
      // made into an adjective — "Chinchilla-optimal", "JiT-style" — is the
      // idea the paper named, not the paper; "JiT-B/16" is still its model.
      pattern: new RegExp(`(?<![A-Za-z0-9])${escapeAlias(alias)}(?![A-Za-z0-9])(?!-\\p{Ll})`, "u"),
    }));
}

/**
 * The papers an answer names anywhere, which are all a citation may be sent to
 * beyond the one on screen. Running on through the library would let a nameless
 * citation land in an unrelated document that happens to have a table of the
 * same number, which nothing in the answer ever pointed at.
 */
export function mentionedPapers<T extends { title: string }>(answer: string, papers: T[]): T[] {
  const named = namedIn(answer, paperAliases(papers));
  return papers.filter((paper) => named.has(paper.title));
}

/** Every paper a stretch of prose names. */
function namedIn(text: string, aliases: PaperAlias[]): Set<string> {
  return new Set(namesIn(text, aliases).map((match) => match.title));
}

/** Where each paper is named in a stretch of prose, a name inside a longer one dropped. */
function namesIn(text: string, aliases: PaperAlias[]): Array<{ start: number; end: number; title: string }> {
  const found: Array<{ start: number; end: number; title: string }> = [];
  for (const alias of aliases) {
    for (const match of text.matchAll(new RegExp(alias.pattern.source, `${alias.pattern.flags}g`))) {
      found.push({ start: match.index, end: match.index + match[0].length, title: alias.title });
    }
  }
  // A name inside a longer one is part of it: "Chimera: Designing and
  // Chinchilla-Scaling Hybrid…" names Chimera, and not Chinchilla too.
  const within = (inner: (typeof found)[number]) => found.some((outer) =>
    outer.title !== inner.title && outer.start <= inner.start && outer.end >= inner.end && outer.end - outer.start > inner.end - inner.start);
  return found.filter((match) => !within(match));
}

/**
 * A paper named for one locator of its own — "Chinchilla's Table 2" — and its
 * locator. The citation takes that name; the rest of the block is still about
 * whatever it was about ("Unlike Chinchilla's Table 2, this paper's Table 1…").
 */
const POSSESSOR = /((?:\p{Lu}[\p{L}\d.-]*\s+){0,3}\p{Lu}[\p{L}\d.-]*)['’]s\s+$/u;
const POSSESSED = new RegExp(String.raw`(?:\p{Lu}[\p{L}\d.-]*\s+){0,3}\p{Lu}[\p{L}\d.-]*['’]s\s+(?=${LOCATOR_IN_PROSE.source})`, "gu");

/** The one paper a stretch of prose is about, or null when it is not clear. */
export function soleMentionedPaper(text: string, aliases: PaperAlias[]): string | null {
  const named = namedIn(text, aliases);
  return named.size === 1 ? [...named][0] : null;
}

/** An ATX heading, or a paragraph that is bold and nothing else: the title of what follows. */
const TITLE = /^ {0,3}(?:(#{1,6})[ \t]+(.*?)[ \t#]*|\*\*([^*\n]+)\*\*:?[ \t]*)$/gm;

/** A title's numbering, emphasis and article, before what it is about: "2. ", "### 1. *", "The ". */
const TITLE_LEAD = /^\s*(?:(?:\d+(?:\.\d+)*|[A-Za-z]|[ivxlc]+)[.)]\s+)?[*_]*\s*(?:the\s+)?/i;

type Title = { index: number; depth: number; paper: string | null };

/**
 * The paper a title is about: the one it opens with. "## 2. Scaling Laws for
 * Native Multimodal Models: …" is that paper's section; "### How it differs
 * from Chinchilla" is a section about the paper on screen that names its
 * comparison, and gives its tables to no other paper; "## Chimera vs.
 * Chinchilla" is a comparison, about neither.
 */
function titlePaper(text: string, aliases: PaperAlias[]): string | null {
  const lead = TITLE_LEAD.exec(text)?.[0].length ?? 0;
  const names = namesIn(text.slice(lead), aliases);
  // A title naming two papers — "Chimera vs. Chinchilla" — is about neither.
  // A title and its head both open "Scaling Laws for Efficient MoE…": one paper.
  const named = new Set(names.map((match) => match.title));
  return named.size === 1 && names.some((match) => match.start === 0) ? [...named][0] : null;
}

/**
 * An answer's titles, each with its depth and the paper it opens with, read
 * once per answer and library. Every block asks for its section on every
 * render, and a streamed answer renders once a token: asked per block, a parse
 * of the whole answer per block made an 8 KB answer cost 330 ms a render.
 */
const titlesByLibrary = new WeakMap<PaperAlias[], Map<string, Title[]>>();

function titlesOf(source: string, aliases: PaperAlias[]): Title[] {
  let bySource = titlesByLibrary.get(aliases);
  if (!bySource) titlesByLibrary.set(aliases, (bySource = new Map()));
  let titles = bySource.get(source);
  if (!titles) {
    const code = markdownCodeRanges(source);
    titles = [...source.matchAll(TITLE)]
      .filter((title) => !code.some(([from, to]) => title.index >= from && title.index < to))
      // A bold paragraph is the innermost title there is; `#` through `######` contain it.
      .map((title) => ({ index: title.index, depth: title[1] ? title[1].length : 7, paper: titlePaper(title[2] ?? title[3], aliases) }));
    if (bySource.size >= 16) bySource.delete(bySource.keys().next().value!);
    bySource.set(source, titles);
  }
  return titles;
}

/**
 * The paper the section a block sits in is about: the nearest title above it
 * that is about a paper, climbing only to titles of the sections that contain it.
 *
 * An answer comparing papers gives each its own section — "## 2. Scaling Laws
 * for Native Multimodal Models", then "### Where the allocation is
 * established", then a table of "Table 1, p. 2" and "§4.2, p. 6" that never
 * says whose they are. Read by the block alone, every cell named nothing, and
 * in a Memory chat each one opened the first paper the answer mentioned.
 */
function sectionPaper(source: string, aliases: PaperAlias[], at: number): string | null {
  const titles = titlesOf(source, aliases);
  let within = 8;
  for (let index = titles.length - 1; index >= 0; index--) {
    const title = titles[index];
    if (title.index >= at || title.depth >= within) continue;
    within = title.depth;
    if (title.paper) return title.paper;
  }
  return null;
}

/**
 * The one paper a block of the answer talks about, given that block's own span
 * of the source.
 *
 * Which span that is matters more than it looks. A citation's own element is
 * the wrong unit: bold it, and `**(pp. 5-8)**` is a `strong` covering the
 * citation and nothing else, so the sentence that named the paper falls outside
 * it and formatting alone would decide which document opens. The caller passes
 * the enclosing block's range instead, taken from the markdown tree — which
 * knows where a paragraph really ends, including the cases a line-by-line guess
 * gets wrong, such as a blockquote whose single paragraph wraps over several
 * `>` lines.
 */
export function blockPaper(
  source: string,
  aliases: PaperAlias[],
  start?: number,
  end?: number,
): string | null {
  // No reliable source position, no inference. The alternative — a shared
  // cursor consuming citations in React's render order — mis-assigns a paper
  // the moment render order and source order diverge, and opening the wrong
  // document is worse than opening the one already on screen.
  if (typeof start !== "number" || typeof end !== "number") return null;
  const block = source.slice(start, end);
  const named = namedIn(block.replace(POSSESSED, " "), aliases);
  if (named.size === 1) return [...named][0];
  // A block that names no paper is about its section's.
  if (!named.size) return sectionPaper(source, aliases, start);
  // One that names several says whose it is by what it cites — "…comparable to
  // Chimera's recipe. (MoE paper, §4.2.2, p. 15.)" — and, failing that, by the
  // section it is in, when that section's paper is among the ones it names.
  const cited = new Set(segmentCitations(block).flatMap((piece) =>
    piece.kind === "citation" && piece.target.paperName ? [...namedIn(piece.target.paperName, aliases)] : []));
  if (cited.size === 1) return [...cited][0];
  const section = sectionPaper(source, aliases, start);
  return section && named.has(section) ? section : null;
}

/** What a citation can learn from the block it sits in, read once per block. */
export type BlockContext = { paper: string | null; outside: boolean };

export const NO_BLOCK: BlockContext = { paper: null, outside: false };

export function blockContext(source: string, aliases: PaperAlias[], start?: number, end?: number): BlockContext {
  return { paper: blockPaper(source, aliases, start, end), outside: citesOnlyTheWeb(source, aliases, start, end) };
}

/**
 * Whether a block's evidence is a web page and no document in the library: it
 * links the web, and no parenthetical in it names a library document.
 *
 * A reading plan that reaches outside the library reads "I found Baidu's ERNIE
 * 5.0 Technical Report. Inspect Figure 1 / §2.1 … ([arxiv.org](…))", and the
 * block may well name a library paper in passing ("the trade-off Chinchilla
 * measured"). Its locators are the outside report's, and
 * sending them into Chinchilla would open a figure nobody cited — its pages as
 * much as its figures, since the link is as often to a PDF the model read on
 * the web. A parenthetical there is read as anywhere else: it says whose it is.
 */
export function citesOnlyTheWeb(
  source: string,
  aliases: PaperAlias[],
  start?: number,
  end?: number,
): boolean {
  if (typeof start !== "number" || typeof end !== "number") return false;
  const block = source.slice(start, end);
  if (!/\]\(\s*<?https?:\/\//i.test(block)) return false;
  return !segmentCitations(block).some((piece) =>
    piece.kind === "citation" && piece.target.paperName && soleMentionedPaper(piece.target.paperName, aliases));
}

/**
 * Tokens inside a citation that are not prose: a code span (group 1 opens it,
 * group 2 is its text), a link's destination, an autolink, a bare URL, and
 * inline maths. Emphasis is never read inside one — an underscore in a URL or a
 * star in `a*b` is not markup.
 */
const LITERAL = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)|\]\([^()\s]*\)|<[A-Za-z][\w+.-]*:[^<>\s]*>|https?:\/\/[^\s()<>]+|\$\$?[^$\n]+?\$\$?/g;

/**
 * One emphasis pair, as GFM reads it: the same run on both sides, hugging
 * non-space text. Underscores also need a non-word character outside them,
 * which is why `snake_case_name` is left alone.
 */
const EMPHASIS = [
  /(?<![\\*])(\*{1,3})(?=[^\s*])([^*\n]*?[^\s*\\])\1(?!\*)/g,
  /(?<![\\\p{L}\p{N}_])(_{1,3})(?=[^\s_])([^_\n]*?[^\s_\\])\1(?![\p{L}\p{N}_])/gu,
];

/**
 * A struck-through run, which is never unwrapped: struck text is retracted and
 * never cites. Unwrapped, `(~~p. 2~~)` would cite the page it retracts, and
 * `(mup, ~~p. 8~~ p. 9)` would send the reader to page 8.
 */
const STRUCK = /(?<![\\~])(~~?)(?=[^\s~])([^~\n]*?[^\s~\\])\1(?!~)/;

/** Placeholders for literal tokens, from the private-use area no answer types. */
const HOLD = /(\d+)/g;

/**
 * A citation's text with its inline markup taken off: emphasis, bold and code
 * spans become their words. Link destinations, URLs and maths are kept exactly
 * as written. Null when any of it is struck through, which keeps it as written.
 */
function withoutMarkup(inner: string): string | null {
  const held: string[] = [];
  let text = inner.replace(LITERAL, (token, ticks: string | undefined, code: string | undefined) => {
    // CommonMark drops one padding space from each side of a code span.
    held.push(ticks ? code!.replace(/^ (?=[\s\S]*\S)([\s\S]*) $/, "$1") : token);
    return `${held.length - 1}`;
  });
  if (STRUCK.test(text)) return null;
  // Outside in: `*a **b** c*` loses one layer per pass.
  for (let pass = 0; pass < 3; pass++) {
    const before = text;
    for (const pattern of EMPHASIS) text = text.replace(pattern, "$2");
    if (text === before) break;
  }
  return text.replace(HOLD, (_, index: string) => held[Number(index)]);
}

/**
 * Fenced code blocks, which are never prose; a citation-shaped line inside one
 * is a program's output, and its stars are the program's.
 */
function proseRuns(content: string): Array<{ text: string; prose: boolean }> {
  const runs: Array<{ text: string; prose: boolean }> = [];
  let from = 0;
  for (const [start, end] of markdownCodeRanges(content)) {
    if (start > from) runs.push({ text: content.slice(from, start), prose: true });
    runs.push({ text: content.slice(start, end), prose: false });
    from = end;
  }
  if (from < content.length) runs.push({ text: content.slice(from), prose: true });
  return runs;
}

/** Where the code spans of a run of prose are, so nothing inside one is rewritten. */
function codeSpans(text: string): Array<[number, number]> {
  return markdownCodeRanges(text, true);
}

/**
 * Unwrap the markup the model put inside a citation, which defeats linking.
 *
 * Models write ``(Why We Think, §`thinking-in-tokens`)``, `(*mup*, pp. 8–9)`,
 * `(*vLLM-Omni tech report (2610.09307v1)*, pp. 4–7.)` and
 * `(mup, **Table 4**, p. 9)`: reasonable markdown, but react-markdown turns each
 * marked-up run into its own element, so the parenthetical reaches the citation
 * walker split across children and is never seen whole. No link appears, and
 * neither does a row in the answer's sources.
 *
 * The rule is the walker's own: a parenthetical that would be a citation
 * without its markup loses its markup. The old rule instead spelled out one
 * shape — a title right after "(", free of parentheses, right before a page —
 * and every title that carried its arXiv id in parentheses, every bold table
 * number and every second document after a semicolon fell outside it. Any
 * other parenthetical keeps its emphasis, and so does everything outside one.
 * One with a struck-through run keeps everything: struck text never cites.
 */
export function normalizeCitationMarkup(content: string) {
  if (!/[*_~`]/.test(content)) return content;
  return proseRuns(content).map(({ text, prose }) => {
    if (!prose || !/[*_~`]/.test(text)) return text;
    const code = codeSpans(text);
    let out = "", cursor = 0;
    for (const match of findParentheticals(text)) {
      // Nested inside one already rewritten, or a parenthesis that is code.
      if (match.index < cursor || code.some(([from, to]) => match.index > from && match.index < to)) continue;
      const plain = withoutMarkup(match.inner);
      if (plain === null || plain === match.inner) continue;
      if (!segmentCitations(`(${plain})`).some((piece) => piece.kind === "citation")) continue;
      out += `${text.slice(cursor, match.index)}(${plain})`;
      cursor = match.index + match.length;
    }
    return out + text.slice(cursor);
  }).join("");
}
