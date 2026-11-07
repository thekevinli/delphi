import type { KeyProvider } from "../frontend/app/lib/ai-connection.ts";
/** Navigation must compare parsed origins, including the port. */
export function sameOrigin(candidate: string, expected: string): boolean {
  try { return new URL(candidate).origin === new URL(expected).origin; }
  catch { return false; }
}

/**
 * A provider key from the setup window. Each provider has its own key, so the
 * request names whose it is. An OpenAI-compatible base URL is not offered yet:
 * other providers will be reached that way, and a URL saved by an earlier
 * build keeps working until its key is replaced.
 */
export function parseSetup(value: unknown): { provider: KeyProvider; apiKey: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid setup request");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !["provider", "apiKey"].includes(key))) throw new Error("Unknown setup field");
  if (record.provider !== "openai" && record.provider !== "claude") throw new Error("Choose a provider for this key");
  if (typeof record.apiKey !== "string" || !record.apiKey.trim() || record.apiKey.length > 16_384) throw new Error("Enter a valid API key");
  const apiKey = record.apiKey.trim();
  // A key pasted under the wrong provider is refused here, not by a provider
  // that would bill nothing and answer with an opaque 401.
  if (record.provider === "openai" && apiKey.startsWith("sk-ant-")) throw new Error("That is a Claude API key. Choose Claude in the provider menu.");
  if (record.provider === "claude" && !apiKey.startsWith("sk-ant-")) throw new Error("A Claude API key starts with sk-ant-.");
  return { provider: record.provider, apiKey };
}
