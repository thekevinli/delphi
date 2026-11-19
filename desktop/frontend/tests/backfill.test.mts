import assert from "node:assert/strict";
import test from "node:test";

import {
  type BackfillCandidate,
  type MaintenanceQueueJob,
  IDLE,
  backfillFraction,
  backfillFromQueue,
  describeFilingStage,
  describeRetry,
  describeRun,
  failureKey,
  describePlan,
  describePlanAction,
  planBackfill,
} from "../app/lib/backfill.ts";

function candidate(overrides: Partial<BackfillCandidate> = {}): BackfillCandidate {
  return {
    projectId: "p1",
    paperId: "a",
    projectName: "Diffusion",
    title: "MDLM",
    digestReady: true,
    filed: false,
    stale: false,
    dropped: [],
    filedVersion: null,
    ...overrides,
  };
}

test("a plan leaves out what is already in the wiki", () => {
  const plan = planBackfill([
    candidate({ paperId: "a", filed: true }),
    candidate({ paperId: "b", filed: false }),
    candidate({ paperId: "c", filed: false }),
  ]);

  // Filing a document twice spends a model call to move a timestamp for a
  // reading that happened once, so the queue is the work and nothing else.
  assert.deepEqual(
    plan.queue.map((item) => item.paperId),
    ["b", "c"],
  );
  assert.equal(plan.total, 2);
  assert.equal(plan.alreadyFiled, 1);
});

test("a document filed by a pass Delphi has replaced is work, not a no-op", () => {
  // The three states a document can be in, and the reason the middle one had
  // to exist: "filed" alone reported a knowledge-v1 page as done, so nothing
  // ever offered to bring it forward and improving the authoring pass reached
  // existing readers only through an operator running a command.
  const plan = planBackfill([
    candidate({ paperId: "current", filed: true, stale: false }),
    candidate({ paperId: "behind", filed: true, stale: true }),
    candidate({ paperId: "never", filed: false }),
  ]);

  assert.deepEqual(
    plan.queue.map((item) => item.paperId),
    ["behind", "never"],
  );
  assert.equal(plan.outdated, 1);
  // Filed *and* current. A stale document is filed and in the queue, so
  // counting it here too would report the same document as both work to do and
  // work already done.
  assert.equal(plan.alreadyFiled, 1);
});

const DROPPED = [{ slug: "masked-diffusion", title: "Masked diffusion", reason: "The passage does not say this." }];

test("a current filing whose last job dropped a page is filed again", () => {
  const plan = planBackfill([
    candidate({ paperId: "clean", filed: true }),
    candidate({ paperId: "short", filed: true, dropped: DROPPED }),
  ]);

  assert.deepEqual(
    plan.queue.map((item) => item.paperId),
    ["short"],
  );
  assert.equal(plan.dropped, 1);
  assert.equal(plan.outdated, 0);
  assert.equal(plan.alreadyFiled, 1);
  assert.equal(describePlanAction(plan), "Rewrite 1 document");
  assert.match(describePlan(plan, 2), /1 has a page the last filing could not write/);
  assert.doesNotMatch(describePlan(plan, 2), /to file/);
});

test("a library that is entirely behind is rewritten, not filed", () => {
  const plan = planBackfill([
    candidate({ paperId: "a", filed: true, stale: true }),
    candidate({ paperId: "b", filed: true, stale: true }),
  ]);

  // Nothing here is missing from the wiki, so a button reading "File 2
  // documents" would describe work the reader has already done.
  assert.equal(describePlanAction(plan), "Rewrite 2 documents");
  assert.match(describePlan(plan, 2), /2 were written by an earlier version/);
  assert.doesNotMatch(describePlan(plan, 2), /to file/);

  // With both kinds present the two halves are named separately.
  const mixed = planBackfill([
    candidate({ paperId: "a", filed: true, stale: true }),
    candidate({ paperId: "b", filed: false }),
  ]);
  assert.equal(describePlanAction(mixed), "File 2 documents");
  assert.match(describePlan(mixed, 2), /1 document to file/);
  assert.match(describePlan(mixed, 2), /1 was written by an earlier version/);
});

test("the plan counts the expensive half separately", () => {
  const plan = planBackfill([
    candidate({ paperId: "a", digestReady: true }),
    candidate({ paperId: "b", digestReady: false }),
    candidate({ paperId: "c", digestReady: false }),
    // Already filed, so its missing digest is not work this run will do.
    candidate({ paperId: "d", digestReady: false, filed: true }),
  ]);

  // The ingest re-reads a digest and is cheap; building one is a whole-document
  // read. Three documents and two document-reads are different prices, and the
  // reader is owed the second number before they agree to it.
  assert.equal(plan.total, 3);
  assert.equal(plan.needDigest, 2);
  assert.match(describePlan(plan, 4), /2 have to be read first/);
  assert.match(describePlan(plan, 4), /1 already up to date/);
});

test("a library that is entirely filed says so instead of offering work", () => {
  const plan = planBackfill([candidate({ filed: true })]);

  assert.equal(plan.total, 0);
  assert.equal(describePlan(plan, 1), "All 1 document is already in your Memory.");
  assert.equal(describePlan(planBackfill([]), 0), "No documents in your library yet.");
});

test("the bar never divides by zero or overshoots", () => {
  assert.equal(backfillFraction(IDLE), 1);
  assert.equal(backfillFraction({ ...IDLE, total: 4 }), 0);
  assert.equal(backfillFraction({ ...IDLE, total: 2, processed: 1 }), 0.5);
  // Three workers racing past the end of the queue must not push it past full.
  assert.equal(backfillFraction({ ...IDLE, total: 2, processed: 3 }), 1);
});

test("a filing stage never quotes the provider's own queue at the reader", () => {
  assert.equal(
    describeFilingStage("Waiting for Flex capacity", "Kimi K3"),
    "Waiting for model capacity",
  );
  assert.equal(
    describeFilingStage("Waiting for Standard capacity"),
    "Waiting for model capacity",
  );
});

test("a filing stage does not repeat the title of the row it sits in", () => {
  assert.equal(
    describeFilingStage(
      "Planning how to teach On-Policy Distillation",
      "On-Policy Distillation",
    ),
    "Planning how to teach it",
  );
  assert.equal(
    describeFilingStage("Reading DeepSeek from V3 to V3.2", "DeepSeek from V3 to V3.2"),
    "Reading the document",
  );
  assert.equal(
    describeFilingStage("Indexing evidence in Kimi K3", "Kimi K3"),
    "Indexing evidence in it",
  );
  assert.equal(
    describeFilingStage("Building research digest for Kimi K3", "Kimi K3"),
    "Building research digest",
  );
  assert.equal(describeFilingStage("Checking Kimi K3", "Kimi K3"), "Checking the document");
  assert.equal(
    describeFilingStage("Correcting the filing for Kimi K3", "Kimi K3"),
    "Correcting the filing",
  );
});

test("an unrecognised stage is still shown, because it is the sign of life", () => {
  assert.equal(
    describeFilingStage("Capturing figure 3", "Kimi K3"),
    "Capturing figure 3",
  );
  assert.equal(describeFilingStage("   ", "Kimi K3"), "");
});

function job(overrides: Partial<MaintenanceQueueJob> = {}): MaintenanceQueueJob {
  return {
    id: "j1",
    kind: "document",
    status: "leased",
    label: "MDLM",
    lastError: null,
    leaseExpiresAt: "2026-08-31T12:00:00+00:00",
    ...overrides,
  };
}

function queueOf(jobs: MaintenanceQueueJob[], maxAttempts = 3) {
  return { jobs, maxAttempts };
}

test("a lease nobody is holding any more is queued, not in flight", () => {
  // The drain leases for the whole model timeout, so a tab that navigated away
  // leaves rows at `leased` for a quarter of an hour with nothing behind them.
  // Counting those as running is what let a three-worker run claim sixteen
  // documents were filing at once, every one of them frozen.
  const state = backfillFromQueue(
    queueOf([
      job({ id: "live", label: "Alive", leaseExpiresAt: "2026-08-31T12:10:00+00:00" }),
      job({ id: "dead", label: "Abandoned", leaseExpiresAt: "2026-08-31T11:50:00+00:00" }),
      job({ id: "never", label: "Waiting", status: "pending", leaseExpiresAt: null }),
    ]),
    0,
    new Map(),
    "2026-08-31T12:00:00+00:00",
  );
  assert.deepEqual(state.filing, ["Alive"]);
  // Still counted — the work is outstanding either way, so the bar must not
  // shrink when a lease lapses.
  assert.equal(state.total, 3);
  assert.equal(state.running, true);
});

test("a running job shows what it is doing, not a permanent Starting", () => {
  // The queue row cannot carry a stage; only the tab holding the stream knows
  // one. Without this the card printed its fallback for the whole of a filing,
  // which is minutes per document, and every row read as hung.
  const state = backfillFromQueue(
    queueOf([
      job({ id: "live", label: "Alive", leaseExpiresAt: "2026-08-31T12:10:00+00:00" }),
      job({ id: "other", label: "Elsewhere", leaseExpiresAt: "2026-08-31T12:10:00+00:00" }),
    ]),
    0,
    new Map([["live", "Writing the pages"]]),
    "2026-08-31T12:00:00+00:00",
  );
  assert.equal(state.stages.Alive, "Writing the pages");
  // A job another browser is running has no stage here, and saying nothing is
  // honest where inventing one would not be.
  assert.equal(state.stages.Elsewhere, undefined);
});

test("only document jobs are an Update's progress", () => {
  // A session filing itself and a domain being written are work nobody
  // pressed Update for.
  const state = backfillFromQueue(
    queueOf([
      job({ id: "doc", label: "A document", status: "pending", leaseExpiresAt: null }),
      job({ id: "talk", kind: "session", label: "A session", status: "pending", leaseExpiresAt: null }),
      job({ id: "place", kind: "domain", label: "A domain", status: "pending", leaseExpiresAt: null }),
      job({ id: "pair", kind: "reconcile", label: "A disagreement", status: "pending", leaseExpiresAt: null }),
    ]),
    0,
    new Map(),
    "2026-08-31T12:00:00+00:00",
  );
  assert.equal(state.total, 1);
});

test("a page that never landed is neither new work nor an aging page", () => {
  // Folding it into "to file" told somebody whose library is entirely filed
  // that documents were missing from it; folding it into the rewrite count
  // said their page was written by an earlier version of Delphi, which is a
  // sentence they can check and find false about a page never written.
  const plan = planBackfill([
    candidate({ paperId: "fresh", filed: false }),
    candidate({ paperId: "aged", filed: true, stale: true, filedVersion: "knowledge-v5" }),
    candidate({ paperId: "short", filed: true, dropped: DROPPED, filedVersion: "knowledge-v6" }),
    // Behind and short at once is one rewrite, counted once.
    candidate({ paperId: "both", filed: true, stale: true, dropped: DROPPED, filedVersion: "knowledge-v5" }),
    candidate({ paperId: "current", filed: true, filedVersion: "knowledge-v6" }),
  ]);

  assert.equal(plan.total, 4);
  assert.equal(plan.outdated, 2);
  assert.equal(plan.dropped, 1);
  assert.equal(plan.alreadyFiled, 1);
  assert.match(describePlan(plan, 5), /1 document to file/);
  assert.match(describePlan(plan, 5), /2 were written by an earlier version/);
  assert.match(describePlan(plan, 5), /1 has a page the last filing could not write/);
  assert.equal(describePlanAction(plan), "File 4 documents");
});

test("chat and digest progress never name a service tier", async () => {
  const { describeModelWait } = await import("../app/lib/backfill.ts");
  assert.equal(describeModelWait("Waiting for Standard capacity"), "Waiting for model capacity");
  assert.equal(describeModelWait("Waiting for Flex capacity"), "Waiting for model capacity");
  assert.equal(describeModelWait("Response started"), "Response started");
});

const NOW = "2026-08-31T12:00:00+00:00";

function failedJob(id: string, cause: string, overrides: Partial<MaintenanceQueueJob> = {}): MaintenanceQueueJob {
  return job({
    id,
    label: id,
    status: "failed",
    leaseExpiresAt: null,
    retryAt: null,
    attempts: 3,
    lastError: `${cause} detail`,
    payload: { projectId: "p1", paperId: `paper-${id}` },
    failure: { cause: cause as never, failedAt: "2026-08-31T11:00:00Z", pages: [] },
    ...overrides,
  });
}

test("a document still retrying is not a failure, and one that gave up says why", () => {
  const state = backfillFromQueue(
    queueOf([
      failedJob("muon", "check", {
        failure: { cause: "check", failedAt: "2026-08-31T11:00:00Z", pages: [{ title: "Muon optimizer", reason: "Stronger than the source." }] },
      }),
      failedJob("adam", "provider", { lastError: "Client error '429 Too Many Requests'" }),
      failedJob("old", "unknown", { failure: null, lastError: null }),
      failedJob("kimi", "provider", { retryAt: "2026-08-31T12:05:00+00:00", attempts: 1 }),
      job({ id: "doing", label: "Doing", leaseExpiresAt: "2026-08-31T12:10:00+00:00" }),
    ]),
    2,
    new Map(),
    NOW,
  );
  assert.deepEqual(
    state.failures.map(({ jobId, cause, pages, detail, projectId, paperId }) => [jobId, cause, pages.length, detail, projectId, paperId]),
    [
      ["muon", "check", 1, "check detail", "p1", "paper-muon"],
      ["adam", "provider", 0, "Client error '429 Too Many Requests'", "p1", "paper-adam"],
      // A row from before causes were recorded, and with no error at all.
      ["old", "unknown", 0, "", "p1", "paper-old"],
    ],
  );
  assert.deepEqual(state.retrying, [
    { jobId: "kimi", title: "kimi", cause: "provider", projectId: "p1", paperId: "paper-kimi", retryAt: "2026-08-31T12:05:00+00:00", attempt: 2, maxAttempts: 3 },
  ]);
  // Gave-up documents are finished; the retrying one and the one in flight are not.
  assert.equal(state.processed, 2 + 3);
  assert.equal(state.total, 2 + 3 + 1 + 1);
  assert.equal(state.running, true);
});

test("the run card reports its phase from what is left", () => {
  const base = { ...IDLE, filed: 33, processed: 40, total: 41 };
  const failures = backfillFromQueue(
    queueOf([failedJob("a", "check"), failedJob("b", "provider"), failedJob("c", "provider")]),
    0,
    new Map(),
    NOW,
  ).failures;
  const retrying = [{ jobId: "r", title: "r", cause: "provider" as const, retryAt: "2026-08-31T12:05:00+00:00", attempt: 2, maxAttempts: 3 }];

  assert.equal(describeRun(IDLE), null);
  assert.deepEqual(describeRun({ ...base, running: true, processed: 12, total: 40 }), {
    phase: "running",
    title: "Updating your Memory",
    detail: "12 of 40 documents finished.",
    pill: { label: "Updating your Memory", detail: "12 of 40" },
  });
  // Only retrying: the queue will try again on its own, so the run is still going.
  const waiting = describeRun({ ...base, processed: 38, total: 40, retrying: [...retrying, { ...retrying[0]!, jobId: "s" }] });
  assert.equal(waiting?.phase, "running");
  assert.equal(waiting?.detail, "38 of 40 documents finished · 2 retrying.");
  // Something gave up: a result, with what still retries counted beside it.
  assert.deepEqual(describeRun({ ...base, failures, retrying }), {
    phase: "failed",
    title: "33 documents filed",
    detail: "33 filed · 3 failed · 1 retrying. The rest is saved.",
    pill: { label: "3 failed", detail: "" },
  });
  assert.deepEqual(describeRun({ ...IDLE, failures: failures.slice(0, 1) }), {
    phase: "failed",
    title: "1 document failed",
    detail: "Your Memory was not changed.",
    pill: { label: "1 failed", detail: "" },
  });
  // Nothing filed and some still retrying: those are counted all the same.
  assert.equal(describeRun({ ...IDLE, failures: failures.slice(0, 1), retrying })?.detail, "1 retrying. Your Memory was not changed.");
  assert.equal(describeRun({ ...base, filed: 1 })?.detail, "1 filed.");
  assert.equal(describeRun({ ...base, filed: 1 })?.phase, "done");
});

test("a retrying document says when its next try is, and which", () => {
  const document = { jobId: "r", title: "r", cause: "provider" as const, retryAt: "2026-08-31T12:05:00+00:00", attempt: 2, maxAttempts: 3 };
  const before = Date.parse("2026-08-31T12:00:00+00:00");
  assert.match(describeRetry(document, before), /^Next try \d\d:\d\d · try 2 of 3$/);
  // Its time has come and no drain has taken it yet.
  assert.equal(describeRetry(document, Date.parse("2026-08-31T12:06:00+00:00")), "Next try soon · try 2 of 3");
  assert.equal(describeRetry({ ...document, maxAttempts: undefined }, Date.parse("2026-08-31T12:06:00+00:00")), "Next try soon");
});

test("a dismissed failure is one failure: failing again, or a new run, is news", () => {
  const failed = job({
    status: "failed", retryAt: null, updatedAt: "2026-08-31T12:00:00Z",
    failure: { cause: "provider", failedAt: "2026-08-31T11:00:00Z", pages: [] },
  });
  assert.equal(failureKey(failed), "j1@2026-08-31T11:00:00Z");
  // Re-enqueued while failed, the row moves on; the failure is the same.
  assert.equal(failureKey({ ...failed, updatedAt: "2026-08-31T13:00:00Z" }), failureKey(failed));
  // Tried again and failed again: another failure.
  assert.notEqual(failureKey({ ...failed, failure: { ...failed.failure!, failedAt: "2026-08-31T13:00:00Z" } }), failureKey(failed));
  // A row the server sent no failure for is named by its update.
  assert.equal(failureKey({ ...failed, failure: null }), "j1@2026-08-31T12:00:00Z");
  // Only a failure is ever dismissed: work under way never is.
  assert.equal(failureKey(job()), "");
  assert.equal(failureKey(job({ status: "pending" })), "");
});
