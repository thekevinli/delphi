"use client";

/**
 * Filling a new project, one question at a time.
 *
 * The first run's screens, reused for the moment after a project is made: an
 * empty project used to land on a placeholder in the reader that said "add the
 * first paper" and offered one button. This asks instead, in the onboarding's
 * own grammar — the dusk ground, one question per screen, Enter to move on —
 * for every webpage and every PDF the reader means to start with, then shows
 * the lot as one list to trim before anything is sent.
 *
 * Nothing leaves this component until the last screen. Webpages are addresses
 * and PDFs are `File`s held here, so a page removed from the list was never
 * fetched and a PDF removed from it was never uploaded: there is nothing to
 * clean up on the server. Filing into Memory is asked for once, after the
 * whole batch has landed, rather than once per document.
 */

import { useCallback, useMemo, useRef, useState } from "react";

import { api, isWebPaper, type AppConfig, type Paper, type Project, type UploadResult } from "../lib/api";
import { isImportableUrl, runPool } from "../lib/bookmarks";
import { carriesFiles, isPdfFile } from "../lib/file-drag";
import { useFileDrop } from "../lib/use-file-drop";
import { requestMemoryMaintenance } from "../lib/memory-maintenance";
import {
  Actions, Chevron, CloseIcon, DropZone, KindMark, OnboardingMark, Question, StatusMark, Step,
  addPage, digest, hostOf, keep, megabytes, message, nextKey,
  useEnterAdvances, useFocusFollowsStep, useSwallowStrayDrops,
  type Status,
} from "./Onboarding";

type SetupStep = "webpages" | "pdfs" | "filing";

type PendingPage = { key: string; kind: "web"; url: string; status: Status; error?: string };
type PendingFile = { key: string; kind: "pdf"; file: File; status: Status; error?: string };
type Pending = PendingPage | PendingFile;

/** An address as the reader would say it: host, then the path without its scheme. */
function shortUrl(url: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}

/** One row of the list: the kind's mark on a tile, a name, a detail, then remove or progress. */
function PendingRow({ item, locked, onRemove }: { item: Pending; locked: boolean; onRemove: () => void }) {
  const name = item.kind === "web" ? hostOf(item.url) : item.file.name;
  const detail = item.kind === "web" ? shortUrl(item.url) : megabytes(item.file.size);
  return <li className="onboarding-item">
    <KindMark kind={item.kind} />
    <span className="onboarding-file">
      <span className="onboarding-file-name">{name}</span>
      <small title={item.kind === "web" ? item.url : undefined}>{detail}</small>
    </span>
    {locked ? <StatusMark status={item.status} error={item.error} />
      : <button type="button" className="onboarding-remove" aria-label={`Remove ${name}`} onClick={onRemove}><CloseIcon /></button>}
  </li>;
}

export function ProjectSetup({ project, config, initialFiles = [], initialUrls = [], onClose, onDone }: {
  project: Project;
  config: AppConfig;
  /** A PDF dropped before the project existed, carried into the PDF screen. */
  initialFiles?: File[];
  /** A webpage asked for before the project existed, carried into the first screen. */
  initialUrls?: string[];
  /** Leave without adding anything. */
  onClose: () => void;
  /** Everything that could be added has been; open the first of it. */
  onDone: (first: Paper | null) => void;
}) {
  const webImports = config.webDocumentsEnabled;
  const path = useMemo<SetupStep[]>(() => [...(webImports ? ["webpages" as const] : []), "pdfs", "filing"], [webImports]);
  const [step, setStep] = useState<SetupStep>(path[0]);
  const index = path.indexOf(step);
  const numberOf = (id: SetupStep) => path.indexOf(id) + 1;
  const stateOf = (id: SetupStep): "past" | "current" | "future" => {
    const at = path.indexOf(id);
    return at < index ? "past" : at > index ? "future" : "current";
  };

  const [pages, setPages] = useState<PendingPage[]>(() =>
    initialUrls.map((url) => ({ key: nextKey(), kind: "web", url, status: "pending" })));
  const [files, setFiles] = useState<PendingFile[]>(() =>
    initialFiles.filter(isPdfFile).map((file) => ({ key: nextKey(), kind: "pdf", file, status: "pending" })));
  const [typed, setTyped] = useState("");
  const [urlError, setUrlError] = useState("");
  const [fileNote, setFileNote] = useState("");
  const [filing, setFiling] = useState<"idle" | "running" | "done">("idle");
  const [first, setFirst] = useState<Paper | null>(null);

  /** The largest PDF worth sending: above the upload limit it is compressed first. */
  const uploadLimitMb = config.maxUploadSourceMb || config.maxUploadMb;
  /** Documents already in the project count against its limit too. */
  const room = config.maxPapersPerProject - project.papers.filter((paper) => !paper.doneAt).length;
  const items: Pending[] = useMemo(() => [...pages, ...files], [pages, files]);
  const over = Math.max(0, items.length - room);
  const landed = items.filter((item) => item.status === "done").length;

  // ------------------------------------------------------------ webpages

  const addTyped = useCallback(() => {
    const text = typed.trim();
    if (!text) return false;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
    if (!isImportableUrl(url)) {
      setUrlError("That does not look like a web address.");
      return true;
    }
    setUrlError("");
    setTyped("");
    setPages((current) => current.some((page) => page.url === url) ? current
      : [{ key: nextKey(), kind: "web", url, status: "pending" }, ...current]);
    return true;
  }, [typed]);

  // ------------------------------------------------------------ PDFs

  // Worked out from the list as it stands, not inside a state updater: the
  // updater runs later, so notes gathered in it were read while still empty.
  const pickFiles = useCallback((picked: File[]) => {
    const notes: string[] = [];
    const next = [...files];
    for (const file of picked) {
      if (!isPdfFile(file)) { notes.push(`${file.name} is not a PDF.`); continue; }
      if (file.size > uploadLimitMb * 1024 * 1024) {
        notes.push(`${file.name} is ${megabytes(file.size)}, too large to add.`);
        continue;
      }
      if (next.some((item) => item.file.name === file.name && item.file.size === file.size)) continue;
      next.push({ key: nextKey(), kind: "pdf", file, status: "pending" });
    }
    setFiles(next);
    setFileNote(notes.join(" "));
  }, [files, uploadLimitMb]);

  // ------------------------------------------------------------ filing

  const setStatus = (key: string, status: Status, error?: string) => {
    setPages((current) => current.map((item) => item.key === key ? { ...item, status, error } : item));
    setFiles((current) => current.map((item) => item.key === key ? { ...item, status, error } : item));
  };

  const runFiling = useCallback(async () => {
    if (filing !== "idle" || !items.length || over) return;
    setFiling("running");
    const added: Paper[] = [];
    const pdfs: { projectId: string; paperId: string }[] = [];
    // Pages one at a time: the server captures each through a single browser
    // slot, so asking for several at once only queues them and times them out.
    for (const page of pages) {
      setStatus(page.key, "adding");
      try {
        const paper = await addPage(project.id, page.url);
        if (!isWebPaper(paper)) pdfs.push({ projectId: project.id, paperId: paper.id });
        added.push(paper);
        setStatus(page.key, "done");
      } catch (reason) {
        setStatus(page.key, "failed", message(reason, "Could not be added"));
      }
    }
    await runPool(files, 2, async ({ key, file }) => {
      setStatus(key, "adding");
      try {
        const form = new FormData();
        form.append("file", file);
        const paper = await keep(project.id, await api<UploadResult>(`/api/projects/${project.id}/papers`, {
          method: "POST", body: form,
        }));
        pdfs.push({ projectId: project.id, paperId: paper.id });
        added.push(paper);
        setStatus(key, "done");
      } catch (reason) {
        setStatus(key, "failed", message(reason, "Upload failed"));
      }
    });
    // Once, for the whole batch: filing is about how the documents relate,
    // so asking per document would only file the same neighbourhood again.
    if (added.length) requestMemoryMaintenance(config.memoryEnabled);
    void runPool(pdfs, 2, digest);
    setFirst(added[0] ?? null);
    // Filing itself runs on in the background queue, so there is nothing to
    // wait for here: with everything in, the reader goes straight to reading.
    // Only a document that could not be added keeps them on this screen.
    if (added.length === pages.length + files.length) {
      onDone(added[0] ?? null);
      return;
    }
    setFiling("done");
  }, [config.memoryEnabled, files, filing, items.length, onDone, over, pages, project.id]);

  const go = (to: SetupStep) => setStep(to);
  const next = () => { if (index < path.length - 1) go(path[index + 1]); };

  const primary: Partial<Record<SetupStep, () => void>> = {
    webpages: next,
    pdfs: next,
    filing: () => {
      if (filing === "idle") void runFiling();
      else if (filing === "done") onDone(first);
    },
  };
  useEnterAdvances(primary, step);
  useSwallowStrayDrops();
  // The whole screen takes a dropped file, not only the drop zone: a drag
  // that crossed the screen first reached the reader's own drop overlay
  // underneath, which added the PDF to the project directly — so it never
  // appeared in this list, and choosing it again made a duplicate. Claimed
  // here, the drag stops at this surface; a PDF dropped anywhere joins the
  // list, and one dropped on the first screen moves on to show it.
  const surfaceDrop = useFileDrop({
    claim: carriesFiles,
    onDrop: (dropped) => {
      if (filing !== "idle") return;
      pickFiles(dropped);
      if (step === "webpages") go("pdfs");
    },
  });
  const stage = useRef<HTMLDivElement>(null);
  useFocusFollowsStep(stage, step);

  const running = filing === "running";
  const back = running || filing === "done" || index === 0 ? null : path[index - 1];
  const forward = running || filing === "done" || index === path.length - 1 ? null : path[index + 1];
  const progress = path.length > 1 ? index / (path.length - 1) : 1;

  return (
    <div
      className="onboarding is-setup"
      ref={stage}
      role="dialog"
      aria-modal="true"
      aria-label={`Add documents to ${project.name}`}
      {...surfaceDrop.handlers}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !running) { event.preventDefault(); onClose(); }
      }}
    >
      <div className="onboarding-progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
      <button type="button" className="onboarding-close" aria-label="Close" title="Close" disabled={running} onClick={onClose}>
        <CloseIcon />
      </button>

      {webImports ? <Step id="webpages" state={stateOf("webpages")}>
        <Question
          number={numberOf("webpages")}
          title="Add any webpage"
          help="Paste an address and press Enter. Add as many as you like."
        />
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!addTyped()) next();
        }}>
          <input
            className="onboarding-input"
            value={typed}
            inputMode="url"
            autoComplete="url"
            placeholder="https://"
            aria-label="Webpage address"
            data-autofocus
            onChange={(event) => { setTyped(event.target.value); setUrlError(""); }}
          />
        </form>
        {urlError ? <p className="onboarding-error" role="alert">{urlError}</p> : null}
        {pages.length ? <ul className="onboarding-files" aria-live="polite">
          {pages.map((item) => <PendingRow
            key={item.key}
            item={item}
            locked={false}
            onRemove={() => setPages((current) => current.filter((page) => page.key !== item.key))}
          />)}
        </ul> : null}
        <Actions
          label={typed.trim() ? "Add" : pages.length ? "Continue" : "Skip"}
          confirm={Boolean(typed.trim()) || pages.length > 0}
          onClick={() => { if (!addTyped()) next(); }}
        />
      </Step> : null}

      <Step id="pdfs" state={stateOf("pdfs")}>
        <Question
          number={numberOf("pdfs")}
          title="Add any PDF"
          help="Drop as many as you like, or choose several at once."
        />
        <DropZone
          accept="application/pdf,.pdf"
          multiple
          row={files.length > 0}
          title={files.length ? "Drop more PDFs here" : "Drop PDFs here, or click to choose"}
          detail={<span className="onboarding-drop-detail">PDFs only{uploadLimitMb ? ` · up to ${uploadLimitMb} MB each` : ""}</span>}
          onFiles={pickFiles}
        />
        {fileNote ? <p className="onboarding-note">{fileNote}</p> : null}
        {files.length ? <ul className="onboarding-files" aria-live="polite">
          {files.map((item) => <PendingRow
            key={item.key}
            item={item}
            locked={false}
            onRemove={() => setFiles((current) => current.filter((file) => file.key !== item.key))}
          />)}
        </ul> : null}
        <Actions label={files.length ? "Continue" : "Skip"} confirm={files.length > 0} onClick={next} />
      </Step>

      <Step id="filing" state={stateOf("filing")}>
        <Question
          number={numberOf("filing")}
          title={filing === "done" ? `${landed} of ${items.length} added` : "Memory filing"}
          help={filing === "done"
            ? landed ? "These will be filed into your Memory in background." : "None of these could be added."
            : items.length
              ? "Everything below will be filed into your Memory in background."
              : <>Nothing to file yet. Go back to add a webpage or a PDF.</>}
        />
        {items.length ? <ul className="onboarding-files is-review" aria-live="polite">
          {items.map((item) => <PendingRow
            key={item.key}
            item={item}
            locked={filing !== "idle"}
            onRemove={() => item.kind === "web"
              ? setPages((current) => current.filter((page) => page.key !== item.key))
              : setFiles((current) => current.filter((file) => file.key !== item.key))}
          />)}
        </ul> : null}
        {filing === "idle" && over ? <p className="onboarding-error" role="alert">
          A project holds {config.maxPapersPerProject} documents{room < config.maxPapersPerProject ? ` and this one has room for ${room}` : ""}. Remove {over} to continue.
        </p> : null}
        {filing === "done" && landed < items.length ? <p className="onboarding-error" role="status">
          {items.length - landed} of {items.length} could not be added. Hover a mark to see why.
        </p> : null}
        {filing === "done"
          ? <Actions label={landed ? "Start reading" : "Close"} onClick={() => landed ? onDone(first) : onClose()} />
          : <Actions
            label={items.length ? "Start reading" : "Nothing to file"}
            confirm={items.length > 0 && !over}
            disabled={!items.length || over > 0}
            busy={running}
            onClick={() => void runFiling()}
          >
            {items.length ? <span className="onboarding-count" aria-label={`${items.length} of ${room} places`}>
              {items.length}/{room}
            </span> : null}
          </Actions>}
      </Step>

      <div className="onboarding-brand" aria-hidden="true">
        <OnboardingMark />
        {project.name}
      </div>
      <nav className="onboarding-nav" aria-label="Setup steps">
        <button type="button" disabled={!back} aria-label="Previous question" onClick={() => back && go(back)}><Chevron up /></button>
        <button type="button" disabled={!forward} aria-label="Next question" onClick={() => forward && go(forward)}><Chevron /></button>
      </nav>
    </div>
  );
}
