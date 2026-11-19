import { useLayoutEffect, useRef } from "react";
import { shortRelativeTime } from "../../lib/dashboard";
import { compactPaperMentionTitle } from "../../lib/paper-mention";
import { accentAt } from "../../lib/project-color";
import type { FiledDocument } from "../../lib/recently-filed";
import { KindMark } from "../KindMark";

/**
 * Under a new Memory chat's composer: the latest documents filed, in up to
 * two rows. Pressing one adds it to the question as an `@` chip, and pressing
 * it again takes it out.
 */
export function RecentlyFiled({
  items,
  added,
  onToggle,
}: {
  items: FiledDocument[];
  added: string[];
  onToggle: (item: FiledDocument) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  // The tags wrap under a two-row height; one wrapped past it is out of sight, so out of reach too.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const fit = () => {
      for (const tag of Array.from(row.children) as HTMLElement[]) {
        tag.inert = tag.offsetTop + tag.offsetHeight > row.clientHeight;
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(row);
    return () => observer.disconnect();
  }, [items, added]);
  if (!items.length) return null;
  return (
    <section className="memory-recent" aria-labelledby="memory-recent-label">
      <p className="conversation-label" id="memory-recent-label">New in your Memory</p>
      <div className="memory-recent-tags" ref={rowRef}>
        {items.map((item) => {
          const on = added.includes(item.slug);
          return (
            <button
              key={item.slug}
              type="button"
              className="memory-recent-tag"
              aria-pressed={on}
              title={item.title}
              // The composer keeps its caret.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onToggle(item)}
            >
              <span style={item.accentIndex === undefined ? undefined : { color: accentAt(item.accentIndex) }}>
                <KindMark kind={item.mark} />
              </span>
              <b>{compactPaperMentionTitle(item.title)}</b>
              <small aria-hidden="true">
                {on ? (
                  <svg viewBox="0 0 12 12"><path d="m2.5 6.2 2.3 2.3 4.7-5" /></svg>
                ) : (
                  <>
                    <time dateTime={item.filedAt}>{shortRelativeTime(item.filedAt)}</time>
                    <i>+</i>
                  </>
                )}
              </small>
            </button>
          );
        })}
      </div>
    </section>
  );
}
