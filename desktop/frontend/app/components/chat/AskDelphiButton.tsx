"use client";

/**
 * The one way into a conversation, on every shell that has one.
 *
 * It lives in the top bar rather than beside the thing being read, and that is
 * the same argument invariant 32a settles twice already: a control whose scope
 * is wider than the panel it sits in has to sit somewhere that says so. This
 * one can ask about the open document, the whole project, or everything the
 * account knows — so no panel is the right home for it.
 *
 * The half of 32a that is easy to lose: the *press* must **not navigate**.
 * Pressing it on the graph, on a wiki page, or over a PDF opens the composer
 * where the reader already is. Graph and Health have no rail to dock a
 * conversation in, so *sending* the question is what lands on the wiki rail.
 */

import { MemoryIcon } from "../MemoryIcon";

export function AskDelphiButton({ onOpen, docked = false }: {
  onOpen: () => void;
  /** A conversation is on screen: the glyph sits pressed, on without a word. */
  docked?: boolean;
}) {
  return (
    <button
      type="button"
      className="topbar-ask"
      onClick={onOpen}
      aria-pressed={docked}
      /* No `data-tooltip`: the label *is* the tooltip here, and a bubble on
         top of it would be the same words twice. */
      aria-label="Ask Delphi"
    >
      <MemoryIcon className="topbar-ask-icon" />
      <span>Ask Delphi</span>
    </button>
  );
}
