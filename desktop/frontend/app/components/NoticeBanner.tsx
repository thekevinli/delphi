import type { ReactNode } from "react";

export type NoticeTone = "info" | "warning" | "danger";

const TONE_ICONS: Record<NoticeTone, string> = {
  info: "i",
  warning: "!",
  danger: "!",
};

/**
 * A transient message that lands at the top of the viewport.
 *
 * The caller owns visibility so dismissal can participate in feature-specific
 * state. When `onDismiss` is present the entire surface is a button, preserving
 * the generous click target without making a non-interactive notice pretend to
 * be interactive.
 */
export function NoticeBanner({
  title,
  tone = "info",
  children,
  onDismiss,
}: {
  title: string;
  tone?: NoticeTone;
  children: ReactNode;
  onDismiss?: () => void;
}) {
  const content = (
    <>
      <span className="notice-banner-icon" aria-hidden="true">
        {TONE_ICONS[tone]}
      </span>
      <span className="notice-banner-copy">
        <strong>{title}</strong>
        {children}
      </span>
      {onDismiss ? (
        <span className="notice-banner-dismiss" aria-hidden="true">
          ×
        </span>
      ) : null}
    </>
  );
  const className = `notice-banner notice-banner-${tone}`;

  return (
    <aside
      className="notice-banner-region"
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
      aria-atomic="true"
    >
      {onDismiss ? (
        <button
          type="button"
          className={className}
          onClick={onDismiss}
          title="Dismiss this message"
        >
          {content}
        </button>
      ) : (
        <div className={className}>{content}</div>
      )}
    </aside>
  );
}
