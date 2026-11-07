"use client";

import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useHoverPeek } from "../lib/use-hover-peek";
import { cleanSourceTitle, siteLetter, siteName, type WebSource } from "../lib/web-sources";

/** A site's name and letter, read once per address however many chips cite it. */
const MARKS = new Map<string, { host: string; letter: string; tint: number }>();
/** Whether the shell has an icon for a site: asked once per session, however many marks show it. */
const ICONS = new Map<string, Promise<boolean>>();
const HAS_ICON = new Map<string, boolean>();

function markFor(url: string) {
  let mark = MARKS.get(url);
  if (!mark) MARKS.set(url, (mark = { host: siteName(url), ...siteLetter(url) }));
  return mark;
}

const iconSrc = (host: string) => `/desktop/favicon?host=${encodeURIComponent(host)}`;

function loadIcon(host: string): Promise<boolean> {
  let pending = ICONS.get(host);
  if (!pending) {
    pending = new Promise<boolean>((resolve) => {
      const image = new Image();
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
      image.src = iconSrc(host);
    }).then((found) => (HAS_ICON.set(host, found), found));
    ICONS.set(host, pending);
  }
  return pending;
}

/**
 * The mark a cited site wears, in the answer and in its Sources list alike:
 * its favicon, which the shell fetches and caches (`/desktop/favicon`), over
 * its first letter on a tint of its own. The letter shows until the icon
 * arrives, and stays where a site has none.
 */
export function SiteMark({ url }: { url: string }) {
  const { host, letter, tint } = markFor(url);
  const [icon, setIcon] = useState(() => HAS_ICON.get(host) ?? false);
  useEffect(() => {
    if (icon) return;
    let live = true;
    void loadIcon(host).then((found) => { if (live && found) setIcon(true); });
    return () => { live = false; };
  }, [host, icon]);
  return (
    <span className={`site-mark site-tint-${tint}${icon ? " has-icon" : ""}`} data-letter={letter} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {icon ? <img src={iconSrc(host)} alt="" /> : null}
    </span>
  );
}

const keyboardFocus = (node: Element) => node.matches(":focus-visible");

/**
 * A web page the answer cites, where the answer cites it: a chip with the
 * site's mark and name that opens the page outside the app. Resting on it, or
 * reaching it by keyboard, shows the row the Sources list has for it, so a
 * reader can tell `sgl-project/sglang-omni` from its docs before leaving.
 *
 * An answer can hold dozens of chips and few are ever rested on, so the peek
 * and its timers mount on the first approach rather than with every chip.
 */
export function WebCitation({ source }: { source: WebSource }) {
  const anchor = useRef<HTMLAnchorElement>(null);
  const [armed, setArmed] = useState(false);
  const arm = armed ? undefined : () => setArmed(true);
  return (
    <>
      <a
        ref={anchor}
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="web-citation"
        onMouseEnter={arm}
        onFocus={arm && ((event) => { if (keyboardFocus(event.currentTarget)) arm(); })}
      >
        <SiteMark url={source.url} />
        {markFor(source.url).host}
      </a>
      {armed ? <WebPeek anchor={anchor} source={source} /> : null}
    </>
  );
}

function WebPeek({ anchor, source }: { anchor: RefObject<HTMLAnchorElement | null>; source: WebSource }) {
  const card = useRef<HTMLDivElement>(null);
  const id = useId();
  const { visible, enter, leave, hold, dismiss } = useHoverPeek(".web-citation, .web-peek");
  const { title, detail } = cleanSourceTitle(source);

  // The approach that mounted this counts as the first, if the pointer or
  // focus is still there; the chip's own events carry every later one.
  useEffect(() => {
    const node = anchor.current;
    if (!node) return;
    if (node.matches(":hover") || keyboardFocus(node)) enter();
    const focus = () => { if (keyboardFocus(node)) enter(); };
    const events: Array<[string, () => void]> = [["mouseenter", enter], ["mouseleave", leave], ["focus", focus], ["blur", dismiss], ["click", dismiss]];
    for (const [name, handler] of events) node.addEventListener(name, handler);
    return () => { for (const [name, handler] of events) node.removeEventListener(name, handler); };
  }, [anchor, enter, leave, dismiss]);

  // Under the chip, inside the chat column, and above it when the column ends.
  useLayoutEffect(() => {
    const at = anchor.current;
    if (!at) return;
    if (!visible || !card.current) return void at.removeAttribute("aria-describedby");
    at.setAttribute("aria-describedby", id);
    const box = at.getBoundingClientRect();
    const area = at.closest(".messages")?.getBoundingClientRect();
    const left = (area?.left ?? 0) + 8;
    const right = (area?.right ?? window.innerWidth) - 8;
    const node = card.current;
    node.style.width = `${Math.min(300, right - left)}px`;
    node.style.left = `${Math.max(left, Math.min(box.left, right - node.offsetWidth))}px`;
    const below = box.bottom + 6;
    node.style.top = `${below + node.offsetHeight > window.innerHeight - 8 ? Math.max(8, box.top - 6 - node.offsetHeight) : below}px`;
  }, [visible, anchor, id]);

  if (!visible) return null;
  const { host } = markFor(source.url);
  return createPortal(
    <div ref={card} id={id} role="tooltip" className="web-peek" onMouseEnter={hold} onMouseLeave={leave}>
      <span className="web-peek-site">
        <SiteMark url={source.url} />
        {host}
        <small>Opens in your browser</small>
      </span>
      <strong>{title}</strong>
      {detail ? <span className="web-peek-detail">{detail}</span> : null}
    </div>,
    document.body,
  );
}
