"use client";

/**
 * A draggable column edge.
 *
 * Two properties are worth keeping in mind before touching this. The drag
 * writes a CSS custom property straight onto the grid parent inside a rAF and
 * only tells React once it is let go, because re-rendering a reader panel on every
 * pointer move is what made the divider feel heavy. And the parent gets
 * `is-panel-resizing` for the duration, which is how a grid that animates its
 * own `grid-template-columns` stops fighting the drag — without it the columns
 * chase the pointer 340ms behind it.
 *
 * The minimum and maximum live in the `constrain` callback rather than in CSS,
 * because a pixel floor a window is too narrow for does not widen the window,
 * it overflows the grid (invariant 31).
 *
 * The drag follows the pointer, not the divider (`followPointer`): waiting for
 * the divider's own pointerup left the grid resizing after a release it never
 * heard, the edge chasing a mouse no longer pressed, and the panels, which take
 * no pointer while a resize runs, unable to be clicked.
 */

import { useEffect, useRef } from "react";
import { followPointer } from "../lib/pointer-gesture";

export function PanelDivider({
  side,
  cssVar,
  label,
  value,
  min,
  max,
  constrain,
  onChange,
  onReset,
  className = "",
}: {
  /** Which way a positive drag widens the panel this divider belongs to. */
  side: "left" | "right";
  /**
   * The custom property the drag writes on the grid parent.
   *
   * A parameter rather than a name derived from `side`, because "which
   * direction does this widen" and "which track does it widen" are two facts,
   * and the second one stopped being guessable the moment a second grid grew a
   * divider.
   */
  cssVar: string;
  label: string;
  value: number;
  min: number;
  max: number;
  constrain: (width: number) => number;
  onChange: (width: number) => void;
  /** A double-click puts the panel back at its opening width. */
  onReset?: () => void;
  className?: string;
}) {
  // Abandons a drag still under way, should the divider unmount mid-drag: the
  // pointer is no longer followed, and the grid takes the pointer again.
  const abandonRef = useRef<(() => void) | null>(null);
  useEffect(() => () => abandonRef.current?.(), []);

  return (
    <div
      className={`panel-divider panel-divider-${side} ${className}`.trim()}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const panels = event.currentTarget.parentElement;
        if (!panels) return;
        panels.classList.add("is-panel-resizing");
        const drag = { x: event.clientX, width: value, pendingWidth: value, frame: null as number | null };
        const paint = () => {
          drag.frame = null;
          panels.style.setProperty(cssVar, `${drag.pendingWidth}px`);
        };
        const settle = () => {
          abandonRef.current = null;
          if (drag.frame !== null) cancelAnimationFrame(drag.frame);
          panels.classList.remove("is-panel-resizing");
        };
        const stop = followPointer(event.nativeEvent, event.currentTarget, {
          move: (move) => {
            const movement = move.clientX - drag.x;
            drag.pendingWidth = constrain(
              drag.width + (side === "left" ? movement : -movement),
            );
            if (drag.frame === null) drag.frame = requestAnimationFrame(paint);
          },
          end: () => {
            settle();
            paint();
            onChange(drag.pendingWidth);
            window.dispatchEvent(new Event("delphi-panel-resize-end"));
          },
        });
        abandonRef.current = () => {
          stop();
          settle();
        };
      }}
      onKeyDown={(event) => {
        if (event.key === "Home") {
          event.preventDefault();
          onChange(constrain(min));
          return;
        }
        if (event.key === "End") {
          event.preventDefault();
          onChange(constrain(max));
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const movement = event.key === "ArrowRight" ? 16 : -16;
        onChange(
          constrain(value + (side === "left" ? movement : -movement)),
        );
      }}
    />
  );
}
