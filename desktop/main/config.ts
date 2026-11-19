/** Profile paths and the profile's secrets. */
import { app, safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { constants, copyFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { oauthStore } from "./inference/oauth-store.ts";
import { moveSecretsOut, readProfile, writeProfile, type StoredConfig } from "./profile.ts";
export type { StoredConfig } from "./profile.ts";
import { join } from "node:path";

export function appDir(): string {
  // `userData` is ~/Library/Application Support/<name>.
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const dataDir = (): string => ensure(join(appDir(), "data"));
export const logsDir = (): string => ensure(join(appDir(), "logs"));
export const faviconsDir = (): string => join(appDir(), "favicons");

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

const configPath = (): string => join(appDir(), "config.json");

export function readConfig(): StoredConfig {
  let config = readProfile(configPath());
  if (config && (config.apiKeyCipher || config.sessionSecretCipher || config.accountPasswordCipher)) config = moveOutOfKeychain(config);
  const data = join(appDir(), "data");
  if (existsSync(data) && readdirSync(data).length && (!config?.username || !config.sessionSecret || !config.accountPassword)) {
    throw new Error("Profile identity is incomplete but existing data was found. Restore the matching config.json backup; existing data has been preserved.");
  }
  return config ?? {};
}

export function writeConfig(next: StoredConfig): void {
  writeProfile(configPath(), next);
}

/**
 * See `moveSecretsOut`: the last Keychain read a Keychain-era profile needs.
 * The original is kept as `config.json.keychain-backup` for a reinstall of an
 * older Delphi, and the ChatGPT sign-in moves in the same launch, while the
 * Keychain key is still cached in this process, so it never asks again later.
 */
function moveOutOfKeychain(config: StoredConfig): StoredConfig {
  const next = moveSecretsOut(config, safeStorage);
  try { copyFileSync(configPath(), `${configPath()}.keychain-backup`, constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  writeConfig(next);
  try { oauthStore(join(appDir(), "inference"), safeStorage).read(); }
  catch (error) { console.error("The ChatGPT sign-in could not be moved out of the Keychain:", error); }
  return next;
}

/**
 * The HMAC secret, minted once per profile.
 *
 * It cannot be dropped just because there is no sign-in: the application signs
 * the page, navigation and staged-upload tokens with it too, and those are
 * what keep the sandboxed web frame scoped to one document.
 */
export function sessionSecret(config: StoredConfig): { secret: string; config: StoredConfig } {
  if (config.sessionSecret) return { secret: config.sessionSecret, config };
  const secret = randomBytes(32).toString("hex");
  const next = { ...config, sessionSecret: secret };
  writeConfig(next);
  return { secret, config: next };
}

/** The local account's password. Generated once; the user never sees or types it. */
export function accountPassword(config: StoredConfig): { password: string; config: StoredConfig } {
  if (config.accountPassword) return { password: config.accountPassword, config };
  const password = randomBytes(32).toString("hex");
  const next = { ...config, accountPassword: password };
  writeConfig(next);
  return { password, config: next };
}

/**
 * The single account's name.
 *
 * It is a real Delphi username: it appears in every reader URL (`/@name/...`)
 * and greets the reader on the Dashboard, so "local" showed up as
 * "Good morning, LOCAL" — a sentinel where a name belongs. Naming it after the
 * macOS account costs nothing and reads like the machine's own app.
 *
 * Stored on first use and never re-derived, because it is baked into the data
 * directory layout (`data/users/<name>/`): changing it later would strand a
 * library rather than rename it.
 *
 * Account names use ASCII letters, digits, underscores and hyphens.
 */
export function localUsername(config: StoredConfig): { username: string; config: StoredConfig } {
  if (config.username) return { username: config.username, config };

  const raw = (() => {
    try { return userInfo().username; } catch { return ""; }
  })();
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  const username = cleaned.length >= 3 ? cleaned : "reader";

  const next = { ...config, username };
  writeConfig(next);
  return { username, config: next };
}
