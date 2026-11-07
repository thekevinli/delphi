import type { Metadata } from "next";

import { MemoryWorkspace } from "../components/MemoryWorkspace";
import { isMemorySlug, MAX_SEEDED_QUESTION } from "../lib/memory";

export const metadata: Metadata = {
  title: "Memory · Delphi",
};

/**
 * The wiki's own address, outside the reader's route group.
 *
 * Nothing in `(reader)` mounts behind this route, so
 * opening Memory does not tear down pdf.js, the chat thread, the
 * panel widths or the zoom — and coming back remounts none of it either.
 *
 * Query params arrive from anyone, so each is checked here before it reaches
 * the client:
 * - `?page=` must be a Memory slug; otherwise the client opens the first
 *   page rather than leaving the pane empty.
 * - `?ask=1` reopens the Spotlight conversation overlay after a reload.
 * - `?q=` seeds one question once (bounded); the client strips it after use.
 * - `?find=` lands in Find mode with that needle — present and empty means
 *   open the bar with nothing typed, which is how the graph route sends a
 *   reader here to search.
 */
export default async function MemoryRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const page = params.page;
  const slug = typeof page === "string" && isMemorySlug(page) ? page : null;
  const askFlag = params.ask;
  const initialAsk =
    askFlag === "1" || askFlag === "true" || typeof params.q === "string";
  const asked = params.q;
  const initialQuestion =
    typeof asked === "string" ? asked.trim().slice(0, MAX_SEEDED_QUESTION) : "";
  // No `?find=` any more: search is account-wide and opens over whatever is
  // mounted (⌘K), so it neither needs an address nor rearranges this page. An
  // old link carrying the parameter lands on the wiki with it ignored.
  return (
    <MemoryWorkspace
      initialSlug={slug}
      initialSection="wiki"
      initialAsk={initialAsk}
      initialQuestion={initialQuestion}
    />
  );
}
