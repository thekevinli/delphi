"use client";

/** Shared navigation for Reader and Memory. */

import Link from "next/link";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

import { AccountMenu } from "./AccountMenu";
import { HistoryControls } from "./HistoryControls";
import { SearchOverlay } from "./SearchOverlay";
import type { User } from "../lib/api";

export function TopBar({
  user,
  onOpenSettings,
  actions,
  className,
}: {
  /** Null while `/api/auth/me` is in flight — the strip is simply empty. */
  user: User | null;
  onOpenSettings: () => void;
  /** Surface-specific controls immediately before the account menu. */
  actions?: ReactNode;
  className?: string;
}) {
  const [searching, setSearching] = useState(false);
  const closeSearch = useCallback(() => setSearching(false), []);

  /**
   * ⌘K, and deliberately not ⌘F: find-in-page is the browser's, and a reader
   * looking for a word inside the PDF they have open should keep it. The
   * Dashboard used to bind ⌘K to focus its own composer; one key now means one
   * thing on every route, which is the only way the menu's "⌘K" is honest.
   */
  useEffect(() => {
    if (!user) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [user]);

  return (
    <header className={className ? `topbar ${className}` : "topbar"}>
      <div className="brand">
        <HistoryControls />
        <Link className="brand-home" href="/" aria-label="Dashboard home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/delphi-mark.svg" alt="" className="brand-mark" />
        </Link>
      </div>
      <div className="account-strip">
        {actions}
        {user ? (
          <AccountMenu
            onOpenSettings={onOpenSettings}
            onOpenSearch={() => setSearching(true)}
          />
        ) : null}
      </div>
      {user ? (
        <SearchOverlay
          username={user.username}
          open={searching}
          onClose={closeSearch}
        />
      ) : null}
    </header>
  );
}
