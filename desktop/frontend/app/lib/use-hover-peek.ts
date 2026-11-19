"use client";

/** A glance that opens on hover or focus after a beat, shared by note and web peeks so their timing never drifts. */

import { useCallback, useEffect, useRef, useState } from "react";

import { useDismissOnOutsideActivity } from "./use-dismiss";

const OPEN_MS = 250;
const CLOSE_MS = 120;

export function useHoverPeek(exemptSelector: string, blocked = false) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [hovered, setHovered] = useState(false);
  const visible = hovered && !blocked;
  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    setHovered(false);
  }, []);
  const enter = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHovered(true), OPEN_MS);
  }, []);
  const leave = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHovered(false), CLOSE_MS);
  }, []);
  /** The pointer reached the peek itself: keep it. */
  const hold = useCallback(() => {
    clearTimeout(timer.current);
    setHovered(true);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (blocked) dismiss(); }, [blocked, dismiss]);
  useDismissOnOutsideActivity(visible, exemptSelector, dismiss);
  return { visible, enter, leave, hold, dismiss };
}
