import type { Metadata } from "next";

import { MemoryWorkspace } from "../../components/MemoryWorkspace";
import { isMemorySlug } from "../../lib/memory";

export const metadata: Metadata = {
  title: "Memory Map · Delphi",
};

/**
 * Durable entry to the account-wide map. `?domain=` opens it zoomed onto one
 * domain — the way back from one of that domain's pages lands where the
 * reader left. `?ask=1` opens it with the Memory conversation docked beside
 * it, which is where a Memory chat is reopened. Checked here, since query
 * params arrive from anyone.
 */
export default async function MemoryGraphRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { domain, ask } = await searchParams;
  const initialDomain = typeof domain === "string" && isMemorySlug(domain) ? domain : null;
  return (
    <MemoryWorkspace
      initialSlug={null}
      initialSection="graph"
      initialDomain={initialDomain}
      initialAsk={ask === "1"}
    />
  );
}
