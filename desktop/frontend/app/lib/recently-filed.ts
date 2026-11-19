import type { DashboardData, MemoryKind, MemoryPageSummary, Paper } from "./api.ts";
import { paperMark, type PaperMark } from "./paper-kind.ts";

/** A document's Memory page, as the new Memory chat offers it for a question. */
export type FiledDocument = {
  slug: string;
  title: string;
  filedAt: string;
  mark: PaperMark;
  /** The document's project's palette position; absent once the document is gone. */
  accentIndex?: number;
};

/** As many pages as a question names by hand; the server takes no more. Delphi finds others itself. */
export const NAMED_PAGES_MAX = 5;

/** A page a question names, by the title it was named under. */
export type NamedPage = { slug: string; title: string };

/** A Memory page an `@` in a Memory chat may name; a document's page wears its document's mark. */
export type MentionPage = { slug: string; title: string; kind: MemoryKind; mark?: PaperMark };

type Library = Array<Paper & { accentIndex?: number }>;

/** Every document in the account, with its project's palette position. */
export function libraryDocuments(data: Pick<DashboardData, "projects">) {
  return data.projects.flatMap((item) => item.documents.map((document) => ({ ...document, accentIndex: item.accentIndex })));
}

/** Every page, newest first, as the `@` menu offers them. */
export function mentionablePages(
  pages: Array<Pick<MemoryPageSummary, "slug" | "title" | "kind" | "createdAt" | "sourcePaperId">>,
  library: Library,
): MentionPage[] {
  const documents = new Map(library.map((document) => [document.id, document]));
  return [...pages]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((page) => {
      const document = page.kind === "source" && page.sourcePaperId ? documents.get(page.sourcePaperId) : undefined;
      return { slug: page.slug, title: page.title, kind: page.kind, ...(document ? { mark: paperMark(document) } : {}) };
    });
}

/**
 * Document pages, newest filed first, as many as a reader would name by hand
 * (the server takes five). Concept and domain pages are left out:
 * a filing writes several of them, and the reader thinks in what they filed.
 */
export function recentlyFiled(
  pages: Array<Pick<MemoryPageSummary, "slug" | "title" | "kind" | "createdAt" | "sourcePaperId">>,
  library: Library,
  limit = NAMED_PAGES_MAX,
): FiledDocument[] {
  const documents = new Map(library.map((document) => [document.id, document]));
  return pages
    .filter((page) => page.kind === "source")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
    .map((page) => {
      const document = page.sourcePaperId ? documents.get(page.sourcePaperId) : undefined;
      return {
        slug: page.slug,
        title: page.title,
        filedAt: page.createdAt,
        mark: document ? paperMark(document) : "pdf",
        accentIndex: document?.accentIndex,
      };
    });
}
