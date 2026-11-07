/** Math compatibility shared by the Markdown plugins and plain-text titles.
 * No KaTeX here: a title loads it only once it holds math. */

export function escapedAt(content: string, index: number): boolean {
  let count = 0;
  while (content[--index] === "\\") count++;
  return count % 2 === 1;
}

export function repairMathOperators(math: string): string {
  return math.replace(
    // `(?![A-Za-z])` rather than `\b` on the tail: the operator is followed by
    // its own subscript far more often than not, and `_` is a word character,
    // so `\b` refuses to close exactly where this is needed most.
    // Only explicit commands need compatibility repair. Bare names inside
    // \text{argmax} or \operatorname{argmin} are already valid; inserting a
    // math command there can make the entire equation unrenderable.
    /\\arg\s*\\?(min|max)(?![A-Za-z])/g,
    (_match, operator: string) => `\\operatorname*{arg\\,${operator}}`,
  );
}

/**
 * A one-line title, cut into the text and the mathematics it carries.
 *
 * A conversation title is the model's own sentence, so it arrives with the
 * same `\(…\)` an answer does — but it is drawn in a list row or a tab, where
 * a Markdown renderer has no business. This finds only the math; everything
 * else stays the plain string it was.
 *
 * Dollar signs are held to a higher bar than in an answer: a title such as
 * "$5 vs $10 plans" is far likelier than one with dollar-delimited math, so a
 * `$…$` span counts only when its inside has the punctuation of notation.
 */
export type TitleSegment = { math: string; source: string } | { text: string };

const TITLE_MATH =
  /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|(?<![\\$\w])\$(?!\s)([^$]*?[\\^_{][^$]*?)(?<![\s\\])\$(?![\w$])/g;

export function titleSegments(title: string): TitleSegment[] {
  const segments: TitleSegment[] = [];
  let cursor = 0;
  for (const match of title.matchAll(TITLE_MATH)) {
    const math = (match[1] ?? match[2] ?? match[3] ?? match[4]).trim();
    if (!math) continue;
    if (match.index > cursor) segments.push({ text: title.slice(cursor, match.index) });
    segments.push({ math: repairMathOperators(math), source: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < title.length) segments.push({ text: title.slice(cursor) });
  return segments;
}
