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
 * A document chat names its project and document; a Memory chat belongs to no
 * project at all. Returning the parts rather than a joined string leaves the
 * separator to CSS, which is where a middot belongs.
 */
export function conversationSource(item: DashboardConversation): string[] {
  if (item.kind === "memory_chat") return ["Memory"];
  const parts = [item.projectName || "Library"];
  if (item.paperTitle) parts.push(item.paperTitle);
  return parts;
}
