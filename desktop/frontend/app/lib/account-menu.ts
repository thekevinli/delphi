/**
 * What the account menu and the settings sheet need to decide, minus the JSX.
 *
 * Kept JSX-free so `node --test --experimental-strip-types` can run over it
 * directly; explicit `.ts` extensions for the same reason.
 */

// Explicit extension so type-stripping can resolve these modules; see the note
// in tsconfig.json.
import type { DashboardConversation } from "./api.ts";
/**
 * The left half of a chat row: which collection, and which document.
 *
 * A conversation is listed by what it is *about*, and the three scopes are
 * about different things — a document chat names both, a project chat names
 * only the project it ranges over, and the wiki chat belongs to no project at
 * all. Returning the parts rather than a joined string leaves the separator to
 * CSS, which is where a middot belongs.
 */
export function conversationSource(item: DashboardConversation): string[] {
  if (item.kind === "memory_chat") return ["Memory"];
  const parts = [item.projectName || "Library"];
  if (item.kind === "document_chat" && item.paperTitle) parts.push(item.paperTitle);
  return parts;
}
