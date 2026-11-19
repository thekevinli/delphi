import { shortRelativeTime } from "./dashboard.ts";

/** The Memory chat list's sections, by when a chat was last used. */
export type ChatGroup = "Today" | "This week" | "Earlier";
const GROUPS: ChatGroup[] = ["Today", "This week", "Earlier"];

/** Today, the six days before it, or earlier, in local time. A chat never used yet is today's. */
export function chatGroup(iso: string | undefined, now = new Date()): ChatGroup {
  if (!iso) return "Today";
  const at = Date.parse(iso);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (at >= today.getTime()) return "Today";
  return at >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime() ? "This week" : "Earlier";
}

/** A row's time: minutes or hours today, the weekday this week, the date before that. */
export function chatTime(iso: string, now = new Date()): string {
  const group = chatGroup(iso, now);
  if (group === "Today") return shortRelativeTime(iso, now.getTime());
  return new Date(iso).toLocaleDateString(undefined, group === "This week" ? { weekday: "short" } : { month: "short", day: "numeric" });
}

/** Newest first, by last use and else by creation; a chat never used leads. */
export function newestFirst<T extends { lastEngagedAt?: string; createdAt?: string }>(items: T[]): T[] {
  const when = (item: T) => {
    const at = item.lastEngagedAt ?? item.createdAt;
    return at ? Date.parse(at) : Number.MAX_SAFE_INTEGER;
  };
  return [...items].sort((a, b) => when(b) - when(a));
}

/** Chats newest first under their sections, leaving out any section with none. */
export function groupChats<T extends { lastEngagedAt?: string; createdAt?: string }>(items: T[], now = new Date()): Array<{ label: ChatGroup; items: T[] }> {
  const sorted = newestFirst(items);
  return GROUPS.map(label => ({ label, items: sorted.filter(item => chatGroup(item.lastEngagedAt ?? item.createdAt, now) === label) }))
    .filter(group => group.items.length);
}
