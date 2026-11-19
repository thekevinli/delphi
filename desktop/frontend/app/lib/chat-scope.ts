/**
 * Which evidence a question is asked against, and everything derived from it.
 *
 * Delphi has one chat with two contexts, and where it is asked decides which.
 * A **Project** question is asked beside a document, in the reader's rail: it
 * attaches that document whole and every other active document in the project
 * as its digest. A **Memory** question is asked anywhere else, on the Memory
 * chat page (`/memory/chat`), of the account's whole wiki; nothing starts open
 * beside it, though its tools open any document. Neither surface switches to
 * the other.
 *
 * A Project conversation belongs to the document it was started beside, which
 * is why its context is spelled `"document"` here and on the wire.
 *
 * The reader's URL says `?chat=paper` while a document's chat is docked; the
 * API says `scope: "document" | "general"`.
 */

import type { ChatScope as UrlChatScope } from "./routes.ts";

export type ChatContext = "document" | "general";

export type ChatTarget =
  | { context: "document"; projectId: string; paperId: string }
  | { context: "general" };

/**
 * The remount key, and the reason it exists.
 *
 * The chat surface is keyed on this string, so a different document mounts a
 * different set of conversations — which loads that thread's history and, via
 * the unmount cleanup, aborts anything still streaming into the old view.
 */
export function scopeKey(target: ChatTarget): string {
  if (target.context === "general") return "general";
  return `document:${target.projectId}:${target.paperId}`;
}

/** How a context is named to the reader and to assistive technology. */
export function scopeLabel(context: ChatContext): string {
  return context === "general" ? "Memory" : "Project";
}

/** The reader's `?chat=` value while a document's chat is docked. */
export const CHAT_DOCKED: UrlChatScope = "paper";

/** Whether the address has a conversation docked at all. */
export function chatIsDocked(value: string | null): boolean {
  return value === CHAT_DOCKED;
}

/** The scope every chat request carries, in its query or its body. */
export function chatQuery(target: ChatTarget): Record<string, string> {
  if (target.context === "general") return { scope: "general" };
  return {
    scope: "document",
    project_id: target.projectId,
    paper_id: target.paperId,
  };
}

/** The composer's hints, which take turns in an empty field (`useCyclingHint`); backticked keys are set in the code face. */
export const COMPOSER_HINT = "Hint: toggle Plan mode by pressing `shift+tab`";
export const SIDE_CHAT_HINT = "Hint: press `/side` to toggle side chat for quick questions";
export const MEMORY_PAGE_HINT = "Pick a Memory page below and start a discussion";
/** The floating Composer's: it has no `/side`, so it says what else its field takes. */
export const DOCUMENT_MENTION_HINT = "Hint: type `@` to bring in a document";
export const PAGE_MENTION_HINT = "Hint: type `@` to bring in a Memory page";
export const IMAGE_HINT = "Hint: paste or drop an image to ask about it";
/** What a field with no hints to give says. */
export const COMPOSER_PLACEHOLDER = "Ask Delphi anything";
