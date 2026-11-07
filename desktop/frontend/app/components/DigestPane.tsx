"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { api, type DigestDetail, type Paper, type PaperDigestMetadata } from "../lib/api";
import { modelLabel } from "../lib/chat-model-policy";
import { pageTitle } from "../lib/page-title";
import { paperMark } from "../lib/paper-kind";
import { LoadingWords } from "./Loading";
import ResearchDigestView from "./ResearchDigestView";

const UNREADABLE = "The stored digest is unavailable. Generate it again.";

export type DigestActivity = { status: "preparing" | "failed"; message: string };

function DigestState({ art, title, heading, children }: {
  art: string; title: string; heading: RefObject<HTMLHeadingElement | null>; children: ReactNode;
}) {
  return <div className="digest-state">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={art} alt="" width={60} height={48} />
    <h3 ref={heading} tabIndex={-1}>{title}</h3>
    {children}
  </div>;
}

/**
 * The digest in the reader's page box, over the document it summarises. It
 * stays mounted while hidden, so the document keeps its place underneath and
 * the digest its own; the stored digest is fetched the first time it is shown.
 * A stored digest outranks the activity: a regenerate in flight or one that
 * failed is said in the footer, under the digest it would have replaced.
 */
export default function DigestPane({ projectId, paper, documentHref, activity, pending = "", shown = true, zoom = 100, onGenerate, onShowDocument, onStoredDigest }: {
  projectId: string;
  paper: Paper;
  documentHref: string;
  activity?: DigestActivity;
  /**
   * Why a digest is already on its way when none is stored: the document's
   * filing writes it, or the rest of the page is still being read. Generate
   * then waits, since a digest written now would be written again from the
   * whole document.
   */
  pending?: string;
  shown?: boolean;
  /** The text size, in percent: the contents and the reading column, not the footer. */
  zoom?: number;
  onGenerate: (force: boolean) => Promise<DigestDetail | null>;
  onShowDocument: () => void;
  /** The server no longer holds the stored digest current: what it says instead, for the library's copy. */
  onStoredDigest?: (digest: PaperDigestMetadata) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  /** Generate gives way to the writing state; its heading then takes the focus the button had. */
  const refocus = useRef(false);
  /** Set by Generate or Try again: the digest that arrives takes the focus, unless the reader has moved on. */
  const land = useRef(false);
  const root = useRef<HTMLElement>(null);
  const storedDigest = useRef(onStoredDigest);
  useEffect(() => { storedDigest.current = onStoredDigest; }, [onStoredDigest]);
  useEffect(() => {
    if (refocus.current && heading.current) {
      refocus.current = false;
      heading.current.focus();
    }
    if (!land.current || !root.current?.querySelector(".digest-document")) return;
    land.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || root.current.contains(active)) root.current.querySelector<HTMLElement>(".digest-reading-scroll")?.focus({ preventScroll: true });
  });
  const [detail, setDetail] = useState<DigestDetail | null>(null);
  /** The paper status the digest on screen was read for; a newer one (a build that finished elsewhere) is read again. */
  const [loadedFor, setLoadedFor] = useState("");
  /** What the server said instead of a digest (no longer current), for the paper status it answered. */
  const [answered, setAnswered] = useState<{ basis: string; digest: PaperDigestMetadata } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const digest = detail?.digest ?? null;
  const metadata = detail?.paper.digest ?? paper.digest;
  const basis = `${paper.digest?.status}:${paper.digest?.updatedAt}`;
  const storedMetadata = answered?.basis === basis ? answered.digest : paper.digest;
  const stored = storedMetadata?.status ?? "missing";

  useEffect(() => {
    if (!shown || stored !== "ready" || error || loadedFor === basis) return;
    let active = true;
    void api<DigestDetail>(`/api/projects/${projectId}/papers/${paper.id}/digest`)
      .then((result) => {
        if (!active) return;
        if (result.digest) {
          setDetail(result);
          setLoadedFor(basis);
        } else if (result.paper.digest?.status === "ready") {
          setError(UNREADABLE);
        } else {
          const current = result.paper.digest ?? { status: "missing" as const };
          setDetail(null);
          setAnswered({ basis, digest: current });
          storedDigest.current?.(current);
        }
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load the digest");
      });
    return () => { active = false; };
  }, [basis, error, loadedFor, paper.id, projectId, shown, stored]);

  const generate = async (force: boolean) => {
    if (!digest) refocus.current = land.current = true;
    setBusy(true);
    setError("");
    // A failure is reported as the activity's message; the stored digest stays.
    const result = await onGenerate(force);
    if (result?.digest) {
      setDetail(result);
      setLoadedFor(`${result.paper.digest?.status}:${result.paper.digest?.updatedAt}`);
    }
    setBusy(false);
  };

  const failed = activity?.status === "failed" ? activity.message : "";
  let body: ReactNode;
  if (digest) {
    const regenerating = busy || activity?.status === "preparing";
    const stamp = [
      metadata?.model ? modelLabel(metadata.model) : "",
      metadata?.updatedAt ? new Date(metadata.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "",
    ].filter(Boolean);
    body = <>
      {/* The reader's header names a PDF above its digest, and a web page not at all. */}
      <ResearchDigestView digest={digest} headerTitle={paperMark(paper) === "pdf" ? pageTitle(paper.title) : undefined}
        projectId={projectId} paperId={paper.id} zoom={zoom}
        documentHref={documentHref} onNavigate={onShowDocument} />
      <footer className="digest-footer">
        {stamp.length ? <span>{stamp.map((part, index) => <Fragment key={part}>
          {index ? <span className="digest-stamp-separator"> · </span> : null}{part}
        </Fragment>)}</span> : null}
        {/* aria-disabled, not disabled: a disabled button drops the keyboard's focus to the page. */}
        <button type="button" aria-label="Regenerate digest" aria-disabled={regenerating} onClick={() => { if (!regenerating) void generate(true); }}>
          {regenerating ? "Regenerating…" : "Regenerate"}
        </button>
        {failed ? <span className="digest-footer-error" role="alert" title={failed}>{failed}</span> : null}
      </footer>
    </>;
  } else if (stored === "ready" && !error) {
    body = <div className="digest-state" role="status">
      <span className="digest-spinner" aria-hidden="true" />
      <LoadingWords text="Opening the digest" />
    </div>;
  } else if (busy || activity?.status === "preparing" || stored === "pending") {
    body = <DigestState heading={heading} art="/brand/animations/delphi-loading-sunrise.gif" title="Writing the digest">
      <p>A few minutes for a long paper. Keep reading 🚀.</p>
      <span className="digest-live" role="status">
        <span>{activity?.status === "preparing" ? activity.message : "Preparing research digest"}</span>
      </span>
    </DigestState>;
  } else if (error) {
    // Stored but not read: read it again, or build it again when the store can't give it back.
    body = <DigestState heading={heading} art="/brand/animations/delphi-warning-alert.gif" title="Couldn't open the digest">
      <p>The digest is saved, but it didn&apos;t load. The detail below says why.</p>
      <p className="digest-state-detail">{error}</p>
      {error === UNREADABLE
        ? <button type="button" className="digest-state-action" onClick={() => void generate(true)}>Generate again</button>
        : <button type="button" className="digest-state-action" onClick={() => { land.current = true; setError(""); }}>Try again</button>}
    </DigestState>;
  } else if (failed || stored === "failed") {
    const reason = failed || storedMetadata?.message;
    body = <DigestState heading={heading} art="/brand/animations/delphi-warning-alert.gif" title="The digest didn't finish">
      <p>Nothing was saved, and the document is unchanged. Try again; if it stops a second time, the detail below says where.</p>
      {reason ? <p className="digest-state-detail">{reason}</p> : null}
      <button type="button" className="digest-state-action" onClick={() => void generate(false)}>Try again</button>
    </DigestState>;
  } else if (pending) {
    body = <DigestState heading={heading} art="/brand/animations/delphi-digest-none.gif" title="The digest is on its way">
      <p>{pending}</p>
      <button type="button" className="digest-state-action" aria-disabled="true">Generation pending</button>
    </DigestState>;
  } else {
    body = <DigestState heading={heading} art="/brand/animations/delphi-digest-none.gif" title="No digest for this document yet">
      <p>A short summary with page references. Later chats read it instead of the whole document.</p>
      <button type="button" className="digest-state-action" onClick={() => void generate(false)}>Generate</button>
      <small>Uses model tokens once.</small>
    </DigestState>;
  }

  return <section ref={root} className={`reader-digest${shown ? " is-shown" : ""}`} aria-label="Digest">{body}</section>;
}
