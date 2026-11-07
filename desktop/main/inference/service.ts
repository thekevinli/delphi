/** Connection changes share one lifecycle, regardless of the transport.
 * Persist only after startup succeeds. A failed change restores the previous
 * service while the worker host keeps the same origin, session and library. */
import type { Backend } from "../backend.ts";
import type { StoredConfig } from "../profile.ts";
import type { HostActivity } from "../worker-host.ts";
import type { InferenceBridge } from "./bridge.ts";

/** Memory's drain and the capture drain: their claims go back to the queue when the backend stops. */
const RESUMABLE = new Set(["/api/memory/maintenance/drain", "/api/captures/drain"]);

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
    if ([...this.options.activity.inflight.values()].some(entry => !RESUMABLE.has(entry.path))) {
      return "Delphi is busy. Switch when it’s done.";
    }
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
    if (busy) throw new Error(busy);
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
