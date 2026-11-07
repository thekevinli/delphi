/**
 * A side chat beside a conversation (`/side`): its widths, its command and
 * what one side question sends.
 *
 * The side chat is never stored. Its turns live in the conversation's
 * in-memory session (`conversation-session.ts`), keyed by `id:generation`, so
 * clearing the chat (a new generation), closing its tab or quitting drops
 * them. The server (`POST /api/chat/side`) re-reads the main thread on every
 * question and writes nothing.
 *
 * JSX-free so `node --test --experimental-strip-types` can load it directly.
 */
import { rightColumnScale } from "./right-column.ts";
import { publishSession, sessionCell, type ConversationSession } from "./conversation-session.ts";

/**
 * Laptop widths, each scaled with the window like every right-column width.
 * `open` is what the docked column grows by when a side chat opens, and the
 * side's own opening width; `expanded` is the same for the expanded card.
 * The side may be dragged down to `min`, and the main chat keeps `mainMin`.
 */
export const SIDE_CHAT = { open: 360, min: 280, mainMin: 340, expanded: 420 } as const;

/** Earlier exchanges one side question carries, and their text in all; the server refuses more. */
export const SIDE_TURNS_SENT = 20;
export const SIDE_CHARS_SENT = 200_000;

/** The one command the composer offers. */
export const SIDE_COMMAND = {
  name: "/side",
  hint: "Temporary, shares this chat’s context",
} as const;

/** How much a side chat adds to a column, docked or expanded. */
export function sideChatExtra(viewport: number, surface: "docked" | "expanded" = "docked"): number {
  return Math.round((surface === "expanded" ? SIDE_CHAT.expanded : SIDE_CHAT.open) * rightColumnScale(viewport));
}

/**
 * The docked column while a side chat is open: the reader's own column plus
 * the side's, or the width the reader dragged it to, under the column's
 * ceiling plus the side's, and never wider than the window can give (`room`).
 * The reader's own width is untouched, so closing the side chat restores it.
 */
export function sideColumnWidth({ column, dragged, ceiling, room, floor, viewport }: {
  column: number;
  dragged: number | null;
  ceiling: number;
  room: number;
  floor: number;
  viewport: number;
}): number {
  const extra = sideChatExtra(viewport);
  return Math.round(Math.max(floor, Math.min(dragged ?? column + extra, ceiling + extra, room)));
}

/** The widest a docked column may be dragged while a side chat is open. */
export const sideColumnCeiling = (ceiling: number, viewport: number) => ceiling + sideChatExtra(viewport);

/**
 * How a panel `panel` px wide shares itself with its side chat.
 *
 * The side opens at its surface's width (or the one the reader dragged) and
 * stays between `min` and what leaves the main chat `mainMin`. A panel too
 * narrow for both lays the side chat over the main one instead, leaving a
 * strip of the main chat in view.
 */
export function sideSplit(panel: number, dragged: number | null, viewport: number, surface: "docked" | "expanded"): {
  side: number;
  overlay: boolean;
} {
  const scale = rightColumnScale(viewport);
  const min = Math.round(SIDE_CHAT.min * scale);
  const mainMin = Math.round(SIDE_CHAT.mainMin * scale);
  const opening = sideChatExtra(viewport, surface);
  if (panel < min + mainMin) {
    return { side: Math.round(Math.max(Math.min(min, panel), Math.min(opening, panel - 48))), overlay: true };
  }
  return { side: Math.round(Math.min(Math.max(dragged ?? opening, min), panel - mainMin)), overlay: false };
}

/** The bounds a side chat may be dragged between in a panel `panel` px wide. */
export function sideBounds(panel: number, viewport: number): { min: number; max: number } {
  const scale = rightColumnScale(viewport);
  const min = Math.round(SIDE_CHAT.min * scale);
  return { min, max: Math.max(min, Math.round(panel - SIDE_CHAT.mainMin * scale)) };
}

/**
 * What the composer's draft says about `/side`.
 *
 * `menu` is a draft that is only the start of the command, which shows the
 * command menu. `open` is the whole command, alone or followed by a question
 * to ask straight away. Anything else, `/usr/bin` included, is an ordinary
 * message.
 */
export function sideCommand(draft: string): { menu: boolean; open: null | { question: string } } {
  const text = draft.replace(/ /g, " ");
  const word = /^\/(\S*)$/.exec(text.trimEnd());
  const menu = Boolean(word && SIDE_COMMAND.name.startsWith(`/${word[1]}`) && !/\s$/.test(text));
  const whole = /^\/side(?:\s+([\s\S]*))?$/.exec(text.trim());
  return { menu, open: whole ? { question: (whole[1] ?? "").trim() } : null };
}

/** One side exchange as the side chat holds it. */
export type SideTurn = {
  /** Which request owns the turn, so a late failure never lands on a newer one. */
  id?: number;
  /** When it was asked, the clock its trace counts from. */
  askedAt?: number;
  question: string;
  answer: string;
  /** The live or finished record of how the answer was reached. */
  trace?: unknown;
  sources?: unknown;
  /** Set when the answer failed or was stopped; such a turn is never sent back. */
  error?: string;
  cancelled?: boolean;
  incomplete?: unknown;
  pending?: boolean;
};

/**
 * The earlier exchanges a side question sends: finished ones, most recent
 * last, dropping the oldest once they outgrow what the server takes.
 */
export function sideTurnsForRequest(turns: SideTurn[]): { question: string; answer: string }[] {
  const sent: { question: string; answer: string }[] = [];
  let chars = 0;
  for (const { question, answer, pending, error, cancelled } of [...turns].reverse()) {
    if (pending || error || cancelled || !answer.trim()) continue;
    chars += question.length + answer.length;
    if (sent.length === SIDE_TURNS_SENT || chars > SIDE_CHARS_SENT) break;
    sent.unshift({ question, answer });
  }
  return sent;
}

/** The request body of one side question. */
export function sideRequestBody({ scope, conversation, prompt, turns, model, effort, personaId }: {
  scope: Record<string, string | undefined>;
  conversation: { id: string; generation: number };
  prompt: string;
  turns: SideTurn[];
  model: string;
  effort: string;
  personaId?: string | null;
}) {
  return {
    ...scope,
    conversation_id: conversation.id,
    generation: conversation.generation,
    prompt,
    side_turns: sideTurnsForRequest(turns),
    model,
    reasoning_effort: effort,
    ...(personaId ? { persona_id: personaId } : {}),
  };
}

/** Open the side chat on `session`, asking `question` once it is on screen. */
export function openSideChat(session: ConversationSession, question = "") {
  session.values.set("sideOpen", true);
  if (question) session.values.set("sideQueued", question);
  publishSession(session);
}

/** Close it: stop any answer and forget every side turn. */
export function closeSideChat(session: ConversationSession) {
  sessionCell<AbortController | null>(session, "sideController", null).current?.abort();
  session.values.set("sideOpen", false);
  session.values.set("sideTurns", []);
  session.values.set("sideDraft", "");
  session.values.set("sideQueued", "");
  publishSession(session);
}
