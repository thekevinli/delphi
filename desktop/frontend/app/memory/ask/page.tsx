import type { Metadata } from "next";

import { MemoryWorkspace } from "../../components/MemoryWorkspace";
import { isMemorySlug, MAX_SEEDED_QUESTION } from "../../lib/memory";

export const metadata: Metadata = {
  title: "Ask your Memory · Delphi",
};

/**
 * Legacy address for the wiki conversation.
 *
 * Ask is a Spotlight overlay on the wiki, not a separate product. This route
 * still resolves so old links keep working: it mounts the same wiki shell with
 * the overlay already open. The client then rewrites the address to
 * `/memory?ask=1` (and drops `?q=` once the seed is spent), so a reload
 * lands on the canonical wiki URL rather than here.
 */
export default async function MemoryAskRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const page = params.page;
  const slug = typeof page === "string" && isMemorySlug(page) ? page : null;
  const raw = params.q;
  const initialQuestion =
    typeof raw === "string"
      ? raw.trim().slice(0, MAX_SEEDED_QUESTION)
      : Array.isArray(raw)
        ? (raw[0] ?? "").trim().slice(0, MAX_SEEDED_QUESTION)
        : "";
  return (
    <MemoryWorkspace
      initialSlug={slug}
      initialAsk
      initialQuestion={initialQuestion}
    />
  );
}
