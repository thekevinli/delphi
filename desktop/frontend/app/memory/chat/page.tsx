import type { Metadata } from "next";

import { MemoryWorkspace } from "../../components/MemoryWorkspace";

export const metadata: Metadata = {
  title: "Memory Chat · Delphi",
};

/**
 * Memory's own conversation, asked of the whole account. It opens on a new
 * chat; `?conversation=` opens that one, which the chat list keeps in the
 * address as chats are chosen.
 */
export default function MemoryChatRoute() {
  return <MemoryWorkspace initialSlug={null} initialSection="chat" />;
}
