/**
 * A marked passage, printed as an index entry rather than as a facsimile.
 *
 * Quotes arrive carrying the line breaks of wherever they were taken from: a
 * PDF column wraps every six or seven words, and a webpage wraps where its own
 * layout happened to. Honouring those breaks in a card two hundred pixels wide
 * turns one sentence into a ragged stack and makes a list of three notes look
 * like a page of poetry. The words are exact; only the breaks between them are
 * the source document's business rather than ours.
 */
export function condenseQuote(text: string) {
  return text.replace(/\s+/g, " ").trim();
}
