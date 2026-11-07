/**
 * What a browser job may ask of the browser host (`browser-host.ts`), checked
 * without Electron: its opening, the DevTools methods it may send, the framing
 * of its stream, and the pool it waits in.
 */
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The longest line either side writes: a tall screenshot, base64-encoded. */
export const MAX_LINE_BYTES = 48 * 1024 * 1024;
/** Pages alive at once; a further job waits, inside its own deadline. */
export const SLOTS = 3;
/** No job outlives this, whatever it asks for. */
export const MAX_DEADLINE_SECONDS = 120;
export interface Opening {
  purpose: "page" | "artifact";
  width: number;
  height: number;
  /** The backend's validating proxy; a page job has no other way out. */
  proxy?: string;
  userAgent?: string;
  deadlineSeconds: number;
  memoryLimitBytes?: number;
}

const integer = (value: unknown, low: number, high: number, name: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) throw new Error(`${name} must be an integer from ${low} to ${high}`);
  return value;
};

/** What a job may ask for, checked before anything is created for it. */
export function parseOpening(value: unknown): Opening {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("open must be an object");
  const raw = value as Record<string, unknown>;
  const known = new Set(["purpose", "width", "height", "proxy", "userAgent", "deadlineSeconds", "memoryLimitBytes"]);
  const unknown = Object.keys(raw).find(key => !known.has(key));
  if (unknown) throw new Error(`unknown option ${unknown}`);
  if (raw.purpose !== "page" && raw.purpose !== "artifact") throw new Error("purpose must be page or artifact");
  if (typeof raw.deadlineSeconds !== "number" || !(raw.deadlineSeconds > 0)) throw new Error("deadlineSeconds must be positive");
  const opening: Opening = {
    purpose: raw.purpose,
    width: integer(raw.width, 100, 8192, "width"),
    height: integer(raw.height, 100, 8192, "height"),
    deadlineSeconds: Math.min(raw.deadlineSeconds, MAX_DEADLINE_SECONDS),
  };
  if (raw.purpose === "page") {
    // Loopback only: the proxy is the backend's own, and it is the whole of a
    // capture's network policy (every host checked public, then dialled).
    if (typeof raw.proxy !== "string" || !/^127\.0\.0\.1:\d{1,5}$/.test(raw.proxy)) throw new Error("a page job needs the backend's loopback proxy");
    opening.proxy = raw.proxy;
  } else if (raw.proxy !== undefined) throw new Error("an artifact job reaches no network");
  if (raw.userAgent !== undefined) {
    if (typeof raw.userAgent !== "string" || raw.userAgent.length > 512) throw new Error("userAgent must be a short string");
    opening.userAgent = raw.userAgent;
  }
  if (raw.memoryLimitBytes !== undefined) opening.memoryLimitBytes = integer(raw.memoryLimitBytes, 64 * 2 ** 20, 4 * 2 ** 30, "memoryLimitBytes");
  return opening;
}

/** The DevTools domains a job page is driven with; nothing browser-wide. */
const DOMAINS = new Set(["Page", "Runtime", "Network", "Fetch", "Emulation", "Log", "DOM"]);
/** Within those, what would reach past the page: a download written to disk. */
const REFUSED = new Set(["Page.setDownloadBehavior"]);

export function permitted(method: string): boolean {
  if (method === "Target.setAutoAttach") return true; // its own frames, flattened
  const domain = method.split(".")[0];
  return DOMAINS.has(domain) && !REFUSED.has(method);
}

/** Splits a byte stream into bounded lines; a longer one is an error, not a wait. */
export function lineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let pending: Buffer[] = [];
  let size = 0;
  return chunk => {
    let start = 0;
    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
      pending.push(chunk.subarray(start, index));
      const line = Buffer.concat(pending).toString("utf8");
      pending = []; size = 0; start = index + 1;
      onLine(line);
    }
    if (start < chunk.length) {
      size += chunk.length - start;
      if (size > MAX_LINE_BYTES) throw new Error("line too long");
      pending.push(chunk.subarray(start));
    }
  };
}

/** A fixed pool, handed out in arrival order; a waiter that gives up leaves the queue. */
export class Slots {
  private free: number[];
  private waiting: Array<{ resolve: (slot: number) => void; reject: (error: Error) => void }> = [];
  constructor(count: number) { this.free = Array.from({ length: count }, (_, index) => index); }

  acquire(signal: AbortSignal): Promise<number> {
    if (signal.aborted) return Promise.reject(new Error("cancelled"));
    const slot = this.free.shift();
    if (slot !== undefined) return Promise.resolve(slot);
    return new Promise((resolve, reject) => {
      const waiter = { resolve: (value: number) => { signal.removeEventListener("abort", abort); resolve(value); }, reject };
      const abort = () => { this.waiting = this.waiting.filter(entry => entry !== waiter); reject(new Error("cancelled")); };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(waiter);
    });
  }

  release(slot: number): void {
    const next = this.waiting.shift();
    if (next) next.resolve(slot); else this.free.push(slot);
  }
}

/**
 * What the backend is told when the host could not start: an address nothing
 * listens on. Its jobs then fail and say so, and none goes looking for an
 * installed Chrome, which is what a backend told of no host at all would do.
 */
export function unavailableBrowserHost(directory = tmpdir()) {
  return {
    socket: join(directory, `delphi-browser-unavailable-${randomBytes(8).toString("hex")}.sock`),
    token: randomBytes(32).toString("hex"),
    available: false,
    close: async () => {},
  };
}
