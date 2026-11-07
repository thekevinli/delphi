/** In-memory conversation ownership survives view and route unmounts. No secrets
 * or transcripts are persisted to browser storage. A reload reads the server. */
export type ConversationSummary = {
  id: string;
  generation: number;
  title: string;
  empty: boolean;
  createdAt?: string;
  lastEngagedAt?: string;
  personaId?: string | null;
  manualTitle?: boolean;
  provisional?: boolean;
};
export type ConversationCatalog = { items: ConversationSummary[]; defaultId: string | null; limit: number };
export type ConversationSession = {
  values: Map<string, unknown>;
  cells: Map<string, { current: unknown }>;
  listeners: Set<() => void>;
};
const sessions = new Map<string, ConversationSession>();
const statusListeners = new Set<() => void>();
let revision = 0;

export const conversationKey = (item: Pick<ConversationSummary, "id" | "generation">) => `${item.id}:${item.generation}`;
export function sessionFor(key: string): ConversationSession {
  let session = sessions.get(key);
  if (!session) {
    session = { values: new Map(), cells: new Map(), listeners: new Set() };
    sessions.set(key, session);
  }
  return session;
}
/** The session a conversation already has, without starting one. */
export const existingSession = (key: string) => sessions.get(key);
/** Whether this tab already holds turns the server's listing may not show yet. */
function sessionHasMessages(key: string): boolean {
  return ((sessions.get(key)?.values.get("messages") as unknown[] | undefined)?.length ?? 0) > 0;
}
/** Nothing said in it yet: a draft, or a stored chat still empty. A listing
 * read before its first answer landed still says "empty", so the session decides. */
export const isBlank = (item: ConversationSummary) => Boolean(item.provisional || (item.empty && !sessionHasMessages(conversationKey(item))));
export function adoptSession(from: string, to: string) {
  if (from !== to) { sessions.set(to, sessionFor(from)); sessions.delete(from); }
}
export function sessionCell<T>(session: ConversationSession, name: string, initial: T): { current: T } {
  if (!session.cells.has(name)) session.cells.set(name, { current: initial });
  return session.cells.get(name) as { current: T };
}
export function publishSession(session: ConversationSession) {
  for (const listener of session.listeners) listener();
  revision++;
  for (const listener of statusListeners) listener();
}
export function disposeSession(key: string) {
  const session = sessions.get(key);
  if (!session) return;
  (session.cells.get("controller")?.current as AbortController | null)?.abort();
  (session.cells.get("sideController")?.current as AbortController | null)?.abort();
  for (const item of (session.values.get("composerImages") ?? []) as { previewUrl?: string; file?: File }[]) {
    if (item.file && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }
  sessions.delete(key);
  publishSession(session);
}
export function clearConversationSessions() {
  for (const key of [...sessions.keys()]) disposeSession(key);
}
export const subscribeConversationStatus = (listener: () => void) => {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
};
export const conversationStatusVersion = () => revision;
export function conversationStatus(item: ConversationSummary) {
  const session = sessions.get(conversationKey(item));
  return session?.values.get("streaming") ? "Answering" : session?.values.get("failed") ? "Answer failed" : "";
}
