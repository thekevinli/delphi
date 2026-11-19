/**
 * Draining Memory's durable work queue.
 *
 * The server owns the jobs; a foreground tab is only the thing that runs them,
 * because Cloud Run does not reliably run detached work after a response
 * closes. That makes *when the browser asks* the whole scheduling story — and
 * for a long time the answer was "on a shell mount, and after a chat answer",
 * with no interval and no visibility handler anywhere in the app. Nothing
 * re-drained. A job that failed and backed off for thirty minutes waited for
 * the reader to navigate somewhere before it was retried, so the wiki only
 * ever caught up when somebody pressed Update.
 *
 * Three entry points, separate on purpose: `drainMemoryMaintenance` runs the
 * queue *now*, `requestMemoryMaintenance` is what a mutation calls when it
 * has just created work, and `startMemoryMaintenance` is the pump that keeps
 * asking for the life of the session.
 *
 * A session's job is the one kind of work the queue holds back, until the
 * reader leaves what they were beside. `readerIsBeside` is where the window
 * says where the reader is, and the pump's start is where it says that no
 * session is open yet.
 */

import { API_BASE } from "./api.ts";
import { readSseStream, type SseEvent } from "./sse.ts";
import { filingStepIndex } from "./filing-progress.ts";
import {
  EVERY_SESSION,
  NOWHERE,
  releasesFor,
  sendSessionRelease,
  type Beside,
  type SessionRelease,
} from "./session-release.ts";

export type MaintenanceDrainResult = {
  processed: number;
  /** Jobs that reported their own failure; the drain carried on past them. */
  failed: number;
  last?: SseEvent;
};

/**
 * How many jobs run at once.
 *
 * Purely a client-side decision: `claim_memory_job` leases under
 * `FOR UPDATE SKIP LOCKED` on Postgres and under a lock on the filesystem
 * backend, so concurrent claims return distinct jobs by construction. Three is
 * what the Update pass already used and what `project_digest_events` settled on
 * for the same shape of work — sequential turns a library that needs digests
 * into an hour of a pinned tab, unbounded turns it into a hundred model calls
 * at once.
 */
const DRAIN_WORKERS = 3;

/**
 * A ceiling on requests per drain, shared by its workers.
 *
 * Not a queue-length limit — a runaway guard, stopping a corrupt API response
 * from keeping a foreground tab in an infinite spend loop.
 */
const DRAIN_CEILING = 100;

/** How often the pump asks, while the tab is visible. */
const PUMP_INTERVAL_MS = 5 * 60 * 1000;

let activeDrain: Promise<MaintenanceDrainResult> | null = null;

const filedListeners = new Set<() => void>();

/**
 * The stage each running job last reported, by job id.
 *
 * The queue records what a job *is*, never what its model call is saying this
 * second — that only exists inside the SSE stream the drain is holding open.
 * So the card derived from `GET /maintenance` had no stage for any row and
 * printed its "Starting…" fallback for the whole of a filing, which is minutes
 * per document: every row of a long run read as hung while all of it was
 * working normally. This is the missing half — the tab doing the work
 * publishes what it hears, and whatever surface is watching reads it.
 *
 * Module-level for the same reason the pump is: the drain and the card are
 * different components, and several places start a drain while only one of
 * them is the one the reader is looking at.
 */
const liveStages = new Map<string, string>();
/**
 * When each running job first spoke, and the furthest step it has reached.
 *
 * Each event names its stage, folded into steps by `filingStepIndex`; a pass that
 * names its step on the event (`step`) is taken at its word. Kept here, beside
 * the stream, so the step only ever moves forward however often a surface
 * re-renders.
 */
const liveDetail = new Map<string, { startedAt: number; step: number }>();
const stageListeners = new Set<() => void>();

/** What every running job is doing right now, for a surface to render. */
export function memoryStages(): Map<string, string> {
  return liveStages;
}

/** When a running job started reporting, and the furthest step it has reached. */
export function memoryStageDetail(jobId: string): { startedAt: number; step: number } | undefined {
  return liveDetail.get(jobId);
}

export function onMemoryStage(listener: () => void): () => void {
  stageListeners.add(listener);
  return () => {
    stageListeners.delete(listener);
  };
}

function announceStage(): void {
  for (const listener of stageListeners) {
    try {
      listener();
    } catch {
      // ignored
    }
  }
}

/**
 * Called whenever a drain files a document, from wherever it was started.
 *
 * A surface showing the wiki is showing what this work writes into, so it has
 * to hear about it: the Reader's rail sits beside a document that a pass may
 * file while the reader is looking at it, and without this the wiki quietly
 * gained the page while the panel went on saying the document was not filed
 * until something else caused a navigation. A subscription rather than a
 * callback per caller, because several places start a drain and only one of
 * them is the one the reader is watching.
 *
 * Fired per job rather than once at the end, so a long backlog fills the view
 * as it lands instead of all at once an hour later.
 */
export function onMemoryFiled(listener: () => void): () => void {
  filedListeners.add(listener);
  return () => {
    filedListeners.delete(listener);
  };
}

const queueListeners = new Set<() => void>();

/**
 * Called when a drain learns the queue has moved without anything being filed:
 * a job was claimed and has started, or one failed or lost its stream.
 *
 * `onMemoryFiled` alone left a surface holding a queue snapshot from the
 * moment the *previous* job ended, which is the moment the next one is still
 * pending. Health then showed a document as queued, with no stage beside it,
 * for the whole of its filing, and a job that failed never showed as stuck
 * until some later job succeeded.
 */
export function onMemoryQueue(listener: () => void): () => void {
  queueListeners.add(listener);
  return () => {
    queueListeners.delete(listener);
  };
}

function announceQueue(): void {
  for (const listener of queueListeners) {
    try {
      listener();
    } catch {
      // ignored
    }
  }
}

function announceFiled(): void {
  // A listener is a view refreshing itself; one that throws must not take the
  // queue down with it.
  for (const listener of filedListeners) {
    try {
      listener();
    } catch {
      // ignored
    }
  }
}

/** Shared by the workers of one drain, so the ceiling is one total. */
type DrainState = {
  requests: number;
  processed: number;
  failed: number;
  drained: boolean;
  last?: SseEvent;
  /** Workers holding a request right now. */
  active: number;
  /** Workers a later request added to this run, which it waits for. */
  joined: Promise<void>[];
};

/** The run in flight, so a later request can add a worker to it. */
let activeState: DrainState | null = null;

function work(fetcher: typeof fetch, state: DrainState, budget?: number): Promise<void> {
  state.active += 1;
  return drainWorker(fetcher, state, budget).finally(() => {
    state.active -= 1;
  });
}

async function drainWorker(
  fetcher: typeof fetch,
  state: DrainState,
  budget = Number.POSITIVE_INFINITY,
): Promise<void> {
  let made = 0;
  for (;;) {
    if (state.drained || state.requests >= DRAIN_CEILING || made >= budget) return;
    made += 1;
    state.requests += 1;
    const response = await fetcher(`${API_BASE}/api/memory/maintenance/drain`, {
      method: "POST",
      credentials: "include",
    });
    if (!response.ok) throw new Error(`Updating your Memory failed (${response.status})`);
    if (!response.body) throw new Error("Updating your Memory returned no progress");
    let terminal: SseEvent | undefined;
    let failure: SseEvent | undefined;
    let started = false;
    for await (const event of readSseStream(response.body)) {
      state.last = event;
      // An empty claim answers with its terminal frame alone, so anything
      // before one means a job was claimed and is running.
      if (!started && event.type !== "done") {
        started = true;
        announceQueue();
      }
      // A job that fails is one job's news, not the queue's. Throwing here
      // ended the whole drain on the first bad document, and since the claim
      // walks the queue in order that document was claimed first on every
      // later mount too — so one paper the provider choked on stopped every
      // paper behind it from ever being filed. The server has already recorded
      // the failure with its own retry schedule; carry on to the next job and
      // let the reader see it on Health.
      if (event.type === "error") failure = event;
      if (event.type === "done") terminal = event;
      // Bounded before it is stored, because it is model-adjacent text headed
      // for a one-line row; the surface does the rewriting.
      if (event.type === "progress" && event.jobId && event.message) {
        const message = String(event.message).trim().slice(0, 180);
        const named = typeof event.step === "string" ? event.step : undefined;
        const detail = liveDetail.get(event.jobId) ?? { startedAt: Date.now(), step: 0 };
        const stage = typeof event.stage === "string" ? event.stage : undefined;
        detail.step = filingStepIndex(message, detail.step, named, stage);
        liveDetail.set(event.jobId, detail);
        if (message && liveStages.get(event.jobId) !== message) {
          liveStages.set(event.jobId, message);
          announceStage();
        }
      }
    }
    // Whatever this job was doing, it has stopped doing it. Left behind, the
    // last stage of a finished document would sit under the next one's title
    // when the row list shifts.
    const finishedId = terminal?.jobId ?? failure?.jobId;
    if (finishedId) liveDetail.delete(finishedId);
    if (finishedId && liveStages.delete(finishedId)) announceStage();
    // A stream that ends with neither frame is the silent close an idle proxy
    // performs: the job is still leased server-side and will come round again,
    // so this is one job's news too — not a reason to stop.
    if (failure || !terminal) {
      state.failed += 1;
      announceQueue();
      continue;
    }
    // Nothing left to claim. Read from `claimed` rather than inferred from
    // `remaining`, which with several workers in flight counts the jobs the
    // other workers are still running.
    if (!terminal.claimed) {
      state.drained = true;
      return;
    }
    state.processed += 1;
    announceFiled();
  }
}

/** Drain durable KB work once, sharing one run across every caller. */
export function drainMemoryMaintenance(
  fetcher: typeof fetch = fetch,
  workers: number = DRAIN_WORKERS,
): Promise<MaintenanceDrainResult> {
  if (activeDrain) {
    // A request that arrives mid-run is usually news of fresh work, and the run
    // may be minutes into one job — an answer filing itself, say, while a
    // document has just been added. Absorbing the request made that document
    // wait its turn behind the job; a worker joins instead, inside the same
    // ceiling, and costs one request if there was nothing new after all.
    const state = activeState;
    if (state && state.active < Math.max(1, workers)) {
      state.drained = false;
      state.joined.push(work(fetcher, state).catch(() => undefined));
    }
    return activeDrain;
  }
  activeDrain = (async () => {
    const state: DrainState = {
      requests: 0,
      processed: 0,
      failed: 0,
      drained: false,
      active: 0,
      joined: [],
    };
    activeState = state;
    // One request decides whether there is anything to do, and only then does
    // the drain go wide. An empty queue is by far the commonest case — the
    // pump asks every five minutes for the life of the session — and it should
    // cost one request rather than one per worker.
    await work(fetcher, state, 1);
    if (!state.drained) {
      await Promise.all(
        Array.from({ length: Math.max(1, workers - state.active) }, () => work(fetcher, state)),
      );
    }
    while (state.joined.length) await state.joined.shift();
    return { processed: state.processed, failed: state.failed, last: state.last };
  })().finally(() => {
    activeDrain = null;
    activeState = null;
  });
  return activeDrain;
}

/**
 * Ask for the queue to be run, because something just put work in it.
 *
 * Best-effort and coalesced: a drain already in flight absorbs the request, and
 * durable failures stay on the server for the Health tab to show.
 */
export function requestMemoryMaintenance(
  enabled: boolean,
  fetcher: typeof fetch = fetch,
): void {
  if (enabled) void drainMemoryMaintenance(fetcher).catch(() => undefined);
}

/**
 * What the pump needs from the browser, so a test can drive it.
 *
 * `node --test` loads this module for its pure half, so nothing here may reach
 * for `window` at import time.
 */
export type MaintenancePumpHost = {
  setInterval: (handler: () => void, ms: number) => number;
  clearInterval: (handle: number) => void;
  addEventListener: (type: string, handler: () => void) => void;
  removeEventListener: (type: string, handler: () => void) => void;
  isVisible: () => boolean;
};

function browserHost(): MaintenancePumpHost | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return {
    setInterval: (handler, ms) => window.setInterval(handler, ms),
    clearInterval: (handle) => window.clearInterval(handle),
    // The two events answer different questions, so both are listened for:
    // `focus` catches returning to a tab that was never hidden (another window
    // was simply on top of it), `visibilitychange` catches the tab itself being
    // switched away from and back.
    addEventListener: (type, handler) => {
      if (type === "visibilitychange") document.addEventListener(type, handler);
      else window.addEventListener(type, handler);
    },
    removeEventListener: (type, handler) => {
      if (type === "visibilitychange") document.removeEventListener(type, handler);
      else window.removeEventListener(type, handler);
    },
    isVisible: () => document.visibilityState === "visible",
  };
}

let pumpStop: (() => void) | null = null;
let beside: Beside = NOWHERE;
let leaving: ReturnType<typeof setTimeout> | null = null;
const CHAT_RETURN_GRACE_MS = 15_000;

/**
 * Report an ended session and run what it released.
 *
 * Fire and forget: nothing the reader does waits for it, and a report that
 * fails leaves the job to the idle limit. A release that freed nothing asks
 * for no drain, so leaving a document nobody asked about costs one request.
 */
function releaseSession(release: SessionRelease, fetcher: typeof fetch): Promise<void> {
  return sendSessionRelease(release, fetcher).then((released) => {
    if (released > 0) requestMemoryMaintenance(true, fetcher);
  });
}

/**
 * Say where the reader now is; whatever session that ends is released.
 *
 * Each surface reports the part it owns: the reader its document and whether
 * that document's chat is docked, the chat its conversation when it belongs to
 * no document. Nothing is sent before the pump has started, which is also
 * what keeps a server with Memory turned off from being asked.
 */
export function readerIsBeside(change: Partial<Beside>, fetcher: typeof fetch = fetch): void {
  if ("conversationId" in change && leaving) {
    clearTimeout(leaving);
    leaving = null;
  }
  const next = { ...beside, ...change };
  const releases = releasesFor(beside, next);
  beside = next;
  if (!pumpStop) return;
  for (const release of releases) void releaseSession(release, fetcher);
}

/**
 * A Memory chat left the screen; release it unless it comes straight back.
 *
 * Moving between a Memory page and the map remounts the chat docked beside
 * them, and that is not the reader leaving the conversation.
 */
export function chatLeft(fetcher: typeof fetch = fetch, graceMs = CHAT_RETURN_GRACE_MS): void {
  if (leaving) clearTimeout(leaving);
  const left = beside.conversationId;
  leaving = setTimeout(() => {
    leaving = null;
    if (beside.conversationId === left) readerIsBeside({ conversationId: null }, fetcher);
  }, graceMs);
}

/**
 * Keep asking for the queue to be run, for the life of the session.
 *
 * Idempotent and module-level rather than per-component: every shell starts it,
 * and a second mount must not mean a second interval. This is the piece that
 * makes the server's retry schedule mean anything — a job that backs off for
 * five minutes is now retried in five minutes, rather than whenever the reader
 * happens to navigate.
 *
 * A hidden tab does nothing: it is not the one the reader is watching, and a
 * background tab spending model calls is a surprise on the bill.
 *
 * Starting releases every session still waiting, before the first drain.
 * Closing the window reports nothing, so a session the reader ended that way
 * is still held; at launch none is open, and each can be filed. The pump is
 * never stopped, so this happens once for a window.
 */
export function startMemoryMaintenance(
  enabled: boolean,
  host: MaintenancePumpHost | null = browserHost(),
  fetcher: typeof fetch = fetch,
): void {
  if (!enabled || pumpStop || !host) return;
  const tick = () => {
    if (host.isVisible()) requestMemoryMaintenance(true, fetcher);
  };
  const timer = host.setInterval(tick, PUMP_INTERVAL_MS);
  host.addEventListener("visibilitychange", tick);
  host.addEventListener("focus", tick);
  pumpStop = () => {
    host.clearInterval(timer);
    host.removeEventListener("visibilitychange", tick);
    host.removeEventListener("focus", tick);
    pumpStop = null;
  };
  void sendSessionRelease(EVERY_SESSION, fetcher).then(() => {
    if (pumpStop) tick();
  });
}

/** Tear the pump down and forget where the reader was. For tests; a session never stops it. */
export function stopMemoryMaintenance(): void {
  pumpStop?.();
  beside = NOWHERE;
  if (leaving) clearTimeout(leaving);
  leaving = null;
}
