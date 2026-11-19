/**
 * What Health's rail foot says, decided from the records alone.
 *
 * The foot says something only when there is something to say: nothing while
 * Memory is healthy, Filing while work is in flight, File while documents wait
 * for the reader's go-ahead, and Memory unhealthy when something went wrong.
 * Each document owed work is counted in exactly one place, so the numbers the
 * foot and the lists show add up: a job that gave up is Stuck, a document that
 * lost a page is Not written, a job still retrying is Filing, and File is only
 * what none of those already covers.
 *
 * Kept JSX-free so `node --test` can strip the types and run it directly.
 */

import type { MemoryDroppedTarget, MemoryHealth, MaintenanceJob, MaintenanceSnapshot } from "./api.ts";
import { type BackfillCandidate, planBackfill } from "./backfill.ts";

export type HealthList = "stuck" | "dropped" | "contradictions";
export type HealthCounts = Record<HealthList, number>;

/**
 * A job that will not run again unless the reader asks. A failed job with a
 * `retryAt` is only waiting out its backoff, which is filing, not stuck.
 */
export function gaveUp(job: Pick<MaintenanceJob, "status" | "retryAt">): boolean {
  return job.status === "failed" && !job.retryAt;
}

/** Documents the queue holds a job for: Filing or Stuck owns each of them. */
function queuedDocuments(queue: MaintenanceSnapshot | null) {
  return new Set(
    (queue?.jobs ?? []).filter((job) => job.kind === "document").map((job) => job.payload?.paperId),
  );
}

/**
 * The pages Not written lists: never a document the queue holds again, whose
 * next pass settles them or whose job gave up and is listed under Stuck, and
 * never one no longer in the library, which nothing can file again.
 */
export function notWritten(
  queue: MaintenanceSnapshot | null,
  health: MemoryHealth | null,
  candidates: BackfillCandidate[] | null,
): MemoryDroppedTarget[] {
  const queued = queuedDocuments(queue);
  const library = candidates ? new Set(candidates.map((item) => item.paperId)) : null;
  return (health?.droppedTargets ?? []).filter(
    (target) => !queued.has(target.paperId) && (!library || library.has(target.paperId)),
  );
}

export function healthCounts(
  queue: MaintenanceSnapshot | null,
  health: MemoryHealth | null,
  candidates: BackfillCandidate[] | null,
): HealthCounts {
  return {
    stuck: (queue?.jobs ?? []).filter(gaveUp).length,
    dropped: notWritten(queue, health, candidates).length,
    contradictions: health?.lastCheck?.contradictions?.length ?? 0,
  };
}

/** Filing in flight: how much Stop would call off, as the server counts it. */
export type FilingNow = { left: number };

/**
 * Documents waiting for the go-ahead, and how many of them Memory already
 * holds from an older pass; or `null` when they could not be counted — File
 * then files whatever the server says is owed.
 */
export type Waiting = { paperIds: string[]; outdated: number } | null;

export type RailStatus =
  | { kind: "healthy" }
  | { kind: "filing"; filing: FilingNow }
  | { kind: "waiting"; waiting: Waiting }
  | { kind: "unhealthy"; counts: HealthCounts; filing: FilingNow | null; waiting: Waiting | undefined };

/**
 * The documents File would file: what the shared planner says is owed.
 *
 * Never one the queue already holds (running, retrying or gave up: Filing and
 * Stuck own those), and never one with a page its last job could not write
 * while Not written lists it with its own Try again; if health could not be
 * read there is no such list, and File takes those too. `undefined` until the
 * queue and health have been read or have failed, since File must not offer
 * what they own; `null` once the count or the queue failed.
 */
export function waitingDocuments(
  candidates: BackfillCandidate[] | null,
  candidatesFailed: boolean,
  queue: MaintenanceSnapshot | null,
  queueFailed: boolean,
  health: MemoryHealth | null,
  healthFailed: boolean,
): Waiting | undefined {
  if ((!queue && !queueFailed) || (!health && !healthFailed)) return undefined;
  if (!candidates) return candidatesFailed ? null : undefined;
  // With no queue there is no Stuck or Filing to file around: File all, when anything is owed.
  if (!queue) return planBackfill(candidates).queue.length ? null : undefined;
  const queued = queuedDocuments(queue);
  const unqueued = candidates.filter((item) => !queued.has(item.paperId));
  const owed = planBackfill(unqueued).queue.filter((item) => !(health && item.dropped.length));
  return owed.length
    ? { paperIds: owed.map((item) => item.paperId), outdated: owed.filter((item) => item.filed && item.stale).length }
    : undefined;
}

export function railStatus({
  counts,
  queue,
  queueFailed,
  health,
  healthFailed,
  candidates,
  candidatesFailed,
  running,
}: {
  counts: HealthCounts;
  queue: MaintenanceSnapshot | null;
  queueFailed: boolean;
  health: MemoryHealth | null;
  healthFailed: boolean;
  candidates: BackfillCandidate[] | null;
  candidatesFailed: boolean;
  /** This window is filing, or the queue says documents are in flight. */
  running: boolean;
}): RailStatus {
  const left = queue?.cancellable ?? 0;
  const filing = left > 0 || running ? { left } : null;
  const waiting = filing ? undefined : waitingDocuments(candidates, candidatesFailed, queue, queueFailed, health, healthFailed);
  if (counts.stuck + counts.dropped + counts.contradictions > 0) {
    return { kind: "unhealthy", counts, filing, waiting };
  }
  if (filing) return { kind: "filing", filing };
  if (waiting !== undefined) return { kind: "waiting", waiting };
  return { kind: "healthy" };
}

const JOB_TAGS: Record<MaintenanceJob["kind"], string> = {
  document: "Document",
  session: "Session",
  domain: "Domain summary",
  reconcile: "Reconciling",
  "page-rewrite": "Page rewrite",
};

/** The small-caps word after a stuck job's name. */
export function jobTag(job: Pick<MaintenanceJob, "kind">): string {
  return JOB_TAGS[job.kind] ?? "";
}

/** Calendar days before today, or null for a missing or unreadable time. */
function daysAgo(iso: string | null | undefined, now: number): number | null {
  const then = new Date(iso ?? "");
  if (!iso || Number.isNaN(then.getTime())) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  then.setHours(0, 0, 0, 0);
  // Rounded: a day that crosses a clock change is 23 or 25 hours.
  return Math.round((today.getTime() - then.getTime()) / 86_400_000);
}

/** "today", "yesterday", "3 days ago", by the calendar rather than by 24 hours. */
export function dayLabel(iso: string | null | undefined, now = Date.now()): string {
  const days = daysAgo(iso, now);
  if (days === null) return "";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  const ago = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  if (days < 30) return ago(days, "day");
  const months = Math.floor(days / 30);
  return days < 365 ? ago(months, "month") : ago(Math.floor(days / 365), "year");
}

/** "today at 14:02", "yesterday at 09:10", "3 days ago". */
export function whenLabel(iso: string | null | undefined, now = Date.now()): string {
  const days = daysAgo(iso, now);
  if (days === null) return "";
  const time = new Date(iso!).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return days > 1 ? dayLabel(iso, now) : `${dayLabel(iso, now)} at ${time}`;
}

/**
 * The line under a stuck job's name: how hard it tried, and when it stopped.
 * When is its failure's own date: a re-enqueue moves `updatedAt` without a try.
 */
export function gaveUpLine(
  job: Pick<MaintenanceJob, "attempts" | "updatedAt"> & { failure?: MaintenanceJob["failure"] },
  now = Date.now(),
): string {
  const tries = job.attempts ? `Gave up after ${job.attempts} ${job.attempts === 1 ? "try" : "tries"}` : "Gave up";
  const when = whenLabel(job.failure?.failedAt ?? job.updatedAt, now);
  return when ? `${tries} · last try ${when}` : tries;
}
