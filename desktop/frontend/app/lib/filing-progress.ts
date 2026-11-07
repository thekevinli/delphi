/**
 * What a document's filing is doing, in steps a reader can follow.
 *
 * The pass streams free-text stage messages ("Reading what there is to file",
 * "Deciding where it belongs in Memory", "Reading Memory and writing what
 * belongs in it", "Checking what was written against its sources"). This module
 * folds them into a short, ordered list of steps, so the rail can say *where* a
 * filing is as well as what it last said. The steps are data, not markup: a
 * pass that grows a step adds an entry here, and a stage event that names its
 * step outright (`step`, matched against `id`) is taken at its word before any
 * wording is read — which is how a future harness can add steps without the
 * reader's vocabulary having to guess them.
 *
 * Every event also carries the machine name of the stage that sent it, and
 * that is read before the sentence is. It has to be: the pass opens by making
 * sure the document has a digest, and that phase says "Checking <title>" and
 * "Writing the digest" — the vocabulary of the last two steps, spoken during
 * the first. Read by wording alone, a filing sat on the final step from its
 * first second to its last.
 */

import type { MaintenanceJob } from "./api.ts";

export type FilingStep = {
  id: string;
  label: string;
  /** The stages, by the name each event carries, that belong to this step. */
  stages: RegExp;
  /** Stage wording that belongs to this step, for events that carry no name. */
  match: RegExp;
};

export const FILING_STEPS: FilingStep[] = [
  {
    id: "read",
    label: "Read the document",
    // Re-reading the web pages an answer cited, or reaching outside the library
    // after the choice, is more reading; after the choice it stays on the choice.
    stages: /^(digest_|file_upload$|memory_gather$|memory_outside$)/,
    match: /^(reading|preparing (research digest|paper context|project context|it|the document))/i,
  },
  { id: "plan", label: "Choose the pages", stages: /^memory_select$/, match: /^(planning|deciding)/i },
  {
    id: "write",
    label: "Write the pages",
    // A page rewrite is the same author on one page, and a domain's page is
    // composed rather than chosen, each under its own stage name.
    stages: /^(memory_maintain|memory_author|memory_domain)$/,
    match: /^(writing|binding|drafting|composing)/i,
  },
  {
    id: "check",
    label: "Check against the source",
    stages: /^memory_verify$/,
    match: /^(checking|correcting|verifying)/i,
  },
];

/**
 * Which step a stage belongs to, given the step it was already on.
 *
 * Never moves backwards — a pass that re-reads a table while writing is still
 * writing — and a message no step claims keeps the step it was on, because an
 * unfamiliar sentence is a sign of life, not a reason to reset the reader's
 * sense of how far along it is. A named stage settles it either way: one no
 * step claims (a wait on the model, a stream of characters) keeps the step,
 * and its wording is not consulted.
 */
export function filingStepIndex(
  message: string,
  previous = 0,
  step?: string | null,
  stage?: string | null,
  steps: FilingStep[] = FILING_STEPS,
): number {
  const named = step ? steps.findIndex((item) => item.id === step) : -1;
  if (named >= 0) return Math.max(previous, named);
  if (stage) {
    const staged = steps.findIndex((item) => item.stages.test(stage));
    return staged >= 0 ? Math.max(previous, staged) : previous;
  }
  const text = (message || "").trim();
  const matched = steps.findIndex((item) => item.match.test(text));
  return matched >= 0 ? Math.max(previous, matched) : previous;
}

// Shared with the chat's waiting line; re-exported so the filing card's
// vocabulary stays in one import.
export { isCapacityWait } from "./backfill.ts";

export { formatClock as formatElapsed } from "./clock.ts";

const DOCUMENT_KINDS = new Set(["document"]);

type QueueJob = Pick<MaintenanceJob, "id" | "kind" | "status" | "label" | "leaseExpiresAt"> & {
  marker?: string;
  payload?: MaintenanceJob["payload"];
};

export type QueueRow = {
  id: string;
  title: string;
  running: boolean;
  self: boolean;
  /** 1-based place among the documents still waiting; 0 while running. */
  position: number;
};

/** A claim whose lease is live: a tab is filing it now. */
export function isRunningJob(job: Pick<MaintenanceJob, "status" | "leaseExpiresAt">, now: string): boolean {
  return job.status === "leased" && (job.leaseExpiresAt ?? "") > now;
}

/**
 * Does this queue row file this document?
 *
 * By id only: the payload names the paper, and the marker is `paper:<id>` or
 * one of its follow-ups. A title is not an identity, and the same paper in two
 * projects would otherwise mark both rows.
 */
export function isJobFor(job: QueueJob, paper: { id: string }): boolean {
  if (!DOCUMENT_KINDS.has(job.kind) || !paper.id) return false;
  if (job.payload?.paperId) return job.payload.paperId === paper.id;
  const marker = `paper:${paper.id}`;
  return job.marker === marker || Boolean(job.marker?.startsWith(`${marker}:`));
}

/**
 * The documents in line, in the order they will be filed: the ones being
 * filed now first, then the waiting ones in the queue's own order. Failed
 * jobs are Health's business, and a lapsed lease is waiting, not running.
 */
export function queueLine(
  jobs: QueueJob[],
  paper: { id: string; title: string },
  now: string,
): QueueRow[] {
  const documents = jobs.filter((job) => DOCUMENT_KINDS.has(job.kind) && job.status !== "failed");
  const running = documents.filter((job) => isRunningJob(job, now));
  const waiting = documents.filter((job) => !isRunningJob(job, now));
  return [
    ...running.map((job) => ({ id: job.id, title: job.label, running: true, self: isJobFor(job, paper), position: 0 })),
    ...waiting.map((job, index) => ({
      id: job.id,
      title: job.label,
      running: false,
      self: isJobFor(job, paper),
      position: index + 1,
    })),
  ];
}

/** How many documents will be filed before this one. */
export function documentsAhead(line: QueueRow[]): number {
  const index = line.findIndex((row) => row.self);
  return index < 0 ? line.length : index;
}

/**
 * A filing card that has stopped moving: a tone for its mark, two lines, at
 * most one verb, and whatever explains it. Every way the card can settle is
 * one of these, so the rail draws them all with the same chrome.
 */
export type SettledFiling = {
  /** "attention" when something did not finish; "info" when there is only something to do. */
  tone: "attention" | "info";
  title: string;
  subtitle: string;
  pages?: { key: string; title: string; reason: string }[];
  action: string;
  /** Primary when the card exists for this verb; secondary when it is optional, as updating an older pass is. */
  primary: boolean;
  note: string;
};

type FilingRecord = {
  filed: boolean;
  stuck: boolean;
  stale: boolean;
  dropped: { slug: string; title: string; reason: string }[];
};

/**
 * A document with its page that is still owed something: a page its last job
 * could not write, a job that gave up, or a newer pass. A page can be dropped
 * at the check or for want of room while writing, so the card names no step.
 */
export function outdatedFiling(record: FilingRecord): SettledFiling | null {
  const { dropped } = record;
  if (dropped.length) {
    return {
      tone: "attention",
      title: dropped.length === 1 ? "A page wasn’t written" : `${dropped.length} pages weren’t written`,
      subtitle: "Each is listed with the reason it was left out",
      pages: dropped.map((page) => ({ key: page.slug, title: page.title || page.slug, reason: page.reason })),
      action: "Retry document",
      primary: true,
      note: "The rest of this document is in Memory.",
    };
  }
  // Its page comes from the digest, which can be written before a later stage gives up.
  if (record.stuck) {
    return {
      tone: "attention",
      title: "Filing didn’t finish",
      subtitle: record.filed ? "What it filed before is still in Memory" : "Only its own page is in Memory so far",
      action: "Try again",
      primary: true,
      note: "Trying again starts the filing from the beginning.",
    };
  }
  if (!record.stale) return null;
  return {
    tone: "info",
    title: "Written by an older Delphi",
    subtitle: "Update this document in Memory when you’re ready.",
    action: "Update document",
    primary: false,
    note: "Delphi now writes Memory differently.",
  };
}

/** A document with no page yet. A past outcome outranks the default invitation. */
export function unfiledFiling(record: FilingRecord | null, filedHere: boolean): SettledFiling {
  if (record?.stuck) {
    return {
      tone: "attention",
      title: "Filing didn’t finish",
      subtitle: "Nothing from this document is in Memory yet",
      action: "Try again",
      primary: true,
      note: "Trying again starts the filing from the beginning.",
    };
  }
  if (filedHere || record?.filed) {
    return {
      tone: "info",
      title: "No page written from it yet",
      subtitle: "Delphi has read this document, but no page cites it.",
      action: "File it again",
      primary: true,
      note: "Files in the background. Keep reading.",
    };
  }
  return {
    tone: "info",
    title: "Not in your Memory yet",
    subtitle: "There is nothing to relate it to until it’s filed.",
    action: "File it now",
    primary: true,
    note: "Files in the background. Keep reading.",
  };
}
