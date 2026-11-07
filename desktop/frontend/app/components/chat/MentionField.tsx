"use client";

/**
 * The `@`-mention editor, and the menu that fills it.
 *
 * This is a `contenteditable` rather than a `<textarea>` because a mention is
 * painted as one uneditable chip while the reader types. It used to live
 * inside `ChatPanel`, which meant the floating `AskComposer` — the surface
 * where most first questions are actually written — had a plain textarea and
 * silently dropped the feature. One editor, mounted in both, is the fix; the
 * pure half of the rules is still `lib/composer-draft.ts`.
 *
 * **What may be mentioned is the caller's decision, not this component's.**
 * `papers` and `images` arrive already scoped: a Document or Project question
 * may reference the project's other documents, an account-wide one may not —
 * there is no project to resolve a reference against and the server refuses
 * one there, so offering the menu would be offering a reference that cannot
 * exist. Images are reusable in every scope. `tabs` follows from that, and a
 * single tab renders no tab strip at all: a chooser with one option is a label
 * pretending to be a control.
 *
 * The draft lives here and is reported upward, rather than being passed down.
 * Painting is deliberately *not* driven by comparing the value to the DOM —
 * a repaint mid-keystroke moves the caret — so it happens only when this
 * component (or its owner, through the handle) has just rewritten the text.
 */

import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from "react";

import type { ChatImage, Paper } from "../../lib/api";
import {
  draftTokens,
  isResolvedPaperMention,
  paperMentionAt,
  splitComposerDraft,
  type PaperMention,
} from "../../lib/composer-draft";
import { paperMark } from "../../lib/paper-kind";
import { paperMentionToken } from "../../lib/paper-mention";
import { KindMark } from "../KindMark";
import { sideCommand } from "../../lib/side-chat";

export type MentionTab = "papers" | "images";

/** What the owner may do to a draft it does not hold. */
export type MentionFieldHandle = {
  /** Empty it — what send does. */
  clear: () => void;
  focus: () => void;
  /** Drop one painted token, for a chip removed from outside the editor. */
  removeToken: (token: string) => void;
};

export function composerText(node: HTMLDivElement): string {
  return node.innerText.replaceAll("\u00a0", " ").replaceAll("\r", "");
}

function clipboardImages(clipboard: DataTransfer): File[] {
  return Array.from(clipboard.files).filter((file) =>
    file.type.startsWith("image/"),
  );
}

/**
 * contenteditable's default paste inserts the HTML flavour. The draft is
 * `innerText`, so a Docs/browser paste left markup on screen and different
 * words in the prompt. Images still take the attach path; everything else
 * is forced through `text/plain`.
 */
export function handleComposerPaste(
  event: ClipboardEvent<HTMLDivElement>,
  editor: HTMLDivElement | null,
  onImages: (files: File[]) => void,
) {
  const images = clipboardImages(event.clipboardData);
  if (images.length) {
    event.preventDefault();
    onImages(images);
    return;
  }
  if (!editor || !editor.contains(event.target as Node)) return;
  event.preventDefault();
  const text = event.clipboardData
    .getData("text/plain")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  if (text) document.execCommand("insertText", false, text);
}

function composerCursorOffset(node: HTMLDivElement): number | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.anchorNode) return null;
  if (!node.contains(selection.anchorNode)) return null;
  const range = document.createRange();
  range.selectNodeContents(node);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
}

function setComposerCursor(node: HTMLDivElement, offset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let textNode = walker.nextNode();
  while (textNode) {
    const length = textNode.textContent?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(textNode, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
    textNode = walker.nextNode();
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function paintComposerDraft(
  node: HTMLDivElement,
  text: string,
  papers: Paper[],
  images: ChatImage[] = [],
) {
  // `:empty::before` is the placeholder. A leftover empty text node is a
  // child, so send has to leave the editor with no children at all.
  if (!text) {
    node.replaceChildren();
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const piece of splitComposerDraft(text, draftTokens(papers, images))) {
    if (piece.kind === "text") {
      fragment.append(piece.value);
      continue;
    }
    const mark = document.createElement("mark");
    mark.className = "inline-paper-mention";
    mark.contentEditable = "false";
    mark.dataset.composerToken = piece.value;
    mark.textContent = piece.value;
    fragment.append(mark);
  }
  node.replaceChildren(fragment);
}

export function MentionField({
  handleRef,
  papers,
  images,
  paintPapers,
  paintImages,
  tabs,
  imageUrl,
  brokenImageIds,
  onImageBroken,
  placeholder,
  disabled = false,
  autoFocus = false,
  initialDraft = "",
  className = "",
  onDraftChange,
  onPaperMention,
  onImageMention,
  onSubmit,
  onPasteImages,
  expiryNote,
  commands,
  onCommand,
}: {
  handleRef?: Ref<MentionFieldHandle | null>;
  /** The documents this scope may reference. Empty hides the Documents tab. */
  papers: Paper[];
  /** The images already uploaded to this conversation. */
  images: ChatImage[];
  /** Which tokens are painted as chips — a superset of what may be inserted. */
  paintPapers: Paper[];
  paintImages: ChatImage[];
  tabs: MentionTab[];
  imageUrl: (imageId: string, variant: "image" | "thumbnail") => string;
  brokenImageIds?: Set<string>;
  onImageBroken?: (imageId: string) => void;
  /** What the empty field says; a `backticked` part is set in the code face. */
  placeholder: string;
  disabled?: boolean;
  /** A contenteditable takes no `autofocus` attribute; this focuses it once. */
  autoFocus?: boolean;
  /**
   * The text to paint on mount. Editing a sent question uses this so the
   * `@` chips come back as chips rather than as the raw token string.
   */
  initialDraft?: string;
  className?: string;
  onDraftChange: (draft: string) => void;
  onPaperMention: (paper: Paper) => void;
  /** Returning false refuses the insertion — the attachment limit is the case. */
  onImageMention: (image: ChatImage) => boolean | void;
  onSubmit: () => void;
  onPasteImages?: (files: File[]) => void;
  expiryNote?: (expiresAt: string) => string | null;
  /** Slash commands this composer offers, shown while the draft is only `/` and the start of one. */
  commands?: readonly { name: string; hint: string }[];
  onCommand?: (name: string) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  // A command menu Escape dismissed stays closed until the draft stops being a command.
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [mention, setMention] = useState<PaperMention | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionTab, setMentionTab] = useState<MentionTab>(tabs[0] ?? "images");
  /* A context switch can take a tab away underneath the reader — General has
     no documents to offer — so the stored choice is a preference and the
     rendered one is always a tab that still exists. */
  const activeTab = tabs.includes(mentionTab) ? mentionTab : (tabs[0] ?? "images");
  const command = commands?.length && onCommand && !mention && !commandDismissed && sideCommand(draft).menu ? commands[0] : null;

  const nodeRef = useRef<HTMLDivElement>(null);
  // Odd parts were backticked: the code face, mid-sentence, which a pseudo-element cannot mix.
  const placeholderParts = placeholder.split("`");
  const placeholderText = placeholderParts.join("");
  const listRef = useRef<HTMLDivElement>(null);
  /* A mention insertion rewrites the whole draft under a caret sitting inside
     it; preserve the text offset so the caret never jumps. */
  const pendingComposerCursorRef = useRef<number | null>(null);
  const pendingComposerPaintRef = useRef(false);
  const composingRef = useRef(false);

  const paperOptions = mention
    ? papers.filter(
        (item) =>
          !mention.query || item.title.toLowerCase().includes(mention.query),
      )
    : [];
  const imageOptions = mention
    ? images.filter(
        (image) =>
          !mention.query ||
          `image #${image.number}`.includes(mention.query.replace(/[\[\]]/g, "")),
      )
    : [];
  const options: Array<Paper | ChatImage> =
    activeTab === "papers" ? paperOptions : imageOptions;

  /* An empty tab says why, and what would fill it. A filter that matched
     nothing is a different fact from a project with nothing else in it. */
  const emptyState =
    activeTab === "papers"
      ? mention?.query
        ? { title: "No documents match", hint: "Keep typing, or clear the search." }
        : {
            title: "No other documents here",
            hint: "Add one to this project to mention it.",
          }
      : mention?.query
        ? { title: "No images match", hint: "Images are named by their number." }
        : {
            title: "No images in this chat",
            hint: "Paste or attach one to mention it.",
          };

  /* The arrow keys can walk past the fold of a long list; the highlighted row
     is the one Enter takes, so it has to be on screen. */
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !row) return;
    /* By hand rather than `scrollIntoView`, which would also scroll the
       transcript behind a menu that is only partly on screen. */
    const above = row.offsetTop - list.offsetTop - 4;
    const below = above + row.offsetHeight + 8 - list.clientHeight;
    if (above < list.scrollTop) list.scrollTop = above;
    else if (below > list.scrollTop) list.scrollTop = below;
  }, [mentionIndex, activeTab]);

  useImperativeHandle(
    handleRef,
    () => ({
      clear: () => {
        pendingComposerPaintRef.current = true;
        pendingComposerCursorRef.current = null;
        setDraft("");
        setMention(null);
        setCommandDismissed(false);
        onDraftChange("");
      },
      focus: () => nodeRef.current?.focus(),
      removeToken: (token: string) => {
        pendingComposerPaintRef.current = true;
        pendingComposerCursorRef.current = null;
        setDraft((value) => {
          const next = value.replace(token, "").replace(/ {2,}/g, " ");
          onDraftChange(next);
          return next;
        });
      },
    }),
    [onDraftChange],
  );

  useEffect(() => {
    if (autoFocus) nodeRef.current?.focus();
    // Once, on mount: re-focusing on every change would fight the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (!initialDraft) return;
    pendingComposerPaintRef.current = true;
    pendingComposerCursorRef.current = initialDraft.length;
    // Mount only: a later prop change is the owner typing, which this
    // field already holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node || !pendingComposerPaintRef.current) return;
    pendingComposerPaintRef.current = false;
    paintComposerDraft(node, draft, paintPapers, paintImages);
    const cursor = pendingComposerCursorRef.current;
    pendingComposerCursorRef.current = null;
    if (cursor === null) return;
    node.focus();
    setComposerCursor(node, cursor);
  }, [draft, paintImages, paintPapers]);

  // The `@` Escape dismissed stays closed until the caret leaves it.
  const dismissedRef = useRef<number | null>(null);
  const updateMention = (value: string, cursor: number | null) => {
    let nextMention = paperMentionAt(value, cursor ?? value.length);
    if (nextMention?.start !== dismissedRef.current) dismissedRef.current = null;
    else nextMention = null;
    if (nextMention && !mention) setMentionTab(tabs[0] ?? "images");
    setMention(
      nextMention && !isResolvedPaperMention(value, nextMention, paintPapers)
        ? nextMention
        : null,
    );
    setMentionIndex(0);
  };

  const syncDraft = (node: HTMLDivElement) => {
    if (composingRef.current) return;
    const value = composerText(node);
    const cursor = composerCursorOffset(node);
    setDraft(value);
    onDraftChange(value);
    updateMention(value, cursor);
    if (!value.startsWith("/")) setCommandDismissed(false);
  };

  /**
   * Splice a token in where the `@` was.
   *
   * A mention enters the sentence as a word: even at the end of the draft it
   * leaves an ordinary, independently deletable space ready for what follows.
   */
  const insertToken = (token: string) => {
    if (!mention) return;
    const trailingText = draft.slice(mention.end);
    const spacer = /^\s/.test(trailingText) ? "" : " ";
    const cursorSpace = spacer.length || Number(trailingText.startsWith(" "));
    const nextDraft = draft.slice(0, mention.start) + token + spacer + trailingText;
    const nextCursor = mention.start + token.length + cursorSpace;
    pendingComposerPaintRef.current = true;
    pendingComposerCursorRef.current = nextCursor;
    setDraft(nextDraft);
    onDraftChange(nextDraft);
    setMention(null);
  };

  const selectPaper = (item: Paper | undefined) => {
    if (!item) return;
    onPaperMention(item);
    insertToken(paperMentionToken(item.title));
  };

  const selectImage = (item: ChatImage | undefined) => {
    if (!item) return;
    if (onImageMention(item) === false) return;
    insertToken(`@[Image #${item.number}]`);
  };

  return (
    <>
      {command ? (
        <div className="mention-menu command-menu" id="composer-command-options" role="listbox" aria-label="Commands">
          <div className="mention-list">
            <button
              type="button"
              role="option"
              aria-selected="true"
              className="active command-option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onCommand?.(command.name)}
            >
              <span className="command-icon" aria-hidden="true">
                <svg width="15" height="15" viewBox="0 0 16 16"><rect x="1.8" y="2.5" width="12.4" height="11" rx="2" /><path d="M9.6 2.5v11" /></svg>
              </span>
              <span className="command-text"><b>{command.name}</b><span>{command.hint}</span></span>
              <ReturnHint />
            </button>
          </div>
        </div>
      ) : null}
      {mention ? (
        <div
          className="mention-menu"
          id="paper-mention-options"
          role="listbox"
          aria-label={
            tabs.length > 1 ? "Reference a document or image" : "Reference an image"
          }
        >
          {tabs.length > 1 ? (
            <div className="mention-tabs" role="tablist" aria-label="Kind">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab}
                  className={activeTab === tab ? "active" : ""}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setMentionTab(tab);
                    setMentionIndex(0);
                  }}
                >
                  {tab === "papers" ? "Documents" : "Images"}
                  <span className="mention-tab-count">
                    {tab === "papers" ? paperOptions.length : imageOptions.length}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {options.length ? (
            <div className="mention-list" ref={listRef}>
              {activeTab === "papers"
                ? paperOptions.map((item, index) => (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={index === mentionIndex}
                      className={index === mentionIndex ? "active" : ""}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => setMentionIndex(index)}
                      onClick={() => selectPaper(item)}
                    >
                      {/* The title is the row. Its ordinal and source line were a
                          second and third thing to read before the one that
                          decides the pick; the mark alone says web or PDF. */}
                      <span className="mention-kind">
                        <KindMark kind={paperMark(item)} labelled />
                      </span>
                      <span className="mention-title">{item.title}</span>
                      {index === mentionIndex ? <ReturnHint /> : null}
                    </button>
                  ))
                : imageOptions.map((item, index) => {
                    const expiring = expiryNote?.(item.expiresAt) ?? null;
                    const broken = brokenImageIds?.has(item.id) ?? false;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={index === mentionIndex}
                        className={`image-option ${
                          index === mentionIndex ? "active" : ""
                        }`.trim()}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => {
                          const preview = new Image();
                          preview.src = imageUrl(item.id, "image");
                        }}
                        onMouseMove={() => setMentionIndex(index)}
                        onClick={() => selectImage(item)}
                      >
                        {broken ? (
                          <span className="mention-thumb-broken" aria-hidden="true" />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={imageUrl(item.id, "thumbnail")}
                            alt=""
                            onError={() => onImageBroken?.(item.id)}
                          />
                        )}
                        <span className="mention-title">Image #{item.number}</span>
                        {/* Only a warning earns a second word: the thumbnail
                            already says which image it is. */}
                        {broken ? (
                          <span className="mention-note">Unavailable</span>
                        ) : expiring ? (
                          <span className="mention-note">{expiring}</span>
                        ) : null}
                        {index === mentionIndex ? <ReturnHint /> : null}
                      </button>
                    );
                  })}
            </div>
          ) : (
            <div className="mention-empty">
              <b>{emptyState.title}</b>
              <span>{emptyState.hint}</span>
            </div>
          )}
        </div>
      ) : null}
      <div className="composer-editor">
        <div
          ref={nodeRef}
          className={`composer-input ${className}`.trim()}
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-label={placeholderText}
          aria-placeholder={placeholderText}
          aria-multiline="true"
          aria-disabled={disabled}
          aria-autocomplete="list"
          aria-controls={command ? "composer-command-options" : mention ? "paper-mention-options" : undefined}
          aria-haspopup="listbox"
          data-placeholder={placeholderText}
          data-placeholder-code={placeholderParts.length > 1 ? "" : undefined}
          onInput={(event: FormEvent<HTMLDivElement>) =>
            syncDraft(event.currentTarget)
          }
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            syncDraft(event.currentTarget);
          }}
          onPaste={
            onPasteImages
              ? (event: ClipboardEvent<HTMLDivElement>) => {
                  /* Handled here in full, so an owner that also listens on the
                     card around this editor does not attach the same pasted
                     image a second time. */
                  event.stopPropagation();
                  handleComposerPaste(event, nodeRef.current, onPasteImages);
                }
              : undefined
          }
          onPointerUp={(event) =>
            updateMention(
              composerText(event.currentTarget),
              composerCursorOffset(event.currentTarget),
            )
          }
          onKeyUp={(event) => {
            /* Escape's own key-up would otherwise find the menu closed and the
               caret still after an `@`, and open it again. */
            if (!mention && event.key !== "Escape") {
              updateMention(
                composerText(event.currentTarget),
                composerCursorOffset(event.currentTarget),
              );
            }
          }}
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            if (command && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !composingRef.current) {
              event.preventDefault();
              onCommand?.(command.name);
              return;
            }
            if (command && event.key === "Escape") {
              event.preventDefault();
              setCommandDismissed(true);
              return;
            }
            if (mention && tabs.length > 1 &&
                (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
              event.preventDefault();
              setMentionTab((current) =>
                current === "papers" ? "images" : "papers",
              );
              setMentionIndex(0);
              return;
            }
            if (mention && options.length) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setMentionIndex((index) => (index + 1) % options.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setMentionIndex(
                  (index) => (index - 1 + options.length) % options.length,
                );
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                if (activeTab === "papers") {
                  selectPaper(paperOptions[mentionIndex] ?? paperOptions[0]);
                } else {
                  selectImage(imageOptions[mentionIndex] ?? imageOptions[0]);
                }
                return;
              }
            }
            if (event.key === "Escape" && mention) {
              event.preventDefault();
              dismissedRef.current = mention.start;
              setMention(null);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !composingRef.current) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        {placeholderParts.length > 1 ? (
          <span className="composer-placeholder" aria-hidden="true">
            {placeholderParts.map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part))}
          </span>
        ) : null}
      </div>
    </>
  );
}

/** Enter takes the highlighted row; the row that will be taken says so. */
function ReturnHint() {
  return (
    <span className="mention-return" aria-hidden="true">
      ↵
    </span>
  );
}
