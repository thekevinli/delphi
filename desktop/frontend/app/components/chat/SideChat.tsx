"use client";

/**
 * The side chat beside a conversation (`/side`): a temporary thread that sees
 * the conversation and is never stored.
 *
 * Its state lives in the conversation's in-memory session, so switching tabs
 * or remounting the panel keeps it and clearing the chat (a new generation)
 * drops it. Each question goes to `POST /api/chat/side` with the earlier side
 * exchanges; the server re-reads the main thread and writes nothing.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";

import { API_BASE, type ChatMessage } from "../../lib/api";
import { applyTraceEvent, isAnswerTrace, type AnswerTrace, type TraceEvent } from "../../lib/answer-trace";
import { incompleteOf } from "../../lib/answer-ending";
import { normalizeSources } from "../../lib/web-sources";
import { readSseStream } from "../../lib/sse";
import { sessionCell, type ConversationSession } from "../../lib/conversation-session";
import { useConversationField } from "../../lib/use-conversation";
import { SIDE_COMMAND, sideRequestBody, type SideTurn } from "../../lib/side-chat";
import { AnswerFlow } from "../AnswerTrace";
import { PanelDivider } from "../PanelDivider";
import { MentionField, type MentionFieldHandle } from "./MentionField";

const SUGGESTION = "Explain the last answer more simply";
const NONE: never[] = [];

/**
 * The main composer's card and field without its attachment button: the same
 * line height, wrap and five-line cap, Enter to send and Shift+Enter for a
 * new line. No `@` menu, since a side question references nothing.
 */
function SideComposer({
  fieldRef,
  initialDraft,
  draft,
  onDraftChange,
  onSubmit,
  streaming = false,
  onStop,
  onCancel,
  autoFocus = true,
}: {
  fieldRef?: Ref<MentionFieldHandle | null>;
  initialDraft: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
  streaming?: boolean;
  onStop?: () => void;
  /** Present on the card that edits a question. */
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const editing = Boolean(onCancel);
  return (
    <div className={`composer side-chat-composer${editing ? " is-edit" : ""}`}>
      <MentionField
        handleRef={fieldRef}
        label={editing ? "Edit side question" : "Side question"}
        papers={NONE}
        images={NONE}
        paintPapers={NONE}
        paintImages={NONE}
        tabs={NONE}
        imageUrl={() => ""}
        placeholder="Ask a side question"
        autoFocus={autoFocus}
        initialDraft={initialDraft}
        onDraftChange={onDraftChange}
        onPaperMention={() => {}}
        onImageMention={() => false}
        onSubmit={onSubmit}
      />
      <div className="composer-row">
        <div className="composer-send-group">
          {onCancel ? (
            <button type="button" className="message-edit-cancel" aria-label="Cancel edit" onClick={onCancel}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          ) : null}
          <button
            type="button"
            className={`send-button${streaming ? " stopping" : ""}`}
            aria-label={streaming ? "Stop side answer" : editing ? "Send edited side question" : "Send side question"}
            title={streaming ? "Stop" : "Send"}
            disabled={!streaming && !draft.trim()}
            onClick={() => (streaming ? onStop?.() : onSubmit())}
          >
            {streaming ? <span className="send-stop-glyph" aria-hidden="true" /> : (
              <svg width="13" height="13" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                <path d="M7.5 12V3M7.5 3L3.5 7M7.5 3L11.5 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SideChat({
  session,
  ensureConversation,
  scope,
  model,
  effort,
  personaId,
  width,
  overlay,
  bounds,
  onResize,
  onClose,
  renderText,
  onNotice,
}: {
  session: ConversationSession;
  ensureConversation: () => Promise<{ id: string; generation: number }>;
  scope: Record<string, string | undefined>;
  /** The main composer's picks: a side question answers with the same model, effort and persona. */
  model: string;
  effort: string;
  personaId?: string | null;
  width: number;
  overlay: boolean;
  bounds: { min: number; max: number };
  /** A dragged width, or null to go back to the opening width. */
  onResize: (width: number | null) => void;
  onClose: () => void;
  renderText: (text: string, message: ChatMessage, streaming: boolean) => ReactNode;
  onNotice: (message: string) => void;
}) {
  const [turns, setTurns] = useConversationField<SideTurn[]>(session, "sideTurns", []);
  const [draft, setDraft] = useConversationField(session, "sideDraft", "");
  const [queued, setQueued] = useConversationField(session, "sideQueued", "");
  const controller = sessionCell<AbortController | null>(session, "sideController", null);
  const nextTurn = sessionCell(session, "sideTurnId", 0);
  const streaming = turns.some((turn) => turn.pending);
  const fieldRef = useRef<MentionFieldHandle | null>(null);
  // The latest question while it is being rewritten in place.
  const [edit, setEdit] = useState<{ id?: number; text: string } | null>(null);
  // The bottom field takes the focus back when the reader ends an edit, not when a queued question does.
  const [refocus, setRefocus] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  // A message object per finished turn, so citation handlers keyed on it stay put.
  const messageFor = useRef(new WeakMap<SideTurn, ChatMessage>());

  const update = (id: number, change: (turn: SideTurn) => SideTurn) =>
    setTurns((items) => items.map((turn) => (turn.id === id ? change(turn) : turn)));

  /** Ask `text`; `fromDraft` is a question typed in the side input, which then empties. */
  const ask = async (text: string, fromDraft = false) => {
    const prompt = text.trim();
    // Read from the session, not this render: a second press can land first.
    const earlier = (session.values.get("sideTurns") as SideTurn[] | undefined) ?? [];
    if (!prompt || earlier.some((turn) => turn.pending)) return;
    const id = nextTurn.current++;
    // A question asked meanwhile (a queued `/side`) ends an edit of the one before it.
    setEdit(null);
    setTurns([...earlier, { id, askedAt: Date.now(), question: prompt, answer: "", pending: true, trace: [] }]);
    if (fromDraft) fieldRef.current?.clear();
    const abort = new AbortController();
    controller.current = abort;
    try {
      const conversation = await ensureConversation();
      const response = await fetch(`${API_BASE}/api/chat/side`, {
        method: "POST",
        signal: abort.signal,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sideRequestBody({ scope, conversation, prompt, turns: earlier, model, effort, personaId })),
      });
      if (!response.ok || !response.body) {
        const refusal = (await response.json().catch(() => null)) as { detail?: unknown } | null;
        throw new Error(typeof refusal?.detail === "string" ? refusal.detail : "The side question could not start");
      }
      for await (const payload of readSseStream(response.body)) {
        if (payload.type === "delta") update(id, (turn) => ({ ...turn, answer: turn.answer + payload.text }));
        if (payload.type === "trace") {
          update(id, (turn) => ({
            ...turn,
            trace: applyTraceEvent((turn.trace as AnswerTrace) ?? [], payload as unknown as TraceEvent),
          }));
        }
        if (payload.type === "done") {
          update(id, (turn) => ({
            ...turn,
            pending: false,
            trace: isAnswerTrace(payload.trace) ? payload.trace : turn.trace,
            sources: normalizeSources(payload.sources),
            incomplete: incompleteOf(payload.incomplete),
          }));
        }
        if (payload.type === "error") throw new Error(payload.message);
      }
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      const message = error instanceof Error ? error.message : "The side question failed";
      update(id, (turn) => ({ ...turn, pending: false, cancelled, error: cancelled ? undefined : message }));
      if (!cancelled) onNotice(`Side chat: ${message}`);
    } finally {
      if (controller.current === abort) controller.current = null;
      update(id, (turn) => (turn.pending ? { ...turn, pending: false } : turn));
    }
  };

  // `/side <question>` asks as the side chat opens, or once the answer in progress ends.
  useEffect(() => {
    const question = session.values.get("sideQueued") as string | undefined;
    if (!question || streaming) return;
    setQueued("");
    if (edit) setRefocus(false);
    void ask(question);
    // `ask` is recreated each render; the queue is what should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, streaming]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns]);

  const retry = (index: number) => {
    const question = turns[index]?.question;
    if (!question) return;
    setTurns((items) => items.filter((_, at) => at !== index));
    void ask(question);
    fieldRef.current?.focus();
  };

  /** The edited last question replaces it and is asked again. */
  const sendEdit = () => {
    const question = edit?.text.trim();
    if (!edit || !question || streaming) return;
    setTurns((items) => items.filter((turn) => turn.id !== edit.id));
    void ask(question);
  };

  /* Escape anywhere in the side chat is the side chat's: it leaves an edit,
     clears a typed question, then closes. It never also leaves the expanded
     card. A menu in the field that took the key keeps it. */
  const onPaneKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.stopPropagation();
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (edit !== null) setEdit(null);
    else if (draft.trim() && (event.target as HTMLElement).closest(".composer-input")) fieldRef.current?.clear();
    else onClose();
  };

  return (
    <>
      {overlay ? <div className="side-chat-ghost" aria-hidden="true" /> : (
        <PanelDivider
          side="right"
          cssVar="--side-width"
          className="side-chat-divider"
          label="Resize side chat"
          value={width}
          min={bounds.min}
          max={bounds.max}
          constrain={(next) => Math.round(Math.max(bounds.min, Math.min(next, bounds.max)))}
          onChange={onResize}
          onReset={() => onResize(null)}
        />
      )}
      <aside className={`side-chat${overlay ? " is-overlay" : ""}`} aria-label="Side chat" onKeyDown={onPaneKeyDown}>
        <header className="side-chat-head">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.8" y="2.5" width="12.4" height="11" rx="2" />
            <path d="M9.6 2.5v11" />
            <path className="side-chat-head-fill" d="M9.6 2.5h2.6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9.6z" />
          </svg>
          <b>Side chat</b>
          <button type="button" className="side-chat-close" aria-label="Close side chat" title="Close side chat (Esc)" onClick={onClose}>
            <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div className="side-chat-messages" ref={scrollRef}>
          {!turns.length ? (
            <div className="side-chat-empty">
              <p>{SIDE_COMMAND.hint}</p>
              <button type="button" onClick={() => void ask(SUGGESTION)}>{SUGGESTION}</button>
            </div>
          ) : (
            turns.map((turn, index) => {
              let message = messageFor.current.get(turn);
              if (!message) {
                message = { role: "assistant", content: turn.answer, sources: turn.sources } as ChatMessage;
                messageFor.current.set(turn, message);
              }
              const latest = index === turns.length - 1;
              return (
                <article key={turn.id ?? index} className={`side-chat-turn${latest ? " is-latest" : ""}`}>
                  {edit && edit.id === turn.id ? (
                    <SideComposer
                      initialDraft={turn.question}
                      draft={edit.text}
                      onDraftChange={(text) => setEdit({ id: turn.id, text })}
                      onSubmit={sendEdit}
                      onCancel={() => setEdit(null)}
                    />
                  ) : (
                    <div className="side-chat-ask">
                      <p className="side-chat-question">
                        {turn.question}
                        {latest && !streaming ? (
                          <button type="button" className="message-edit" aria-label="Edit side question" onClick={() => {
                            setRefocus(true);
                            setEdit({ id: turn.id, text: turn.question });
                          }}>
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M4 20h4l10.5-10.5a2.828 2.828 0 1 0-4-4L4 16v4" />
                              <path d="m13.5 6.5 4 4" />
                            </svg>
                          </button>
                        ) : null}
                      </p>
                    </div>
                  )}
                  <div className="side-chat-answer kb-chat-turn">
                    <AnswerFlow
                      content={turn.answer}
                      trace={isAnswerTrace(turn.trace) ? turn.trace : []}
                      live={Boolean(turn.pending)}
                      keepWaiting={false}
                      startedAt={turn.askedAt ?? 0}
                      renderText={(text) => renderText(text, message, Boolean(turn.pending))}
                    />
                    {turn.error || turn.cancelled ? (
                      <p className={`side-chat-notice${turn.cancelled ? " is-cancelled" : ""}`} role="status">
                        <span>{turn.cancelled ? "Request cancelled." : `Request failed: ${turn.error}`}</span>
                        {latest && !streaming && edit === null ? (
                          <button type="button" onClick={() => retry(index)}>Retry</button>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                </article>
              );
            })
          )}
        </div>
        {edit === null ? (
          <SideComposer
            fieldRef={fieldRef}
            initialDraft={draft}
            draft={draft}
            // A field emptied by hand keeps a stray line break; it is still empty.
            onDraftChange={(text) => setDraft(text.trim() ? text : "")}
            onSubmit={() => void ask(draft, true)}
            streaming={streaming}
            onStop={() => {
              controller.current?.abort();
              fieldRef.current?.focus();
            }}
            autoFocus={refocus}
          />
        ) : null}
      </aside>
    </>
  );
}
