"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent } from "react";
import type { User } from "../lib/api";
import { SearchIcon, SettingsIcon } from "./AccountMenu";
import { SearchOverlay } from "./SearchOverlay";
import { HistoryControls } from "./HistoryControls";

type Tool = "search" | "settings";

/**
 * A tool's icon answers the pointer with a motion of its own: the magnifier
 * looks around, the gear turns one tooth. A tooth is a sixth of a turn, so the
 * gear ends where it began. Each plays to its end once started, so leaving
 * early never snaps the icon back mid-turn.
 */
const TOOL_MOTION: Record<Tool, [Keyframe[], KeyframeAnimationOptions]> = {
  search: [[
    { transform: "rotate(0deg)" }, { transform: "rotate(-16deg)", offset: 0.3 },
    { transform: "rotate(8deg)", offset: 0.62 }, { transform: "rotate(0deg)" },
  ], { duration: 550, easing: "cubic-bezier(.3,.7,.3,1)" }],
  settings: [[{ transform: "rotate(0deg)" }, { transform: "rotate(60deg)" }], { duration: 450, easing: "cubic-bezier(.2,.8,.2,1)" }],
};

function playToolMotion(button: HTMLElement, tool: Tool) {
  const icon = button.querySelector("svg");
  if (!icon || icon.getAnimations().length || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  icon.animate(...TOOL_MOTION[tool]);
}

export function DashboardRail({ user, onOpenSettings }: {
  user: User | null;
  onOpenSettings: () => void;
}) {
  // Collapsed on every launch; a reader's choice lasts until the window closes.
  const [collapsed, setCollapsed] = useState(true);
  const [searching, setSearching] = useState(false);
  const closeSearch = useCallback(() => setSearching(false), []);
  // Collapsed, a tool's name shows beside the rail, outside it: the rail
  // clips what it holds. Kept after leaving so the label fades with its words.
  const [tip, setTip] = useState<{ tool: Tool; top: number; shown: boolean } | null>(null);
  const showTip = (tool: Tool, button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    setTip({ tool, top: rect.top + rect.height / 2, shown: true });
  };
  const hideTip = () => setTip((current) => current && { ...current, shown: false });
  const toolEvents = (tool: Tool) => ({
    onPointerEnter: (event: PointerEvent<HTMLButtonElement>) => {
      playToolMotion(event.currentTarget, tool);
      if (collapsed) showTip(tool, event.currentTarget);
    },
    onFocus: (event: FocusEvent<HTMLButtonElement>) => {
      if (collapsed && event.currentTarget.matches(":focus-visible")) showTip(tool, event.currentTarget);
    },
    onPointerLeave: hideTip,
    onBlur: hideTip,
  });
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try { setCollapsed(sessionStorage.getItem("delphi.dashboard.rail") !== "expanded"); } catch { /* Storage is optional. */ }
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (user && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [user]);
  const contentLeft = useRef<number | null>(null);
  const toggle = () => {
    contentLeft.current = document.querySelector(".dashboard-wrap")?.getBoundingClientRect().left ?? null;
    const next = !collapsed;
    setCollapsed(next);
    try { sessionStorage.setItem("delphi.dashboard.rail", next ? "collapsed" : "expanded"); } catch { /* Persistence is optional. */ }
  };
  useLayoutEffect(() => {
    const content = document.querySelector<HTMLElement>(".dashboard-wrap");
    const before = contentLeft.current;
    contentLeft.current = null;
    if (!content || before === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Lay out once, then move the content on the compositor rather than animating padding.
    const offset = before - content.getBoundingClientRect().left;
    const animation = content.animate([
      { transform: `translateX(${offset}px)` }, { transform: "translateX(0)" },
    ], { duration: 360, easing: "cubic-bezier(.22,1.08,.36,1)" });
    return () => animation.cancel();
  }, [collapsed]);
  return <>
    <div className="desktop-window-drag" aria-hidden="true" />
    <aside className={`dashboard-sidebar${collapsed ? " is-collapsed" : ""}`} aria-label="Dashboard navigation">
      {!collapsed && <HistoryControls />}
          <button type="button" className="desktop-rail-collapse" aria-label="Collapse sidebar"
            tabIndex={collapsed ? -1 : 0} aria-hidden={collapsed || undefined} aria-expanded={!collapsed} onClick={toggle}>
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
              <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
              <path d="M8 4v12" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
      {/* Collapsed, the brand gives way to the expand target behind it, but the
          tools stay live: a reader who wants Settings should not have to open
          the rail first. Everything else on the rail expands it. */}
      <div className="desktop-rail-inner">
        <div className="desktop-rail-header" inert={collapsed} aria-hidden={collapsed || undefined}>
          <Link href="/" className="desktop-rail-brand" aria-label="Delphi home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/delphi-mark-on-burgundy.svg" alt="" width="30" height="30" />
            <strong>Delphi</strong>
          </Link>

        </div>
        <nav className="desktop-rail-actions" aria-label="Tools">
          <button type="button" onClick={() => { hideTip(); setSearching(true); }} disabled={!user} aria-label="Search (⌘K)" {...toolEvents("search")}>
            <SearchIcon /><span>Search</span><kbd><span className="kbd-mod">⌘</span>K</kbd>
          </button>
          <button type="button" onClick={() => { hideTip(); onOpenSettings(); }} disabled={!user} aria-label="Settings" {...toolEvents("settings")}>
            <SettingsIcon /><span>Settings</span>
          </button>
        </nav>
      </div>
      {collapsed && <button type="button" className="desktop-rail-expand" aria-label="Expand sidebar" aria-expanded={false} onClick={toggle} />}
    </aside>
    {collapsed && tip && <span className={`desktop-rail-tip${tip.shown ? " is-shown" : ""}`} style={{ top: tip.top }} aria-hidden="true">
      {tip.tool === "search" ? <>Search<kbd><span className="kbd-mod">⌘</span>K</kbd></> : "Settings"}
    </span>}
    {user && <SearchOverlay username={user.username} open={searching} onClose={closeSearch} />}
  </>;
}
