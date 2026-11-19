"use client";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { useSearchParams } from "next/navigation";
import { ConversationActivity } from "./ConversationMenus";
import ScrollingTitle from "../ScrollingTitle";
import { api } from "../../lib/api";
import { chatQuery, scopeKey, type ChatTarget } from "../../lib/chat-scope";
import { chatTime, groupChats, newestFirst } from "../../lib/conversation-layout";
import { shortRelativeTime } from "../../lib/dashboard";
import { adoptSession, conversationKey, isBlank, conversationStatus, conversationStatusVersion, disposeSession, sessionCell, sessionFor, subscribeConversationStatus, type ConversationCatalog, type ConversationSummary } from "../../lib/conversation-session";
import { chatLeft, readerIsBeside } from "../../lib/memory-maintenance";
import { useEscapeFromOutside } from "../../lib/use-dismiss";
import { hint, type Notice } from "../Notice";
import { LoadingWords, SkeletonBar } from "../Loading";

export const conversationsChanged = () => window.dispatchEvent(new Event("delphi-conversations-changed"));
const fetchCatalog = (target: ChatTarget) =>
  api<ConversationCatalog>(`/api/chat/conversations?${new URLSearchParams(chatQuery(target))}`);
/** One creation per provisional chat, however many sends race to make it. */
const creations = new Map<string, Promise<ConversationSummary>>();
export function conversationQuery(target: ChatTarget, conversation: ConversationSummary) {
  return { ...chatQuery(target), conversation_id: conversation.id, generation: String(conversation.generation) };
}

/** Every chat the context may hold has something in it: there is no room for a new one. */
/** Where the keyboard goes once a switch from the header lands: back to the title, or into a new chat's composer. */
let refocus: "switch" | "compose" | null = null;
const isFull = (catalog: ConversationCatalog) => catalog.items.length >= catalog.limit && !catalog.items.some(isBlank);
const FULL = (catalog: ConversationCatalog) => `${catalog.limit} chats maximum. Continue a chat or delete one to start another.`;
/** How many rows a new chat offers: its latest others first, then openers to fill the rest. */
const EARLIER_COUNT = 2;

export type ConversationParts = {
  conversation: ConversationSummary;
  /** The reader's header: the chat's title, which drops its document's chats, and +. */
  switcher: ReactNode;
  /** A new chat's most recent others, with `fill` drawing openers into the rows they leave. */
  earlier: (fill: (room: number) => ReactNode) => ReactNode;
  /** The rename and delete dialogs, and any problem loading the chats. */
  tools: ReactNode;
  ensureConversation: () => Promise<ConversationSummary>;
};

/**
 * One context's chats and which is on screen. A document's are switched from
 * the title at the top of its chat; Memory's are listed in the Memory page's
 * rail (`listHost`), which starts on a new chat unless a link names one.
 */
export function ConversationRail({ target, seedConversation, titleMaxCharacters, onNotice, listHost, children }: {
  target: ChatTarget;
  seedConversation?: ConversationSummary;
  /** The server's bound on a title; the rename box offers back a generated one. */
  titleMaxCharacters: number;
  onNotice: (notice: Notice) => void;
  /** The Memory page's rail, where its chats are listed. */
  listHost?: HTMLElement | null;
  children: (parts: ConversationParts) => ReactNode;
}) {
  const key = scopeKey(target);
  const page = listHost !== undefined;
  const searchParams = useSearchParams();
  const [catalog, setCatalog] = useState<ConversationCatalog | null>(null);
  const [selected, setSelected] = useState<string | null>(() => seedConversation?.id ?? null);
  // Capture the same navigation snapshot that selected this scope. During a
  // transition window.location can still name the departing context's chat.
  const [linked] = useState(() => searchParams.get("conversation"));
  const [provisional, setProvisional] = useState<ConversationSummary>(() => ({ id: `draft-${crypto.randomUUID()}`, generation: 0, title: "New chat", empty: true, provisional: true }));
  const [problem, setProblem] = useState("");
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  const [renaming, setRenaming] = useState<ConversationSummary | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
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
      const exists = (id: string | null | undefined) => value.items.some(item => item.id === id);
      if (requested && !exists(requested)) onNotice(hint("That conversation is no longer available."));
      const blank = value.items.find(isBlank)?.id;
      const recent = newestFirst(value.items.filter(item => !isBlank(item)))[0]?.id;
      let remembered: string | null = null;
      try { remembered = sessionStorage.getItem(`delphi:conversation:${key}`); } catch {}
      // A document reopens the chat last read beside it, else its latest; the Memory page, like
      // a new conversation anywhere, starts blank unless a link names one.
      let choice = exists(requested) ? requested
        : page ? blank ?? null
        : exists(remembered) ? remembered : recent ?? blank ?? null;
      // Without room for a new chat, the latest comes back, and the reader is told why.
      if (!choice && isFull(value)) { choice = recent ?? null; onNotice(hint(FULL(value))); }
      setSelected(choice);
    }, (error: unknown) => { if (active) setProblem(error instanceof Error ? error.message : "Could not load conversations"); });
    const refresh = () => { void reload(); };
    window.addEventListener("delphi-conversations-changed", refresh);
    return () => { active = false; window.removeEventListener("delphi-conversations-changed", refresh); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reload]);
  // A composer handing over a conversation selects it on the render that sees it.
  const [seedSeen, setSeedSeen] = useState(seedConversation?.id);
  if (seedConversation && seedConversation.id !== seedSeen) {
    setSeedSeen(seedConversation.id);
    setSelected(seedConversation.id);
  }
  useEffect(() => { if (seedSeen) void reload(); }, [seedSeen, reload]);
  // A later link to another conversation, while this rail stays mounted. The
  // rail's own address writes name what is already selected.
  const routed = searchParams.get("conversation");
  const [routeSeen, setRouteSeen] = useState(routed);
  // A chat this rail has not listed, begun since it loaded or since deleted, is asked for first.
  const [unlisted, setUnlisted] = useState<string | null>(null);
  if (routed !== routeSeen) {
    setRouteSeen(routed);
    setUnlisted(null);
    if (routed && routed !== selected) {
      if (catalog?.items.some(item => item.id === routed)) setSelected(routed); else setUnlisted(routed);
    }
  }
  useEffect(() => {
    if (!unlisted) return;
    let active = true;
    void reload().then(value => {
      if (!active || !value) return;
      setUnlisted(null);
      if (value.items.some(item => item.id === unlisted)) setSelected(unlisted);
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
    // Only a document remembers its chat; the Memory page opens blank.
    try { if (selected && !page) sessionStorage.setItem(`delphi:conversation:${key}`, selected); } catch {}
  }, [loaded, selected, key, unlisted, page]);
  const items = catalog?.items ?? [];
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
      setCatalog(current => current && { ...current, items: [...current.items.filter(item => item.id !== created.id), created] });
      setSelected(created.id); conversationsChanged(); return created;
    }).finally(() => { creations.delete(provisional.id); });
    creations.set(provisional.id, creation);
    return creation;
  };
  /** A new chat: the empty one this context already holds, else a draft. */
  const newChat = () => {
    if (isBlank(conversation)) return;
    if (catalog && isFull(catalog)) { onNotice(hint(FULL(catalog))); return; }
    draft(items);
  };
  /** The empty chat among `left`, else a fresh draft that has never been sent. */
  const draft = (left: ConversationSummary[]) => {
    const empty = left.find(isBlank);
    if (empty) { setSelected(empty.id); return; }
    setProvisional({ id: `draft-${crypto.randomUUID()}`, generation: 0, title: "New chat", empty: true, provisional: true });
    setSelected(null);
  };
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      const result = await api<{ selectedId: string; catalog: ConversationCatalog }>(`/api/chat?${new URLSearchParams(conversationQuery(target, deleting))}`, { method: "DELETE" });
      disposeSession(conversationKey(deleting));
      setCatalog(result.catalog);
      // Only losing the chat on screen moves anything: the Memory page to a new
      // chat, a document to its latest.
      if (selected === deleting.id) {
        const left = result.catalog.items;
        const latest = newestFirst(left.filter(item => !isBlank(item)))[0];
        if (latest && !page) setSelected(latest.id); else draft(left);
      }
      setDeleting(null);
      conversationsChanged();
    } catch (error) { onNotice(error instanceof Error ? error.message : "Could not delete conversation"); }
    finally { setBusy(false); }
  };
  if (!catalog) return problem
    ? <div className="conversation-loading" role="status">{problem}<button onClick={() => void reload()}>Retry</button></div>
    : <ConversationsOutline page={page} />;
  const choose = (item: ConversationSummary) => setSelected(item.provisional ? null : item.id);
  const rename = (item: ConversationSummary) => { setRenaming(item); setName(item.title); };
  const past = newestFirst(items.filter(item => !isBlank(item)));
  const rows = { current: conversation.id, onChoose: choose, onRename: rename, onDelete: setDeleting };
  const switcher = <>
    <ChatSwitcher conversation={conversation} items={past} {...rows} />
    <button type="button" className="conversation-new" aria-label="New chat" data-tip="New chat" disabled={isBlank(conversation)} onClick={() => { refocus = "compose"; newChat(); }}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
    </button>
  </>;
  const others = past.filter(item => item.id !== conversation.id).slice(0, EARLIER_COUNT);
  const earlier = (fill: (room: number) => ReactNode) => isBlank(conversation) ? <section className="conversation-earlier" aria-label={others.length ? "Earlier chats" : "Suggested questions"}>
    <div className="conversation-earlier-rows">
      {others.map(item => <ChatRow key={item.id} item={item} onChoose={choose} lead={EARLIER_MARK} />)}
      {fill(EARLIER_COUNT - others.length)}
    </div>
  </section> : null;
  const tools = <>
    {problem ? <p role="alert">{problem}</p> : null}
    {deleting || renaming ? <div className="conversation-dialog-backdrop"><form className="modal is-quiet conversation-dialog" role="dialog" aria-modal="true" aria-label={deleting ? "Delete conversation" : "Rename conversation"} onSubmit={event => { event.preventDefault(); if (deleting) void remove(); else if (renaming && name.trim()) { setBusy(true); void api(`/api/chat/conversations/${renaming.id}`, { method: "PATCH", body: JSON.stringify({ title: name.trim(), generation: renaming.generation }) }).then(() => { setRenaming(null); conversationsChanged(); }).catch(error => onNotice(error.message)).finally(() => setBusy(false)); } }}>
      <h2>{deleting ? `${items.length === 1 ? "Clear" : "Delete"} “${deleting.title}”?` : "Rename conversation"}</h2>
      {deleting ? <p>{conversationStatus(deleting) === "Answering" ? "This will stop its answer. " : ""}{items.length === 1 ? "Its messages will be erased, leaving an empty chat." : "This conversation and its attachments will be deleted."} Saved plans remain available.</p> : <input autoFocus maxLength={titleMaxCharacters} value={name} onChange={event => setName(event.target.value)} aria-label="Conversation title" />}
      <div className="modal-actions"><button type="button" className="secondary-button" autoFocus={Boolean(deleting)} disabled={busy} onClick={() => { setDeleting(null); setRenaming(null); }}>Cancel</button><button type="submit" className={deleting ? "danger-button" : "primary-button"} disabled={busy || Boolean(renaming && !name.trim())}>{busy ? "Saving…" : deleting ? items.length === 1 ? "Clear chat" : "Delete chat" : "Save"}</button></div>
    </form></div> : null}
  </>;
  return <>
    {children({ conversation, switcher, earlier, tools, ensureConversation })}
    {listHost ? createPortal(<MemoryChatList conversation={conversation} items={past} onNew={newChat} {...rows} />, listHost) : null}
  </>;
}

type RowActions = {
  current?: string;
  onChoose: (item: ConversationSummary) => void;
  onRename?: (item: ConversationSummary) => void;
  onDelete?: (item: ConversationSummary) => void;
};

/**
 * One chat: its title, which runs like a ticker under the pointer, and right
 * of it what it is doing and when it was last used. Where it can be changed,
 * a ⋮ takes the time's place on hover and offers Rename and Delete in it.
 */
const EARLIER_MARK = <svg className="conversation-row-lead" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10v7H7.5L4.5 13v-2.5H3z" /></svg>;

function ChatRow({ item, current, onChoose, onRename, onDelete, menu = false, when = shortRelativeTime, options = false, onOptions, lead }: RowActions & {
  item: ConversationSummary;
  /** A mark before the title, where the row sits among openers that wear one. */
  lead?: ReactNode;
  /** A row of a menu, rather than of a list. */
  menu?: boolean;
  when?: (iso: string) => string;
  options?: boolean;
  onOptions?: (open: boolean) => void;
}) {
  const open = item.id === current;
  const editable = Boolean(onOptions && onRename && onDelete && !item.provisional);
  return <div className={`conversation-row${open ? " is-current" : ""}${options ? " is-open" : ""}`} data-conversation={item.id}
    onContextMenu={editable ? event => { event.preventDefault(); onOptions!(true); } : undefined}>
    <button type="button" role={menu ? "menuitem" : undefined} aria-current={open || undefined} onClick={() => onChoose(item)}>
      {lead}
      <ScrollingTitle title={item.title} className="conversation-row-title" />
      {open ? null : <ConversationActivity item={item} />}
      {item.lastEngagedAt ? <time dateTime={item.lastEngagedAt}>{when(item.lastEngagedAt)}</time> : null}
    </button>
    {editable ? options
      ? <span className="conversation-row-actions">
          <button type="button" role={menu ? "menuitem" : undefined} autoFocus onClick={() => { onOptions!(false); onRename!(item); }}>Rename</button>
          <button type="button" role={menu ? "menuitem" : undefined} onClick={() => { onOptions!(false); onDelete!(item); }}>Delete</button>
        </span>
      : <button type="button" className="conversation-row-more" role={menu ? "menuitem" : undefined} aria-label={`Options for ${item.title}`} onClick={() => onOptions!(true)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="3.5" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="8" cy="12.5" r="1.3" /></svg>
        </button> : null}
  </div>;
}

/** Which row shows Rename and Delete in its ⋮'s place. A click elsewhere puts the ⋮ back; Escape also gives it the keyboard. */
function useRowOptions(root: RefObject<HTMLElement | null>) {
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  useEffect(() => {
    if (!optionsFor) return;
    const outside = (event: Event) => { if (!(event.target as Element).closest?.(`[data-conversation="${optionsFor}"]`)) setOptionsFor(null); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [optionsFor]);
  const dismiss = () => {
    const id = optionsFor;
    flushSync(() => setOptionsFor(null));
    root.current?.querySelector<HTMLElement>(`[data-conversation="${id}"] .conversation-row-more`)?.focus();
  };
  return { optionsFor, setOptionsFor, dismiss };
}

/** Arrow keys move through a list's rows, wrapping at either end. */
function moveFocus(root: HTMLElement | null, key: string) {
  const items = [...root?.querySelectorAll<HTMLButtonElement>(".conversation-row > button:first-child") ?? []];
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = key === "Home" ? 0 : key === "End" ? items.length - 1 : current < 0 ? (key === "ArrowUp" ? items.length - 1 : 0) : (current + (key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
  items[next]?.focus();
}

/**
 * The chat's title, which drops this document's chats as a flush sheet under
 * the header: titles newest first, the open one marked at its edge. Two
 * clicks switch, and nothing opens on hover.
 */
function ChatSwitcher({ conversation, items, ...rows }: RowActions & { conversation: ConversationSummary; items: ConversationSummary[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { optionsFor, setOptionsFor, dismiss } = useRowOptions(root);
  const sheet = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => { setOpen(false); setOptionsFor(null); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", close);
    // The open chat's row, or the first, takes the keyboard.
    const row = (selector: string) => sheet.current?.querySelector<HTMLButtonElement>(`${selector} > button:first-child`);
    (row(".conversation-row.is-current") ?? row(".conversation-row"))?.focus({ preventScroll: true });
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("blur", close); };
  }, [open]);
  useEscapeFromOutside(open, root, close);
  useEffect(() => {
    const target = refocus === "switch" ? root.current?.querySelector<HTMLElement>(".conversation-switch-trigger")
      : refocus === "compose" ? root.current?.closest(".kb-ask-modal")?.querySelector<HTMLElement>("[contenteditable=true]") : null;
    refocus = null;
    target?.focus({ preventScroll: true });
  }, [conversation.id]);
  const blank = isBlank(conversation);
  // A chat answering out of sight shows on the title, so the sheet need not be opened to know.
  const answering = items.some(item => item.id !== conversation.id && conversationStatus(item) === "Answering");
  return <div className="conversation-switch" ref={root} onKeyDown={event => {
    // Escape closes a row's actions, then the sheet; Tab leaves the sheet for its title.
    if ((event.key === "Escape" || event.key === "Tab") && open) {
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape" && optionsFor) { dismiss(); return; }
      close(); root.current?.querySelector<HTMLButtonElement>(".conversation-switch-trigger")?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !items.length) return;
    event.preventDefault(); event.stopPropagation();
    if (open) moveFocus(sheet.current, event.key); else setOpen(true);
  }}>
    <button type="button" className={`conversation-switch-trigger${blank ? " is-blank" : ""}`} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? id : undefined} title={conversation.title} disabled={!items.length}
      onClick={() => open ? close() : setOpen(true)}>
      <span className="conversation-switch-title">{conversation.title}</span>
      {answering ? <svg className="conversation-activity running" viewBox="0 0 16 16" role="img" aria-label="Another chat is answering"><circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 5.2 3"/></svg> : null}
      <svg className="conversation-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d={open ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4"} /></svg>
    </button>
    {open ? <>
      <div className="conversation-sheet-veil" aria-hidden="true" onPointerDown={close} />
      <div id={id} className="conversation-sheet" role="menu" aria-label="Chats on this document" ref={sheet}>
        {items.map(item => <ChatRow key={item.id} item={item} menu {...rows}
          onChoose={value => { close(); refocus = "switch"; rows.onChoose(value); }}
          onRename={value => { close(); rows.onRename?.(value); }}
          onDelete={value => { close(); rows.onDelete?.(value); }}
          options={optionsFor === item.id} onOptions={shown => setOptionsFor(shown ? item.id : null)} />)}
      </div>
    </> : null}
  </div>;
}

/** Memory's chats in the Memory page's rail: New chat, then Today, This week and Earlier. */
function MemoryChatList({ conversation, items, onNew, ...rows }: RowActions & {
  conversation: ConversationSummary;
  items: ConversationSummary[];
  onNew: () => void;
}) {
  const list = useRef<HTMLElement>(null);
  const { optionsFor, setOptionsFor, dismiss } = useRowOptions(list);
  // A new chat sits at the top of Today until its first question is sent.
  const blank = isBlank(conversation) ? { ...conversation, title: "New chat", lastEngagedAt: undefined, createdAt: undefined } : null;
  const shown = blank ? [blank, ...items] : items;
  return <nav className="memory-chat-list" aria-label="Memory chats" ref={list} onKeyDown={event => {
    if (event.key === "Escape" && optionsFor) { event.preventDefault(); dismiss(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !(event.target as Element).closest(".conversation-row")) return;
    event.preventDefault();
    moveFocus(list.current, event.key);
  }}>
    <button type="button" className="memory-chat-new" onClick={onNew}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>New chat
    </button>
    {groupChats(shown).map(group => <section key={group.label} aria-label={group.label}>
      <h3 className="conversation-label">{group.label}</h3>
      <div className="memory-chat-rows">
        {group.items.map(item => <ChatRow key={item.id} item={item} when={chatTime} {...rows}
          options={optionsFor === item.id} onOptions={item === blank ? undefined : open => setOptionsFor(open ? item.id : null)} />)}
      </div>
    </section>)}
  </nav>;
}

/**
 * The chat card before its conversations arrive: the header's title, then a
 * first exchange, outlined in the card's own frame, so the card does not jump
 * into place when they land. The Memory page's card has no header.
 */
function ConversationsOutline({ page }: { page: boolean }) {
  return <section className={`kb-chat-rail landed${page ? " is-page" : ""}`} aria-label="Chat">
    <div className="kb-ask-modal chat-surface conversation-outline skeleton" role="status">
      <LoadingWords text="Loading conversations" />
      {page ? null : <header className="conversation-header">
        <SkeletonBar width="148px" height={9} tone="strong" className="conversation-outline-title" />
      </header>}
      <div className="conversation-outline-body">
        <SkeletonBar width="62%" height={40} tone="tint" className="conversation-outline-question" />
        <SkeletonBar width="92%" height={9} tone="strong" />
        <SkeletonBar width="84%" height={9} />
        <SkeletonBar width="60%" height={9} />
      </div>
    </div>
  </section>;
}
