/** Provider and billing method are separate: the Claude API connection has its
 * own credential and transport, never a fallback from a subscription. */
export const AI_CONNECTIONS = {
  "chatgpt-oauth": { provider: "openai", kind: "subscription", name: "ChatGPT" },
  "claude-subscription": { provider: "anthropic", kind: "subscription", name: "Claude" },
  "openai-api": { provider: "openai", kind: "api", name: "OpenAI" },
  "claude-api": { provider: "anthropic", kind: "api", name: "Claude" },
} as const;
export type ConnectionId = keyof typeof AI_CONNECTIONS;
export type SubscriptionId = { [Id in ConnectionId]: typeof AI_CONNECTIONS[Id]["kind"] extends "subscription" ? Id : never }[ConnectionId];
export function isConnectionId(value: unknown): value is ConnectionId {
  return typeof value === "string" && Object.hasOwn(AI_CONNECTIONS, value);
}
export function isSubscription(id: ConnectionId): id is SubscriptionId {
  return AI_CONNECTIONS[id].kind === "subscription";
}
/** The connections a saved provider key serves, and which key each one uses. */
export type ApiConnectionId = Exclude<ConnectionId, SubscriptionId>;
export type KeyProvider = "openai" | "claude";
export const KEY_PROVIDER: Record<ApiConnectionId, KeyProvider> = { "openai-api": "openai", "claude-api": "claude" };
/** Which provider keys the shell holds; never the keys themselves. */
export type SavedKeys = Record<KeyProvider, boolean>;
/** A Claude subscription is served by the reader's own Claude Code; Delphi
 * neither bundles nor updates it. Shared by the shell, setup and Settings. */
export const CLAUDE_CODE = {
  minVersion: "2.1.302",
  install: "curl -fsSL https://claude.ai/install.sh | bash",
  update: "claude update",
  guide: "https://code.claude.com/docs/en/setup",
} as const;
/** Why the installed Claude Code cannot serve: absent, or older than `minVersion`. */
export type ClaudeCodeProblem = "missing" | "outdated";
/** The provider keys Settings lists under "API keys", in order, then what is
 * coming: an OpenAI-compatible base URL is how other inference providers will
 * be reached. Enabling one means a connection in AI_CONNECTIONS (and the
 * shell) and setting `available`. */
export const API_KEYS: ReadonlyArray<{ id: ApiConnectionId | "other-endpoint"; name: string; billing: string; available: boolean }> = [
  { id: "openai-api", name: "OpenAI", billing: "Billed to your OpenAI account", available: true },
  { id: "claude-api", name: "Claude", billing: "Billed to your Anthropic account", available: true },
  { id: "other-endpoint", name: "Other endpoint", billing: "Any OpenAI-compatible base URL", available: false },
];
