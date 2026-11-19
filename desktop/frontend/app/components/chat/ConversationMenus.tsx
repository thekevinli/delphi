"use client";

import { conversationStatus, type ConversationSummary } from "../../lib/conversation-session";

/** What a chat is doing while it is not on screen. */
export function ConversationActivity({ item }: { item: ConversationSummary }) {
  const state = conversationStatus(item);
  return state === "Answering" ? <svg className="conversation-activity running" viewBox="0 0 16 16" role="img" aria-label="Answering"><circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 5.2 3"/></svg>
    : state === "Answer failed" ? <span className="conversation-activity failed" role="img" aria-label="Answer failed">!</span>
    : null;
}

/** Expand and Hide: each window action is its own button, named on hover. */
export function ConversationWindowControls({ fullscreen, onExpand, onClose }: { fullscreen: boolean; onExpand?: () => void; onClose?: () => void }) {
  if (!onExpand && !onClose) return null;
  const expand = fullscreen ? "Collapse chat" : "Expand chat";
  return <div className="conversation-window-controls">
    {onExpand ? <button type="button" className="conversation-window-button" aria-label={expand} data-tip={expand} onClick={onExpand}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d={fullscreen ? "M9.5 2.5v4h4M6.5 13.5v-4h-4M9.5 6.5 14 2M6.5 9.5 2 14" : "M10 2.5h3.5V6M6 13.5H2.5V10M13.5 2.5 9 7M2.5 13.5 7 9"} /></svg>
    </button> : null}
    {onClose ? <button type="button" className="conversation-window-button" aria-label="Hide chat" data-tip="Hide chat" onClick={onClose}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M10 2.5v11M5.2 6.4 6.8 8l-1.6 1.6" /></svg>
    </button> : null}
  </div>;
}
