"use client";

/**
 * The composer that floats up from the bottom of whatever is on screen.
 *
 * It is deliberately not a panel: it opens over the page the reader is
 * already on, takes one question, and hands it to the docked surface. That is
 * why it grows out of a pill (`kb-composer-morph-in`) rather than sliding in
 * from an edge — the animation says "this is the button you pressed", not
 * "a new region has appeared".
 *
 * Where it is opened decides what it asks: over a document, that document's
 * Project chat; anywhere else, Memory, whose answer is read on the Memory
 * chat page. An image attachment is staged locally until send, because the
 * number it will wear lives on a conversation this card has not made yet.
 *
 * The field itself is the docked chat's own `MentionField`, not a textarea.
 * It was a textarea for one release and that quietly dropped `@` here — the
 * surface where most first questions are written — so the reader could only
 * reference another document by opening the rail and asking again.
 *
 * While it is up it owns every file drag, the same way the backdrop already
 * owns clicks: images attach, a PDF is swallowed. Dismiss it to add a paper.
 */

import { conversationsChanged, conversationQuery } from "./ConversationRail";
import type { ConversationCatalog, ConversationSummary } from "../../lib/conversation-session";
import { ModeTag } from "./ModeTag";
import { ChatMode, nextChatMode, isModeShortcut } from "../../lib/chat-mode";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  API_BASE,
  api,
  type AppConfig,
  type ChatImage,
  type ComposerChoice,
  type Paper,
  type PersonaSummary,
} from "../../lib/api";
import {
  chatQuery,
  COMPOSER_HINT,
  COMPOSER_PLACEHOLDER,
  DOCUMENT_MENTION_HINT,
  IMAGE_HINT,
  PAGE_MENTION_HINT,
  type ChatContext,
  type ChatTarget,
} from "../../lib/chat-scope";
import { useCyclingHint } from "../../lib/cycling-hint";
import { imageDropHint, isAcceptedImageFile } from "../../lib/file-drag";
import { useCoveringFileDrop } from "../../lib/use-file-drop";
import {
  ComposerToggle,
  EFFORT_LABELS,
  modelLabel,
  ModelPill,
  PersonaPill,
} from "../ChatBits";
import { MentionField, type MentionFieldHandle, type MentionTab } from "./MentionField";
import { expandPaperMentionTokens } from "../../lib/paper-mention";
import { draftTokens, keptMentions } from "../../lib/composer-draft";
import { hint, type Notice } from "../Notice";
import { holdMemoryAsk } from "../../lib/memory";
import { NAMED_PAGES_MAX, type MentionPage } from "../../lib/recently-filed";

export type AskDraft = {
  conversation: ConversationSummary;
  requestId: string;
  prompt: string;
  imageIds: string[];
  /** Documents `@`-mentioned in the question, so the surface can attach them. */
  referencedPaperIds: string[];
  /** Memory pages `@`-mentioned in a Memory question. */
  referencedPages: Array<{ slug: string; title: string }>;
  context: ChatContext;
  /** The passage Reply was pressed on, if the composer was opened by one. */
  selectedText: string;
  /**
   * The persona its pill was showing.
   *
   * The composer offers the choice, so the choice has to travel with the
   * question. Without this the draft pick was simply dropped at send and the
   * conversation answered as whatever it already held.
   */
  personaId: string;
  /** Chat or Plan, the model, effort and web search, for the same reason. */
  choice: ComposerChoice;
};

/**
 * Hold a Memory question for the Memory chat page, which asks it, and say
 * where that is. The composer's box goes with it, so the page's composer can
 * come from where this one stood.
 */
export function handOffToMemory(draft: AskDraft): string {
  const box = document.querySelector(".kb-composer-card")?.getBoundingClientRect();
  holdMemoryAsk({
    prompt: draft.prompt, imageIds: draft.imageIds, referencedPages: draft.referencedPages,
    personaId: draft.personaId, choice: draft.choice,
    conversation: draft.conversation, requestId: draft.requestId,
    ...(box ? { from: { left: box.left, top: box.top, width: box.width, height: box.height } } : {}),
  });
  return "/memory/chat";
}

type StagedImage = { localId: string; previewUrl: string; file: File };

/** The one draft "See past conversations" set aside; module-level so it outlives the unmount. */
let heldDraft: { text: string; quote: string; papers: Paper[]; pages: MentionPage[] } | null = null;

export function AskComposer({
  target,
  onSeeHistory,
  quote = "",
  papers = [],
  pages,
  config,
  model,
  onModelChange,
  effort,
  onEffortChange,
  personas,
  personaId,
  onPersonaChange,
  onManagePersonas,
  onClose,
  onSend,
  onNotice,
}: {
  /** The context the question is asked in, and where its attachments upload at send. */
  target: ChatTarget;
  /** Leave the composer for this context's past conversations. */
  onSeeHistory?: () => void;
  /** Opened by Reply: the passage travels with the question. */
  quote?: string;
  /**
   * The documents an `@` may reach. The caller filters (active, not the one
   * already open); Memory reaches none, having no project to resolve one in.
   */
  papers?: Paper[];
  /** The Memory pages a Memory question's `@` may name. */
  pages?: MentionPage[];
  config: AppConfig;
  model: string;
  onModelChange: (value: string) => void;
  effort: string;
  onEffortChange: (value: string) => void;
  personas: PersonaSummary[];
  personaId: string;
  onPersonaChange: (value: string) => void;
  /** Opens Settings → Persona. The shell owns the sheet, so it owns this. */
  onManagePersonas?: () => void;
  onClose: () => void;
  onSend: (draft: AskDraft) => void;
  onNotice: (notice: Notice) => void;
}) {
  const [mode, setMode] = useState<ChatMode>(ChatMode.Chat);
  // Memory has no Plan mode, even when the composer was switched to Memory while in it.
  const planMode = target.context !== "general" && mode === ChatMode.Plan;
  // A draft left behind by "See past conversations" comes back on the next open.
  const [held] = useState(() => heldDraft);
  useEffect(() => { heldDraft = null; }, []);
  const [draft, setDraft] = useState(held?.text ?? "");
  /* Droppable, like the docked chat's own chip. Reply is an offer to quote,
     not a commitment to — the reader may decide the passage is not what they
     wanted to ask about after all. */
  const [quoted, setQuoted] = useState(quote || held?.quote || "");
  const context: ChatContext = target.context;
  // The composer always starts a new chat. The context's catalog is read only
  // to say, before anything is typed, that it already holds all it may.
  const [catalog, setCatalog] = useState<ConversationCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const full = Boolean(catalog && catalog.items.length >= catalog.limit);
  /** One creation key, so a retried send finds the chat it made. */
  const creationKey = useRef(crypto.randomUUID().replaceAll("-", "_"));
  const requestId = useRef(crypto.randomUUID().replaceAll("-", "_"));
  const uploadCache = useRef(new Map<string, ChatImage>());
  const sending = useRef(false);
  useEffect(() => {
    let active = true;
    const load = () => { void api<ConversationCatalog>(`/api/chat/conversations?${new URLSearchParams(chatQuery(target))}`)
      .then(value => { if (active) { setCatalog(value); setCatalogError(""); } })
      .catch(error => { if (active) setCatalogError(error.message); }); };
    load();
    window.addEventListener("delphi-conversations-changed", load);
    return () => { active = false; window.removeEventListener("delphi-conversations-changed", load); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Files held here, not yet a conversation's: upload waits for send. */
  const stagedRef = useRef<StagedImage[]>([]);
  const [staged, setStaged] = useState<StagedImage[]>([]);
  const setStagedImages = (next: (items: StagedImage[]) => StagedImage[]) => {
    stagedRef.current = next(stagedRef.current);
    setStaged(stagedRef.current);
  };

  /** The documents named in the draft; a reference deleted from it is dropped. */
  const [referencedPapers, setReferencedPapers] = useState<Paper[]>(held?.papers ?? []);
  const [referencedPages, setReferencedPages] = useState<MentionPage[]>(held?.pages ?? []);
  const mentionablePapers = context === "general" ? [] : papers;
  const mentionTabs: MentionTab[] =
    context !== "general" ? ["papers", "images"] : pages ? ["pages", "images"] : ["images"];
  // Its hints take turns as a new Memory chat's do, at the same pace.
  const composerHint = useCyclingHint(
    context === "general"
      ? [COMPOSER_PLACEHOLDER, pages ? PAGE_MENTION_HINT : IMAGE_HINT]
      : [COMPOSER_HINT, DOCUMENT_MENTION_HINT],
  );
  const paintPapers = useMemo(() => [...referencedPapers, ...referencedPages], [referencedPapers, referencedPages]);
  const fieldRef = useRef<MentionFieldHandle | null>(null);
  const imageUrl = (imageId: string, variant: "image" | "thumbnail") =>
    `${API_BASE}/api/chat/images/${imageId}/${variant}?${new URLSearchParams(
      chatQuery(target),
    )}`;

  const attach = (files: File[]) => {
    const room = config.chatImageMaxPerQuestion - stagedRef.current.length;
    if (room <= 0) return;
    const accepted = files.filter((file) =>
      isAcceptedImageFile(file, config.chatImageMaxSourceMb),
    );
    if (accepted.length !== files.length) {
      onNotice(
        hint(`Images must be PNG, JPEG, or static WebP and under ${config.chatImageMaxSourceMb} MB.`),
      );
    }
    if (!accepted.length) return;
    setStagedImages((current) => [
      ...current,
      ...accepted.slice(0, room).map((file) => ({
        localId: crypto.randomUUID(),
        previewUrl: URL.createObjectURL(file),
        file,
      })),
    ]);
  };

  const removeStaged = (item: StagedImage) => {
    URL.revokeObjectURL(item.previewUrl);
    setStagedImages((current) =>
      current.filter((candidate) => candidate.localId !== item.localId),
    );
  };

  useEffect(
    () => () => {
      for (const item of stagedRef.current) URL.revokeObjectURL(item.previewUrl);
    },
    [],
  );

  const coveringDrop = useCoveringFileDrop(attach);

  const send = async () => {
    // The editor owns compact atomic labels; the model receives full titles —
    // the same expansion the docked composer does at its own send.
    const asked = expandPaperMentionTokens(draft, [...referencedPapers, ...referencedPages]).trim();
    if (!asked || sending.current || !catalog || full) return;
    sending.current = true; setUploading(true);
    let destination: ConversationSummary;
    try {
      destination = await api<ConversationSummary>("/api/chat/conversations", { method: "POST", body: JSON.stringify({ ...chatQuery(target), creation_key: creationKey.current }) });
    } catch (error) { onNotice(error instanceof Error ? error.message : "Could not open conversation"); sending.current = false; setUploading(false); return; }
    const imageIds: string[] = [];
    if (stagedRef.current.length) {
      setUploading(true);
      try {
        for (const item of stagedRef.current) {
          const body = new FormData();
          body.append("image", item.file);
          const cacheKey = `${destination.id}:${item.localId}`;
          const stored = uploadCache.current.get(cacheKey) ?? await api<ChatImage>(
            `/api/chat/images?${new URLSearchParams(conversationQuery(target, destination))}`,
            { method: "POST", body },
          );
          uploadCache.current.set(cacheKey, stored);
          imageIds.push(stored.id);
        }
      } catch (error) {
        onNotice(error instanceof Error ? error.message : "Upload failed");
        setUploading(false);
        sending.current = false;
        return;
      }
      for (const item of stagedRef.current) URL.revokeObjectURL(item.previewUrl);
      stagedRef.current = [];
      setUploading(false);
    }
    conversationsChanged();
    onSend({
      conversation: destination,
      requestId: requestId.current,
      prompt: asked,
      imageIds,
      // The account-wide question has no project to resolve a reference
      // against, and the server refuses one there.
      referencedPaperIds:
        context === "general" ? [] : referencedPapers.map((item) => item.id),
      referencedPages: context === "general" ? referencedPages.map(({ slug, title }) => ({ slug, title })) : [],
      context,
      selectedText: quoted,
      personaId,
      choice: { mode: planMode ? ChatMode.Plan : ChatMode.Chat, model, effort },
    });
  };

  return (
    <div
      className="kb-composer-backdrop"
      onPointerDown={uploading ? undefined : onClose}
      {...coveringDrop.handlers}
    >
      <form
        className={`kb-composer-card${coveringDrop.active ? " image-drop" : ""}${planMode ? " composer-plan" : ""}`}
        onKeyDownCapture={(event) => {
          // Memory chat has no Plan mode: a plan's sources are captured from a project's documents.
          if (context !== "general" && !uploading && isModeShortcut(event)) {
            event.preventDefault(); event.stopPropagation(); setMode(nextChatMode);
          }
        }}
        role="dialog"
        aria-label="Ask Delphi"
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {catalogError ? <p role="alert">{catalogError}</p> : null}
        {full ? <p className="conversation-capacity" role="status">{context === "general" ? "Memory" : "This document"} holds its {catalog?.limit} chats. Continue one from past conversations, or delete one there to start another.</p> : null}
        {coveringDrop.active ? (
          <p className="composer-drop-hint" role="status">
            {imageDropHint(config.chatImageMaxPerQuestion)}
          </p>
        ) : null}
        {staged.length ? (
          <div className="composer-images" aria-label="Attached images">
            {staged.map((item) => (
              <div className="composer-image" key={item.localId}>
                {/* Authenticated, expiring user content cannot use the static image optimizer. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.previewUrl} alt="Image being attached" />
                {uploading ? (
                  <span className="image-upload-state" aria-hidden="true" />
                ) : null}
                <button
                  type="button"
                  aria-label="Remove this image"
                  disabled={uploading}
                  onClick={() => removeStaged(item)}
                >
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 10 10"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M2 2l6 6M8 2 2 8"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {quoted ? (
          /* The same chip the docked chat shows, so a passage looks the same
             wherever the question is being written. */
          <div className="selection-chip">
            <p>{quoted}</p>
            <button
              type="button"
              className="selection-chip-clear"
              onClick={() => setQuoted("")}
              aria-label="Remove quoted passage"
            >
              ×
            </button>
          </div>
        ) : null}
        <MentionField
          handleRef={fieldRef}
          papers={mentionablePapers}
          pages={pages}
          images={[]}
          paintPapers={paintPapers}
          paintImages={[]}
          tabs={mentionTabs}
          imageUrl={imageUrl}
          autoFocus
          initialDraft={held?.text ?? ""}
          placeholder={planMode ? "What should we plan?" : composerHint}
          label={COMPOSER_PLACEHOLDER}
          onDraftChange={(value) => {
            setDraft(value);
            // A reference deleted from the sentence is a reference dropped.
            setReferencedPapers((current) => keptMentions(value, current, draftTokens([...current, ...referencedPages], [])));
            setReferencedPages((current) => keptMentions(value, current, draftTokens([...referencedPapers, ...current], [])));
          }}
          onPageMention={(item) => {
            if (referencedPages.some((page) => page.slug === item.slug)) return true;
            if (referencedPages.length >= NAMED_PAGES_MAX) {
              onNotice(hint(`Up to ${NAMED_PAGES_MAX} Memory pages can be named in one question. Delphi finds others on its own.`));
              return false;
            }
            setReferencedPages((current) => [...current, item]);
            return true;
          }}
          onPaperMention={(item) =>
            setReferencedPapers((current) =>
              current.some((paper) => paper.id === item.id)
                ? current
                : [...current, item],
            )
          }
          onImageMention={() => true}
          onSubmit={() => void send()}
          onPasteImages={attach}
        />
        <div className="kb-composer-tools">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            multiple
            hidden
            onChange={(event) => {
              attach(Array.from(event.target.files ?? []));
              // Re-picking the same file fires no change event unless the
              // input forgets it first.
              event.target.value = "";
            }}
          />
          <ComposerToggle
            label={
              staged.length >= config.chatImageMaxPerQuestion
                ? `Limit reached (${config.chatImageMaxPerQuestion} per question)`
                : "Attach an image"
            }
            className="attach-image-button"
            disabled={staged.length >= config.chatImageMaxPerQuestion || uploading}
            onActivate={() => fileRef.current?.click()}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M10.5 5.2 5.9 9.8a1.6 1.6 0 0 0 2.3 2.3l4.6-4.6a3 3 0 0 0-4.2-4.2L3.9 7.9a4.3 4.3 0 0 0 6.1 6.1l4.3-4.3"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </ComposerToggle>
          {onSeeHistory ? (
            <button
              type="button"
              className="composer-history-button"
              aria-label="See past conversations"
              disabled={uploading}
              onClick={() => {
                // Leaving to read past chats keeps what was being written here.
                heldDraft = { text: draft, quote: quoted, papers: referencedPapers, pages: referencedPages };
                onSeeHistory();
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8M2.6 2.6v2.6h2.6M8 5.2V8l2 1.3" /></svg>
              <span>See past conversations</span>
            </button>
          ) : null}
          <div className="kb-composer-choices">
            <ModeTag mode={planMode ? ChatMode.Plan : ChatMode.Chat} />
            <ModelPill
              models={config.models.map((value) => ({
                value,
                label: modelLabel(value),
              }))}
              model={model}
              onModelChange={onModelChange}
              efforts={config.reasoningEfforts.map((value) => ({
                value,
                label: EFFORT_LABELS[value] ?? value,
              }))}
              modelEfforts={config.modelReasoningEfforts}
              effort={effort}
              onEffortChange={onEffortChange}
            />
            <PersonaPill
              personas={personas}
              value={personaId}
              onChange={onPersonaChange}
              onManage={onManagePersonas}
            />
          </div>
          <button
            type="submit"
            className="send-button"
            disabled={!draft.trim() || uploading || !catalog || full}
            aria-label="Send"
          >
            <span aria-hidden="true">↑</span>
          </button>
        </div>
      </form>
    </div>
  );
}
