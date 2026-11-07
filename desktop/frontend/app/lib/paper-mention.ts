/** The visible title budget; the leading @ and a trailing ... do not count. */
export const PAPER_MENTION_TITLE_MAX_CHARS = 30;

/**
 * Fit a paper title into the composer without cutting through a word. The
 * ellipsis sits outside the title budget: it says that words were omitted,
 * rather than taking three characters away from the last complete word.
 */
export function compactPaperMentionTitle(
  title: string,
  maxChars = PAPER_MENTION_TITLE_MAX_CHARS,
): string {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxChars) return normalized;

  const segments = Array.from(
    new Intl.Segmenter(undefined, { granularity: "word" }).segment(normalized),
    ({ segment }) => segment,
  );
  let visible = "";
  for (const segment of segments) {
    const candidate = visible + segment;
    if (candidate.length > maxChars) break;
    visible = candidate;
  }
  visible = visible.trimEnd();

  // A single long word has no legal internal breaking point. Keeping it whole
  // honours the stronger promise: a mention never shows half a title word.
  const firstWord = segments.find((segment) => segment.trim()) ?? "";
  return `${visible || firstWord}...`;
}

export function paperMentionToken(title: string): string {
  return `@${compactPaperMentionTitle(title)}`;
}

/**
 * The composer stores compact atomic labels, while the model should receive
 * the real titles. Expand one occurrence per selected paper so two references
 * whose compact labels happen to collide still follow selection order.
 */
export function expandPaperMentionTokens(
  text: string,
  papers: Array<{ title: string }>,
): string {
  let expanded = text;
  for (const paper of papers) {
    const compact = paperMentionToken(paper.title);
    const full = `@${paper.title}`;
    if (compact === full) continue;
    const index = expanded.indexOf(compact);
    if (index < 0) continue;
    expanded =
      expanded.slice(0, index) + full + expanded.slice(index + compact.length);
  }
  return expanded;
}

/**
 * The stored turn holds the expanded `@Full Title` the model received.
 * Editing paints compact chips, so the inverse has to run before the
 * field mounts — otherwise a long title sits in the draft as prose and
 * the `@` chip the reader sent never comes back.
 */
export function compactPaperMentionTokens(
  text: string,
  papers: Array<{ title: string }>,
): string {
  let compacted = text;
  for (const paper of papers) {
    const compact = paperMentionToken(paper.title);
    const full = `@${paper.title}`;
    if (compact === full) continue;
    const index = compacted.indexOf(full);
    if (index < 0) continue;
    compacted =
      compacted.slice(0, index) +
      compact +
      compacted.slice(index + full.length);
  }
  return compacted;
}
