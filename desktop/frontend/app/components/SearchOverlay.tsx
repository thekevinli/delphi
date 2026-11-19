"use client";

/**
 * One search box over the whole account.
 *
 * It replaces a Find control that sat in the application's top bar and reached
 * exactly one thing — wiki pages — while looking like it reached the product.
 * That control also *navigated*: pressing it on the graph route sent the reader
 * to the wiki with the catalog forced open, so asking a question rearranged the
 * page they were reading. This opens over whatever is mounted and puts it back
 * untouched when it closes.
 *
 * Mounted once, in `TopBar`, which is the single place all three shells share.
 * That is the whole of its plumbing: no shell knows it exists, and none of them
 * had to be taught.
 *
 * It renders through a **portal to `document.body`**, and that is not
 * optional. `position: fixed` is only relative to the viewport while no
 * ancestor establishes a containing block — and `transform`, `filter`,
 * `backdrop-filter`, `perspective`, `will-change` and `contain: paint` all do.
 * The Dashboard's own top bar takes `backdrop-filter: blur(18px)` the moment
 * the page is scrolled (`.dashboard-topbar.is-condensed`), so an overlay living
 * inside that header stopped covering the window and covered the *bar* instead:
 * a dim that ended a few hundred pixels down the page, but only after scrolling.
 * Mounting to the body puts it out of reach of anything a shell's chrome
 * decides to do to itself later.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

import { api } from "../lib/api";
import {
  EMPTY_RESULTS,
  FILTERS,
  GROUP_LABELS,
  MIN_QUERY,
  chipCounts,
  filterLabel,
  groupOf,
  highlightMatches,
  moveSelection,
  searchHref,
  visibleResults,
} from "../lib/search";
import type {
  SearchFilter,
  SearchKind,
  SearchResponse,
  SearchResult,
  SearchResults,
} from "../lib/search";

function MagnifierIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.25" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="m12.4 12.4 4.1 4.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** One glyph per kind, so a scanning eye sorts the list before reading it. */
function KindIcon({ kind }: { kind: SearchKind }) {
  if (kind === "document") {
    return (
      <svg viewBox="0 0 20 20" className="search-result-icon" fill="none" aria-hidden="true">
        <path
          d="M5.5 3.5h6l3.5 3.5v9a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path d="M11.2 3.6v3.6h3.6" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "conversation") {
    return (
      <svg viewBox="0 0 20 20" className="search-result-icon" fill="none" aria-hidden="true">
        <path
          d="M4 5.4a1.4 1.4 0 0 1 1.4-1.4h9.2A1.4 1.4 0 0 1 16 5.4v6.3a1.4 1.4 0 0 1-1.4 1.4H8.3L5 16.2v-3.1h-.6a.4.4 0 0 1-.4-.4Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" className="search-result-icon" fill="none" aria-hidden="true">
      <circle cx="10" cy="5.4" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5.2" cy="14" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="14.8" cy="14" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8.6 7.1 6.4 12.2m5-5.1 2.2 5.1M7.2 14h5.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/**
 * What each scope holds, shown before anything is typed.
 *
 * The empty state used to be one grey sentence floating in the middle of an
 * empty card. It named the same three things, but a reader had to parse a
 * sentence to learn what the box could reach — and a large panel holding one
 * line of centred text reads as unfinished rather than as waiting. Three rows
 * with the same icons the results use teach the vocabulary of the list before
 * the list exists, so the first search is read faster than it otherwise would
 * be.
 */
const SCOPES: Array<{ kind: SearchKind; label: string; hint: string }> = [
  { kind: "memory", label: "Memory", hint: "pages Delphi has written" },
  { kind: "document", label: "Documents", hint: "the text inside every paper and page" },
  { kind: "conversation", label: "Chats", hint: "everything you have asked Delphi" },
];

/** One key, drawn as a key. */
function Key({ children }: { children: string }) {
  return <kbd className="search-key">{children}</kbd>;
}

/**
 * The query, in the hit, in the hit's own type.
 *
 * Colour stays with the line — title, domain, snippet — so a match is a weight
 * change rather than a second paint. The spans themselves come from
 * `highlightMatches`, which uses the same terms the ranker did.
 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  return highlightMatches(text, query).map((span, index) =>
    span.match ? (
      <strong key={index} className="search-result-match">
        {span.text}
      </strong>
    ) : (
      <Fragment key={index}>{span.text}</Fragment>
    ),
  );
}

export function SearchOverlay({
  username,
  open,
  onClose,
}: {
  username: string;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SearchFilter>("all");
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS);
  const [selected, setSelected] = useState(-1);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /**
   * Where the pointer last actually was.
   *
   * Scrolling the list moves rows *under* a stationary cursor, and the browser
   * fires `mousemove` for that — so pressing ↓ scrolled the list, some unrelated
   * row slid beneath the pointer, and the hover handler immediately threw the
   * keyboard's selection away. The arrow keys effectively stopped working the
   * moment the list was long enough to scroll. A move is only a move if the
   * coordinates changed.
   */
  const pointerAt = useRef({ x: -1, y: -1 });

  const visible = useMemo(() => visibleResults(results, filter), [results, filter]);
  const counts = useMemo(() => chipCounts(results), [results]);
  const needle = query.trim();

  // Opening is a fresh question. Carrying the last one over would show a reader
  // answers to something they asked twenty minutes ago as though they were
  // about what they just typed — and the input is empty, so nothing on screen
  // would explain where the list came from.
  // Deferred rather than set in the effect body, which is this codebase's
  // standing answer to the same warning elsewhere: state written during an
  // effect cascades a second render before paint.
  useEffect(() => {
    if (!open) return;
    const reset = window.setTimeout(() => {
      setQuery("");
      setFilter("all");
      setResults(EMPTY_RESULTS);
      setSelected(-1);
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(reset);
  }, [open]);

  // One request per pause, not per keystroke, and the in-flight one is aborted
  // when the next is issued — a slow answer to "meta" must not land after the
  // answer to "metaquery" and replace it.
  useEffect(() => {
    if (!open || needle.length < MIN_QUERY) {
      const clear = window.setTimeout(() => {
        setResults(EMPTY_RESULTS);
        setSearching(false);
      }, 0);
      return () => window.clearTimeout(clear);
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      void api<SearchResponse>(
        `/api/search?q=${encodeURIComponent(needle)}`,
        { signal: controller.signal },
      )
        .then((payload) => {
          setResults(payload.results);
          setSelected(-1);
          setSearching(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setResults(EMPTY_RESULTS);
          setSearching(false);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, needle]);

  const openResult = useCallback(
    (result: SearchResult) => {
      const href = searchHref(username, result);
      if (!href) return;
      onClose();
      router.push(href);
    },
    [username, onClose, router],
  );

  /**
   * Keys are handled in the capture phase, and every one this overlay claims is
   * stopped there.
   *
   * Escape is the reason. Half the shells underneath keep a global Escape
   * listener of their own — the KB chat closes, a paper menu closes — so an
   * Escape that merely bubbled would close Search *and* whatever was behind it,
   * and the reader would find their conversation gone for having dismissed a
   * search box.
   */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setSelected((current) =>
          moveSelection(current, event.key === "ArrowDown" ? 1 : -1, visible.length),
        );
        return;
      }
      if (event.key === "Enter" && selected >= 0 && visible[selected]) {
        event.preventDefault();
        event.stopPropagation();
        openResult(visible[selected]);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose, visible, selected, openResult]);

  /**
   * Hover selects a row, but only when the pointer genuinely moved.
   *
   * One listener rather than a handler per row, and it reads the row out of the
   * DOM (`data-search-index`) rather than closing over an index — which is also
   * what keeps the coordinate check in an event handler, where reading a ref is
   * unambiguously safe.
   */
  useEffect(() => {
    if (!open) return;
    const onMove = (event: PointerEvent) => {
      const { x, y } = pointerAt.current;
      if (event.clientX === x && event.clientY === y) return;
      pointerAt.current = { x: event.clientX, y: event.clientY };
      const row = (event.target as Element | null)?.closest?.(
        "[data-search-index]",
      );
      if (!row) return;
      const at = Number(row.getAttribute("data-search-index"));
      if (!Number.isNaN(at)) setSelected(at);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [open]);

  // Keep the selected row in view when the arrows walk past the fold.
  useEffect(() => {
    if (selected < 0) return;
    listRef.current
      ?.querySelector(`[data-search-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // `document` does not exist while the server renders this, and the overlay
  // cannot be open on the first paint anyway — by the time `open` is true the
  // browser is certainly there. Same argument the account menu makes about
  // reading `localStorage` on open rather than in an effect.
  if (!open || typeof document === "undefined") return null;

  const groups: SearchKind[] =
    filter === "all" ? ["memory", "document", "conversation"] : [filter];
  let index = -1;

  return createPortal(
    /* `onMouseDown` on the backdrop rather than `useDismissOnOutsideActivity`:
       that hook also dismisses on `wheel`, which would close the overlay the
       moment a reader scrolled its own result list. */
    <div className="search-backdrop" onMouseDown={onClose}>
      <section
        className="search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search Delphi"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="search-field">
          <span className="search-field-well" aria-hidden="true">
            <MagnifierIcon className="search-field-icon" />
          </span>
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            value={query}
            placeholder="Search pages, documents and chats"
            aria-label="Search pages, documents and chats"
            /* Not `type="search"`: its native clear button fires Escape in some
               browsers, which would close the overlay when the reader meant to
               clear the field. */
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {needle.length >= MIN_QUERY ? (
          <div className="search-chips" role="tablist" aria-label="Filter results by kind">
            {FILTERS.map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={filter === entry}
                className={`search-chip${filter === entry ? " is-active" : ""}`}
                onClick={() => {
                  setFilter(entry);
                  setSelected(-1);
                }}
              >
                {filterLabel(entry)}
                <span className="search-chip-count">{counts[entry]}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="search-results" ref={listRef}>
          {needle.length < MIN_QUERY ? (
            <ul className="search-scopes">
              {SCOPES.map((scope) => (
                <li key={scope.kind} className="search-scope">
                  <span className="search-scope-mark">
                    <KindIcon kind={scope.kind} />
                  </span>
                  <span className="search-scope-body">
                    <span className="search-scope-label">{scope.label}</span>
                    <span className="search-scope-hint">{scope.hint}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : visible.length === 0 ? (
            <p className="search-hint">
              {searching
                ? "Searching…"
                : `Nothing matches every word of “${needle}”.`}
            </p>
          ) : (
            groups.map((kind) => {
              const rows = groupOf(results, kind);
              if (rows.length === 0) return null;
              return (
                <section key={kind} className="search-group">
                  <h2 className="search-group-title">{GROUP_LABELS[kind]}</h2>
                  {rows.map((result, position) => {
                    index += 1;
                    const at = index;
                    return (
                      <button
                        key={`${kind}-${position}`}
                        type="button"
                        data-search-index={at}
                        className={`search-result${selected === at ? " is-selected" : ""}`}
                        onClick={() => openResult(result)}
                      >
                        <KindIcon kind={result.kind} />
                        <span className="search-result-body">
                          <span className="search-result-title">
                            <HighlightedText text={result.title} query={needle} />
                          </span>
                          {result.subtitle ? (
                            <span className="search-result-where">
                              <HighlightedText text={result.subtitle} query={needle} />
                            </span>
                          ) : null}
                          {result.snippet ? (
                            <span className="search-result-snippet">
                              <HighlightedText text={result.snippet} query={needle} />
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </section>
              );
            })
          )}
        </div>
        {/* A base for the panel, and the only place the keyboard is taught.
            Without it the card ended in a soft edge over its own shadow and
            read as a box that had been cut off rather than one that finishes. */}
        <footer className="search-footer">
          <span className="search-legend">
            <Key>↑</Key>
            <Key>↓</Key>
            to move
          </span>
          <span className="search-legend">
            <Key>↵</Key>
            to open
          </span>
          <span className="search-legend">
            <Key>esc</Key>
            to close
          </span>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
