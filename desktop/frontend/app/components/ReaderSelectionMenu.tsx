"use client";

/** One selection toolbar for both document renderers. */
export function ReaderSelectionMenu({ x, y, onReply, onHighlight, onNote, preparing = false }: {
  x: number; y: number; onReply: () => void; onHighlight?: () => void; onNote?: () => void; preparing?: boolean;
}) {
  return <div className={`selection-menu${onNote ? " triple" : onHighlight ? "" : " single"}`} style={{ left: x, top: y }} role="toolbar" aria-label="Selected passage"
    onMouseDown={event => event.preventDefault()}>
    {onHighlight ? <button disabled={preparing} title={preparing ? "Preparing this passage…" : undefined} onClick={onHighlight}><HighlightIcon/><span>Highlight</span></button> : null}
    {onNote ? <button disabled={preparing} title={preparing ? "Preparing this passage…" : undefined} onClick={onNote}><NoteIcon/><span>Note</span></button> : null}
    <button onClick={onReply}><ReplyIcon/><span>Reply</span></button>
  </div>;
}

export function HighlightIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.6 2.9l3.5 3.5-6 6-4.1.6.6-4.1 6-6z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path d="M2.5 13.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function NoteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 2.6h7.2L13 5.4v8H3v-10.8z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M9.9 2.7v2.9H13"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M5.4 8.4h5.2M5.4 10.7h3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function ReplyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.6 7.2c0-2.3 2.4-4.1 5.4-4.1s5.4 1.8 5.4 4.1-2.4 4.2-5.4 4.2c-.6 0-1.2-.1-1.8-.2l-2.8 1.5.7-2.4c-.9-.8-1.5-1.8-1.5-3.1z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

