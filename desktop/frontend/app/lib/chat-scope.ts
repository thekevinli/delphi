/**
 * Which evidence a question is asked against, and everything derived from it.
 *
 * Delphi has one chat with two contexts, and this module is the whole of the
 * difference on the client. A **Project** question is asked beside a document:
 * it attaches that document whole and every other active document in the
 * project as its digest. A **Memory** question is asked of the account's own
 * wiki, and beside a document it also names that document. They are two
 * conversations, not two products: each keeps its own thread, and switching
 * between them swaps which thread is on screen rather than carrying turns
 * across (the server treats conversation scope as one authority).
 *
 * A Project conversation belongs to the document it was started beside, which
 * is why its context is spelled `"document"` here and on the wire: that is the
 * thread's identity, and the name the reader sees is only its label. There
 * used to be a third, project-wide thread that attached digests and no
 * document; it is no longer offered, and its conversations stay stored.
 *
 * Two spellings meet here and must not be conflated:
 *
 * - the **URL** says `?chat=general` for Memory and `?chat=paper` otherwise,
 *   the historical spelling of "the document this path already names". An old
 *   `?chat=project` link opens the same conversation.
 * - the **API** says `scope: "document" | "general"`.
 *
 * `chatParam` and `contextFromParam` are the only places those two meet, which
 * is what stops a third spelling appearing the next time a surface needs one.
 */

import type { ChatScope as UrlChatScope } from "./routes.ts";

export type ChatContext = "document" | "general";

/**
 * `open` is the document beside a Memory conversation, and `page` the Memory
 * page beside one, when there is either. Both are context for a question and
 * never identity: Memory stays one account-wide set of threads wherever it is
 * asked from, so `scopeKey` and `chatQuery` ignore them and only
 * `chatRequestScope` sends them.
 */
export type ChatTarget =
  | { context: "document"; projectId: string; paperId: string }
  | {
      context: "general";
      open?: { projectId: string; paperId: string };
      page?: string;
    };

/**
 * The remount key, and the reason it exists.
 *
 * The chat surface is keyed on this string, so changing context unmounts one
 * conversation and mounts another — which loads that thread's history and, via
 * the unmount cleanup, aborts anything still streaming. Holding the context in
 * component state instead would let a stream started under Document finish by
 * appending into whatever thread happened to be on screen when it landed.
 */
export function scopeKey(target: ChatTarget): string {
  if (target.context === "general") return "general";
  return `document:${target.projectId}:${target.paperId}`;
}

/** What the Context pill reads: how wide the question is. */
export function scopeLabel(context: ChatContext): string {
  return context === "general" ? "Memory" : "Project";
}

/**
 * What a shell opens with.
 *
 * The reader defaults to the Project context whenever a document is open,
 * because that is the question the reader is most likely asking. With nothing
 * open — an empty project, or the instant before the reader lands on its
 * first document — and everywhere outside the reader, there is no document to
 * mean, so Memory is the only honest default.
 */
export function defaultContext(options: {
  inReader: boolean;
  hasPaper: boolean;
}): ChatContext {
  return options.inReader && options.hasPaper ? "document" : "general";
}

/** Which contexts a shell may offer. Project needs a document open to mean. */
export function availableContexts(options: {
  inReader: boolean;
  hasPaper: boolean;
}): ChatContext[] {
  return options.inReader && options.hasPaper
    ? ["document", "general"]
    : ["general"];
}

/**
 * The `?chat=` value that docks this context.
 *
 * Always a value, never null: the parameter's job is to say a conversation is
 * *open*, and the document context needs to be able to say that as much as
 * Memory does. Absence of the parameter means no conversation, which is a
 * different fact and is read by `chatIsDocked`.
 */
export function chatParam(context: ChatContext): UrlChatScope {
  return context === "general" ? "general" : "paper";
}

/** Whether the address has a conversation docked at all. */
export function chatIsDocked(value: string | null): boolean {
  return value === "paper" || value === "project" || value === "general";
}

/**
 * Read a context back off the address.
 *
 * An unknown or absent value — and the retired `project` — is the Project
 * conversation when a document is open and Memory when nothing is. Never a
 * throw, because this parses a string a stranger can put in a link.
 */
export function contextFromParam(
  value: string | null,
  options: { hasPaper: boolean },
): ChatContext {
  if (value === "general") return "general";
  return options.hasPaper ? "document" : "general";
}

/** The query string every scoped chat request carries. */
export function chatQuery(target: ChatTarget): Record<string, string> {
  if (target.context === "general") return { scope: "general" };
  return {
    scope: "document",
    project_id: target.projectId,
    paper_id: target.paperId,
  };
}

/**
 * The scope fields of a chat request body.
 *
 * A Memory question asked beside a document names it, as a project and a paper
 * together or not at all — the server refuses one without the other. It reads
 * that document's digest for the one turn and files the turn in the same
 * account-wide thread as any other Memory question. Asked beside a Memory
 * page instead, it names that page, which the server starts its lookup from.
 */
export function chatRequestScope(target: ChatTarget): {
  scope: ChatContext;
  project_id?: string;
  paper_id?: string;
  page_slug?: string;
} {
  if (target.context === "general") {
    const open = target.open;
    if (open?.projectId && open.paperId) {
      return { scope: "general", project_id: open.projectId, paper_id: open.paperId };
    }
    return target.page ? { scope: "general", page_slug: target.page } : { scope: "general" };
  }
  return {
    scope: "document",
    project_id: target.projectId,
    paper_id: target.paperId,
  };
}

/**
 * What the composer says before anything is typed.
 *
 * One sentence for every scope, deliberately. The prompt used to name the
 * scope — "Ask about this document…", "Ask your Memory…" — which put
 * the same fact in two places a few pixels apart: the Context pill sits
 * directly above the field and is both the statement of scope *and* the
 * control that changes it. Restating it in grey text underneath added nothing
 * to read and rewrote itself every time the pill was touched, so the field
 * flickered during a decision that was being made above it.
 */
export const COMPOSER_PLACEHOLDER = "Ask Delphi anything (press ⇧ ⇥ to toggle Plan mode)";
/** The Composer's prompt teaches the shortcut; the backticked keys are set in the code face. */
export const COMPOSER_HINT = "Hint: toggle Plan mode by pressing `shift+tab`";
/** Until the first answer of an app session, the chat teaches its side chat instead. */
export const SIDE_CHAT_HINT = "Hint: press `/side` to toggle side chat for quick questions";
/** The docked column is too narrow for the shortcut hint; it keeps the prompt alone. */
export const COMPOSER_PLACEHOLDER_SHORT = "Ask Delphi anything";
