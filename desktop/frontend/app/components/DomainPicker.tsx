"use client";

import type { MouseEvent } from "react";
import type { MemoryDomainDestination } from "../lib/api";

/**
 * Where a page goes when its domain is deleted, picked from a tag: shared by
 * Delete domain and Delete page. The menu is the model picker's, drawn fixed
 * so a scrolling list or a dialog's edge never clips it.
 */

/** Its width, one row, and the most it grows to. */
const MENU_WIDTH = 184;
const MENU_ROW = 22;
const MENU_MAX = 214;

export type DomainMenuAt = { id: string; top: number; left: number };

/** The menu for `id`, under the tag that opened it, or above it near the window's foot. */
export function domainMenuAt(id: string, event: MouseEvent<HTMLElement>, count: number): DomainMenuAt {
  const box = event.currentTarget.getBoundingClientRect();
  const tall = Math.min(MENU_MAX, count * MENU_ROW + 12);
  const below = box.bottom + 4;
  return {
    id,
    top: below + tall > window.innerHeight - 8 ? box.top - 4 - tall : below,
    left: Math.max(8, box.right - MENU_WIDTH),
  };
}

/** A domain as a tag: grey once chosen, a dashed "Move to…" before. */
export function DomainChip({ value, title, open, label, onClick }: {
  value: string;
  title: string;
  open: boolean;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={value ? "delete-domain-chip" : "delete-domain-chip is-empty"}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={label}
      onClick={onClick}
    >
      {value ? null : (
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
      )}
      <span>{value ? title : "Move to…"}</span>
    </button>
  );
}

export function DomainMenu({ at, destinations, current, onPick }: {
  at: DomainMenuAt;
  destinations: MemoryDomainDestination[];
  current: string;
  onPick: (domain: string) => void;
}) {
  return (
    <div
      className="delete-domain-menu"
      role="listbox"
      aria-label="Domains"
      style={{ top: at.top, left: at.left }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {destinations.map((domain) => (
        <button
          key={domain.slug}
          type="button"
          role="option"
          aria-selected={current === domain.slug}
          onClick={() => onPick(domain.slug)}
        >
          <span>{domain.title}</span>
          <small>{domain.pages}</small>
        </button>
      ))}
      {destinations.length === 0 ? <p>No other domain yet. Make one from the sidebar first.</p> : null}
    </div>
  );
}
