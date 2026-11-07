import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { isConnectionId, type ConnectionId } from "../frontend/app/lib/ai-connection.ts";

export interface StoredConfig {
  version?: 1 | 2;
  connectionId?: ConnectionId;
  apiBaseUrl?: string;
  /** The OpenAI key, and an Anthropic one beside it: saving one never replaces the other. */
  apiKey?: string;
  claudeApiKey?: string;
  sessionSecret?: string;
  accountPassword?: string;
  /** Keychain-encrypted copies a Keychain-era build wrote, read once by `readConfig` to move them out. */
  apiKeyCipher?: string;
  sessionSecretCipher?: string;
  accountPasswordCipher?: string;
  /** Retired: an installed browser's path, from before the built-in browser host. Read, never used. */
  chromePath?: string;
  delphiRevision?: string;
  username?: string;
}

/** Accept the unversioned original format, but never reinterpret corruption as setup. */
export function validateProfile(value: unknown): StoredConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid profile configuration");
  const record = value as Record<string, unknown>;
  const fields = new Set(["version", "connectionId", "apiBaseUrl", "apiKey", "claudeApiKey", "sessionSecret", "accountPassword", "apiKeyCipher", "sessionSecretCipher", "accountPasswordCipher", "chromePath", "delphiRevision", "username"]);
  for (const [key, item] of Object.entries(record)) {
    if (!fields.has(key)) throw new Error(`Unknown profile field: ${key}`);
    if (key === "version") {
      if (item !== 1 && item !== 2) throw new Error("Unsupported profile version; use a compatible Delphi release");
    } else if (typeof item !== "string" || !item.length) throw new Error(`Invalid profile field: ${key}`);
    if (key.endsWith("Cipher") && (typeof item !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item))) {
      throw new Error(`Invalid encrypted profile field: ${key}`);
    }
  }
  if (record.version === 2 && record.connectionId === undefined) throw new Error("AI connection is missing");
  if (record.connectionId !== undefined && !isConnectionId(record.connectionId)) throw new Error("Unsupported AI connection");
  if (record.username !== undefined && !/^[A-Za-z0-9_-]{3,40}$/.test(String(record.username))) throw new Error("Invalid profile account name");
  if (record.apiBaseUrl !== undefined) {
    const url = new URL(String(record.apiBaseUrl));
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid provider URL");
  }
  // Keep old profiles byte-compatible until a connection is explicitly changed.
  return { ...record, version: record.version ?? 1 } as StoredConfig;
}

/**
 * Secrets live in config.json, which only this macOS user can read (0600), like
 * the library beside it. Keychain-era builds encrypted them with a Keychain key,
 * which an ad hoc signed app is asked to unlock again after every update while
 * protecting nothing the user's own files did not already hold. Such a profile
 * is decrypted once and returned without its ciphertexts; any failure throws
 * and leaves the file as it was. A plain value already present wins.
 */
export function moveSecretsOut(config: StoredConfig, keychain: { isEncryptionAvailable(): boolean; decryptString(value: Buffer): string }): StoredConfig {
  const { apiKeyCipher, sessionSecretCipher, accountPasswordCipher, ...next } = config;
  for (const [field, cipher] of [["apiKey", apiKeyCipher], ["sessionSecret", sessionSecretCipher], ["accountPassword", accountPasswordCipher]] as const) {
    if (!cipher || next[field]) continue;
    if (!keychain.isEncryptionAvailable()) throw new Error("The system keychain is unavailable. Unlock it and retry; your profile has been preserved.");
    let value = "";
    try { value = keychain.decryptString(Buffer.from(cipher, "base64")); } catch { /* reported below */ }
    // Delphi minted both of these as 32 random bytes in hex; anything else is a bad decrypt.
    if (!value || (field !== "apiKey" && !/^[0-9a-f]{64}$/.test(value))) throw new Error("A stored secret could not be decrypted. Allow Keychain access once more or restore the matching profile backup; your profile has been preserved.");
    next[field] = value;
  }
  return next;
}

export function readProfile(path: string): StoredConfig | undefined {
  let source: string;
  try { source = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Profile configuration could not be read; it has been preserved", { cause: error });
  }
  try { return validateProfile(JSON.parse(source)); }
  catch (error) { throw new Error("Profile configuration is invalid or incompatible; it has been preserved", { cause: error }); }
}

/** Same-directory rename prevents a crash from leaving half a credential record. */
export function writeProfile(path: string, config: StoredConfig): void {
  const text = JSON.stringify(validateProfile(JSON.parse(JSON.stringify(config))), null, 2) + "\n";
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
