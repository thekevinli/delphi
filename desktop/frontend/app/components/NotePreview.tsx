"use client";

/**
 * A note, read rather than edited.
 *
 * Opening a note used to mean opening the editor, which put a caret in the
 * reader's own sentence every time they glanced at what they had written — and
 * on a page they are reading, glancing is the common case and editing is the
 * rare one. A click shows this; the pencil or a double click loads `NoteEditor`.
 *
 * It renders the stored markdown through `markdownToDoc`, the same parser the
 * editor seeds itself from, so the two cannot disagree about what a note says.
 * Deliberately no Tiptap: reading a note must not pay for an editor, which is
 * the same argument that keeps the editor itself behind a lazy import.
 */

import type { JSX } from "react";

import { markdownToDoc, type Node } from "../lib/note-markdown";

export default function NotePreview({
  body,
  onEdit,
  onDelete,
}: {
  body: string;
  /** The pencil and double-clicking the card both enter the existing editor. */
  onEdit: () => void;
  /** Deletes the note and the stroke it hangs off, as the editor's does. */
  onDelete: () => void;
}) {
  const doc = markdownToDoc(body);
  return (
    <div
      className="note-card note-card-preview"
      onDoubleClick={onEdit}
      role="dialog"
      aria-label="Note"
    >
      <div className="note-body">{renderBlocks(doc.content)}</div>
      <div className="note-toolbar note-preview-toolbar">
        <button
          type="button"
          className="note-delete"
          title="Delete note"
          aria-label="Delete note"
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <TrashGlyph />
        </button>
        <button type="button" className="note-edit" aria-label="Edit note" title="Edit note (or double-click the note)"
          onDoubleClick={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); onEdit(); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function TrashGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function renderBlocks(nodes: Node[] | undefined): JSX.Element[] {
  return (nodes ?? []).map((node, index) => {
    const key = `${node.type}-${index}`;
    if (node.type === "bulletList") {
      return <ul key={key}>{renderItems(node.content)}</ul>;
    }
    if (node.type === "orderedList") {
      return <ol key={key}>{renderItems(node.content)}</ol>;
    }
    if (node.type === "codeBlock") {
      return (
        <pre key={key}>
          <code>{plainText(node.content)}</code>
        </pre>
      );
    }
    if (node.type === "heading") {
      // A note is a margin note, so its headings are emphasis rather than
      // document structure — rendering an <h1> inside a card would put a
      // 44px line in a 268px box and claim an outline level it does not have.
      return (
        <p key={key}>
          <strong>{renderInline(node.content)}</strong>
        </p>
      );
    }
    return <p key={key}>{renderInline(node.content)}</p>;
  });
}

function renderItems(nodes: Node[] | undefined): JSX.Element[] {
  return (nodes ?? []).map((item, index) => (
    <li key={`item-${index}`}>{renderInline(item.content?.[0]?.content)}</li>
  ));
}

function plainText(nodes: Node[] | undefined): string {
  return (nodes ?? []).map((node) => node.text ?? "").join("");
}

function renderInline(nodes: Node[] | undefined): Array<JSX.Element | string> {
  return (nodes ?? []).map((node, index) => {
    const key = `inline-${index}`;
    if (node.type === "hardBreak") return <br key={key} />;
    let content: JSX.Element | string = node.text ?? "";
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") content = <strong key={key}>{content}</strong>;
      else if (mark.type === "italic") content = <em key={key}>{content}</em>;
      else if (mark.type === "strike") content = <s key={key}>{content}</s>;
      else if (mark.type === "code") content = <code key={key}>{content}</code>;
      else if (mark.type === "link") {
        const href = String(mark.attrs?.href ?? "");
        // The same allow-list the editor enforces when a link is made. A stored
        // body is reader-authored text that has been through a round trip, and
        // the anchor is the one place a `javascript:` URL would become live.
        content = /^(https?:|mailto:)/i.test(href) ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {content}
          </a>
        ) : (
          content
        );
      }
    }
    return typeof content === "string" ? (
      <span key={key}>{content}</span>
    ) : (
      content
    );
  });
}

/** Shared read-only markdown for the annotation list. */
export function NoteBody({ body }: { body: string }) {
  return <div className="note-body">{renderBlocks(markdownToDoc(body).content)}</div>;
}
