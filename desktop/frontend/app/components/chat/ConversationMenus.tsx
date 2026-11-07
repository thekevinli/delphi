"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { chatQuery, scopeKey, scopeLabel, type ChatContext, type ChatTarget } from "../../lib/chat-scope";
import { contextNameFits } from "../../lib/conversation-layout";
import { conversationStatus, isBlank, type ConversationCatalog, type ConversationSummary } from "../../lib/conversation-session";
import { shortRelativeTime } from "../../lib/dashboard";
import { useEscapeFromOutside } from "../../lib/use-dismiss";
import ScrollingTitle from "../ScrollingTitle";
import { ContextIcon } from "./ContextIcon";

/** The least room the chats keep from the chat panel's edge. */
const PANEL_INSET = 8;
/** Dropped below the menu, the chats line up with the card's 12px content inset. */
const BELOW_INSET = 12;
/** The air between the context menu and the chats beside or below it. */
const LIST_GAP = 6;
const LIST_WIDTH = 320;
/** Narrower than this beside the menu, the chats drop below it instead. */
const LIST_MIN_SIDE = 260;
/** Inside a row, Delete stops short of the ⋮ at its right. */
const REMOVE_INSET = 28;
/** How long the pointer rests on a context before its chats replace the ones
 * shown, so a path to the list across the other context does not swap it. */
const HOVER_INTENT_MS = 200;

/** Arrow keys move through a menu's own items, wrapping at either end. */
function moveFocus(items: HTMLButtonElement[], key: string) {
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = key === "Home" ? 0 : key === "End" ? items.length - 1 : current < 0 ? (key === "ArrowUp" ? items.length - 1 : 0) : (current + (key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
  items[next]?.focus();
}

/** The context menu's dismissal and keyboard navigation. `aside` hangs beside
 * the menu, outside the clip its roll unrolls from. */
function ConversationMenu({ label, trigger, className = "", children, aside, onOpen }: {
  label: string; trigger: ReactNode; className?: string;
  children: (close: () => void) => ReactNode;
  aside?: (close: () => void) => ReactNode;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => setOpen(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", close);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("blur", close); };
  }, [open]);
  useEscapeFromOutside(open, root, close);
  return <div className={`conversation-menu ${className}`} ref={root} onKeyDown={event => {
    if (event.key === "Escape" && open) {
      event.preventDefault(); event.stopPropagation(); close();
      root.current?.querySelector<HTMLButtonElement>(":scope > button")?.focus();
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (!open) { setOpen(true); onOpen?.(); }
    requestAnimationFrame(() => moveFocus([...document.getElementById(id)?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []], event.key));
  }}>
    <button type="button" className="conversation-menu-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { if (!open) onOpen?.(); setOpen(!open); }}>{trigger}</button>
    {open ? <div id={id} role="menu" aria-label={label} className="conversation-menu-popover">{children(close)}</div> : null}
    {open && aside ? aside(close) : null}
  </div>;
}

/** What a chat is doing while it is not on screen. */
export function ConversationActivity({ item }: { item: ConversationSummary }) {
  const state = conversationStatus(item);
  return state === "Answering" ? <svg className="conversation-activity running" viewBox="0 0 16 16" role="img" aria-label="Answering"><circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 5.2 3"/></svg>
    : state === "Answer failed" ? <span className="conversation-activity failed" role="img" aria-label="Answer failed">!</span>
    : null;
}

/** The chats of the context on screen, which the rail owns: it alone knows
 * which is open and can reopen or delete one. */
export type ContextChats = {
  items: ConversationSummary[];
  currentId: string;
  choose: (item: ConversationSummary) => void;
  remove: (item: ConversationSummary) => void;
  /** The tab strip beside the menu: its width and the tabs open in it. */
  strip: { width: number; tabs: number };
};

/**
 * One context's chats, hanging beside the context menu with its top level with
 * the menu's first row; without room beside it, below it across the panel.
 * Titles keep one line and run like a ticker under the pointer, as Memory's do. A row of the context on screen offers
 * Delete from its ⋮ or a right-click; another context's rows only open.
 * Status and time sit right of the title.
 */
function ContextChatList({ id, context, items, currentId, onChoose, onDelete, onBack }: {
  id: string;
  context: ChatContext;
  items: ConversationSummary[];
  currentId?: string;
  onChoose: (item: ConversationSummary) => void;
  onDelete?: (item: ConversationSummary) => void;
  onBack: () => void;
}) {
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = list.current;
    const root = node?.closest<HTMLElement>(".conversation-menu");
    const clip = root?.querySelector<HTMLElement>(":scope > .conversation-menu-popover");
    const roll = clip?.querySelector<HTMLElement>(".conversation-scope-roll");
    const first = roll?.querySelector<HTMLElement>("[role=menuitemradio]");
    const card = root?.closest(".chat-surface");
    if (!node || !root || !clip || !roll || !first || !card) return;
    const place = () => {
      // Measured from the clip, which never moves: the roll inside it may still
      // be unrolling, and its transformed box is not where it comes to rest.
      const at = root.getBoundingClientRect(), box = clip.getBoundingClientRect(), panel = card.getBoundingClientRect();
      const right = box.left + roll.offsetLeft + roll.offsetWidth;
      const room = panel.right - PANEL_INSET - (right + LIST_GAP);
      const beside = room >= LIST_MIN_SIDE;
      const top = beside ? box.top + first.offsetTop : box.top + roll.offsetTop + roll.offsetHeight + LIST_GAP;
      node.style.width = `${beside ? Math.min(LIST_WIDTH, room) : panel.width - 2 * BELOW_INSET}px`;
      node.style.left = `${(beside ? right + LIST_GAP : panel.left + BELOW_INSET) - at.left}px`;
      node.style.top = `${top - at.top}px`;
      // A long list scrolls rather than run past the panel's foot.
      node.style.maxHeight = `${panel.bottom - PANEL_INSET - top}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(card);
    return () => observer.disconnect();
  }, [items.length]);
  const rows = useRef<HTMLDivElement>(null);
  const remove = useRef<HTMLButtonElement>(null);
  /*
   * Delete opens to the right of the list, level with its row, where it covers
   * nothing; only when the panel has no room there does it sit inside the row,
   * left of the ⋮. It lives in the card rather than the row because the rows
   * scroll, and a scroller clips everything inside it.
   */
  const placeRemove = () => {
    const node = list.current, button = remove.current, panel = node?.closest(".chat-surface");
    const row = optionsFor ? rows.current?.querySelector<HTMLElement>(`[data-conversation="${CSS.escape(optionsFor)}"]`) : null;
    if (!node || !button || !panel || !row) return;
    const card = node.getBoundingClientRect(), at = row.getBoundingClientRect(), room = panel.getBoundingClientRect().right - PANEL_INSET;
    // A row scrolled out of the list takes its Delete with it, as the scroller once clipped it.
    const shown = rows.current!.getBoundingClientRect();
    button.hidden = at.bottom <= shown.top || at.top >= shown.bottom;
    const outside = card.right + LIST_GAP + button.offsetWidth <= room;
    const left = outside ? card.right + LIST_GAP : at.right - REMOVE_INSET - button.offsetWidth;
    button.classList.toggle("is-beside", outside);
    button.style.left = `${left - card.left - node.clientLeft}px`;
    button.style.top = `${at.top + (at.height - button.offsetHeight) / 2 - card.top - node.clientTop}px`;
  };
  useLayoutEffect(placeRemove);
  // The list is moved and resized without a render (`place` above); its Delete follows.
  useEffect(() => {
    const node = list.current;
    if (!node || !optionsFor) return;
    const observer = new ResizeObserver(placeRemove);
    observer.observe(node);
    return () => observer.disconnect();
  });
  const removing = onDelete ? items.find(item => item.id === optionsFor && !item.provisional) : undefined;
  return <div id={id} className="conversation-chat-list" role="menu" aria-label={`${scopeLabel(context)} chats`} ref={list} onKeyDown={event => {
    if (event.key === "ArrowLeft" || event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onBack(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    moveFocus([...list.current?.querySelectorAll<HTMLButtonElement>(".conversation-menu-row > button:first-child") ?? []], event.key);
  }}>
    <div className="conversation-chat-rows" ref={rows} onScroll={placeRemove}>
      {items.map(item => <div className={`conversation-menu-row${optionsFor === item.id ? " is-open" : ""}`} key={item.id} data-conversation={item.id}
        onContextMenu={event => { event.preventDefault(); if (onDelete && !item.provisional) setOptionsFor(item.id); }}>
        <button type="button" role="menuitem" aria-current={item.id === currentId || undefined} onClick={() => onChoose(item)}>
          <ScrollingTitle title={item.title} className="conversation-chat-title" />
          {item.id === currentId ? null : <ConversationActivity item={item} />}
          {item.id === currentId ? <span className="conversation-chat-when is-open">Open</span>
            : item.lastEngagedAt ? <time className="conversation-chat-when" dateTime={item.lastEngagedAt}>{shortRelativeTime(item.lastEngagedAt)}</time> : null}
        </button>
        {/* A chat not yet created has nothing to delete. */}
        {onDelete && !item.provisional ? <button type="button" className="conversation-row-more" aria-label={`Options for ${item.title}`} aria-expanded={optionsFor === item.id}
          onClick={() => setOptionsFor(optionsFor === item.id ? null : item.id)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="3.4" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="8" cy="12.6" r="1.25"/></svg>
        </button> : null}
      </div>)}
    </div>
    {removing && onDelete ? <button type="button" role="menuitem" className="conversation-row-delete" ref={remove} aria-label={`Delete ${removing.title}`} onClick={() => onDelete(removing)}>Delete</button> : null}
  </div>;
}

/** Each context's chats, as last read when the menu opened. */
type Read = { items: Partial<Record<ChatContext, ConversationSummary[]>> };
export function ConversationScopeMenu({ context, options, projectId, paperId, onSelect, chats, direction = "down" }: {
  context: ChatContext; options: ChatContext[]; projectId?: string; paperId?: string;
  onSelect: (context: ChatContext, conversationId?: string) => void;
  /** The context on screen's chats. With them, pointing at a context shows its chats beside the menu. */
  chats?: ContextChats;
  /** The composer sits low in the window, so there its options roll upward. */
  direction?: "down" | "up";
}) {
  const [loaded, setLoaded] = useState<Read & { key: string }>({ key: "", items: {} });
  const [showing, setShowing] = useState<ChatContext | null>(null);
  const intent = useRef<number | undefined>(undefined);
  /** The pointer has to rest on a context to swap the chats already shown. */
  const pointAt = (option: ChatContext) => {
    window.clearTimeout(intent.current);
    if (showing === null) setShowing(option);
    else if (option !== showing) intent.current = window.setTimeout(() => setShowing(option), HOVER_INTENT_MS);
  };
  useEffect(() => () => window.clearTimeout(intent.current), []);
  const targets: ChatTarget[] = options.flatMap(option => option === "general" ? [{ context: option } as ChatTarget]
    : projectId && paperId ? [{ context: option, projectId, paperId }] : []);
  const key = targets.map(scopeKey).join("|");
  // Counts belong to the contexts they were read for; a different document shows "…" until read.
  const read: Read = loaded.key === key ? loaded : { items: {} };
  const readContexts = () => {
    setShowing(null);
    // With the rail's chats, the context on screen needs no reading.
    void Promise.all(targets.filter(target => !chats || target.context !== context).map(async target => {
      try {
        const value = await api<ConversationCatalog>(`/api/chat/conversations?${new URLSearchParams(chatQuery(target))}`);
        return [target.context, value.items] as const;
      } catch { return [target.context, undefined] as const; }
    })).then(values => setLoaded({
      key,
      items: Object.fromEntries(values.flatMap(([option, items]) => items ? [[option, items.filter(item => !isBlank(item))]] : [])),
    }));
  };
  // A context counts the chats its list shows; with the rail's chats, the one
  // on screen is read from the rail, so a chat begun or deleted here is counted.
  const chatsOf = (option: ChatContext) => chats && option === context ? chats.items : read.items[option];
  const listOf = (option: ChatContext) => chats ? chatsOf(option) : undefined;
  const countOf = (option: ChatContext) => chatsOf(option)?.length;
  const rollId = useId(), listId = useId();
  // Beside the tabs the name shows only where the strip can spare it. Judged
  // once the name has come to rest: mid-ease the strip's width lags the name's.
  const name = useRef<HTMLSpanElement>(null);
  const [named, setNamed] = useState(false);
  const [rested, setRested] = useState(0);
  const stripWidth = chats?.strip.width, stripTabs = chats?.strip.tabs;
  useLayoutEffect(() => {
    const node = name.current;
    if (stripWidth === undefined || stripTabs === undefined || !node || node.getAnimations().length) return;
    const style = getComputedStyle(node), gap = parseFloat(getComputedStyle(node.parentElement!).columnGap) || 0;
    const shown = node.getBoundingClientRect().width + gap + parseFloat(style.marginLeft);
    setNamed(contextNameFits(stripWidth + shown, parseFloat(style.getPropertyValue("--scope-name-width")) + gap, stripTabs));
  }, [stripWidth, stripTabs, context, rested]);
  /** Back from the chats to their context's row, with the chats put away. */
  const showRow = (option: ChatContext) => {
    document.getElementById(rollId)?.querySelector<HTMLButtonElement>(`[data-context="${option}"]`)?.focus();
    setShowing(null);
  };
  const badge = (value: ChatContext) => <span className="conversation-scope-badge" data-scope={value}><ContextIcon context={value} /><span className="conversation-scope-name" ref={name} onTransitionEnd={() => setRested(count => count + 1)}>{scopeLabel(value)}</span></span>;
  const shown = showing ? listOf(showing) : undefined;
  return <ConversationMenu label={`Chat context: ${scopeLabel(context)}`} className={`conversation-scope-menu${direction === "up" ? " is-up" : ""}${named ? " is-named" : ""}`} onOpen={readContexts}
    trigger={<>{badge(context)}<svg className="conversation-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6.4 4 3.6 4-3.6" /></svg></>}
    aside={showing && shown?.length ? close => <ContextChatList key={showing} id={listId} context={showing} items={shown}
      currentId={showing === context ? chats?.currentId : undefined}
      onChoose={item => { close(); if (showing === context) chats?.choose(item); else onSelect(showing, item.id); }}
      onDelete={showing === context ? item => { close(); chats?.remove(item); } : undefined}
      onBack={() => showRow(showing)} /> : undefined}>
    {/* Not a popover: the options roll down from under the pill, in its colour,
        so the pill and its choices read as one object. The rule parts the
        current choice, still named on the pill, from the list. */}
    {close => <div className="conversation-scope-roll" id={rollId}>
      <span className="conversation-scope-rule" aria-hidden="true" />
      {options.map(option => {
        const count = countOf(option);
        const list = Boolean(listOf(option)?.length);
        return <button key={option} type="button" role="menuitemradio" aria-checked={option === context} data-context={option}
          aria-haspopup={list ? "menu" : undefined} aria-expanded={list ? showing === option : undefined}
          onClick={() => { close(); onSelect(option); }}
          onPointerEnter={chats ? () => pointAt(option) : undefined}
          onPointerLeave={chats ? () => window.clearTimeout(intent.current) : undefined}
          onFocus={chats ? () => { window.clearTimeout(intent.current); setShowing(option); } : undefined}
          onKeyDown={list ? event => {
            if (event.key !== "ArrowRight") return;
            event.preventDefault(); event.stopPropagation();
            const first = () => document.getElementById(listId)?.querySelector<HTMLButtonElement>(".conversation-menu-row > button:first-child")?.focus();
            // Pointing or focus has usually shown the list already; otherwise it lands next frame.
            if (showing === option) first(); else { setShowing(option); requestAnimationFrame(first); }
          } : undefined}>
          <ContextIcon context={option} /><span className="conversation-scope-label">{scopeLabel(option)}</span>{count === undefined
            ? <span className="conversation-scope-count is-loading" aria-label="Counting threads">…</span>
            /* A plain figure: "0 threads" written out beside each context
               read as a sentence apiece. */
            : <span className={`conversation-scope-count${count ? "" : " is-empty"}`}
                aria-label={`${count} ${count === 1 ? "thread" : "threads"}`}>{count}</span>}
          {chats ? <svg className={`conversation-scope-more${list ? "" : " is-empty"}`} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg> : null}
        </button>;
      })}
    </div>}
  </ConversationMenu>;
}

/** Expand and Hide: each window action is its own button, named on hover. */
export function ConversationWindowControls({ fullscreen, onExpand, onClose }: { fullscreen: boolean; onExpand?: () => void; onClose?: () => void }) {
  if (!onExpand && !onClose) return null;
  const expand = fullscreen ? "Collapse chat" : "Expand chat";
  return <div className="conversation-window-controls">
    {onExpand ? <button type="button" className="conversation-window-button" aria-label={expand} data-tip={expand} onClick={onExpand}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d={fullscreen ? "M9.5 2.5v4h4M6.5 13.5v-4h-4M9.5 6.5 14 2M6.5 9.5 2 14" : "M10 2.5h3.5V6M6 13.5H2.5V10M13.5 2.5 9 7M2.5 13.5 7 9"} /></svg>
    </button> : null}
    {onClose ? <button type="button" className="conversation-window-button" aria-label="Hide chat" data-tip="Hide chat" onClick={onClose}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M10 2.5v11M5.2 6.4 6.8 8l-1.6 1.6" /></svg>
    </button> : null}
  </div>;
}
