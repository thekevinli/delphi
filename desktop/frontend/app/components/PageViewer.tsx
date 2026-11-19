"use client";

import {
  forwardRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import { useWebAnnotations, type WebSelection } from "../lib/use-web-annotations";
import { WindowToast } from "./Notice";
import { AnnotationsPanel, type AnnotationActions } from "./AnnotationsPanel";
import { PageNoteLayer, type PageNoteCard } from "./PageNotes";
import remarkGfm from "remark-gfm";
import {
  api,
  API_BASE,
  type ViewportSection,
  type ChatViewport,
} from "../lib/api";
import { selectionMenuPoint } from "../lib/frame-selection";
import { pageTitle } from "../lib/page-title";
import { pageFrameLayout, stepPageZoom } from "../lib/page-zoom";
import { chatOwnsZoom, zoomDirection } from "../lib/use-text-zoom";
import { annotationBox, annotationSelection } from "../lib/web-annotation-state";
import { findDocumentText, type FindResult } from "../lib/document-find";
import { LoadingCaption } from "./Loading";
import { ReaderFind } from "./ReaderFind";
import { ReaderMenu, ReaderMenuItem, ReaderMenuRule, ReaderMenuView, ReaderMenuZoom } from "./ReaderMenu";
// One definition of the action's glyph, so the two viewers' menus cannot drift.
// No bundle cost: Workspace already imports both eagerly.
import { ReaderSelectionMenu } from "./ReaderSelectionMenu";

export type PageFocus = {
  anchor: string | null;
  quote: string | null;
  /** The quote's opening words, pointed at first in case the whole is gone. */
  lead?: string | null;
  nonce: number;
};

export type EvidenceViewport = {
  source: "evidence";
  evidenceId?: string;
  kind: "html" | "image";
  url: string;
  title: string;
  favicon?: string;
  sourceHash: string;
  document?: { sections: ViewportSection[] };
  imageData?: string;
  mimeType?: "image/webp";
};

export type PageViewerHandle = {
  getViewport: (quote?: string) => Promise<ChatViewport | null>;
  openEvidence: (evidence: EvidenceViewport, focus?: PageFocus | null) => void;
};

type HistoryEntry = {
  id: number;
  source: "home" | "anonymous" | "evidence";
  requestedUrl: string;
  resolvedUrl: string;
  title: string;
  favicon?: string;
  kind: "html" | "image" | "pdf" | "unknown";
  scrollY: number;
  evidenceId?: string;
  capture?: EvidenceViewport;
};

type Frame = {
  method: "GET" | "POST";
  url: string;
  sandbox: string;
  allow: string;
  token?: string;
  destination?: string;
  serial: number;
  renderWidth?: number;
  view?: "live" | "cached";
  /**
   * The cached copy, shown because the live page was not: it failed to load,
   * or its site draws it with scripts that run only on its own address.
   */
  fallback?: Fallback;
};

type Fallback = "" | "failed" | "own-address";

type BridgeMessage = {
  source?: string;
  type?: string;
  nonce?: string;
  text?: string;
  href?: string;
  title?: string;
  favicon?: string;
  url?: string;
  chars?: number;
  blank?: boolean;
  renderWidth?: number | null;
  unavailable?: string | null;
  unavailableReason?: string | null;
  kind?: "html" | "image" | "pdf";
  scrollY?: number;
  over?: boolean;
  file?: unknown;
  annotation?: WebSelection;
  rect?: { x: number; y: number; w: number; h: number };
};

/** `x`/`y` are the toolbar's place in the window; `rect` is the passage's own
 *  box in the frame, which is what a note card anchors to. */
type FrameSelection = { text: string; x: number; y: number; rect: { x: number; y: number; w: number; h: number }; annotation?: WebSelection; requestId: string };

/** "Nov 3", or "Nov 3, 2025" for a copy from another year. */
function savedOn(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", {
    month: "short", day: "numeric",
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

const HISTORY_LIMIT = 25;
const CAPTURE_MEMORY_LIMIT = 3 * 1024 * 1024;
const RENDERED_CHARS = 200;
const ESCAPE_GRACE_MS = 500;
const MAX_RECOVERIES = 3;

function absoluteApi(url: string) {
  return url.startsWith("http") ? url : `${API_BASE}${url}`;
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function captureBytes(capture?: EvidenceViewport) {
  if (!capture) return 0;
  if (capture.kind === "image") return Math.ceil((capture.imageData ?? "").length * 0.75);
  const sections = capture.document?.sections ?? [];
  return new TextEncoder().encode(
    `${capture.url}\n${capture.title}\n${sections.map((section) => section.markdown).join("\n")}`,
  ).byteLength;
}

/** Captures share a three-megabyte memory budget; URLs survive eviction. */
function capHistory(entries: HistoryEntry[], activeIndex: number) {
  const dropped = Math.max(0, entries.length - HISTORY_LIMIT);
  const kept = entries.slice(-HISTORY_LIMIT);
  const active = Math.max(0, Math.min(activeIndex - dropped, kept.length - 1));
  const retentionOrder = [
    active,
    ...kept.map((_, index) => index).reverse().filter((index) => index !== active),
  ];
  let budget = CAPTURE_MEMORY_LIMIT;
  for (const index of retentionOrder) {
    const size = captureBytes(kept[index].capture);
    if (size <= budget) budget -= size;
    else kept[index] = { ...kept[index], capture: undefined };
  }
  return kept;
}

function CleanReadingView({
  entry,
  onNavigate,
  onScroll,
}: {
  entry: HistoryEntry;
  onNavigate: (href: string) => void;
  onScroll: (scrollY: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const capture = entry.capture;
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = entry.scrollY;
  }, [entry.id, entry.scrollY]);

  if (!capture) {
    return (
      <div
        ref={scrollRef}
        className="captured-reading-scroll"
        onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
      >
        <div className="page-capture-empty">
          <h2>This citation&rsquo;s evidence is no longer in memory</h2>
          <p>Reload the page to read it at its source.</p>
        </div>
      </div>
    );
  }
  if (capture.kind === "image") {
    const data = capture.imageData;
    return data ? (
      <div
        ref={scrollRef}
        className="captured-reading-scroll"
        onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
      >
        <div className="page-capture-image">
          <img src={`data:image/webp;base64,${data}`} alt={entry.title} />
        </div>
      </div>
    ) : null;
  }
  const sections = capture.document?.sections ?? [];
  return (
    <div
      ref={scrollRef}
      className="captured-reading-scroll"
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
    >
      <article className="captured-reading-view">
        <h1>{entry.title}</h1>
        {sections.map((section) => (
          <section key={section.anchor} id={section.anchor}>
            <h2>{section.title}</h2>
            <div className="captured-markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
                        if (
                          !href ||
                          event.button !== 0 ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey
                        ) return;
                        event.preventDefault();
                        onNavigate(href);
                      }}
                    >
                      {children}
                    </a>
                  ),
                }}
              >
                {section.markdown}
              </ReactMarkdown>
            </div>
          </section>
        ))}
      </article>
    </div>
  );
}

type PageViewerProps = AnnotationActions & {
  projectId: string;
  paperId: string;
  url: string;
  title: string;
  favicon?: string;
  focus?: PageFocus | null;
  browsingEnabled: boolean;
  /** `webSavedPageMaxBytes` from the backend's config. */
  savedPageMaxBytes?: number;
  /**
   * How much of the page its saved copy holds: its first window while the
   * rest is being read (`partial`, a long Notion page just added), or all of
   * it. A partial copy waits behind a reading state unless the reader asks to
   * read what is there; the change to `whole` loads the whole copy in its
   * place, at the reader's place.
   */
  copy?: "partial" | "whole";
  onReply: (text: string) => void;
  onEngage: () => void;
  /** Under the digest: the zoom keys are not for this page. */
  covered?: boolean;
  onExternalAction: (href: string) => void;
  onImportPdf: (href: string) => void;
  onSavePage: (viewport: ChatViewport) => void;
  onHomeChange: (offHome: boolean) => void;
  onDrag: (over: boolean) => void;
  onFileDrop: (file: File) => void;
};

export const PageViewer = forwardRef<PageViewerHandle, PageViewerProps>(
  function PageViewer(
    {
      drafts, highlights, notes, onHighlight, onRemoveHighlight, onSaveNote,
      projectId,
      paperId,
      url,
      title,
      favicon,
      focus,
      browsingEnabled,
      savedPageMaxBytes,
      copy = "whole",
      onReply,
      onEngage,
      covered,
      onExternalAction,
      onImportPdf,
      onSavePage,
      onHomeChange,
      onDrag,
      onFileDrop,
    },
    ref,
  ) {
    const frameRef = useRef<HTMLIFrameElement>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
    const [wrapSize, setWrapSize] = useState({ width: 0, height: 0 });
    const [pageZoom, setPageZoom] = useState(100);
    const pageZoomRef = useRef(pageZoom);
    useEffect(() => { pageZoomRef.current = pageZoom; }, [pageZoom]);
    const initialEntry = useMemo<HistoryEntry>(
      () => ({
        id: 0,
        source: "home",
        requestedUrl: url,
        resolvedUrl: url,
        title,
        favicon,
        kind: "html",
        scrollY: 0,
      }),
      [favicon, title, url],
    );
    const historyRef = useRef<HistoryEntry[]>([initialEntry]);
    const indexRef = useRef(0);
    const nonceRef = useRef<string | null>(null);
    const pendingHelloRef = useRef<string[]>([]);
    const recoveriesRef = useRef(0);
    const postBootLoadsRef = useRef(0);
    const serialRef = useRef(0);
    const navigationSerial = useRef(0);
    const invalidateFrame = useRef<() => void>(() => {});
    const pinnedReply = useRef<{ quote: string; url: string; title: string } | null>(null);
    const alive = useRef(true);
    useEffect(() => {
      alive.current = true;
      return () => { alive.current = false; navigationSerial.current++; };
    }, []);
    const savedViewRef = useRef(false);
    const fallbackViewRef = useRef<Fallback>("");
    const nextEntryIdRef = useRef(1);
    const [history, setHistory] = useState<HistoryEntry[]>([initialEntry]);
    // A rename while the document is open reaches its header at once.
    useEffect(() => {
      if (historyRef.current.every((entry) => entry.source !== "home" || entry.title === title)) return;
      const entries = historyRef.current.map((entry) => entry.source === "home" ? { ...entry, title } : entry);
      historyRef.current = entries;
      setHistory(entries);
    }, [title]);
    const [index, setIndex] = useState(0);
    const [frame, setFrame] = useState<Frame | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [blank, setBlank] = useState(false);
    const [selection, setSelection] = useState<FrameSelection | null>(null);
    // The selection the frame reported last, set as its report arrives. A
    // reader who releases a drag and clicks the menu at once clicks a menu
    // drawn for the selection before the release: the click must act on the
    // passage released on, which may not have been rendered yet.
    const latestSelection = useRef<FrameSelection | null>(null);
    useEffect(() => { latestSelection.current = selection; }, [selection]);
    const [brokenFavicon, setBrokenFavicon] = useState<string | null>(null);
    const replaceNextCaptureRef = useRef<"entry" | "home" | null>(null);
    const layoutWidthRef = useRef<number | undefined>(undefined);
    const current = history[index] ?? history[0];
    const frameName = useMemo(() => `delphi-frame-${paperId}`, [paperId]);

    const replaceHistory = useCallback(
      (entries: HistoryEntry[], nextIndex: number) => {
        const capped = capHistory(entries, nextIndex);
        const dropped = Math.max(0, entries.length - capped.length);
        const shifted = Math.max(0, nextIndex - dropped);
        historyRef.current = capped;
        indexRef.current = Math.min(shifted, capped.length - 1);
        setHistory(capped);
        setIndex(indexRef.current);
        onHomeChange(capped[indexRef.current]?.source !== "home");
      },
      [onHomeChange],
    );

    const updateCurrent = useCallback((fields: Partial<HistoryEntry>) => {
      const entries = historyRef.current.slice();
      entries[indexRef.current] = { ...entries[indexRef.current], ...fields };
      historyRef.current = entries;
      setHistory(entries);
    }, []);

    const beginFrame = useCallback((next: Omit<Frame, "serial">) => {
      invalidateFrame.current();
      nonceRef.current = null;
      pendingHelloRef.current = [];
      setLoading(true);
      setBlank(false);
      setError("");
      setSelection(null);
      const descriptor = { ...next, serial: ++serialRef.current };
      postBootLoadsRef.current = descriptor.method === "POST" ? 1 : 0;
      setFrame(descriptor);
    }, []);

    const loadEntry = useCallback(
      async (entry: HistoryEntry, saved = false, fallback: Fallback = "") => {
        const ticket = ++navigationSerial.current;
        invalidateFrame.current();
        nonceRef.current = null;
        setSelection(null);
        if (entry.capture) {
          setFrame(null);
          setLoading(false);
          setError("");
          window.requestAnimationFrame(() => window.scrollTo(0, entry.scrollY));
          return;
        }
        if (entry.source === "evidence") {
          setFrame(null);
          if (!entry.evidenceId) {
            setLoading(false);
            setError("This citation evidence is unavailable.");
            return;
          }
          setLoading(true);
          const capture = await api<EvidenceViewport>(
            `/api/projects/${projectId}/papers/${paperId}/evidence/${entry.evidenceId}`,
          );
          if (ticket !== navigationSerial.current) return;
          const entries = historyRef.current.slice();
          entries[indexRef.current] = {
            ...entries[indexRef.current],
            capture: { ...capture, evidenceId: entry.evidenceId },
          };
          replaceHistory(entries, indexRef.current);
          setLoading(false);
          setError("");
          return;
        }
        if (entry.source === "home") {
          savedViewRef.current = saved;
          fallbackViewRef.current = fallback;
          const next = await api<{
            url: string;
            sandbox: string;
            allow: string;
            renderWidth?: number | null;
            view?: "live" | "cached";
          }>(
            `/api/projects/${projectId}/papers/${paperId}/page-url?view=${saved ? "cached" : "live"}`,
          );
          if (ticket !== navigationSerial.current) return;
          if (next.view !== (saved ? "cached" : "live")) {
            throw new Error("Update the Delphi backend to use live and cached document views.");
          }
          beginFrame({
            method: "GET",
            ...next,
            url: absoluteApi(next.url),
            renderWidth: next.renderWidth ?? undefined,
            fallback,
          });
          return;
        }
        const next = await api<{
          action: string;
          url: string;
          token: string;
          sandbox: string;
          allow: string;
        }>(`/api/projects/${projectId}/papers/${paperId}/navigation`, {
          method: "POST",
          body: JSON.stringify({ url: entry.requestedUrl }),
        });
        if (ticket !== navigationSerial.current) return;
        updateCurrent({ resolvedUrl: next.url });
        beginFrame({
          method: "POST",
          url: absoluteApi(next.action),
          sandbox: next.sandbox,
          allow: next.allow,
          token: next.token,
          destination: next.url,
        });
      },
      [beginFrame, paperId, projectId, replaceHistory, updateCurrent],
    );

    useEffect(() => {
      void loadEntry(historyRef.current[0]).catch((reason) => setError(String(reason)));
    }, [loadEntry]);

    useEffect(() => {
      if (!frame || frame.method !== "POST" || !frameRef.current) return;
      const form = document.createElement("form");
      form.method = "POST";
      form.action = frame.url;
      form.target = frameName;
      form.hidden = true;
      for (const [name, value] of Object.entries({
        url: frame.destination ?? "",
        token: frame.token ?? "",
      })) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
      form.remove();
    }, [frame, frameName]);

    useEffect(() => {
      const node = wrapRef.current;
      if (!node) return;
      const update = () =>
        setWrapSize({ width: node.clientWidth, height: node.clientHeight });
      update();
      const observer = new ResizeObserver(update);
      observer.observe(node);
      return () => observer.disconnect();
    }, [frame]);

    const layoutWidth = frame?.renderWidth;
    useEffect(() => { layoutWidthRef.current = layoutWidth; }, [layoutWidth]);
    const frameStyle: CSSProperties | undefined = wrapSize.width && wrapSize.height
      ? pageFrameLayout(wrapSize.width, wrapSize.height, layoutWidth, pageZoom)
      : undefined;

    const post = useCallback((message: Record<string, unknown>) => {
      if (!nonceRef.current) return;
      frameRef.current?.contentWindow?.postMessage(
        { ...message, source: "delphi-app" },
        "*",
      );
    }, []);
    const [noteCard, setNoteCard] = useState<PageNoteCard | null>(null);
    // The marks the frame reports positions for: every one with a margin icon,
    // and the one a card is open over, so both follow their lines through any
    // reflow — including the library folding away on the first click.
    const measure = useMemo(
      () => [...notes.map(note => note.highlightId), ...(noteCard ? [noteCard.highlightId] : [])],
      [notes, noteCard],
    );
    const annotations = useWebAnnotations(projectId, paperId, highlights, measure, post, savedPageMaxBytes);
    // Navigation invalidates the frame's index as it starts, before the next
    // page can report anything against the old one.
    useEffect(() => { invalidateFrame.current = annotations.invalidate; }, [annotations.invalidate]);
    const [pageClicks, setPageClicks] = useState(0);
    const lastSelectionRef = useRef("");
    const [annotationError, setAnnotationError] = useState("");
    const annotationSaving = useRef(false);
    const saveNote = async (note: Parameters<typeof onSaveNote>[0]) => {
      await onSaveNote(note);
      annotations.keepAnnotatedPage(savedViewRef.current);
    };
    const [savingAnnotation, setSavingAnnotation] = useState(false);
    /**
     * Captures the reader's passage. A click that follows a release at once
     * can reach this window before the frame's report of the released
     * selection does, and the frame then refuses the selection the menu was
     * drawn for. The report is already on its way: wait for it briefly and
     * capture what the reader released on.
     */
    async function captureLatest(from: FrameSelection, annotation: WebSelection, options: { pin?: boolean; page?: boolean }) {
      try {
        return { selection: from, captured: await annotations.capture(annotation, options) };
      } catch (reason) {
        const started = performance.now();
        while (latestSelection.current === from && performance.now() - started < 500) await new Promise(resolve => window.setTimeout(resolve, 20));
        const newer = latestSelection.current;
        if (newer === from || !newer?.annotation) throw reason;
        return { selection: newer, captured: await annotations.capture(newer.annotation, options) };
      }
    }
    async function saveAnnotation(note: boolean) {
      const latest = latestSelection.current;
      if (!latest?.annotation || annotationSaving.current) return;
      annotationSaving.current = true;
      setSavingAnnotation(true);
      // A save that outlives its page — the reader navigated, or the viewer
      // closed — must not open a card over whatever is there now.
      const ticket = serialRef.current;
      setAnnotationError("");
      try {
        // The page is taken with the selection, and kept only if the
        // highlight is saved — even if the reader has moved on by then.
        const viewingSavedCopy = savedViewRef.current;
        const { selection, captured: { page, ...captured } } = await captureLatest(latest, latest.annotation, { page: !viewingSavedCopy });
        if (!alive.current || ticket !== serialRef.current) return;
        const existing = highlights.find(h => h.type === "html" && h.anchor?.revision === captured.anchor.revision && h.anchor.start === captured.anchor.start && h.anchor.end === captured.anchor.end && h.text === captured.text);
        const saved = existing ?? await onHighlight({type:"html",...captured,requestId:selection.requestId});
        if (saved && !existing) annotations.keepAnnotatedPage(viewingSavedCopy, page);
        if (!alive.current || ticket !== serialRef.current) return;
        if (!saved) throw new Error("Highlight was not saved. Please retry.");
        // The card opens over the passage the reader just marked, where the
        // selection was — the frame has not repainted the mark yet, so its own
        // geometry is a message away and the toolbar's position is what we have.
        if (note) setNoteCard({ highlightId: saved.id, x: selection.rect.x + selection.rect.w / 2, top: selection.rect.y, mode: "editor", ours: !existing });
        post({type:"clear-selection"});setSelection(null);
      } catch (reason) { setAnnotationError(reason instanceof Error ? reason.message : String(reason)); }
      finally { annotationSaving.current = false; setSavingAnnotation(false); }
    }
    /**
     * A mark was clicked in the frame. One that carries a note opens it; one
     * that does not offers the two things there are to do with a highlight.
     * Where several marks overlap the click is ambiguous, so it opens the panel
     * instead and the reader picks — the same answer the PDF reader gives.
     */
    const clicked = annotations.clicked;
    // What the panel has to answer for: several marks at one point, or a mark
    // whose box the frame did not report — an older backend says only which
    // marks were clicked, and a card with nowhere to be is worse than a list.
    const panelAnswers = useMemo(
      () => (clicked && (clicked.ids.length > 1 || !clicked.rect) ? clicked.ids : []),
      [clicked],
    );
    // Answered during render, once per click: an unsaved draft reopens in its
    // editor rather than as a preview of the note it has not become yet.
    const [handledClick, setHandledClick] = useState<typeof clicked>(null);
    if (clicked !== handledClick) {
      setHandledClick(clicked);
      if (clicked?.ids.length === 1 && clicked.rect) {
        const id = clicked.ids[0];
        setNoteCard({ highlightId: id, x: clicked.rect.x + clicked.rect.w / 2,
          top: clicked.rect.y, mode: drafts.has(id) ? "editor" : notes.some(note => note.highlightId === id) ? "preview" : "menu", ours: false });
      }
    }

    const pushAnonymous = useCallback(
      async (href: string) => {
        if (!browsingEnabled) {
          onExternalAction(href);
          return;
        }
        const ticket = ++navigationSerial.current;
        invalidateFrame.current();
        nonceRef.current = null;
        setSelection(null);
        const next = await api<{
          action: string;
          url: string;
          token: string;
          sandbox: string;
          allow: string;
        }>(`/api/projects/${projectId}/papers/${paperId}/navigation`, {
          method: "POST",
          body: JSON.stringify({ url: href }),
        });
        if (ticket !== navigationSerial.current) return;
        const entry: HistoryEntry = {
          id: nextEntryIdRef.current++,
          source: "anonymous",
          requestedUrl: href,
          resolvedUrl: next.url,
          title: hostOf(next.url),
          kind: "unknown",
          scrollY: 0,
        };
        const entries = historyRef.current.slice(0, indexRef.current + 1);
        entries.push(entry);
        replaceHistory(entries, entries.length - 1);
        beginFrame({
          method: "POST",
          url: absoluteApi(next.action),
          sandbox: next.sandbox,
          allow: next.allow,
          token: next.token,
          destination: next.url,
        });
      },
      [beginFrame, browsingEnabled, onExternalAction, paperId, projectId, replaceHistory],
    );

    const openCaptured = useCallback(
      (capture: EvidenceViewport) => {
        navigationSerial.current++;
        invalidateFrame.current();
        nonceRef.current = null;
        setSelection(null);
        const replaceMode = replaceNextCaptureRef.current;
        if (replaceMode) {
          replaceNextCaptureRef.current = null;
          const entries = historyRef.current.slice();
          entries[indexRef.current] = {
            ...entries[indexRef.current],
            source: replaceMode === "home" ? "home" : capture.source,
            requestedUrl: capture.url,
            resolvedUrl: capture.url,
            title: capture.title,
            kind: capture.kind,
            scrollY: 0,
            evidenceId: "evidenceId" in capture ? capture.evidenceId : undefined,
            capture,
          };
          replaceHistory(entries, indexRef.current);
          setFrame(null);
          setLoading(false);
          setError("");
          return;
        }
        const entry: HistoryEntry = {
          id: nextEntryIdRef.current++,
          source: capture.source,
          requestedUrl: capture.url,
          resolvedUrl: capture.url,
          title: capture.title,
          kind: capture.kind,
          scrollY: 0,
          evidenceId: "evidenceId" in capture ? capture.evidenceId : undefined,
          capture,
        };
        const entries = historyRef.current.slice(0, indexRef.current + 1);
        entries.push(entry);
        replaceHistory(entries, entries.length - 1);
        setFrame(null);
        setLoading(false);
        setError("");
      },
      [replaceHistory],
    );

    useImperativeHandle(
      ref,
      () => ({
        getViewport: async (quote = "") => {
          const entry = historyRef.current[indexRef.current];
          if (!entry || entry.source === "evidence") return null;
          // A Reply's quote was pinned where it was selected, so its evidence
          // is that passage on that page even after the reader moves on.
          const pinned = pinnedReply.current;
          if (quote && pinned?.quote === quote) return { source: "captured", kind: "html", url: pinned.url, title: pinned.title, ...await annotations.evidence(quote) };
          if (!quote) pinnedReply.current = null;
          // The page as read now, when the frame has been indexed. Without it —
          // still loading, or page matching unavailable — the question goes
          // without a viewport and the server reads the stored snapshot. Only a
          // pinned Reply quote is strict, above: that passage is evidence the
          // reader chose.
          if (entry.source === "home") {
            const page = await annotations.evidence("").catch(() => null);
            return page && { source: "captured", kind: "html", url: entry.resolvedUrl, title: entry.title, ...page };
          }
          return {
            source: "anonymous",
            kind: entry.kind,
            url: entry.resolvedUrl,
            title: entry.title,
          };
        },
        openEvidence: (evidence, nextFocus) => {
          openCaptured(evidence);
          if (nextFocus?.anchor) {
            window.setTimeout(() => {
              document.getElementById(nextFocus.anchor ?? "")?.scrollIntoView({ block: "start" });
            });
          }
        },
      }),
      [openCaptured, annotations.evidence],
    );

    const escaped = useCallback(() => {
      if (recoveriesRef.current >= MAX_RECOVERIES) {
        setError("This page keeps navigating away from the reader.");
        return;
      }
      recoveriesRef.current += 1;
      void loadEntry(historyRef.current[indexRef.current], savedViewRef.current).catch((reason) =>
        setError(String(reason)),
      );
    }, [loadEntry]);

    useEffect(() => {
      const onMessage = (event: MessageEvent<BridgeMessage>) => {
        if (event.source !== frameRef.current?.contentWindow) return;
        const data = event.data;
        // Anything the frame says is untrusted input from a page Delphi does not control.
        if (!data || typeof data !== "object" || data.source !== "delphi-page" || typeof data.nonce !== "string" || !data.nonce || data.nonce.length > 128) return;
        if (data.type === "hello") {
          if (!nonceRef.current) nonceRef.current = data.nonce;
          if (nonceRef.current === data.nonce) pendingHelloRef.current.push(data.nonce);
          return;
        }
        if (data.nonce !== nonceRef.current) return;
        if (historyRef.current[indexRef.current].source === "home") annotations.receive(data as Record<string, unknown>);

        if (data.type === "ready") {
          // The backend frames a view it could not serve rather than failing
          // the iframe. Only the view this frame asked for counts, so a page
          // setting the attribute itself can at most show the cached copy.
          const requested = savedViewRef.current ? "cached" : "live";
          if (data.unavailable === requested && historyRef.current[indexRef.current].source === "home") {
            if (requested === "live") {
              const fallback = data.unavailableReason === "own-address" ? "own-address" : "failed";
              void loadEntry(historyRef.current[0], true, fallback).catch((reason) => setError(String(reason)));
            } else {
              setLoading(false);
              setError(fallbackViewRef.current
                ? "The live page could not be loaded, and no cached copy is saved."
                : "No cached copy of this page is saved.");
            }
            return;
          }
          // A fresh render reports its own layout width, independently of the cache.
          const width = typeof data.renderWidth === "number" && Number.isFinite(data.renderWidth)
            && data.renderWidth >= 320 && data.renderWidth <= 10000 ? data.renderWidth : undefined;
          setFrame(prior => prior && prior.renderWidth !== width ? { ...prior, renderWidth: width } : prior);
          setLoading(false);
          recoveriesRef.current = 0;
          updateCurrent({
            // The document's own entry keeps the reader's name for it — a
            // rename overrides whatever the site calls itself. Pages reached
            // from it are named by their own titles.
            title: historyRef.current[indexRef.current].source === "home"
              ? historyRef.current[indexRef.current].title
              : pageTitle(data.title || historyRef.current[indexRef.current].title),
            favicon: data.favicon || historyRef.current[indexRef.current].favicon,
            resolvedUrl: data.url || historyRef.current[indexRef.current].resolvedUrl,
            kind: data.kind || historyRef.current[indexRef.current].kind,
          });
          post({ type: "restore-scroll", y: historyRef.current[indexRef.current].scrollY });
          return;
        }
        if (data.type === "settled") {
          // The frame's own verdict: it can see what is drawn as well as what
          // is written. A count of characters is all an older one reports.
          setBlank(typeof data.blank === "boolean" ? data.blank : (data.chars ?? 0) < RENDERED_CHARS);
          return;
        }
        if (data.type === "scroll") {
          updateCurrent({ scrollY: Math.max(0, data.scrollY ?? 0) });
          return;
        }
        if (data.type === "navigate" && data.href) {
          void pushAnonymous(data.href).catch((reason) => setError(String(reason)));
          return;
        }
        if (data.type === "same-document" && data.href) {
          try {
            if (new URL(data.href).pathname + new URL(data.href).search !== new URL(historyRef.current[indexRef.current].resolvedUrl).pathname + new URL(historyRef.current[indexRef.current].resolvedUrl).search) annotations.invalidate();
          } catch { return; }
          updateCurrent({ resolvedUrl: data.href });
          return;
        }
        if (data.type === "import-pdf" && data.href) {
          onImportPdf(data.href);
          return;
        }
        if (
          (data.type === "external-link" || data.type === "external-action") &&
          data.href
        ) {
          onExternalAction(data.href);
          return;
        }
        // A click in the page is a click away from any open note card. The
        // window never hears it — pointer events inside a cross-origin frame
        // stay inside it — so the frame's own report of a plain click stands
        // in, and so does the start of a new selection.
        if (data.type === "engaged") {
          onEngage();
          setPageClicks(count => count + 1);
        }
        // A click on a highlight is not a reading click — the frame does not
        // report it as one, so the library stays put — but it is still a click
        // away from whatever card is open. The open card closes, saving what was
        // written, before the one for this mark opens.
        if (data.type === "annotation-click") setPageClicks(count => count + 1);
        if (data.type === "selection") {
          // Only a *new* selection. The frame reports the same one again when
          // the reader's drag settles or the page reflows, and a re-report is
          // not the reader doing anything: counting it would close, and with an
          // empty draft delete, a note mid-thought.
          if (data.text && data.text !== lastSelectionRef.current) setPageClicks(count => count + 1);
          lastSelectionRef.current = data.text ?? "";
          const rect = annotationBox(data.rect);
          if (typeof data.text !== "string" || !data.text || data.text.length > 20000 || !rect) { latestSelection.current = null; setSelection(null); }
          else {
            const node = frameRef.current;
            const box = node?.getBoundingClientRect();
            if (node && box) {
              const annotation = historyRef.current[indexRef.current].source === "home" ? annotationSelection(data.annotation) : undefined;
              // A re-report of the same selection keeps its request id, so a
              // highlight saved from it is not saved twice under two ids.
              const previous = latestSelection.current;
              const next = {
                text: data.text!,
                requestId: previous && previous.text === data.text && previous.annotation?.selection === annotation?.selection ? previous.requestId : crypto.randomUUID(),
                rect, annotation,
                ...selectionMenuPoint(box, node.offsetWidth, rect),
              };
              latestSelection.current = next;
              setSelection(next);
            }
          }
        }
        if (data.type === "drag") onDrag(Boolean(data.over));
        if (data.type === "file-drop" && data.file instanceof File) onFileDrop(data.file);
      };
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    }, [onEngage, onExternalAction, onImportPdf, onDrag, onFileDrop, post, pushAnonymous, updateCurrent, loadEntry, annotations.receive, annotations.invalidate]);

    // A click in a frame the page itself embeds reaches neither this window
    // nor the page's own document, so nothing reports it as reading. Focus
    // does move: this window loses it to the frame, and the frame is told so it
    // can say whether the click went on into something it embeds.
    useEffect(() => {
      const entered = () => {
        if (document.activeElement === frameRef.current) post({ type: "focus-entered" });
      };
      window.addEventListener("blur", entered);
      return () => window.removeEventListener("blur", entered);
    }, [post]);

    // Keep framed articles from reflowing on every animation frame when a side
    // panel opens or closes. The wrapper clips the one final layout width.
    // A stored DOM is already sized to its build width and scaled; writing a
    // live `clientWidth` over that is the clip the scale was meant to prevent.
    useEffect(() => {
      const hold = (event: Event) => {
        if (layoutWidthRef.current) return;
        const node = frameRef.current;
        const wrap = node?.parentElement;
        if (!node || !wrap) return;
        const grow = (event as CustomEvent<{ grow?: number }>).detail?.grow ?? 0;
        node.style.width = `${(wrap.clientWidth + Math.max(0, grow)) * 100 / pageZoomRef.current}px`;
      };
      const release = () => {
        if (layoutWidthRef.current) return;
        if (frameRef.current && wrapRef.current) frameRef.current.style.width = `${wrapRef.current.clientWidth * 100 / pageZoomRef.current}px`;
      };
      window.addEventListener("delphi-panel-resize-start", hold);
      window.addEventListener("delphi-panel-resize-end", release);
      return () => {
        window.removeEventListener("delphi-panel-resize-start", hold);
        window.removeEventListener("delphi-panel-resize-end", release);
        release();
      };
    }, []);

    const coveredRef = useRef(covered);
    useEffect(() => { coveredRef.current = covered; }, [covered]);
    useEffect(() => {
      const change = (event: Event) => {
        const direction = zoomDirection(event);
        if (!coveredRef.current && direction !== null && !chatOwnsZoom()) {
          setPageZoom(value => direction === 0 ? 100 : stepPageZoom(value, direction));
          setSelection(null);
        }
      };
      window.addEventListener("delphi-page-zoom", change);
      return () => window.removeEventListener("delphi-page-zoom", change);
    }, []);

    const go = (nextIndex: number) => {
      const entry = historyRef.current[nextIndex];
      if (!entry) return;
      indexRef.current = nextIndex;
      setIndex(nextIndex);
      onHomeChange(entry.source !== "home");
      void loadEntry(entry).catch((reason) => setError(String(reason)));
    };

    useEffect(() => {
      if (!focus || loading) return;
      // A quote with no anchor is a passage on the live page: leave a captured
      // view for it, and scroll once the page is back.
      if (current.capture && !focus.anchor) { go(0); return; }
      if (current.capture?.kind === "html" && focus.anchor) {
        document.getElementById(focus.anchor)?.scrollIntoView({ block: "start" });
      } else {
        // The frame answers a quote it cannot find with nothing, so the short
        // one goes first and the whole, when it is found, replaces it.
        if (focus.lead && focus.lead !== focus.quote) post({ type: "scroll-to", anchor: focus.anchor, quote: focus.lead });
        post({ type: "scroll-to", anchor: focus.anchor, quote: focus.quote });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [current.capture, focus, loading, post]);

    // Viewing mode is independent of how the source produces its HTML.
    const savedCopy = frame?.view === "cached";
    // The copy holds only its first window, which ends mid-page as if that
    // were all of it: held back until the rest is read and `copy` turns whole.
    // A throttled site can hold its capture for half an hour, and a page with
    // no live view has nothing else to read, so the reader may read on.
    const [readEarly, setReadEarly] = useState<string | null>(null);
    const partialShown = copy === "partial" && savedCopy && index === 0 && current.source === "home";
    const reading = partialShown && readEarly !== paperId;

    // The saved copy changed under the reader (a partial page read whole).
    // Only the copy they are looking at is reloaded: a live page is the site
    // itself, and a page reached from the document loads the new copy when
    // they come back to it. A reader holding a passage or an open note is
    // left to finish; the swap waits for them to put it down. The frame's
    // "ready" restores the place the reader was at (`restore-scroll`).
    const shownCopy = useRef(copy);
    useEffect(() => {
      if (copy === shownCopy.current || loading) return;
      if (!savedCopy || index !== 0 || current.source !== "home") {
        shownCopy.current = copy;
        return;
      }
      if (selection || annotations.clicked) return;
      shownCopy.current = copy;
      void loadEntry(historyRef.current[0], true, fallbackViewRef.current).catch(reason => setError(String(reason)));
    }, [annotations.clicked, copy, current.source, index, loadEntry, loading, savedCopy, selection]);
    const reload = () => {
      recoveriesRef.current = 0;
      // The copy shown because the live page failed: Reload is the live page's second try.
      const saved = savedCopy && frame?.fallback !== "failed";
      void loadEntry(historyRef.current[indexRef.current], saved).catch(reason => setError(String(reason)));
    };
    const viewLatest = () => {
      void loadEntry(historyRef.current[0]).catch(reason => setError(String(reason)));
    };
    const viewSavedCopy = () => {
      void loadEntry(historyRef.current[0], true).catch(reason => setError(String(reason)));
    };

    /** File the page the reader navigated to as a document of its own. */
    const saveCurrent = () => {
      const entry = historyRef.current[indexRef.current];
      if (!entry || entry.source === "home" || entry.source === "evidence") return;
      onSavePage({
        source: "anonymous",
        kind: entry.kind,
        url: entry.resolvedUrl,
        title: entry.title,
      });
    };

    const navigateCleanView = (href: string) => {
      if (!browsingEnabled) {
        onExternalAction(href);
        return;
      }
      void pushAnonymous(href);
    };

    const reply = async () => {
      const selection = latestSelection.current;
      if (!selection) return;
      const ticket = serialRef.current;
      let quote = selection.text;
      try {
        if(selection.annotation) {
          quote = (await captureLatest(selection, selection.annotation, { pin: true })).captured.text;
          if (!alive.current || ticket !== serialRef.current) return;
          const entry = historyRef.current[indexRef.current];
          pinnedReply.current = { quote, url: entry.resolvedUrl, title: entry.title };
        }
      } catch(reason) { setAnnotationError(reason instanceof Error ? reason.message : String(reason));return; }
      onReply(quote);
      post({ type: "clear-selection" });
      setSelection(null);
    };

    // Where the frame is on screen, and the scale a stored DOM is shown at —
    // the same two numbers the selection toolbar is placed with. Measured only
    // when there is a card or a margin icon to put somewhere.
    const [markFrame, setMarkFrame] = useState<{ box: DOMRect; scale: number } | null>(null);
    useLayoutEffect(() => {
      const node = frameRef.current;
      if (!node || current.source !== "home" || current.capture) { setMarkFrame(null); return; }
      const update = () => {
        const box = node.getBoundingClientRect();
        setMarkFrame({ box, scale: node.offsetWidth ? box.width / node.offsetWidth : 1 });
      };
      update();
      const observer = new ResizeObserver(update);
      observer.observe(node);
      window.addEventListener("resize", update);
      window.addEventListener("delphi-panel-resize-end", update);
      return () => { observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("delphi-panel-resize-end", update); };
    }, [frame, current.source, current.capture, wrapSize, pageZoom]);

    return (
      <div className="page-shell">
        {annotations.error ? <p className="annotation-error" role="alert">{annotations.error} <button onClick={() => { annotations.retry(); reload(); }}>Retry</button></p> : null}
        {annotationError ? <WindowToast notice={annotationError} onDismiss={() => setAnnotationError("")} /> : null}
        <ReaderFind resetKey={`${current.id}:${frame?.serial ?? 0}`} search={async (query, index) => {
          if (current.capture) return findDocumentText(query, index, ".captured-reading-scroll");
          return api<FindResult>("/desktop/reader/find", { method: "POST", body: JSON.stringify({ frameName, query, index }) });
        }} />
        <div className="page-chrome">
          <div className="page-history-actions">
            <button className="icon-button" disabled={index <= 0} onClick={() => go(index - 1)} aria-label="Back">←</button>
            <button className="icon-button" disabled={index >= history.length - 1} onClick={() => go(index + 1)} aria-label="Forward">→</button>
          </div>
          <span className="page-favicon" aria-hidden="true">
            {current.favicon && brokenFavicon !== current.favicon ? (
              <img src={current.favicon} alt="" width={14} height={14} onError={() => setBrokenFavicon(current.favicon ?? null)} />
            ) : <GlobeIcon />}
          </span>
          <span className="page-address">
            <strong>{pageTitle(current.title)}</strong>
            <span className="page-address-path">{current.resolvedUrl}</span>
          </span>
          <div className="page-chrome-actions">
            <button className="icon-button page-tooltip" data-tooltip="Reload" onClick={reload} aria-label="Reload">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" /></svg>
            </button>
            <AnnotationsPanel drafts={drafts} highlights={highlights} notes={notes} onSaveNote={saveNote} onRemoveHighlight={onRemoveHighlight} placements={annotations.placements} selected={panelAnswers} pageClicks={pageClicks} onReveal={highlight => annotations.reveal(highlight.id)} />
            <ReaderMenu closeSignal={pageClicks}>
              {/* The document's own page has a copy the reader made; the one
                  row says which of the two this is, and switches. */}
              {current.source !== "home" ? null : savedCopy
                ? <ReaderMenuView onSelect={viewLatest}>View live</ReaderMenuView>
                : <ReaderMenuView disabled={!annotations.backup.available} onSelect={viewSavedCopy}
                    meta={annotations.backup.savedAt ? <time dateTime={annotations.backup.savedAt}>{new Date(annotations.backup.savedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</time> : null}>View cached</ReaderMenuView>}
              <ReaderMenuZoom
                value={pageZoom}
                canOut={pageZoom > 50}
                canIn={pageZoom < 200}
                onOut={() => { setPageZoom(value => stepPageZoom(value, -1)); setSelection(null); }}
                onIn={() => { setPageZoom(value => stepPageZoom(value, 1)); setSelection(null); }}
                onReset={() => { setPageZoom(100); setSelection(null); }}
                labels={{ out: "Zoom webpage out (⌘−)", in: "Zoom webpage in (⌘+)", reset: "Reset webpage zoom to 100%" }}
              />
              <ReaderMenuRule />
              <ReaderMenuItem glyph="browser" onSelect={() => window.open(current.resolvedUrl, "_blank", "noopener,noreferrer")}>Open in browser</ReaderMenuItem>
              {current.source === "home" ? null : <ReaderMenuItem glyph="home" onSelect={() => go(0)}>Back to the first page</ReaderMenuItem>}
              {current.source !== "home" && current.kind !== "image" && current.kind !== "pdf" && current.source !== "evidence"
                ? <ReaderMenuItem glyph="save" onSelect={saveCurrent}>Save as new document</ReaderMenuItem>
                : null}
            </ReaderMenu>
          </div>
        </div>
        {/* Said as what the reader is looking at, not as a failure: for a page
            that can only draw itself on its own site the saved copy is the right
            view, and the date says how current it is. The reason is said too,
            or a reader takes the missing live page for a bug. */}
        {frame?.fallback && !loading && !error && !reading ? (
          <p className="page-notice is-info">
            <strong>Saved copy{annotations.backup.savedAt ? <> · <time dateTime={annotations.backup.savedAt}>{savedOn(annotations.backup.savedAt)}</time></> : null}.</strong>{" "}
            {frame.fallback === "own-address"
              ? "This site only shows its pages on its own website. Showing the cached copy here."
              : "The live page didn’t load just now. Reload tries again."}
            {partialShown ? " The rest of the page is still being read and appears here when it is." : null}
          </p>
        ) : null}
        {blank && !error ? (
          <p className="page-notice">
            This page rendered nothing readable. Open it in your browser to
            see it as the site serves it.
          </p>
        ) : null}
        <div className="page-frame-wrap" ref={wrapRef}>
          {loading && !error ? (
            <div className="document-loading" role="status" aria-live="polite">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/animations/delphi-loading-climb.gif" alt="" />
              <LoadingCaption text="Loading webpage…" />
            </div>
          ) : reading && !error ? (
            <div className="document-loading is-reading" role="status" aria-live="polite">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/animations/delphi-loading-climb.gif" alt="" />
              <LoadingCaption text="Reading the rest of this page…" />
              <p>A long page is read in parts. It opens here once Delphi has all of it.</p>
              <button type="button" className="secondary-button" onClick={() => setReadEarly(paperId)}>Read what’s here</button>
            </div>
          ) : null}
          {error ? <div className="panel-error">{error}</div> : null}
          {current.capture ? (
            <div style={{ zoom: pageZoom / 100, height: `${10000 / pageZoom}%` }}>
            <CleanReadingView
              entry={current}
              onNavigate={navigateCleanView}
              onScroll={(scrollY) => updateCurrent({ scrollY })}
            />
            </div>
          ) : frame ? (
            <iframe
              key={`${paperId}:${frame.serial}`}
              ref={frameRef}
              name={frameName}
              className="page-frame"
              style={frameStyle}
              src={frame.method === "GET" ? frame.url : "about:blank"}
              title={pageTitle(current.title)}
              sandbox={frame.sandbox}
              allow={frame.allow}
              referrerPolicy="no-referrer"
              onLoad={() => {
                const ticket = navigationSerial.current;
                const serial = frame.serial;
                if (postBootLoadsRef.current > 0) {
                  postBootLoadsRef.current -= 1;
                  return;
                }
                const claim = () => {
                  const nonce = pendingHelloRef.current.shift();
                  if (!nonce || nonce !== nonceRef.current) return false;
                  setLoading(false);
                  recoveriesRef.current = 0;
                  return true;
                };
                if (claim()) return;
                window.setTimeout(() => {
                  if (ticket !== navigationSerial.current || serial !== serialRef.current) return;
                  if (!claim()) escaped();
                }, ESCAPE_GRACE_MS);
              }}
              onError={() => setError("Delphi could not load that page in the reader.")}
            />
          ) : null}
        </div>
        {selection ? <ReaderSelectionMenu x={selection.x} y={selection.y} onReply={() => void reply()}
          onHighlight={current.source === "home" && selection.annotation ? () => void saveAnnotation(false) : undefined}
          onNote={current.source === "home" && selection.annotation ? () => void saveAnnotation(true) : undefined}
          preparing={savingAnnotation} /> : null}
        <PageNoteLayer drafts={drafts} frameBox={markFrame?.box ?? null} scale={markFrame?.scale ?? 1} card={noteCard} onCard={setNoteCard} pageClicks={pageClicks}
          highlights={highlights} notes={notes} geometry={annotations.geometry}
          onSaveNote={saveNote} onRemoveHighlight={onRemoveHighlight} onError={setAnnotationError} />
      </div>
    );
  },
);

export function GlobeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.2" />
      <ellipse cx="7" cy="7" rx="2.4" ry="5.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.6 7h10.8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
