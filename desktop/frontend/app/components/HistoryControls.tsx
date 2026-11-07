"use client";

import { useSyncExternalStore } from "react";

// Electron's Navigation API owns the top-level history, including router
// pushState/replaceState calls and reloads, without counting reader iframe visits.
// Keep this narrow type until our pinned TypeScript DOM library includes it.
interface PageNavigation extends EventTarget {
  canGoBack: boolean;
  canGoForward: boolean;
  back(): { committed: Promise<unknown>; finished: Promise<unknown> };
  forward(): { committed: Promise<unknown>; finished: Promise<unknown> };
}

function navigation(): PageNavigation | undefined {
  return (window as Window & { navigation?: PageNavigation }).navigation;
}

function subscribe(update: () => void) {
  const history = navigation();
  history?.addEventListener("currententrychange", update);
  window.addEventListener("pageshow", update);
  return () => {
    history?.removeEventListener("currententrychange", update);
    window.removeEventListener("pageshow", update);
  };
}

function snapshot() {
  const history = navigation();
  return (history?.canGoBack ? 1 : 0) | (history?.canGoForward ? 2 : 0);
}

function go(direction: "back" | "forward") {
  const history = navigation();
  if (!history || !(direction === "back" ? history.canGoBack : history.canGoForward)) return;
  const result = history[direction]();
  // A second click or another route can supersede a pending traversal.
  void Promise.allSettled([result.committed, result.finished]);
}

export function HistoryControls() {
  const available = useSyncExternalStore(subscribe, snapshot, () => 0);
  return (
    <nav className="history-controls" aria-label="Page history">
      <button type="button" aria-label="Go back" title="Go back" disabled={!(available & 1)} onClick={() => go("back")}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m10 3-5 5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button type="button" aria-label="Go forward" title="Go forward" disabled={!(available & 2)} onClick={() => go("forward")}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </nav>
  );
}
