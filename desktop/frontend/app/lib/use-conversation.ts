"use client";
import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
import { publishSession, type ConversationSession } from "./conversation-session.ts";

export function useConversationField<T>(session: ConversationSession, name: string, initial: T | (() => T)) {
  if (!session.values.has(name)) session.values.set(name, typeof initial === "function" ? (initial as () => T)() : initial);
  const subscribe = useCallback((listener: () => void) => {
    session.listeners.add(listener);
    return () => { session.listeners.delete(listener); };
  }, [session]);
  const snapshot = useCallback(() => session.values.get(name) as T, [session, name]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const set = useCallback((next: SetStateAction<T>) => {
    const previous = session.values.get(name) as T;
    const value = typeof next === "function" ? (next as (value: T) => T)(previous) : next;
    if (!Object.is(previous, value)) { session.values.set(name, value); publishSession(session); }
  }, [session, name]);
  return [value, set] as const;
}
