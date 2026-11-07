"use client";

import { createContext, useContext } from "react";

import { memoryPath, type KnownPages, wikiLinkText } from "../lib/memory";

/** Text inside a link the author wrote: a link cannot hold another. */
export const InsideLink = createContext(false);

/**
 * One `[[slug]]`, drawn the same way in a Memory page and in a chat answer: the
 * page's title in a tint of its kind, led by the dot the rail and the map use.
 * A name with no page is not a link at all — it reads as plain text, since
 * there is nothing to open. So does any name where nothing can open a page, or
 * inside a link the author already wrote.
 *
 * An anchor rather than a button, so a title that wraps keeps its tint on both
 * lines. Every click opens the page in place: the app has no tabs, and a
 * window it opens goes to the system browser, which holds no session.
 */
export function MemoryLink({
  link,
  pages,
  onOpen,
}: {
  link: { slug: string; label: string };
  pages: KnownPages;
  onOpen?: (slug: string) => void;
}) {
  const insideLink = useContext(InsideLink);
  const page = pages.get(link.slug);
  const label = wikiLinkText(link, page);
  if (!page || !onOpen || insideLink) return <>{label}</>;
  return (
    <a
      href={memoryPath(link.slug)}
      className={`kb-link kb-link-${page.kind}`}
      onClick={(event) => {
        event.preventDefault();
        onOpen(link.slug);
      }}
      // A middle click asks for a new window, which Electron hands to the system browser, where there is no session.
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onOpen(link.slug);
      }}
    >
      <i className="kb-link-dot" aria-hidden="true" />
      {label}
    </a>
  );
}
