"use client";

import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import TitleText from "./TitleText";

/** How fast a long title runs under the pointer, in pixels a second. */
const TICKER_SPEED = 28;

/**
 * A page's title on one line. One that does not fit fades out at the right
 * edge rather than wrapping, so the list keeps an even rhythm; under the
 * pointer it then runs leftward like a ticker, slowly and without end. The
 * fit is measured, not guessed from the length, so a title that only just
 * fits is left alone. The copy rides 48px behind the original, which is what
 * lets the loop close without a seam; it is hidden from assistive tech.
 */
export default function ScrollingTitle({ title, className = "" }: { title: string; className?: string }) {
  const box = useRef<HTMLElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [run, setRun] = useState(0);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const width = text.current?.scrollWidth ?? 0;
      setRun(width > element.clientWidth + 1 ? width : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [title]);
  return (
    <strong
      ref={box}
      className={`kb-related-title${run ? " is-long" : ""} ${className}`}
      title={run ? title : undefined}
      style={run ? ({ "--ticker-duration": `${Math.round((run + 48) / TICKER_SPEED)}s` } as CSSProperties) : undefined}
    >
      <span className="kb-related-track">
        <span ref={text}><TitleText title={title} /></span>
        {run ? <span aria-hidden="true"><TitleText title={title} /></span> : null}
      </span>
    </strong>
  );
}
