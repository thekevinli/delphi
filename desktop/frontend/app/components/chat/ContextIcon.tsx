"use client";

/**
 * The mark for each chat context, drawn from what the scope actually is: a
 * stack for the **Project** conversation — the open document with the rest of
 * its project behind it — and the Memory mark for **Memory**, the same mark
 * the Memory view and the Ask control use, so the widest scope is the one
 * already associated with the whole account. The scope menus show the
 * context's name beside it.
 */

import type { ChatContext } from "../../lib/chat-scope";

export function ContextIcon({ context }: { context: ChatContext }) {
  if (context === "document") {
    /* A stack, and drawn back-to-front so the sheets overlap the way a pile
       does — two outlines side by side read as two documents, not as one
       collection of them. */
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="chat-scope-icon">
        <path
          d="M6.2 1.9h3.1l2.4 2.4V4.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
          opacity="0.55"
        />
        <path
          d="M12 4.6v6.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          opacity="0.55"
        />
        <path
          d="M3.6 4.4h4.2l2.6 2.6v6.3a.8.8 0 0 1-.8.8H3.6a.8.8 0 0 1-.8-.8V5.2a.8.8 0 0 1 .8-.8Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path
          d="M7.6 4.6v2.6h2.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  /* The Memory mark, matching the wiki and the Ask control: the widest
     scope is the one already associated with the whole account. */
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="chat-scope-icon">
      <circle cx="10" cy="4.4" r="2.1" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <circle cx="4.6" cy="14" r="2.1" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <circle cx="15.4" cy="14" r="2.1" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path
        d="M8.6 6.2 6 12.1m5.4-5.9 2.6 5.9M6.7 14.6h6.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
