"use client";

import { chatModelEfforts, chatEffort, DEFAULT_CHAT_CONFIG, modelLabel, SUPPORTED_MODELS } from "../lib/chat-model-policy";
export { modelLabel, SUPPORTED_MODELS } from "../lib/chat-model-policy";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type { PersonaSummary } from "../lib/api";
import {
  DEFAULT_PERSONA_ID,
  personaElement,
} from "../lib/personas";
import { ElementIcon } from "./ElementIcon";
import { useEscapeFromOutside } from "../lib/use-dismiss";
export { AnswerFlow, TraceFold } from "./AnswerTrace";

/**
 * The pieces every chat surface shares.
 *
 * Lifted out of `ChatPanel.tsx` when Memory grew a chat of its own.
 * The reader should not be able to tell which of the two they are looking at
 * from the way a reasoning line ticks over or a model pill opens — and the way
 * two surfaces come to differ is by each owning a copy of these.
 *
 * What stays behind in `ChatPanel` is everything that is genuinely about
 * reading a paper: @mentions, image attachments, the selection chip, the
 * viewport. None of that means anything to a conversation with the wiki.
 */

const TOGGLE_TIP_DELAY_MS = 500;

/** The menu's intended width, and the width below which it slides instead. */
const MENU_WIDTH = 400;
const MENU_MIN_WIDTH = 240;

export function ComposerToggle({
  label,
  className = "",
  pressed,
  disabled,
  onActivate,
  children,
}: {
  label: string;
  className?: string;
  pressed?: boolean;
  disabled?: boolean;
  onActivate: () => void;
  children: ReactNode;
}) {
  const [tip, setTip] = useState(false);
  const timerRef = useRef<number | null>(null);
  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  useEffect(() => clearTimer, []);
  return (
    <span
      className="composer-toggle-slot"
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        clearTimer();
        timerRef.current = window.setTimeout(() => setTip(true), TOGGLE_TIP_DELAY_MS);
      }}
      onPointerLeave={() => {
        clearTimer();
        setTip(false);
      }}
    >
      <button
        type="button"
        className={`composer-toggle ${className}`.trim()}
        aria-pressed={pressed}
        aria-label={label}
        disabled={disabled}
        onFocus={() => setTip(true)}
        onBlur={() => setTip(false)}
        onClick={() => {
          clearTimer();
          onActivate();
        }}
      >
        {children}
      </button>
      {tip ? <span className="composer-tip" role="tooltip">{label}</span> : null}
    </span>
  );
}

/**
 * The persona control, and the only one.
 *
 * There used to be two: this drop-up in the account-wide chat, and a button in
 * every reader scope that opened a modal onto the *project's* persona. They
 * looked different, they were reached differently, and the only explanation of
 * what a persona is lived inside the modal — which is to say, behind a choice
 * the reader had already made. One control, in every chat, explaining itself
 * before it is used.
 */
export function PersonaPill({
  personas,
  value,
  onChange,
  onManage,
  fallbackId = DEFAULT_PERSONA_ID,
}: {
  personas: PersonaSummary[];
  value: string;
  onChange: (value: string) => void;
  /** Opens Settings → Persona. Absent on a surface with no settings sheet. */
  onManage?: () => void;
  /** What the server would answer as if `value` no longer resolves. */
  fallbackId?: string;
}) {
  const choices = personas.length
    ? personas
    : [
        {
          id: DEFAULT_PERSONA_ID,
          official: true,
          name: "Mentor",
          element: "water",
          capabilities: [],
        },
      ];
  /**
   * What answers, which is not always what is stored.
   *
   * A persona can be deleted while a conversation still names it, so a stored
   * id can dangle. The server resolves that to the account default rather than
   * failing the thread, and the pill has to say the same thing — it read
   * "Persona" with no icon before, which told the reader nothing about the
   * voice their next question would actually get.
   */
  const current =
    choices.find((persona) => persona.id === value) ??
    choices.find((persona) => persona.id === fallbackId) ??
    choices[0];
  // `official` comes off the wire on every row — true for the ones shipped in
  // code, false from both storage backends — so the client needs no list of
  // which personas those are, and cannot hold a stale one.
  const official = choices.filter((persona) => persona.official);
  const mine = choices.filter((persona) => !persona.official);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const closeMenu = useCallback(() => {
    if (!open) return;
    setClosing(true);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
      closeTimerRef.current = null;
    }, 150);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [closeMenu, open]);
  useEscapeFromOutside(open, rootRef, closeMenu);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  /**
   * Keep the menu above its own pill, and inside whatever is clipping it.
   *
   * The menu is 400px and hangs leftward from the pill's right edge — the edge
   * that holds still while the name unrolls — which overflows any rail where
   * the pill sits less than 400px from the left — and the rail's card is
   * `overflow: hidden`, so the overflow is not merely ugly, it is cut off. The
   * old fix re-anchored the menu to the composer's *right* edge, which is why
   * it opened at the far side of the panel with its pill nowhere near it.
   *
   * CSS cannot ask an ancestor how wide it is, so this measures once on open
   * and writes two custom properties the stylesheet reads. A layout effect, not
   * a render-time write: nothing is assigned to a ref while rendering.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const menu = menuRef.current;
    if (!root || !menu) return;
    const clip = root.closest(".composer, .kb-ask-modal, .kb-composer-card");
    if (!clip) return;
    const pill = root.getBoundingClientRect();
    const bounds = clip.getBoundingClientRect();
    // How much room there is between the pill and the clipping edge. Floored,
    // because a menu squeezed below this is unreadable — past the floor it
    // slides right instead of narrowing further.
    const room = Math.max(0, pill.right - bounds.left);
    const width = Math.max(MENU_MIN_WIDTH, Math.min(MENU_WIDTH, room));
    root.style.setProperty("--persona-menu-width", `${width}px`);
    root.style.setProperty(
      "--persona-menu-shift",
      `${Math.max(0, width - room)}px`,
    );
  }, [open]);

  return (
    <div
      className="persona-pill"
      ref={rootRef}
      data-element={personaElement(current?.element)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        closeMenu();
      }}
    >
      <button
        type="button"
        className="persona-pill-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Answer persona"
        onClick={() => {
          if (open) closeMenu();
          else {
            setClosing(false);
            setOpen(true);
          }
        }}
      >
        <ElementIcon element={personaElement(current?.element)} size={14} />
        <span className="persona-pill-label">{current?.name ?? "Persona"}</span>
      </button>
      {open ? (
        <div
          ref={menuRef}
          className={`persona-picker-menu${closing ? " closing" : ""}`}
          role="listbox"
          aria-label="Choose answer persona"
        >
          <span className="persona-picker-heading" aria-hidden="true">Persona</span>
          {[
            { key: "official", label: "Official", rows: official },
            { key: "mine", label: "Your personas", rows: mine },
          ].map(({ key, label, rows }) =>
            rows.length === 0 ? null : (
              <div key={key} className="persona-picker-group">
                {/* Labelled only once there is something to tell apart. With no
                    personas of your own, "Official" is a heading over the only
                    list there is. */}
                {mine.length > 0 ? (
                  <span className="persona-picker-group-label">{label}</span>
                ) : null}
                {rows.map((persona) => (
                  <button
                    key={persona.id}
                    type="button"
                    role="option"
                    aria-selected={persona.id === value}
                    className={`persona-picker-option${persona.id === value ? " active" : ""}`}
                    onClick={() => {
                      onChange(persona.id);
                      closeMenu();
                    }}
                  >
                    <span className="persona-picker-tile" data-element={personaElement(persona.element)}>
                      <ElementIcon element={personaElement(persona.element)} size={16} />
                    </span>
                    <span className="persona-picker-copy">
                      <strong>{persona.name}</strong>
                      {persona.tagline ? <small>{persona.tagline}</small> : null}
                    </span>
                    {persona.id === value ? <PickerCheck /> : null}
                  </button>
                ))}
              </div>
            ),
          )}
          {onManage ? (
            <button
              type="button"
              className="persona-picker-manage"
              onClick={() => {
                closeMenu();
                onManage();
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>
              Manage personas
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const EFFORT_LABELS: Record<string, string> = {
  max: "Max",
  xhigh: "xHigh",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** The version a model's label leads with; a narrow pill keeps only the name after it. */
const MODEL_VERSION_PREFIX = /^GPT[\s-]*[\d.]+\s*/i;

/** Sequence a compact-label change without animating the flex row's width. */
function useCompactModelPill(root: RefObject<HTMLDivElement | null>, label: string) {
  useLayoutEffect(() => {
    const button = root.current?.querySelector<HTMLButtonElement>(".model-badge");
    const composer = root.current?.closest<HTMLElement>(".composer, .kb-composer-card");
    if (!button || !composer) return;
    const name = button.querySelector<HTMLElement>(".model-pill-short-name")!;
    const prefix = button.querySelector<HTMLElement>(".model-pill-prefix")!;
    const effort = button.querySelector<HTMLElement>(".model-pill-effort")!;
    const bars = button.querySelector<HTMLElement>(".model-pill-effort-icon")!;
    let revision = 0;
    let target: boolean | undefined;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const animations = new Set<Animation>();
    const animate = (element: HTMLElement, frames: Keyframe[], duration: number, delay = 0) => {
      const animation = element.animate(frames, { duration, delay, easing: "ease-out", fill: "both" });
      animation.id = "model-pill-morph";
      animations.add(animation);
      return animation.finished.catch(() => {});
    };
    const cancel = () => { animations.forEach(animation => animation.cancel()); animations.clear(); };
    const fit = async (width: number) => {
      const compact = width <= 380;
      if (target === compact) return;
      const initial = target === undefined;
      target = compact;
      const currentRevision = ++revision;
      cancel();
      delete button.dataset.morphing;
      if (initial || reducedMotion.matches) {
        button.dataset.compact = String(compact);
        return;
      }
      if (button.dataset.compact === String(compact)) return;
      // Fade before changing layout. Only opacity and the name's transform
      // animate; the control row is laid out once at the new size.
      await Promise.all((compact ? [prefix, effort] : [bars]).map(element =>
        animate(element, [{ opacity: 1 }, { opacity: 0 }], 150)));
      if (currentRevision !== revision) return;
      // Measured from the badge's own edge: the pill sits right-aligned, so its
      // left edge moves with the width and the name must travel with it.
      const inset = () => name.getBoundingClientRect().left - button.getBoundingClientRect().left;
      const before = inset();
      button.dataset.compact = String(compact);
      button.dataset.morphing = "true";
      cancel();
      const offset = before - inset();
      await Promise.all([
        animate(name, [{ transform: `translateX(${offset}px)` }, { transform: "translateX(0)" }], 240),
        ...(compact ? [bars] : [prefix, effort]).map(element =>
          animate(element, [{ opacity: 0 }, { opacity: 1 }], 210, 150)),
      ]);
      if (currentRevision !== revision) return;
      cancel();
      delete button.dataset.morphing;
    };
    const style = getComputedStyle(composer);
    let observedWidth = composer.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    let resizeFrame = 0;
    void fit(observedWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === observedWidth) return;
      observedWidth = entry.contentRect.width;
      cancelAnimationFrame(resizeFrame);
      // A compact change resizes the pill inside the observed composer.
      // Apply it outside observer delivery so that layout cannot feed back
      // into the same notification cycle; height-only changes need no work.
      resizeFrame = requestAnimationFrame(() => { void fit(observedWidth); });
    });
    observer.observe(composer);
    const settleMotion = () => {
      if (!reducedMotion.matches) return;
      revision++;
      cancel();
      button.dataset.compact = String(target);
      delete button.dataset.morphing;
    };
    reducedMotion.addEventListener("change", settleMotion);
    return () => { revision++; observer.disconnect(); cancelAnimationFrame(resizeFrame); reducedMotion.removeEventListener("change", settleMotion); cancel(); delete button.dataset.morphing; };
  }, [root, label]);
}

/**
 * Model and reasoning effort are one choice in two parts, so they are one pill:
 * the name carries the weight, the effort trails it lighter. Two separate pills
 * spent a third of a narrow composer row on a distinction nobody makes
 * independently — and the row has an attachment control still to come.
 *
 * A native <select> could not do this: its closed state can only be the chosen
 * option's own text, and its dropdown is the OS widget rather than ours.
 */
export function ModelPill({
  models,
  model,
  onModelChange,
  efforts,
  modelEfforts,
  effort,
  onEffortChange,
}: {
  models: { value: string; label: string }[];
  model: string;
  onModelChange: (value: string) => void;
  efforts: { value: string; label: string }[];
  modelEfforts: Record<string, string[]>;
  effort: string;
  onEffortChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [previewModel, setPreviewModel] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const modelsRef = useRef<HTMLDivElement>(null);
  const effortsRef = useRef<HTMLDivElement>(null);
  /** The height the window last settled at, so the next view grows from it. */
  const settledHeightRef = useRef(0);
  // Exactly the models this connection serves: the API key and a ChatGPT plan
  // publish different lists, and a model from the other would have no efforts.
  const selectableModels = models;
  const effectiveModelEfforts = chatModelEfforts({
    ...DEFAULT_CHAT_CONFIG.modelReasoningEfforts,
    ...modelEfforts,
  });
  const currentModel =
    selectableModels.find((item) => item.value === model) ?? selectableModels[0];
  const allowedEfforts = new Set(
    effectiveModelEfforts[currentModel?.value ?? ""] ??
      efforts.map((item) => item.value),
  );
  // The service publishes strongest-first for request fallback. A picker reads
  // more naturally as a rising ladder, matching the system settings pattern.
  const availableEfforts = efforts
    .filter((item) => allowedEfforts.has(item.value))
    .slice()
    .reverse();
  const currentEffort =
    availableEfforts.find((item) => item.value === chatEffort(currentModel?.value ?? "", effort, effectiveModelEfforts)) ??
    availableEfforts.at(0);
  useCompactModelPill(rootRef, `${currentModel?.label}:${currentEffort?.value}`);
  const pendingModel =
    selectableModels.find((item) => item.value === previewModel) ?? currentModel;
  const pendingAllowedEfforts = new Set(
    effectiveModelEfforts[pendingModel?.value ?? ""] ??
      efforts.map((item) => item.value),
  );
  const pendingEfforts = efforts
    .filter((item) => pendingAllowedEfforts.has(item.value))
    .slice()
    .reverse();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setPreviewModel(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);
  useEscapeFromOutside(open, rootRef, () => {
    setOpen(false);
    setPreviewModel(null);
  });

  /**
   * One window, two views: choosing a model slides the model list out to the
   * left and its efforts in from the right, and the window takes the height
   * of whichever list it is showing.
   *
   * The height is set once per view — layout changes once — and the change is
   * *shown* by the surface behind the lists scaling from the old height to the
   * new one, so every animated frame is a transform. Animating `height` would
   * relayout the composer on each frame.
   */
  const onEfforts = previewModel !== null;
  useLayoutEffect(() => {
    if (!open) {
      settledHeightRef.current = 0;
      return;
    }
    const picker = pickerRef.current;
    const pane = (onEfforts ? effortsRef : modelsRef).current;
    if (!picker || !pane) return;
    const next = pane.offsetHeight;
    const previous = settledHeightRef.current;
    settledHeightRef.current = next;
    picker.style.height = `${next}px`;
    if (!previous || previous === next) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    surfaceRef.current?.animate(
      [{ transform: `scaleY(${previous / next})` }, { transform: "scaleY(1)" }],
      { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
    // The list being shown takes focus with it, so the keyboard follows the slide.
    const target = pane.querySelector<HTMLButtonElement>(
      onEfforts ? '[aria-checked="true"], [role="menuitemradio"]' : ".preview, .active, button",
    );
    target?.focus({ preventScroll: true });
  }, [open, onEfforts, previewModel]);

  if (!currentModel || !currentEffort) return null;

  return (
    <div
      className="pill-select"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
          setPreviewModel(null);
        }
      }}
    >
      <button
        type="button"
        className="composer-pill model-badge"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${currentModel.label}, effort: ${currentEffort.label}`}
        onClick={() => {
          if (open) setPreviewModel(null);
          setOpen(!open);
        }}
      >
        <span className="model-pill-name"><span className="model-pill-prefix">{currentModel.label.match(MODEL_VERSION_PREFIX)?.[0]}</span><span className="model-pill-short-name">{currentModel.label.replace(MODEL_VERSION_PREFIX, "")}</span></span>
        <span className="model-pill-effort">{currentEffort.label}</span>
        <span className="model-pill-effort-icon"><EffortBars level={availableEfforts.indexOf(currentEffort) + 1} of={availableEfforts.length} /></span>
        <svg className="model-pill-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="m3.5 7.25 2.5-2.5 2.5 2.5" /></svg>
      </button>
      {open ? (
        <div
          className="model-picker"
          ref={pickerRef}
          data-view={onEfforts ? "efforts" : "models"}
        >
          <div className="model-picker-surface" ref={surfaceRef} aria-hidden="true" />
          <div className="model-picker-panes">
            <div
              ref={modelsRef}
              className="model-picker-menu model-picker-models"
              role="menu"
              aria-label="Choose model"
              aria-hidden={onEfforts || undefined}
              inert={onEfforts}
            >
              <span className="model-picker-heading" aria-hidden="true">Model</span>
              {selectableModels.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.value === currentModel.value}
                  aria-haspopup="menu"
                  aria-expanded={option.value === previewModel}
                  className={
                    option.value === previewModel
                      ? "preview"
                      : option.value === currentModel.value
                        ? "active"
                        : ""
                  }
                  onClick={() => setPreviewModel(option.value)}
                >
                  <span>{option.label}</span>
                  <small>{option.value === currentModel.value ? currentEffort.label : ""}</small>
                  <PickerChevron />
                </button>
              ))}
            </div>
            <div
              ref={effortsRef}
              className="model-picker-submenu"
              role="menu"
              aria-label={`Choose effort for ${pendingModel.label}`}
              aria-hidden={!onEfforts || undefined}
              inert={!onEfforts}
            >
              <button
                type="button"
                className="model-picker-back"
                onClick={() => setPreviewModel(null)}
              >
                <PickerBack />
                <span>{pendingModel.label}</span>
              </button>
              {pendingEfforts.map((option, index) => {
                const selected =
                  pendingModel.value === currentModel.value &&
                  option.value === currentEffort.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={selected ? "active" : ""}
                    onClick={() => {
                      onModelChange(pendingModel.value);
                      onEffortChange(option.value);
                      setOpen(false);
                      setPreviewModel(null);
                    }}
                  >
                    <EffortBars level={index + 1} of={pendingEfforts.length} />
                    <span>{option.label}</span>
                    {selected ? <PickerCheck /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A rising ladder beside each effort, so the levels read before the words. */
function EffortBars({ level, of }: { level: number; of: number }) {
  return (
    <span className="effort-bars" aria-hidden="true">
      {Array.from({ length: of }, (_, index) => <i key={index} className={index < level ? "on" : undefined} />)}
    </span>
  );
}

function PickerChevron() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <path d="m5.25 3.5 3.5 3.5-3.5 3.5" />
    </svg>
  );
}

function PickerBack() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <path d="m8.75 3.5-3.5 3.5 3.5 3.5" />
    </svg>
  );
}

function PickerCheck() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <path d="m2.25 7.25 3 3 6.5-7" />
    </svg>
  );
}

/**
 * The passage a question was asked about, on the question. Three lines, and
 * the rest one click away when there is more: a long selection used to be cut
 * off with no way to read what was sent.
 */
export function SelectedPassage({ text }: { text: string }) {
  const quote = useRef<HTMLQuoteElement>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  // Measured again whenever the quote's box changes: a narrower panel clips more.
  useLayoutEffect(() => {
    const node = quote.current;
    if (!node || open) return;
    const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, open]);
  return (
    <>
      <blockquote ref={quote} className={open ? "is-open" : undefined}>{text}</blockquote>
      {clipped ? (
        <button
          type="button"
          className="trace-fold-toggle selected-passage-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
    </>
  );
}

/**
 * Same confirm on both chat surfaces — clearing is permanent either way.
 *
 * Portalled to `document.body`, because a confirm has to out-rank everything
 * it is asked over and rendering it inside the card meant it never could.
 * `.kb-chat-rail.landed` sets `z-index: 4`, which is a *stacking context*: the
 * backdrop's own `z-index: 100` then only ever ranked it against the rail's
 * own children, never against the page. Docked in the Reader the result was a
 * dialog that covered the viewport in geometry and half of it in paint — the
 * library panel and both dividers sit at `z-index: 20` in the grid's stacking
 * context and drew straight over it, so pressing the eraser washed part of the
 * page and showed a confirm the reader could not necessarily see. The dim is
 * the whole viewport now because the backdrop is a sibling of the app.
 */
export function ClearChatModal({
  onClose,
  onClear,
}: {
  onClose: () => void;
  onClear: () => void;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        // Nested under the ask overlay (also a backdrop) — without this the
        // click dismisses the whole conversation as well as the confirm.
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        className="modal"
        role="alertdialog"
        aria-labelledby="clear-chat-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="modal-warning-icon"
          src="/brand/animations/delphi-warning-alert.gif"
          alt=""
        />
        <span className="eyebrow">Clear chat</span>
        <h2 id="clear-chat-title">Clear this conversation?</h2>
        <p>
          This deletes the chat history for good. The model won&rsquo;t have
          this context on your next question, so you may end up re-asking things
          already answered.
        </p>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="danger-button" onClick={onClear}>
            Clear history
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
