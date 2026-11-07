"use client";

/**
 * Close a transient surface when attention moves off it.
 *
 * Lifted out of `PdfViewer.tsx`, where it was module-private, when the account
 * dropdown in the topbar needed the same behaviour. Importing it *from* the
 * viewer would have pulled a nineteen-hundred-line module and the pdf.js types
 * behind it into the Dashboard and Memory bundles for the sake of one
 * effect — the reading workspace is the only surface that should pay for the
 * reader.
 *
 * Excluded by target rather than by stopping propagation on the menu's own
 * pointerdown: that stopped the event before the menu's click could still
 * land, since click fires as its own event after pointerdown has already
 * torn the button out of the DOM.
 */

import { useEffect, useEffectEvent, type RefObject } from "react";

export function useDismissOnOutsideActivity(
  active: boolean,
  exemptSelector: string,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const dismiss = (event: Event) => {
      const target = event.target as Element | null;
      if (target?.closest(exemptSelector)) return;
      onDismiss();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("wheel", dismiss, true);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("wheel", dismiss, true);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [active, exemptSelector, onDismiss]);
}

/** Escape closes an open menu even when focus is outside it, as after a click
 * in Safari, which does not focus a clicked button. The menu handles Escape
 * pressed inside it; this one goes no further, so it closes nothing else. */
export function useEscapeFromOutside(
  active: boolean,
  root: RefObject<Element | null>,
  onEscape: () => void,
) {
  const escaped = useEffectEvent(onEscape);
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || root.current?.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
      escaped();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [active, root]);
}
