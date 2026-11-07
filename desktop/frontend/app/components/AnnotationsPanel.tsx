"use client";
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import type { Highlight, Note } from "../lib/api";
import type { Placement } from "../lib/use-web-annotations";
import { condenseQuote } from "../lib/quote-text";
import { NoteBody } from "./NotePreview";
import { Skeleton, SkeletonBar } from "./Loading";
const EMPTY_SELECTION: string[] = [];
const NoteEditor = lazy(() => import("./NoteEditor"));

/** Where the editor will open, while its code loads: the quote's shape, outlined. */
function NoteOutline() {
  return <Skeleton label="Opening editor" className="note-editor-outline">
    <SkeletonBar width="94%" height={8} />
    <SkeletonBar width="82%" height={8} />
    <SkeletonBar width="56%" height={8} />
  </Skeleton>;
}
export type AnnotationActions = {
  drafts: Map<string, string>;
  highlights: Highlight[];
  notes: Note[];
  onHighlight: (selection: Omit<Highlight, "id" | "color">) => Promise<Highlight | null>;
  onRemoveHighlight: (id: string) => Promise<void>;
  onSaveNote: (note: Pick<Note, "highlightId" | "page" | "anchorY" | "quotedText" | "body">) => Promise<void>;
};
/** The durable collection remains readable independently of inline placement. */
export function AnnotationsPanel({ drafts, highlights, notes, onSaveNote, onRemoveHighlight, placements = [], selected = EMPTY_SELECTION, pageClicks = 0, onEditNote, onReveal }: Omit<AnnotationActions, "onHighlight"> & {
  placements?: Placement[];
  selected?: string[];
  /**
   * How many times the reader has clicked inside the document. A PDF is in
   * this window and `outside` below hears those clicks itself; a webpage is in
   * a frame of another origin, where a pointer event never leaves. Counting
   * them in the viewer that does hear the frame is how reading on puts this
   * panel away, in both readers, without either of them owning `open`.
   */
  pageClicks?: number;
  onEditNote?: (highlight: Highlight, note?: Note) => void;
  /**
   * Take the reader to the passage in the document. The list is an index of
   * what was marked, so an entry is also the way back to it. Returns false
   * when the passage has no place in the document on screen to go to.
   */
  onReveal?: (highlight: Highlight) => boolean | void;
}) {
  const panelId = useId();
  const container = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (event.target as HTMLElement)?.closest('[contenteditable="true"]')) return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const [visibleCount, setVisibleCount] = useState(50);
  const [editing, setEditing] = useState<Highlight | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const body = useRef("");
  const saving = useRef(false);
  // `selected` is the reader having clicked somewhere the panel has to answer
  // for — marks that overlap, or a mark whose place on the page is unknown.
  // A single, located mark is answered in the page, by the card over it.
  const [lastSelection, setLastSelection] = useState(selected);
  const [lastClicks, setLastClicks] = useState(pageClicks);
  if (selected !== lastSelection || pageClicks !== lastClicks) {
    setLastSelection(selected);
    setLastClicks(pageClicks);
    if (selected !== lastSelection && selected.length) setOpen(true);
    else if (pageClicks !== lastClicks) setOpen(false);
  }
  async function save() {
    if (!editing || saving.current)
      return;
    const value = body.current;
    if (!value.trim()) {
      setError("Write a note before saving.");
      return;
    }
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await onSaveNote({ highlightId: editing.id, page: editing.type === "pdf" ? editing.page! : null, anchorY: editing.type === "pdf" ? editing.rects?.[0]?.y ?? 0 : null, quotedText: editing.text, body: value });
      if (drafts.get(editing.id) === value) {
        drafts.delete(editing.id);
        setEditing(current => current?.id === editing.id ? null : current);
      }
    }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save. Your draft is still here.");
    }
    finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function remove(id: string) {
    if (saving.current)
      return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await onRemoveHighlight(id);
      if (editing?.id === id) {
        setEditing(null);
      }
    }
    catch (reason) {
      setError(String(reason));
    }
    finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const selectedSet = new Set(selected.slice(0, 50));
  const shown = open ? highlights.slice(0, visibleCount) : [];
  const shownIds = new Set(shown.map(h => h.id));
  if (open)
    for (const highlight of highlights)
      if ((selectedSet.has(highlight.id) || editing?.id === highlight.id) && !shownIds.has(highlight.id))
        shown.push(highlight);
  const noteByHighlight = new Map(notes.map(note => [note.highlightId, note]));
  const placementById = new Map(placements.map(place => [place.id, place]));
  return <aside ref={container} className="annotations-panel" aria-label="Annotations">
    <button ref={trigger} className="icon-button annotations-trigger" onClick={() => setOpen(!open)}
      aria-label={`Annotations${highlights.length ? ` (${highlights.length})` : ""}`}
      title="Highlights and notes" aria-expanded={open} aria-controls={panelId}>
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M5 3.5h10a1.5 1.5 0 0 1 1.5 1.5v7.5L12 17H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
        <path d="M12 17v-4.5h4.5M7 7h6M7 10h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      {highlights.length ? <span className="annotations-count">{highlights.length}</span> : null}
    </button>
    {open ? <div id={panelId} className="annotations-popover" role="region" aria-label="Highlights and notes">
      {/* The count is already on the trigger, and a reader looking at a list of
          two can see that it is two. The heading says what the list is. */}
      <header className="annotations-heading">
        <strong>Highlights &amp; Notes</strong>
        <button className="icon-button" aria-label="Close annotations" onClick={() => { setOpen(false); trigger.current?.focus(); }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
        </button>
      </header>
      <div className="annotations-list">
        {error ? <p className="annotations-message" role="alert">{error}</p> : null}
        {/* The heading already says what this is and how much of it there is.
            A panel that explains how to make a highlight is a manual, and the
            reader opened a quick view of the ones they have. */}
        {!highlights.length ? <p className="annotations-empty">Highlight a passage and it appears here.</p> : null}
        {shown.map(highlight => {
          const note = noteByHighlight.get(highlight.id);
          const status = placementById.get(highlight.id)?.status;
          const unresolved = highlight.type !== "pdf" && status !== "placed";
          // Where there is somewhere to go. A passage this version of the page
          // does not contain has no place to scroll to, and a card being edited
          // is the reader writing, not looking for where they were.
          const revealable = Boolean(onReveal) && !unresolved && editing?.id !== highlight.id;
          const reveal = () => { if (onReveal?.(highlight) !== false) setOpen(false); };
          const writing = editing?.id === highlight.id;
          return <section key={highlight.id} className={`annotation-entry${selectedSet.has(highlight.id) ? " annotation-selected" : ""}`}>
            <div className={revealable ? "annotation-target" : undefined} role={revealable ? "button" : undefined} tabIndex={revealable ? 0 : undefined}
              title={revealable ? "Show in the document" : undefined}
              // A link inside a note is the note's own; it opens, it does not scroll.
              onClick={revealable ? event => { if (!(event.target as HTMLElement).closest("a")) reveal(); } : undefined}
              onKeyDown={revealable ? event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); reveal(); } } : undefined}>
              <blockquote>{condenseQuote(highlight.text)}</blockquote>
              {!writing && note ? <NoteBody body={note.body}/> : null}
            </div>
            {unresolved ? <p className="annotation-location">{status === "missing" ? "Passage not found in this version" : status === "ambiguous" ? "Multiple matching passages" : "Location unavailable in this version"}</p> : null}
            {writing ? <>
              <Suspense fallback={<NoteOutline />}><NoteEditor key={highlight.id} value={drafts.get(highlight.id) ?? note?.body ?? ""}
                onChange={value => { body.current = value; drafts.set(highlight.id, value); }}
                onSave={value => { body.current = value; drafts.set(highlight.id, value); void save(); }}
                onCancel={() => { if (!busy) { drafts.delete(highlight.id); setEditing(null); } }}/></Suspense>
              <div className="annotation-entry-actions"><span>Enter to save · Shift Enter for a new line</span><button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button></div>
            </> : <div className="annotation-entry-actions">
              <button disabled={busy} onClick={() => {
                if (onEditNote) { onEditNote(highlight, note); setOpen(false); return; }
                body.current = drafts.get(highlight.id) ?? note?.body ?? ""; drafts.set(highlight.id, body.current); setEditing(highlight);
              }}>{note ? "Edit note" : "Add note"}</button>
              <button className="annotation-delete" disabled={busy} onClick={() => void remove(highlight.id)}
                aria-label={note ? "Delete highlight and note" : "Delete highlight"} title={note ? "Delete highlight and note" : "Delete highlight"}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 9h6l.5-9M6.5 7v4M9.5 7v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            </div>}
          </section>;
        })}
        {visibleCount < highlights.length ? <button className="annotations-more" onClick={() => setVisibleCount(n => n + 50)}>Show more</button> : null}
      </div>
    </div> : null}
  </aside>;
}
