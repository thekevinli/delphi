"use client";

/**
 * The pieces Health's lists share with the filing run card, which lists what
 * went wrong in the same rows.
 */

import { useState } from "react";

export function Chevron({ up = false }: { up?: boolean }) {
  return (
    <svg className="kb-health-chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d={up ? "m6 15 6-6 6 6" : "m9 6 6 6-6 6"} />
    </svg>
  );
}

/** What the raw error said, one press away and never in monospace. */
export function TechnicalDetail({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="kb-health-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron />
        {open ? "Hide the technical detail" : "Technical detail"}
      </button>
      {open ? <p className="kb-health-detail">{text}</p> : null}
    </>
  );
}
