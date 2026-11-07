"use client";

import { useCallback, useSyncExternalStore } from "react";

import { stepPageZoom } from "./page-zoom";

/**
 * Which surface the zoom keys scale.
 *
 * Cmd+plus, minus and zero arrive as one window event (`delphi-page-zoom`),
 * and the reader and a conversation beside it both answer it. The chat takes
 * it while it is expanded over everything, when nothing else on screen
 * zooms, or when the reader last pressed or typed in it; otherwise it is the
 * reader's: the document, or its digest while that is shown.
 */
const CHAT = ".chat-surface";

/**
 * Whether the reader last pressed or typed in a conversation, decided as it
 * happens: a press that rebuilds the chat (a scope switch remounts it) leaves
 * no element behind to ask afterwards.
 */
let inChat = false;
if (typeof window !== "undefined") {
  const note = (event: Event) => { inChat = event.target instanceof Element && Boolean(event.target.closest(CHAT)); };
  window.addEventListener("pointerdown", note, true);
  window.addEventListener("focusin", note, true);
}

export function chatOwnsZoom(): boolean {
  if (typeof document === "undefined" || !document.querySelector(CHAT)) return false;
  if (document.querySelector(".kb-chat-rail.is-fullscreen") || !document.querySelector(".reader-stage")) return true;
  // A press inside a frame (the web page, or an artifact in the chat) never
  // reaches this document, but the frame takes the focus, and a press anywhere
  // here takes it back out.
  const active = document.activeElement;
  return active instanceof HTMLIFrameElement ? Boolean(active.closest(CHAT)) : inChat;
}

/** Each key's zoom as last read or set; storage is read once, and may refuse. */
const zooms = new Map<string, number>();
const listeners = new Set<() => void>();

function storedZoom(key: string): number {
  let value = zooms.get(key);
  if (value === undefined) {
    try { value = Number(localStorage.getItem(key)); } catch { value = 100; }
    // Only one of the zoom steps; nothing stored, or anything else, is 100%.
    if (stepPageZoom(value, 0) !== value) value = 100;
    zooms.set(key, value);
  }
  return value;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * A text zoom the reader keeps, remembered across launches: one for every
 * digest, and one for every conversation. `step` takes
 * the zoom event's direction, 0 being back to 100%.
 */
export function useStoredZoom(key: string): [number, (direction: number) => void] {
  const percent = useSyncExternalStore(subscribe, () => storedZoom(key), () => 100);
  const step = useCallback((direction: number) => {
    const next = direction === 0 ? 100 : stepPageZoom(storedZoom(key), direction);
    zooms.set(key, next);
    try { localStorage.setItem(key, String(next)); } catch { /* A preference only. */ }
    listeners.forEach((listener) => listener());
  }, [key]);
  return [percent, step];
}

/** The event's direction, or null for anything else dispatched under its name. */
export function zoomDirection(event: Event): number | null {
  const direction = (event as CustomEvent<number>).detail;
  return direction === 0 || direction === 1 || direction === -1 ? direction : null;
}
