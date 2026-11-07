"use client";

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import type { TreeNode } from "../lib/memory-tree";

export type MemoryView = "map" | "health";

/**
 * The toggle's slide, carried across the route change it causes.
 *
 * Map, Health and a page are separate routes. The toggle resets when its
 * active view changes, so the pressed toggle can differ from the result. The
 * pressed one starts sliding at once; the new one picks the slide up where it
 * has got to, rather than appearing with the thumb already on the far side.
 */
let slide: { from: number; to: number; at: number } | null = null;

/**
 * The left rail of Memory: which view, then what that view is about.
 *
 * On the map and on Health it lists the domains as folders. A folder's
 * chevron expands its pages beneath it and zooms the map onto its circle; the
 * others stay in view so a reader can switch without backing out first. Its
 * name opens the domain's own page once one has been written, and until then
 * does what the chevron does: the pages filed there are all it has. On a page it
 * holds that page's links instead (the caller passes them as children), so
 * the page itself can take the whole width.
 *
 * Renaming and adding a domain live on the rows they change. Update is not a
 * header button any more: after a rename or a new domain it is a card that
 * says why it is worth running, and otherwise one quiet row at the foot.
 */
export function MemoryRail({
  view,
  onView,
  tree,
  focus,
  onFocus,
  openSlug,
  onOpen,
  onRenameDomain,
  onDeleteDomain,
  onCreateDomain,
  footer,
  children,
}: {
  view: MemoryView | "page";
  onView: (view: MemoryView) => void;
  tree?: TreeNode[];
  focus?: string | null;
  onFocus?: (slug: string | null) => void;
  openSlug?: string | null;
  onOpen?: (slug: string) => void;
  onRenameDomain?: (slug: string, title: string) => Promise<boolean>;
  onDeleteDomain?: (slug: string) => void;
  onCreateDomain?: (title: string) => void;
  /** Below the domains, at the rail's foot: what Health needs decided, and filing. */
  footer?: ReactNode;
  /** On a page: what the rail holds instead of the domains. */
  children?: ReactNode;
}) {
  const active: MemoryView = view === "health" ? "health" : "map";
  return (
    <aside className="kb-memory-rail" aria-label={view === "page" ? "Linked pages" : "Domains"}>
      <MemoryViewToggle key={active} active={active} onView={onView} />
      {view === "page" ? (
        children
      ) : (
        <DomainFolders
          tree={tree ?? []}
          focus={focus ?? null}
          onFocus={onFocus ?? (() => undefined)}
          openSlug={openSlug ?? null}
          onOpen={onOpen ?? (() => undefined)}
          onRenameDomain={onRenameDomain ?? (async () => false)}
          onDeleteDomain={onDeleteDomain ?? (() => undefined)}
          onCreateDomain={onCreateDomain ?? (() => undefined)}
        />
      )}
      {footer}
    </aside>
  );
}

/** A route change resets the optimistic press; the carried slide resumes on mount. */
function MemoryViewToggle({ active, onView }: {
  active: MemoryView;
  onView: (view: MemoryView) => void;
}) {
  // What the thumb shows: the press, before the route it starts has arrived.
  const [shown, setShown] = useState<MemoryView>(active);
  const toggle = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const carried = slide;
    slide = null;
    const to = active === "map" ? 0 : 1;
    const element = toggle.current;
    if (!carried || carried.to !== to || carried.from === to || !element) return;
    // The stylesheet's own timing, so the two halves are one motion.
    const style = getComputedStyle(element, "::before");
    const duration = parseFloat(style.transitionDuration) * 1000;
    const elapsed = performance.now() - carried.at;
    if (!(elapsed < duration)) return;
    element.animate(
      [
        { transform: `translateX(${carried.from * 100}%)` },
        { transform: `translateX(${to * 100}%)` },
      ],
      {
        duration,
        delay: -elapsed,
        easing: style.transitionTimingFunction,
        pseudoElement: "::before",
      },
    );
  }, [active]);
  return (
    <div
      ref={toggle}
      className="segmented library-tabs kb-memory-toggle"
      role="tablist"
      aria-label="Memory view"
      style={{ "--segment-index": shown === "map" ? 0 : 1 } as React.CSSProperties}
    >
      {(["map", "health"] as const).map((entry) => (
        <button
          key={entry}
          type="button"
          role="tab"
          aria-selected={active === entry}
          className={shown === entry ? "active" : ""}
          onClick={() => {
            if (entry !== shown) {
              slide = { from: shown === "map" ? 0 : 1, to: entry === "map" ? 0 : 1, at: performance.now() };
              setShown(entry);
            }
            onView(entry);
          }}
        >
          {entry === "map" ? "Map" : "Health"}
        </button>
      ))}
    </div>
  );
}

/** Every page below a domain, in tree order, however deep it is filed. */
function pagesUnder(node: TreeNode): TreeNode[] {
  return node.children.flatMap((child) => [child, ...pagesUnder(child)]);
}

function DomainFolders({
  tree,
  focus,
  onFocus,
  openSlug,
  onOpen,
  onRenameDomain,
  onDeleteDomain,
  onCreateDomain,
}: {
  tree: TreeNode[];
  focus: string | null;
  onFocus: (slug: string | null) => void;
  openSlug: string | null;
  onOpen: (slug: string) => void;
  onRenameDomain: (slug: string, title: string) => Promise<boolean>;
  onDeleteDomain: (slug: string) => void;
  onCreateDomain: (title: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const domains = tree.filter((node) => node.heading || node.depth === 0);
  const finishAdd = () => {
    const title = name.trim();
    if (title) onCreateDomain(title);
    setName("");
    setAdding(false);
  };
  return (
    <>
      <p className="kb-memory-label">Domains</p>
      <nav className="kb-memory-domains" aria-label="Domains">
        {domains.map((domain) => (
          <DomainRow
            key={domain.slug}
            domain={domain}
            expanded={focus === domain.slug}
            onToggle={() => onFocus(focus === domain.slug ? null : domain.slug)}
            openSlug={openSlug}
            onOpen={onOpen}
            onRenameDomain={onRenameDomain}
            onDeleteDomain={onDeleteDomain}
          />
        ))}
        {domains.length === 0 ? (
          <p className="kb-memory-empty">
            Nothing here yet. Pages are written as you read and ask questions.
          </p>
        ) : null}
        {adding ? (
          <form
            className="kb-memory-edit"
            onSubmit={(event) => {
              event.preventDefault();
              finishAdd();
            }}
          >
            <input
              value={name}
              autoFocus
              maxLength={120}
              placeholder="New domain"
              aria-label="New domain name"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                setName("");
                setAdding(false);
              }}
              onBlur={finishAdd}
            />
            <button type="submit" onMouseDown={(event) => event.preventDefault()}>
              Add
            </button>
          </form>
        ) : (
          <button type="button" className="kb-memory-new" onClick={() => setAdding(true)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
            New domain
          </button>
        )}
      </nav>
    </>
  );
}

function DomainRow({
  domain,
  expanded,
  onToggle,
  openSlug,
  onOpen,
  onRenameDomain,
  onDeleteDomain,
}: {
  domain: TreeNode;
  expanded: boolean;
  onToggle: () => void;
  openSlug: string | null;
  onOpen: (slug: string) => void;
  onRenameDomain: (slug: string, title: string) => Promise<boolean>;
  onDeleteDomain: (slug: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(domain.title);
  const saving = useRef(false);
  const cancelled = useRef(false);
  const pages = expanded ? pagesUnder(domain) : [];
  const save = async () => {
    if (saving.current) return;
    const next = title.trim();
    if (!next || next === domain.title) {
      setTitle(domain.title);
      setEditing(false);
      return;
    }
    saving.current = true;
    if (await onRenameDomain(domain.slug, next)) setEditing(false);
    saving.current = false;
  };
  return (
    <div className={expanded ? "kb-memory-domain is-open" : "kb-memory-domain"}>
      {editing ? (
        <form
          className="kb-memory-edit"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input
            value={title}
            autoFocus
            maxLength={120}
            aria-label={`Rename ${domain.title}`}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              cancelled.current = true;
              setTitle(domain.title);
              setEditing(false);
            }}
            onBlur={() => {
              if (cancelled.current) {
                cancelled.current = false;
                return;
              }
              void save();
            }}
          />
          <button type="submit" onMouseDown={(event) => event.preventDefault()}>
            Save
          </button>
        </form>
      ) : (
        <div className="kb-memory-domain-row">
          <button
            type="button"
            className="kb-memory-domain-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${domain.title}`}
            onClick={onToggle}
          >
            <svg className="kb-memory-chevron" viewBox="0 0 16 16" aria-hidden="true">
              <path d="m6 3.5 4.5 4.5L6 12.5" />
            </svg>
          </button>
          <button
            type="button"
            className="kb-memory-domain-name"
            title={domain.openable ? `Open ${domain.title}` : undefined}
            onClick={() => (domain.openable ? onOpen(domain.slug) : onToggle())}
          >
            <span>{domain.title}</span>
            <span className="kb-memory-count">{domain.count}</span>
          </button>
          {/* Only on the open domain: a pencil on every row was a column of
              marks the reader had to look past to read the names. */}
          {expanded && domain.heading ? (
            <button
              type="button"
              className="kb-memory-icon"
              aria-label={`Rename ${domain.title}`}
              title="Rename"
              onClick={() => {
                setTitle(domain.title);
                setEditing(true);
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 13h2.6l7-7-2.6-2.6-7 7z" />
                <path d="m9 4.4 2.6 2.6" />
              </svg>
            </button>
          ) : null}
          {/* Removable exactly while it holds nothing — the server's own test,
              so the button is offered only where it would be honoured. */}
          {expanded && domain.heading && domain.count === 0 ? (
            <button
              type="button"
              className="kb-memory-icon"
              aria-label={`Remove ${domain.title}`}
              title="Remove empty domain"
              onClick={() => onDeleteDomain(domain.slug)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
              </svg>
            </button>
          ) : null}
        </div>
      )}
      {expanded ? (
        <ul className="kb-memory-pages">
          {pages.map((page) => (
            <li key={page.slug}>
              <button
                type="button"
                className={page.slug === openSlug ? "is-open" : undefined}
                disabled={!page.openable}
                onClick={() => onOpen(page.slug)}
              >
                <span className={`kb-memory-dot kb-memory-dot-${page.kind}`} aria-hidden="true" />
                <span className="kb-memory-page-title">{page.title}</span>
              </button>
            </li>
          ))}
          {pages.length === 0 ? (
            <li className="kb-memory-empty">Empty until Update files pages here.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
