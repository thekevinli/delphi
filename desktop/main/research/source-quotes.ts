// PDF extraction may concatenate words, split words at line endings, flatten
// superscripts, or use ligatures. Match those representations, not paraphrases.
// Keep offsets so the saved quote is the captured source itself.
const wrap = '\uE000';
function canonical(text: string, source: boolean) {
  let value = ''; const offsets: { start: number; end: number }[] = [];
  const tokens = /-[ \t]*\r?\n|\^\{([^{}]+)\}|\^([A-Za-z0-9])|[\s\S]/gu;
  for (const match of text.matchAll(tokens)) {
    const raw = match[0];
    const normalized = source && /^-[ \t]*\r?\n$/.test(raw)
      ? wrap : (match[1] ?? match[2] ?? raw).normalize('NFKC').replace(/\s/g, '');
    for (const char of normalized) {
      value += char;
      for (let i = 0; i < char.length; i++) offsets.push({ start: match.index!, end: match.index! + raw.length });
    }
  }
  return { value, offsets };
}
export function capturedQuote(text: string, excerpt: string): string | undefined {
  let quote = excerpt.trim();
  const pairs: Record<string, string> = { '"': '"', '“': '”', '‘': '’' };
  if (pairs[quote[0]] === quote.at(-1)) quote = quote.slice(1, -1).trim();
  const needle = canonical(quote, false).value;
  if (!needle || needle.includes(wrap)) return undefined;
  const haystack = canonical(text, true);
  const escape = (char: string) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Only a hyphen at an actual source line break is discretionary. Minus signs
  // and in-line hyphens, numbers, order, and all other symbols must match.
  const pattern = Array.from(needle, char => char === '-' ? `(?:-|${wrap})` : escape(char)).join(`${wrap}*`);
  const match = new RegExp(pattern, 'u').exec(haystack.value);
  if (!match) return undefined;
  return text.slice(haystack.offsets[match.index].start, haystack.offsets[match.index + match[0].length - 1].end);
}
