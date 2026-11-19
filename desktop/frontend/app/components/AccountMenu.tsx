"use client";

/** Desktop actions open from the top bar without exposing a local identity. */

import { useCallback, useEffect, useRef, useState } from "react";

import { useDismissOnOutsideActivity } from "../lib/use-dismiss";

/** The search glyph, at the menu's stroke weight rather than the top bar's. */
export function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" className="account-menu-icon" fill="none" aria-hidden="true">
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

/** A symmetric six-tooth gear shared by the Dashboard and account menu. */
export function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" className="account-menu-icon" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M10.06 3.85 Q10.13 3.20 11.18 3.20 L12.82 3.20 Q13.87 3.20 13.94 3.85 L14.04 4.88 Q14.10 5.53 14.79 5.93 L15.86 6.55 Q16.55 6.95 17.15 6.68 L18.09 6.25 Q18.69 5.98 19.21 6.89 L20.04 8.31 Q20.56 9.22 20.03 9.60 L19.19 10.20 Q18.65 10.59 18.65 11.38 L18.65 12.62 Q18.65 13.41 19.19 13.80 L20.03 14.40 Q20.56 14.78 20.04 15.69 L19.21 17.11 Q18.69 18.02 18.09 17.75 L17.15 17.32 Q16.55 17.05 15.86 17.45 L14.79 18.07 Q14.10 18.47 14.04 19.12 L13.94 20.15 Q13.87 20.80 12.82 20.80 L11.18 20.80 Q10.13 20.80 10.06 20.15 L9.96 19.12 Q9.90 18.47 9.21 18.07 L8.14 17.45 Q7.45 17.05 6.85 17.32 L5.91 17.75 Q5.31 18.02 4.79 17.11 L3.96 15.69 Q3.44 14.78 3.97 14.40 L4.81 13.80 Q5.35 13.41 5.35 12.62 L5.35 11.38 Q5.35 10.59 4.81 10.20 L3.97 9.60 Q3.44 9.22 3.96 8.31 L4.79 6.89 Q5.31 5.98 5.91 6.25 L6.85 6.68 Q7.45 6.95 8.14 6.55 L9.21 5.93 Q9.90 5.53 9.96 4.88 Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AccountMenu({
  onOpenSettings,
  onOpenSearch,
}: {
  onOpenSettings: () => void;
  onOpenSearch: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);
  // Stable across renders so the effect inside the hook is not torn down and
  // rebuilt on every keystroke elsewhere in the shell.
  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutsideActivity(open, "[data-account-menu]", close);

  return (
    <div className={`account-menu${open ? " is-open" : ""}`} data-account-menu>
        <button
          ref={trigger}
          type="button"
          className="desktop-menu-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-label="Search and settings"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          {/* Two lines, at the back and forward chevrons' weight beside it. */}
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden="true">
            <path d="M4.5 7.5h11M4.5 12.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      <div className={`account-menu-surface${open ? " is-open" : ""}`} inert={!open} aria-hidden={!open || undefined}>
          <div ref={menu} className="account-menu-list" role="menu" aria-label="Search and settings"
            onKeyDown={(event) => {
              const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
              } else if (event.key === "Escape") {
                close();
                requestAnimationFrame(() => trigger.current?.focus());
              }
            }}
            // Focus moving to the trigger is its click on the way: let that
            // click close the menu, or blur would close it and the click reopen it.
            onBlur={(event) => {
              if (event.relatedTarget === trigger.current) return;
              if (!event.currentTarget.contains(event.relatedTarget)) close();
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="account-menu-item"
              onClick={() => {
                close();
                onOpenSearch();
              }}
            >
              <SearchIcon />
              Search
              <span className="account-menu-shortcut" aria-hidden="true">⌘K</span>
            </button>
            {/* Settings is a button, not a link: it opens a sheet over whichever
                shell is mounted rather than going anywhere, and the three shells
                would otherwise each need a route for it. */}
            <button
              type="button"
              role="menuitem"
              className="account-menu-item"
              onClick={() => {
                close();
                onOpenSettings();
              }}
            >
              <SettingsIcon />
              Settings
            </button>
          </div>
      </div>
    </div>
  );
}
