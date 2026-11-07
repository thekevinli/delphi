"use client";

import { memo, type ReactNode, useEffect, useState } from "react";

import {
  type AnswerReferences,
  answerReferences,
  referenceCount,
  referenceSummary,
  type ReferenceScope,
} from "../lib/answer-references";
import type { ChatMessage } from "../lib/api";
import type { CitationTarget } from "../lib/citations";
import type { WebSource } from "../lib/web-sources";
import { SiteMark } from "./WebCitation";

type Row = {
  key: string;
  mark: ReactNode;
  title: string;
  detail: string;
  cited: number;
  /** A web page leaves the app; anything else opens in place. */
  href?: string;
  onOpen?: () => void;
};

const OUT = "M7 17 17 7M9 7h8v8";
const IN = "m9 6 6 6-6 6";

function SourceRow({ row }: { row: Row }) {
  const body = (
    <>
      <span className="answer-source-mark">{row.mark}</span>
      <span className="answer-source-body">
        <span className="answer-source-title">
          <span>{row.title}</span>
          {row.cited > 1 ? (
            <small title={`Cited ${row.cited} times in this answer`}>{row.cited}×</small>
          ) : null}
        </span>
        {row.detail ? <span className="answer-source-detail">{row.detail}</span> : null}
      </span>
      {row.href || row.onOpen ? (
        <svg className="answer-source-go" viewBox="0 0 24 24" aria-hidden="true">
          <path d={row.href ? OUT : IN} />
        </svg>
      ) : null}
    </>
  );
  if (row.href) {
    return <a className="answer-source" href={row.href} target="_blank" rel="noopener noreferrer">{body}</a>;
  }
  if (row.onOpen) {
    return <button type="button" className="answer-source" onClick={row.onOpen}>{body}</button>;
  }
  return <div className="answer-source">{body}</div>;
}

/**
 * Everything an answer rests on, folded to one line under it: the Memory
 * pages it names, then the passages it cites, then the web pages the provider
 * found. Open, it is one list; a tiny label marks each kind only when there is
 * more than one. The citations in the text stay where they are; this is them
 * in one place.
 */
function AnswerSourcesList({
  content,
  sources,
  scope,
  evidence,
  onOpenPage,
  onCitation,
}: {
  content: string;
  sources?: WebSource[];
  /** What the answer can cite besides the web; one object for the whole panel. */
  scope: Omit<ReferenceScope, "sources">;
  evidence?: ChatMessage["viewportEvidence"];
  onOpenPage?: (slug: string) => void;
  /** Followed as the answer's own citations are: with what it was shown, and its text. */
  onCitation?: (target: CitationTarget, evidence: ChatMessage["viewportEvidence"], answer: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [references, setReferences] = useState<AnswerReferences | null>(null);
  // Read after the answers have painted: a long chat holds many, and its
  // text, not this line under it, is what the reader is waiting for.
  useEffect(() => {
    const read = () => setReferences(answerReferences(content, { ...scope, sources }));
    if (typeof requestIdleCallback !== "function") {
      const timer = setTimeout(read);
      return () => clearTimeout(timer);
    }
    const idle = requestIdleCallback(read, { timeout: 500 });
    return () => cancelIdleCallback(idle);
  }, [content, sources, scope]);
  if (!references || !referenceCount(references)) return null;

  const memory: Row[] = references.memory.map((page) => ({
    key: `memory-${page.slug}`,
    mark: <span className={`answer-source-kind kb-link-${page.kind}`}><i /></span>,
    title: page.title,
    detail: page.summary,
    cited: page.cited,
    onOpen: onOpenPage ? () => onOpenPage(page.slug) : undefined,
  }));
  const passages: Row[] = references.passages.map((passage) => ({
    key: `passage-${passage.key}`,
    mark: <span className="answer-source-page">{passage.mark}</span>,
    title: passage.label,
    detail: passage.document,
    cited: passage.cited,
    onOpen: onCitation ? () => onCitation(passage.target, evidence, content) : undefined,
  }));
  const web: Row[] = references.web.map((page) => ({
    key: `web-${page.url}`,
    mark: <SiteMark url={page.url} />,
    title: page.title,
    detail: page.detail ? `${page.site} · ${page.detail}` : page.site,
    cited: page.cited,
    href: page.url,
  }));
  const sections = [
    { label: "Memory", rows: memory },
    { label: "Documents", rows: passages },
    { label: "Web sources", rows: web },
  ].filter((section) => section.rows.length);
  const labelled = sections.length > 1;
  // One mark per site, so a fold of five GitHub pages does not show five Gs.
  const sites = new Set<string>();
  const marks = [
    ...memory.slice(0, 2),
    ...passages.slice(0, 1),
    ...web.filter((_, index) => !sites.has(references.web[index].site) && sites.add(references.web[index].site)),
  ].slice(0, 4);

  return (
    <div className="answer-sources">
      <button
        type="button"
        className="trace-fold-toggle answer-sources-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        <span className="answer-sources-label">Sources</span>
        <span className="answer-sources-marks" aria-hidden="true">
          {marks.map((row) => <span key={row.key}>{row.mark}</span>)}
        </span>
        <span className="answer-sources-summary">{referenceSummary(references)}</span>
      </button>
      {open ? (
        <div className="answer-sources-list">
          {sections.map((section) => (
            <section key={section.label} aria-label={section.label}>
              {labelled ? <h4 className="answer-sources-section">{section.label}</h4> : null}
              <ol>
                {section.rows.map((row) => <li key={row.key}><SourceRow row={row} /></li>)}
              </ol>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const AnswerSources = memo(AnswerSourcesList);
