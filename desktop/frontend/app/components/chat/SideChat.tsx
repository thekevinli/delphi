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

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

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

const SUGGESTION = "Explain the last answer more simply";

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
  const inputRef = useRef<HTMLInputElement>(null);
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
    setTurns([...earlier, { id, askedAt: Date.now(), question: prompt, answer: "", pending: true, trace: [] }]);
    if (fromDraft) setDraft("");
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
    void ask(question);
    // `ask` is recreated each render; the queue is what should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, streaming]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns]);

  const retry = (index: number) => {
    const question = turns[index]?.question;
    if (!question) return;
    setTurns((items) => items.filter((_, at) => at !== index));
    void ask(question);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void ask(draft, true);
    }
  };
  /* Escape anywhere in the side chat is the side chat's: it clears a typed
     question, then closes. It never also leaves the expanded card. */
  const onPaneKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (draft && event.target === inputRef.current) setDraft("");
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
              return (
                <article key={turn.id ?? index} className="side-chat-turn">
                  <p className="side-chat-question">{turn.question}</p>
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
                      <p className="side-chat-error" role="status">
                        <span>{turn.cancelled ? "Stopped." : `Request failed: ${turn.error}`}</span>
                        {index === turns.length - 1 && !streaming ? (
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
        <div className="side-chat-composer">
          <input
            ref={inputRef}
            aria-label="Side question"
            placeholder="Ask a side question"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className={`send-button${streaming ? " stopping" : ""}`}
            aria-label={streaming ? "Stop side answer" : "Send side question"}
            title={streaming ? "Stop" : "Send"}
            disabled={!streaming && !draft.trim()}
            onClick={() => (streaming ? controller.current?.abort() : void ask(draft, true))}
          >
            {streaming ? <span className="send-stop-glyph" aria-hidden="true" /> : (
              <svg width="13" height="13" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                <path d="M7.5 12V3M7.5 3L3.5 7M7.5 3L11.5 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
      </aside>
    </>
  );
}
