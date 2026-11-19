/**
 * Where in a section a quote is, tolerant of how it was set: the capture keeps
 * the page as markdown, and a quote is the same words without the marks.
 */
export function quoteRange(text: string, quote: string): [number, number] | null {
  const words = quote.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < 3) return null;
  const pattern = new RegExp(words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}]+"), "iu");
  const found = pattern.exec(text);
  return found ? [found.index, found.index + found[0].length] : null;
}
