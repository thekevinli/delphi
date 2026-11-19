"use client";

import { Fragment, type ReactNode, useEffect, useState } from "react";

import {
  activeCall,
  answerSegments,
  type AnswerTrace,
  cleanThought,
  contextRows,
  foldSummary,
  formatClock,
  liveWindow,
  resultTags,
  stretchRows,
  toolPhrase,
  TRACE_LIVE_VISIBLE,
  TRACE_TIMING,
  type ToolEntry,
  type TraceEntry,
  type TraceGlyph,
  type TraceResult,
  type TraceStretch,
  traceTool,
} from "../lib/answer-trace";
import { shuffledPhrases } from "../lib/loading-phrases";
import { isWebUrl } from "../lib/web-sources";
import { SweepText } from "./Loading";

/** Said on hover when the provider has no capacity; the line itself does not change. */
const CAPACITY_TIP = "Waiting for model capacity · Delphi retries on its own";

/** Opens the Memory page a result row names, by its slug. */
export type OpenTraceResult = (result: TraceResult) => void;

/**
 * One glyph per kind of row. A tool names its glyph in `TRACE_TOOLS`; a new
 * tool that needs a new mark adds its path here and nothing else changes.
 */
const GLYPHS: Record<TraceGlyph, ReactNode> = {
  question: <path d="M2.4 3h9.2v6.4H7.2L4.6 11.6V9.4H2.4Z" />,
  index: (
    <>
      <path d="M3 2.2h8v9.6H3z" />
      <path d="M5 5h4M5 7h4M5 9h2.4" />
    </>
  ),
  search: (
    <>
      <path d="M2.2 3.6h5.2M2.2 6.6h3M2.2 9.6h2.4" />
      <circle cx="8.8" cy="8.2" r="2.4" />
      <path d="m10.6 10 1.6 1.6" />
    </>
  ),
  links: (
    <>
      <circle cx="3.4" cy="7" r="1.5" />
      <circle cx="10.6" cy="3.4" r="1.5" />
      <circle cx="10.6" cy="10.6" r="1.5" />
      <path d="m4.8 6.3 4.4-2.2M4.8 7.7l4.4 2.2" />
    </>
  ),
  page: <path d="M3.4 1.8h4.8l2.4 2.4v8H3.4zM8 1.8v2.6h2.6" />,
  pages: (
    <>
      <path d="M4.6 1.8h4l2 2v6.4h-6z" />
      <path d="M3 4v8.2h5.6" />
    </>
  ),
  document: (
    <>
      <path d="M3.4 1.8h4.8l2.4 2.4v8H3.4z" />
      <path d="M5.4 6.6h3.2M5.4 8.8h3.2" />
    </>
  ),
  figure: (
    <>
      <path d="M2.2 2.8h9.6v8.4H2.2z" />
      <path d="m2.6 9.6 2.8-2.8 2.2 2.2 1.4-1.4 2.4 2.4" />
    </>
  ),
  web: (
    <>
      <circle cx="7" cy="7" r="4.8" />
      <path d="M2.2 7h9.6M7 2.2c1.6 1.4 1.6 8.2 0 9.6M7 2.2c-1.6 1.4-1.6 8.2 0 9.6" />
    </>
  ),
  tool: <circle cx="7" cy="7" r="2" />,
};

function TraceGlyphMark({ glyph }: { glyph: TraceGlyph }) {
  return (
    <svg className="trace-glyph" viewBox="0 0 14 14" aria-hidden="true">
      {GLYPHS[glyph]}
    </svg>
  );
}

/** The Delphi mark in its tile, the sun rising behind the mountain while it works. */
export function WaitingMark() {
  return (
    <span className="trace-mark" aria-hidden="true">
      <svg viewBox="0 0 120 120">
        <circle className="trace-mark-sun" cx="60" cy="38" r="20" />
        <path d="M60 46 L98 98 H22 Z" />
      </svg>
    </span>
  );
}

/** A time in its column: tabular, right-aligned, counted from the stretch's start. */
function TraceTime({ stretch, at, reason }: { stretch: TraceStretch; at: number; reason?: string }) {
  return (
    <span className="trace-time">
      {reason ? `${reason} · ` : ""}
      {formatClock(at - stretch.startedAt)}
    </span>
  );
}

const PAGE_KINDS = ["source", "concept", "domain", "pdf", "web-page"];

/** The pages a call returned, on an elbow from the thread under it. */
function TraceResults({ results, onOpen }: { results: TraceResult[]; onOpen?: OpenTraceResult }) {
  const tags = resultTags(results);
  return (
    <ol className="trace-results">
      {results.map((result, index) => (
        <li key={`${result.slug ?? result.paperId ?? result.url ?? result.title}-${index}`}>
          <span
            className={`trace-kind trace-kind-${PAGE_KINDS.includes(result.kind) ? result.kind : "other"}`}
            aria-hidden="true"
          />
          {/* Only a Memory page opens from here. A document is named, not
              linked, rather than drawn as a button that does nothing. */}
          {/* This copy draws a stored trace as it was stored, so an address is
              checked here, where it would become a link. */}
          {isWebUrl(result.url) ? (
            // A page on the web opens outside the app, in its own tab.
            <a className="trace-result-title" href={result.url} target="_blank" rel="noopener noreferrer">
              {result.title}
            </a>
          ) : onOpen && result.slug ? (
            <button type="button" className="trace-result-title" onClick={() => onOpen(result)}>
              {result.title}
            </button>
          ) : (
            <span className="trace-result-title">{result.title}</span>
          )}
          {tags[index] ? <span className="trace-result-tag">{tags[index]}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function ToolRow({
  entry,
  stretch,
  active,
  onOpen,
}: {
  entry: ToolEntry;
  stretch: TraceStretch;
  /** The call still running at the end of the live stretch. */
  active: boolean;
  onOpen?: OpenTraceResult;
}) {
  const phrase = toolPhrase(entry);
  const failed = entry.ok === false;
  return (
    <li
      className={`trace-row trace-tool${failed ? " is-failed" : ""}${active ? " is-active" : ""}`}
      // The tool's id and how long it took are for whoever asks, on hover.
      title={`${entry.tool}${entry.ms !== undefined ? ` · ${entry.ms} ms` : ""}`}
    >
      <span className="trace-lead" aria-hidden="true">
        {active ? <WaitingMark /> : <TraceGlyphMark glyph={traceTool(entry).glyph} />}
      </span>
      <span className="trace-body">
        <span className="trace-line">
          <strong>{phrase.verb}</strong>
          {phrase.joiner ? ` ${phrase.joiner}` : ""}
          {phrase.plain ? ` ${phrase.plain}` : ""}
          {phrase.code ? <> <code>{phrase.code}</code></> : null}
          {phrase.link ? (
            <> <a className="trace-link" href={phrase.link.href} target="_blank" rel="noopener noreferrer"><code>{phrase.link.text}</code></a></>
          ) : null}
          {phrase.then ? <> {phrase.then.joiner} <code>{phrase.then.code}</code></> : null}
          {phrase.quote ? ` “${phrase.quote}”` : ""}
        </span>
      </span>
      <TraceTime stretch={stretch} at={entry.at} reason={failed ? entry.error ?? "Failed" : undefined} />
      {/* Under the call and across to the time column, where each page's id sits. */}
      {phrase.results.length ? <TraceResults results={phrase.results} onOpen={onOpen} /> : null}
    </li>
  );
}

function ThoughtRow({ entry, stretch }: { entry: TraceEntry & { kind: "thought" }; stretch: TraceStretch }) {
  return (
    <li className="trace-row trace-thought">
      <span className="trace-lead" aria-hidden="true">
        <i className="trace-dot" />
      </span>
      <span className="trace-body">
        <span className="trace-line">{cleanThought(entry.text)}</span>
      </span>
      <TraceTime stretch={stretch} at={entry.at} />
    </li>
  );
}

/**
 * A stretch as its timeline: what the answer was handed (first stretch only),
 * then every thought and call in the order they happened, on one thread.
 *
 * The same rows whether the stretch is finished or still running. While it
 * runs, one row is active: the call being written or run (`activeCall`), said
 * in the present tense, or — between calls — a waiting phrase with the clock.
 */
function TraceTimeline({
  stretch,
  live,
  now,
  startedAt,
  waitingForCapacity,
  onOpen,
}: {
  stretch: TraceStretch;
  live?: boolean;
  /** The reader's clock; only a running stretch reads it. */
  now?: number;
  /** When the request was sent, on the reader's clock. */
  startedAt?: number;
  waitingForCapacity?: boolean;
  onOpen?: OpenTraceResult;
}) {
  const [phrases] = useState(shuffledPhrases);
  const rows = stretchRows(stretch);
  const running = (live && activeCall(stretch)) || null;
  const elapsed = live && now !== undefined && startedAt ? Math.max(0, now - startedAt) : 0;
  const phrase = phrases[Math.floor(elapsed / TRACE_TIMING.phraseHoldMs) % phrases.length];
  // What the answer was handed always shows: it is short, and it is what the
  // rest is read against.
  const context: Array<{ key: string; node: ReactNode }> = [
    ...contextRows(stretch.context, live).map((row) => ({
      key: `context-${row.label}`,
      node: (
        <li className="trace-row trace-context">
          <span className="trace-lead" aria-hidden="true">
            <TraceGlyphMark glyph={row.glyph} />
          </span>
          <span className="trace-body">
            <span className="trace-line">
              {row.label}{row.running ? "…" : ""}
              {row.detail ? <span className="trace-context-detail"> · {row.detail}</span> : null}
            </span>
          </span>
          {/* The one row the reader waited on says when it ended, and counts while it has not. */}
          <span className="trace-time">{formatClock(row.running ? elapsed : row.at ?? 0)}</span>
          {row.results?.length ? <TraceResults results={row.results} onOpen={onOpen} /> : null}
        </li>
      ),
    })),
  ];
  // The work itself, of which a running stretch keeps only its last few.
  const items: Array<{ key: string; node: ReactNode }> = [
    ...rows.map((entry, index) => ({
      key: `entry-${index}`,
      node: entry.kind === "tool" ? (
        <ToolRow entry={entry} stretch={stretch} active={entry === running} onOpen={onOpen} />
      ) : (
        <ThoughtRow entry={entry} stretch={stretch} />
      ),
    })),
    ...(stretch.truncated
      ? [{
          key: "truncated",
          node: (
            <li className="trace-row trace-context">
              <span className="trace-lead" aria-hidden="true"><i className="trace-dot" /></span>
              <span className="trace-body"><span className="trace-line">More steps followed; only these were kept.</span></span>
            </li>
          ),
        }]
      : []),
  ];
  // The active call stays in view however many rows came before it.
  const { earlier, shown } = live ? liveWindow(items, TRACE_LIVE_VISIBLE + (running ? 1 : 0)) : { earlier: 0, shown: items };
  return (
    <ol className={`trace-timeline${live ? " is-live" : ""}`}>
      {context.map((item) => <Fragment key={item.key}>{item.node}</Fragment>)}
      {earlier ? (
        <li className="trace-row trace-earlier">
          <span className="trace-lead" aria-hidden="true"><i className="trace-dash" /></span>
          <span className="trace-body"><span className="trace-line">{earlier} earlier</span></span>
        </li>
      ) : null}
      {shown.map((item) => <Fragment key={item.key}>{item.node}</Fragment>)}
      {live && !running ? (
        <li
          className="trace-row trace-waiting is-active"
          role="status"
          aria-live="polite"
          title={waitingForCapacity ? CAPACITY_TIP : undefined}
        >
          <span className="trace-lead" aria-hidden="true"><WaitingMark /></span>
          <span className="trace-body">
            <span key={phrase} className="trace-line trace-phrase"><SweepText text={`${phrase}…`} /></span>
          </span>
          <span className="trace-time">{formatClock(elapsed)}</span>
        </li>
      ) : null}
    </ol>
  );
}

/** The stretch being worked on right now: its timeline, with a ticking clock. */
function LiveStretch({
  stretch,
  startedAt,
  waitingForCapacity,
  onOpen,
}: {
  stretch: TraceStretch;
  startedAt: number;
  waitingForCapacity?: boolean;
  onOpen?: OpenTraceResult;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TRACE_TIMING.tickMs);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="trace">
      <TraceTimeline
        stretch={stretch}
        live
        now={now}
        startedAt={startedAt || now}
        waitingForCapacity={waitingForCapacity}
        onOpen={onOpen}
      />
    </div>
  );
}

/**
 * A finished stretch, folded into one line where it happened in the answer —
 * how long it took, how many steps, how many pages — and opened on request.
 * A model that thinks, writes, then thinks again gets one fold per stretch.
 */
export function TraceFold({ stretch, onOpen }: { stretch: TraceStretch; onOpen?: OpenTraceResult }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="trace trace-fold">
      <button
        type="button"
        className="trace-fold-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
        {foldSummary(stretch)}
      </button>
      {open ? <TraceTimeline stretch={stretch} onOpen={onOpen} /> : null}
    </div>
  );
}

/**
 * An assistant turn as it happened: answer text, and between the pieces of it
 * the stretches of work that came in between. The stretch still in progress
 * is drawn open and live; finished ones are folds. Before anything arrives, or
 * in Plan mode once its visible introduction is written, a waiting row stands
 * alone.
 */
export function AnswerFlow({
  content,
  trace,
  live,
  keepWaiting,
  startedAt,
  waitingForCapacity,
  onOpenResult,
  renderText,
}: {
  content: string;
  trace: AnswerTrace;
  /** This turn is the one being streamed. */
  live: boolean;
  /** Keep a waiting row under the text while the stream continues unseen. */
  keepWaiting: boolean;
  /** When the request was sent, on the reader's clock. */
  startedAt: number;
  waitingForCapacity?: boolean;
  onOpenResult?: OpenTraceResult;
  renderText: (text: string) => ReactNode;
}) {
  const segments = answerSegments(content, trace);
  const last = segments[segments.length - 1];
  const waitingAlone = live && (!last || (keepWaiting && last.kind === "text"));
  return (
    <>
      {segments.map((segment) =>
        segment.kind === "text" ? (
          <div key={segment.key} className="message-markdown prose-reading">
            {renderText(segment.text)}
          </div>
        ) : segment.open && live ? (
          <LiveStretch
            key={segment.key}
            stretch={segment.stretch}
            startedAt={startedAt + segment.stretch.startedAt}
            waitingForCapacity={waitingForCapacity}
            onOpen={onOpenResult}
          />
        ) : (
          <TraceFold key={segment.key} stretch={segment.stretch} onOpen={onOpenResult} />
        ),
      )}
      {waitingAlone ? (
        <LiveStretch
          stretch={{ offset: content.length, startedAt: 0, entries: [] }}
          startedAt={startedAt}
          waitingForCapacity={waitingForCapacity}
        />
      ) : null}
    </>
  );
}
