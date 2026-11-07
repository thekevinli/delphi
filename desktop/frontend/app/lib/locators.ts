/**
 * A locator is what a citation points at *inside* a document — "Table 2",
 * "Fig. 2", "§3.2", "Eq. 6".
 *
 * Everything about how one is spelled lives in the single table below, because
 * the three places that used to know it — the parser's alternation, the "is
 * this fragment a paper name" negation, and the noun shown to the reader —
 * drifted apart, and the gap between them is precisely what made
 * `(JiT, Table 2)` render as unclickable prose.
 *
 * `body` is written against what a PDF *prints*, not what a model writes, and
 * that asymmetry is the whole bug this module exists to fix. A model writes
 * "Equation 6" where the paper prints "Eq. (6)" or bare "(6)"; it writes
 * "Section 3.2" where the paper prints "3.2. Prediction Space". Searching a
 * document for the model's spelling finds nothing, every time — which is why
 * every locator citation used to stall and then outline the whole page.
 */

export type LocatorKind =
  | "table"
  | "figure"
  | "section"
  | "equation"
  | "algorithm"
  | "appendix"
  | "theorem"
  | "lemma"
  | "proposition"
  | "corollary"
  | "definition";

export type Locator = {
  kind: LocatorKind;
  /** As written: "2", "3.2", "A". */
  number: string;
  /** The canonical spelling, for the link's tooltip only. */
  label: string;
};

/**
 * Neither `\b` nor a bare lookahead is enough after a locator's number: `\b`
 * let "Section 3.2" match "3.2.1" and "Table 4" match "Table 4.1", because the
 * boundary between "2" and "." is a word boundary. Reject a following digit,
 * and a following dot that starts one.
 */
const TAIL = String.raw`(?!\d)(?!\.\d)`;

/**
 * After a number that ends in a letter — an appendix printed as plain "F" —
 * a following letter is a different word too: "F" is not the start of "FLOPs".
 */
const tail = (n: string) => (/[A-Za-z]$/.test(n) ? String.raw`(?!\w)(?!\.\d)` : TAIL);

/**
 * Digits, dotted subsections and the odd "A1", plus an appendix's own
 * subsections, "D.2" and "B.1.3" — a bare letter appendix is its kind's own
 * alternative.
 */
const NUMBER = String.raw`(?:[A-Z]?\d+|[A-Z](?=\.\d))(?:\.\d+)*`;

/** A numbered statement in a proof-heavy paper, printed "Theorem 3.1." and cited the same way. */
const statement = (words: string) => (n: string) => String.raw`\b(?:${words})\.?\s*${n}${TAIL}`;

const KINDS: ReadonlyArray<{
  kind: LocatorKind;
  noun: string;
  /** How a *citation* names it, inside a parenthetical: any case, any abbreviation. */
  lead: string;
  /**
   * How a *sentence* names it, outside one (`LOCATOR_IN_PROSE`). The noun has to
   * look like one there — capitalised, abbreviated with its dot, or a whole
   * lowercase word — so "tab 2" and "app 3" in passing are not read as a table
   * and an appendix.
   */
  prose: string;
  /** How the *document* prints it. `n` arrives RegExp-escaped. */
  body: (n: string) => string;
  /** Kinds whose number may be a bare letter. */
  letter?: true;
}> = [
  { kind: "table", noun: "Table", lead: String.raw`tabs?|tables?`, prose: String.raw`[Tt]ables?|Tabs?\.`,
    body: n => String.raw`\btab(?:le)?s?\.?\s*${n}${TAIL}` },
  { kind: "figure", noun: "Figure", lead: String.raw`figs?|figures?`, prose: String.raw`[Ff]igures?|Figs?\.?`,
    body: n => String.raw`\bfig(?:s?\.|ures?)?\s*${n}${TAIL}` },
  { kind: "section", noun: "Section", lead: String.raw`secs?|sects?|sections?`, prose: String.raw`[Ss]ections?|Sec(?:t|s)?\.`,
    // A section heading is printed as its own number — "3.2. Prediction Space"
    // — so the noun is optional here in a way it is not for the others. The
    // lookbehind keeps "3.2" from matching inside "13.2" or "1.3.2". The noun,
    // when there is one, is group 1: `matchLocator` needs to know.
    body: n => String.raw`(§\s*|\bsec(?:t(?:ion)?)?s?\.?\s*)?(?<![\w.])${n}${tail(n)}` },
  { kind: "equation", noun: "Equation", lead: String.raw`eqs?|eqns?|equations?`, prose: String.raw`[Ee]quations?|Eq(?:n?s)?\.?`,
    // Equation numbers are printed in parentheses at the margin, usually with
    // no noun at all. The noun, when there is one, is group 1.
    body: n => String.raw`(\beq(?:n?s?\.|uations?)?\s*)?\(\s*${n}\s*\)` },
  { kind: "algorithm", noun: "Algorithm", lead: String.raw`algs?|algos?|algorithms?`, prose: String.raw`[Aa]lgorithms?|Alg(?:o|s)?\.`,
    body: n => String.raw`\balg(?:o(?:rithm)?)?s?\.?\s*${n}${TAIL}` },
  { kind: "appendix", noun: "Appendix", lead: String.raw`appendix|appendices|apps?`, prose: String.raw`[Aa]ppendix|[Aa]ppendices|App\.`,
    // An appendix is headed by its letter alone as often as by the word —
    // "F. FLOPs computation", "D.2 Approach 3" — so, like a section, the noun
    // is optional, and group 1 when present.
    body: n => String.raw`(\bapp(?:endix)?\.?\s*)?(?<![\w.])${n}${tail(n)}`, letter: true },
  { kind: "theorem", noun: "Theorem", lead: String.raw`thms?|theorems?`, prose: String.raw`[Tt]heorems?|Thms?\.`,
    body: statement("theorems?|thms?") },
  { kind: "lemma", noun: "Lemma", lead: String.raw`lems?|lemmas?`, prose: String.raw`[Ll]emmas?|Lem\.`,
    body: statement("lemmas?|lem") },
  { kind: "proposition", noun: "Proposition", lead: String.raw`props?|propositions?`, prose: String.raw`[Pp]ropositions?|Prop\.`,
    body: statement("propositions?|prop") },
  { kind: "corollary", noun: "Corollary", lead: String.raw`cors?|corollary|corollaries`, prose: String.raw`[Cc]orollary|[Cc]orollaries|Cor\.`,
    body: statement("corollary|corollaries|cor") },
  { kind: "definition", noun: "Definition", lead: String.raw`defs?|definitions?`, prose: String.raw`[Dd]efinitions?|Def\.`,
    body: statement("definitions?|defs?") },
];

/** Every spelling a citation may use to open a locator. */
export const LOCATOR_LEAD = KINDS.map(kind => kind.lead).join("|");

/**
 * Leading fragments that are locators rather than a paper name. "p."/"pp." get
 * their own branch because a trailing period is not a word boundary, so a `\b`
 * after them would never match.
 */
export const NOT_A_NAME = new RegExp(
  String.raw`^\s*(?:§|pp?\.|pgs?\.|pages?\s|(?:${LOCATOR_LEAD})\b)`,
  "i",
);

/**
 * Where a locator begins in a citation segment, whatever kind it is. Used only
 * to find where a paper's name stops and its locator starts.
 */
export const LOCATOR_AT = new RegExp(
  String.raw`(?:\u00a7\s*|\b(?:${LOCATOR_LEAD})\b\.?\s*)\(?\s*(?:${NUMBER}|[A-Z](?![A-Za-z]))`,
  "i",
);

/**
 * A locator as a sentence writes it, outside any parenthetical: "Table 6",
 * "§§3.2–3.4", "Figs. 8 and 9", "Equations (1)–(2)", "Fig. 9d", "Appendix F".
 *
 * Models put locators in their own prose at least as often as in a
 * parenthetical — the system prompt's own examples do ("§4.2 gives accuracy",
 * "Read Table 2's caption") — and a reading plan is mostly a list of them. A
 * range or a list after the number belongs to the same locator; its first
 * number is where a click goes. A bare letter is let through for an appendix
 * and read as nothing for the rest ("Section I" names no page).
 */
const PROSE_NUMBER = String.raw`(?:\(\s*\d+(?:\.\d+)*[a-z]?\s*\)|[A-Z]?\d+(?:\.\d+)*(?:[a-z](?![A-Za-z]))?|[A-Z](?:\.\d+)+|[A-Z](?![\w]))`;
export const LOCATOR_IN_PROSE = new RegExp(
  String.raw`(?:§§?\s*|(?<![\w.])(?:${KINDS.map(kind => kind.prose).join("|")})\s*)${PROSE_NUMBER}` +
    String.raw`(?:\s*[–—-]\s*§?\s*${PROSE_NUMBER}|\s+(?:and|&|to)\s+${PROSE_NUMBER})*(?![\w])`,
  "g",
);

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PARSERS = KINDS.map(kind => ({
  kind,
  // `§` introduces a section with no noun; every other kind needs its noun. An
  // equation is cited as the paper prints it, "Eq. (6)", as often as "Eq. 6":
  // the system prompt asks for the first, which this used to read as nothing.
  pattern: new RegExp(
    kind.kind === "section"
      ? String.raw`(?:§\s*|\b(?:${kind.lead})\b\.?\s*)(${NUMBER})`
      : String.raw`\b(?:${kind.lead})\b\.?\s*${kind.kind === "equation" ? String.raw`\(?\s*` : ""}(${kind.letter ? String.raw`${NUMBER}|[A-Z](?![A-Za-z])` : NUMBER})`,
    "i",
  ),
}));

/**
 * The first locator a citation segment names, or null.
 *
 * Deliberately the first and not all of them: a segment reading
 * "Eq. 6 and Algorithm 1, p. 7" is one citation and gets one jump target, so
 * following it cannot scatter highlights across a page.
 */
export function parseLocator(segment: string): Locator | null {
  let best: { at: number; kind: (typeof KINDS)[number]; number: string } | null = null;
  for (const { kind, pattern } of PARSERS) {
    const match = pattern.exec(segment);
    if (!match) continue;
    if (!best || match.index < best.at) best = { at: match.index, kind, number: match[1] };
  }
  if (!best) return null;
  const number = best.number.toUpperCase();
  return { kind: best.kind.kind, number, label: `${best.kind.noun} ${number}` };
}

export type LocatorMatch = { index: number; length: number; rank: number };

/**
 * The rank at which a match reads as the captioned thing itself rather than a
 * mention of it. Named because the index treats anything weaker as provisional:
 * papers routinely write "as shown in Table 4" a page before Table 4 appears.
 */
export const CAPTION = 3;

/**
 * What the line around a run says about it, which the run's own text cannot.
 */
export type RunContext = {
  /**
   * This line carries on a sentence the line above it left unfinished: same
   * paragraph, same margin, one line down. "…compared to the same analysis on"
   * then "Table 1. This confirms that…" is a sentence that wrapped, however
   * much its second line looks like a caption.
   */
  continues?: boolean;
  /**
   * The line is set smaller than the page's running text: a figure's legend
   * or tick labels, "4 Configurations". A heading never is.
   */
  small?: boolean;
};

/** Kinds whose `body` lets the noun go unprinted, and captures it as group 1 when it is. */
const NOUN_OPTIONAL = new Set<LocatorKind>(["section", "equation", "appendix"]);

/** Kinds stated with an optional name before their full stop: "Theorem 2 (Scaling law). Let…". */
const STATEMENTS = new Set<LocatorKind>(["theorem", "lemma", "proposition", "corollary", "definition"]);

/**
 * Whether what follows a caption's number reads as the caption's own text
 * rather than the rest of a sentence. A caption's label is followed by its
 * punctuation ("Table 2.", "Figure 3:"), by a separator glyph — which some
 * fonts extract as a lone letter, "Figure 3 j IsoFLOP curves" — by its title
 * glued on or capitalised ("Algorithm 1Training step"), or by nothing at all,
 * when the label sits on its own line. Prose goes on in lower case, "Figure 21
 * shows", or into a parenthesis, "Figure 3 (left). In all cases".
 */
function captioned(rest: string, statement: boolean): boolean {
  if (/^\s*(?:$|[:.|\u2014\u2013]|\p{L}\s+\p{Lu}|\p{Lu})/u.test(rest)) return true;
  return statement && /^\s*\([^()]{1,80}\)\s*[.:]/.test(rest);
}

/** Lowercase words a prose reference to an equation reads after: "minimise (3)", "in (1)". */
const REFERS = /(?:^|[^\p{L}])(?:[a-z]{3,}|in|of|to|by|as|on|at|or)\s*$/u;

/**
 * Whether what follows a bare printed number reads as a heading's title.
 *
 * A heading is a capitalised title set off from its number, "3.3 Inference
 * Cost Correction" or "F. FLOPs computation". The same number at the start of
 * a line is also an axis tick or a page number with nothing after it, an
 * affiliation mark glued to its institution ("1FAIR at Meta"), a table row
 * that is mostly figures, a reference list's initial followed by a name
 * ("F. Hutter, …", "J. Nocedal. Updating…", "A Yang Qwen, Baosong Yang, …"),
 * a numbered paragraph that runs on past its first sentence, or a line of
 * prose too long to be a title. A lettered heading has one more lookalike, a
 * notation entry that is a sentence: "E Number of routable experts."
 */
function headed(rest: string, lettered: boolean): boolean {
  const set = /^(?:[.:]\s*|\s+)/.exec(rest);
  if (!set) return false;
  const title = rest.slice(set[0].length);
  if (!/^\p{Lu}/u.test(title)) return false;
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length > 14) return false;
  if (words.slice(0, 3).some(word => /^\p{Lu}\.$/u.test(word))) return false;
  if (words.length > 1 && /[.,]$/.test(words[0])) return false;
  if (/\p{Ll}{3,}[.!?]\s+\p{Lu}/u.test(title) || (title.match(/,/g)?.length ?? 0) >= 3) return false;
  if (lettered && words.length >= 3 && /\.$/.test(title.trimEnd())) return false;
  const letters = title.match(/\p{L}/gu)?.length ?? 0;
  const digits = title.match(/\d/g)?.length ?? 0;
  const figures = words.filter(word => /\d/.test(word)).length;
  return letters >= 2 * digits && 2 * figures < words.length;
}

/**
 * Where a locator appears in one run of extracted document text, and how much
 * that appearance looks like the thing itself rather than a mention of it.
 *
 * This is a heuristic and is meant to stay one. Extracted PDF text carries no
 * structural marker for a caption, so the rules below rank likelihood and
 * promise nothing more. **Do not grow this into a list of per-document
 * exceptions**: when a paper defeats it the citation lands on the page, which
 * is a supported outcome and a far better failure than a rule that fits one
 * document and misreads the next.
 *
 *   3 — probably the caption or heading itself.
 *   2 — opens its run, but reads like prose.
 *   1 — mentioned mid-sentence.
 *
 * What makes a 3 depends on how the kind is printed:
 *
 * - A table, figure, algorithm or statement prints its noun, and its caption
 *   opens a line with the label and then its own text (`captioned`). A line
 *   that opens with the noun and goes on as a sentence — "Figure 21 shows
 *   that", or anything that wraps on from the line above — is prose.
 * - A section, and an appendix headed by its letter, prints only its number,
 *   followed by a title (`headed`). The noun in front of a section number is
 *   therefore the mark of a *reference*, "Section 4.1, we observe", and a bare
 *   number that is not followed by a title — an axis tick, a page number, a
 *   figure in a table — is not the section at all and does not match. Nor is
 *   one set in a figure's small type, or one a wrapped sentence starts on.
 * - An equation prints its number at the right margin, so its own number ends
 *   its line; "(1)" opening a line followed by more, "(1):73–101", is a
 *   reference list's issue number or an enumeration.
 */
export function matchLocator(run: string, locator: Locator, context: RunContext = {}): LocatorMatch | null {
  const kind = KINDS.find(entry => entry.kind === locator.kind);
  if (!kind) return null;
  const match = new RegExp(kind.body(escape(locator.number)), "i").exec(run);
  if (!match) return null;
  const at = (rank: number) => ({ index: match.index, length: match[0].length, rank });

  // Extraction routinely glues the previous fragment's trailing punctuation to
  // the front of the next, so an equation number set alone at the margin
  // arrives as ",(6)". Leading punctuation is not prose and does not stop a run
  // from being a caption.
  const first = run.search(/\S/);
  const lead = run.search(/[^\s.,;:\u00b7]/);
  const opens = match.index === first || match.index === lead;
  const rest = run.slice(match.index + match[0].length);
  const named = !NOUN_OPTIONAL.has(kind.kind) || match[1] !== undefined;

  if (kind.kind === "equation") {
    if (named) return at(opens ? 2 : 1);
    const closes = /^[\s.,;:]*$/.test(rest);
    return at(closes && !REFERS.test(run.slice(0, match.index)) ? CAPTION : 1);
  }
  if (!named) {
    // Printed case is the whole signal for a lettered appendix: "a" opening a
    // line is an article, not appendix A.
    const lettered = /[A-Za-z]/.test(locator.number);
    if (lettered && match[0] !== locator.number) return null;
    return opens && !context.continues && !context.small && headed(rest, lettered) ? at(CAPTION) : null;
  }
  if (!opens) return at(1);
  if (context.continues || kind.kind === "section") return at(2);
  return at(captioned(rest, STATEMENTS.has(kind.kind)) ? CAPTION : 2);
}
