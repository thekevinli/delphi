/**
 * The pieces every notification shares.
 *
 * A notice is one off-white card — the same surface as the Home cards — whose
 * mark carries its state: the climb while work runs, the sunrise when it is
 * done, the alert when it needs the reader. The mark sits in a small rounded
 * tile tinted for that state, so the colour says the same thing as the
 * animation without the card itself changing colour. The chrome lives in
 * `globals.css` under "Notifications"; this file is the vocabulary.
 */

import { useState } from "react";
import { createPortal } from "react-dom";

export type NoticeState = "running" | "done" | "attention" | "info";

export const MARKS: Record<NoticeState, string> = {
  running: "/brand/animations/delphi-loading-climb.gif",
  done: "/brand/animations/delphi-loading-sunrise.gif",
  attention: "/brand/animations/delphi-warning-alert.gif",
  // A proposal waiting on the reader: nothing is wrong and nothing is
  // running, so it rises like a finished thing on a neutral tile.
  info: "/brand/animations/delphi-loading-sunrise.gif",
};

/** The state mark, in its tinted tile. `size="small"` is the shrunk pill's. */
export function NoticeMark({
  state,
  size = "regular",
}: {
  state: NoticeState;
  size?: "regular" | "small";
}) {
  return (
    <span
      className={`notice-mark notice-mark-${state}${size === "small" ? " is-small" : ""}`}
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={MARKS[state]} alt="" />
    </span>
  );
}

/**
 * A one-line message at the bottom of the window.
 *
 * Two kinds, decided by the caller. A plain string is an error or a failed
 * action — it stays, with a warning mark, until the reader dismisses it,
 * because a failure that vanishes before it is read has not been reported.
 * `hint(...)` is guidance or a small success: it leaves on its own after a few
 * seconds (paused while hovered), and pressing it dismisses it sooner.
 */
export type ToastTone = "hint" | "error";
export type Notice = string | { message: string; tone: ToastTone };

export function hint(message: string): Notice {
  return { message, tone: "hint" };
}

export function noticeText(notice: Notice): string {
  return typeof notice === "string" ? notice : notice.message;
}

function noticeTone(notice: Notice): ToastTone {
  return typeof notice === "string" ? "error" : notice.tone;
}

export function Toast({
  notice,
  onDismiss,
}: {
  notice: Notice;
  onDismiss: () => void;
}) {
  // Each notice sent is shown afresh: the same hint again starts its life over.
  const [shown, setShown] = useState(notice);
  const [turn, setTurn] = useState(0);
  if (shown !== notice) { setShown(notice); setTurn(turn + 1); }
  const message = noticeText(notice);
  if (!message) return null;
  if (noticeTone(notice) === "hint") {
    return (
      <button
        key={turn}
        type="button"
        className="toast toast-hint"
        role="status"
        aria-live="polite"
        onClick={onDismiss}
        // The lifetime is a CSS animation, so hovering pauses it for free and
        // the timing lives beside the rest of the toast's styling.
        onAnimationEnd={(event) => {
          if (event.animationName === "toast-hint-life") onDismiss();
        }}
      >
        <span className="toast-message">{message}</span>
      </button>
    );
  }
  return (
    <div key={turn} className="toast toast-error" role="alert" aria-live="assertive">
      <svg className="toast-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 8v5M12 16.5v.5" />
        <path d="M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </svg>
      <span className="toast-message">{message}</span>
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={onDismiss}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}

/** The toast, for a view inside a transformed or clipped pane: drawn on the window, where `position: fixed` holds. */
export function WindowToast(props: { notice: Notice; onDismiss: () => void }) {
  return createPortal(<Toast {...props} />, document.body);
}
