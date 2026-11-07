"use client";

import { useId, useLayoutEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { noteSummary } from "../lib/note-markdown";
import { useHoverPeek } from "../lib/use-hover-peek";

/** A temporary glance never replaces the note the reader deliberately opened. */
export default function NoteMarker({ body, expanded, className = "", style, bounds, onOpen, onEdit }: {
  body: string;
  expanded: boolean;
  className?: string;
  style: CSSProperties;
  bounds?: DOMRect;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const marker = useRef<HTMLButtonElement>(null);
  const peek = useRef<HTMLDivElement>(null);
  const id = useId();
  const summary = noteSummary(body, Infinity);
  const { visible, enter, leave, hold, dismiss } = useHoverPeek(".pdf-note-icon, .note-peek", expanded);
  useLayoutEffect(() => {
    if (!visible || !marker.current || !peek.current) return;
    const anchor = marker.current.getBoundingClientRect();
    const area = bounds ?? marker.current.closest(".pdf-page")?.getBoundingClientRect();
    const left = Math.max(8, (area?.left ?? 0) + 8);
    const right = Math.min(window.innerWidth - 8, area?.right ?? window.innerWidth);
    const bottom = Math.min(window.innerHeight - 8, area?.bottom ?? window.innerHeight);
    const node = peek.current;
    node.style.width = `${Math.min(330, right - left)}px`;
    node.style.left = `${Math.max(left, Math.min(anchor.right - node.offsetWidth, right - node.offsetWidth))}px`;
    node.style.top = `${Math.max(8, Math.min(anchor.bottom + 8, bottom - node.offsetHeight))}px`;
  }, [visible, body, bounds, style.top]);

  return <>
    <button
      ref={marker}
      type="button"
      className={`pdf-note-icon ${className}`}
      style={style}
      aria-label={`Note: ${summary}`}
      aria-expanded={expanded}
      aria-describedby={visible ? id : undefined}
      onPointerDown={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={dismiss}
      onClick={() => { dismiss(); onOpen(); }}
      onDoubleClick={() => { dismiss(); onEdit(); }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 4h14v12l-4 4H5z" /><path d="M15 20v-4h4M9 9h6M9 13h4" />
      </svg>
    </button>
    {visible && createPortal(
      <div ref={peek} id={id} role="tooltip" className="note-peek"
        onMouseEnter={hold} onMouseLeave={leave}>
        <span>{summary}</span>
      </div>, document.body,
    )}
  </>;
}
