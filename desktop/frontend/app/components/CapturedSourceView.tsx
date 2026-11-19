"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError, type CapturedSource } from "../lib/api";
import { hint, WindowToast } from "./Notice";
import { quoteRange } from "../lib/quote-range";

const UNAVAILABLE = hint("The captured copy of that source is no longer kept.");
const UNREACHABLE = hint("Couldn't open that source. Try again.");

/**
 * An outside page as Delphi captured it, opened from a citation: what the page
 * said on the day it was read, with the cited passage marked. The capture is
 * shown as text. Nothing in it is fetched, linked or run; the one link out is
 * to the live page, which may have changed since. A capture that cannot be
 * read opens nothing: it says so in the window's bottom toast.
 */
export default function CapturedSourceView({ evidenceId, section, onClose }: {
  evidenceId: string; section: string | null; onClose: () => void;
}) {
  const [source, setSource] = useState<CapturedSource | null>(null);
  const [failed, setFailed] = useState<typeof UNAVAILABLE | null>(null);
  const cited = useRef<HTMLElement>(null);
  useEffect(() => {
    let current = true;
    api<CapturedSource>(`/api/evidence/${encodeURIComponent(evidenceId)}`)
      .then(loaded => { if (current) setSource(loaded); })
      .catch(error => { if (current) setFailed(error instanceof ApiError && error.status === 404 ? UNAVAILABLE : UNREACHABLE); });
    return () => { current = false; };
  }, [evidenceId]);
  useEffect(() => { cited.current?.scrollIntoView({ block: "center" }); }, [source]);
  useEffect(() => {
    if (!source) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [source, onClose]);

  if (failed) return <WindowToast notice={failed} onDismiss={onClose} />;
  if (!source) return null;
  const anchor = (section ?? "").replace(/^#|^§/, "").toLowerCase();
  // Out of whatever opened it: a marker's paragraph would give the dialog its
  // type, and the pane around a Memory page would clip it.
  return createPortal(<div className="captured-source-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="captured-source" role="dialog" aria-modal="true" aria-label={source.title || "Captured source"}>
      <header>
        <div>
          <span className="captured-source-label">Outside source, as captured {source.capturedAt.slice(0, 10)}</span>
          <h2>{source.title}</h2>
          <a href={source.finalUrl} target="_blank" rel="noopener noreferrer">Open the live page</a>
        </div>
        <button type="button" aria-label="Close captured source" onClick={onClose}>×</button>
      </header>
      <div className="captured-source-body">
        {source.sections.map(part => {
          const isCited = part.anchor.toLowerCase() === anchor;
          const quotes = isCited ? source.findings.filter(finding => finding.anchor.toLowerCase() === anchor) : [];
          const range = quotes.map(finding => quoteRange(part.markdown, finding.quote)).find(Boolean) ?? null;
          return <article key={part.anchor} ref={isCited ? cited : undefined} className={isCited ? "is-cited" : undefined} data-anchor={part.anchor}>
            {part.title ? <h3>{part.title}</h3> : null}
            <p>{range ? <>{part.markdown.slice(0, range[0])}<mark>{part.markdown.slice(range[0], range[1])}</mark>{part.markdown.slice(range[1])}</> : part.markdown}</p>
          </article>;
        })}
      </div>
    </section>
  </div>, document.body);
}

/** A page's citation of an outside source, as something to open: the capture it rests on. */
export function OutsideSourceLink({ evidenceId, section }: { evidenceId: string; section?: string | null }) {
  // Counted, so pressing it again while its toast is up asks again.
  const [opened, setOpened] = useState(0);
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="kb-outside-source" onClick={() => { setOpened(opened + 1); setOpen(true); }}>
      outside source{section ? ` · §${section}` : ""}
    </button>
    {open ? <CapturedSourceView key={opened} evidenceId={evidenceId} section={section ?? null} onClose={() => setOpen(false)} /> : null}
  </>;
}
