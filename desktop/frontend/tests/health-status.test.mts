/**
 * What Health's rail foot says, and that every number on it adds up: each
 * document owed work is counted in exactly one place.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryHealth, MaintenanceJob, MaintenanceSnapshot } from "../app/lib/api.ts";
import type { BackfillCandidate } from "../app/lib/backfill.ts";
import {
  dayLabel,
  gaveUp,
  gaveUpLine,
  healthCounts,
  notWritten,
  railStatus,
  waitingDocuments,
} from "../app/lib/health-status.ts";

const now = "2026-10-21T12:00:00Z";

function job(id: string, overrides: Partial<MaintenanceJob> = {}): MaintenanceJob {
  return {
    id, kind: "document", marker: `paper:${id}`, payload: { paperId: id }, status: "pending", attempts: 0,
    leaseExpiresAt: null, retryAt: null, lastError: null, createdAt: now, updatedAt: now, label: id, context: "Filing a document",
    failure: null, ...overrides,
  };
}

function queue(jobs: MaintenanceJob[], cancellable = 0): MaintenanceSnapshot {
  return {
    pending: jobs.filter((entry) => entry.status === "pending").length,
    leased: jobs.filter((entry) => entry.status === "leased").length,
    cancellable,
    failed: jobs.filter((entry) => entry.status === "failed").length,
    due: 0,
    jobs,
    maxAttempts: 3,
  };
}

function paper(paperId: string, overrides: Partial<BackfillCandidate> = {}): BackfillCandidate {
  return {
    projectId: "p", paperId, projectName: "Library", title: paperId, digestReady: true,
    filed: false, stale: false, dropped: [], filedVersion: null, ...overrides,
  };
}

const healthy = { stuck: 0, dropped: 0, contradictions: 0 };

function health(droppedPaperIds: string[] = []): MemoryHealth {
  return {
    pages: 3, computedAt: now, orphans: [], uncapturedFigures: [],
    droppedTargets: droppedPaperIds.map((paperId, index) => (
      { slug: `s${index}`, title: `S${index}`, action: "edit", reason: "r", quote: "", marker: "m", paperId }
    )),
    lastCheck: null,
  } as unknown as MemoryHealth;
}

test("only a job with no retry left is stuck; one waiting out its backoff is still filing", () => {
  assert.equal(gaveUp(job("a", { status: "failed", retryAt: null })), true);
  assert.equal(gaveUp(job("b", { status: "failed", retryAt: "2026-10-21T12:05:00Z" })), false);
  assert.equal(gaveUp(job("c", { status: "pending" })), false);

  // The snapshot's own `failed` counts both, which is what called a queue that
  // was only backing off unhealthy.
  const snapshot = queue([
    job("a", { status: "failed", retryAt: null }),
    job("b", { status: "failed", retryAt: "2026-10-21T12:05:00Z" }),
  ], 1);
  assert.equal(snapshot.failed, 2);
  assert.equal(healthCounts(snapshot, null, null).stuck, 1);
  const backingOff = queue([snapshot.jobs[1]], 1);
  assert.deepEqual(healthCounts(backingOff, null, null), healthy);
  assert.deepEqual(railStatus({ counts: healthCounts(backingOff, null, null), queue: backingOff, queueFailed: false, health: health(), healthFailed: false, candidates: [], candidatesFailed: false, running: false }),
    { kind: "filing", filing: { left: 1 } });
});

test("the counts come from the queue, the dropped targets and the last check", () => {
  const checked = {
    ...health(["p1", "p1"]),
    lastCheck: { kind: "lint", createdAt: now, summary: "", contradictions: [{ pages: ["a", "b"], claim: "c", detail: "d" }] },
  } as unknown as MemoryHealth;
  assert.deepEqual(healthCounts(null, checked, null), { stuck: 0, dropped: 2, contradictions: 1 });
  assert.deepEqual(healthCounts(null, null, null), healthy);
});

test("a document the queue holds again is not also listed as Not written", () => {
  const both = health(["p1", "p2"]);
  // Its job gave up: Stuck lists it, with its own Try again.
  const stuck = queue([job("p1", { status: "failed", retryAt: null })]);
  assert.deepEqual(notWritten(stuck, both, null).map((target) => target.paperId), ["p2"]);
  assert.deepEqual(healthCounts(stuck, both, null), { stuck: 1, dropped: 1, contradictions: 0 });
  // Queued or retrying, it is Filing; its next pass settles the pages.
  const retrying = queue([job("p1", { status: "failed", retryAt: "2026-10-21T12:05:00Z" })], 1);
  assert.equal(healthCounts(retrying, both, null).dropped, 1);
  assert.equal(healthCounts(queue([job("p1")], 1), both, null).dropped, 1);
  // A session's job names a document too, but it files a conversation.
  assert.equal(healthCounts(queue([job("s", { kind: "session", payload: { paperId: "p1" } })]), both, null).dropped, 2);
});

test("File counts only what nothing else already covers", () => {
  const candidates = [
    paper("new"),
    paper("older", { filed: true, stale: true }),
    paper("current", { filed: true }),
    // Not written owns these, with their own Try again, even one also out of date.
    paper("lost-a-page", { filed: true, dropped: [{ slug: "s", title: "S", reason: "r" }] }),
    paper("older-lost-a-page", { filed: true, stale: true, dropped: [{ slug: "s", title: "S", reason: "r" }] }),
    // The queue holds these: Filing owns the first two, Stuck the last.
    paper("queued"),
    paper("retrying"),
    paper("gave-up"),
  ];
  const snapshot = queue([
    job("queued"),
    job("retrying", { status: "failed", retryAt: "2026-10-21T12:05:00Z" }),
    job("gave-up", { status: "failed", retryAt: null }),
  ]);
  const loaded = health(["lost-a-page", "older-lost-a-page"]);
  // File names the one already in Memory from an older pass apart from the new one.
  assert.deepEqual(waitingDocuments(candidates, false, snapshot, false, loaded, false), { paperIds: ["new", "older"], outdated: 1 });
  // With no health there is no Not written list, so File takes what it would have held.
  assert.deepEqual(waitingDocuments(candidates, false, snapshot, false, null, true), { paperIds: ["new", "older", "lost-a-page", "older-lost-a-page"], outdated: 2 });
  // A session's job names a document too, but it files a conversation.
  assert.deepEqual(waitingDocuments([paper("new")], false, queue([job("s", { kind: "session", payload: { paperId: "new" } })]), false, health(), false), { paperIds: ["new"], outdated: 0 });
});

test("File waits for the queue and health before offering anything, and a count that failed offers File all", () => {
  const candidates = [paper("new"), paper("gave-up")];
  const snapshot = queue([job("gave-up", { status: "failed", retryAt: null })]);
  // The library's list can arrive first: until the queue is read, a document
  // that gave up would read as waiting, and File would bypass Stuck.
  assert.equal(waitingDocuments(candidates, false, null, false, health(), false), undefined);
  assert.equal(waitingDocuments(candidates, false, snapshot, false, null, false), undefined);
  assert.deepEqual(waitingDocuments(candidates, false, snapshot, false, health(), false), { paperIds: ["new"], outdated: 0 });
  assert.equal(waitingDocuments(null, false, snapshot, false, health(), false), undefined);
  assert.equal(waitingDocuments(null, true, snapshot, false, health(), false), null);
  assert.equal(waitingDocuments([paper("current", { filed: true })], false, snapshot, false, health(), false), undefined);

  const base = { counts: { ...healthy }, queue: queue([]), queueFailed: false, health: health(), healthFailed: false, running: false };
  assert.deepEqual(railStatus({ ...base, candidates: null, candidatesFailed: false }), { kind: "healthy" });
  assert.deepEqual(railStatus({ ...base, candidates: null, candidatesFailed: true }), { kind: "waiting", waiting: null });
  assert.deepEqual(railStatus({ ...base, candidates: [paper("new")], candidatesFailed: false }), { kind: "waiting", waiting: { paperIds: ["new"], outdated: 0 } });
  // Unread, the queue holds File back; failed, there is nothing to file around.
  assert.deepEqual(railStatus({ ...base, queue: null, candidates: [paper("new")], candidatesFailed: false }), { kind: "healthy" });
  assert.deepEqual(railStatus({ ...base, queue: null, queueFailed: true, candidates: [paper("new")], candidatesFailed: false }), { kind: "waiting", waiting: null });
  assert.deepEqual(railStatus({ ...base, queue: null, queueFailed: true, candidates: [paper("current", { filed: true })], candidatesFailed: false }), { kind: "healthy" });
});

test("pages a deleted document could not write are not counted, since nothing can file them again", () => {
  const both = health(["kept", "deleted"]);
  assert.deepEqual(notWritten(null, both, [paper("kept")]).map((target) => target.paperId), ["kept"]);
  assert.equal(healthCounts(null, both, [paper("kept")]).dropped, 1);
  // Unknown is not gone: before the library's list arrives, both count.
  assert.equal(healthCounts(null, both, null).dropped, 2);
});

test("the foot says one thing: unhealthy over filing over waiting, and nothing when healthy", () => {
  const candidates = [paper("new")];
  assert.deepEqual(railStatus({ counts: { ...healthy }, queue: queue([]), queueFailed: false, health: null, healthFailed: false, candidates: [], candidatesFailed: false, running: false }), { kind: "healthy" });
  // Filing hides File: what waits is offered once the run is over.
  assert.deepEqual(railStatus({ counts: { ...healthy }, queue: queue([job("q")], 1), queueFailed: false, health: null, healthFailed: false, candidates, candidatesFailed: false, running: false }),
    { kind: "filing", filing: { left: 1 } });
  // This window filing with nothing left to stop still says Filing, with no stop.
  assert.deepEqual(railStatus({ counts: { ...healthy }, queue: queue([]), queueFailed: false, health: null, healthFailed: false, candidates: [], candidatesFailed: false, running: true }),
    { kind: "filing", filing: { left: 0 } });
  // Unhealthy carries what overlaps with it, for the panel's foot.
  const counts = { stuck: 1, dropped: 0, contradictions: 0 };
  assert.deepEqual(railStatus({ counts, queue: queue([job("q")], 1), queueFailed: false, health: null, healthFailed: false, candidates, candidatesFailed: false, running: false }),
    { kind: "unhealthy", counts, filing: { left: 1 }, waiting: undefined });
  assert.deepEqual(railStatus({ counts, queue: queue([]), queueFailed: false, health: health(), healthFailed: false, candidates, candidatesFailed: false, running: false }),
    { kind: "unhealthy", counts, filing: null, waiting: { paperIds: ["new"], outdated: 0 } });
  // A contradiction alone is enough: it stays a row while the backend reports it.
  assert.equal(railStatus({ counts: { ...healthy, contradictions: 2 }, queue: null, queueFailed: false, health: null, healthFailed: false, candidates: [], candidatesFailed: false, running: false }).kind, "unhealthy");
});

test("a stuck row says how hard it tried and when, in calendar days", () => {
  const today = new Date(2026, 9, 21, 14, 2).toISOString();
  const later = new Date(2026, 9, 21, 18, 0).getTime();
  assert.equal(gaveUpLine({ attempts: 3, updatedAt: today }, later), "Gave up after 3 tries · last try today at 14:02");
  assert.equal(gaveUpLine({ attempts: 1, updatedAt: today }, later), "Gave up after 1 try · last try today at 14:02");
  assert.equal(gaveUpLine({ attempts: 3, updatedAt: today }, new Date(2026, 9, 22, 9, 0).getTime()), "Gave up after 3 tries · last try yesterday at 14:02");
  assert.equal(gaveUpLine({ attempts: 3, updatedAt: today }, new Date(2026, 9, 25, 9, 0).getTime()), "Gave up after 3 tries · last try 4 days ago");
  // Re-enqueued since (a republished digest): the row moved, the last try did not.
  const yesterday = new Date(2026, 9, 20, 9, 15).toISOString();
  assert.equal(
    gaveUpLine({ attempts: 3, updatedAt: today, failure: { cause: "provider", failedAt: yesterday, pages: [] } }, later),
    "Gave up after 3 tries · last try yesterday at 09:15",
  );
  // Calendar days, everywhere on the pane: 23:30 last night is yesterday at 09:00.
  assert.equal(dayLabel(new Date(2026, 9, 20, 23, 30).toISOString(), new Date(2026, 9, 21, 9, 0).getTime()), "yesterday");
  assert.equal(dayLabel(new Date(2025, 7, 1).toISOString(), new Date(2026, 9, 21).getTime()), "1 year ago");
  assert.equal(dayLabel(new Date(2026, 7, 1).toISOString(), new Date(2026, 9, 21).getTime()), "2 months ago");
  assert.equal(dayLabel(new Date(2025, 9, 26).toISOString(), new Date(2026, 9, 21).getTime()), "12 months ago");
  assert.equal(dayLabel("not a date"), "");
  // Across a clock change a day is 23 or 25 hours; the count is in calendar days.
  process.env.TZ = "America/New_York";
  const late = new Date(2026, 2, 7, 23, 30).toISOString();
  assert.equal(gaveUpLine({ attempts: 3, updatedAt: late }, new Date(2026, 2, 9, 0, 30).getTime()), "Gave up after 3 tries · last try 2 days ago");
  assert.equal(gaveUpLine({ attempts: 3, updatedAt: late }, new Date(2026, 2, 8, 9, 0).getTime()), "Gave up after 3 tries · last try yesterday at 23:30");
});
