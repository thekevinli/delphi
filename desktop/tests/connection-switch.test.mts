import assert from "node:assert/strict";
import test from "node:test";
import { AiServiceController, type AiService } from "../main/inference/service.ts";
import { desktopConnectionHandler } from "../main/inference/connection-handler.ts";
import { backendEnv, desktopTaskModels } from "../main/backend.ts";
import { validateProfile, type StoredConfig } from "../main/profile.ts";
import { parseSetup } from "../main/browser-policy.ts";
import type { HostActivity } from "../main/worker-host.ts";
const original: StoredConfig = { version: 2, connectionId: "chatgpt-oauth", username: "reader", apiKey: "YWJj", accountPassword: "YWJj", sessionSecret: "YWJj" };
const claude: StoredConfig = { ...original, connectionId: "claude-subscription" };
function rig() {
  const activity: HostActivity = { inflight: new Map(), paused: false };
  const events: string[] = [];
  let saved = original;
  let barrier: Promise<void> | undefined;
  let fail: string | undefined;
  const create = async (config: StoredConfig): Promise<AiService> => {
    events.push(`start:${config.connectionId}`);
    if (barrier) { const wait = barrier; barrier = undefined; await wait; }
    if (fail === config.connectionId) throw new Error("fixture startup failure");
    let close!: () => void;
    const closed = new Promise<void>(r => { close = r; });
    return { backend: { url: "http://127.0.0.1:9", closed, recentErrors: () => "", stop: () => { events.push(`backend.stop:${config.connectionId}`); close(); } },
      bridge: { url: "http://127.0.0.1:8", token: "fixture", active: 0, stop: async () => { events.push(`bridge.stop:${config.connectionId}`); } } };
  };
  const controller = new AiServiceController({ activity, start: create, save: c => { saved = validateProfile(c); events.push(`saved:${c.connectionId}`); }, changed: () => events.push("reload") });
  return { controller, activity, events, saved: () => saved, block: (p: Promise<void>) => { barrier = p; }, fail: (id: string) => { fail = id; } };
}

test("ChatGPT → Claude → ChatGPT retains the profile and stops the backend before its bridge", async () => {
  const r = rig(); await r.controller.start(original, "");
  await r.controller.change(claude, "");
  assert.deepEqual(r.saved(), claude);
  assert.deepEqual(r.events.slice(1), ["backend.stop:chatgpt-oauth", "bridge.stop:chatgpt-oauth", "start:claude-subscription", "saved:claude-subscription", "reload"]);
  await r.controller.change(original, ""); assert.deepEqual(r.saved(), original);
  assert.equal(r.activity.paused, false); await r.controller.stop();
});

test("foreground answers block switching while background filing is stopped and resumed", async () => {
  const r = rig(); await r.controller.start(original, "");
  r.activity.inflight.set(1, { path: "/api/chat/stream", abort: new AbortController() } as any);
  await assert.rejects(r.controller.change(claude, ""), /Delphi is busy/);
  assert.deepEqual(r.saved(), original); assert.equal(r.events.length, 1);
  r.activity.inflight.clear();
  r.activity.inflight.set(2, { path: "/api/memory/maintenance/drain", abort: new AbortController() } as any);
  // A page being read whole goes back to its queue too, and is read after the switch.
  r.activity.inflight.set(3, { path: "/api/captures/drain", abort: new AbortController() } as any);
  await r.controller.change(claude, ""); assert.equal(r.saved().connectionId, "claude-subscription");
  await r.controller.stop();
});

test("a failed start restores the serving connection without persisting the rejected choice", async () => {
  const r = rig(); await r.controller.start(original, ""); r.fail("claude-subscription");
  await assert.rejects(r.controller.change(claude, ""), /stayed on the previous connection/);
  assert.equal(r.activity.paused, false); assert.deepEqual(r.saved(), original);
  assert.ok(r.controller.backend); assert.equal(r.events.includes("saved:claude-subscription"), false);
  assert.equal(r.events.includes("reload"), false, "keep the switch error visible");
  await r.controller.stop();
});

test("simultaneous switches are serialized and quit cannot resurrect a starting provider", async () => {
  const r = rig(); await r.controller.start(original, "");
  let release!: () => void; r.block(new Promise<void>(resolve => { release = resolve; }));
  const changing = r.controller.change(claude, "");
  await assert.rejects(r.controller.change(original, ""), /already in progress/);
  while (!r.events.includes("start:claude-subscription")) await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(r.saved(), original); assert.equal(r.activity.paused, true);
  const stopped = r.controller.stop(); release();
  await assert.rejects(changing, /stopping/); await stopped; await r.controller.stop();
  assert.equal(r.controller.backend, undefined); assert.deepEqual(r.saved(), original);
  assert.equal(r.events.filter(e => e === "backend.stop:claude-subscription").length, 1);
});

test("settings route authenticates switches, names saved keys without them, and never accepts credentials", async () => {
  const changed: string[] = [], managed: string[] = [];
  const handler = desktopConnectionHandler({ origin: "http://localhost:1234", authenticate: async r => r.headers.get("cookie") === "local=yes", read: () => original,
    statuses: async () => ({ chatgpt: { connected: true, signingIn: false }, claude: { connected: false, signingIn: false } }), busy: () => undefined,
    change: async to => { if (to === "claude-subscription") throw Object.assign(new Error("Sign in first"), { setup: true }); changed.push(to); }, manage: to => managed.push(to ?? "default") });
  const request = (body: unknown, headers = { cookie: "local=yes", origin: "http://localhost:1234" }) => handler(new Request("http://localhost:1234/desktop/connection", { method: "POST", headers, body: JSON.stringify(body) }));
  assert.equal((await request({ action: "switch", to: "claude-subscription" }, { cookie: "", origin: "http://localhost:1234" }))?.status, 401);
  assert.equal((await request({ action: "switch", to: "claude-subscription" }, { cookie: "local=yes", origin: "https://evil.example" }))?.status, 405);
  for (const body of [{ action: "switch", to: "other-endpoint" }, { action: "switch", to: "claude-subscription", apiKey: "secret" }, null]) assert.equal((await request(body))?.status, 400);
  const setup = await (await request({ action: "switch", to: "claude-subscription" }))!.json();
  assert.equal(setup.setup, true); assert.deepEqual(managed, ["claude-subscription"]); assert.deepEqual(changed, []);
  await request({ action: "switch", to: "chatgpt-oauth" }); assert.deepEqual(changed, ["chatgpt-oauth"]);
  await request({ action: "switch", to: "claude-api" }); assert.deepEqual(changed, ["chatgpt-oauth", "claude-api"]);
  await request({ action: "manage", to: "claude-api" }); assert.deepEqual(managed, ["claude-subscription", "claude-api"]);
  const read = await (await handler(new Request("http://localhost:1234/desktop/connection", { headers: { cookie: "local=yes" } })))!.text();
  assert.deepEqual(JSON.parse(read).keys, { openai: Boolean(original.apiKey), claude: false });
  assert.doesNotMatch(read, /Cipher/);
  assert.ok(!read.includes(String(original.apiKey)));
});

test("settings reports a saved API key from the plain profile field, and never the key itself", async () => {
  for (const [profile, saved] of [[original, true], [{ ...original, apiKey: undefined }, false], [{ ...original, connectionId: "claude-subscription" as const }, true]] as const) {
    const handler = desktopConnectionHandler({ origin: "http://localhost:1234", authenticate: async () => true, read: () => profile,
      statuses: async () => ({ chatgpt: { connected: true, signingIn: false }, claude: { connected: true, signingIn: false } }), busy: () => undefined,
      change: async () => {}, manage: () => {} });
    const response = await handler(new Request("http://localhost:1234/desktop/connection", { headers: { cookie: "local=yes", origin: "http://localhost:1234" } }));
    const text = await response!.text();
    assert.equal(JSON.parse(text).keys.openai, saved);
    assert.ok(!text.includes(String(original.apiKey)));
  }
});

test("?quick names the connection from the profile at once, without waiting for the plans' statuses", async () => {
  let asked = 0;
  const handler = desktopConnectionHandler({ origin: "http://localhost:1234", authenticate: async () => true, read: () => original,
    statuses: async () => { asked++; return new Promise(() => {}); }, busy: () => undefined, change: async () => {}, manage: () => {} });
  const response = await handler(new Request("http://localhost:1234/desktop/connection?quick", { headers: { origin: "http://localhost:1234" } }));
  assert.deepEqual(await response!.json(), { connection: "chatgpt-oauth", keys: { openai: true, claude: false } });
  assert.equal(asked, 0);
  const refused = desktopConnectionHandler({ origin: "http://localhost:1234", authenticate: async () => false, read: () => original,
    statuses: async () => ({ chatgpt: { connected: true, signingIn: false }, claude: { connected: true, signingIn: false } }), busy: () => undefined, change: async () => {}, manage: () => {} });
  assert.equal((await refused(new Request("http://localhost:1234/desktop/connection?quick")))!.status, 401);
});

test("Claude owns all task models, sends PDFs inline and cannot fall back to an API key", () => {
  const env = backendEnv({ python: "/python", dataDir: "/data", logsDir: "/logs", apiHost: "127.0.0.1", apiPort: 8, uiOrigin: "http://localhost:9", sessionSecret: "s", apiKey: "", connection: "claude-subscription", inference: { url: "http://127.0.0.1:7/v1", token: "local-token" } });
  assert.equal(env.MODEL_CHOICES, "claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5"); assert.equal(env.OPENAI_FILES_ENABLED, "false");
  assert.equal(env.OPENAI_API_KEY, "local-token");
  const tasks = desktopTaskModels("claude-subscription");
  assert.deepEqual(tasks.chat, { model: "claude-opus-5-5", effort: "medium" });
  assert.deepEqual(tasks.title, { model: "claude-sonnet-5-5", effort: "low" });
  assert.deepEqual(tasks.digest, { model: "claude-opus-5-5", effort: "medium" });
  assert.throws(() => validateProfile({ ...original, claudeSignInCompleted: true }), /Unknown profile field/);
  assert.throws(() => validateProfile({ ...original, connectionId: "claude-max" }), /Unsupported AI connection/);
});

test("a Claude API key is served like the plan: Claude's models, through the bridge, the key kept in the shell", () => {
  const options = { python: "/python", dataDir: "/data", logsDir: "/logs", apiHost: "127.0.0.1", apiPort: 8, uiOrigin: "http://localhost:9", sessionSecret: "s", connection: "claude-api" as const };
  const env = backendEnv({ ...options, apiKey: "", inference: { url: "http://127.0.0.1:7/v1", token: "local-token" } });
  assert.equal(env.MODEL_CHOICES, "claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5");
  assert.equal(env.MODEL_DEFAULT, "claude-opus-5-5");
  assert.equal(env.OPENAI_API_KEY, "local-token");
  assert.equal(env.OPENAI_API_BASE_URL, "http://127.0.0.1:7/v1");
  assert.equal(env.OPENAI_FILES_ENABLED, "false");
  assert.deepEqual(desktopTaskModels("claude-api"), desktopTaskModels("claude-subscription"));
  // Never directly, and never with the reader's key beside the bridge's token.
  assert.throws(() => backendEnv({ ...options, apiKey: "sk-ant-secret" }), /local transport/);
  assert.throws(() => backendEnv({ ...options, apiKey: "sk-ant-secret", inference: { url: "http://127.0.0.1:7/v1", token: "t" } }), /cannot also configure an API key/);
  // Its key has a field of its own beside OpenAI's.
  assert.deepEqual(validateProfile({ ...original, connectionId: "claude-api", claudeApiKey: "sk-ant-key" }).claudeApiKey, "sk-ant-key");
});
