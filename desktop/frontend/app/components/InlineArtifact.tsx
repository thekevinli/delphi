"use client";

import { createContext, memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ExtraProps } from "react-markdown";
import { artifactDocument, artifactFence, artifactHeight, ARTIFACT_LANGUAGE, type ArtifactFence } from "../lib/inline-artifact";
import { artifactThemeValues } from "../lib/artifact-theme";
import { isDisplaySource, parseDisplay } from "../lib/display-spec";
import { DisplayBoundary, DisplayCard } from "./display/DisplayCard";
import { artifactControls, artifactBadge, artifactStep, type ArtifactControlAction, type ArtifactControls, type ArtifactStep } from "../lib/artifact-controls";

export const ArtifactMarkdown = createContext({ source: "", enabled: false, streaming: false });

function syncFrameTheme(frame: HTMLIFrameElement | null) {
  if (!frame) return;
  const root = document.documentElement;
  const requested = root.dataset.theme ?? document.body.dataset.theme;
  const scheme = getComputedStyle(root).colorScheme;
  const theme = requested === "light" || requested === "dark" ? requested
    : root.classList.contains("dark") || document.body.classList.contains("dark") ? "dark"
      : root.classList.contains("light") || document.body.classList.contains("light") ? "light"
        : scheme === "dark" || (scheme.includes("dark") && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  const host = frame.closest(".inline-artifact") ?? root;
  frame.contentWindow?.postMessage({ type: "delphi-artifact-theme", theme, values: artifactThemeValues(getComputedStyle(host)) }, "*");
}

/** An app-selected theme wins over the OS, without resetting a working control. */
function useFrameTheme(frame: RefObject<HTMLIFrameElement | null>) {
  useEffect(() => {
    const observer = new MutationObserver(() => syncFrameTheme(frame.current));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => syncFrameTheme(frame.current);
    media.addEventListener("change", changed);
    syncFrameTheme(frame.current);
    return () => { observer.disconnect(); media.removeEventListener("change", changed); };
  }, [frame]);
}

function frameLoaded(frame: HTMLIFrameElement | null) {
  syncFrameTheme(frame);
  frame?.contentWindow?.postMessage({ type: "delphi-artifact-measure" }, "*");
  frame?.contentWindow?.postMessage({ type: "delphi-artifact-controls-request" }, "*");
}

/** A stable pre renderer shared by both chat scopes; ordinary code is untouched. */
export function ArtifactPre({ node, children, ...props }: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const context = useContext(ArtifactMarkdown);
  const code = node?.children[0];
  const classes = code?.type === "element" ? code.properties.className : undefined;
  const isArtifact = Array.isArray(classes) && classes.includes(`language-${ARTIFACT_LANGUAGE}`);
  if (!context.enabled || !isArtifact || code?.type !== "element") return <pre {...props}>{children}</pre>;
  const source = code.children.filter(child => child.type === "text").map(child => child.value).join("").replace(/\n$/, "");
  const fence = artifactFence(context.source, node?.position?.start.offset, node?.position?.end.offset, source);
  if (!fence) return <pre {...props}>{children}</pre>;
  return <InlineArtifact title={fence.title} source={fence.source} problem={fence.problem} streaming={fence.problem === "incomplete" && context.streaming} />;
}

// The offline validator mounts this same card; it must not recreate its host
// controls, theme channel or sandbox in a second renderer.
export const InlineArtifact = memo(function InlineArtifact({ title, source, problem, streaming }: Pick<ArtifactFence, "title" | "source" | "problem"> & { streaming: boolean }) {
  if (!problem && isDisplaySource(source)) return <LibraryDisplay key={source} title={title} source={source} />;
  if (!problem) return <InteractiveArtifact key={source} title={title} source={source} />;
  return <ProblemArtifact title={title} source={source} problem={problem} streaming={streaming} />;
});

/** A display from Delphi's library: data drawn by the reader, never a document it runs. */
function LibraryDisplay({ title, source }: { title: string; source: string }) {
  const spec = useMemo(() => parseDisplay(source), [source]);
  const unreadable = <ProblemArtifact title={title} source={source} problem="unreadable" streaming={false} />;
  return spec ? <DisplayBoundary fallback={unreadable}><DisplayCard spec={spec} /></DisplayBoundary> : unreadable;
}

/** Sends a follow-up for a card that can be mended by asking; absent while an answer streams. */
export const ArtifactAsk = createContext<((prompt: string) => void) | null>(null);

const GLYPH = <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="4" rx="1" /><rect x="9" y="10" width="5" height="4" rx="1" /><path d="M4.5 6v3.5a1 1 0 0 0 1 1H9" /></svg>;
const CHEVRON = { back: <path d="M10 3.5 5.5 8l4.5 4.5" />, next: <path d="M6 3.5 10.5 8 6 12.5" /> };
function CardTitle({ title, step, docked }: { title: string; step?: ArtifactStep | null; docked?: boolean }) {
  // Docked, the header names where the reader is; the card's title stays beside it.
  if (docked && step?.name) return <span className="inline-artifact-title" title={`${step.name} · ${title}`}>{step.current} · {step.name}<small>{title}</small></span>;
  return <span className="inline-artifact-title" title={step?.name ? `${title} · ${step.name}` : title}>{title}{step?.name ? <small>{step.name}</small> : null}</span>;
}

/** One card frame for every state that is not a running diagram: one line, one action. */
function ProblemArtifact({ title, source, problem, streaming }: { title: string; source: string; problem: NonNullable<ArtifactFence["problem"]> | "unreadable"; streaming: boolean }) {
  const ask = useContext(ArtifactAsk);
  const drawn = problem === "incomplete" && !isDisplaySource(source) && /<(?:svg|div|section|figure|canvas|table|p|h[1-6]|button|label)\b/i.test(source);
  const [line, action, prompt] = problem === "incomplete"
    ? ["The diagram stopped before it finished.", "Finish it", `Please finish the diagram “${title}”; it stopped before it was complete.`]
    : problem === "unreadable" ? ["This diagram could not be read.", "Draw it again", `The diagram “${title}” could not be read. Please draw it again.`]
    : problem === "too-large" ? ["This diagram is too large to show.", "Ask for a smaller one", `The diagram “${title}” was too large to show. Please draw a smaller version.`]
      : ["This diagram came back empty.", "Draw it again", `The diagram “${title}” came back empty. Please draw it again.`];
  return <figure className="inline-artifact" data-artifact-state={streaming ? "loading" : "error"}>
    <figcaption className="inline-artifact-caption">
      <span className="inline-artifact-glyph" aria-hidden="true">{GLYPH}</span>
      <CardTitle title={title} />
    </figcaption>
    {drawn ? <ArtifactPreview title={title} source={source} streaming={streaming} />
      : streaming ? <div className="inline-artifact-sketch" aria-hidden="true"><i /><b /><i /><b /><i /><i /><span /></div> : null}
    {streaming ? <div className="inline-artifact-status" role="status">Drawing<span className="inline-artifact-dots" aria-hidden="true"><i /><i /><i /></span></div>
      : <div className="inline-artifact-status" role="status">
        <span className={`inline-artifact-tile${problem === "incomplete" ? " is-unfinished" : ""}`} aria-hidden="true">{problem === "incomplete" ? "!" : "i"}</span>
        <span className="inline-artifact-line">{line}</span>
        {ask ? <button type="button" onClick={() => ask(prompt)}>{action}</button> : null}
      </div>}
  </figure>;
}

/**
 * Show a diagram taking shape, but never execute a partially written program.
 * A fresh nonce admits only our sizing script. The model cannot learn it from
 * its output, and inline handlers and scripts have no usable nonce.
 */
function ArtifactPreview({ title, source, streaming }: { title: string; source: string; streaming: boolean }) {
  const id = `delphi-artifact-preview-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(source);
  useEffect(() => { latest.current = source; }, [source]);
  const [shown, setShown] = useState(source);
  const [height, setHeight] = useState(160);
  const [nonce] = useState(() => crypto.randomUUID().replaceAll("-", ""));
  const previewSource = streaming ? shown : source;
  const document = useMemo(() => artifactDocument(previewSource, title, { previewNonce: nonce }), [previewSource, title, nonce]);
  useFrameTheme(frame);
  useEffect(() => {
    // Throttle, rather than debounce: a continuous token stream still paints.
    const timer = streaming ? setInterval(() => setShown(latest.current), 350) : undefined;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== "delphi-artifact") return;
      const measured = artifactHeight(event.data.height);
      if (measured !== null) setHeight(measured);
    };
    window.addEventListener("message", receive);
    return () => { clearInterval(timer); window.removeEventListener("message", receive); };
  }, [streaming]);
  return <div inert className="inline-artifact-preview-wrap"><iframe ref={frame} name={id} className="inline-artifact-frame inline-artifact-preview"
    title={`${title} — drawing preview`} srcDoc={document} tabIndex={-1} sandbox="allow-scripts" referrerPolicy="no-referrer"
    allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
    style={{ height }} onLoad={() => frameLoaded(frame.current)} /></div>;
}


/** How much of the card must remain below the view's top for its header to dock. */
export const ARTIFACT_DOCK_BODY = 140;

/**
 * The chat transcript fades its top edge, so a sticky header would park
 * half-transparent inside that band. Instead a copy of the header docks in a
 * layer beside the transcript, outside its mask, while the card's own header
 * is above the view and enough of the card is still below it.
 */
function useDockedHeader(figure: RefObject<HTMLElement | null>, caption: RefObject<HTMLElement | null>, layer: RefObject<HTMLDivElement | null>) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [docked, setDocked] = useState(false);
  useEffect(() => {
    const card = figure.current, scroller = card?.closest<HTMLElement>(".messages");
    if (!card || !scroller?.parentElement) return;
    let queued = 0;
    const place = () => {
      queued = 0;
      setHost(scroller.parentElement);
      const head = caption.current?.getBoundingClientRect(), view = scroller.getBoundingClientRect(), box = card.getBoundingClientRect();
      if (!head) return;
      const fade = Number.parseFloat(getComputedStyle(scroller).getPropertyValue("--chat-transcript-fade")) || 2;
      setDocked(head.top < view.top + fade - 1 && box.bottom > view.top + ARTIFACT_DOCK_BODY && box.top < view.bottom);
      // Correct by the layer's own measured offset, whatever its containing block is.
      const node = layer.current;
      if (!node) return;
      const at = node.getBoundingClientRect();
      node.style.top = `${(parseFloat(node.style.top) || 0) + view.top - at.top}px`;
      node.style.left = `${(parseFloat(node.style.left) || 0) + box.left - at.left}px`;
      node.style.width = `${box.width}px`;
    };
    const schedule = () => { if (!queued) queued = requestAnimationFrame(place); };
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    observer.observe(card);
    scroller.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => { cancelAnimationFrame(queued); observer.disconnect(); scroller.removeEventListener("scroll", schedule); setDocked(false); };
  }, [figure, caption, layer]);
  return [host, docked] as const;
}

function InteractiveArtifact({ title, source }: { title: string; source: string }) {
  const id = `delphi-artifact-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const frame = useRef<HTMLIFrameElement>(null);
  const figure = useRef<HTMLElement>(null);
  const caption = useRef<HTMLElement>(null);
  const dockLayer = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(240);
  const [failure, setFailure] = useState("");
  const [details, setDetails] = useState(false);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [spins, setSpins] = useState(0);
  const [touched, setTouched] = useState(false);
  const [target, setTarget] = useState<number | null>(null);
  const [controls, setControls] = useState<ArtifactControls | null>(null);
  const [badge, setBadge] = useState("");
  const document = useMemo(() => artifactDocument(source, title), [source, title]);
  const [dockHost, docked] = useDockedHeader(figure, caption, dockLayer);
  useFrameTheme(frame);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      // Opaque frames have origin "null"; the exact window, never a claimed
      // id or origin string, owns height/status and bounded local controls.
      if (event.source !== frame.current?.contentWindow || !event.data || event.data.type !== "delphi-artifact") return;
      if (typeof event.data.error === "string" && event.data.error) setFailure(event.data.error.slice(0, 240));
      if (event.data.ready === true) setReady(true);
      if (typeof event.data.badge === "string") setBadge(artifactBadge(event.data.badge));
      if (Object.hasOwn(event.data, "controls")) {
        const next = artifactControls(event.data.controls);
        setControls(next);
        if (!next && Number.isSafeInteger(event.data.controls?.revision)) {
          frame.current?.contentWindow?.postMessage({ type: "delphi-artifact-controls-ack", revision: event.data.controls.revision, accepted: false }, "*");
        }
      }
      const measured = artifactHeight(event.data.height);
      if (measured !== null) setHeight(measured);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  useEffect(() => {
    if (controls) frame.current?.contentWindow?.postMessage({ type: "delphi-artifact-controls-ack", revision: controls.revision, accepted: !failure }, "*");
  }, [controls, failure]);

  const live = controls && !failure ? controls : null;
  const step = live ? artifactStep(live.progress) : null;
  const activate = (action: ArtifactControlAction) => {
    if (!live || live[action].disabled) return false;
    frame.current?.contentWindow?.postMessage({ type: "delphi-artifact-control", revision: live.revision, action }, "*");
    return true;
  };
  // A press made before the diagram answered the last one waits for it, so
  // quick arrow presses are kept rather than dropped as stale.
  const waiting = useRef<{ revision: number; queue: ArtifactControlAction[] }>({ revision: 0, queue: [] });
  const send = (action: ArtifactControlAction) => {
    if (!live || !activate(action)) return;
    const revision = live.revision;
    waiting.current.revision = revision;
    setTimeout(() => { if (waiting.current.revision === revision) waiting.current = { revision: 0, queue: [] }; }, 600);
  };
  const press = (action: ArtifactControlAction) => {
    setTarget(null); setTouched(true);
    if (live && waiting.current.revision === live.revision) { if (waiting.current.queue.length < 4) waiting.current.queue.push(action); return; }
    send(action);
  };
  useEffect(() => {
    if (!live) { waiting.current = { revision: 0, queue: [] }; return; }
    const action = waiting.current.queue.shift();
    if (action) send(action);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.revision]);

  // A track segment walks there one Back or Next at a time, each after the
  // diagram has answered the last, so the author's own step logic decides.
  useEffect(() => {
    if (target === null || !step) return;
    const arrived = step.current === target || !activate(target > step.current ? "next" : "back");
    const done = setTimeout(() => setTarget(null), arrived ? 0 : 3000);
    return () => clearTimeout(done);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, live?.revision]);

  const reset = () => { setBadge(""); setFailure(""); setDetails(false); setReady(false); setControls(null); setTarget(null); setTouched(false); setSpins(value => value + 1); setRevision(value => value + 1); };
  const keys = (event: ReactKeyboardEvent) => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.nativeEvent.isComposing || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    if (event.target instanceof HTMLElement && event.target.closest("input, select, textarea")) return;
    event.preventDefault();
    press(event.key === "ArrowLeft" ? "back" : "next");
  };
  const header = (docked: boolean) => <>
    <span className="inline-artifact-glyph" aria-hidden="true">{GLYPH}</span>
    <CardTitle title={title} step={step} docked={docked} />
    {badge ? <span className="inline-artifact-badge">{badge}</span> : null}
    {live ? <span className="inline-artifact-step-controls" role="group" aria-label="Diagram steps">
      <button type="button" onClick={() => press("back")} disabled={live.back.disabled} aria-label={live.back.label} title={`${live.back.label}  ←`}><svg viewBox="0 0 16 16" aria-hidden="true">{CHEVRON.back}</svg></button>
      {live.progress ? <span className="inline-artifact-progress" role={docked ? undefined : "status"} title={live.progress} aria-label={step ? `Step ${step.current} of ${step.total}${step.name ? `: ${step.name}` : ""}` : undefined}>
        {step ? <>{step.current}<i> / {step.total}</i></> : live.progress}
      </span> : null}
      <button type="button" className={!touched && step?.current === 1 && !live.next.disabled ? "is-inviting" : undefined} onClick={() => press("next")} disabled={live.next.disabled} aria-label={live.next.label} title={`${live.next.label}  →`}><svg viewBox="0 0 16 16" aria-hidden="true">{CHEVRON.next}</svg></button>
    </span> : null}
    {docked ? null : <span className="inline-artifact-actions">
      <button type="button" className="inline-artifact-tool" onClick={reset} aria-label="Reset visualization" title="Reset visualization"><svg key={spins} className={spins ? "is-spinning" : undefined} viewBox="0 0 20 20" aria-hidden="true"><path d="M4 7a6 6 0 1 1-.1 5M4 3v4h4" /></svg></button>
    </span>}
    {step && step.total <= 12 ? <span className="inline-artifact-track" aria-hidden="true">
      {Array.from({ length: step.total }, (_, index) => <button key={index} type="button" tabIndex={-1} className={index + 1 < step.current ? "is-done" : index + 1 === step.current ? "is-current" : undefined}
        onClick={() => { setTouched(true); setTarget(index + 1); }}><i /></button>)}
    </span> : null}
  </>;
  const pinned = docked && !failure;
  // The faded card header takes no focus while its docked copy stands in.
  useLayoutEffect(() => {
    const node = caption.current;
    if (!node) return;
    if (pinned && node.contains(window.document.activeElement)) figure.current?.focus({ preventScroll: true });
    node.inert = pinned;
  }, [pinned]);
  return <figure ref={figure} className="inline-artifact inline-artifact-interactive" data-artifact-state={failure ? "error" : ready ? "ready" : "loading"} data-docked={pinned ? "" : undefined}
    tabIndex={live ? 0 : pinned ? -1 : undefined} onKeyDown={live ? keys : undefined} aria-label={live ? `${title}. Use the left and right arrow keys to step.` : undefined}>
    <figcaption ref={caption} className={`inline-artifact-caption${live ? " is-stepped" : ""}`}>{header(false)}</figcaption>
    {failure ? <div className="inline-artifact-status" role="status">
      <span className="inline-artifact-tile is-unfinished" aria-hidden="true">!</span>
      <span className="inline-artifact-line">This diagram couldn’t run.</span>
      <button type="button" className="inline-artifact-quiet" onClick={() => setDetails(value => !value)} aria-expanded={details}>Details</button>
      <button type="button" onClick={reset}>Try again</button>
    </div> : null}
    {failure && details ? <p className="inline-artifact-detail">{failure}</p> : null}
    {failure ? null : <iframe key={revision} ref={frame} name={id} className="inline-artifact-frame" title={title} srcDoc={document}
      sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
      style={{ height }}
      onLoad={() => { setReady(true); frameLoaded(frame.current); }} />}
    {dockHost ? createPortal(<div ref={dockLayer} className="inline-artifact-dock" data-docked={pinned ? "" : undefined} inert={!pinned}>
      <div className={`inline-artifact-caption${live ? " is-stepped" : ""}`}>{header(true)}</div>
    </div>, dockHost) : null}
  </figure>;
}
