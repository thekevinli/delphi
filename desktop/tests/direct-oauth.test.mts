import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHATGPT_OAUTH, DirectOAuth, credentialsFromResponse, pkce, type OAuthCredentials } from "../main/inference/direct-oauth.ts";
import { oauthStore } from "../main/inference/oauth-store.ts";
import { parseCatalog } from "../main/inference/direct-provider.ts";
import { SubscriptionConnection, missingModels, modelRequirements } from "../main/inference/connection.ts";

const token = (account = "account-1", exp = Math.floor(Date.now() / 1000) + 3600) => `header.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
const initial = (): OAuthCredentials => ({ accessToken: token(), refreshToken: "refresh-secret", accountId: "account-1", expiresAt: Date.now() + 3600_000 });
function memory() {
  let value: OAuthCredentials | undefined = initial();
  return { read: () => value, write: (next: OAuthCredentials) => { value = next; }, clear: () => { value = undefined; } };
}

test("PKCE uses fresh S256 verifiers and unpredictable callback state", () => {
  const a = pkce(), b = pkce();
  assert.equal(a.verifier.length, 43);
  assert.equal(a.challenge, createHash("sha256").update(a.verifier).digest("base64url"));
  assert.notEqual(a.verifier, b.verifier); assert.notEqual(a.state, b.state);
});

test("credentials require refresh and account identity; rotation cannot switch accounts", () => {
  assert.throws(() => credentialsFromResponse({ access_token: token() }), /incomplete/);
  assert.throws(() => credentialsFromResponse({ access_token: token("other") }, initial()), /account changed/);
  assert.equal(credentialsFromResponse({ access_token: token() }, initial()).refreshToken, "refresh-secret");
});

test("the sign-in is a private file; a Keychain-era file is moved out once and never read again", () => {
  const dir = mkdtempSync(join(tmpdir(), "delphi-oauth-"));
  try {
    let decrypts = 0, available = false;
    const keychain = { isEncryptionAvailable: () => available, decryptString: (_: Buffer) => { decrypts++; return JSON.stringify(initial()); } };
    const store = oauthStore(dir, keychain);
    store.write(initial());
    assert.equal(statSync(join(dir, "oauth.json")).mode & 0o777, 0o600);
    assert.equal(store.read()?.accountId, "account-1");
    assert.equal(decrypts, 0);
    store.clear(); assert.equal(store.read(), undefined);

    writeFileSync(join(dir, "oauth.encrypted"), "opaque-encrypted-fixture");
    assert.throws(() => store.read(), /Keychain/);
    assert.ok(existsSync(join(dir, "oauth.encrypted")), "a locked Keychain preserves the old sign-in");
    available = true;
    assert.equal(store.read()?.accountId, "account-1");
    assert.equal(decrypts, 1);
    assert.ok(!existsSync(join(dir, "oauth.encrypted")));
    assert.ok(existsSync(join(dir, "oauth.encrypted.keychain-backup")), "kept for a reinstall of an older Delphi");
    assert.equal(statSync(join(dir, "oauth.json")).mode & 0o777, 0o600);
    available = false; assert.equal(store.read()?.accountId, "account-1");
    assert.equal(decrypts, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent refresh is single-flight and logout prevents an in-flight refresh from restoring credentials", async () => {
  const original = globalThis.fetch;
  const store = memory(); const oauth = new DirectOAuth(store);
  let release!: (r: Response) => void;
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(url, CHATGPT_OAUTH.token);
    assert.deepEqual(JSON.parse(String(init?.body)), { grant_type: "refresh_token", client_id: CHATGPT_OAUTH.clientId, refresh_token: "refresh-secret" });
    return new Promise<Response>(resolve => { release = resolve; });
  }) as typeof fetch;
  try {
    const first = oauth.credentials(true), second = oauth.credentials(true);
    oauth.logout();
    release(Response.json({ access_token: token(), refresh_token: "rotated" }));
    await assert.rejects(first, /sign-in changed/); await assert.rejects(second, /sign-in changed/);
    assert.equal(calls, 1); assert.equal(store.read(), undefined);
  } finally { globalThis.fetch = original; }
});

test("direct requests use only OAuth at the Codex endpoint and refresh once on 401", async () => {
  const original = globalThis.fetch;
  const oauth = new DirectOAuth(memory());
  const calls: string[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push(String(url));
    if (url === CHATGPT_OAUTH.token) return Response.json({ access_token: token(), refresh_token: "rotated" });
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("chatgpt-account-id"), "account-1");
    assert.match(headers.get("authorization")!, /^Bearer header\./);
    return calls.length === 1 ? new Response("expired", { status: 401 }) : new Response("stream");
  }) as typeof fetch;
  try {
    assert.equal(await (await oauth.responses({ model: "test", stream: true })).text(), "stream");
    assert.deepEqual(calls, [CHATGPT_OAUTH.responses, CHATGPT_OAUTH.token, CHATGPT_OAUTH.responses]);
  } finally { globalThis.fetch = original; }
});

test("catalog requests expose current desktop models instead of rejecting an account through an older client catalog", async () => {
  const original = globalThis.fetch;
  const legacy = { models: [{ slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "medium" }] }] };
  const current = { models: ["gpt-6.1-sol", "gpt-6-luna"].map(slug => ({ slug,
    supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map(effort => ({ effort })) })) };
  const { required, composer } = modelRequirements();
  assert.ok(missingModels(parseCatalog(legacy), required).length > 0);
  globalThis.fetch = (async (url, init) => {
    const endpoint = new URL(String(url));
    assert.equal(endpoint.pathname, "/backend-api/codex/models");
    assert.equal(init?.method, "GET");
    const version = (endpoint.searchParams.get("client_version") ?? "0.0.0").split(".").map(Number);
    // Measured: 0.159.3 exposes the pair; 0.153.4 hides it. Keep the
    // request at a catalog version that exposes the whole desktop selection.
    const modern = version[0] > 0 || version[1] > 159 || (version[1] === 159 && version[2] >= 3);
    return Response.json(modern ? current : legacy);
  }) as typeof fetch;
  try {
    const catalog = parseCatalog(await (await new DirectOAuth(memory()).models()).json());
    assert.deepEqual(missingModels(catalog, required), []);
    assert.deepEqual(missingModels(catalog, composer), []);
  } finally { globalThis.fetch = original; }
});

test("OAuth callback rejects wrong state and exchanges the code with PKCE, without requesting an API key", async () => {
  const original = globalThis.fetch;
  const store = memory(); store.clear(); const oauth = new DirectOAuth(store);
  let authorize!: URL;
  globalThis.fetch = (async (url, init) => {
    if (url !== CHATGPT_OAUTH.token) return original(url, init);
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "fixture-code");
    assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), authorize.searchParams.get("code_challenge"));
    assert.equal(form.has("requested_token_type"), false);
    return Response.json({ access_token: token(), refresh_token: "refresh" });
  }) as typeof fetch;
  const login = await oauth.startLogin(async url => { authorize = new URL(url); });
  try {
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ code: "fixture-code", state: "wrong" }).toString();
    assert.equal((await original(callback)).status, 400);
    assert.equal(store.read(), undefined);
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    assert.equal((await original(callback)).status, 200);
    await login.completion;
    assert.equal(store.read()?.accountId, "account-1");
  } finally { login.cancel(); globalThis.fetch = original; }
});

// ChatGPT sign-in is offered on macOS only, so its status says nothing else elsewhere.
test("a ChatGPT sign-in cancelled from Delphi is not reported as a failure", { skip: process.platform !== "darwin" }, async () => {
  const connection = new SubscriptionConnection({ read: () => undefined, write: () => {}, clear: () => {} }, async () => {});
  await connection.login();
  try { assert.equal((await connection.status()).signingIn, true); }
  finally { await connection.cancel(); }
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await connection.status(), { connected: false, signingIn: false, message: undefined });
});
