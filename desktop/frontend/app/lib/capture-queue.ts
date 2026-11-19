/**
 * Reading whole the web pages an add read at their first window.
 *
 * A windowed page (a long public Notion page) is opened as soon as its first
 * window is built, and the server queues a `capture` job to read the rest
 * (`routers/captures.py`). Like Memory's queue, the server owns the jobs and a
 * foreground window is what runs them, so when the window asks is the whole
 * schedule: after an add, at launch, when the window comes back into view,
 * and again a minute later while the server says one is still owed (a claim
 * a closed app left behind frees when its lease runs out).
 *
 * One worker, never three: a capture is a browser page drawing a whole long
 * document, which is memory, not a model call. It needs no model and no
 * Memory, so nothing here is gated on either.
 *
 * JSX-free so `node --test --experimental-strip-types` can load it.
 */

import { API_BASE, type Paper } from "./api.ts";
import { readSseStream } from "./sse.ts";

/** A capture that finished: the paper as republished, or null if it went meanwhile. */
export type Captured = { projectId: string; paperId: string; paper: Paper | null };

/** A runaway guard on one drain, not a queue length. */
const DRAIN_CEILING = 50;
/** How long to wait before asking again for a capture the server still owes. */
const CAPTURE_RETRY_MS = 60 * 1000;

let activeDrain: Promise<void> | null = null;
/** Bumped by every request, so a drain that ends can tell it was asked again meanwhile. */
let asked = 0;
let retry: ReturnType<typeof setTimeout> | null = null;

const capturedListeners = new Set<(captured: Captured) => void>();

/** Called once per capture settled, from whichever drain settled it: read whole, or given up on its first window. */
export function onCaptured(listener: (captured: Captured) => void): () => void {
  capturedListeners.add(listener);
  return () => {
    capturedListeners.delete(listener);
  };
}

function announce(captured: Captured): void {
  // A listener is a view refreshing itself; one that throws must not stop the queue.
  for (const listener of capturedListeners) {
    try {
      listener(captured);
    } catch {
      // ignored
    }
  }
}

/** Ask again once a capture still owed may be due, or the backend is back. One timer at a time. */
function askLater(fetcher: typeof fetch, retryMs: number): void {
  if (retry) return;
  retry = setTimeout(() => {
    retry = null;
    void drainCaptures(fetcher, retryMs).catch(() => undefined);
  }, retryMs);
}

/**
 * Run due captures until none is left.
 *
 * Single-flight: a request while a drain runs is noted, and the drain claims
 * once more before it ends, so work queued just after its last empty claim is
 * not left for the next launch.
 */
export function drainCaptures(fetcher: typeof fetch = fetch, retryMs = CAPTURE_RETRY_MS): Promise<void> {
  asked += 1;
  if (activeDrain) return activeDrain;
  activeDrain = (async () => {
    for (let requests = 0; requests < DRAIN_CEILING; requests += 1) {
      const claimedAt = asked;
      const response = await fetcher(`${API_BASE}/api/captures/drain`, { method: "POST", credentials: "include" });
      if (!response.ok || !response.body) throw new Error(`Reading the whole page failed (${response.status})`);
      let terminal: Record<string, unknown> | null = null;
      for await (const event of readSseStream(response.body)) {
        if (event.type === "done" || event.type === "error") terminal = event;
      }
      if ((terminal?.type === "done" && terminal.claimed) || (terminal?.type === "error" && terminal.terminal)) {
        announce({
          projectId: String(terminal.projectId ?? ""),
          paperId: String(terminal.paperId ?? ""),
          paper: (terminal.paper as Paper | null | undefined) ?? null,
        });
        continue;
      }
      // A job that will retry has its time on the server; the next claim moves past it.
      if (terminal?.type === "error" || !terminal) continue;
      if (asked !== claimedAt) continue;
      // Nothing due, and still something owed: a claim a closed app left
      // behind, or a capture backing off. Ask again when it may be due.
      if (Number(terminal.remaining ?? 0) > 0) askLater(fetcher, retryMs);
      break;
    }
  })().catch((reason) => {
    // The backend went away mid-capture (a connection switch restarts it, and
    // hands the claim back): ask again once it is back.
    askLater(fetcher, retryMs);
    throw reason;
  }).finally(() => {
    activeDrain = null;
  });
  return activeDrain;
}

/** Ask for the queue to be run, because an add just queued a capture. Never throws. */
export function requestCaptures(fetcher: typeof fetch = fetch): void {
  void drainCaptures(fetcher).catch(() => undefined);
}

/** What the pump needs from the browser, so a test can drive it. */
export type CapturePumpHost = {
  addEventListener: (type: string, handler: () => void) => void;
  isVisible: () => boolean;
};

function browserHost(): CapturePumpHost | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return {
    addEventListener: (type, handler) => {
      if (type === "visibilitychange") document.addEventListener(type, handler);
      else window.addEventListener(type, handler);
    },
    isVisible: () => document.visibilityState === "visible",
  };
}

let started = false;

/**
 * Run whatever a paused or quit app left owed, now and whenever the window
 * comes back into view. Idempotent, and never stopped.
 */
export function startCaptures(host: CapturePumpHost | null = browserHost(), fetcher: typeof fetch = fetch): void {
  if (started || !host) return;
  started = true;
  const tick = () => {
    if (host.isVisible()) requestCaptures(fetcher);
  };
  host.addEventListener("visibilitychange", tick);
  host.addEventListener("focus", tick);
  tick();
}
