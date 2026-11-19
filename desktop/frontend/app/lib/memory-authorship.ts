/**
 * How a concept page's Written by names its authors. JSX-free, so
 * `node --test` reaches it.
 */
import type { MemoryAuthor } from "./api.ts";

/** A row's name: the document, the chats and notes beside one, or the Memory chat. */
export function authorName(author: MemoryAuthor): string {
  if (author.kind === "chat") return author.title ? `Memory chat: ${author.title}` : "A deleted Memory chat";
  if (!author.title) return "A document no longer in your library";
  return author.kind === "session" ? `Chats and notes beside ${author.title}` : author.title;
}

/** "Sep 12", and "Sep 12, 2025" for a year that is not this one. */
export function authorDate(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const year = at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const };
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", ...year });
}
