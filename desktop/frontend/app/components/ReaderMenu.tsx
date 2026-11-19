"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEscapeFromOutside } from "../lib/use-dismiss";

/** The menu's glyphs, one 16-unit stroke set so every row reads alike. */
const GLYPHS = {
  zoom: "M7 2.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4ZM10.2 10.2l3.3 3.3",
  home: "M2.5 7.4 8 3l5.5 4.4V13H10V9.6H6V13H2.5z",
  browser: "M9.2 2.8h4v4M13.2 2.8 7.6 8.4M11.6 9.6v3.6H2.8V4.4h3.6",
  save: "M3.5 1.75h6l3 3v9.5h-9zM9.5 1.75v3h3M8 7v4M6 9h4",
  export: "M8 10.2V2.6M5 5.4l3-3 3 3M2.8 9.6v3.6h10.4V9.6",
} as const;
export type ReaderMenuGlyph = keyof typeof GLYPHS;

function Glyph({ name }: { name: ReaderMenuGlyph }) {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={GLYPHS[name]} /></svg>;
}

/** Put the menu away and give focus back to ⋮, where the reader left it. */
const close = (from: Element) => {
  const menu = from.closest("details");
  if (!menu?.open) return;
  menu.open = false;
  menu.querySelector("summary")?.focus();
};

/**
 * The reader header's ⋮: what the bar need not show at rest. `closeSignal`
 * closes it when it changes, for clicks this window never hears (a webpage's
 * frame reports them as a count).
 */
export function ReaderMenu({ children, closeSignal }: { children: ReactNode; closeSignal?: number }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    // Captured, so a highlight or link that stops its own pointerdown still closes it.
    const dismiss = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    window.addEventListener("pointerdown", dismiss, true);
    return () => window.removeEventListener("pointerdown", dismiss, true);
  }, [open]);
  // A zoom step that reaches its limit disables the button holding focus.
  useEscapeFromOutside(open, ref, () => { if (ref.current) close(ref.current); });
  useEffect(() => { if (ref.current) ref.current.open = false; }, [closeSignal]);
  return <details
    ref={ref}
    className="reader-menu"
    onToggle={event => setOpen(event.currentTarget.open)}
    onKeyDown={event => {
      if (event.key !== "Escape" || !event.currentTarget.open) return;
      // The menu's Escape, not an open note's or the notes list's.
      event.preventDefault();
      event.stopPropagation();
      close(event.currentTarget);
    }}
  >
    <summary className="icon-button" aria-label="More" title="More">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M8 3.2v.01M8 8v.01M8 12.8v.01" /></svg>
    </summary>
    <div className="reader-menu-items">{children}</div>
  </details>;
}

/** A row that does one thing and puts the menu away; `href` makes it a download. */
export function ReaderMenuItem({ glyph, children, meta, onSelect, href }: {
  glyph: ReaderMenuGlyph; children: ReactNode; meta?: ReactNode; onSelect?: () => void; href?: string;
}) {
  const body = <><Glyph name={glyph} /><span className="reader-menu-label">{children}</span>{meta ? <span className="reader-menu-meta">{meta}</span> : null}</>;
  return href
    ? <a className="reader-menu-item" href={href} download onClick={event => close(event.currentTarget)}>{body}</a>
    : <button type="button" className="reader-menu-item" onClick={event => { close(event.currentTarget); onSelect?.(); }}>{body}</button>;
}

/** Cached or live, in the project's own colour: the one row that says which page this is. */
export function ReaderMenuView({ children, meta, disabled, onSelect }: {
  children: ReactNode; meta?: ReactNode; disabled?: boolean; onSelect: () => void;
}) {
  return <button type="button" className="reader-menu-item reader-menu-view" disabled={disabled} onClick={event => { close(event.currentTarget); onSelect(); }}>
    <span className="reader-menu-dot" aria-hidden="true" />
    <span className="reader-menu-label">{children}</span>
    {meta ? <span className="reader-menu-meta">{meta}</span> : null}
  </button>;
}

/**
 * Zoom stays open while it is used, so a reader can step twice and see both.
 * The readout resets to 100%, as every browser's zoom indicator does.
 */
export function ReaderMenuZoom({ value, canOut, canIn, onOut, onIn, onReset, labels }: {
  value: number; canOut: boolean; canIn: boolean; onOut: () => void; onIn: () => void; onReset: () => void;
  labels: { out: string; in: string; reset: string };
}) {
  return <div className="reader-menu-zoom" role="group" aria-label="Zoom">
    <Glyph name="zoom" />
    <span className="reader-menu-label">Zoom</span>
    <span className="reader-menu-stepper">
      <button type="button" aria-label={labels.out} title={labels.out} disabled={!canOut} onClick={onOut}>−</button>
      <button type="button" className="reader-menu-zoom-value" aria-label={`Zoom ${value}%. Reset to 100%`} title={labels.reset} disabled={value === 100} onClick={onReset}>{value}%</button>
      <button type="button" aria-label={labels.in} title={labels.in} disabled={!canIn} onClick={onIn}>+</button>
    </span>
  </div>;
}

export function ReaderMenuRule() {
  return <hr className="reader-menu-rule" />;
}
