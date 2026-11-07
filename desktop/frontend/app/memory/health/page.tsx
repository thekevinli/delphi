import type { Metadata } from "next";

import { MemoryWorkspace } from "../../components/MemoryWorkspace";

export const metadata: Metadata = {
  title: "Memory Health · Delphi",
};

/**
 * Durable entry to computed findings, model lint and the maintenance log.
 * `?ask=1` keeps the Memory conversation docked beside it.
 */
export default async function MemoryHealthRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ask } = await searchParams;
  return <MemoryWorkspace initialSlug={null} initialSection="health" initialAsk={ask === "1"} />;
}
