"use client";

import { Component, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { displayState, type Display } from "../../lib/display-spec";
import { FigureView } from "./figures";
import { HoverContext, Rich, TileDefs } from "./parts";

const PREV = <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>;
const NEXT = <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>;
const RESET = <svg width="13" height="13" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 7a6 6 0 1 1-.1 5M4 3v4h4" /></svg>;

/**
 * One display from Delphi's library, drawn natively in the answer. A display
 * with steps or a control is a card with a header stepper; one without either
 * sits bare in the prose, its title the only chrome.
 */
export function DisplayCard({ spec }: { spec: Display }) {
  const uid = `dsp${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const steps = spec.steps ?? [];
  const control = spec.control;
  const [step, setStep] = useState(0);
  const [variant, setVariant] = useState(control?.default ?? "");
  const [hover, setHover] = useState<string | null>(null);
  const state = useMemo(() => displayState(spec, step, variant), [spec, step, variant]);
  const beat = `${step}:${variant}`;
  const stepped = steps.length > 1;
  const framed = stepped || Boolean(control);
  const card = useRef<HTMLDivElement>(null);
  const go = (next: number) => {
    const to = Math.max(0, Math.min(steps.length - 1, next));
    // The button pressed is about to be disabled at either end: keep focus on the card, not the page.
    if ((to === 0 || to === steps.length - 1) && card.current?.contains(document.activeElement) && document.activeElement?.closest(".dsp-step")) card.current.focus({ preventScroll: true });
    setStep(to); setHover(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A tip closes first; the chat's own Escape (stop, close a panel) waits for the next press.
    if (event.key === "Escape" && hover) { event.preventDefault(); event.stopPropagation(); setHover(null); return; }
    if (!stepped || event.target !== event.currentTarget) return;
    if (event.key === "ArrowRight") { event.preventDefault(); go(step + 1); }
    if (event.key === "ArrowLeft") { event.preventDefault(); go(step - 1); }
  };
  const context = useMemo(() => ({ hover, setHover, uid, beat }), [hover, uid, beat]);

  return <HoverContext.Provider value={context}>
    <div ref={card} className={`dsp${framed ? "" : " is-bare"}`} data-display={uid} tabIndex={stepped ? 0 : undefined} onKeyDown={onKeyDown}
      onMouseLeave={() => setHover(null)} aria-label={stepped ? `${spec.title}, step ${step + 1} of ${steps.length}` : undefined}>
      <TileDefs uid={uid} />
      <div className="dsp-head">
        <span className="dsp-title"><Rich text={spec.title} />{spec.badge ? <small><Rich text={spec.badge} /></small> : null}</span>
        {stepped ? <>
          <span className="dsp-step">
            <button type="button" aria-label="Previous step" disabled={step === 0} onClick={() => go(step - 1)}>{PREV}</button>
            <output aria-live="polite"><b>{step + 1}</b> / {steps.length}</output>
            <button type="button" aria-label="Next step" disabled={step === steps.length - 1} onClick={() => go(step + 1)}>{NEXT}</button>
          </span>
          <button type="button" className="dsp-tool" aria-label="Reset" title="Reset" onClick={() => { go(0); setVariant(control?.default ?? ""); }}>{RESET}</button>
        </> : null}
      </div>
      {stepped ? <div className="dsp-hair">{steps.map((item, index) => <button key={index} type="button"
        className={index === step ? "is-current" : index < step ? "is-done" : ""}
        aria-label={`Step ${index + 1}: ${typeof item.name === "string" ? item.name : item.name[variant] ?? Object.values(item.name)[0]}`}
        onClick={() => go(index)} />)}</div> : null}
      <div className="dsp-body">
        {control ? <div className={`dsp-top${control.caption ? "" : " is-lead"}`}>
          {control.caption ? <span><Rich text={control.caption} /></span> : null}
          <div className="dsp-tabs" role="group" aria-label={control.label}>
            {control.options.map(option => <button key={option.value} type="button" aria-pressed={option.value === variant}
              onClick={() => { setVariant(option.value); setHover(null); }}><Rich text={option.label} /></button>)}
          </div>
          {!control.caption && control.hint ? <span><Rich text={control.hint} /></span> : null}
        </div> : null}
        {state.figures.map((figure, index) => <FigureView key={index} figure={figure} at={index} />)}
        {steps.length ? <div className="dsp-note">{state.stepName ? <b><Rich text={state.stepName} />.</b> : null} <Rich text={state.stepNote} /></div> : null}
        {spec.footnote ? <div className="dsp-footnote"><Rich text={spec.footnote} /></div> : null}
      </div>
    </div>
  </HoverContext.Provider>;
}

/** A spec from another build that the reader cannot draw falls back to the given card instead of taking the chat down. */
export class DisplayBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
