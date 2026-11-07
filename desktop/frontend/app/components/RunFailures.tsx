"use client";

/**
 * What a filing run could not file, one cause at a time.
 *
 * Health's list row rather than a column per cause: a tile, the cause's short
 * title and count, its one line said once, then its documents. Each cause
 * carries its own fix (`FAILURE_CAUSES`), beside the documents it fixes. A
 * document still retrying is listed last, with nothing to do, unless its cause
 * is one only the reader can fix: then it waits under that cause, beside the fix.
 * A retry waits for the run it would join; opening something never waits.
 */

import { type ReactNode, useState } from "react";

import { type FailedDocument, type RetryingDocument, type RunDocument, describeRetry } from "../lib/backfill";
import { FAILURE_CAUSES, RETRYING_COPY, type FailureCause, groupByCause } from "../lib/filing-failure";
import { Chevron, TechnicalDetail } from "./HealthBits";

/** Over this many documents, a cause shows three and "N more". */
const SHORT_LIST = 4;

type Verb = { label: string; name: string; run: () => void; disabled: boolean };

export function RunFailures({
  failures,
  retrying,
  busy,
  onRetry,
  onConnect,
  onOpen,
}: {
  failures: FailedDocument[];
  retrying: RetryingDocument[];
  busy: boolean;
  onRetry: (jobIds: string[]) => void;
  onConnect: () => void;
  onOpen: (document: RunDocument) => void;
}) {
  const [open, setOpen] = useState(true);
  const count = failures.length || retrying.length;
  // A retry passes on its own only where trying again is the fix.
  const resting = retrying.filter((document) => FAILURE_CAUSES[document.cause].fix === "retry");
  const waiting = retrying.filter((document) => FAILURE_CAUSES[document.cause].fix !== "retry");
  return (
    <div className="kb-run-failures">
      <button type="button" className="kb-run-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="kb-run-fold-head">{failures.length > 0 ? "Failed" : "Retrying"}</span>
        <span className="kb-run-fold-count">
          {count} document{count === 1 ? "" : "s"}
        </span>
        <Chevron />
      </button>
      {open ? (
        <div className="kb-run-groups">
          {groupByCause<FailedDocument | RetryingDocument>([...failures, ...waiting]).map(({ cause, items }) => (
            <CauseGroup
              key={cause}
              cause={cause}
              documents={items.filter((item): item is FailedDocument => !("retryAt" in item))}
              waiting={items.filter((item): item is RetryingDocument => "retryAt" in item)}
              busy={busy}
              onRetry={onRetry}
              onConnect={onConnect}
              onOpen={onOpen}
            />
          ))}
          {resting.length > 0 ? (
            <Group tone="cloud" icon={RETRYING_COPY.icon} title={RETRYING_COPY.title} line={RETRYING_COPY.line} verb={null}>
              {resting.map((document) => (
                <DocumentRow key={document.jobId} title={document.title} verb={null}>
                  <NextTry document={document} />
                </DocumentRow>
              ))}
            </Group>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CauseGroup({
  cause,
  documents,
  waiting,
  busy,
  onRetry,
  onConnect,
  onOpen,
}: {
  cause: FailureCause;
  documents: FailedDocument[];
  /** Still retrying, under a cause only the reader can fix. */
  waiting: RetryingDocument[];
  busy: boolean;
  onRetry: (jobIds: string[]) => void;
  onConnect: () => void;
  onOpen: (document: RunDocument) => void;
}) {
  const copy = FAILURE_CAUSES[cause];
  const several = documents.length + waiting.length > 1;
  const own = (document: RunDocument): Verb | null =>
    copy.fix === "retry"
      ? { label: "Try again", name: `Try again: ${document.title}`, run: () => onRetry([document.jobId]), disabled: busy }
      : copy.fix === "open" && document.paperId
        ? { label: "Open", name: `Open ${document.title}`, run: () => onOpen(document), disabled: false }
        : null;
  // The cause's own verb, or with one document, that document's.
  const verb: Verb | null =
    copy.fix === "retry"
      ? { label: "Try again", name: `Try again: ${copy.title}`, run: () => onRetry(documents.map((item) => item.jobId)), disabled: busy }
      : copy.fix === "connection"
        ? { label: "Open AI connection", name: "Open AI connection", run: onConnect, disabled: false }
        : several
          ? null
          : own(documents[0] ?? waiting[0]!);
  return (
    <Group tone={copy.tone} icon={copy.icon} title={copy.title} line={copy.line} verb={verb}>
      {[
        ...documents.map((document) => (
          <DocumentRow key={document.jobId} title={document.title} verb={several ? own(document) : null}>
            {document.pages.length > 0 ? (
              <ul className="kb-health-pages kb-run-pages" aria-label="Pages not written">
                {document.pages.map((page, index) => (
                  <li key={`${index}:${page.title}`}>
                    <span className="kb-health-page-mark" aria-hidden="true" />
                    <span className="kb-health-row-copy">
                      <span className="kb-health-row-name">{page.title}</span>
                      <span className="kb-health-row-meta">{page.reason}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : document.detail ? (
              <TechnicalDetail text={document.detail} />
            ) : null}
          </DocumentRow>
        )),
        ...waiting.map((document) => (
          <DocumentRow key={document.jobId} title={document.title} verb={several ? own(document) : null}>
            <NextTry document={document} />
          </DocumentRow>
        )),
      ]}
    </Group>
  );
}

/** One document: its title, what is known about it, and its own verb when its cause has several. */
function DocumentRow({ title, verb, children }: { title: string; verb: Verb | null; children: ReactNode }) {
  return (
    <li className="kb-run-document">
      <span className="kb-run-document-copy">
        <strong>{title}</strong>
        {children}
      </span>
      {verb ? <VerbButton verb={verb} className="kb-health-verb kb-run-document-verb" /> : null}
    </li>
  );
}

/** A document waiting out its backoff: its next try. */
function NextTry({ document }: { document: RetryingDocument }) {
  return <span className="kb-run-next">{describeRetry(document)}</span>;
}

function VerbButton({ verb, className }: { verb: Verb; className: string }) {
  return (
    <button type="button" className={className} aria-label={verb.name} disabled={verb.disabled} onClick={verb.run}>
      {verb.label}
    </button>
  );
}

/** One cause: its tile, title and count, its line, then its documents, three of them when there are many. */
function Group({
  tone,
  icon,
  title,
  line,
  verb,
  children,
}: {
  tone: string;
  icon: string;
  title: string;
  line: string;
  verb: Verb | null;
  children: ReactNode[];
}) {
  const [all, setAll] = useState(false);
  const long = children.length > SHORT_LIST;
  const shown = long && !all ? children.slice(0, SHORT_LIST - 1) : children;
  return (
    <section className={`kb-run-group is-${tone}`} aria-label={title}>
      <span className="kb-run-tile" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          <path d={icon} />
        </svg>
      </span>
      <div className="kb-run-group-copy">
        <span className="kb-run-group-title">
          <strong>{title}</strong>
          <b>{children.length}</b>
        </span>
        <span className="kb-run-group-line">{line}</span>
        <ul className="kb-run-documents" aria-label="Documents">
          {shown}
        </ul>
        {long ? (
          <button type="button" className="kb-health-fold kb-run-more" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `${children.length - shown.length} more`}
          </button>
        ) : null}
      </div>
      {verb ? <VerbButton verb={verb} className="kb-health-verb" /> : null}
    </section>
  );
}
