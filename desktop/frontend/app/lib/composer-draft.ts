/**
 * The contenteditable composer's draft, as data.
 *
 * The composer is a `contenteditable` rather than a `<textarea>` because it
 * paints `@`-mentions as inline chips while the reader types. That means the
 * draft has two representations — the string the request carries, and the DOM
 * the reader looks at — and the rules for turning one into the other are the
 * part worth testing. They live here, out of the component, so that the one
 * composer now shared by all three chat contexts has a single set of them.
 *
 * `splitComposerDraft` is the piece with actual logic in it and is DOM-free on
 * purpose; everything below it is the thin DOM application of that result.
 */

import type { Paper } from "./api.ts";
import { paperMentionToken } from "./paper-mention.ts";

export type PaperMention = { start: number; end: number; query: string };

/** A run of plain text, or a mention that renders as one uneditable chip. */
export type DraftPiece =
  | { kind: "text"; value: string }
  | { kind: "token"; value: string };

/**
 * Where the `@`-menu should open, if anywhere.
 *
 * Anchored to a whitespace boundary so an email address or a `foo@bar` in
 * prose does not open a document picker mid-word.
 */
export function paperMentionAt(
  text: string,
  cursor: number,
): PaperMention | null {
  const beforeCursor = text.slice(0, cursor);
  const match = /(?:^|\s)@([^\n@\]]*)$/.exec(beforeCursor);
  if (!match) return null;
  return {
    start: cursor - match[1].length - 1,
    end: cursor,
    query: match[1].trim().toLowerCase(),
  };
}

/**
 * Whether what sits at the cursor is already a completed mention.
 *
 * A completed mention must not re-open the picker, but the text after it is
 * ordinary prose — so a token followed by punctuation or a space counts, and a
 * token the reader is still typing into does not.
 */
export function isResolvedPaperMention(
  text: string,
  mention: PaperMention,
  papers: Paper[],
): boolean {
  const candidate = text.slice(mention.start, mention.end);
  return papers.some((paper) => {
    const token = paperMentionToken(paper.title);
    if (candidate === token) return true;
    const suffix = candidate.slice(token.length);
    return candidate.startsWith(token) && /^[\s.,;:!?()[\]{}]/.test(suffix);
  });
}

/** Every token the composer paints as a chip, longest first. */
export function draftTokens(papers: Paper[], images: { number: number }[]): string[] {
  return [
    ...papers.map((paper) => paperMentionToken(paper.title)),
    ...images.map((image) => `@[Image #${image.number}]`),
  ];
}

/**
 * Cut a draft into plain runs and mention chips.
 *
 * Earliest match wins, and ties break toward the longer token: one document
 * titled "Attention" and another "Attention Is All You Need" would otherwise
 * see the shorter one swallow the front of the longer, leaving the tail of a
 * title sitting outside its own chip as editable text.
 */
export function splitComposerDraft(
  text: string,
  tokens: string[],
): DraftPiece[] {
  if (!text) return [];
  const pieces: DraftPiece[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const next = tokens
      .map((token) => ({ token, index: text.indexOf(token, cursor) }))
      .filter((item) => item.index >= 0)
      .sort(
        (left, right) =>
          left.index - right.index || right.token.length - left.token.length,
      )[0];
    if (!next) {
      pieces.push({ kind: "text", value: text.slice(cursor) });
      break;
    }
    if (next.index > cursor) {
      pieces.push({ kind: "text", value: text.slice(cursor, next.index) });
    }
    pieces.push({ kind: "token", value: next.token });
    cursor = next.index + next.token.length;
  }
  return pieces;
}

/** Which painted tokens survive in a draft — how a deleted chip is noticed. */
export function tokensPresent(text: string, tokens: string[]): string[] {
  return tokens.filter((token) => text.includes(token));
}
