export const ChatMode = { Chat: "chat", Plan: "plan" } as const;
export type ChatMode = typeof ChatMode[keyof typeof ChatMode];
const modes: readonly ChatMode[] = [ChatMode.Chat, ChatMode.Plan];
export function nextChatMode(mode: ChatMode): ChatMode {
  return modes[(modes.indexOf(mode) + 1) % modes.length]!;
}
export function isModeShortcut(event: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
  return event.key === "Tab" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}
