"use client";

import type { RefObject } from "react";
import type { Paper } from "../lib/api";
import type { DigestActivity } from "./DigestPane";

export type ReaderView = "document" | "digest";
export type DigestMark = "ready" | "new" | "preparing" | "missing" | "failed";

const MARK_TITLES: Record<DigestMark, string> = {
  ready: "Research digest",
  new: "Digest just finished",
  preparing: "Digest is being written",
  missing: "No digest yet",
  failed: "The digest didn't finish",
};

/**
 * `landed`: it finished while the reader was elsewhere, and has not been opened
 * since. A failed regenerate leaves the stored digest readable, so it is ready.
 */
export function digestMark(paper: Paper, activity: DigestActivity | undefined, landed: boolean): DigestMark {
  const stored = paper.digest?.status ?? "missing";
  if (activity?.status === "preparing" || stored === "pending") return "preparing";
  if (stored === "ready") return landed ? "new" : "ready";
  return activity?.status === "failed" ? "failed" : stored;
}

/** Document | Digest in the Reader header; the Digest side carries the digest's state. */
export default function ReaderViewToggle({ view, mark, onChange, documentButton }: {
  view: ReaderView; mark: DigestMark; onChange: (view: ReaderView) => void;
  documentButton?: RefObject<HTMLButtonElement | null>;
}) {
  return <div className="reader-view-toggle" role="group" aria-label="Show" data-view={view}>
    <span className="reader-view-knob" aria-hidden="true" />
    <button ref={documentButton} type="button" aria-pressed={view === "document"} onClick={() => onChange("document")}>Document</button>
    <button type="button" aria-pressed={view === "digest"} title={MARK_TITLES[mark]} onClick={() => onChange("digest")}>
      <span className="digest-mark" data-state={mark} aria-hidden="true" />Digest
    </button>
  </div>;
}
