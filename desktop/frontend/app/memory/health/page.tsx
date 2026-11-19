import type { Metadata } from "next";

import { MemoryWorkspace } from "../../components/MemoryWorkspace";

export const metadata: Metadata = {
  title: "Memory Health · Delphi",
};

/** Durable entry to computed findings, model lint and the maintenance log. */
export default function MemoryHealthRoute() {
  return <MemoryWorkspace initialSlug={null} initialSection="health" />;
}
