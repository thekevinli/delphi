import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { moveSecretsOut, readProfile, writeProfile, validateProfile } from "../main/profile.ts";

test("missing, malformed and unsupported profiles remain distinct", () => {
  const dir = mkdtempSync(join(tmpdir(), "delphi-profile-"));
  const path = join(dir, "config.json");
  try {
    assert.equal(readProfile(path), undefined);
    for (const source of ['{', 'null', '[]', '{"version":2}', '{"username":"../escape"}', '{"apiKeyCipher":"bad!"}']) {
      writeFileSync(path, source);
      assert.throws(() => readProfile(path), /preserved/);
      assert.equal(readFileSync(path, "utf8"), source);
    }
    assert.throws(() => readProfile(dir), /could not be read/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy identity is preserved and versioned atomically with private permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "delphi-profile-"));
  const path = join(dir, "config.json");
  try {
    writeFileSync(path, JSON.stringify({ username: "reader", accountPasswordCipher: "YWJj" }));
    const config = readProfile(path)!;
    assert.equal(config.username, "reader");
    writeProfile(path, { ...config, apiKeyCipher: "ZGVm" });
    assert.equal(readProfile(path)?.accountPasswordCipher, "YWJj");
    assert.equal(readProfile(path)?.version, 1);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const before = readFileSync(path, "utf8");
    assert.throws(() => writeProfile(path, { username: "../bad" }));
    assert.equal(readFileSync(path, "utf8"), before);
    assert.deepEqual(readdirSync(dir), ["config.json"]);
    assert.throws(() => validateProfile({ apiKeyCipher: 4 }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("secrets are stored plainly in the private profile and never as an empty value", () => {
  const dir = mkdtempSync(join(tmpdir(), "delphi-profile-"));
  const path = join(dir, "config.json");
  try {
    writeProfile(path, { version: 2, connectionId: "openai-api", username: "reader", apiKey: "sk-test", sessionSecret: "s".repeat(64), accountPassword: "p".repeat(64) });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readProfile(path)?.apiKey, "sk-test");
    assert.throws(() => validateProfile({ apiKey: "" }));
    assert.throws(() => validateProfile({ sessionSecret: 4 }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a Keychain-era profile is decrypted once into plain fields; a refusal changes nothing", () => {
  const b64 = (text: string) => Buffer.from(`enc:${text}`).toString("base64");
  const session = "a".repeat(64), password = "b".repeat(64);
  let calls = 0, available = true, broken = false;
  const keychain = { isEncryptionAvailable: () => available, decryptString: (value: Buffer) => {
    calls++; if (broken) throw new Error("denied"); return value.toString().replace(/^enc:/, ""); } };
  const legacy = { version: 2 as const, connectionId: "openai-api" as const, username: "reader", apiKeyCipher: b64("sk-key"), sessionSecretCipher: b64(session), accountPasswordCipher: b64(password) };
  const moved = moveSecretsOut(legacy, keychain);
  assert.deepEqual(moved, { version: 2, connectionId: "openai-api", username: "reader", apiKey: "sk-key", sessionSecret: session, accountPassword: password });
  assert.equal(calls, 3);
  // A subscription profile (ChatGPT or Claude) has no key; nothing is invented for it.
  const { apiKeyCipher: _, ...subscription } = { ...legacy, connectionId: "claude-subscription" as const };
  assert.equal(moveSecretsOut(subscription, keychain).apiKey, undefined);
  // An already-moved profile never touches the Keychain.
  assert.deepEqual(moveSecretsOut(moved, { isEncryptionAvailable: () => { throw new Error("no Keychain read"); }, decryptString: () => "" }), moved);
  // A plain value present wins; its stale ciphertext is dropped unread.
  calls = 0;
  assert.equal(moveSecretsOut({ ...legacy, apiKey: "sk-plain" }, keychain).apiKey, "sk-plain");
  assert.equal(calls, 2);
  // A decrypt that is not the 64-hex secret Delphi minted is refused, not saved.
  assert.throws(() => moveSecretsOut({ ...legacy, sessionSecretCipher: b64("garbage") }, keychain), /could not be decrypted/);
  available = false; assert.throws(() => moveSecretsOut(legacy, keychain), /keychain is unavailable/);
  available = true; broken = true; assert.throws(() => moveSecretsOut(legacy, keychain), /could not be decrypted/);
  assert.equal(legacy.apiKeyCipher, b64("sk-key"), "the input profile is never modified");
});
