"use client";

/**
 * The first run, one question at a time.
 *
 * A new reader used to land on the Dashboard's empty state: a mission they had
 * not read anything under yet and a card pointing at the Reader, where they then
 * had to learn projects before they could add anything. This asks for the two
 * things a library needs instead, one screen each, and hands over a Dashboard
 * that already has projects and documents in it.
 *
 * Two routes through it. A Chrome bookmarks export becomes projects the reader
 * can rename and prune before anything is sent; skipping it asks for one project
 * name and up to five PDFs. Both end on the mission, and Enter moves forward on
 * every screen.
 *
 * Nothing here is new API. Projects, pages and uploads go through the same
 * endpoints the Reader uses, with the Reader's two questions answered the way a
 * first run would: a PDF link is imported as a PDF, and an upload that only fits
 * compressed is kept.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import {
  API_BASE, ApiError, api, isStagedUpload, isWebPaper,
  type AppConfig, type Paper, type Project, type UploadResult,
} from "../lib/api";
import {
  DOCUMENT_TITLE_MAX, PROJECT_NAME_MAX, isImportableUrl, parseBookmarks, runPool,
} from "../lib/bookmarks";
import { requestCaptures } from "../lib/capture-queue";
import { carriesFiles, isPdfFile } from "../lib/file-drag";
import { memoryStages, onMemoryStage, requestMemoryMaintenance } from "../lib/memory-maintenance";
import { useFileDrop } from "../lib/use-file-drop";
import { OnboardingFan } from "./OnboardingFan";

type StepId = "welcome" | "bookmarks" | "preview" | "project" | "documents" | "webpage" | "finale";
export type Status = "pending" | "adding" | "done" | "failed";

type DraftDocument = { key: string; title: string; url: string; status: Status; error?: string };
type DraftProject = { key: string; name: string; documents: DraftDocument[]; error?: string };
type PickedFile = { key: string; file: File; status: Status; error?: string };

type Readiness = {
  status: "running" | "complete" | null;
  uploaded?: number;
  completed?: number;
  pending?: number;
};

/** A failed filing never counts as a completed first document. */
function isReady(readiness: Readiness | null): boolean {
  if (!readiness) return false;
  if (readiness.status !== "running") return readiness.status === "complete";
  return (readiness.completed ?? 0) > 0;
}

/** The Reader's answer to "how many at once" for a first library. */
const ONBOARDING_MAX_FILES = 5;

let keys = 0;
export const nextKey = () => `k${++keys}`;

export const hostOf = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
};

export const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** An upload that only fits compressed is kept: a first run has no one to ask. */
export async function keep(projectId: string, result: UploadResult): Promise<Paper> {
  if (!isStagedUpload(result)) {
    // A page added at its first window is read whole in the background.
    if (result.capture === "partial") requestCaptures();
    return result;
  }
  return api<Paper>(`/api/projects/${projectId}/papers/staged`, {
    method: "POST",
    body: JSON.stringify({ token: result.token }),
  });
}

/** A web page, or — when the address is a PDF — the PDF itself, as the Reader offers. */
export async function addPage(projectId: string, url: string): Promise<Paper> {
  const add = (pdfMode: "ask" | "upload") => api<UploadResult>(`/api/projects/${projectId}/pages`, {
    method: "POST",
    body: JSON.stringify({ url, pdf_mode: pdfMode }),
  });
  try {
    return await keep(projectId, await add("ask"));
  } catch (reason) {
    if (reason instanceof ApiError && reason.code === "pdf_url") {
      return keep(projectId, await add("upload"));
    }
    throw reason;
  }
}

/**
 * The digest the Reader starts after every PDF it adds, read to the end so the
 * server finishes it. Nobody is waiting on the result here; opening the paper
 * later finds it ready.
 */
export async function digest({ projectId, paperId }: { projectId: string; paperId: string }) {
  try {
    const response = await fetch(`${API_BASE}/api/projects/${projectId}/papers/${paperId}/digest/stream`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: false }),
    });
    const reader = response.body?.getReader();
    if (!reader) return;
    while (!(await reader.read()).done) { /* drain */ }
  } catch {
    // The Reader offers to generate a digest that is missing; nothing is lost.
  }
}

export const message = (reason: unknown, fallback: string) =>
  reason instanceof Error && reason.message ? reason.message : fallback;

export function CheckIcon() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
    <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function CloseIcon() {
  return <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M3 3l8 8M11 3l-8 8" />
  </svg>;
}

export function Chevron({ up }: { up?: boolean }) {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={up ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
  </svg>;
}

export function UploadIcon() {
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
  </svg>;
}

/** The mark on a button that confirms an answer. */
export function ConfirmIcon() {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8.5l3.2 3L13 4.5" />
  </svg>;
}

/** A ring with a dawn arc. On a button, its track takes the button's own ink. */
export function Spinner({ track = "rgba(252,237,232,0.24)" }: { track?: string }) {
  return <svg className="onboarding-spinner" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <circle cx="9" cy="9" r="7" stroke={track} strokeWidth="2" />
    <path d="M9 2a7 7 0 0 1 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>;
}

function Crumb() {
  return <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 2l3 3-3 3" />
  </svg>;
}

export function StatusMark({ status, error }: { status: Status; error?: string }) {
  const label = { pending: "Waiting", adding: "Adding", done: "Added", failed: error || "Could not be added" }[status];
  return <span className={`onboarding-status is-${status}`} role="img" aria-label={label} title={label}>
    {status === "done" ? <CheckIcon /> : status === "failed" ? <CloseIcon /> : null}
  </span>;
}

/** OK, and the key that does the same thing. An answer is confirmed with a check. */
export function Actions({ label = "OK", confirm, disabled, busy, onClick, children }: {
  label?: string; confirm?: boolean; disabled?: boolean; busy?: boolean; onClick: () => void; children?: ReactNode;
}) {
  return <div className="onboarding-actions">
    <button type="button" className="onboarding-ok" disabled={disabled || busy} onClick={onClick}>
      {label}{busy ? <Spinner track="rgba(122,42,35,0.2)" /> : confirm ? <ConfirmIcon /> : null}
    </button>
    {disabled || busy ? null : <span className="onboarding-enter" aria-hidden="true">press <b>Enter ↵</b></span>}
    {children}
  </div>;
}

export function Question({ number, title, help }: { number?: number; title: string; help?: ReactNode }) {
  return <header>
    <div className="onboarding-question">
      {number ? <span className="onboarding-number" aria-hidden="true">{number} →</span> : null}
      <h2>{title}</h2>
    </div>
    {help ? <p className="onboarding-help">{help}</p> : null}
  </header>;
}

/**
 * Drop or choose. Claims every file drag over it; what it accepts is checked on
 * drop. The tall zone is itself the button; the row form, which sits above a
 * list of what was chosen, has its own.
 */
export function DropZone({ accept, multiple, row, title, detail, onFiles }: {
  accept: string; multiple?: boolean; row?: boolean; title: string; detail?: ReactNode; onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { active, handlers } = useFileDrop({ claim: carriesFiles, onDrop: onFiles });
  const choose = () => input.current?.click();
  const button = row ? {} : {
    role: "button",
    tabIndex: 0,
    onClick: choose,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); }
    },
  };
  return <div className={`onboarding-drop${row ? " is-row" : ""}${active ? " is-active" : ""}`} {...button} {...handlers}>
    <span className="onboarding-drop-icon"><UploadIcon /></span>
    {row ? <>
      <span className="onboarding-drop-text"><strong>{title}</strong>{detail ? <span>{detail}</span> : null}</span>
      <button type="button" className="onboarding-choose" onClick={choose}>Choose files</button>
    </> : <>
      <span className="onboarding-drop-title">{title}</span>
      {detail}
    </>}
    <input
      ref={input}
      type="file"
      hidden
      accept={accept}
      multiple={multiple}
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (files.length) onFiles(files);
      }}
    />
  </div>;
}

/**
 * One screen. All of them stay mounted and stacked, so a transition is only a
 * change of `data-state`: the answered one rises away, the next rises in.
 */
export function Step({ id, state, centered, children }: {
  id: string; state: "past" | "current" | "future"; centered?: boolean; children: ReactNode;
}) {
  return <section
    className={`onboarding-step${centered ? " is-centered" : ""}`}
    data-step={id}
    data-state={state}
    aria-hidden={state === "current" ? undefined : true}
    inert={state !== "current"}
    tabIndex={-1}
  >
    <div className="onboarding-step-inner">{children}</div>
  </section>;
}

/**
 * Enter anywhere that is not already a control answers the current screen.
 * Inputs, buttons and the drop zone answer Enter themselves; answering here
 * too would act twice.
 */
export function useEnterAdvances<K extends string>(primary: Partial<Record<K, () => void>>, step: K) {
  const primaryRef = useRef(primary);
  const stepRef = useRef(step);
  useEffect(() => {
    primaryRef.current = primary;
    stepRef.current = step;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, a, [role='button'], [contenteditable='true'], .modal-backdrop, .search-backdrop")) return;
      event.preventDefault();
      primaryRef.current[stepRef.current]?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/**
 * A file dropped beside a drop zone would otherwise replace the whole app with
 * the file. The zones stop the drags they claim before this sees them.
 */
export function useSwallowStrayDrops() {
  useEffect(() => {
    const swallow = (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);
}

/**
 * Focus follows the question, once it has started arriving. Only a text field
 * takes focus: anything else would put a focus ring on a control the pointer
 * never touched, and a focused drop zone or button would answer Enter itself
 * instead of moving on.
 */
export function useFocusFollowsStep(stage: { current: HTMLElement | null }, step: string) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const current = stage.current?.querySelector<HTMLElement>(`[data-step="${step}"]`);
      const target = current?.querySelector<HTMLElement>("[data-autofocus]:not(:disabled)") ?? current;
      target?.focus({ preventScroll: true });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [stage, step]);
}

/** A document's kind on a dawn-tinted tile: a globe for a webpage, a page for a PDF. */
export function KindMark({ kind }: { kind: "web" | "pdf" }) {
  return <span className="onboarding-kind" role="img" aria-label={kind === "web" ? "Webpage" : "PDF"}>
    {kind === "web" ? <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.7 2.5 14.3 0 17M12 3.5c-2.5 2.7-2.5 14.3 0 17" />
    </svg> : <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6zM14 3v4h4" />
    </svg>}
  </span>;
}

/** The Delphi mark, cream on the dusk ground: the sun rising behind the peak. */
export function OnboardingMark({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 120 120" fill="none" aria-hidden="true">
    <circle cx="60" cy="40" r="21" fill="#F6C29C" />
    <path d="M60 44 L98 98 H22 Z" fill="#FCEDE8" style={{ stroke: "var(--onboarding-ground)" }} strokeWidth="10" strokeLinejoin="round" />
  </svg>;
}

export function Onboarding({ config, onFinish }: {
  config: AppConfig;
  /** Called once the reader leaves the last screen; reloads the Dashboard. */
  onFinish: () => Promise<void>;
}) {
  const webImports = config.webDocumentsEnabled;
  const [step, setStep] = useState<StepId>("welcome");
  /** Whether bookmarks were imported: it decides which screens follow. */
  const [route, setRoute] = useState<"bookmarks" | "manual">(webImports ? "bookmarks" : "manual");
  const [committed, setCommitted] = useState(false);
  const [farthest, setFarthest] = useState(0);

  const [drafts, setDrafts] = useState<DraftProject[]>([]);
  const [bookmarkError, setBookmarkError] = useState("");
  const [importing, setImporting] = useState<"idle" | "running" | "done">("idle");
  /** Why the import added nothing at all, when it added nothing at all. */
  const [importFailure, setImportFailure] = useState("");

  const [projectName, setProjectName] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [fileNote, setFileNote] = useState("");
  const [uploading, setUploading] = useState<"idle" | "running" | "done">("idle");
  const [uploadError, setUploadError] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [addingPage, setAddingPage] = useState(false);
  const [pageError, setPageError] = useState("");

  const [added, setAdded] = useState({ projects: 0, documents: 0 });
  /** Whether the preview list has more below its edge, to fade that edge. */
  const [moreBelow, setMoreBelow] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const measureList = useCallback(() => {
    const element = list.current;
    if (element) setMoreBelow(element.scrollTop + element.clientHeight < element.scrollHeight - 4);
  }, []);
  useEffect(() => {
    measureList();
    window.addEventListener("resize", measureList);
    return () => window.removeEventListener("resize", measureList);
  }, [drafts, measureList]);
  const [finishing, setFinishing] = useState(false);
  /** The attempt's tally from the server, which the last screen waits on. */
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [pollNonce, setPollNonce] = useState(0);
  /** What the filing is doing this moment, as the pump in this tab hears it. */
  const [filingStage, setFilingStage] = useState("");
  const ready = isReady(readiness);
  const filingFailed = readiness?.status === "running" && (readiness.uploaded ?? 0) > 0
    && !readiness.completed && readiness.pending === 0;
  const [finishError, setFinishError] = useState("");

  const path = useMemo<StepId[]>(() => [
    "welcome",
    ...(webImports ? ["bookmarks" as const] : []),
    ...(route === "bookmarks" ? ["preview" as const] : ["project" as const, "documents" as const, ...(webImports ? ["webpage" as const] : [])]),
    "finale",
  ], [route, webImports]);
  const index = path.indexOf(step);

  const go = useCallback((to: StepId) => {
    setStep(to);
    setFarthest((current) => Math.max(current, path.indexOf(to)));
  }, [path]);

  // ---------------------------------------------------------------- bookmarks

  const readBookmarks = useCallback(async (picked: File[]) => {
    setBookmarkError("");
    // The picker offers one file, but a drop can carry several; taking the
    // first and ignoring the rest would import a library the reader did not choose.
    if (picked.length > 1) {
      setBookmarkError("Drop one bookmarks export at a time.");
      return;
    }
    const file = picked[0];
    if (!file || !/\.html?$/i.test(file.name) && file.type !== "text/html") {
      setBookmarkError("That is not a bookmarks export. Chrome saves it as an .html file.");
      return;
    }
    // Read here and dropped: the export itself is never sent anywhere.
    const folders = parseBookmarks(await file.text(), config.maxPapersPerProject);
    if (!folders.length) {
      setBookmarkError("No documents were found in that file.");
      return;
    }
    setDrafts(folders.map((folder) => ({
      key: nextKey(),
      name: folder.name,
      documents: folder.links.map((link) => ({ key: nextKey(), ...link, status: "pending" })),
    })));
    setRoute("bookmarks");
    setImporting("idle");
    setFarthest(path.indexOf("bookmarks"));
    setStep("preview");
  }, [config.maxPapersPerProject, path]);

  const skipBookmarks = useCallback(() => {
    setRoute("manual");
    setFarthest(path.indexOf("bookmarks"));
    setStep("project");
  }, [path]);

  const updateProject = (key: string, patch: Partial<DraftProject>) =>
    setDrafts((current) => current.map((project) => project.key === key ? { ...project, ...patch } : project));
  const updateDocument = (projectKey: string, documentKey: string, patch: Partial<DraftDocument>) =>
    setDrafts((current) => current.map((project) => project.key !== projectKey ? project : {
      ...project,
      documents: project.documents.map((document) => document.key === documentKey ? { ...document, ...patch } : document),
    }));

  const importable = drafts.filter((project) => project.name.trim() && project.documents.length);
  const pageCount = importable.reduce((sum, project) => sum + project.documents.length, 0);

  const runImport = useCallback(async () => {
    if (!importable.length || importing === "running") return;
    setImporting("running");
    setCommitted(true);
    const jobs: { projectKey: string; projectId: string; document: DraftDocument }[] = [];
    let projects = 0;
    for (const draft of importable) {
      try {
        const created = await api<Project>("/api/projects", {
          method: "POST",
          body: JSON.stringify({ name: draft.name.trim().slice(0, PROJECT_NAME_MAX), onboarding: true }),
        });
        projects += 1;
        jobs.push(...draft.documents.map((document) => ({ projectKey: draft.key, projectId: created.id, document })));
      } catch (reason) {
        const error = message(reason, "This project could not be created.");
        updateProject(draft.key, { error });
        for (const document of draft.documents) updateDocument(draft.key, document.key, { status: "failed", error });
      }
    }

    const pdfs: { projectId: string; paperId: string }[] = [];
    const landed = new Set<DraftDocument>();
    /** Each document's latest failure, for a summary when nothing landed. */
    const failures = new Map<DraftDocument, string>();
    const attempt = async ({ projectKey, projectId, document }: (typeof jobs)[number]) => {
      updateDocument(projectKey, document.key, { status: "adding", error: undefined });
      try {
        const paper = await addPage(projectId, document.url);
        const title = document.title.trim().slice(0, DOCUMENT_TITLE_MAX);
        // The preview is what the reader agreed to, so its title wins over
        // whatever the page calls itself.
        if (title && paper.title !== title) {
          await api(`/api/projects/${projectId}/papers/${paper.id}`, {
            method: "PATCH", body: JSON.stringify({ title }),
          }).catch(() => undefined);
        }
        if (!isWebPaper(paper)) pdfs.push({ projectId, paperId: paper.id });
        landed.add(document);
        updateDocument(projectKey, document.key, { status: "done" });
      } catch (reason) {
        const error = message(reason, "Could not be added");
        failures.set(document, error);
        updateDocument(projectKey, document.key, { status: "failed", error });
      }
    };
    // One page at a time, as the Reader adds them. The server captures every
    // page through a single browser slot, so parallel imports only queued on
    // it, and arXiv timed out on two of three PDFs requested together that
    // each fetch in a second on their own.
    for (const job of jobs) await attempt(job);
    // One more try each for whatever failed; transient failures are common.
    for (const job of jobs) if (!landed.has(job.document)) await attempt(job);

    // A folder none of whose pages could be added is not kept as an empty
    // project the reader then has to find and delete.
    for (const draft of importable) {
      const own = jobs.filter((job) => job.projectKey === draft.key);
      if (!own.length || own.some((job) => landed.has(job.document))) continue;
      await api(`/api/projects/${own[0].projectId}`, { method: "DELETE" }).catch(() => undefined);
      projects -= 1;
      updateProject(draft.key, { error: "None of these documents could be added, so this project was not kept." });
    }
    const documents = landed.size;
    if (!projects) {
      // Named by the most common reason: a file of dead links reads as one
      // failure, not a list of them.
      const counts = new Map<string, number>();
      for (const error of failures.values()) counts.set(error, (counts.get(error) ?? 0) + 1);
      const reason = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "nothing could be added";
      setImportFailure(reason.replace(/\.$/, ""));
    }

    setAdded({ projects, documents });
    setImporting("done");
    if (documents) requestMemoryMaintenance(config.memoryEnabled);
    void runPool(pdfs, 2, digest);
    // Nothing to report: move on by itself, after a beat to see the checks land.
    if (projects && documents === jobs.length && projects === importable.length) {
      window.setTimeout(() => go("finale"), 900);
    }
  }, [importable, importing, config.memoryEnabled, go]);

  // ---------------------------------------------------------------- manual

  // Worked out from the list as it stands, not inside a state updater: the
  // updater runs later, so notes gathered in it were read while still empty
  // and a dropped .docx was turned away without a word.
  const pickFiles = useCallback((picked: File[]) => {
    const notes: string[] = [];
    const next = [...files];
    for (const file of picked) {
      if (!isPdfFile(file)) { notes.push(`${file.name} is not a PDF.`); continue; }
      if (file.size > config.maxUploadSourceMb * 1024 * 1024) {
        notes.push(`${file.name} is ${megabytes(file.size)}, too large to add.`);
        continue;
      }
      if (next.some((item) => item.file.name === file.name && item.file.size === file.size)) continue;
      if (next.length >= ONBOARDING_MAX_FILES) {
        notes.push(`Start with ${ONBOARDING_MAX_FILES} — add the rest from the reader.`);
        break;
      }
      next.push({ key: nextKey(), file, status: "pending" });
    }
    setFiles(next);
    setFileNote(notes.join(" "));
  }, [config.maxUploadSourceMb, files]);

  /** The manual route's project, once made, so a retry adds to it rather than making another. */
  const manualProject = useRef<Project | null>(null);
  const ensureManualProject = useCallback(async (): Promise<Project> => {
    if (manualProject.current) return manualProject.current;
    const created = await api<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: projectName.trim().slice(0, PROJECT_NAME_MAX), onboarding: true }),
    });
    manualProject.current = created;
    setCommitted(true);
    return created;
  }, [projectName]);

  const runUpload = useCallback(async () => {
    const name = projectName.trim().slice(0, PROJECT_NAME_MAX);
    if (!name || !files.length || uploading === "running") return;
    setUploading("running");
    setUploadError("");
    let project: Project;
    try {
      project = await ensureManualProject();
    } catch (reason) {
      setUploadError(message(reason, "Your project could not be created. Try again."));
      setUploading("idle");
      return;
    }
    const setStatus = (key: string, status: Status, error?: string) =>
      setFiles((current) => current.map((item) => item.key === key ? { ...item, status, error } : item));
    const pdfs: { projectId: string; paperId: string }[] = [];
    let documents = 0;
    await runPool(files, 2, async ({ key, file }) => {
      setStatus(key, "adding");
      try {
        const form = new FormData();
        form.append("file", file);
        const paper = await keep(project.id, await api<UploadResult>(`/api/projects/${project.id}/papers`, {
          method: "POST", body: form,
        }));
        pdfs.push({ projectId: project.id, paperId: paper.id });
        documents += 1;
        setStatus(key, "done");
      } catch (reason) {
        setStatus(key, "failed", message(reason, "Upload failed"));
      }
    });
    // At least one document is the price of moving on: if none landed, it is
    // back to the drop zone, not on to an empty project.
    if (!documents) {
      setFiles([]);
      setUploadError("None of those PDFs could be added. Try different files.");
      setUploading("idle");
      return;
    }
    setAdded({ projects: 1, documents });
    setUploading("done");
    requestMemoryMaintenance(config.memoryEnabled);
    void runPool(pdfs, 2, digest);
    if (documents === files.length) window.setTimeout(() => go(webImports ? "webpage" : "finale"), 900);
  }, [config.memoryEnabled, ensureManualProject, files, go, projectName, uploading, webImports]);

  /** The webpage step: one address, added to the same project. */
  const runWebpage = useCallback(async () => {
    const typed = pageUrl.trim();
    if (!typed || addingPage) return;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
    if (!isImportableUrl(url)) {
      setPageError("That does not look like a web address.");
      return;
    }
    setAddingPage(true);
    setPageError("");
    try {
      const project = await ensureManualProject();
      const paper = await addPage(project.id, url);
      if (!isWebPaper(paper)) void digest({ projectId: project.id, paperId: paper.id });
      setAdded((current) => ({ projects: 1, documents: current.documents + 1 }));
      requestMemoryMaintenance(config.memoryEnabled);
      go("finale");
    } catch (reason) {
      setPageError(message(reason, "That webpage could not be added."));
    } finally {
      setAddingPage(false);
    }
  }, [addingPage, config.memoryEnabled, ensureManualProject, go, pageUrl]);

  /** Every bookmark failed: carry on as if the import had been skipped. */
  const continueManually = useCallback(() => {
    setDrafts([]);
    setImportFailure("");
    setRoute("manual");
    setFarthest(webImports ? 2 : 1);
    setStep("project");
  }, [webImports]);

  // ---------------------------------------------------------------- finish

  // The last screen waits until a document has completed — uploaded and, with
  // Memory on, filed — because that is what a later visit decides by: an
  // attempt with nothing completed is cleaned up and started over. Filing runs
  // in the background pump; this only asks how far it has got.
  useEffect(() => {
    if (step !== "finale") return;
    let live = true;
    let timer = 0;
    const poll = async () => {
      // Nudge the pump on every check, not once: a filing that failed is
      // retried a minute later, and the pump's own schedule is five.
      requestMemoryMaintenance(config.memoryEnabled);
      try {
        const next = await api<Readiness>("/api/onboarding");
        if (!live) return;
        setReadiness(next);
        if (isReady(next)) return;
      } catch {
        // Asked again on the next beat.
      }
      if (live) timer = window.setTimeout(poll, 5000);
    };
    void poll();
    return () => { live = false; window.clearTimeout(timer); };
  }, [step, pollNonce, config.memoryEnabled]);

  // The wait is the digest and the filing, a minute or two; saying which step
  // it is on makes that read as progress rather than a stall. A new account's
  // only jobs are this attempt's documents, so the newest stage is theirs.
  useEffect(() => {
    if (step !== "finale") return;
    const read = () => setFilingStage([...memoryStages().values()].at(-1) ?? "");
    read();
    return onMemoryStage(read);
  }, [step]);

  const finish = useCallback(async () => {
    if (finishing || (!ready && !filingFailed)) return;
    setFinishing(true);
    setFinishError("");
    try {
      if (filingFailed) {
        // Resolve performs the same scoped cleanup as returning after an interruption.
        // It rechecks under the filing lock, so a late successful commit is kept.
        await api("/api/onboarding/resolve", { method: "POST" });
        window.location.reload();
        return;
      }
      const { complete } = await api<{ complete: boolean }>("/api/onboarding/finish", { method: "POST" });
      if (complete) await onFinish();
      else { setReadiness(null); setPollNonce((n) => n + 1); }
    } catch (reason) {
      setFinishError(message(reason, "Could not finish onboarding. Try again."));
    } finally {
      setFinishing(false);
    }
  }, [finishing, onFinish, ready, filingFailed]);

  /** What Enter does on each screen, when it is allowed to do anything. */
  const primary: Partial<Record<StepId, () => void>> = {
    welcome: () => go(path[1]),
    bookmarks: skipBookmarks,
    preview: () => {
      if (importing === "idle") void runImport();
      else if (importing === "done") {
        if (added.projects) go("finale");
        else continueManually();
      }
    },
    project: () => { if (projectName.trim()) go("documents"); },
    documents: () => {
      if (uploading === "idle" && files.length) void runUpload();
      else if ((uploading === "idle" && webImports) || uploading === "done") go(webImports ? "webpage" : "finale");
    },
    webpage: () => {
      if (pageUrl.trim()) void runWebpage();
      else if (added.documents) go("finale");
    },
    finale: () => void finish(),
  };
  useEnterAdvances(primary, step);
  useSwallowStrayDrops();
  const stage = useRef<HTMLDivElement>(null);
  useFocusFollowsStep(stage, step);

  // Creating the manual project commits its name, not the choice of document
  // format. A failed first webpage can still be replaced by a PDF in that same
  // project. Keep navigation locked while an import is in flight.
  const importingDocument = addingPage || uploading === "running" || importing === "running";
  const back = importingDocument ? null
    : route === "manual" && step === "webpage" && !added.documents ? "documents"
    : index > 0 && !committed ? path[index - 1] : null;
  const forward = index < farthest && !committed && !importingDocument ? path[index + 1] : null;
  const progress = path.length > 1 ? index / (path.length - 1) : 1;

  const numberOf = (id: StepId) => path.indexOf(id);
  const stateOf = (id: StepId): "past" | "current" | "future" => {
    const at = path.indexOf(id);
    return at < index ? "past" : at > index ? "future" : "current";
  };
  return (
    <div className="onboarding" ref={stage}>
      <div className="onboarding-progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>

      <Step id="welcome" state={stateOf("welcome")} centered>
        <OnboardingFan />
        <h1 className="onboarding-title">Welcome to Delphi</h1>
        <p className="onboarding-lede">
          An agentic reader for <span className="onboarding-dotted">webpages</span> and{" "}
          <span className="onboarding-dotted">PDFs</span>, with a Memory that grows as you
          read — so every conversation starts from what you already know.
        </p>
        <Actions label="Get started" onClick={() => go(path[1])} />
      </Step>

      {webImports ? <Step id="bookmarks" state={stateOf("bookmarks")}>
        <Question
          number={numberOf("bookmarks")}
          title="Import your bookmarks"
          help="Delphi turns Chrome bookmark folders into projects. Skip to set one up by hand."
        />
        <DropZone
          accept=".html,.htm,text/html"
          title="Drop your bookmarks export here"
          detail={<span className="onboarding-crumbs">
            <span>Chrome</span><Crumb /><span>Bookmark Manager</span><Crumb /><span>Export bookmarks</span>
          </span>}
          onFiles={(picked) => void readBookmarks(picked)}
        />
        {bookmarkError ? <p className="onboarding-error" role="alert">{bookmarkError}</p> : null}
        <div className="onboarding-actions">
          <button type="button" className="onboarding-skip" onClick={skipBookmarks}>Skip</button>
          <span className="onboarding-enter" aria-hidden="true">press <b>Enter ↵</b></span>
        </div>
      </Step> : null}

      {route === "bookmarks" ? <Step id="preview" state={stateOf("preview")}>
        <Question
          number={numberOf("preview")}
          title={importing === "done" && added.projects ? "Your library is ready" : "Here is what we found"}
          help={importing === "idle"
            ? `Each folder becomes a project of up to ${config.maxPapersPerProject} documents. Edit or remove anything below!`
            : undefined}
        />
        <div
          ref={list}
          className={`onboarding-projects${moreBelow ? " has-more" : ""}`}
          aria-live="polite"
          onScroll={measureList}
        >
          {drafts.map((project) => <article key={project.key} className="onboarding-project">
            <header>
              <input
                className="onboarding-inline onboarding-project-name"
                value={project.name}
                maxLength={PROJECT_NAME_MAX}
                disabled={importing !== "idle"}
                aria-label="Project name"
                onChange={(event) => updateProject(project.key, { name: event.target.value })}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              />
              <small>
                {project.documents.length} {project.documents.length === 1 ? "document" : "documents"}
              </small>
              {importing === "idle" ? <button
                type="button" className="onboarding-remove" aria-label={`Remove ${project.name || "project"}`}
                onClick={() => setDrafts((current) => current.filter((item) => item.key !== project.key))}
              ><CloseIcon /></button> : null}
            </header>
            {project.error ? <p className="onboarding-error">{project.error}</p> : null}
            <ol>
              {project.documents.map((document) => <li key={document.key}>
                {importing === "idle" ? <span className="onboarding-bullet" aria-hidden="true" />
                  : <StatusMark status={document.status} error={document.error} />}
                <input
                  className="onboarding-inline"
                  value={document.title}
                  maxLength={DOCUMENT_TITLE_MAX}
                  disabled={importing !== "idle"}
                  aria-label="Document title"
                  onChange={(event) => updateDocument(project.key, document.key, { title: event.target.value })}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                />
                <small title={document.url}>{hostOf(document.url)}</small>
                {importing === "idle" ? <button
                  type="button" className="onboarding-remove" aria-label={`Remove ${document.title}`}
                  onClick={() => updateProject(project.key, {
                    documents: project.documents.filter((item) => item.key !== document.key),
                  })}
                ><CloseIcon /></button> : null}
              </li>)}
            </ol>
          </article>)}
        </div>
        {importing === "done" && !added.projects ? <p className="onboarding-error" role="status">
          Bookmark imports failed: {importFailure}. You can still create a new project manually.
        </p> : importing === "done" && added.documents < pageCount ? <p className="onboarding-error" role="status">
          {pageCount - added.documents} of {pageCount} documents could not be added. Hover a mark to see why; you can add them later from the reader.
        </p> : null}
        {importing === "done" ? <Actions label="Continue" onClick={() => added.projects ? go("finale") : continueManually()} />
          : <Actions
            label={importable.length
              ? `Import ${importable.length} ${importable.length === 1 ? "project" : "projects"} · ${pageCount} ${pageCount === 1 ? "document" : "documents"}`
              : "Nothing to import"}
            disabled={!importable.length}
            busy={importing === "running"}
            onClick={() => void runImport()}
          />}
      </Step> : null}

      {route === "manual" ? <Step id="project" state={stateOf("project")}>
        <Question number={numberOf("project")} title="Create a project" help="A project holds the documents you want to read and discuss together." />
        <form onSubmit={(event) => { event.preventDefault(); if (projectName.trim()) go("documents"); }}>
          <input
            className="onboarding-input"
            value={projectName}
            maxLength={PROJECT_NAME_MAX}
            placeholder="What do you want to read about?"
            aria-label="Project name"
            data-autofocus
            onChange={(event) => setProjectName(event.target.value)}
          />
        </form>
        <Actions confirm disabled={!projectName.trim()} onClick={() => go("documents")} />
      </Step> : null}

      {route === "manual" ? <Step id="documents" state={stateOf("documents")}>
        <Question
          number={numberOf("documents")}
          title="Add your first documents"
          help={<>Start with up to {ONBOARDING_MAX_FILES} PDFs for <b>{projectName.trim() || "your project"}</b>. You can add more later.</>}
        />
        {uploading === "idle" && files.length < ONBOARDING_MAX_FILES ? <DropZone
          accept="application/pdf,.pdf"
          multiple
          row
          title="Drop PDFs here"
          detail={files.length ? `${ONBOARDING_MAX_FILES - files.length} more can be added` : `Up to ${ONBOARDING_MAX_FILES} can be added`}
          onFiles={pickFiles}
        /> : null}
        {files.length ? <ul className="onboarding-files">
          {files.map((item) => <li key={item.key} className="onboarding-item">
            <KindMark kind="pdf" />
            <span className="onboarding-file">
              <span className="onboarding-file-name">{item.file.name}</span>
              <small>{megabytes(item.file.size)}</small>
            </span>
            {uploading === "idle" ? <button
              type="button" className="onboarding-remove" aria-label={`Remove ${item.file.name}`}
              onClick={() => setFiles((current) => current.filter((file) => file.key !== item.key))}
            ><CloseIcon /></button> : <StatusMark status={item.status} error={item.error} />}
          </li>)}
        </ul> : null}
        {fileNote ? <p className="onboarding-note">{fileNote}</p> : null}
        {uploadError ? <p className="onboarding-error" role="alert">{uploadError}</p> : null}
        {uploading === "done" && added.documents < files.length ? <p className="onboarding-error" role="status">
          {files.length - added.documents} of {files.length} could not be added. You can try again from the reader.
        </p> : null}
        {uploading === "done" ? <Actions label="Continue" onClick={() => go(webImports ? "webpage" : "finale")} />
          : <Actions
            label={files.length ? `Add ${files.length} ${files.length === 1 ? "PDF" : "PDFs"}` : webImports ? "Skip" : "Add PDFs"}
            confirm={files.length > 0}
            disabled={!files.length && !webImports}
            busy={uploading === "running"}
            onClick={() => files.length ? void runUpload() : go(webImports ? "webpage" : "finale")}
          />}
      </Step> : null}

      {route === "manual" && webImports ? <Step id="webpage" state={stateOf("webpage")}>
        <Question
          number={numberOf("webpage")}
          title="Add a webpage"
          help={<>Paste the address of a webpage to read in <b>{projectName.trim() || "your project"}</b>.</>}
        />
        <form onSubmit={(event) => {
          event.preventDefault();
          if (pageUrl.trim()) void runWebpage();
          else if (added.documents) go("finale");
        }}>
          <input
            className="onboarding-input"
            value={pageUrl}
            inputMode="url"
            autoComplete="url"
            placeholder="https://"
            aria-label="Webpage address"
            data-autofocus
            disabled={addingPage}
            onChange={(event) => { setPageUrl(event.target.value); setPageError(""); }}
          />
        </form>
        {pageError ? <p className="onboarding-error" role="alert">{pageError}</p> : null}
        {/* A webpage is optional once PDFs are in, and the only document otherwise. */}
        <Actions
          label={pageUrl.trim() || !added.documents ? "Add webpage" : "Skip"}
          disabled={!pageUrl.trim() && !added.documents}
          busy={addingPage}
          onClick={() => pageUrl.trim() ? void runWebpage() : go("finale")}
        />
      </Step> : null}

      <Step id="finale" state={stateOf("finale")} centered>
        <h1 className="onboarding-title onboarding-mission">Never outsource<br />your understanding</h1>
        {ready ? null : filingFailed ? <p className="onboarding-filing" role="status">
          Your documents could not be filed. Start again to discard this attempt and add a new document.
        </p> : <p className="onboarding-filing" role="status">
          <Spinner />
          Filing your first document into your Memory…
        </p>}
        {!ready && !filingFailed && filingStage ? <p className="onboarding-stage" aria-live="polite">{filingStage}</p> : null}
        {finishError ? <p className="onboarding-error" role="alert">{finishError}</p> : null}
        <Actions label={filingFailed ? "Start again" : "Enter Delphi"} disabled={!ready && !filingFailed} busy={finishing} onClick={() => void finish()} />
      </Step>

      {/* The mark alone: the name is already the welcome's title. */}
      <div className="onboarding-brand" aria-hidden="true">
        <OnboardingMark size={36} />
      </div>
      <nav className="onboarding-nav" aria-label="Onboarding steps">
        <button type="button" disabled={!back} aria-label="Previous question" onClick={() => back && setStep(back)}><Chevron up /></button>
        <button type="button" disabled={!forward} aria-label="Next question" onClick={() => forward && setStep(forward)}><Chevron /></button>
      </nav>
    </div>
  );
}
