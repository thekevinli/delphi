"use client";

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { API_BASE, Highlight, Note, PdfRect } from "../lib/api";
import { loadPdfEngine, type PdfDocument, type PdfModule } from "../lib/pdf-engine";
import { registerDocument, unregisterDocument } from "../lib/locator-index";
import { WindowToast } from "./Notice";
import { LoadingCaption } from "./Loading";
import NotePreview from "./NotePreview";
import NoteMarker from "./NoteMarker";
import { ReaderSelectionMenu } from "./ReaderSelectionMenu";
import { AnnotationsPanel } from "./AnnotationsPanel";
import { ReaderFind } from "./ReaderFind";
import { findDocumentText } from "../lib/document-find";
import { pdfFindMatches } from "../lib/pdf-find";
import {
  bandsIntersect,
  clampBandsToText,
  mergeIntoLineBands,
} from "../lib/highlight-rects";
// Shared with the topbar's account menu; see the module for why it does not
// live in this file any more.
import { useDismissOnOutsideActivity } from "../lib/use-dismiss";

// Tiptap and its ProseMirror stack only arrive when a note is actually *edited*.
// A reader who highlights and never writes should not pay for an editor, and
// nor should one who only opens a note to re-read it — that is `NotePreview`,
// which is a plain render of the same markdown and imports nothing.
const NoteEditor = lazy(() => import("./NoteEditor"));

type SelectionState = {
  text: string;
  page: number;
  rects: PdfRect[];
  x: number;
  y: number;
};

/**
 * Two scales, and they are not the same gesture.
 *
 * ZOOM is the −/+ control: it re-lays-out the document larger, so a PDF page is
 * re-rendered at the bigger size and web text rewraps to the column. Type gets
 * genuinely crisper.
 *
 * MAGNIFY is the trackpad pinch, and it deliberately changes no layout at all —
 * it scales the rendered surface so you can look closely at one part and pan
 * around it, the way pinching behaves on any native surface. Its floor is the
 * document at natural size, since pinching out past that has nothing left to
 * show; the gesture answers with a rubber band rather than doing nothing.
 */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.15;

export const MAGNIFY_MIN = 1;
export const MAGNIFY_MAX = 5;

/**
 * Pulling past the floor stretches a rubber band rather than firing an
 * animation: the document follows the fingers down, resisting harder the
 * further it goes, and only lets go once the gesture is over. RUBBER_FLOOR is
 * as small as it will ever get, RUBBER_RESIST is how much accumulated pull
 * spends most of that range.
 *
 * A pinch is only ever a burst of ctrl+wheel events — Chrome has no
 * gesturestart/gestureend, so fingers resting still on the trackpad look
 * exactly like fingers lifted. PINCH_HOLD_MS is therefore how long the stretch
 * is held before it counts as released; long enough to sit at the floor and
 * see the page holding against you, short enough not to feel stuck.
 */
const RUBBER_FLOOR = 0.88;
const RUBBER_RESIST = 120;
const PINCH_HOLD_MS = 350;
const RUBBER_SETTLE_MS = 520;

export const clampZoom = (scale: number) =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(scale * 100) / 100));

/**
 * A request to jump to a page and point at whatever was cited on it.
 *
 * `rect` is resolved before the jump, by `locator-index`, so arriving here is
 * only ever a scroll. It used to be a *label* the viewer had to go and find in
 * the rendered text layer, which could not work for the spelling a model
 * writes, and spent 3.6 seconds failing before outlining the whole page.
 * A null rect now means exactly one thing: a page was cited, not a place on it.
 */
export type PdfFocus = {
  page: number;
  rect: PdfRect | null;
  nonce: number;
};

type GuideState = { page: number; rect: PdfRect | null; nonce: number };

/** A PDF annotation carrying somewhere to go — out to the web, or to another
 * spot in the same document (an inline citation, a footnote back-reference). */
type PdfLink = { key: string; rect: PdfRect; url?: string; dest?: string | unknown[] };

/**
 * Highlights are merged again on the way to the screen, not only on capture.
 *
 * Everything stored before line-banding existed holds one rect per pdf.js span,
 * and re-merging on paint gives those the same clean stroke without a migration
 * — `mergeIntoLineBands` is idempotent, so a highlight captured today passes
 * through untouched. The cache is what keeps that off the render path: a
 * highlight's `rects` array keeps its identity between renders, so the work
 * happens once per highlight per page shape rather than once per frame.
 */
const bandCache = new WeakMap<PdfRect[], { aspect: number; bands: PdfRect[] }>();

/** Two band sets that are the same mark, allowing for float drift. */
function sameBands(a: PdfRect[], b: PdfRect[]): boolean {
  return (
    a.length === b.length &&
    a.every((band, index) =>
      (["x", "y", "w", "h"] as const).every(
        (key) => Math.abs(band[key] - b[index][key]) < 1e-6,
      ),
    )
  );
}

function paintedRects(rects: PdfRect[] | undefined, aspect: number): PdfRect[] {
  if (!rects?.length) return [];
  const cached = bandCache.get(rects);
  if (cached && cached.aspect === aspect) return cached.bands;
  const bands = mergeIntoLineBands(rects, aspect);
  bandCache.set(rects, { aspect, bands });
  return bands;
}

/**
 * The page's highlights as one geometry: a band per line of text, whoever drew
 * it.
 *
 * Marks that touch are merged here as well as at capture, because the capture
 * side only sees selections made since it existed — a paper highlighted twice
 * over the same words before then holds two records, and drawing both stacks
 * `multiply` over the same pixels and darkens the text. Bands are merged rather
 * than one being trimmed against the other because the reader is looking at a
 * mark, not at records: two abutting bands of slightly different heights read
 * as two marks with a seam even when nothing doubles.
 *
 * Each band belongs to the first highlight that helped draw it, which is what
 * clicking it removes.
 */
function unionOfHighlights(
  highlights: Highlight[],
  aspect: number,
  textBoxes: PdfRect[],
): Array<{ highlight: Highlight; band: PdfRect }> {
  const own = highlights.map((highlight) => ({
    highlight,
    bands: paintedRects(highlight.rects, aspect),
  }));
  const merged = clampBandsToText(
    mergeIntoLineBands(
      highlights.flatMap((highlight) => highlight.rects ?? []),
      aspect,
    ),
    textBoxes,
  );
  return merged.map((band) => ({
    band,
    highlight: (own.find((item) => bandsIntersect([band], item.bands)) ?? own[0])
      .highlight,
  }));
}

/**
 * Roughly one icon's height as a fraction of a page. Two notes on adjacent
 * lines would otherwise draw on top of each other.
 */
const NOTE_ICON_PITCH = 0.045;

/**
 * Where each note's icon sits in the gutter, nudged down so none covers another.
 *
 * Sorted by anchor and never by recency: a column that reshuffled between two
 * visits is one nobody can build a habit around, which is the same reason the
 * Memory sidebar's tree is deterministic.
 */
/**
 * Where the scroller must sit for a place on a page to be on screen: a third of
 * the way down the viewport for a known point, a whisker above the page itself
 * when all that was cited is the page. Null while that page element does not
 * exist — a cold document builds its pages as it paints them.
 *
 * Both jumps in this file go through here. They are different in every other
 * way — a chat citation re-asserts its target as the layout above it settles,
 * an in-PDF link scrolls smoothly once and is done — but they arrive at the
 * same arithmetic, and it was written out twice, down to the third and the
 * eight pixels.
 */
function scrollTopFor(node: HTMLElement, page: number, y: number | null): number | null {
  const pageEl = node.querySelector<HTMLElement>(`.pdf-page[data-page="${page}"]`);
  if (!pageEl) return null;
  return y !== null
    ? pageEl.offsetTop + y * pageEl.offsetHeight - node.clientHeight * 0.3
    : pageEl.offsetTop - 8;
}

function stackNotes(notes: Note[], highlights: Highlight[], aspect: number, textBoxes: PdfRect[]): Array<{ note: Note; top: number }> {
  // Use the same text-clamped bands as the visible highlight: stored boxes
  // can include extra ascent/descent space that shifts their visual centre.
  const ordered = notes.map(note => {
    const rects = highlights.find(highlight => highlight.id === note.highlightId)?.rects;
    const line = clampBandsToText(paintedRects(rects, aspect), textBoxes)[0];
    return { note, centre: line ? line.y + line.h / 2 : note.anchorY ?? 0 };
  }).sort((a, b) => a.centre - b.centre || a.note.id.localeCompare(b.note.id));
  let previous = -Infinity;
  return ordered.map(({ note, centre }) => {
    const top = Math.min(1 - NOTE_ICON_PITCH / 2, Math.max(NOTE_ICON_PITCH / 2, centre, previous + NOTE_ICON_PITCH));
    previous = top;
    return { note, top };
  });
}

/** A note card open in the gutter, whether it is new or being edited. */
type OpenNote = {
  persisted?: boolean;
  /** Absent while the note is being written for the first time. */
  noteId?: string;
  highlightId: string;
  page: number;
  anchorY: number;
  quotedText: string;
  body: string;
  /**
   * True when the Note button minted the stroke a moment ago, which is the only
   * case where backing out should take the stroke away again. A note opened
   * from the gutter must leave the reader's own highlight where it was.
   */
  strokeIsOurs: boolean;
};

function RemoveHighlightIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PdfViewer({
  projectId,
  paperId,
  fileUrl,
  highlights,
  notes,
  notesEnabled = false,
  annotationToolbar,
  drafts,
  focus,
  zoom,
  onHighlight,
  onRemoveHighlight,
  onSaveNote,
  onReply,
  onEngage,
}: {
  projectId: string;
  paperId: string;
  /** Override for a linked PDF whose bytes still live behind the page route. */
  fileUrl?: string;
  highlights: Highlight[];
  notes?: Note[];
  /** Whether the embedding reader supplies note persistence. */
  notesEnabled?: boolean;
  annotationToolbar?: HTMLElement | null;
  /** Unsaved note text, shared with the list so neither loses the other's. */
  drafts?: Map<string, string>;
  focus?: PdfFocus | null;
  zoom: number;
  onHighlight: (selection: Omit<Highlight, "id" | "color">) => Promise<Highlight | null>;
  onRemoveHighlight: (highlightId: string) => Promise<void>;
  onSaveNote?: (note: {
    highlightId: string;
    page: number;
    anchorY: number;
    quotedText: string;
    body: string;
  }) => Promise<void>;
  onReply: (text: string) => void;
  onEngage: () => void;
}) {
  const [pdfjs, setPdfjs] = useState<PdfModule | null>(null);
  const [document, setDocument] = useState<PdfDocument | null>(null);
  const findSerial = useRef(0);
  const findPages = useRef<{ document: PdfDocument; pages: Promise<string[]> } | null>(null);
  const [findMatch, setFindMatch] = useState<{ page: number; occurrence: number; query: string } | null>(null);
  useEffect(() => {
    if (!findMatch) return;
    const selector = `.pdf-page[data-page="${findMatch.page}"] .text-layer`;
    const root = window.document.querySelector(selector);
    if (!root) return;
    const paint = () => {
      findDocumentText(findMatch.query, findMatch.occurrence, selector);
    };
    paint();
    const observer = new MutationObserver(paint);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [findMatch, zoom]);
  // The column's width; zoom multiplies it at render time so pages are drawn at
  // the enlarged size rather than scaled up from a smaller raster.
  const [width, setWidth] = useState(720);
  const pagesRef = useRef<HTMLDivElement>(null);
  const resizePreviewRef = useRef<HTMLDivElement>(null);
  const renderedWidthRef = useRef(width);
  useLayoutEffect(() => {
    renderedWidthRef.current = width;
    if (resizePreviewRef.current) resizePreviewRef.current.style.transform = "";
  }, [width]);
  // Magnification lives in a ref, not state: it changes many times per gesture
  // and must not cost a render.
  const magnifyRef = useRef(MAGNIFY_MIN);
  // Accumulated pull past the floor, and the timer that decides the fingers
  // have left the trackpad.
  const pullRef = useRef(0);
  const holdRef = useRef<number | undefined>(undefined);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  // A highlight the reader has clicked on, offering the one thing to do with
  // an existing highlight: take it back. Positioned like the selection menu,
  // but never both at once — placing a new selection was the reader picking
  // something else to act on.
  // The note card, open in the gutter. `body` is the value the editor mounted
  // with, updated as it changes so a click away can save what is on screen.
  const [openNote, setOpenNote] = useState<OpenNote | null>(null);
  // Read by the click-away handler, which is installed once and would otherwise
  // close over the note that was open when it was. Kept in step by an effect
  // rather than during render: it is not rendering state, and no pointer event
  // can reach the handler before effects for that render have run.
  const openNoteRef = useRef<OpenNote | null>(null);
  const savingNote = useRef(false);
  const [annotationError, setAnnotationError] = useState("");
  const [overlapping, setOverlapping] = useState<string[]>([]);
  // A clicked note stays open independently of the transient hover peek.
  const [previewNote, setPreviewNote] = useState<Note | null>(null);
  const [activeHighlight, setActiveHighlight] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [error, setError] = useState("");
  // pdf.js reports a missing file (a 404, or a deleted local path) as a
  // ResponseException with `missing: true` — distinct from a corrupt or
  // unreadable PDF, and worth its own wording rather than a raw error string.
  const [unavailable, setUnavailable] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [guide, setGuide] = useState<GuideState | null>(null);
  // Page-1 aspect, used to size pages that have not been drawn yet.
  const [pageRatio, setPageRatio] = useState(1.294);
  const viewerRef = useRef<HTMLDivElement>(null);
  const pointerStartRef = useRef<{
    span: HTMLElement;
    x: number;
    y: number;
  } | null>(null);
  const lastSpanRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let active = true;
    loadPdfEngine().then((module) => {
      if (active) setPdfjs(module);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!pdfjs) return;
    let active = true;
    const task = pdfjs.getDocument({
      url:
        fileUrl ??
        `${API_BASE}/api/projects/${projectId}/papers/${paperId}/file`,
      withCredentials: true,
    });
    task.promise
      .then(async (loaded) => {
        if (!active) return;
        setError("");
        setUnavailable(false);
        setDocument(loaded as PdfDocument);
        // Lend the proxy to the locator index so following a citation into this
        // paper does not parse the same file a second time. The loan is ours to
        // end: the cleanup below destroys the task, so the index must stop
        // using it at exactly the same moment.
        registerDocument(paperId, loaded as PdfDocument);
        try {
          const first = await (loaded as PdfDocument).getPage(1);
          const viewport = first.getViewport({ scale: 1 });
          if (active && viewport.width > 0) {
            setPageRatio(viewport.height / viewport.width);
          }
        } catch {
          // Keep the default ratio; placeholders stay approximate.
        }
      })
      .catch((reason) => {
        if (!active) return;
        const missing =
          typeof reason === "object" &&
          reason !== null &&
          (reason as { missing?: unknown }).missing === true;
        setUnavailable(missing);
        setError(missing ? "" : String(reason));
      });
    return () => {
      active = false;
      unregisterDocument(paperId);
      task.destroy();
    };
  }, [fileUrl, paperId, pdfjs, projectId]);

  useEffect(() => {
    const node = viewerRef.current;
    if (!node) return;
    let settleTimer: number | undefined;
    let measured = false;
    const commitWidth = (nextWidth: number) => {
      window.clearTimeout(settleTimer);
      setWidth((currentWidth) =>
        Math.abs(currentWidth - nextWidth) < 1 ? currentWidth : nextWidth,
      );
    };
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.max(1, entry.contentRect.width);
      if (!measured) {
        measured = true;
        commitWidth(nextWidth);
        return;
      }
      // Scale the existing page and its annotation layers while the window
      // moves. Only rasterize again after resizing pauses, not at every pixel.
      if (resizePreviewRef.current) {
        resizePreviewRef.current.style.transform = `scale(${nextWidth / renderedWidthRef.current})`;
      }
      window.clearTimeout(settleTimer);
      const panels = node.closest(".three-panel");
      // While the column is being dragged or is animating open/shut, the
      // observer fires every frame — and every commit re-renders the page
      // through pdf.js. Remeasure once the movement settles.
      if (
        panels?.classList.contains("is-panel-resizing") ||
        panels?.classList.contains("is-panel-animating")
      ) {
        return;
      }
      settleTimer = window.setTimeout(() => commitWidth(nextWidth), 140);
    });
    const finishPanelResize = () => {
      // Read the settled content box. The last observer notification may
      // precede the final grid frame, and the border box includes the gutters.
      const style = getComputedStyle(node);
      commitWidth(Math.max(1, node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
    };
    observer.observe(node);
    window.addEventListener("delphi-panel-resize-end", finishPanelResize);
    return () => {
      observer.disconnect();
      window.clearTimeout(settleTimer);
      window.removeEventListener("delphi-panel-resize-end", finishPanelResize);
    };
  }, []);

  /**
   * Trackpad pinch — magnification, not zoom.
   *
   * A pinch asks to look closer at the page as it is laid out, so the layout
   * holds still and the rendered surface is scaled: pan around it by scrolling.
   * The scale is written straight to the DOM rather than held in React state,
   * because a pinch is a burst of wheel events and a render per tick is exactly
   * the judder this replaces. The −/+ control keeps doing the other thing —
   * re-rendering pages larger, so the type is genuinely crisper.
   *
   * Registered by hand: React attaches wheel listeners passively, and a passive
   * listener cannot preventDefault, without which the browser magnifies the
   * whole of Delphi instead of the document.
   */
  useEffect(() => {
    const scroller = viewerRef.current;
    const pages = pagesRef.current;
    if (!scroller || !pages) return;

    const paint = (scale: number, animate: boolean) => {
      pages.style.transformOrigin = "0 0";
      pages.style.transition = animate
        ? "transform 220ms cubic-bezier(.2,.7,.3,1)"
        : "";
      pages.style.transform = scale === 1 ? "" : `scale(${scale})`;
    };

    // Lets go of the stretch, slowly. No overshoot past natural size, and an
    // easing that spends its time where the eye is rather than covering most
    // of the distance in the first few frames: a quick round trip through 0.82
    // and back is the flash this replaces.
    const settle = () => {
      pullRef.current = 0;
      pages.style.transition = `transform ${RUBBER_SETTLE_MS}ms cubic-bezier(.33,1,.68,1)`;
      pages.style.transform = "";
    };

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();

      const previous = magnifyRef.current;
      // Positive delta pinches out; at the floor there is nothing left to
      // shrink, so it goes into the band instead.
      let delta = event.deltaY;
      if (previous === MAGNIFY_MIN && (delta > 0 || pullRef.current > 0)) {
        if (!pullRef.current) {
          // Shrink towards the middle of what is on screen, not towards the
          // page origin: a corner-anchored stretch reads as the document
          // sliding away rather than as the whole of it giving a little. Set
          // once per gesture so the anchor cannot drift as the pull deepens.
          //
          // The box has to be measured with nothing scaling it. A pinch is a
          // stop-start burst, so the band is often re-grabbed while the last
          // release is still settling — and clearing the inline transform is
          // not enough, because the transition keeps animating the element
          // until it is cancelled and the rect would report whatever
          // half-finished scale it is passing through. That is what anchored
          // the stretch off-centre.
          pages.getAnimations().forEach((animation) => animation.cancel());
          pages.style.transition = "";
          pages.style.transform = "";
          const viewport = scroller.getBoundingClientRect();
          const pagesBox = pages.getBoundingClientRect();
          pages.style.transformOrigin = `${
            viewport.left + scroller.clientLeft + scroller.clientWidth / 2 -
            pagesBox.left
          }px ${
            viewport.top + scroller.clientTop + scroller.clientHeight / 2 -
            pagesBox.top
          }px`;
        }
        window.clearTimeout(holdRef.current);
        // Pinching back in pays the stretch off before it magnifies again, so
        // the band never snaps out from under the fingers.
        const paid = pullRef.current + delta;
        pullRef.current = Math.max(0, paid);
        if (pullRef.current > 0) {
          const stretch =
            RUBBER_FLOOR +
            (1 - RUBBER_FLOOR) * Math.exp(-pullRef.current / RUBBER_RESIST);
          pages.style.transition = "";
          pages.style.transform = `scale(${stretch})`;
          holdRef.current = window.setTimeout(settle, PINCH_HOLD_MS);
          return;
        }
        settle();
        if (paid >= 0) return;
        // Only what is left of the pinch after the band goes slack magnifies,
        // or the tick that finishes paying it off would also be spent lifting
        // the page off natural size — a visible jump at the hand-over.
        delta = paid;
      }

      const next = previous * Math.exp(-delta / 180);
      const scale = Math.min(MAGNIFY_MAX, Math.max(MAGNIFY_MIN, next));
      magnifyRef.current = scale;
      // Pin the point under the fingers so the pinch grabs the page rather
      // than resizing it from a corner.
      const box = scroller.getBoundingClientRect();
      const localX = event.clientX - box.left;
      const localY = event.clientY - box.top;
      const pageX = (scroller.scrollLeft + localX) / previous;
      const pageY = (scroller.scrollTop + localY) / previous;
      paint(scale, false);
      scroller.scrollLeft = pageX * scale - localX;
      scroller.scrollTop = pageY * scale - localY;
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.clearTimeout(holdRef.current);
      scroller.removeEventListener("wheel", onWheel);
    };
  }, []);

  const captureSelection = useCallback((fallback?: {
    start: HTMLElement;
    end: HTMLElement;
    x: number;
    y: number;
  }) => {
    const nativeSelection = window.getSelection();
    const text = nativeSelection?.toString().trim();
    if (nativeSelection && text && nativeSelection.rangeCount > 0) {
      const range = nativeSelection.getRangeAt(0);
      const start =
        range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      const pageNode = start?.closest<HTMLElement>(".pdf-page");
      if (!pageNode) return;
      const pageBox = pageNode.getBoundingClientRect();
      const selectionBox = range.getBoundingClientRect();
      // One box per text-layer span crossed, which is a dozen per line of prose.
      // Merged into one band per line before anything sees them, so the preview,
      // the stored record and the annotated export share a single geometry.
      const rects = mergeIntoLineBands(
        Array.from(range.getClientRects())
          .filter((rect) => rect.width > 1 && rect.height > 1)
          .map((rect) => ({
            x: Math.max(0, (rect.left - pageBox.left) / pageBox.width),
            y: Math.max(0, (rect.top - pageBox.top) / pageBox.height),
            w: Math.min(1, rect.width / pageBox.width),
            h: Math.min(1, rect.height / pageBox.height),
          })),
        pageBox.width / pageBox.height,
      );
      if (!rects.length) return;
      setSelection({
        text,
        page: Number(pageNode.dataset.page),
        rects,
        x: selectionBox.left + selectionBox.width / 2,
        y: selectionBox.top - 10,
      });
      return;
    }

    // Some WebKit builds expose PDF.js text spans but do not reliably create
    // a native Range while dragging across transparent text. Fall back to the
    // actual spans crossed by the pointer so highlighting and quoting still work.
    if (!fallback) {
      setSelection(null);
      return;
    }
    const startPage = fallback.start.closest<HTMLElement>(".pdf-page");
    const endPage = fallback.end.closest<HTMLElement>(".pdf-page");
    if (!startPage || startPage !== endPage) return;
    const spans = Array.from(
      startPage.querySelectorAll<HTMLElement>(".text-layer span"),
    ).filter((span) => span.textContent?.trim());
    const startIndex = spans.indexOf(fallback.start);
    const endIndex = spans.indexOf(fallback.end);
    if (startIndex < 0 || endIndex < 0) return;
    const [from, to] =
      startIndex <= endIndex
        ? [startIndex, endIndex]
        : [endIndex, startIndex];
    const selectedSpans = spans.slice(from, to + 1);
    const fallbackText = selectedSpans
      .map((span) => span.textContent?.trim())
      .filter(Boolean)
      .join(" ");
    if (!fallbackText) return;
    const pageBox = startPage.getBoundingClientRect();
    // Literally one box per span here, so this path needs the merge most.
    const rects = mergeIntoLineBands(
      selectedSpans.map((span) => {
        const rect = span.getBoundingClientRect();
        return {
          x: Math.max(0, (rect.left - pageBox.left) / pageBox.width),
          y: Math.max(0, (rect.top - pageBox.top) / pageBox.height),
          w: Math.min(1, rect.width / pageBox.width),
          h: Math.min(1, rect.height / pageBox.height),
        };
      }),
      pageBox.width / pageBox.height,
    );
    if (!rects.length) return;
    setSelection({
      text: fallbackText,
      page: Number(startPage.dataset.page),
      rects,
      x: fallback.x,
      y: fallback.y - 10,
    });
  }, []);

  const clearSelection = useCallback(() => {
    const nativeSelection = window.getSelection();
    if (typeof nativeSelection?.removeAllRanges === "function") {
      nativeSelection.removeAllRanges();
    }
    setSelection(null);
  }, []);

  const clearActiveHighlight = useCallback(() => setActiveHighlight(null), []);

  const closeNote = useCallback(
    async (save: boolean) => {
      const open = openNoteRef.current;
      if (!open || savingNote.current) return;
      const originalBody = open.body;
      savingNote.current = true;
      setAnnotationError("");
      try {
        if (save && open.body.trim()) {
          if (!onSaveNote) throw new Error("Notes are unavailable");
          await onSaveNote({
            highlightId: open.highlightId, page: open.page,
            anchorY: open.anchorY, quotedText: open.quotedText,
            body: open.body.trim(),
          });
          open.persisted = true;
        } else if ((save && (open.noteId || open.persisted)) || (!open.noteId && !open.persisted && open.strokeIsOurs)) {
          // One authoritative deletion cascades to the associated note.
          await onRemoveHighlight(open.highlightId);
        }
        if (openNoteRef.current === open && open.body === originalBody) {
          openNoteRef.current = null;
          setOpenNote(null);
        }
      } catch (reason) {
        setAnnotationError(reason instanceof Error ? reason.message : "Could not save note. Your draft is still open.");
      } finally {
        savingNote.current = false;
      }
    },
    [onRemoveHighlight, onSaveNote],
  );

  /** A deliberate click pins the full note; hover stays local to the marker. */
  const previewExistingNote = useCallback((note: Note) => {
    setActiveHighlight(null);
    setPreviewNote((current) => (current?.id === note.id ? null : note));
  }, []);

  const closePreview = useCallback(() => {
    setPreviewNote(null);
  }, []);

  /** Delete from the preview: the same one act as deleting from the editor. */
  const deleteNote = useCallback(
    async (note: Note) => {
      try {
        await onRemoveHighlight(note.highlightId);
        closePreview();
      } catch (reason) {
        setAnnotationError(reason instanceof Error ? reason.message : "Could not delete note");
      }
    },
    [closePreview, onRemoveHighlight],
  );

  const openExistingNote = useCallback(
    async (note: Note) => {
      if(openNoteRef.current?.highlightId===note.highlightId)return;
      await closeNote(true);
      if(openNoteRef.current)return;
      clearSelection();
      setActiveHighlight(null);
      // The preview is what the editor replaces; leaving it mounted would draw
      // the note twice at the same anchor.
      closePreview();
      setOpenNote({
        noteId: note.id,
        highlightId: note.highlightId,
        page: note.page!,
        anchorY: note.anchorY!,
        quotedText: note.quotedText,
        body: note.body,
        strokeIsOurs: false,
      });
    },
    [clearSelection, closePreview, closeNote],
  );

  // Anywhere else, or Escape. Wheel is included — unlike the editor, a preview
  // holds nothing the reader would lose, and scrolling past the line it belongs
  // to is exactly when they have finished with it.
  useDismissOnOutsideActivity(
    !!previewNote,
    ".note-card, .pdf-note-icon, .note-peek",
    closePreview,
  );

  // A click that lands off any text span — the page margin, a figure, blank
  // canvas — never reaches captureSelection at all (beginDragSelection found
  // nothing to anchor a drag to), so the Reply/Highlight menu and its orange
  // preview would otherwise linger after the reader's attention has clearly
  // moved elsewhere.
  useDismissOnOutsideActivity(!!selection, ".selection-menu", clearSelection);

  // Any other pointer action — starting a new selection, scrolling, clicking
  // elsewhere — puts the highlight menu away.
  useDismissOnOutsideActivity(
    !!activeHighlight,
    ".selection-menu.single",
    clearActiveHighlight,
  );

  useEffect(() => {
    openNoteRef.current = openNote;
  }, [openNote]);

  // A click away collapses the card, saving whatever is in it. Deliberately not
  // routed through `useDismissOnOutsideActivity`: that one also fires on wheel,
  // and the card is anchored to the page, so scrolling while thinking about
  // what to write is not a reason to throw the thought away.
  useEffect(() => {
    if (!openNote) return;
    const away = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".note-card, .pdf-note-icon, .selection-menu, .toast")
      ) {
        return;
      }
      void closeNote(true);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") void closeNote(false);
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", onEscape);
    };
  }, [openNote, closeNote]);

  const noteByHighlight = useMemo(() => {
    const index = new Map<string, Note>();
    for (const note of notes ?? []) index.set(note.highlightId, note);
    return index;
  }, [notes]);

  const handleHighlightClick = useCallback(
    (highlight: Highlight, x: number, y: number, candidates?: Highlight[]) => {
      clearSelection();
      setOverlapping([]);
      if (candidates && candidates.length > 1) { setOverlapping(candidates.map(item => item.id)); return; }
      // A stroke with a note on it shows the note. Offering "remove highlight"
      // as the only thing to do with it would make the reader's own writing
      // reachable exclusively from the margin icon. Reading it, not editing it:
      // the double click below is the way in.
      const note = noteByHighlight.get(highlight.id);
      if (note) {
        previewExistingNote(note);
        return;
      }
      setActiveHighlight({ id: highlight.id, x, y: y - 10 });
    },
    [clearSelection, noteByHighlight, previewExistingNote],
  );

  const handleHighlightEdit = useCallback(
    (highlight: Highlight) => {
      const note = noteByHighlight.get(highlight.id);
      if (note) openExistingNote(note);
    },
    [noteByHighlight, openExistingNote],
  );

  const resolveTextSpan = useCallback(
    (target: EventTarget | null, x: number, y: number) => {
      const direct =
        target instanceof Element
          ? target.closest<HTMLElement>(".text-layer span")
          : null;
      if (direct) return direct;
      for (const element of window.document.elementsFromPoint(x, y)) {
        const span = element.closest<HTMLElement>(".text-layer span");
        if (span) return span;
      }
      return null;
    },
    [],
  );

  const beginDragSelection = useCallback(
    (event: ReactPointerEvent<HTMLDivElement> | ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const span = resolveTextSpan(event.target, event.clientX, event.clientY);
      pointerStartRef.current = span
        ? { span, x: event.clientX, y: event.clientY }
        : null;
      lastSpanRef.current = span;
    },
    [resolveTextSpan],
  );

  const trackDragSelection = useCallback(
    (event: ReactPointerEvent<HTMLDivElement> | ReactMouseEvent<HTMLDivElement>) => {
      if (!pointerStartRef.current) return;
      const span = resolveTextSpan(event.target, event.clientX, event.clientY);
      if (span) lastSpanRef.current = span;
    },
    [resolveTextSpan],
  );

  const finishDragSelection = useCallback(
    (event: ReactPointerEvent<HTMLDivElement> | ReactMouseEvent<HTMLDivElement>) => {
      const start = pointerStartRef.current;
      if (!start || event.button !== 0) return;
      const end =
        resolveTextSpan(event.target, event.clientX, event.clientY) ??
        lastSpanRef.current;
      pointerStartRef.current = null;
      lastSpanRef.current = null;
      const moved =
        Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 4;
      window.setTimeout(
        () =>
          captureSelection(
            end && moved
              ? {
                  start: start.span,
                  end,
                  x: event.clientX,
                  y: event.clientY,
                }
              : undefined,
          ),
        0,
      );
    },
    [captureSelection, resolveTextSpan],
  );

  useEffect(() => {
    const node = viewerRef.current;
    if (!document || !node) return;
    setCurrentPage(1);
    const pages = Array.from(node.querySelectorAll<HTMLElement>(".pdf-page"));
    if (!pages.length) return;
    const ratios = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page);
          ratios.set(page, entry.intersectionRatio);
        }
        let bestPage = 1;
        let bestRatio = 0;
        for (const [page, ratio] of ratios) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestPage = page;
          }
        }
        if (bestRatio > 0) setCurrentPage(bestPage);
      },
      { root: node, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    pages.forEach((page) => observer.observe(page));
    return () => observer.disconnect();
  }, [document, width]);

  // Follow a citation: scroll to its page, then point at the cited element once
  // PDF.js has painted enough of the text layer for us to find it.
  useEffect(() => {
    if (!focus || !document) return;
    const node = viewerRef.current;
    if (!node) return;

    let cancelled = false;
    let attempts = 0;
    let pollTimer = 0;
    let clearTimer = 0;

    const settle = (rect: PdfRect | null) => {
      if (cancelled) return;
      setGuide({ page: focus.page, rect, nonce: focus.nonce });
      clearTimer = window.setTimeout(() => {
        if (!cancelled) setGuide(null);
      }, 3000);
    };

    /**
     * Hold the viewport on a target that is still moving.
     *
     * A cold PDF open is still settling its own layout — pdf.js sizing pages,
     * the container's ResizeObserver committing its measured width — for a
     * moment after the page it wants is first found, and a scroll issued into
     * the middle of that gets silently clamped back by a transient shrink no
     * later frame ever undoes on its own. Re-asserting across a few frames is
     * what survives that, where a single `scrollTo` (even a non-smooth one)
     * did not.
     *
     * The target is recomputed each time rather than frozen. Every page above
     * the cited one is a placeholder of approximate height until pdf.js paints
     * it, so each one that lands moves the cited page down — and re-applying a
     * pixel value measured before they arrived leaves the citation hundreds of
     * pixels off the top of the screen. This used to be hidden: the scroll
     * waited on a text-layer search that could only succeed once layout had
     * long settled. Nothing is searched for any more, so the jump is issued the
     * moment the page element exists, and the drift is real.
     */
    const hold = (place: () => number | null) => {
      const apply = () => {
        if (cancelled) return;
        const top = place();
        if (top !== null) node.scrollTop = Math.max(0, top);
      };
      apply();
      requestAnimationFrame(apply);
      requestAnimationFrame(() => requestAnimationFrame(apply));
      window.setTimeout(apply, 200);
      window.setTimeout(apply, 600);
    };

    /** Where the cited place currently is, or null while its page is unbuilt. */
    const place = () => scrollTopFor(node, focus.page, focus.rect?.y ?? null);

    // The only thing left to wait for is the page element itself; where to
    // point on it was decided before the jump was issued.
    const attempt = () => {
      if (cancelled) return;
      if (place() !== null) {
        hold(place);
        settle(focus.rect);
        return;
      }

      attempts += 1;
      if (attempts >= 60) {
        settle(null);
        return;
      }
      pollTimer = window.setTimeout(attempt, 60);
    };

    pollTimer = window.setTimeout(attempt, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [focus, document]);

  const goToPage = (page: number) => {
    const node = viewerRef.current;
    if (!node || !document) return;
    const clamped = Math.min(Math.max(1, page), document.numPages);
    node
      .querySelector<HTMLElement>(`[data-page="${clamped}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Shared by an in-PDF link click: the destination page and point are already
  // known (unlike a chat citation, nothing needs to be found in the rendered
  // text), so this scrolls straight there. Deliberately no guide flash: a
  // destination's stored coordinate is often just wherever the PDF's author
  // placed the anchor — sometimes mid-figure, mid-table, or off by a line —
  // and a translucent box drawn at that exact, occasionally-odd spot reads as
  // a formatting bug rather than the arrival point it is. The scroll itself
  // is confirmation enough that the click did something.
  const jumpToLink = useCallback((page: number, y: number | null) => {
    const node = viewerRef.current;
    if (!node) return;
    const top = scrollTopFor(node, page, y);
    if (top !== null) node.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, []);

  /**
   * The annotations list's way back to a stroke: scroll until its middle is
   * the middle of the view. The stroke is already painted, so arriving at it
   * is the whole of the answer — the same reasoning as a link's jump, which
   * draws no guide either.
   */
  const revealHighlight = useCallback((highlight: Highlight) => {
    const node = viewerRef.current;
    const rects = highlight.rects ?? [];
    if (!node || highlight.type !== "pdf" || !highlight.page || !rects.length) return false;
    const pageEl = node.querySelector<HTMLElement>(`.pdf-page[data-page="${highlight.page}"]`);
    if (!pageEl) return false;
    const top = Math.min(...rects.map(rect => rect.y));
    const bottom = Math.max(...rects.map(rect => rect.y + rect.h));
    const middle = pageEl.offsetTop + ((top + bottom) / 2) * pageEl.offsetHeight;
    node.scrollTo({ top: Math.max(0, middle - node.clientHeight / 2), behavior: "smooth" });
    return true;
  }, []);

  // An internal PDF link (an inline citation, a footnote back-reference) only
  // gives a destination, not the label text a chat citation carries — so this
  // resolves it through pdf.js instead of searching the rendered page for a
  // caption. A destination that fails to resolve is left alone: the reader
  // loses a shortcut, not the document.
  const resolveDestination = useCallback(
    async (dest: string | unknown[]) => {
      if (!document) return;
      try {
        const explicit = typeof dest === "string" ? await document.getDestination(dest) : dest;
        if (!Array.isArray(explicit) || !explicit.length) return;
        const [ref, style, c0, c1] = explicit as [
          unknown,
          { name?: string } | undefined,
          number | null | undefined,
          number | null | undefined,
        ];
        const pageIndex =
          typeof ref === "number" ? ref : await document.getPageIndex(ref as never);
        const targetPage = pageIndex + 1;
        let y: number | null = null;
        const name = style?.name;
        // XYZ carries an exact point; FitH/FitBH carry just the top edge. Other
        // fit styles (Fit, FitB, FitR…) have nothing to point at, so the jump
        // just lands on the top of the page.
        const point =
          name === "XYZ" && typeof c0 === "number" && typeof c1 === "number"
            ? [c0, c1]
            : (name === "FitH" || name === "FitBH") && typeof c0 === "number"
              ? [0, c0]
              : null;
        if (point) {
          const targetDoc = await document.getPage(targetPage);
          const natural = targetDoc.getViewport({ scale: 1 });
          const [, vy] = natural.convertToViewportPoint(point[0], point[1]);
          y = Math.min(1, Math.max(0, vy / natural.height));
        }
        jumpToLink(targetPage, y);
      } catch {
        // See comment above: silently give up rather than surface an error.
      }
    },
    [document, jumpToLink],
  );

  const handleLinkActivate = useCallback(
    (link: { url?: string; dest?: string | unknown[] }) => {
      if (link.dest) void resolveDestination(link.dest);
    },
    [resolveDestination],
  );

  const replyToSelection = () => {
    if (!selection) return;
    onReply(selection.text);
    clearSelection();
  };

  /**
   * The page as drawn, so bands captured on one page shape can be compared with
   * bands stored from another. Measured rather than assumed: `pageRatio` is
   * page 1's aspect, and a paper with a landscape figure page has more than one.
   */
  const pageAspect = (page: number) => {
    const box = pagesRef.current
      ?.querySelector<HTMLElement>(`.pdf-page[data-page="${page}"]`)
      ?.getBoundingClientRect();
    if (box && box.width > 0 && box.height > 0) return box.width / box.height;
    return pageRatio > 0 ? 1 / pageRatio : 1;
  };

  // Records remain independent: deleting an overlapping record also deletes its
  // note. Only the painted bands are unioned; exact duplicates reuse their ID.
  const unionHighlight = async (
    page: number,
    rects: PdfRect[],
    text: string,
  ): Promise<Highlight | null> => {
    const aspect = pageAspect(page);
    const bands = mergeIntoLineBands(rects, aspect);
    const duplicate = highlights.find((item) =>
      item.type === "pdf" && item.page === page && item.text === text &&
      sameBands(bands, paintedRects(item.rects, aspect)),
    );
    if (duplicate) return duplicate;
    try {
      return await onHighlight({ type: "pdf", page, rects: bands, text });
    } catch (reason) {
      setAnnotationError(reason instanceof Error ? reason.message : "Could not save highlight");
      return null;
    }
  };

  const saveSelection = async () => {
    if (!selection) return;
    if (await unionHighlight(selection.page, selection.rects, selection.text)) clearSelection();
  };

  /**
   * A note always has a stroke under it, so the Note button creates one first
   * and then opens the card over it. The stroke is what owns where the note
   * points — writing the note against raw coordinates would give the same fact
   * two homes, and one of them would eventually be wrong.
   */
  const startNote = async () => {
    if (!selection) return;
    await closeNote(true);
    if(openNoteRef.current)return;
    const stroke = await unionHighlight(
      selection.page,
      selection.rects,
      selection.text,
    );
    if (!stroke) return;
    clearSelection();
    // A stroke that already carries a note: this is a request to read it, not a
    // second note at the same anchor — a stroke holds one.
    const existing = noteByHighlight.get(stroke.id);
    if (existing) {
      previewExistingNote(existing);
      return;
    }
    setOpenNote({
      highlightId: stroke.id,
      page: selection.page,
      anchorY: selection.rects[0]?.y ?? 0,
      quotedText: selection.text,
      body: "",
      // Backing out takes the stroke only when this card is what made it. A
      // mark the reader drew earlier stays whatever they do with the card.
      strokeIsOurs: !highlights.some((item) => item.id === stroke.id),
    });
  };

  const removeActiveHighlight = async () => {
    if (!activeHighlight) return;
    const { id } = activeHighlight;
    setActiveHighlight(null);
    await onRemoveHighlight(id);
  };

  // Linked PDFs (ArXiv and friends) can sit on an empty panel for tens of
  // seconds while bytes stream through the page route; a quiet void reads as
  // broken. Local uploads are usually fast, but the same overlay covers the
  // brief gap between mount and the first page so both paths feel intentional.
  const loading = !document && !error && !unavailable;

  return (
    <div className="pdf-shell">
      {notesEnabled && onSaveNote && drafts && annotationToolbar ? createPortal(<AnnotationsPanel drafts={drafts} highlights={highlights} notes={notes ?? []} onSaveNote={async note => { if (note.page === null || note.anchorY === null) throw new Error("PDF note coordinates are missing"); await onSaveNote({...note,page:note.page,anchorY:note.anchorY}); }} onRemoveHighlight={onRemoveHighlight} selected={overlapping} onReveal={revealHighlight} onEditNote={async (highlight,note)=>{
        // Open the note where its mark is, so the card sits beside the passage.
        if(note){revealHighlight(highlight);await openExistingNote(note);return;}
        await closeNote(true);
        if(openNoteRef.current || highlight.type!=="pdf" || !highlight.page)return;
        revealHighlight(highlight);
        setOpenNote({highlightId:highlight.id,page:highlight.page,anchorY:highlight.rects?.[0]?.y??0,quotedText:highlight.text??"",body:"",strokeIsOurs:false});
      }} />, annotationToolbar) : null}
      {annotationError ? <WindowToast notice={annotationError} onDismiss={() => setAnnotationError("")} /> : null}
      <ReaderFind resetKey={paperId} search={async (query, index) => {
        const serial = ++findSerial.current;
        if (!query.trim()) {
          setFindMatch(null);
          findDocumentText("", 0);
          return { total: 0, index: 0 };
        }
        if (!document) throw new Error("PDF not ready");
        if (findPages.current?.document !== document) {
          const currentDocument = document;
          findPages.current = { document, pages: (async () => {
            const pages: string[] = [];
            for (let page = 1; page <= currentDocument.numPages; page++) {
              const content = await (await currentDocument.getPage(page)).getTextContent();
              pages.push(content.items.map(item => "str" in item ? String(item.str) : "").join(" "));
            }
            return pages;
          })() };
        }
        const matches = pdfFindMatches(await findPages.current.pages, query);
        if (serial !== findSerial.current) return { total: 0, index: 0 };
        if (!matches.length) { setFindMatch(null); findDocumentText("", 0); return { total: 0, index: 0 }; }
        const active = ((index % matches.length) + matches.length) % matches.length;
        setFindMatch({ ...matches[active], query });
        goToPage(matches[active].page);
        return { total: matches.length, index: active };
      }} />
      {loading ? (
        <div className="document-loading" role="status" aria-live="polite">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/animations/delphi-loading-climb.gif" alt="" />
          <LoadingCaption text={fileUrl ? "Loading webpage…" : "Loading PDF…"} />
        </div>
      ) : null}
      <div
        // Once our own line bands exist, the browser's per-span selection
        // painting is a second, ragged copy of the same thing. See globals.css.
        className={`pdf-scroll${selection ? " has-bands" : ""}`}
        ref={viewerRef}
        onPointerDown={(event) => {
          onEngage();
          beginDragSelection(event);
        }}
        onPointerMove={trackDragSelection}
        onPointerUp={finishDragSelection}
        onMouseDown={beginDragSelection}
        onMouseMove={trackDragSelection}
        onMouseUp={finishDragSelection}
      >
        {/* Pinch magnification lives on this wrapper, never on the pages
            themselves: a transform is composited, so panning stays smooth,
            whereas re-rendering pdf.js per wheel tick is what made it judder.
            A transformed child still extends its ancestor's scrollable area,
            so panning is just scrolling. */}
        <div
          ref={pagesRef}
          className="pdf-pages"
        >
          <div className="pdf-resize-preview" ref={resizePreviewRef} style={{ width }}>
          {unavailable ? (
            <div className="panel-error panel-unavailable">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="panel-unavailable-icon"
                src="/brand/animations/delphi-warning-alert.gif"
                alt=""
              />
              <p>This document is no longer available.</p>
              <p className="panel-unavailable-detail">
                It may have been removed or moved to another project.
              </p>
            </div>
          ) : error ? (
            <div className="panel-error">The PDF could not be rendered. {error}</div>
          ) : null}
          {document && pdfjs
            ? Array.from({ length: document.numPages }, (_, index) => (
                <PdfPage
                  key={`${paperId}-${index + 1}`}
                  pdf={document}
                  pdfjs={pdfjs}
                  pageNumber={index + 1}
                  targetWidth={width * zoom}
                  ratio={pageRatio}
                  highlights={highlights.filter(
                    (item) => item.type === "pdf" && item.page === index + 1,
                  )}
                  selectionRects={
                    selection?.page === index + 1 ? selection.rects : []
                  }
                  notes={(notes ?? []).filter((note) => note.page === index + 1)}
                  openNote={openNote?.page === index + 1 ? openNote : null}
                  previewNote={
                    previewNote?.page === index + 1 ? previewNote : null
                  }
                  onPreviewNote={previewExistingNote}
                  onDeleteNote={(note) => void deleteNote(note)}
                  onOpenNote={openExistingNote}
                  // Written straight to the ref and never to state: the card is
                  // uncontrolled once mounted, so a render per keystroke would
                  // buy nothing and cost the editor's own scheduling.
                  onNoteChange={(body) => {
                    if (openNoteRef.current) openNoteRef.current.body = body;
                  }}
                  onNoteSave={(body) => {
                    if (openNoteRef.current) openNoteRef.current.body = body;
                    void closeNote(true);
                  }}
                  onNoteCancel={() => void closeNote(false)}
                  guide={guide?.page === index + 1 ? guide : null}
                  priority={focus?.page === index + 1 || findMatch?.page === index + 1}
                  onHighlightClick={handleHighlightClick}
                  onHighlightEdit={handleHighlightEdit}
                  onLinkActivate={handleLinkActivate}
                />
              ))
            : null}
          </div>
        </div>
      </div>
      {document ? (
        <div className="pdf-pager">
          <button
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
          >
            Prev
          </button>
          <span>
            {currentPage} / {document.numPages}
          </span>
          <button
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= document.numPages}
          >
            Next
          </button>
        </div>
      ) : null}
      {selection ? <ReaderSelectionMenu key={`${selection.x}-${selection.y}`} x={selection.x} y={selection.y}
        onHighlight={() => void saveSelection()} onNote={notesEnabled ? () => void startNote() : undefined}
        onReply={replyToSelection} /> : null}
      {activeHighlight ? (
        <div
          key={activeHighlight.id}
          className="selection-menu single"
          style={{ left: activeHighlight.x, top: activeHighlight.y }}
        >
          <button onClick={() => void removeActiveHighlight()}>
            <span>Remove highlight</span>
            <RemoveHighlightIcon />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PdfPage({
  pdf,
  pdfjs,
  pageNumber,
  targetWidth,
  ratio,
  highlights,
  selectionRects,
  notes,
  openNote,
  previewNote,
  onPreviewNote,
  onDeleteNote,
  onOpenNote,
  onNoteChange,
  onNoteSave,
  onNoteCancel,
  guide,
  priority = false,
  onHighlightClick,
  onHighlightEdit,
  onLinkActivate,
}: {
  pdf: PdfDocument;
  pdfjs: PdfModule;
  pageNumber: number;
  targetWidth: number;
  ratio: number;
  highlights: Highlight[];
  selectionRects: PdfRect[];
  notes: Note[];
  openNote: OpenNote | null;
  /** The read-only card, when one of this page's notes is being looked at. */
  previewNote: Note | null;
  onPreviewNote: (note: Note) => void;
  /** Delete from the preview — the note and the stroke it hangs off. */
  onDeleteNote: (note: Note) => void;
  onOpenNote: (note: Note) => void;
  onNoteChange: (body: string) => void;
  onNoteSave: (body: string) => void;
  onNoteCancel: () => void;
  guide?: GuideState | null;
  /** A citation is pointing here, so draw it without waiting for scroll. */
  priority?: boolean;
  onHighlightClick: (highlight: Highlight, x: number, y: number, candidates?: Highlight[]) => void;
  /** Double click on a stroke that carries a note: edit what it says. */
  onHighlightEdit: (highlight: Highlight) => void;
  onLinkActivate: (link: { url?: string; dest?: string | unknown[] }) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const noteCardRef = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<PdfLink[]>([]);
  const [textBoxes, setTextBoxes] = useState<PdfRect[]>([]);
  const [pageError, setPageError] = useState("");
  const [isNear, setIsNear] = useState(false);
  // This page's own aspect once known; until then the document's page-1 aspect
  // keeps the placeholder the right shape, so the scrollbar and citation jumps
  // land correctly before anything has been drawn.
  const [ownRatio, setOwnRatio] = useState<number | null>(null);
  const dimensions = {
    width: targetWidth,
    height: targetWidth * (ownRatio ?? ratio),
  };
  const visibleNote = openNote ?? previewNote;
  const noteBottom = visibleNote
    ? Math.max(visibleNote.anchorY ?? 0, ...(highlights.find(item => item.id === visibleNote.highlightId)?.rects ?? []).map(rect => rect.y + rect.h))
    : 0;

  useLayoutEffect(() => {
    const card = noteCardRef.current;
    if (!card) return;
    // A taller editor must still fit when its highlight is near the page's
    // foot. Measure again as the lazy editor loads and the draft grows.
    const fit = () => {
      card.style.top = `${Math.max(8, Math.min(noteBottom * dimensions.height + 8, dimensions.height - card.offsetHeight - 8))}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(card);
    return () => observer.disconnect();
  }, [visibleNote?.highlightId, Boolean(openNote), noteBottom, dimensions.height]);

  // Rasterising every page of a long paper on each width change costs hundreds
  // of milliseconds — the canvas and, worse, a text layer of many hundreds of
  // spans. Only pages in or near the viewport do that work.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsNear(entry.isIntersecting),
      { root: frame.closest(".pdf-scroll"), rootMargin: "1200px 0px" },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isNear && !priority) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | undefined;
    let textTask:
      | { cancel?: () => void; render: () => Promise<void> }
      | undefined;
    pdf
      .getPage(pageNumber)
      .then(async (page) => {
        if (cancelled) return;
        const natural = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: targetWidth / natural.width });
        setPageError("");
        if (natural.width > 0) setOwnRatio(natural.height / natural.width);
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d", { alpha: false });
        if (!canvas || !context) return;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        // Resizing an { alpha: false } canvas clears it to opaque black, which
        // shows through while the page is still being drawn or if the render is
        // cancelled by a scroll or resize. Lay down paper white first.
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        await renderTask.promise;
        const textContainer = textRef.current;
        if (!textContainer || cancelled) return;
        textContainer.replaceChildren();
        textContainer.style.setProperty(
          "--total-scale-factor",
          String(viewport.scale),
        );
        const textContent = await page.getTextContent();
        const TextLayerClass = (pdfjs as unknown as {
          TextLayer: new (options: object) => {
            render: () => Promise<void>;
            cancel?: () => void;
          };
        }).TextLayer;
        if (!TextLayerClass) throw new Error("PDF.js text layer is unavailable");
        textTask = new TextLayerClass({
          textContentSource: textContent,
          container: textContainer,
          viewport,
        });
        await textTask.render();
        if (cancelled) return;
        // The glyph boxes, normalised, so a stored band that is fractionally
        // too tall can be trimmed to the line it actually covers rather than
        // bleeding into the one below. Captured here because this is the one
        // moment the text layer is known to be complete.
        setTextBoxes(
          Array.from(textContainer.querySelectorAll<HTMLElement>("span"))
            .filter((span) => span.textContent?.trim())
            .map((span) => {
              const box = span.getBoundingClientRect();
              const page = textContainer.getBoundingClientRect();
              return {
                x: (box.left - page.left) / page.width,
                y: (box.top - page.top) / page.height,
                w: box.width / page.width,
                h: box.height / page.height,
              };
            })
            .filter((rect) => rect.w > 0 && rect.h > 0),
        );
        // A source PDF's own hyperlinks — an inline citation, a footnote
        // back-reference, a URL — are otherwise silently dropped: pdf.js only
        // paints them if something builds an annotation layer, and until now
        // nothing here did. Failure is swallowed rather than surfaced: a
        // reader who cannot click a citation still has the whole document.
        const annotations = await page
          .getAnnotations({ intent: "display" })
          .catch(() => [] as Array<Record<string, unknown>>);
        if (cancelled) return;
        const nextLinks: PdfLink[] = [];
        for (const annotation of annotations) {
          if (annotation.subtype !== "Link") continue;
          const url = (annotation.url as string | undefined) ?? undefined;
          const dest = (annotation.dest as string | unknown[] | undefined) ?? undefined;
          if (!url && !dest) continue;
          const raw = annotation.rect as number[] | undefined;
          if (!raw || raw.length !== 4 || viewport.width <= 0 || viewport.height <= 0) {
            continue;
          }
          const [px1, py1, px2, py2] = viewport.convertToViewportRectangle(raw);
          const left = Math.min(px1, px2);
          const top = Math.min(py1, py2);
          const width = Math.abs(px2 - px1);
          const height = Math.abs(py2 - py1);
          nextLinks.push({
            key: String(annotation.id ?? `${left}-${top}-${width}-${height}`),
            rect: {
              x: left / viewport.width,
              y: top / viewport.height,
              w: width / viewport.width,
              h: height / viewport.height,
            },
            url,
            dest,
          });
        }
        setLinks(nextLinks);
      })
      .catch((reason) => {
        if (cancelled || reason?.name === "RenderingCancelledException") return;
        setPageError(
          reason instanceof Error ? reason.message : "This page could not be rendered.",
        );
      });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textTask?.cancel?.();
    };
  }, [isNear, priority, pageNumber, pdf, pdfjs, targetWidth]);

  return (
    <div
      ref={frameRef}
      className="pdf-page"
      data-page={pageNumber}
      style={{ width: dimensions.width, height: dimensions.height }}
    >
      <canvas ref={canvasRef} />
      <div ref={textRef} className="textLayer text-layer" />
      {pageError ? (
        <div className="page-warning">Selection unavailable: {pageError}</div>
      ) : null}
      {links.length ? (
        <div className="pdf-link-layer">
          {links.map((link) => (
            <a
              key={link.key}
              className="pdf-link"
              href={link.url ?? "#"}
              target={link.url ? "_blank" : undefined}
              rel={link.url ? "noopener noreferrer" : undefined}
              aria-label={link.url ? "Open link" : "Jump to reference"}
              style={{
                left: `${link.rect.x * 100}%`,
                top: `${link.rect.y * 100}%`,
                width: `${link.rect.w * 100}%`,
                height: `${link.rect.h * 100}%`,
              }}
              // Stopped here for the same reason as .pdf-highlight: without
              // it, a click on a link would also be read by .pdf-scroll as
              // the start of a text-selection drag.
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                if (link.url) return;
                event.preventDefault();
                onLinkActivate(link);
              }}
            />
          ))}
        </div>
      ) : null}
      {/* Not `aria-hidden`: the highlight spans below are real interactive
          controls, and hiding an ancestor of a focusable element is an ARIA
          violation, not just a style choice. The guide and selection preview
          stay purely decorative. */}
      <div className="highlight-layer">
        {guide ? (
          // Keyed on nonce so a repeat jump replays the animation.
          <span
            key={guide.nonce}
            aria-hidden="true"
            className={`pdf-guide ${guide.rect ? "" : "pdf-guide-page"}`}
            style={
              guide.rect
                ? {
                    left: `${guide.rect.x * 100}%`,
                    top: `${guide.rect.y * 100}%`,
                    width: `${guide.rect.w * 100}%`,
                    height: `${guide.rect.h * 100}%`,
                  }
                : undefined
            }
          />
        ) : null}
        {selectionRects.map((rect, index) => (
          <span
            key={`selection-${index}`}
            aria-hidden="true"
            className="pdf-selection-preview"
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
            }}
          />
        ))}
        {unionOfHighlights(
          highlights,
          dimensions.width / dimensions.height,
          textBoxes,
        ).map(({ highlight, band: rect }, index) => (
          <span
              key={`${highlight.id}-${index}`}
              className="pdf-highlight"
              role="button"
              tabIndex={0}
              title="Click to remove highlight"
              aria-label="Remove highlight"
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.w * 100}%`,
                height: `${rect.h * 100}%`,
              }}
              // Stopped here rather than left to bubble: the drag-selection
              // handlers on `.pdf-scroll` would otherwise treat this pointer
              // down as the start of a new selection over the text beneath.
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                const box = event.currentTarget.getBoundingClientRect();
                const pageBox = frameRef.current?.getBoundingClientRect();
                const candidates = pageBox ? highlights.filter(item => (item.rects ?? []).some(r => {
                  const x = (event.clientX-pageBox.left)/pageBox.width, y = (event.clientY-pageBox.top)/pageBox.height;
                  return x >= r.x && x <= r.x+r.w && y >= r.y && y <= r.y+r.h;
                })) : [highlight];
                onHighlightClick(candidates[0] ?? highlight, box.left + box.width / 2, box.top, candidates);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                if (highlights.filter(item => bandsIntersect(item.rects ?? [], [rect])).length === 1) onHighlightEdit(highlight);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                onHighlightClick(highlight, box.left + box.width / 2, box.top);
              }}
          />
        ))}
      </div>
      {notes.length || openNote ? (
        <div className="pdf-note-gutter">
          {stackNotes(notes, highlights, dimensions.width / dimensions.height, textBoxes).map(({ note, top }) =>
            openNote?.highlightId === note.highlightId ? null : (
              <NoteMarker
                key={note.id}
                body={note.body}
                expanded={previewNote?.id === note.id}
                style={{ top: `${top * 100}%` }}
                onOpen={() => onPreviewNote(note)}
                onEdit={() => onOpenNote(note)}
              />
            ),
          )}
          {previewNote && !openNote ? (
            <div
              ref={noteCardRef}
              className="pdf-note-open pdf-note-read"
            >
              <NotePreview
                body={previewNote.body}
                onEdit={() => onOpenNote(previewNote)}
                onDelete={() => onDeleteNote(previewNote)}
              />
            </div>
          ) : null}
          {openNote ? (
            <div
              ref={noteCardRef}
              className="pdf-note-open"
            >
              <Suspense
                fallback={
                  <div className="note-card note-card-loading" role="status">
                    <span className="note-loading">Opening…</span>
                  </div>
                }
              >
                <NoteEditor
                  // Remounted per anchor so the editor starts from the right
                  // body. It owns its document after that; re-seeding it
                  // mid-edit would fight the reader's caret.
                  key={openNote.noteId ?? openNote.highlightId}
                  value={openNote.body}
                  onChange={onNoteChange}
                  onSave={onNoteSave}
                  onCancel={onNoteCancel}
                  onDelete={openNote.noteId ? () => onNoteSave("") : undefined}
                />
              </Suspense>
            </div>
          ) : null}
        </div>
      ) : null}
      <span className="page-number">{pageNumber}</span>
    </div>
  );
}
