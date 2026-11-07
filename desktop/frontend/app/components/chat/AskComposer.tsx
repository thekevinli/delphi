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
 * Two things it carries that the docked follow-up does not need:
 *
 * - the **Context pill**, top-left, because this is the moment the reader
 *   decides how wide the question is. Docked, the same control moves into the
 *   header, where it reports what the open thread already is.
 * - an **image attachment**, staged locally until send. The number it will
 *   wear lives on a conversation, and this card has not chosen one yet — so
 *   a Document → Memory switch has to keep the thumbnail, and the upload
 *   waits for the context the question is actually asked in.
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
import { scopeKey } from "../../lib/chat-scope";
import { ModeTag } from "./ModeTag";
import { ChatMode, nextChatMode, isModeShortcut } from "../../lib/chat-mode";
import { useEffect, useRef, useState } from "react";

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
  type ChatContext,
  type ChatTarget,
} from "../../lib/chat-scope";
import { imageDropHint, isAcceptedImageFile } from "../../lib/file-drag";
import { useCoveringFileDrop } from "../../lib/use-file-drop";
import {
  ComposerToggle,
  EFFORT_LABELS,
  modelLabel,
  ModelPill,
  PersonaPill,
} from "../ChatBits";
import { ConversationScopeMenu } from "./ConversationMenus";
import { MentionField, type MentionFieldHandle, type MentionTab } from "./MentionField";
import {
  expandPaperMentionTokens,
  paperMentionToken,
} from "../../lib/paper-mention";
import { hint, type Notice } from "../Notice";

export type AskDraft = {
  conversation: ConversationSummary;
  requestId: string;
  prompt: string;
  imageIds: string[];
  /** Documents `@`-mentioned in the question, so the surface can attach them. */
  referencedPaperIds: string[];
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

type StagedImage = { localId: string; previewUrl: string; file: File };

/** The one draft "See past conversations" set aside; module-level so it outlives the unmount. */
let heldDraft: { text: string; quote: string } | null = null;

export function AskComposer({
  initialContext,
  onSeeHistory,
  quote = "",
  contextOptions,
  papers = [],
  targetFor,
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
  /**
   * What the pill opens on. Held locally from there until send, because
   * choosing a context is a decision about the question being written — not
   * yet a change to what is on screen. Writing it to the address on each pick
   * would dock a conversation the reader has not asked for.
   */
  initialContext: ChatContext;
  /** Leave the composer for the rail's past conversations in this context. */
  onSeeHistory?: (context: ChatContext) => void;
  /** Opened by Reply: the passage travels with the question. */
  quote?: string;
  contextOptions: ChatContext[];
  /**
   * The documents an `@` may reach, for the contexts that have any.
   *
   * The caller filters (active, not the one already open); this only decides
   * that General reaches none of them — the account-wide question has no
   * project to resolve a reference against.
   */
  papers?: Paper[];
  /** Where a staged attachment uploads at send, for the context then picked. */
  targetFor: (context: ChatContext) => ChatTarget;
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
  const planMode = mode === ChatMode.Plan;
  // A draft left behind by "See past conversations" comes back on the next open.
  const [held] = useState(() => heldDraft);
  useEffect(() => { heldDraft = null; }, []);
  const [draft, setDraft] = useState(held?.text ?? "");
  /* Droppable, like the docked chat's own chip. Reply is an offer to quote,
     not a commitment to — the reader may decide the passage is not what they
     wanted to ask about after all. */
  const [quoted, setQuoted] = useState(quote || held?.quote || "");
  const [context, setContext] = useState<ChatContext>(initialContext);
  const target = targetFor(context);
  const targetKey = scopeKey(target);
  // The composer always starts a new chat. The context's catalog is read only
  // to say, before anything is typed, that it already holds its ten.
  const [catalogState, setCatalogState] = useState<{ key: string; catalog: ConversationCatalog | null; error: string }>({ key: "", catalog: null, error: "" });
  const catalog = catalogState.key === targetKey ? catalogState.catalog : null;
  const catalogError = catalogState.key === targetKey ? catalogState.error : "";
  const full = Boolean(catalog && catalog.items.length >= catalog.limit);
  /** One creation key per context, so a retried send finds the chat it made. */
  const creationKeys = useRef(new Map<string, string>());
  const requestId = useRef(crypto.randomUUID().replaceAll("-", "_"));
  const uploadCache = useRef(new Map<string, ChatImage>());
  const sending = useRef(false);
  useEffect(() => {
    let active = true;
    const load = () => { void api<ConversationCatalog>(`/api/chat/conversations?${new URLSearchParams(chatQuery(target))}`)
      .then(value => { if (active) setCatalogState({ key: targetKey, catalog: value, error: "" }); })
      .catch(error => { if (active) setCatalogState(current => ({ key: targetKey, catalog: current.key === targetKey ? current.catalog : null, error: error.message })); }); };
    load();
    window.addEventListener("delphi-conversations-changed", load);
    return () => { active = false; window.removeEventListener("delphi-conversations-changed", load); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * Files held here, not yet a conversation's. Upload waits for send so a
   * context switch cannot orphan a thumbnail that was aimed at this question.
   */
  const stagedRef = useRef<StagedImage[]>([]);
  const [staged, setStaged] = useState<StagedImage[]>([]);
  const setStagedImages = (next: (items: StagedImage[]) => StagedImage[]) => {
    stagedRef.current = next(stagedRef.current);
    setStaged(stagedRef.current);
  };

  /**
   * The documents named in the draft, kept whatever the context becomes.
   *
   * A reference is only a word in the sentence until it is sent. Switching to
   * General does not take the chip off the half-written question; `send` is
   * what drops it, because the account-wide conversation has no project to
   * resolve a reference against.
   */
  const [referencedPapers, setReferencedPapers] = useState<Paper[]>([]);
  const mentionablePapers = context === "general" ? [] : papers;
  const mentionTabs: MentionTab[] =
    context === "general" ? ["images"] : ["papers", "images"];
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
    const asked = expandPaperMentionTokens(draft, referencedPapers).trim();
    if (!asked || sending.current || !catalog || full) return;
    sending.current = true; setUploading(true);
    let destination: ConversationSummary;
    let creationKey = creationKeys.current.get(targetKey);
    if (!creationKey) {
      creationKey = crypto.randomUUID().replaceAll("-", "_");
      creationKeys.current.set(targetKey, creationKey);
    }
    try {
      destination = await api<ConversationSummary>("/api/chat/conversations", { method: "POST", body: JSON.stringify({ ...chatQuery(target), creation_key: creationKey }) });
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
      context,
      selectedText: quoted,
      personaId,
      choice: { mode, model, effort },
    });
  };

  // The scope menu counts each context's threads, so it needs the ids the
  // contexts resolve to; the document's target carries both when there is one.
  const scopeTarget = contextOptions.includes("document") ? targetFor("document") : null;

  return (
    <div
      className="kb-composer-backdrop"
      onPointerDown={uploading ? undefined : onClose}
      {...coveringDrop.handlers}
    >
      <form
        className={`kb-composer-card${coveringDrop.active ? " image-drop" : ""}${planMode ? " composer-plan" : ""}`}
        onKeyDownCapture={(event) => {
          if (!uploading && isModeShortcut(event)) {
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
        {/* One row above the question: what it is about, and Chat or Plan at
            the far end — the mode tag used to sit inside the field and a long
            line ran under it. Past conversations sit with the other tools. */}
        <div className="kb-composer-context">
          <ConversationScopeMenu
            direction="up"
            context={context}
            options={contextOptions}
            projectId={scopeTarget && "projectId" in scopeTarget ? scopeTarget.projectId : undefined}
            paperId={scopeTarget && "paperId" in scopeTarget ? scopeTarget.paperId : undefined}
            onSelect={value => { if (!uploading) setContext(value); }}
          />
          <ModeTag mode={mode} />
        </div>
        {catalogError ? <p role="alert">{catalogError}</p> : null}
        {full ? <p className="conversation-capacity" role="status">This context holds its 10 chats. Continue one from past conversations, or delete one there to start another.</p> : null}
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
          images={[]}
          paintPapers={referencedPapers}
          paintImages={[]}
          tabs={mentionTabs}
          imageUrl={imageUrl}
          autoFocus
          initialDraft={held?.text ?? ""}
          placeholder={planMode ? "What should we plan?" : COMPOSER_HINT}
          onDraftChange={(value) => {
            setDraft(value);
            // A reference deleted from the sentence is a reference dropped.
            setReferencedPapers((current) =>
              current.filter((item) =>
                value.includes(paperMentionToken(item.title)),
              ),
            );
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
                heldDraft = { text: draft, quote: quoted };
                onSeeHistory(context);
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8M2.6 2.6v2.6h2.6M8 5.2V8l2 1.3" /></svg>
              <span>See past conversations</span>
            </button>
          ) : null}
          <div className="kb-composer-choices">
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
