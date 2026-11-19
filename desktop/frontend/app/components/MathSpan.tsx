"use client";

import { type ComponentPropsWithoutRef, useState } from "react";
import type { ExtraProps } from "react-markdown";

/** Keep failed math local, readable and selectable without exposing parser errors. */
export function MathSpan({ node, children, ...props }: ComponentPropsWithoutRef<"span"> & ExtraProps) {
  void node;
  const [expanded, setExpanded] = useState(false);
  if (!props.className?.split(" ").includes("katex-error")) {
    return <span {...props}>{children}</span>;
  }
  // Inline-safe even when remark-math places a display inside a paragraph.
  return (
    <span className="math-fallback">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        Equation couldn’t be displayed · {expanded ? "Hide" : "Show"} LaTeX
      </button>
      {expanded && <code className="math-fallback-source">{children}</code>}
    </span>
  );
}
