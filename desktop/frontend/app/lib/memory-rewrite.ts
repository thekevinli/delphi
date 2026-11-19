/** Follow one durable rewrite, independently of whichever tab holds its lease. */
import { api, type MaintenanceSnapshot } from "./api.ts";

export async function waitForMemoryRewrite(
  jobId: string,
  signal: AbortSignal,
  onProgress: (message: string) => void,
  readQueue = () => api<MaintenanceSnapshot>("/api/memory/maintenance", { signal }),
  pause = () => new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 3000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }),
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    let snapshot: MaintenanceSnapshot;
    try {
      snapshot = await readQueue();
    } catch {
      signal.throwIfAborted();
      // A failed status read says nothing about whether the job completed.
      onProgress("Waiting to reconnect and check this rewrite…");
      await pause();
      continue;
    }
    signal.throwIfAborted();
    const job = snapshot.jobs.find((entry) => entry.id === jobId);
    if (!job) return;
    if (job.status === "failed") {
      throw new Error(job.lastError || "The page rewrite failed. Please try again.");
    }
    onProgress(job.status === "leased"
      ? "Writing a new explanation from this page’s sources…"
      : job.lastError
        ? "Rewrite queued for another attempt. Delphi will retry it."
        : "Rewrite queued. Waiting for Delphi to start it…");
    await pause();
  }
}
