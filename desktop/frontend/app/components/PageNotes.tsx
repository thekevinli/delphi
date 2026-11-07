"use client";

/**
 * Notes on a webpage, kept where the PDF reader keeps them: in the margin.
 *
 * The two readers now behave the same way, because a reader who has learned one
 * of them has learned both — a mark is clicked to read what was written about
 * it, double-clicked to rewrite it, and deleted from the card that opens. What
 * differs is only where the geometry comes from. A PDF page is ours and its
 * marks are laid out in page coordinates; a webpage is someone else's document
 * inside a cross-origin frame, so the frame reports where it painted each mark
 * and this layer floats over the pane at those positions.
 *
 * Floating rather than in the flow has one consequence worth stating: nothing
 * here scrolls with the page by itself. The frame re-reports where the marks
 * are once a scroll, a zoom or a reflow settles, and the icons and any open
 * card move to follow them.
 */

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef } from "react";

import type { Highlight, Note } from "../lib/api";
import type { MarkGeometry } from "../lib/use-web-annotations";
import NoteMarker from "./NoteMarker";
import NotePreview from "./NotePreview";
import { NoteIcon } from "./ReaderSelectionMenu";

const NoteEditor = lazy(() => import("./NoteEditor"));

export type PageNoteCard = {
  highlightId: string;
  /** The middle and the top of the passage, in frame coordinates. */
  x: number;
  top: number;
  mode: "menu" | "preview" | "editor";
  /**
   * This mark was minted to carry this card. Dismissing the card without
   * writing anything takes the mark with it — otherwise pressing Note and
   * changing your mind leaves a highlight the reader never asked for, with no
   * obvious way to be rid of it.
   */
  ours: boolean;
};

const GUTTER = 12;

export function PageNoteLayer({
  drafts,
  frameBox,
  scale,
  card,
  onCard,
  pageClicks,
  highlights,
  notes,
  geometry,
  onSaveNote,
  onRemoveHighlight,
  onError,
}: {
  drafts: Map<string, string>;
  /** The iframe's box in the window, and the transform a stored DOM is shown at. */
  frameBox: DOMRect | null;
  scale: number;
  card: PageNoteCard | null;
  onCard: (card: PageNoteCard | null) => void;
  /** Counts the reader's clicks inside the page, which the window cannot see. */
  pageClicks: number;
  highlights: Highlight[];
  notes: Note[];
  geometry: MarkGeometry;
  onSaveNote: (note: Pick<Note, "highlightId" | "page" | "anchorY" | "quotedText" | "body">) => Promise<void>;
  onRemoveHighlight: (id: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const draft = useRef("");
  const busy = useRef(false);
  // A save asked for while another is in flight, replayed once that one has
  // kept the card open for a newer draft — dropping it swallowed the Enter.
  // Only a save: a queued Escape could read a stale note list and delete the
  // mark the first save just gave a note.
  const queuedSave = useRef(false);
  const closeRef = useRef<(save: boolean, previous?: PageNoteCard) => Promise<void>>(async () => {});
  const previousCard = useRef<{ card: PageNoteCard | null; clicks: number }>({ card: null, clicks: pageClicks });
  const notesRef = useRef(notes);
  useEffect(() => { notesRef.current = notes; }, [notes]);
  const cardRef = useRef<PageNoteCard | null>(card);
  useEffect(() => {
    cardRef.current = card;
    if (card?.mode === "editor") draft.current = drafts.get(card.highlightId) ?? notesRef.current.find(n => n.highlightId === card.highlightId)?.body ?? "";
    else draft.current = "";
  }, [card, drafts]);

  const noteFor = useCallback(
    (highlightId: string) => notes.find((note) => note.highlightId === highlightId),
    [notes],
  );


  const highlight = card ? highlights.find((item) => item.id === card.highlightId) : undefined;
  const note = card ? noteFor(card.highlightId) : undefined;

  /**
   * Closing the card is where a note is saved, and it is the same act whether
   * the reader pressed Save, clicked away, or pressed Escape. Mirrors the PDF
   * reader's `closeNote`: an empty body on a note that exists deletes it, and
   * an empty body on a mark this card minted deletes the mark.
   */
  const close = useCallback(
    async (save: boolean, previous?: PageNoteCard) => {
      const open = previous ?? cardRef.current;
      if (!open) return;
      if (busy.current) { queuedSave.current ||= save; return; }
      const existing = notesRef.current.find((item) => item.highlightId === open.highlightId);
      const originalBody = drafts.get(open.highlightId) ?? existing?.body ?? "";
      const written = originalBody.trim();
      busy.current = true;
      let kept = false;
      onError("");
      try {
        if (open.mode === "editor" && save && written) {
          await onSaveNote({
            highlightId: open.highlightId,
            page: null,
            anchorY: null,
            quotedText: highlights.find((item) => item.id === open.highlightId)?.text ?? "",
            body: written,
          });
        } else if (open.mode === "editor" && ((save && !written && existing) || (!existing && open.ours && (!save || !written)))) {
          await onRemoveHighlight(open.highlightId);
        }
        if (open.mode === "editor" && save && drafts.get(open.highlightId) !== undefined && drafts.get(open.highlightId) !== originalBody) { kept = true; return; }
        drafts.delete(open.highlightId);
        if (cardRef.current === open) { previousCard.current.card = null; onCard(null); }
      } catch (reason) {
        onError(reason instanceof Error ? reason.message : "Could not save that note. Your draft is still open.");
      } finally {
        busy.current = false;
        const queued = queuedSave.current;
        queuedSave.current = false;
        if (kept && queued && cardRef.current === open) void closeRef.current(true, open);
      }
    },
    [drafts, highlights, onCard, onError, onRemoveHighlight, onSaveNote],
  );
  useEffect(() => { closeRef.current = close; }, [close]);

  const remove = useCallback(
    async (highlightId: string) => {
      if (busy.current) return;
      busy.current = true;
      onError("");
      try {
        await onRemoveHighlight(highlightId);
        if (cardRef.current?.highlightId === highlightId) onCard(null);
      } catch (reason) {
        onError(reason instanceof Error ? reason.message : "Could not delete that highlight.");
      } finally {
        busy.current = false;
      }
    },
    [onCard, onError, onRemoveHighlight],
  );

  // A click anywhere else puts the card away, keeping whatever was written in
  // it. Pointer events only: a reader scrolling while they think about what to
  // write is not throwing it away.
  useEffect(() => {
    if (!card) return;
    const away = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".note-card, .selection-menu, .page-note-icon, .note-peek, .toast")) return;
      void close(true);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") void close(false);
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", escape);
    };
  }, [card, close]);

  // The same click away, made inside the page. It is the likeliest place for
  // the reader to click — back into what they were reading — and the one the
  // listener above can never hear.
  useEffect(() => {
    const previous = previousCard.current;
    previousCard.current = { card, clicks: pageClicks };
    if (previous.card && previous.card.highlightId !== card?.highlightId) void close(true, previous.card);
    else if (previous.clicks !== pageClicks && previous.card === card) void close(true);
  }, [card, pageClicks, close]);

  // A glance at a note ends when its passage leaves the page — not whenever
  // the page moves. The library folding away on the first click reflows the
  // text and nudges the scroll, and a card that closed on any scroll closed
  // before the reader had seen it. An editor stays however far its passage
  // goes: what is being written is not given up by scrolling.
  const frameHeight = frameBox ? frameBox.height / scale : 0;
  useEffect(() => {
    if (!card || card.mode === "editor" || !frameHeight) return;
    const at = geometry[card.highlightId];
    if (at && (at.bottom <= 0 || at.top >= frameHeight)) onCard(null);
  }, [card, geometry, frameHeight, onCard]);

  // A card is placed at its passage, then lifted by exactly as much as it
  // would run past the bottom of the frame — measured, because an editor is
  // three lines tall until the reader writes a paragraph into it, and a guess
  // at its height either clips a long note or throws a short one far from the
  // sentence it is about.
  const openRef = useRef<HTMLDivElement>(null);
  const frameBottom = frameBox?.bottom;
  useLayoutEffect(() => {
    const node = openRef.current;
    if (!node || frameBottom === undefined) return;
    const fit = () => {
      // Layout height, not the painted box: the card opens with a scale
      // animation, and measuring its first frame would lift it too little.
      const overflow = parseFloat(node.style.top) + node.offsetHeight - (frameBottom - GUTTER);
      node.style.marginTop = overflow > 0 ? `${-overflow}px` : "0px";
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [card, frameBottom, geometry]);

  if (!frameBox) return null;

  const place = (top: number) => ({
    top: Math.max(frameBox.top + GUTTER, frameBox.top + top * scale - 4),
    right: Math.max(GUTTER, window.innerWidth - frameBox.right + GUTTER),
    maxWidth: Math.max(0, frameBox.width - 2 * GUTTER),
  });
  // A mark any part of which is on screen keeps its icon, pinned to the top
  // edge while its first line is scrolled above it — a passage that is
  // visibly highlighted and has no way to reach its note looks like a bug.
  const visible = (at: { top: number; bottom: number }) => at.bottom > 0 && at.top < frameBox.height / scale;

  return (
    <>
      {notes.map((item) => {
        const at = geometry[item.highlightId];
        if (!at || !visible(at)) return null;
        if (card?.mode === "editor" && card.highlightId === item.highlightId) return null;
        return (
          <NoteMarker
            key={item.id}
            body={item.body}
            expanded={card?.mode === "preview" && card.highlightId === item.highlightId}
            className="page-note-icon"
            bounds={frameBox}
            style={{ top: frameBox.top + Math.max(14, Math.min(frameBox.height - 14, (Math.max(at.top, 0) + Math.min(at.bottom, frameHeight)) / 2 * scale)), right: Math.max(GUTTER, window.innerWidth - frameBox.right + GUTTER) }}
            onOpen={() => onCard(card?.mode === "preview" && card.highlightId === item.highlightId ? null : { highlightId: item.highlightId, x: 0, top: at.top, mode: "preview", ours: false })}
            onEdit={() => {
              draft.current = item.body;
              onCard({ highlightId: item.highlightId, x: 0, top: at.top, mode: "editor", ours: false });
            }}
          />
        );
      })}
      {card && highlight ? (
        card.mode === "menu" ? (
          <div
            className="selection-menu"
            // Where the frame last reported the mark, which is where it is now;
            // the click that opened this only says where it was then.
            style={{ left: frameBox.left + (geometry[card.highlightId]?.x ?? card.x) * scale, top: frameBox.top + (geometry[card.highlightId]?.top ?? card.top) * scale - 8 }}
            role="toolbar"
            aria-label="Highlighted passage"
          >
            <button
              onClick={() => {
                draft.current = note?.body ?? "";
                onCard({ ...card, mode: "editor" });
              }}
            >
              <NoteIcon />
              <span>{note ? "Edit note" : "Add note"}</span>
            </button>
            <button onClick={() => void remove(card.highlightId)}>
              <TrashGlyph />
              <span>Remove</span>
            </button>
          </div>
        ) : (
          // Both views sit below the passage and follow it as the frame scrolls.
          <div ref={openRef} className={`page-note-open pdf-note-open${card.mode === "preview" ? " pdf-note-read" : ""}`} style={place((geometry[card.highlightId]?.bottom ?? card.top) + 12 / scale)}>
            {/* A preview whose note has just been deleted is a card with
                nothing in it, not an invitation to write a new one. */}
            {card.mode === "preview" ? (note ? (
              <NotePreview
                body={note.body}
                onEdit={() => {
                  draft.current = note.body;
                  onCard({ ...card, mode: "editor" });
                }}
                onDelete={() => void remove(card.highlightId)}
              />
            ) : null) : (
              <Suspense
                fallback={
                  <div className="note-card note-card-loading" role="status">
                    <span className="note-loading">Opening…</span>
                  </div>
                }
              >
                <NoteEditor
                  key={card.highlightId}
                  value={drafts.get(card.highlightId) ?? note?.body ?? ""}
                  onChange={(body) => { draft.current = body; drafts.set(card.highlightId, body); }}
                  onSave={(body) => { draft.current = body; drafts.set(card.highlightId, body); void close(true); }}
                  onCancel={() => void close(false)}
                  onDelete={note ? () => void remove(card.highlightId) : undefined}
                />
              </Suspense>
            )}
          </div>
        )
      ) : null}
    </>
  );
}

function TrashGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8M6.8 7v3.5M9.2 7v3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
