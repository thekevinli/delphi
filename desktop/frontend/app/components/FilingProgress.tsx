"use client";

import { useEffect, useReducer, useState, useSyncExternalStore, type ReactNode } from "react";

import { api, type MaintenanceJob, type MaintenanceSnapshot } from "../lib/api";
import { describeFilingStage } from "../lib/backfill";
import { memoryPath } from "../lib/memory";
import { authorDate } from "../lib/memory-authorship";
import { causeOf, failureSentence } from "../lib/filing-failure";
import {
  FILING_STEPS,
  documentsAhead,
  formatElapsed,
  isCapacityWait,
  isJobFor,
  isRunningJob,
  queueLine,
  type SettledFiling,
} from "../lib/filing-progress";
import {
  memoryStageDetail,
  memoryStages,
  onMemoryFiled,
  onMemoryQueue,
  onMemoryStage,
} from "../lib/memory-maintenance";
import { NoticeMark, type NoticeState } from "./Notice";

/** How often the queue is re-read while a document is owed. */
const QUEUE_POLL_MS = 5000;
/** One line each, and no more than this many lines of queue. */
const LINE_LIMIT = 6;

type FilingPaper = { id: string; title: string };

/** A failed pass that is owed another try; one with no retry time has given up. */
function isRetrying(job: Pick<MaintenanceJob, "status" | "retryAt">): boolean {
  return job.status === "failed" && job.retryAt != null;
}

/**
 * One read of the queue for every surface in this tab that shows it.
 *
 * The library and the rail card ask the same question, and each polling on
 * its own was two timers for one answer, held for as long as a reader keeps
 * a tab open. So the read is shared, made only while something subscribes and
 * the tab is visible, and repeated only while a document is owed or a card
 * that exists because one is owed is showing (`watching`): its job can be
 * written after the card's first read. An idle queue moves when this tab's
 * drain says so, or when the reader comes back.
 */
const queue = {
  snapshot: null as MaintenanceSnapshot | null,
  text: "",
  listeners: new Set<() => void>(),
  watching: 0,
  reading: null as Promise<void> | null,
  timer: 0,
  unsubscribe: () => {},
};

function queueOwed(snapshot: MaintenanceSnapshot | null): boolean {
  return Boolean(
    // A retry's wait is minutes long and its claim is this tab's drain's news, so only work that can start now is polled for.
    snapshot?.jobs?.some((job) => job.kind === "document" && job.status !== "failed"),
  );
}

function readQueue(): Promise<void> {
  if (queue.reading) return queue.reading;
  window.clearTimeout(queue.timer);
  if (!queue.listeners.size || document.visibilityState === "hidden") return Promise.resolve();
  queue.reading = api<MaintenanceSnapshot>("/api/memory/maintenance")
    .then((answer) => {
      const text = JSON.stringify(answer);
      if (text === queue.text) return;
      queue.text = text;
      queue.snapshot = answer;
      for (const listener of queue.listeners) listener();
    })
    .catch(() => undefined)
    .finally(() => {
      queue.reading = null;
      if (queue.listeners.size && (queue.watching || queueOwed(queue.snapshot))) {
        queue.timer = window.setTimeout(() => void readQueue(), QUEUE_POLL_MS);
      }
    });
  return queue.reading;
}

const readWhenSeen = () => {
  if (document.visibilityState === "visible") void readQueue();
};

function subscribeQueue(listener: () => void, watching = false): () => void {
  // One registration for every surface: the callback is shared, so a surface removing its own would deafen the rest.
  if (!queue.listeners.size) {
    document.addEventListener("visibilitychange", readWhenSeen);
    window.addEventListener("focus", readWhenSeen);
    const stopQueue = onMemoryQueue(readWhenSeen);
    const stopFiled = onMemoryFiled(readWhenSeen);
    queue.unsubscribe = () => {
      stopQueue();
      stopFiled();
      document.removeEventListener("visibilitychange", readWhenSeen);
      window.removeEventListener("focus", readWhenSeen);
    };
  }
  queue.listeners.add(listener);
  if (watching) queue.watching += 1;
  // A surface that has just appeared asks once: it may be here because work was queued.
  void readQueue();
  return () => {
    queue.listeners.delete(listener);
    if (watching) queue.watching -= 1;
    if (queue.listeners.size) return;
    window.clearTimeout(queue.timer);
    queue.unsubscribe();
  };
}

const noSubscription = () => () => {};
const watchQueue = (listener: () => void) => subscribeQueue(listener, true);

function useQueueSnapshot(enabled: boolean, watching = false): MaintenanceSnapshot | null {
  return useSyncExternalStore(
    !enabled ? noSubscription : watching ? watchQueue : subscribeQueue,
    () => (enabled ? queue.snapshot : null),
    () => null,
  );
}

/** Which jobs this tab has heard a stage from, as one comparable value. */
function stageVersion(): string {
  return [...memoryStages().keys()].join(" ");
}

/**
 * Everything the card needs, read from the queue and from the stream the drain
 * holds: whether this document's job is running or waiting, what it last said,
 * which step that puts it on, and the documents around it in line.
 */
function useFilingProgress(paper: FilingPaper) {
  const snapshot = useQueueSnapshot(true, true);
  const [now, setNow] = useState(() => Date.now());
  const [, heard] = useReducer((count: number) => count + 1, 0);
  useEffect(() => onMemoryStage(heard), []);

  // The elapsed clock, while there is something to time.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const stamp = new Date(now).toISOString();
  const jobs = snapshot?.jobs ?? [];
  const job = jobs.find((item) => isJobFor(item, paper) && item.status !== "failed");
  const message = job ? memoryStages().get(job.id) ?? "" : "";
  const detail = job ? memoryStageDetail(job.id) : undefined;
  // A stage heard in this tab is proof the job is running even before the next
  // queue read says so; a live lease is proof without one (another tab, or the
  // first seconds of a claim).
  const running = Boolean(job && (message || isRunningJob(job, stamp)));
  // A pass that failed keeps its row and a time to try again. That document is
  // owed a retry, not a place behind the others, and it is not in the line.
  const failed = job ? undefined : jobs.find((item) => isJobFor(item, paper) && isRetrying(item));
  return {
    running,
    retrying: Boolean(failed),
    // The cause of the last try, unless it is unknown: that says nothing
    // without the technical detail, which lives on Health.
    reason: failed && causeOf(failed) !== "unknown" ? failureSentence(causeOf(failed)) : "",
    message,
    step: detail?.step ?? 0,
    elapsed: detail ? formatElapsed(now - detail.startedAt) : "",
    line: queueLine(jobs, paper, stamp),
  };
}

/**
 * The step this document's filing is on, or null while none is running.
 *
 * For a surface that shows what a step writes: the digest is written by
 * "Read the document", so the Digest tab re-reads the document as the step
 * moves past it rather than when the whole filing ends.
 */
export function useFilingStep(paper: FilingPaper | null, enabled: boolean): number | null {
  const snapshot = useQueueSnapshot(enabled && Boolean(paper));
  return useSyncExternalStore(onMemoryStage, () => {
    const job = paper ? snapshot?.jobs?.find((item) => isJobFor(item, paper) && item.status !== "failed") : undefined;
    const detail = job ? memoryStageDetail(job.id) : undefined;
    return detail ? detail.step : null;
  }, () => null);
}

/**
 * Whether the document's filing has failed an attempt and is waiting to try
 * again, or has given up: it is not writing the digest now, so the Digest tab
 * offers Generate rather than wait on it.
 */
export function useFilingSetback(paper: FilingPaper | null, enabled: boolean): boolean {
  const snapshot = useQueueSnapshot(enabled && Boolean(paper));
  return Boolean(paper && snapshot?.jobs?.some((job) => isJobFor(job, paper) && (job.status === "failed" || Boolean(job.lastError))));
}

/**
 * Which of the library's documents are being filed, or waiting to be.
 *
 * The rail's card speaks only for the document that is open, so a document
 * added while the reader was in another one sat in the library with nothing to
 * say Memory had it in hand, for the minutes its filing takes.
 */
export function useLibraryFiling(enabled: boolean): (paper: FilingPaper) => "running" | "queued" | null {
  const snapshot = useQueueSnapshot(enabled);
  // Re-rendered when a job starts or stops speaking, not on every sentence it says.
  useSyncExternalStore(onMemoryStage, stageVersion, () => "");
  const stamp = new Date().toISOString();
  return (paper) => {
    const job = snapshot?.jobs?.find((item) => isJobFor(item, paper) && item.status !== "failed");
    if (!job) return null;
    return memoryStages().has(job.id) || isRunningJob(job, stamp) ? "running" : "queued";
  };
}

/** The filing card's chrome: the mark in its tile, a title and one quiet line, then the state's own parts. */
function FilingCard({
  mark,
  title,
  label = title,
  detail,
  subtitle,
  waiting = false,
  settled = false,
  children,
}: {
  mark: NoticeState;
  title: string;
  /** The card's name for a screen reader, when the title alone does not say it. */
  label?: string;
  /** A line between the title and the subtitle, in the title's ink. */
  detail?: ReactNode;
  subtitle: ReactNode;
  waiting?: boolean;
  settled?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      className={`filing-progress${waiting ? " is-waiting" : ""}${settled ? " is-settled" : ""}`}
      // Work in flight and a pass that did not finish are announced; a card that only offers a verb is a region.
      role={settled && mark === "info" ? undefined : "status"}
      aria-live={settled && mark === "info" ? undefined : "polite"}
      aria-label={label}
    >
      <div className="filing-progress-head">
        <NoticeMark state={mark} />
        <div className={detail ? "filing-progress-copy has-detail" : "filing-progress-copy"}>
          <strong>{title}</strong>
          {detail}
          <span>{subtitle}</span>
        </div>
      </div>
      {children}
    </section>
  );
}

/** One segment per step: done, then the current one moving. */
function FilingSegments({ step }: { step: number }) {
  return (
    <div className="filing-progress-segments" aria-hidden="true">
      {FILING_STEPS.map((item, index) => (
        <i
          key={item.id}
          className={
            index < step ? "is-done" : index === step ? "is-current" : undefined
          }
        />
      ))}
    </div>
  );
}

/** Why it settled, indented to the title it explains. */
function FilingReason({ text }: { text: string }) {
  return text ? <p className="filing-progress-reason">{text}</p> : null;
}

/**
 * A document being filed into Memory, in the reader's rail.
 *
 * Running: the steps, the current one turning with what the pass last said
 * beneath it, and a segment per step along the top. Waiting on the model's
 * capacity: the same, in honey, saying it will retry on its own. Queued: the
 * documents in line, one line each, this one marked. A pass that failed and
 * is owed another says so and why, rather than claiming a place in a line it
 * is not in.
 */
export function FilingProgress({
  paper,
  title = "Filing into Memory",
}: {
  paper: FilingPaper;
  /** "Updating this document in Memory" when a filed document is refiled. */
  title?: string;
}) {
  const { running, retrying, reason, message, step, elapsed, line } = useFilingProgress(paper);
  const waiting = running && isCapacityWait(message);
  const total = FILING_STEPS.length;
  const ahead = documentsAhead(line);
  const subtitle = retrying
    ? "Did not finish · trying again soon"
    : !running
    ? ahead > 0
      ? `Queued · ${ahead} document${ahead === 1 ? "" : "s"} ahead`
      : "Queued · starting soon"
    : waiting
      ? `Step ${step + 1} of ${total} · paused for capacity`
      : (
        <>
          Step {step + 1} of {total}
          {/* The clock is for the eye: a live region re-announcing it every second says nothing new. */}
          {elapsed ? <span aria-hidden="true"> · {elapsed}</span> : null}
        </>
      );
  const live = waiting
    ? "Waiting for model capacity · Delphi retries on its own"
    : describeFilingStage(message, paper.title);
  const shown = retrying ? [] : line.slice(0, LINE_LIMIT);
  const hidden = line.length - shown.length;

  return (
    <>
    <FilingCard
      mark={retrying || waiting ? "attention" : running ? "running" : "info"}
      title={title}
      subtitle={subtitle}
      waiting={waiting}
    >
      {retrying ? (
        <FilingReason text={reason} />
      ) : running ? (
        <>
          <FilingSegments step={step} />
          <ol className="filing-progress-steps" aria-label="Filing steps">
            {FILING_STEPS.map((item, index) => {
              const state = index < step ? "done" : index === step ? "current" : "pending";
              return (
                <li key={item.id} className={`is-${state}`} aria-current={state === "current" ? "step" : undefined}>
                  <span className="filing-progress-marker" aria-hidden="true">
                    {state === "done" ? (
                      <svg viewBox="0 0 24 24">
                        <path d="m5 12 5 5 9-10" />
                      </svg>
                    ) : null}
                  </span>
                  <span className="filing-progress-step">
                    <span>{item.label}</span>
                    {state === "current" && live ? (
                      <small key={live}>{live}</small>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      ) : shown.length ? (
        <div className="filing-progress-line">
          <span className="filing-progress-kicker">In line</span>
          <ol aria-label="Documents waiting to be filed">
            {shown.map((row) => (
              <li key={row.id} className={row.self ? "is-self" : undefined}>
                <span className="filing-progress-place" aria-hidden="true">
                  {row.running ? <i className="filing-progress-spin" /> : row.position}
                </span>
                <span className="filing-progress-title" title={row.title}>
                  {row.title}
                </span>
                {row.running ? (
                  <small>Filing</small>
                ) : row.self ? (
                  <small>This one</small>
                ) : null}
              </li>
            ))}
          </ol>
          {hidden > 0 ? <span className="filing-progress-more">+{hidden} more</span> : null}
        </div>
      ) : null}
    </FilingCard>
    <p className="filing-progress-note">
      {running
        ? "This becomes the document’s map."
        : retrying
          ? "Delphi retries on its own. Keep reading."
          : "Files in the background. Keep reading."}
    </p>
    </>
  );
}

/**
 * A document that may be one the reader deleted, whose page was kept. Filing
 * waits on the answer: the kept page, rewritten from this document, or a page
 * of its own.
 */
export function SameDocumentCard({
  page,
  answering,
  onAnswer,
  onOpen,
}: {
  page: { slug: string; title: string; deletedAt: string | null };
  answering: boolean;
  onAnswer: (use: boolean) => void;
  onOpen: (slug: string) => void;
}) {
  const deleted = page.deletedAt ? authorDate(page.deletedAt) : "";
  return (
    <>
      <FilingCard
        mark="info"
        title="Same as page"
        label={`Same as ${page.title}?`}
        // The page itself, one click away, so the reader can see what they would be agreeing to.
        detail={
          <a
            className="filing-progress-page"
            href={memoryPath(page.slug)}
            onClick={(event) => {
              event.preventDefault();
              onOpen(page.slug);
            }}
          >
            <i aria-hidden="true">
              <svg viewBox="0 0 16 16"><path d="M4 1.8h5.5L12.5 5v9.2H4z" /><path d="M9.3 1.8V5.2h3.2" /></svg>
            </i>
            {page.title}
          </a>
        }
        subtitle={deleted ? `Original document deleted ${deleted}` : "Original document deleted"}
        settled
      >
        <div className="filing-progress-actions is-choice">
          <button type="button" className="primary-button" disabled={answering} onClick={() => onAnswer(true)}>
            Use that page
          </button>
          <button type="button" className="secondary-button" disabled={answering} onClick={() => onAnswer(false)}>
            Keep separate
          </button>
        </div>
      </FilingCard>
      <p className="filing-progress-note">Filing waits until you choose.</p>
    </>
  );
}

/**
 * Every way the card can end other than running, in the running card's own
 * chrome: the pages it could not write listed as the queue lists documents,
 * and its one verb.
 */
export function SettledFilingCard({ card, onAction }: { card: SettledFiling; onAction: () => void }) {
  return (
    <>
      <FilingCard mark={card.tone} title={card.title} subtitle={card.subtitle} settled>
        {card.pages?.length ? (
          <div className="filing-progress-line">
            <span className="filing-progress-kicker">Not written</span>
            <ul className="filing-progress-pages" aria-label="Pages that were not written">
              {card.pages.map((page) => (
                <li key={page.key}>
                  <span className="filing-progress-marker" aria-hidden="true" />
                  <span className="filing-progress-step">
                    <span title={page.title}>{page.title}</span>
                    <small>{page.reason}</small>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className={`filing-progress-actions${card.pages?.length ? " is-listed" : ""}`}>
          <button
            type="button"
            className={card.primary ? "primary-button" : "secondary-button"}
            onClick={onAction}
          >
            {card.action}
          </button>
        </div>
      </FilingCard>
      <p className="filing-progress-note">{card.note}</p>
    </>
  );
}
