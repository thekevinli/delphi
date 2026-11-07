"use client";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { visibleConversationCount } from "../../lib/conversation-layout";
import { ConversationActivity, type ContextChats } from "./ConversationMenus";
import ScrollingTitle from "../ScrollingTitle";
import { api } from "../../lib/api";
import { chatQuery, scopeKey, type ChatTarget } from "../../lib/chat-scope";
import { adoptSession, conversationKey, isBlank, conversationStatus, conversationStatusVersion, disposeSession, existingSession, sessionCell, sessionFor, subscribeConversationStatus, type ConversationCatalog, type ConversationSummary } from "../../lib/conversation-session";
import { chatLeft, readerIsBeside } from "../../lib/memory-maintenance";
import { hint, type Notice } from "../Notice";
import { closeSideChat } from "../../lib/side-chat";
import { LoadingWords, SkeletonBar } from "../Loading";

export const conversationsChanged = () => window.dispatchEvent(new Event("delphi-conversations-changed"));
const fetchCatalog = (target: ChatTarget) =>
  api<ConversationCatalog>(`/api/chat/conversations?${new URLSearchParams(chatQuery(target))}`);
/** One creation per provisional chat, however many sends race to make it. */
const creations = new Map<string, Promise<ConversationSummary>>();
export function conversationQuery(target: ChatTarget, conversation: ConversationSummary) {
  return { ...chatQuery(target), conversation_id: conversation.id, generation: String(conversation.generation) };
}

/** Chats closed out of the tab strip, per scope. They stay in the context menu's list until reopened or deleted. */
const closedKey = (scope: string) => `delphi:conversations-closed:${scope}`;
function readClosed(scope: string): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(closedKey(scope)) ?? "[]");
    return Array.isArray(stored) ? stored.filter(id => typeof id === "string") : [];
  } catch { return []; }
}
function writeClosed(scope: string, ids: string[]) {
  // A tidier strip is a convenience: without storage it lasts until reload.
  try { if (ids.length) localStorage.setItem(closedKey(scope), JSON.stringify(ids)); else localStorage.removeItem(closedKey(scope)); } catch {}
}

/** Every chat the context may hold has something in it: there is no room for a blank tab. */
const isFull = (catalog: ConversationCatalog) => catalog.items.length >= catalog.limit && !catalog.items.some(isBlank);
const FULL = "10 chats maximum. Continue a chat or delete one to start another.";

/**
 * The strip works as a browser's tabs do. A chat is a tab while it is open;
 * its cross closes the tab and keeps the chat, which waits in its context's
 * list, beside the context menu, until it is reopened or deleted there. A
 * blank chat is a tab only while it is the one on screen, and there is never
 * a second. When the last tab closes, so does the chat window; opening it
 * again with nothing open starts on a blank tab, or, in a context with no
 * room for another chat, on the chat closed last.
 */
export function ConversationRail({ target, seedConversation, titleMaxCharacters, onNotice, onClose, children }: {
  target: ChatTarget;
  seedConversation?: ConversationSummary;
  /** The server's bound on a title; the rename box offers back a generated one. */
  titleMaxCharacters: number;
  onNotice: (notice: Notice) => void;
  /** Closes the chat window. Without it the last tab gives way to a blank one. */
  onClose?: () => void;
  children: (options: { conversation: ConversationSummary; tabs: ReactNode; tools: ReactNode; chats: ContextChats; ensureConversation: () => Promise<ConversationSummary> }) => ReactNode;
}) {
  const key = scopeKey(target);
  const searchParams = useSearchParams();
  const [catalog, setCatalog] = useState<ConversationCatalog | null>(null);
  const [selected, setSelected] = useState<string | null>(() => seedConversation?.id ?? null);
  // Capture the same navigation snapshot that selected this scope. During a
  // transition window.location can still name the departing context's chat.
  // Keep the initial link while the catalog loads and selection rewrites the URL.
  const [linked] = useState(() => searchParams.get("conversation"));
  const [provisional, setProvisional] = useState<ConversationSummary>(() => ({ id: `draft-${crypto.randomUUID()}`, generation: 0, title: "New chat", empty: true, provisional: true }));
  const [problem, setProblem] = useState("");
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  // Held with the scope it was read for, so it is only ever saved back there.
  const [closedIn, setClosedIn] = useState<{ scope: string; ids: string[] }>({ scope: "", ids: [] });
  const closed = closedIn.scope === key ? closedIn.ids : [];
  // Saved as it changes, not after the render: closing the last tab unmounts this.
  const updateClosed = (ids: string[]) => { setClosedIn({ scope: key, ids }); writeClosed(key, ids); };
  useEffect(() => { if (closedIn.scope) writeClosed(closedIn.scope, closedIn.ids); }, [closedIn]);
  const [enteringId, setEnteringId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<ConversationSummary | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [stripWidth, setStripWidth] = useState(0);
  const [tabsNode, setTabsNode] = useState<HTMLDivElement | null>(null);
  useSyncExternalStore(subscribeConversationStatus, conversationStatusVersion, () => 0);
  const reload = useCallback(() => fetchCatalog(target).then(
    value => { setCatalog(value); setProblem(""); return value; },
    (error: unknown) => { setProblem(error instanceof Error ? error.message : "Could not load conversations"); return null; },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [key]); // context membership is represented by the key
  useEffect(() => {
    let active = true;
    void fetchCatalog(target).then(value => {
      if (!active) return;
      setCatalog(value); setProblem("");
      const requested = seedConversation?.id ?? linked;
      let remembered: string | null = null;
      try { remembered = sessionStorage.getItem(`delphi:conversation:${key}`); } catch {}
      const exists = (id: string | null | undefined) => value.items.some(item => item.id === id);
      // A link or a hand-off reopens a closed chat; a remembered or default choice never does.
      const shut = readClosed(key).filter(id => exists(id) && id !== requested);
      if (requested && !exists(requested)) onNotice(hint("That conversation is no longer available."));
      const open = (id: string | null) => exists(id) && !shut.includes(id!);
      // With every chat closed the window opens on a blank tab: the empty chat it has, else a draft.
      let choice = exists(requested) ? requested : open(remembered) ? remembered : open(value.defaultId) ? value.defaultId
        : (value.items.find(item => open(item.id) && !isBlank(item)) ?? value.items.find(isBlank))?.id ?? null;
      // Without room for a draft, the chat closed last comes back, and the reader is told why.
      if (!choice && isFull(value)) { choice = shut.at(-1) ?? null; onNotice(hint(FULL)); }
      setClosedIn({ scope: key, ids: shut.filter(id => id !== choice) });
      setSelected(choice);
    }, (error: unknown) => { if (active) setProblem(error instanceof Error ? error.message : "Could not load conversations"); });
    const refresh = () => { void reload(); };
    window.addEventListener("delphi-conversations-changed", refresh);
    return () => { active = false; window.removeEventListener("delphi-conversations-changed", refresh); };
  }, [key, reload]);
  // A composer handing over a conversation selects it on the render that sees it.
  const [seedSeen, setSeedSeen] = useState(seedConversation?.id);
  if (seedConversation && seedConversation.id !== seedSeen) {
    setSeedSeen(seedConversation.id);
    setSelected(seedConversation.id);
    if (closed.includes(seedConversation.id)) setClosedIn({ scope: key, ids: closed.filter(id => id !== seedConversation.id) });
  }
  useEffect(() => { if (seedSeen) void reload(); }, [seedSeen, reload]);
  useEffect(() => {
    const node = tabsNode;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setStripWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, [tabsNode]);
  // Selecting a closed chat, from its row in the context's list, puts it back in the strip.
  const select = (id: string | null) => {
    if (id && closed.includes(id)) updateClosed(closed.filter(shut => shut !== id));
    setSelected(id);
  };
  // A later link to another conversation, while this rail stays mounted. The
  // rail's own address writes name what is already selected.
  const routed = searchParams.get("conversation");
  const [routeSeen, setRouteSeen] = useState(routed);
  // A chat this rail has not listed, begun since it loaded or since deleted, is asked for first.
  const [unlisted, setUnlisted] = useState<string | null>(null);
  const adopt = (id: string) => {
    setSelected(id);
    setClosedIn(current => current.scope === key && current.ids.includes(id) ? { scope: key, ids: current.ids.filter(shut => shut !== id) } : current);
  };
  if (routed !== routeSeen) {
    setRouteSeen(routed);
    setUnlisted(null);
    if (routed && routed !== selected) {
      if (catalog?.items.some(item => item.id === routed)) adopt(routed); else setUnlisted(routed);
    }
  }
  useEffect(() => {
    if (!unlisted) return;
    let active = true;
    void reload().then(value => {
      if (!active || !value) return;
      setUnlisted(null);
      if (value.items.some(item => item.id === unlisted)) adopt(unlisted);
      else onNotice(hint("That conversation is no longer available."));
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlisted, reload]);
  // Whatever chose the conversation — a click, the composer's hand-off, the
  // first catalog read — the address and this tab's memory follow it, so a
  // reload reopens what is on screen. Not before the catalog answers: until
  // then nothing has been chosen, and a deep link is still being honoured.
  const loaded = catalog !== null;
  useEffect(() => {
    if (!loaded || unlisted) return;
    const url = new URL(window.location.href);
    if (selected) url.searchParams.set("conversation", selected); else url.searchParams.delete("conversation");
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
    try { if (selected) sessionStorage.setItem(`delphi:conversation:${key}`, selected); } catch {}
  }, [loaded, selected, key, unlisted]);
  const items = catalog?.items ?? [];
  const full = Boolean(catalog && isFull(catalog));
  const conversation = items.find(item => item.id === selected) ?? (seedConversation?.id === selected ? seedConversation : provisional);
  // A chat that belongs to no document is its own session, filed when it
  // leaves the screen. Beside a document the session is the document's, and
  // the reader reports that one.
  const ownSession = target.context === "general" && !conversation.provisional ? conversation.id : null;
  // Not before the catalog answers, when every rail is still on its draft.
  useEffect(() => { if (loaded) readerIsBeside({ conversationId: ownSession }); }, [loaded, ownSession]);
  useEffect(() => () => chatLeft(), []);
  const ensureConversation = async () => {
    if (!conversation.provisional) return conversation;
    const pending = creations.get(provisional.id);
    if (pending) return pending;
    const creation = api<ConversationSummary>("/api/chat/conversations", {
      method: "POST", body: JSON.stringify({ ...chatQuery(target), creation_key: provisional.id.replaceAll("-", "_") }),
    }).then(async created => {
      sessionCell(sessionFor(conversationKey(provisional)), "identity", created).current = created;
      adoptSession(conversationKey(provisional), conversationKey(created));
      setCatalog(current => ({ items: [...(current?.items ?? []).filter(item => item.id !== created.id), created], defaultId: current?.defaultId ?? created.id, limit: 10 }));
      select(created.id); conversationsChanged(); return created;
    }).finally(() => { creations.delete(provisional.id); });
    creations.set(provisional.id, creation);
    return creation;
  };
  const startDraft = () => { const id = `draft-${crypto.randomUUID()}`; setEnteringId(id); setProvisional({ id, generation: 0, title: "New chat", empty: true, provisional: true }); select(null); };
  /** A blank tab: the empty chat this context already holds, else a draft. */
  const openBlank = () => {
    const empty = items.find(isBlank);
    if (empty) { setEnteringId(empty.id); select(empty.id); } else startDraft();
  };
  const newChat = () => {
    if (isBlank(conversation)) return;
    if (full) { onNotice(hint(FULL)); return; }
    openBlank();
  };
  // The strip holds the chats left open and whichever is on screen, as many
  // as fit at a readable width; the context menu lists every chat with
  // something in it, closed or merely out of room.
  const past = items.filter(item => !isBlank(item));
  const open = items.filter(item => item.id === selected || (!closed.includes(item.id) && !isBlank(item)));
  const shown = conversation.provisional ? [...open, conversation] : open;
  const visible = shown.slice(0, visibleConversationCount(stripWidth, shown.length));
  if (!visible.some(item => item.id === conversation.id) && shown.length) visible.splice(Math.max(0, visible.length - 1), 1, conversation);
  /** No tab is left to show: the window goes with it. */
  const leave = () => {
    if (!onClose) { openBlank(); return; }
    // The next opening starts fresh rather than returning to what was closed.
    try { sessionStorage.removeItem(`delphi:conversation:${key}`); } catch {}
    const url = new URL(window.location.href);
    url.searchParams.delete("conversation");
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
    onClose();
  };
  /** The tab's cross: out of the strip, never out of the library. */
  const closeTab = (item: ConversationSummary) => {
    // A side chat belongs to its tab and goes with it.
    const session = existingSession(conversationKey(item));
    if (session) closeSideChat(session);
    // A tab behind the one on screen just leaves the strip.
    if (item.id !== conversation.id) { updateClosed([...closed, item.id]); return; }
    const index = shown.findIndex(row => row.id === item.id);
    const others = shown.filter(row => row.id !== item.id);
    const neighbour = others[index - 1] ?? others[index];
    // With no window to close and no room for a blank tab, the last tab has nowhere to go.
    if (!neighbour && !onClose && full) { onNotice(hint(FULL)); return; }
    if (item.provisional) disposeSession(conversationKey(item));
    else if (!isBlank(item)) updateClosed([...closed, item.id]);
    if (neighbour) select(neighbour.id); else leave();
  };
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      const result = await api<{ selectedId: string; catalog: ConversationCatalog }>(`/api/chat?${new URLSearchParams(conversationQuery(target, deleting))}`, { method: "DELETE" });
      disposeSession(conversationKey(deleting));
      setCatalog(result.catalog);
      const shut = closed.filter(id => id !== deleting.id);
      updateClosed(shut);
      // Only losing the chat on screen moves anything, and never onto a closed chat.
      if (selected === deleting.id) {
        const left = result.catalog.items.filter(item => !shut.includes(item.id) && !isBlank(item));
        const next = left.find(item => item.id === result.selectedId) ?? left.at(-1);
        if (next) select(next.id); else leave();
      }
      setDeleting(null);
      conversationsChanged();
    } catch (error) { onNotice(error instanceof Error ? error.message : "Could not delete conversation"); }
    finally { setBusy(false); }
  };
  if (!catalog) return problem
    ? <div className="conversation-loading" role="status">{problem}<button onClick={() => void reload()}>Retry</button></div>
    : <ConversationsOutline />;
  const choose = (item: ConversationSummary) => select(item.provisional ? null : item.id);
  const tabs = <div className="conversation-navigation" ref={setTabsNode}>
    <div className="conversation-tabs" role="tablist" aria-label="Conversations" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = shown.findIndex(item => item.id === conversation.id);
      const next = event.key === "Home" ? 0 : event.key === "End" ? shown.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + shown.length) % shown.length;
      choose(shown[next]);
      requestAnimationFrame(() => tabsNode?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus());
    }}>
      {visible.map(item => <div className={`conversation-tab${item.id === conversation.id ? " active" : ""}${item.id === enteringId ? " is-entering" : ""}`} key={item.id} onAnimationEnd={() => { if (enteringId === item.id) setEnteringId(null); }}>
        <button type="button" role="tab" aria-selected={item.id === conversation.id} tabIndex={item.id === conversation.id ? 0 : -1} title={[item.title, conversationStatus(item)].filter(Boolean).join(" · ")} onClick={() => choose(item)} onDoubleClick={() => { if (!item.provisional) { setRenaming(item); setName(item.title); } }}>
          {item.id === conversation.id ? null : <ConversationActivity item={item} />}<ScrollingTitle title={item.title} className="conversation-tab-title" />
        </button>
        {/* Every tab can close; a tab not on screen shows its cross on hover. */}
        <button type="button" className="conversation-tab-close" aria-label={`Close ${item.title}`} tabIndex={item.id === conversation.id ? 0 : -1} onClick={() => closeTab(item)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
      </div>)}
    </div>
    <button type="button" className="conversation-new" aria-label="New chat" data-tip="New chat" onClick={newChat}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg></button>
  </div>;
  const tools = <>
    {problem ? <p role="alert">{problem}</p> : null}
    {deleting || renaming ? <div className="conversation-dialog-backdrop"><form className="modal is-quiet conversation-dialog" role="dialog" aria-modal="true" aria-label={deleting ? "Delete conversation" : "Rename conversation"} onSubmit={event => { event.preventDefault(); if (deleting) void remove(); else if (renaming && name.trim()) { setBusy(true); void api(`/api/chat/conversations/${renaming.id}`, { method: "PATCH", body: JSON.stringify({ title: name.trim(), generation: renaming.generation }) }).then(() => { setRenaming(null); conversationsChanged(); }).catch(error => onNotice(error.message)).finally(() => setBusy(false)); } }}>
      <h2>{deleting ? `${items.length === 1 ? "Clear" : "Delete"} “${deleting.title}”?` : "Rename conversation"}</h2>
      {deleting ? <p>{conversationStatus(deleting) === "Answering" ? "This will stop its answer. " : ""}{items.length === 1 ? "Its messages will be erased, leaving an empty chat." : "This conversation and its attachments will be deleted."} Saved plans remain available.</p> : <input autoFocus maxLength={titleMaxCharacters} value={name} onChange={event => setName(event.target.value)} aria-label="Conversation title" />}
      <div className="modal-actions"><button type="button" className="secondary-button" autoFocus={Boolean(deleting)} disabled={busy} onClick={() => { setDeleting(null); setRenaming(null); }}>Cancel</button><button type="submit" className={deleting ? "danger-button" : "primary-button"} disabled={busy || Boolean(renaming && !name.trim())}>{busy ? "Saving…" : deleting ? items.length === 1 ? "Clear chat" : "Delete chat" : "Save"}</button></div>
    </form></div> : null}
  </>;
  const chats: ContextChats = { items: past, currentId: conversation.id, choose, remove: setDeleting, strip: { width: stripWidth, tabs: shown.length } };
  return children({ conversation, tabs, tools, chats, ensureConversation });
}

/**
 * The chat card before its conversations arrive: the scope, a tab and a first
 * exchange, outlined in the card's own frame, so the card does not jump into
 * place when they land.
 */
function ConversationsOutline() {
  return <section className="kb-chat-rail landed" aria-label="Chat">
    <div className="kb-ask-modal chat-surface conversation-outline skeleton" role="status">
      <LoadingWords text="Loading conversations" />
      <header className="conversation-header">
        <SkeletonBar width="84px" height={24} tone="tint" className="conversation-outline-scope" />
        <span className="conversation-outline-tab"><SkeletonBar height={9} tone="strong" /></span>
        <SkeletonBar width="80px" height={9} className="conversation-outline-tab-next" />
      </header>
      <div className="conversation-outline-body">
        <SkeletonBar width="62%" height={40} tone="tint" className="conversation-outline-question" />
        <SkeletonBar width="92%" height={9} tone="strong" />
        <SkeletonBar width="84%" height={9} />
        <SkeletonBar width="60%" height={9} />
      </div>
    </div>
  </section>;
}
