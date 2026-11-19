export function pdfFindMatches(pages: string[], query: string): { page: number; occurrence: number }[] {
  const needle = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (!needle) return [];
  return pages.flatMap((page, index) => {
    const text = page.replace(/\s+/g, " ").toLowerCase();
    const matches: { page: number; occurrence: number }[] = [];
    let offset = 0;
    while ((offset = text.indexOf(needle, offset)) !== -1) {
      matches.push({ page: index + 1, occurrence: matches.length });
      offset += needle.length;
    }
    return matches;
  });
}
