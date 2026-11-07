/**
 * A local, credential-free validation surface. The backend loads this built
 * entry in its own browser process; it is not an application route. Author
 * markup reaches only InlineArtifact's opaque iframe. CDP inspects that frame
 * separately: this API never grants the host a way into authored DOM.
 */
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { ARTIFACT_DOCK_BODY, InlineArtifact } from "../components/InlineArtifact";
import { ARTIFACT_VALIDATOR_HEIGHT, artifactValidatorRequest, type ArtifactValidatorRequest } from "../lib/artifact-validator-contract";
import "katex/dist/katex.min.css";
import "../globals.css";
import "./host.css";

const container = document.createElement("div");
container.id = "delphi-artifact-validator";
document.body.replaceChildren(container);
const root = createRoot(container);
const loaded = new WeakSet<HTMLIFrameElement>();
container.addEventListener("load", event => {
  if (event.target instanceof HTMLIFrameElement) loaded.add(event.target);
}, true);
let generation = 0;

const figure = () => container.querySelector<HTMLElement>(".inline-artifact");
const display = () => container.querySelector<HTMLElement>(".dsp");
const transcript = () => container.querySelector<HTMLElement>(".messages");
const rect = (element: Element | null) => element?.getBoundingClientRect().toJSON() as {
  x: number; y: number; top: number; right: number; bottom: number; left: number; width: number; height: number;
} | undefined;
const fits = (element: HTMLElement | null) => !element || (element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1);
const finiteAnimations = () => container.getAnimations({ subtree: true }).filter(animation =>
  (animation.playState === "running" || animation.pending) && Number.isFinite(animation.effect?.getComputedTiming().endTime)
).length;

function status() {
  const visual = figure(), messages = transcript();
  const caption = visual?.querySelector<HTMLElement>(".inline-artifact-caption") ?? null;
  const progress = visual?.querySelector<HTMLElement>(".inline-artifact-progress") ?? null;
  const frame = visual?.querySelector<HTMLIFrameElement>("iframe.inline-artifact-frame") ?? null;
  const buttons = visual?.querySelectorAll<HTMLButtonElement>(".inline-artifact-step-controls button");
  const describe = (button: HTMLButtonElement) => ({ label: button.getAttribute("aria-label") || button.textContent || "", disabled: button.disabled });
  const captionRect = rect(caption), transcriptRect = rect(messages), frameRect = rect(frame), figureRect = rect(visual);
  // Once the card's own header scrolls away, its docked copy is the header.
  const dockRect = rect(container.querySelector(".inline-artifact-dock[data-docked]"));
  const fade = messages ? Number.parseFloat(getComputedStyle(messages).getPropertyValue("--chat-transcript-fade")) || 0 : 0;
  const headerContained = Boolean(captionRect && [...(caption?.querySelectorAll("button,[role=status]") ?? [])].every(element => {
    const box = element.getBoundingClientRect();
    return box.left >= captionRect.left - 1 && box.right <= captionRect.right + 1 && box.top >= captionRect.top - 1 && box.bottom <= captionRect.bottom + 1;
  }));
  return {
    state: visual?.dataset.artifactState ?? "empty",
    error: visual?.dataset.artifactState === "error" ? visual.querySelector(".inline-artifact-status")?.textContent?.slice(0, 500) ?? "Artifact failed" : null,
    fontsReady: document.fonts.status === "loaded",
    frame: frame ? { selector: "iframe.inline-artifact-frame", name: frame.name, loaded: loaded.has(frame), width: frame.getBoundingClientRect().width, height: frame.getBoundingClientRect().height, sandbox: frame.getAttribute("sandbox") } : null,
    // The pill shows a parsed count; its title keeps the author's whole progress text.
    controls: buttons?.length === 2 ? { progress: progress?.getAttribute("title") ?? progress?.textContent ?? "", back: describe(buttons[0]), next: describe(buttons[1]) } : null,
    geometry: {
      figure: figureRect, caption: captionRect, transcript: transcriptRect, progress: rect(progress),
      scrollTop: messages?.scrollTop ?? 0, scrollHeight: messages?.scrollHeight ?? 0,
      // At the top, the header must leave the diagram's first row unobscured.
      headerOccludesBody: Boolean(messages && messages.scrollTop <= 1 && frameRect?.height && captionRect && captionRect.bottom > frameRect.top + 1),
      overflow: Boolean(visual && visual.scrollWidth > visual.clientWidth + 1),
      headerContained, progressFits: fits(progress),
      // The header ends a title it cannot fit with an ellipsis.
      titleClipped: (() => { const title = caption?.querySelector<HTMLElement>(".inline-artifact-title"); return Boolean(title && title.scrollWidth > title.clientWidth + 1); })(),
      headerVisible: Boolean(transcriptRect && ((captionRect && captionRect.top >= transcriptRect.top + fade - 1 && captionRect.bottom <= transcriptRect.bottom + 1)
        || (dockRect && Math.abs(dockRect.top - transcriptRect.top) <= 1)
        // Too little of the card is left in view for a docked header.
        || (figureRect && figureRect.bottom <= transcriptRect.top + ARTIFACT_DOCK_BODY))),
      docked: Boolean(dockRect),
    },
    finiteAnimations: finiteAnimations(),
  };
}

/**
 * A library display is the reader's own markup drawn from data, so this host
 * may measure it directly: what overflows the card, which labels are cut off,
 * which parts overlap and which formulas failed to typeset.
 */
function displayIssues(card: HTMLElement) {
  const box = card.getBoundingClientRect();
  const issues: { code: string; message: string; target: string }[] = [];
  const add = (code: string, message: string, target = "") => { if (issues.length < 12 && !issues.some(issue => issue.code === code && issue.target === target)) issues.push({ code, message, target }); };
  const named = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const shown = (element: Element) => element.getClientRects().length > 0 && !element.closest(".dsp-tip, .dsp-hide, .dsp-s-row.is-hidden, .dsp-s-lane.is-faded .dsp-s-row.is-hidden");
  if (card.scrollWidth > card.clientWidth + 1) add("horizontal_overflow", `The display needs ${card.scrollWidth}px in a ${card.clientWidth}px card.`);
  for (const element of card.querySelectorAll(".dsp-body *")) {
    // Shapes inside an svg are clipped by it; only the svg's own box can leave the card.
    if (!shown(element) || (element instanceof SVGElement && element.ownerSVGElement)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && (rect.right > box.right + 1 || rect.left < box.left - 1)) add("horizontal_overflow", `“${named(element)}” extends past the card's edge.`, named(element));
  }
  for (const element of card.querySelectorAll(".dsp-s-box b, .dsp-out, .dsp-tabs button, .dsp-box, .dsp-nd, .dsp-cell, .dsp-mh, .dsp-tl-label, .dsp-s-name, .dsp-lane-name, .dsp-clab")) {
    if (shown(element) && element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1) add("clipped_content", `“${named(element)}” is cut off: it needs ${element.scrollWidth}px and has ${element.clientWidth}px. Shorten it${element.matches(".dsp-s-box b") ? ", or give its row fewer parts" : ""}.`, named(element));
  }
  const parts = [...card.querySelectorAll(".dsp-nd, .dsp-box, .dsp-s-box, .dsp-s-tile, .dsp-cell")].filter(shown).map(element => ({ element, rect: element.getBoundingClientRect() }));
  for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) {
    const one = parts[a], two = parts[b];
    if (one.element.contains(two.element) || two.element.contains(one.element)) continue;
    const across = Math.min(one.rect.right, two.rect.right) - Math.max(one.rect.left, two.rect.left);
    const down = Math.min(one.rect.bottom, two.rect.bottom) - Math.max(one.rect.top, two.rect.top);
    if (across > 2 && down > 2) add("overlap", `“${named(one.element)}” overlaps “${named(two.element)}”. Give them separate places.`, `${named(one.element)} / ${named(two.element)}`);
  }
  for (const error of card.querySelectorAll(".katex-error")) add("math_error", `TeX “${(error.textContent ?? "").slice(0, 80)}” could not be typeset: ${(error.getAttribute("title") ?? "").slice(0, 120)}`, error.textContent ?? "");
  return issues;
}

function displayStatus() {
  const card = currentDisplay(), box = card.getBoundingClientRect();
  return {
    fontsReady: document.fonts.status === "loaded",
    display: {
      width: Math.round(box.width), height: Math.round(box.height), scrollWidth: card.scrollWidth, scrollHeight: card.scrollHeight, bare: card.classList.contains("is-bare"),
      steps: card.querySelectorAll(".dsp-hair button").length, options: [...card.querySelectorAll(".dsp-tabs button")].map(button => button.textContent ?? ""),
      step: card.querySelector(".dsp-step output b")?.textContent ?? "", option: card.querySelector('.dsp-tabs button[aria-pressed="true"]')?.textContent ?? "",
      issues: displayIssues(card),
    },
    finiteAnimations: finiteAnimations(),
  };
}

/** A display has no frame to load: it is ready once fonts are in and its transitions have ended. */
async function settledDisplay() {
  const deadline = performance.now() + 8000;
  await paint(); await paint();
  while (performance.now() < deadline) {
    const current = displayStatus();
    if (current.fontsReady && current.finiteAnimations === 0) return current;
    await paint();
  }
  throw new Error("The display did not settle within eight seconds");
}

/**
 * What one state of a display's figures draws: elements, the attributes that
 * paint them and text, without the control row, the note, a tooltip or any
 * attribute only a screen reader or a pointer reads.
 */
function fingerprint(card: HTMLElement) {
  let hash = 2166136261;
  const mix = (text: string) => { for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { mix(node.textContent ?? ""); return; }
    if (!(node instanceof Element) || node.matches(".dsp-top, .dsp-note, .dsp-tip")) return;
    mix(`<${node.tagName}`);
    for (const { name, value } of node.attributes) if (!/^(?:aria-|title$|tabindex$|role$)/.test(name)) mix(` ${name}=${value}`);
    node.childNodes.forEach(walk);
  };
  const body = card.querySelector(".dsp-body");
  if (body) walk(body);
  return (hash >>> 0).toString(16);
}

function currentDisplay() {
  const card = display();
  if (!card) throw new Error("Mount a display first");
  return card;
}

/** Puts a display at one control option and step, by its own buttons, as a reader would. */
async function displaySet({ option, step }: { option?: number; step?: number }) {
  const card = currentDisplay();
  if (option !== undefined) card.querySelectorAll<HTMLButtonElement>(".dsp-tabs button")[option]?.click();
  if (step !== undefined) card.querySelectorAll<HTMLButtonElement>(".dsp-hair button")[step]?.click();
  return settledDisplay();
}

/**
 * Every state a reader can reach, with transitions held still so each is
 * measured where it lands. The caller compares neighbours: a step or an
 * option that draws nothing new is dead.
 */
async function displayWalk() {
  const card = currentDisplay();
  card.dataset.still = "";
  const options = card.querySelectorAll(".dsp-tabs button").length;
  const pressed = [...card.querySelectorAll(".dsp-tabs button")].findIndex(button => button.getAttribute("aria-pressed") === "true");
  const steps = Math.max(1, card.querySelectorAll(".dsp-hair button").length);
  const states = [];
  for (let option = 0; option < Math.max(1, options); option++) {
    for (let step = 0; step < steps; step++) {
      const current = await displaySet({ option: options ? option : undefined, step: steps > 1 ? step : undefined });
      states.push({ option: current.display.option, index: option, step: step + 1, fingerprint: fingerprint(currentDisplay()), issues: current.display.issues });
    }
  }
  await displaySet({ option: options ? Math.max(0, pressed) : undefined, step: steps > 1 ? 0 : undefined });
  return states;
}

/** The mounted display at another width, held still, so a walk there costs no remount or entrance. */
function displayResize(width: number) {
  currentDisplay().dataset.still = "";
  resize(width);
  return settledDisplay();
}

type Status = ReturnType<typeof status>;
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function settled(ticket = generation): Promise<Status> {
  const deadline = performance.now() + 8000;
  await paint(); await paint();
  while (performance.now() < deadline) {
    if (generation !== ticket) throw new Error("Artifact render was replaced");
    const current = status();
    // `ready` is a lifecycle observation, not a quality verdict. Require a
    // real iframe load rather than trusting a model's ready postMessage.
    if (current.state === "error" || (current.state === "ready" && current.frame?.loaded && current.fontsReady && current.finiteAnimations === 0)) return current;
    await paint();
  }
  throw new Error("Artifact host did not settle within eight seconds");
}

function resize(width: number) {
  if (!Number.isInteger(width) || width < 270 || width > 1200) throw new Error("Invalid artifact width");
  const rail = container.querySelector<HTMLElement>(".kb-chat-rail");
  if (!rail) throw new Error("Mount an artifact before resizing");
  // Measure the real rail's padding rather than duplicating its CSS tokens.
  const current = (figure() ?? display())?.getBoundingClientRect().width ?? width;
  rail.style.width = `${rail.getBoundingClientRect().width + width - current}px`;
}

async function mount(input: ArtifactValidatorRequest) {
  const request = artifactValidatorRequest(input);
  const ticket = ++generation;
  root.render(<div className="kb-chat-rail landed" style={{ width: request.width + 40, height: ARTIFACT_VALIDATOR_HEIGHT }}>
    {/* A check is of a card at one width. The docked measure decides which
        widths a card is given in the app; here it would hold the turn short
        of the width asked for, so a check at 800px drew a narrower card. */}
    <div className="kb-ask-modal chat-surface" style={{ "--chat-measure": "none" } as CSSProperties}>
      <div className="messages" data-validator-transcript>
        <div className="message assistant"><div className="kb-chat-turn"><div className="message-markdown prose-reading">
          <InlineArtifact key={ticket} title={request.title} source={request.source} problem={null} streaming={false} />
        </div></div></div>
      </div>
    </div>
  </div>);
  await paint(); await paint();
  if (display()) {
    // A library display draws in this document; a spec it cannot read falls back to a problem card below.
    await settledDisplay();
    resize(request.width);
    await settledDisplay();
    return status();
  }
  await settled(ticket);
  resize(request.width);
  const messages = transcript();
  if (messages) messages.scrollTop = 0;
  return settled(ticket);
}

async function setWidth(width: number) { resize(width); return settled(); }
async function scroll(top: number) {
  if (!Number.isFinite(top) || top < 0) throw new Error("Invalid transcript position");
  const messages = transcript();
  if (!messages) throw new Error("Mount an artifact before scrolling");
  messages.scrollTop = Math.min(top, messages.scrollHeight);
  // The scroll event places the docked header a frame later, and React commits it after that.
  await paint(); await paint(); await paint();
  return status();
}

type Action = "next" | "back" | "reset";
async function action(name: Action) {
  const visual = figure();
  if (!visual) throw new Error("Mount an artifact before interacting");
  const steps = visual.querySelectorAll<HTMLButtonElement>(".inline-artifact-step-controls button");
  const button = name === "back" ? steps[0] : name === "next" ? steps[1]
    : name === "reset" ? visual.querySelector<HTMLButtonElement>('.inline-artifact-actions > button[aria-label="Reset visualization"]') : null;
  if (!button || button.disabled) throw new Error(`Artifact action is unavailable: ${name}`);
  button.click();
  await paint(); await paint();
  return settled();
}

async function probeHeader() {
  const initial = await settled();
  if (!initial.controls) return { applicable: false, initial };
  const next = initial.controls.next.disabled ? null : await action("next");
  const back = next?.controls && !next.controls.back.disabled ? await action("back") : null;
  const reset = await action("reset");
  return { applicable: true, initial, next, back, reset };
}

const api = Object.freeze({ mount, status, setWidth, action, scroll, probeHeader, displayStatus: settledDisplay, displayWalk, displaySet, displayResize });
declare global { interface Window { __delphiArtifactValidator: typeof api } }
Object.defineProperty(window, "__delphiArtifactValidator", { value: api, writable: false, configurable: false });
