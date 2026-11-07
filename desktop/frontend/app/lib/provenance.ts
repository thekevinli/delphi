/**
 * A Memory page's Provenance: its sources grouped by document, and the counts
 * the folded strip shows. JSX-free, so `node --test` reaches it.
 */
import type { MemoryAuthor, MemoryCitation, MemorySource } from "./api.ts";
import { citationsBySection } from "./memory.ts";

type Sections = Array<{ section: string; ids: number[] }>;

export type SourceGroups = {
  /** Each document the page cites, most-cited first, with its passages by section. */
  documents: Array<{ source: MemorySource; sections: Sections }>;
  /** Each captured outside source, with its passages; `captured: false` once it is no longer kept. */
  outside: Array<{ evidenceId: string; captured: boolean; sections: Sections }>;
  /** What no source holds: Delphi's inference, and any marker naming nothing. */
  rest: Sections;
};

const isOutside = (citation: MemoryCitation) => citation.claimType === "external" && Boolean(citation.evidenceId);

/** A page's citations under the source each rests on. */
export function sourceGroups(citations: MemoryCitation[], sources: MemorySource[]): SourceGroups {
  const documents = sources.map((source) => ({
    source,
    sections: citationsBySection(citations.filter((citation) => !isOutside(citation) && citation.paperId === source.paperId)),
  }));
  const placed = new Set(sources.map((source) => source.paperId));
  const captures = new Map<string, MemoryCitation[]>();
  for (const citation of citations.filter(isOutside)) {
    captures.set(citation.evidenceId!, [...(captures.get(citation.evidenceId!) ?? []), citation]);
  }
  return {
    documents,
    outside: [...captures].map(([evidenceId, cited]) => ({
      evidenceId,
      captured: cited.every((citation) => citation.captured !== false),
      sections: citationsBySection(cited),
    })),
    rest: citationsBySection(citations.filter((citation) => !isOutside(citation) && !placed.has(citation.paperId ?? ""))),
  };
}

/**
 * The folded strip: one count per group, in the order the groups open, with
 * an empty group left out. "4 sources · 4 authors · 3 references".
 */
export function provenanceCounts(groups: SourceGroups, authors: MemoryAuthor[], references: number) {
  const counts = [
    [groups.documents.length + groups.outside.length, "source"],
    [authors.length, "author"],
    [references, "reference"],
  ] as const;
  return counts.filter(([count]) => count > 0).map(([count, noun]) => ({ count, noun: count === 1 ? noun : `${noun}s` }));
}

/** What the strip's hover says is gone: "1 source and 1 author deleted", or nothing. */
export function deletedCounts(groups: SourceGroups, authors: MemoryAuthor[]): string {
  const sources = groups.documents.filter(({ source }) => !source.available).length
    + groups.outside.filter((capture) => !capture.captured).length;
  const removed = authors.filter((author) => author.removed).length;
  const said = [
    sources ? `${sources} source${sources === 1 ? "" : "s"}` : "",
    removed ? `${removed} author${removed === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return said.length ? `${said.join(" and ")} deleted` : "";
}
