"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Renders a full-window overlay on the body rather than where it was written.
 *
 * `.modal-backdrop` is `position: fixed; z-index: 100`, which only means
 * "above everything" while the backdrop's nearest positioned ancestor is the
 * page itself. Rendered from inside a panel that stacks — `.library-panel` at
 * 20, `.reader-panel`, Memory's page and the rails all do the same — the 100 is
 * compared with its siblings inside that panel, and the top bar's own layer
 * paints over it. The rule is a shape rather than a number: a surface covering
 * the window is mounted on the window.
 */
export function ModalLayer({ children }: { children: ReactNode }) {
  // `document` does not exist while the server renders this, and none of these
  // overlays can be open on a first paint — the same argument SearchOverlay
  // makes for the identical guard.
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
