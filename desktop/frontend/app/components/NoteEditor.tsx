"use client";

/**
 * The note card: a formatting toolbar and a live-formatted body.
 *
 * Tiptap is loaded on the first note opened and never before. The reading
 * workspace is the hot path in this product — a reader who highlights and never
 * writes should not pay for an editor — which is the same argument that keeps
 * Mermaid out of everything but Memory.
 *
 * The stored value is markdown, produced by `lib/note-markdown`. This component
 * owns the editor and the keys; that module owns what a note *is*, and is
 * unit-tested without a DOM.
 */

import { useEffect, useRef, useState } from "react";

import { docToMarkdown, markdownToDoc, type Node } from "../lib/note-markdown";

type Engine = {
  useEditor: typeof import("@tiptap/react").useEditor;
  EditorContent: typeof import("@tiptap/react").EditorContent;
  StarterKit: typeof import("@tiptap/starter-kit").default;
  Link: typeof import("@tiptap/extension-link").default;
};

let enginePromise: Promise<Engine> | null = null;

/**
 * One shared promise, so opening a second note never re-imports and two notes
 * opened in the same tick do not race.
 */
function loadEngine(): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = Promise.all([
      import("@tiptap/react"),
      import("@tiptap/starter-kit"),
      import("@tiptap/extension-link"),
    ]).then(([react, starter, link]) => ({
      useEditor: react.useEditor,
      EditorContent: react.EditorContent,
      StarterKit: starter.default,
      Link: link.default,
    }));
  }
  return enginePromise;
}

export type NoteEditorProps = {
  /** Markdown the note already holds; empty for a note being written now. */
  value: string;
  /**
   * Every edit, as markdown. The card can be dismissed by clicking anywhere on
   * the page, and the handler that does it cannot ask this component for its
   * contents — so the contents come to it, or a click away would save the body
   * the editor mounted with and quietly discard everything typed since.
   */
  onChange: (body: string) => void;
  /** Save button, Enter, ⌘/Ctrl+Enter, or a click away with text in the body. */
  onSave: (body: string) => void;
  /** Escape, or a click away with an empty body. */
  onCancel: () => void;
  onDelete?: () => void;
};

const TOOLS = [
  { name: "bold", label: "Bold", hint: "⌘B", glyph: <strong>B</strong> },
  { name: "italic", label: "Italic", hint: "⌘I", glyph: <em>I</em> },
  { name: "code", label: "Code", hint: "⌘E", glyph: <CodeGlyph /> },
  { name: "bulletList", label: "Bullet list", hint: "- ", glyph: <ListGlyph /> },
  { name: "link", label: "Link", hint: "⌘K", glyph: <LinkGlyph /> },
] as const;

export default function NoteEditor(props: NoteEditorProps) {
  const [engine, setEngine] = useState<Engine | null>(null);

  useEffect(() => {
    let live = true;
    void loadEngine().then((loaded) => {
      if (live) setEngine(loaded);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!engine) {
    return (
      <div className="note-card note-card-loading" role="status">
        <span className="note-loading">Opening…</span>
      </div>
    );
  }
  return <MountedEditor engine={engine} {...props} />;
}

function MountedEditor({
  engine,
  value,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: NoteEditorProps & { engine: Engine }) {
  const { useEditor, EditorContent, StarterKit, Link } = engine;
  // Read through a ref inside the key handlers: the handlers are installed once
  // when the editor mounts, and a stale `onSave` would write the previous note.
  // Written in an effect rather than during render — a ref is not rendering
  // state, and the handlers cannot fire before an effect has run.
  const handlers = useRef({ onSave, onCancel, onChange });
  useEffect(() => {
    handlers.current = { onSave, onCancel, onChange };
  }, [onSave, onCancel, onChange]);
  // The key handlers are installed once, when the editor mounts, so they read
  // the editor through a ref rather than closing over it.
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const [, forceToolbar] = useState(0);

  const editor = useEditor({
    // The document is server data on a page the reader also edits, so leaving
    // this true would have React render one tree and the editor another.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ link: false, heading: { levels: [1, 2, 3] } }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        // A note body is reader-authored text that ends up in the DOM, and
        // Memory reads it back. Only addresses that go somewhere.
        protocols: ["http", "https", "mailto"],
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      }),
    ],
    content: markdownToDoc(value),
    autofocus: "end",
    editorProps: {
      attributes: { class: "note-body", "aria-label": "Note" },
      handleKeyDown(_view, event) {
        if (event.key === "Escape") {
          event.preventDefault();
          handlers.current.onCancel();
          return true;
        }
        // Keep Enter-to-save and Shift+Enter for a new block; the visible
        // shortcut also accepts Command/Control+Enter. IME confirmation must
        // finish composing text without submitting the note.
        if (event.isComposing) return false;
        if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          const doc = editorRef.current?.getJSON() as Node | undefined;
          handlers.current.onSave(docToMarkdown(doc ?? null));
          return true;
        }
        if (event.key === "Enter" && event.shiftKey) {
          // A block split rather than the default hard break. The two look the
          // same, but an input rule only fires at the start of a textblock, so
          // after a hard break typing "- " stays the literal characters — and
          // with Enter spoken for, a hard break would be the only line the
          // reader could ever make. Inside a list the split continues the list.
          const active = editorRef.current;
          if (!active) return false;
          event.preventDefault();
          if (active.isActive("listItem")) {
            active.chain().focus().splitListItem("listItem").run();
          } else {
            active.chain().focus().splitBlock().run();
          }
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: live }) =>
      handlers.current.onChange(docToMarkdown(live.getJSON() as Node)),
    onSelectionUpdate: () => forceToolbar((tick) => tick + 1),
    onTransaction: () => forceToolbar((tick) => tick + 1),
  });

  // Not held in state: `useEditor` already owns the instance and its teardown,
  // and this only gives the key handlers a way back to it.
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  if (!editor) return null;

  const run = (name: (typeof TOOLS)[number]["name"]) => {
    const chain = editor.chain().focus();
    if (name === "bold") chain.toggleBold().run();
    else if (name === "italic") chain.toggleItalic().run();
    else if (name === "code") chain.toggleCode().run();
    else if (name === "bulletList") chain.toggleBulletList().run();
    else {
      if (editor.isActive("link")) {
        chain.unsetLink().run();
        return;
      }
      const href = window.prompt("Link address");
      if (!href) return;
      // Refuse anything that is not a place, so a note body cannot smuggle a
      // javascript: URL past the extension's own allow-list.
      if (!/^(https?:|mailto:)/i.test(href)) return;
      chain.setLink({ href }).run();
    }
  };

  return (
    <div className="note-card note-card-editor" role="dialog" aria-label="Note">
      <EditorContent editor={editor} />
      <div className="note-toolbar" role="toolbar" aria-label="Formatting">
        {TOOLS.map((tool) => (
          <button
            key={tool.name}
            type="button"
            className={editor.isActive(tool.name) ? "is-active" : undefined}
            title={`${tool.label} (${tool.hint})`}
            aria-label={tool.label}
            aria-pressed={editor.isActive(tool.name)}
            // The editor must keep the caret: a toolbar button that stole focus
            // would collapse the selection it is about to format.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(tool.name)}
          >
            {tool.glyph}
          </button>
        ))}
        {onDelete ? (
          <>
            <span className="note-toolbar-divider" aria-hidden="true" />
            <button
              type="button"
              className="note-delete"
              title="Delete note"
              aria-label="Delete note"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onDelete}
            >
              <TrashGlyph />
            </button>
          </>
        ) : null}
        <div className="note-save-actions">
          <span className="note-save-hint" aria-hidden="true">⌘↵</span>
          <button
            type="button"
            className="note-save"
            title="Save note (⌘Enter)"
            aria-keyshortcuts="Meta+Enter Control+Enter"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSave(docToMarkdown(editor.getJSON() as Node))}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function CodeGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
    </svg>
  );
}

function ListGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6 4h8M6 8h8M6 12h8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="2.8" cy="4" r="1" fill="currentColor" />
      <circle cx="2.8" cy="8" r="1" fill="currentColor" />
      <circle cx="2.8" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

function LinkGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.6 9.4a2.6 2.6 0 010-3.7l2-2a2.6 2.6 0 013.7 3.7l-.9.9M9.4 6.6a2.6 2.6 0 010 3.7l-2 2a2.6 2.6 0 01-3.7-3.7l.9-.9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8M6.8 7v3.5M9.2 7v3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
