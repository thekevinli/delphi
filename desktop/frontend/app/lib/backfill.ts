/**
 * The bookkeeping behind Memory's Update button.
 *
 * Filing a library that predates the wiki is the one operation here whose cost
 * the reader should see before they agree to it, because it is the one where
 * the expensive half is invisible: the ingest re-reads a digest and is cheap,
 * while a document with no digest has to be read end to end first. The two are
 * an order of magnitude apart, so "47 documents" is not the number that matters
 * — "21 of them have never been read" is.
 *
 * Kept JSX-free and dependency-free so `node --test` can strip the types and
 * run it directly; the component owns the requests and this owns the counting.
 */

import type { JobFailure } from "./api.ts";
import { type FailureCause, causeOf } from "./filing-failure.ts";

/** One document, with the two facts that decide what filing it costs. */
export type BackfillCandidate = {
  projectId: string;
  paperId: string;
  projectName: string;
  title: string;
  /** False means a whole-document read has to happen before the ingest can. */
  digestReady: boolean;
  /** Already in the wiki. Filing it again would spend a model call to no end. */
  filed: boolean;
  /**
   * In the wiki, but written by a pass Delphi has since replaced.
   *
   * Neither of the two states above: not work the wiki has never seen, and not
   * work already done to the standard it is done to now. Without it a document
   * filed under an older pass reports `filed` and nothing ever offers to bring
   * it forward, which is what made improving the authoring pass an operator's
   * migration rather than a reader's press.
   */
  stale: boolean;
  /**
   * What its last job staged and could not write. A document with any entry
   * is current and still owed that page, so the press files it again.
   */
  dropped: Array<{ slug: string; title: string; reason: string }>;
  /** Which pass wrote it, or null where it predates the stamp. */
  filedVersion: string | null;
};

export type BackfillPlan = {
  /** Everything the run will actually request, in order. */
  queue: BackfillCandidate[];
  total: number;
  /**
   * In the library, filed, and filed by the pass that runs now — so skipped.
   *
   * Deliberately not "filed": a stale document is filed *and* in the queue, so
   * counting it here as well would have the card report the same document
   * twice, once as work to do and once as work already done.
   */
  alreadyFiled: number;
  /** Of the queue, how many are rewrites rather than first filings. */
  outdated: number;
  /**
   * Filed by the pass that runs now, and still owed a page its last job could
   * not write. Split out from `outdated` because the words differ: one is a
   * page being rewritten by a better pass, the other a page that never landed.
   */
  dropped: number;
  /** Of the queue, how many need a document read first — the slow ones. */
  needDigest: number;
};

export type BackfillState = {
  running: boolean;
  processed: number;
  total: number;
  /** Titles in flight right now, so a long run shows it is still moving. */
  filing: string[];
  /** Latest server-authored stage for each title currently in flight. */
  stages: Record<string, string>;
  filed: number;
  /** Documents whose filing gave up, each with why. */
  failures: FailedDocument[];
  /** Documents that failed with tries left. Due again on their own, so not failures. */
  retrying: RetryingDocument[];
};

/** A document on the run card: its job, why its last try failed, and where it lives. */
export type RunDocument = {
  jobId: string;
  title: string;
  cause: FailureCause;
  projectId?: string;
  paperId?: string;
};

/** A document whose filing gave up, and what the reader is told about it. */
export type FailedDocument = RunDocument & {
  /** For a check that refused it: the pages, and why each was refused. */
  pages: JobFailure["pages"];
  /** The error itself: the technical detail behind the cause. */
  detail: string;
};

/** A document waiting out its backoff, and which of its tries comes next. */
export type RetryingDocument = RunDocument & {
  retryAt: string;
  attempt: number;
  maxAttempts?: number;
};

/**
 * The progress card, read from the queue rather than from the tab.
 *
 * `BackfillState` was written for a run this browser was performing, so every
 * number in it came from a loop in one component — which is exactly why
 * leaving the page destroyed it, and why a second tab watching the same
 * account saw nothing at all. Filing is durable work now, so the same shape is
 * derived from `GET /maintenance`: the counts belong to the account, every tab
 * shows the same run, and a reload picks it up where it stands.
 *
 * `total` is what this filing still has to get through plus what it already
 * did, not the library's size — a queue is what remains, so counting anything
 * else would make the bar move backwards as work arrives.
 */
export function backfillFromQueue(
  queue: { jobs: MaintenanceQueueJob[]; maxAttempts?: number } | null,
  filed: number,
  stages: Map<string, string> = new Map(),
  now: string = new Date().toISOString(),
): BackfillState {
  if (!queue) return IDLE;
  // Only document filing belongs on this card. A `domain` rewrite is
  // maintenance the reader never asked for by name, and a `session` job is a
  // conversation filing itself; putting either here would report work nobody
  // pressed a button for as part of their Update.
  const papers = queue.jobs.filter((job) => job.kind === "document");
  // A lease outlives the tab that took it: the drain holds one for the whole
  // model timeout, so a reader who navigated away leaves rows sitting at
  // `leased` for a quarter of an hour with nothing running behind them. Those
  // are waiting to be reclaimed, not filing, and listing them as in flight is
  // what made a three-worker run report sixteen documents in progress — all of
  // them frozen, because thirteen of them were nobody's.
  const running = (job: MaintenanceQueueJob) =>
    job.status === "leased" && (job.leaseExpiresAt ?? "") > now;
  const active = papers.filter(running);
  const waiting = papers.filter(
    (job) => job.status === "pending" || (job.status === "leased" && !running(job)),
  );
  // A failure with a time to try again is still the queue's to finish: it is
  // retrying, and only a job that has stopped trying is a failure.
  const document = (job: MaintenanceQueueJob): RunDocument => ({
    jobId: job.id,
    title: job.label,
    cause: causeOf(job),
    projectId: job.payload?.projectId ?? undefined,
    paperId: job.payload?.paperId ?? undefined,
  });
  const retrying = papers
    .filter((job) => job.status === "failed" && job.retryAt)
    .map((job) => ({
      ...document(job),
      retryAt: job.retryAt!,
      attempt: (job.attempts ?? 0) + 1,
      maxAttempts: queue.maxAttempts,
    }));
  const failures = papers
    .filter((job) => job.status === "failed" && !job.retryAt)
    .map((job) => ({ ...document(job), pages: job.failure?.pages ?? [], detail: job.lastError ?? "" }));
  return {
    running: active.length > 0 || waiting.length > 0,
    // A document that gave up is finished too: the bar measures what is left.
    processed: filed + failures.length,
    total: filed + active.length + waiting.length + retrying.length + failures.length,
    filing: active.map((job) => job.label),
    // The queue records what a job *is*, not what its model call is saying
    // this second — that lives in the stream the drain is holding, and reaches
    // here through `memoryStages()`. A job this tab is not the one running
    // simply has no entry, and the row falls back to "Starting…", which is the
    // honest thing to say about work somebody else's browser is doing.
    stages: Object.fromEntries(
      active
        .map((job) => [job.label, stages.get(job.id) ?? ""] as const)
        .filter(([, stage]) => stage !== ""),
    ),
    filed,
    failures,
    retrying,
  };
}

/** The fields of a queue row this module reads. */
export type MaintenanceQueueJob = {
  id: string;
  kind: string;
  status: string;
  label: string;
  lastError: string | null;
  /** When the claim lapses. Absent on a row that was never claimed. */
  leaseExpiresAt?: string | null;
  /** When a failed job is due again; null once it has given up. */
  retryAt?: string | null;
  attempts?: number;
  payload?: { projectId?: string | null; paperId?: string | null };
  failure?: JobFailure | null;
  updatedAt?: string;
};

/**
 * One failure of one job, as a dismissed card remembers it: a job tried again
 * that fails again is a new failure, and a failed row re-enqueued for another
 * reason is not. Empty for a job that has not failed.
 */
export function failureKey(job: MaintenanceQueueJob): string {
  return job.status === "failed" ? `${job.id}@${job.failure?.failedAt ?? job.updatedAt ?? ""}` : "";
}

export const IDLE: BackfillState = {
  running: false,
  processed: 0,
  total: 0,
  filing: [],
  stages: {},
  filed: 0,
  failures: [],
  retrying: [],
};

/**
 * Decide what a run will do.
 *
 * Three kinds of work, one queue: documents the wiki has never seen,
 * documents it saw through a pass that has since been replaced, and documents
 * whose last job dropped a page. The server's `stale` and `dropped` are the
 * only definition of "worth refiling", which is what stops the badge here and
 * the skip test there drifting apart.
 */
export function planBackfill(candidates: BackfillCandidate[]): BackfillPlan {
  const owesPage = (item: BackfillCandidate) => item.dropped.length > 0;
  const queue = candidates.filter(
    (item) => !item.filed || item.stale || owesPage(item),
  );
  return {
    queue,
    total: queue.length,
    alreadyFiled: candidates.length - queue.length,
    outdated: queue.filter((item) => item.filed && item.stale).length,
    dropped: queue.filter((item) => item.filed && !item.stale && owesPage(item)).length,
    needDigest: queue.filter((item) => !item.digestReady).length,
  };
}

/**
 * What the confirmation says before anything is spent.
 *
 * Deliberately names the slow half rather than a single duration: how long a
 * document read takes is not something the browser can know, and a made-up
 * minute count that turns out to be wrong is worse than an honest "this is the
 * part that takes a while".
 */
export function describePlan(plan: BackfillPlan, library: number): string {
  if (library === 0) return "No documents in your library yet.";
  if (plan.total === 0) {
    return `All ${library} document${library === 1 ? " is" : "s are"} already in your Memory.`;
  }
  const firstFilings = plan.total - plan.outdated - plan.dropped;
  const parts: string[] = [];
  // The two halves are named separately because they are different promises.
  // "To file" is work the wiki has never seen; a rewrite is a page the reader
  // already has, being written again by a better pass — and folding them into
  // one number would tell somebody whose library is entirely filed that they
  // have eleven documents missing from it.
  if (firstFilings > 0) {
    parts.push(
      `${firstFilings} document${firstFilings === 1 ? "" : "s"} to file`,
    );
  }
  if (plan.outdated > 0) {
    parts.push(
      `${plan.outdated} ${plan.outdated === 1 ? "was" : "were"} written by an earlier version of Delphi`,
    );
  }
  if (plan.dropped > 0) {
    parts.push(
      `${plan.dropped} ${plan.dropped === 1 ? "has" : "have"} a page the last filing could not write`,
    );
  }
  if (plan.alreadyFiled > 0) {
    parts.push(`${plan.alreadyFiled} already up to date`);
  }
  if (plan.needDigest > 0) {
    parts.push(
      `${plan.needDigest} ${plan.needDigest === 1 ? "has" : "have"} to be read first, which is the slow part`,
    );
  }
  return `${parts.join(" · ")}.`;
}

/**
 * What the button says, which is not always "file".
 *
 * A reader whose library is entirely filed and merely behind is not filing
 * anything — they are asking for pages they already have to be rewritten by a
 * pass that did not exist when those pages were written. Calling that "File 8
 * documents" describes work they have already done.
 */
export function describePlanAction(plan: BackfillPlan): string {
  if (plan.total === 0) return "OK";
  if (plan.outdated + plan.dropped === plan.total) {
    return `Rewrite ${plan.total} document${plan.total === 1 ? "" : "s"}`;
  }
  return `File ${plan.total} document${plan.total === 1 ? "" : "s"}`;
}

/** When a retrying document's next try is, and which try that is: "Next try 14:32 · try 2 of 3". */
export function describeRetry(document: RetryingDocument, now = Date.now()): string {
  const at = new Date(document.retryAt);
  const when = at.getTime() > now
    ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
    : "soon";
  const which = document.maxAttempts ? ` · try ${document.attempt} of ${document.maxAttempts}` : "";
  return `Next try ${when}${which}`;
}

/** What the run card says: its phase, its title and detail, and the pill it shrinks to. */
export type RunSummary = {
  phase: "running" | "failed" | "done";
  title: string;
  detail: string;
  pill: { label: string; detail: string };
};

/**
 * The run card, or null when there is no run to report.
 *
 * Retrying is still running while nothing has given up: the queue tries again
 * on its own and the reader has nothing to do. Once a document has given up,
 * the card reports the result, with what still retries listed beside it.
 */
export function describeRun(state: BackfillState): RunSummary | null {
  const failed = state.failures.length;
  const retrying = state.retrying.length;
  const documents = (count: number) => `${count} document${count === 1 ? "" : "s"}`;
  if (state.running || (retrying > 0 && failed === 0)) {
    return {
      phase: "running",
      title: "Updating your Memory",
      detail: `${state.processed} of ${state.total} documents finished${retrying > 0 ? ` · ${retrying} retrying` : ""}.`,
      pill: { label: "Updating your Memory", detail: `${state.processed} of ${state.total}` },
    };
  }
  if (failed > 0) {
    const counts = [
      state.filed > 0 ? `${state.filed} filed` : "",
      `${failed} failed`,
      retrying > 0 ? `${retrying} retrying` : "",
    ].filter(Boolean);
    return {
      phase: "failed",
      title: state.filed > 0 ? `${documents(state.filed)} filed` : `${documents(failed)} failed`,
      detail: state.filed > 0
        ? `${counts.join(" · ")}. The rest is saved.`
        : `${retrying > 0 ? `${retrying} retrying. ` : ""}Your Memory was not changed.`,
      pill: { label: `${failed} failed`, detail: "" },
    };
  }
  if (state.filed > 0) {
    return { phase: "done", title: "Memory updated", detail: `${state.filed} filed.`, pill: { label: "Memory updated", detail: "" } };
  }
  return null;
}

/**
 * The server's own stage, said the way the reader's surface needs it.
 *
 * Two things reach these frames that should not reach a reader. The provider's
 * queue is one — "Waiting for Flex capacity" names a service tier Delphi chose
 * and the reader never did. The document's title is the other: the frames are
 * written for a single-document stream where naming it is the only way to say
 * which document, and every surface that shows a *list* already has that title
 * in the row beside the stage, so relaying it verbatim prints the same words
 * twice across one line.
 *
 * Rewriting rather than dropping: the stage is the only sign a long filing is
 * still moving, so an unrecognised message is passed through bounded rather
 * than swallowed.
 */
/**
 * The provider's queue, said without its service tier. Delphi chose the tier,
 * and a ChatGPT connection has none, so the reader is told only that the model
 * has not started yet. Every surface that relays a server stage uses this.
 */
export function describeModelWait(message: string): string {
  return /waiting for (?:flex|standard) capacity/i.test(message) ? "Waiting for model capacity" : message;
}

/** The provider is out of capacity and the request is waiting to retry. */
export function isCapacityWait(message: string): boolean {
  return describeModelWait(message || "") !== (message || "");
}

export function describeFilingStage(message: string, title = ""): string {
  const raw = (message || "").trim();
  if (!raw) return "";
  if (describeModelWait(raw) !== raw) return describeModelWait(raw);
  let stage = raw;
  const name = title.trim();
  if (name.length > 2) {
    const pattern = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    stage = stage.replace(pattern, "it").trim();
  }
  stage = stage
    // "Correcting the filing for it" — the preposition only existed to carry
    // the title that is now gone.
    .replace(/\s+for it$/i, "")
    // "Reading it", "Checking it", "Preparing it": a bare pronoun where the
    // document used to be says less than the noun does, and these are the
    // frames a reader sees longest — the whole-document read is the slow half.
    .replace(/^([A-Za-z]+ing) it$/, "$1 the document")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!stage) return raw.length > 120 ? `${raw.slice(0, 117)}…` : raw;
  return stage.length > 120 ? `${stage.slice(0, 117)}…` : stage;
}

/** 0..1, for the bar. Zero-length runs read as complete rather than dividing by zero. */
export function backfillFraction(state: BackfillState): number {
  if (state.total <= 0) return 1;
  return Math.min(1, state.processed / state.total);
}
