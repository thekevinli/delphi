import { useEffect, useState } from "react";

/** How long each composer hint stays before the next rolls in: the Memory chat's and the floating Composer's. */
export const HINT_HOLD_MS = 4000;
/** The right rail's, which is read beside a conversation already under way. */
export const RAIL_HINT_HOLD_MS = 8000;

/** The hint `step` holds after `start`, in the list's own order and round again. */
export function hintAt(hints: readonly string[], start: number, step: number): string {
  return hints.length ? hints[(start + step) % hints.length] : "";
}

/**
 * The composer's hint: one picked at random when the chat opens, then each
 * next in turn every `hold` milliseconds.
 */
export function useCyclingHint(hints: readonly string[], hold = HINT_HOLD_MS): string {
  const [start] = useState(() => Math.floor(Math.random() * 720));
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (hints.length < 2) return;
    const timer = setInterval(() => setStep((value) => value + 1), hold);
    return () => clearInterval(timer);
  }, [hints.length, hold]);
  return hintAt(hints, start, step);
}
