/** Connection changes share one lifecycle, regardless of the transport.
 * Persist only after startup succeeds. A failed change restores the previous
 * service while the worker host keeps the same origin, session and library. */
import type { Backend } from "../backend.ts";
import type { StoredConfig } from "../profile.ts";
import type { HostActivity } from "../worker-host.ts";
import type { InferenceBridge } from "./bridge.ts";

/** Memory's drain and the capture drain: their claims go back to the queue when the backend stops. */
const RESUMABLE = new Set(["/api/memory/maintenance/drain", "/api/captures/drain"]);

/**
 * With nothing said for longer than any step of an answer can take (the
 * backend's read timeout is fifteen minutes), an entry is stuck: its socket
 * outlived the work, or the work waits where no timeout reaches. `since` moves
 * with every chunk written except a heartbeat, so a stream still saying
 * something never ages out, and one that only heartbeats does.
 */
export const INFLIGHT_MAX_AGE_MS = 20 * 60_000;

/** The work a switch is waiting on, named for the person who asked to switch. */
function describe(path: string): string {
  if (path === "/desktop/reader/find") return "reader search";
  if (path.endsWith("/chat/stream")) return "a chat answer";
  if (path.endsWith("/digest/stream")) return "a digest";
  if (path === "/api/memory/reorganize/stream") return "Memory reorganizing";
  if (path === "/api/memory/lint") return "Memory checking its pages";
  if (path.startsWith("/api/projects/") && (path.endsWith("/papers") || path.endsWith("/pages"))) return "a document being added";
  if (path.startsWith("/api/memory/")) return "a change to Memory";
  return "a change to your library";
}

export interface AiService { backend: Backend; bridge?: InferenceBridge }
export class AiServiceController {
  private service?: AiService;
  private current?: { config: StoredConfig; apiKey: string };
  private changing = false;
  private stopping = false;
  private stopped?: Promise<void>;
  private readonly options: {
    activity: HostActivity;
    start(config: StoredConfig, apiKey: string): Promise<AiService>;
    save(config: StoredConfig): void;
    changed(): void;
  };
  constructor(options: AiServiceController["options"]) { this.options = options; }
  get backend() { return this.service?.backend; }
  get bridge() { return this.service?.bridge; }
  busy(): string | undefined {
    if (this.changing) return "A connection change is already in progress.";
    if (this.stopping) return "Delphi is stopping.";
    // Background work the backend hands back when it stops, and runs again after.
    const now = Date.now();
    const blocking = [...this.options.activity.inflight.values()].find(entry =>
      !RESUMABLE.has(entry.path) && now - entry.since <= INFLIGHT_MAX_AGE_MS);
    if (blocking) return `Delphi is busy. Switch when it’s done. Waiting on: ${describe(blocking.path)} for ${Math.round((now - blocking.since) / 1000)}s.`;
  }
  async start(config: StoredConfig, apiKey: string): Promise<void> {
    this.service = await this.options.start(config, apiKey);
    this.current = { config, apiKey };
  }
  private async stopService(): Promise<void> {
    const service = this.service;
    this.service = undefined;
    service?.backend.stop();
    await service?.backend.closed;
    await service?.bridge?.stop(3_000);
  }
  async change(config: StoredConfig, apiKey: string): Promise<void> {
    const busy = this.busy();
    if (busy) { console.warn(`Connection change refused: ${busy}`); throw new Error(busy); }
    const before = this.current;
    if (!before) throw new Error("Delphi is still starting.");
    let changed = false;
    this.changing = true;
    this.options.activity.paused = true;
    try {
      await this.stopService();
      if (this.stopping) throw new Error("Delphi is stopping.");
      try {
        await this.start(config, apiKey);
        if (this.stopping) throw new Error("Delphi is stopping.");
        this.options.save(config);
        changed = true;
      } catch (error) {
        await this.stopService();
        if (this.stopping) throw error;
        await this.start(before.config, before.apiKey);
        throw new Error(`Delphi stayed on the previous connection. ${error instanceof Error ? error.message.split("\n")[0] : "The new connection could not start."}`);
      }
    } finally {
      this.changing = false;
      this.options.activity.paused = this.stopping;
      if (changed && !this.stopping) this.options.changed();
    }
  }
  stop(): Promise<void> {
    this.stopped ??= (async () => {
      this.stopping = true;
      this.options.activity.paused = true;
      // A change already in progress owns cleanup of its starting service.
      while (this.changing) await new Promise(resolve => setTimeout(resolve, 25));
      await this.stopService();
    })();
    return this.stopped;
  }
}
