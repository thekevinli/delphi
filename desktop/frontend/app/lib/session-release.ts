/**
 * Telling the server the reader left a session.
 *
 * Memory files what a reader did beside a document (its chats in every tab,
 * and the notes on it) or in one Memory chat once, when that session ends.
 * Until then the server holds the session's job: every answer and every note
 * change pushes its wait forward. The session has a beginning the server can
 * see and an end only the window can, so the window reports the end here.
 *
 * This module decides *what* to report and sends it. `readerIsBeside` in
 * `memory-maintenance.ts` holds where the reader is and runs the queue
 * afterwards.
 *
 * JSX-free so `node --test --experimental-strip-types` can load it.
 */

import { API_BASE } from "./api.ts";

/** The body of `POST /api/memory/sessions/release`; none releases every waiting session. */
export type SessionRelease =
  | { paperId: string; projectId: string }
  | { conversationId: string }
  | null;

/** What the window sends when it is launched: no session is open yet. */
export const EVERY_SESSION: SessionRelease = null;

/**
 * What the reader is beside, as far as a session is concerned.
 *
 * `document` is the one open in the reader, and `chat` whether its own chat is
 * docked beside it: the document's session takes in both its chats and its
 * notes, so it is open while either can still add to it. `conversationId` is a
 * chat that belongs to no document, wherever it is on screen.
 */
export type Beside = {
  document: { paperId: string; projectId: string; chat: boolean } | null;
  conversationId: string | null;
};

export const NOWHERE: Beside = { document: null, conversationId: null };

// The server's own patterns: an id it would refuse is one it holds no job for.
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,32}$/;
const CONVERSATION_ID = /^[a-f0-9]{32}$/;

/**
 * The sessions that ended when the reader moved from `previous` to `next`.
 *
 * A document's session ends when another document takes its place, when the
 * reader leaves it for another route, or when its chat is closed. Moving
 * between the chats beside one document ends nothing, and neither does
 * opening its chat. A chat with no document ends when it leaves the screen. A
 * chat not yet created has no id the server knows, and nothing to file.
 */
export function releasesFor(previous: Beside, next: Beside): Exclude<SessionRelease, null>[] {
  const releases: Exclude<SessionRelease, null>[] = [];
  const left = previous.document;
  if (left && DOCUMENT_ID.test(left.paperId) && DOCUMENT_ID.test(left.projectId)) {
    const stayed = next.document?.paperId === left.paperId;
    if (!stayed || (left.chat && !next.document?.chat)) {
      releases.push({ paperId: left.paperId, projectId: left.projectId });
    }
  }
  const chat = previous.conversationId;
  if (chat && chat !== next.conversationId && CONVERSATION_ID.test(chat)) {
    releases.push({ conversationId: chat });
  }
  return releases;
}

/**
 * Report one ended session, and answer how many jobs it released.
 *
 * Nothing waits on this and nothing depends on it arriving: a report that is
 * lost leaves the job to the server's idle limit and to the next launch. So it
 * never throws, and a failure is a line in the console and a zero.
 */
export async function sendSessionRelease(
  release: SessionRelease,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  try {
    const response = await fetcher(`${API_BASE}/api/memory/sessions/release`, {
      method: "POST",
      credentials: "include",
      ...(release
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(release) }
        : {}),
    });
    if (!response.ok) throw new Error(`Releasing a session failed (${response.status})`);
    const answer = (await response.json()) as { released?: unknown };
    return typeof answer.released === "number" ? answer.released : 0;
  } catch (reason) {
    console.warn("Session not released", reason);
    return 0;
  }
}
