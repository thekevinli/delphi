import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialStore, OAuthCredentials } from "./direct-oauth.ts";

interface Decryption {
  isEncryptionAvailable(): boolean;
  decryptString(value: Buffer): string;
}

/**
 * The ChatGPT sign-in, in `oauth.json` readable by this macOS user alone, as
 * Codex keeps its own. Keychain-era builds kept it as `oauth.encrypted` under the Keychain
 * key (see `config.ts`); such a file is decrypted once and replaced.
 */
export function oauthStore(directory: string, keychain: Decryption): CredentialStore {
  const path = join(directory, "oauth.json"), legacy = join(directory, "oauth.encrypted");
  const parse = (text: string) => {
    const value = JSON.parse(text) as OAuthCredentials;
    if (!value.accessToken || !value.refreshToken || !value.accountId || !Number.isFinite(value.expiresAt)) throw new Error();
    return value;
  };
  const store: CredentialStore = {
    read() {
      if (!existsSync(path) && existsSync(legacy)) {
        if (!keychain.isEncryptionAvailable()) throw new Error("Unlock Keychain once to move the ChatGPT connection out of it.");
        let value: OAuthCredentials;
        try { value = parse(keychain.decryptString(readFileSync(legacy))); }
        catch { throw new Error("The ChatGPT connection could not be unlocked. Allow Keychain access once more or sign in again."); }
        store.write(value);
        // Kept for a reinstall of an older Delphi; never read again.
        renameSync(legacy, `${legacy}.keychain-backup`);
      }
      if (!existsSync(path)) return undefined;
      try { return parse(readFileSync(path, "utf8")); }
      catch { throw new Error("The saved ChatGPT connection is unreadable. Sign in again."); }
    },
    write(value) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.pending`;
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    },
    clear() { for (const file of [path, `${path}.pending`, legacy]) rmSync(file, { force: true }); },
  };
  return store;
}
