import type { DashboardConversation } from "./api.ts";

/** Recent threads shown on the Dashboard: enough to resume, few enough that
 *  the column stands level with the Memory panel beside it. */
export const DASHBOARD_THREAD_LIMIT = 4;

/**
 * What a thread was about, after its project in the thread's "project >
 * context" line. The Dashboard carries no message text, so this names the
 * thing asked of — the document, the project, or the whole memory — rather
 * than inventing a summary. The project is already named beside it, so a
 * project chat does not name it twice.
 */
export function conversationContext(conversation: Pick<DashboardConversation, "kind" | "paperTitle">): string {
  if (conversation.kind === "memory_chat") return "Across your memory";
  if (conversation.kind === "project_chat") return "Across the project";
  return conversation.paperTitle || "A document";
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

/** The days a list of chats is grouped under, newest first. */
export const CONVERSATION_DAYS = ["Today", "Yesterday", "This week", "Earlier"] as const;
export type ConversationDay = (typeof CONVERSATION_DAYS)[number];

/** Which of `CONVERSATION_DAYS` a moment falls on, by the reader's calendar day. */
export function conversationDay(iso: string, now = Date.now()): ConversationDay {
  const midnight = (time: number) => {
    const date = new Date(time);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  };
  // Rounded, not floored: a day with a clock change is 23 or 25 hours long.
  const days = Math.round((midnight(now) - midnight(Date.parse(iso))) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  return "Earlier";
}

/**
 * Items under the day each falls on, in `CONVERSATION_DAYS` order, keeping
 * their own order within a day and leaving out days with nothing in them.
 * The day stands in for a time on every row: a list of chats is read for what
 * they were about, and "9h ago" beside each one was noise.
 */
export function groupByDay<T>(items: T[], at: (item: T) => string, now = Date.now()): Array<{ day: ConversationDay; items: T[] }> {
  const groups = new Map<ConversationDay, T[]>();
  for (const item of items) {
    const day = conversationDay(at(item), now);
    groups.set(day, [...(groups.get(day) ?? []), item]);
  }
  return CONVERSATION_DAYS.filter((day) => groups.has(day)).map((day) => ({ day, items: groups.get(day)! }));
}

/** `relativeTime` for a corner: "5m", "6h", "1d", with no "ago". */
export function shortRelativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d` : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function conversationDestination(username: string, item: DashboardConversation): string {
  // A Memory chat belongs to the account, not to a page: it opens beside the
  // map, the same place every time, not on whichever page the wiki opens on.
  if (item.kind === "memory_chat") return `/memory/graph?ask=1&conversation=${encodeURIComponent(item.id)}`;
  const paper = item.kind === "document_chat" ? item.paperSlug : item.lastDocumentSlug;
  if (!item.projectSlug || !paper) return "/reader";
  const base = `/@${username}/${item.projectSlug}/${paper}`;
  // Always a `?chat=`: the row is a *conversation*, so following it has to dock
  // one. Without the parameter a document chat opened its document with the
  // panel shut, which reads as the link having done nothing.
  return `${base}?chat=${item.kind === "project_chat" ? "project" : "paper"}&conversation=${encodeURIComponent(item.id)}`;
}

export function horizontalWheelDelta(deltaX: number, deltaY: number, shiftKey = false): number {
  // A vertical-dominant wheel used to be remapped onto the carousel, which is
  // how a mouse-wheel over Projects panned the cards while the page also
  // moved (React's onWheel is passive, so preventDefault never owned the
  // gesture). Only a predominant horizontal flick — or Shift+wheel, the usual
  // mouse spelling of one — may move the rail.
  if (shiftKey) return deltaX || deltaY;
  return Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : 0;
}

export function compactSourceLabel(label: string, limit = 24): string {
  if (label.length <= limit) return label;
  return `${label.slice(0, Math.max(0, limit - 3))}...`;
}

/**
 * A project shelf shows at most this many covers, in the order the server
 * sends them; the project itself holds the rest. Ten is a full sideways
 * scroll, not a library.
 */
export const SHELF_DOCUMENT_LIMIT = 10;

type ShelfCaptionSource = {
  kind?: string;
  filename: string;
  title: string;
  url?: string | null;
  pages: number;
};

/**
 * The one muted line under a cover: where it came from and how long it is,
 * because the title itself only appears on hover. An arXiv id beats a host,
 * which beats "Uploaded".
 */
export function shelfCaption(document: ShelfCaptionSource): string {
  const arxivId = `${document.url ?? ""} ${document.filename} ${document.title}`
    .match(/\b(\d{4}\.\d{4,5})(?:v\d+)?\b/i)?.[1];
  let host = "";
  if (document.url) {
    try {
      host = new URL(document.url).hostname.replace(/^www\./, "");
    } catch {
      host = "";
    }
  }
  const pdf = document.kind !== "web" || document.filename.toLowerCase().endsWith(".pdf");
  const source = arxivId ?? (host || (document.kind === "web" ? "Saved webpage" : "Uploaded"));
  const size = pdf
    ? `${document.pages} pp`
    : `${document.pages} ${document.pages === 1 ? "section" : "sections"}`;
  return `${source} · ${size}`;
}
