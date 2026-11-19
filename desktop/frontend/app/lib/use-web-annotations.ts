"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, API_BASE, ApiError, DEFAULT_APP_CONFIG, type Highlight, type HtmlAnchor } from "./api";
import { forgetProjectAnchors } from "./anchor-index.ts";
import { annotationBox as box, annotationCapture, annotationIndex, pageCopy, type PageCopy } from "./web-annotation-state.ts";
/** Where a mark is painted, in the frame's own viewport pixels; `x` is the middle of its first line. */
export type MarkGeometry = Record<string, { top: number; bottom: number; x: number }>;
/** A mark the reader clicked, with the box the frame painted it in. */
export type MarkClick = {
  ids: string[];
  rect: { x: number; y: number; w: number; h: number } | null;
  nonce: number;
};
/** A selection the frame will measure when the reader acts on it. */
export type WebSelection = {
  selection: number;
};
export type Placement = {
  id: string;
  status: "placed" | "missing" | "ambiguous" | "unknown" | "unavailable";
  start?: number;
  end?: number;
};
type Revision = {
  epoch: number;
  generation: number;
  revision: string;
  complete: boolean;
};
/**
 * Owns the worker. React retains only placements, never a second article index.
 *
 * Making an annotation never waits for the page. The frame is asked for the
 * reader's selection when the reader acts on it, and answers with the page's
 * text and the selection in it, read together; the worker makes the anchor from
 * that. The index marks are painted from arrives separately, whenever the frame
 * has read the page again, and replaces the last one without disturbing the
 * marks, the list or a capture in flight.
 *
 * `measure` names the marks the reader's view is pointing at — the ones with a
 * margin icon and the one with a card open — so the frame reports where they
 * are after every reflow. It is the only thing about the reader's annotations,
 * beyond where to paint, that ever crosses into the page.
 *
 * It also keeps the document's saved copy: see `keepAnnotatedPage`.
 */
export function useWebAnnotations(projectId: string, paperId: string, highlights: Highlight[], measure: string[], post: (message: Record<string, unknown>) => void, savedPageMaxBytes = DEFAULT_APP_CONFIG.webSavedPageMaxBytes) {
  const path = `/api/projects/${projectId}/papers/${paperId}/annotation-revision`;
  const cachedPlacements = useRef(new Map<string, {
    revision: string;
    start: number;
    end: number;
  }>());
  const [attempt, setAttempt] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  const [backup, setBackup] = useState<{
    available: boolean;
    savedAt?: string;
  }>({ available: false });
  const worker = useRef<Worker | null>(null);
  // Once per opening, each. The first annotation keeps the page and re-fetches
  // the text the model reads; later ones in the same visit mark up the same
  // page, so doing either again would redo the same work. A failure leaves the
  // next annotation to try again.
  const kept = useRef(false);
  const refreshing = useRef(false);
  const pageKept = useRef(false);
  const keepingPage = useRef(false);
  // Whether the frame on screen can serialise itself: its bridge says so when
  // it is ready, and one served by an older backend never does.
  const pageCapturable = useRef(false);
  const pageCaptures = useRef(new Map<string, {
    resolve: (copy: PageCopy) => void;
    reject: (reason: Error) => void;
  }>());
  const pinnedQuote = useRef<string | null>(null);
  const current = useRef<Revision | null>(null);
  // A replacement iframe restarts its own generation counter at zero.
  const epoch = useRef(0);
  const pendingIndex = useRef<Record<string, unknown> | null>(null);
  const records = useRef(highlights);
  const handles = useRef(new Map<string, string>());
  const evidenceRequests = useRef(new Map<string, {
    resolve: (value: {
      revision: string;
      texts: string[];
    }) => void;
    reject: (reason: Error) => void;
  }>());
  const pending = useRef(new Map<string, {
    pin: boolean;
    resolve: (value: {
      anchor: HtmlAnchor;
      text: string;
    }) => void;
    reject: (reason: Error) => void;
  }>());
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [error, setError] = useState("");
  const [clicked, setClicked] = useState<MarkClick | null>(null);
  const clicks = useRef(0);
  // Where the frame painted the marks named in `measure`, so icons and cards
  // follow their lines through a scroll, a zoom or the library folding away.
  const [geometry, setGeometry] = useState<MarkGeometry>({});
  const measureKey = [...measure].sort().join(" ");
  const measured = useRef(new Set(measure));
  const lastPaint = useRef<{ generation: number; ranges: { handle: string; start: number; end: number; measure: boolean }[] } | null>(null);
  /**
   * The set of marks to measure changed — a note was written or deleted, or a
   * card opened over a mark. Repainting is what tells the frame, so an icon
   * appears where a card just closed rather than on the next load. The marks
   * themselves have not moved: same handles, same offsets, so this is a cheap
   * re-send and not a relocation.
   */
  useEffect(() => {
    measured.current = new Set(measureKey ? measureKey.split(" ") : []);
    const last = lastPaint.current;
    if (!last)
      return;
    const ranges = last.ranges.map(range => ({ ...range, measure: measured.current.has(handles.current.get(range.handle) ?? "") }));
    if (ranges.every((range, index) => range.measure === last.ranges[index].measure))
      return;
    lastPaint.current = { ...last, ranges };
    post({ type: "annotation-paint", generation: last.generation, ranges });
  }, [measureKey, post]);
  const refreshSaved = useCallback(async () => {
    const saved = await api<{
      available: boolean;
      savedAt: string;
    }>(path, { signal: lifetime.current?.signal });
    if (lifetime.current?.signal.aborted) return;
    setBackup({ available: saved.available, savedAt: saved.savedAt });
  }, [path]);
  /**
   * Ask the frame for the page as it is drawn now. Only an answer to a request
   * made here is accepted, and only one within the limits the backend holds it
   * to; anything else the frame sends is ignored.
   */
  const capturePage = useCallback(() => new Promise<PageCopy>((resolve, reject) => {
    if (!pageCapturable.current) {
      reject(new Error("This page cannot be kept as it is shown."));
      return;
    }
    const request = crypto.randomUUID();
    const timer = setTimeout(() => { pageCaptures.current.delete(request); reject(new Error("The page did not answer in time.")); }, 10000);
    pageCaptures.current.set(request, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: reason => { clearTimeout(timer); reject(reason); } });
    post({ type: "page-capture", request, maxBytes: savedPageMaxBytes });
  }), [post, savedPageMaxBytes]);
  /**
   * Send the page copy. Not tied to this view's lifetime: the reader often
   * annotates and leaves, which is exactly when keeping the page matters, and
   * the copy is of the page they annotated whatever the frame shows by then.
   */
  const storePage = useCallback(async (copy: PageCopy) => {
    const query = new URLSearchParams({ width: String(copy.width), url: copy.url });
    try {
      await api(`/api/projects/${projectId}/papers/${paperId}/saved-page?${query}`, {
        method: "PUT", body: copy.html, headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch (reason) {
      // A backend from before page copies has no such route; the text refresh
      // still renews the copy there, as it always did, so do not ask again.
      if (reason instanceof ApiError && (reason.status === 404 || reason.status === 405)) return;
      throw reason;
    }
    await refreshSaved().catch(() => { });
  }, [paperId, projectId, refreshSaved]);
  const wantsPage = useCallback(() => !pageKept.current && !keepingPage.current && pageCapturable.current, []);
  /**
   * An annotation was saved on the live page: keep the page as the reader
   * annotated it, so the cached view is what they marked up — with whatever
   * the page's scripts drew — and re-fetch the text the model reads of it.
   *
   * Once a visit, on its first annotation: the copy is a backup of a page
   * that might be taken down, not a history of it. `page` is the copy taken
   * with the selection, so a page that changed while the highlight was being
   * saved is still kept as it was when it was marked; a note, which has no
   * selection, takes the page as it is. Annotating the saved copy keeps
   * nothing: it is already what is kept. Opening, reloading and switching
   * views never reach here. A frame from a backend before page copies cannot
   * make one; there, the text refresh renews the copy as it always did.
   */
  const keepAnnotatedPage = useCallback((viewingSavedCopy: boolean, page?: Promise<PageCopy>) => {
    if (viewingSavedCopy) return;
    const copy = page ?? (wantsPage() ? capturePage() : undefined);
    if (copy && !pageKept.current && !keepingPage.current) {
      keepingPage.current = true;
      void copy.then(storePage)
        .then(() => { pageKept.current = true; })
        // Housekeeping the reader never asked for: the annotation is saved
        // either way, and a refusal is the backend keeping a copy it trusts more.
        .catch(reason => console.warn("Saved copy not updated", reason))
        .finally(() => { keepingPage.current = false; });
    }
    if (kept.current || refreshing.current) return;
    refreshing.current = true;
    void api(`/api/projects/${projectId}/papers/${paperId}/refresh`, { method: "POST" })
      // The re-snapshot rewrote this page's sections under the same id.
      .then(() => { kept.current = true; forgetProjectAnchors(projectId); return refreshSaved(); })
      // Housekeeping the reader never asked for: the annotation is saved either
      // way, and a refused refresh is the server keeping text it trusts more.
      .catch(reason => console.warn("Saved text not updated", reason))
      .finally(() => { refreshing.current = false; });
  }, [capturePage, paperId, projectId, refreshSaved, storePage, wantsPage]);
  const relocate = useCallback(() => {
    if (current.current?.revision)
      worker.current?.postMessage({ type: "resolve", ...current.current, annotations: records.current.filter(h => h.type === "html").map(h => ({ ...h, placement: cachedPlacements.current.get(h.id) ?? h.placement })) });
  }, []);
  const invalidate = useCallback(() => {
    epoch.current++;
    current.current = null;
    worker.current?.postMessage({ type: "invalidate" });
    pendingIndex.current = null;
    setPlacements([]);
    setGeometry({});
    setClicked(null);
    lastPaint.current = null;
    handles.current.clear();
    for (const request of pending.current.values())
      request.reject(new Error("The page changed. Select the passage again."));
    pending.current.clear();
    for (const request of evidenceRequests.current.values()) request.reject(new Error("The page changed while preparing the question. Please retry."));
    evidenceRequests.current.clear();
    // The next document says for itself whether it can be kept.
    pageCapturable.current = false;
    for (const request of pageCaptures.current.values()) request.reject(new Error("The page changed before it could be kept."));
    pageCaptures.current.clear();
  }, []);
  useEffect(() => {
    records.current = highlights;
    relocate();
  }, [highlights, relocate]);
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    pinnedQuote.current = null;
    let owned: Worker | null = null;
    let workerUrl: string | null = null;
    void Promise.all([
      fetch(`${API_BASE}/api/projects/annotation-worker.js`, { signal: abort.signal, credentials: "include" }),
      api<{
        available: boolean;
        savedAt: string;
      }>(path, { signal: abort.signal }),
    ]).then(async ([response, saved]) => {
      if (abort.signal.aborted) return;
      setBackup({ available: saved.available, savedAt: saved.savedAt });
      if (!response.ok)
        throw new Error("Web annotations require an updated backend");
      const source = await response.text();
      if (abort.signal.aborted)
        return;
      // WebKit may not load the Blob until after the constructor returns.
      // Keep its URL alive for the lifetime of the worker.
      workerUrl = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
      owned = new Worker(workerUrl);
      worker.current = owned;
      owned.onmessage = ({ data }) => {
        if (abort.signal.aborted) return;
        if (data.type === "captured") {
          const request = pending.current.get(data.request);
          pending.current.delete(data.request);
          if (request?.pin) pinnedQuote.current = data.text;
          request?.resolve({ anchor: data.anchor, text: data.text });
          return;
        }
        if (data.type === "evidence") {
          evidenceRequests.current.get(data.request)?.resolve({ revision: data.revision, texts: data.texts });
          evidenceRequests.current.delete(data.request);
          return;
        }
        if (data.type === "error") {
          if (data.request && evidenceRequests.current.has(data.request)) {
            evidenceRequests.current.get(data.request)!.reject(new Error(data.message));
            evidenceRequests.current.delete(data.request);
            // The caller decides whether this request needs a notice. A
            // missing live viewport is a normal fallback for ordinary chat.
            return;
          }
          setError(data.message);
          if (data.request) {
            pending.current.get(data.request)?.reject(new Error(data.message));
            pending.current.delete(data.request);
          }
          return;
        }
        if (!current.current || data.epoch !== current.current.epoch || data.generation !== current.current.generation)
          return;
        if (data.type === "indexed") {
          setError("");
          current.current.revision = data.revision;
          relocate();
        }
        if (data.type === "placements" && data.revision === current.current.revision) {
          setPlacements(data.results);
          const ranges: {
            handle: string;
            start: number;
            end: number;
            measure: boolean;
          }[] = [];
          handles.current.clear();
          for (const placement of data.results as Placement[]) {
            if (placement.status !== "placed")
              continue;
            const handle = crypto.randomUUID();
            handles.current.set(handle, placement.id);
            ranges.push({ handle, start: placement.start!, end: placement.end!, measure: measured.current.has(placement.id) });
          }
          lastPaint.current = { generation: data.generation as number, ranges };
          post({ type: "annotation-paint", generation: data.generation, ranges });
          const byId = new Map(records.current.map(record => [record.id, record]));
          const updates = (data.results as Placement[]).flatMap(place => {
            if (place.status !== "placed")
              return [];
            const original = byId.get(place.id);
            if (!original)
              return [];
            const prior = cachedPlacements.current.get(place.id) ?? original.placement ?? original.anchor;
            if (prior && prior.revision === data.revision && prior.start === place.start && prior.end === place.end)
              return [];
            return [{ id: place.id, start: place.start!, end: place.end! }];
          });
          if (updates.length)
            void api<void>(path.replace("annotation-revision", "annotation-placements"), { method: "POST", body: JSON.stringify({ revision: data.revision, placements: updates }) })
              .then(() => { for (const place of updates)
              cachedPlacements.current.set(place.id, { revision: data.revision, start: place.start, end: place.end }); })
              .catch(() => { });
        }
      };
      owned.onerror = () => { setError("Page matching stopped. Your annotations remain in the panel."); invalidate(); };
      if (pendingIndex.current)
        owned.postMessage(pendingIndex.current);
    }).catch(reason => { if (!abort.signal.aborted)
      setError(String(reason)); });
    return () => { abort.abort(); owned?.terminate(); if (workerUrl) URL.revokeObjectURL(workerUrl); worker.current = null; invalidate(); };
  }, [post, relocate, invalidate, path, attempt]);
  const receive = useCallback((data: Record<string, unknown>) => {
    if (data.type === "annotation-invalidated" || data.type === "annotation-unavailable") {
      invalidate();
      return;
    }
    if (data.type === "ready")
      pageCapturable.current = data.pageCapture === true;
    if (data.type === "page-capture") {
      // An answer nothing here asked for — unsolicited, or to a request the
      // page has since outlived — is dropped.
      const request = typeof data.request === "string" ? pageCaptures.current.get(data.request) : undefined;
      if (!request) return;
      pageCaptures.current.delete(data.request as string);
      const copy = pageCopy(data, savedPageMaxBytes);
      if (copy) request.resolve(copy);
      else request.reject(new Error(typeof data.error === "string" ? data.error.slice(0, 200) : "The page sent a copy that cannot be kept."));
      return;
    }
    if (data.type === "annotation-index") {
      const index = annotationIndex(data);
      if (!index) return;
      // A newer reading of the same page. What is painted and listed stays
      // until the new placements replace it.
      current.current = { epoch: epoch.current, generation: index.generation, revision: "", complete: index.complete };
      const message = { type: "index", epoch: epoch.current, generation: index.generation, texts: index.texts };
      if (worker.current)
        worker.current.postMessage(message);
      else
        pendingIndex.current = message;
    }
    if (data.type === "annotation-capture") {
      const answer = annotationCapture(data);
      const request = answer && pending.current.get(answer.request);
      if (!answer || !request) return;
      if ("error" in answer) {
        pending.current.delete(answer.request);
        request.reject(new Error(answer.error));
      }
      else if (!worker.current) {
        pending.current.delete(answer.request);
        request.reject(new Error("Page matching is not available. Please retry."));
      }
      else worker.current.postMessage({ type: "capture", request: answer.request, texts: answer.texts, start: answer.start, end: answer.end, pin: request.pin });
    }
    if (data.type === "annotation-click" && data.generation === current.current?.generation && Array.isArray(data.handles)) {
      const ids = data.handles.slice(0, 10000).flatMap(h => typeof h === "string" && handles.current.has(h) ? [handles.current.get(h)!] : []);
      setClicked(ids.length ? { ids, rect: box(data.rect), nonce: ++clicks.current } : null);
    }
    if (data.type === "annotation-geometry" && data.generation === current.current?.generation && Array.isArray(data.items)) {
      const next: MarkGeometry = {};
      for (const item of data.items.slice(0, 200) as { handle?: unknown; top?: unknown; bottom?: unknown; x?: unknown }[]) {
        if (!item || typeof item !== "object") continue;
        const id = typeof item.handle === "string" ? handles.current.get(item.handle) : undefined;
        if (id && Number.isFinite(item.top) && Number.isFinite(item.bottom) && Number.isFinite(item.x))
          next[id] = { top: item.top as number, bottom: item.bottom as number, x: item.x as number };
      }
      setGeometry(next);
    }
  }, [invalidate, savedPageMaxBytes]);
  /**
   * The selected passage as an annotation. `pin` keeps the page as it was read
   * for this as a Reply's evidence, so the question is answered from what the
   * reader was looking at even if the page changes before it is sent. `page`
   * also asks for the page itself, in the frame's very next task after the
   * selection is read, for `keepAnnotatedPage` once the annotation is saved.
   */
  const capture = useCallback((selection: WebSelection, { pin = false, page = false } = {}) => {
    let copy: Promise<PageCopy> | undefined;
    const captured = new Promise<{
      anchor: HtmlAnchor;
      text: string;
    }>((resolve, reject) => {
      const request = crypto.randomUUID();
      const timer = setTimeout(() => { pending.current.delete(request); reject(new Error("Could not read this selection. Please retry.")); }, 5000);
      pending.current.set(request, { pin, resolve: value => { clearTimeout(timer); resolve(value); }, reject: reason => { clearTimeout(timer); reject(reason); } });
      post({ type: "annotation-capture", request, selection: selection.selection });
      if (page && wantsPage()) {
        copy = capturePage();
        // Unused when the annotation is not saved; not an unhandled failure.
        copy.catch(() => { });
      }
    });
    return captured.then(value => ({ ...value, page: copy }));
  }, [capturePage, post, wantsPage]);
  const evidence = useCallback((quote: string) => new Promise<{
    revision: string;
    texts: string[];
  }>((resolve, reject) => {
    if (quote && pinnedQuote.current !== quote) {
      reject(new Error("The selected page revision is no longer available. Select the passage again."));
      return;
    }
    if (!worker.current) {
      reject(new Error("Page text is unavailable. Please wait for it to finish loading."));
      return;
    }
    const request = crypto.randomUUID();
    const timer = setTimeout(() => { evidenceRequests.current.delete(request); reject(new Error("Could not read the selected page revision.")); }, 5000);
    evidenceRequests.current.set(request, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: reason => { clearTimeout(timer); reject(reason); } });
    worker.current.postMessage({ type: "evidence", request, quote });
  }), []);
  /**
   * Scroll the page to a mark, leaving it in the middle of the view. The frame
   * is told where the mark is in the current text — the same offsets it was
   * painted from — so it goes to the painted passage itself, not to the first
   * run of text that happens to read the same. False when the mark has no
   * place on this page to go to.
   */
  const reveal = useCallback((id: string) => {
    const place = placements.find(item => item.id === id && item.status === "placed");
    if (!place || !current.current)
      return false;
    post({ type: "annotation-reveal", generation: current.current.generation, start: place.start, end: place.end });
    return true;
  }, [placements, post]);
  const retry = useCallback(() => { setError(""); setAttempt(value => value + 1); }, []);
  return { retry, placements, error, clicked, geometry, capture, receive, invalidate, backup, evidence, reveal, keepAnnotatedPage };
}
