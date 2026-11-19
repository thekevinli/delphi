/**
 * The environment the backend child runs under.
 *
 * Every line of `backendEnv` is load-bearing in a way that fails quietly: a
 * wrong DATA_DIR writes a library into site-packages, a wrong sandbox origin
 * dissolves the isolation between proxied pages and the API, and a missing HOME
 * hangs every web capture. None of that surfaces as an error, so it is asserted
 * here instead.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { backendEnv, desktopTaskModels, DESKTOP_TASK_MODELS, KEY_CHECK, MODEL_SETTINGS, SUBSCRIPTION_MODEL_FALLBACK } from "../main/backend.ts";
import { assertHostSplit, API_HOST, UI_HOST } from "../main/ports.ts";

const options = {
  python: "/nope/python3",
  dataDir: "/Users/someone/Library/Application Support/Delphi/data",
  logsDir: "/Users/someone/Library/Application Support/Delphi/logs",
  apiHost: API_HOST,
  apiPort: 51000,
  uiOrigin: `http://${UI_HOST}:52000`,
  sessionSecret: "s".repeat(64),
  apiKey: "sk-test",
};

test("the sandbox origin is a different host from the UI", () => {
  const env = backendEnv(options);
  const sandbox = new URL(env.WEB_SANDBOX_ORIGIN!);
  const ui = new URL(env.FRONTEND_ORIGINS!);

  // The whole isolation argument: cookies ignore port but not host, so a
  // host-only session cookie on the UI's host is never sent to the sandbox's.
  assert.notEqual(sandbox.hostname, ui.hostname);
  // And Delphi refuses to start if the sandbox origin is also a frontend one.
  assert.notEqual(env.WEB_SANDBOX_ORIGIN, env.FRONTEND_ORIGINS);
  assert.throws(() => assertHostSplit(ui.hostname, ui.hostname));
});

test("DATA_DIR is absolute", () => {
  // A relative DATA_DIR is resolved against `Path(__file__).parents[2]`, which
  // in an installed layout is inside site-packages — so the library would land
  // in the app bundle and vanish on update.
  assert.ok(backendEnv(options).DATA_DIR!.startsWith("/"));
});

test("the session secret is passed, because tokens depend on it", () => {
  // Not only the cookie: the page, navigation and staged-upload tokens are
  // signed with it too.
  assert.equal(backendEnv(options).SESSION_SECRET, options.sessionSecret);
});

test("Flex is what the Advanced tier toggle selects; Standard stays the default", () => {
  // The backend sends "default" while the account prefers Standard, which it
  // does until the reader changes it, and this value otherwise.
  assert.equal(backendEnv(options).OPENAI_SERVICE_TIER, "flex");
});

test("a ChatGPT connection runs the plan's models, sends PDFs inline, and never holds a key", () => {
  const env = backendEnv({ ...options, apiKey: "", inference: { url: "http://127.0.0.1:9/v1", token: "bridge-token" } });
  assert.equal(env.OPENAI_FILES_ENABLED, "false");
  assert.equal(env.OPENAI_API_KEY, "bridge-token");
  assert.equal(env.MODEL_CHOICES, "gpt-6-luna,gpt-6.1-sol");
  for (const [setting, value] of Object.entries(MODEL_SETTINGS)) {
    assert.equal(env[setting], SUBSCRIPTION_MODEL_FALLBACK[value] ?? (setting === "MODEL_CHOICES" ? env[setting] : value), setting);
  }
  // Efforts are unchanged: a fallback stands in for its model at the same rung.
  const api = Object.values(DESKTOP_TASK_MODELS);
  const plan = Object.values(desktopTaskModels("chatgpt-oauth"));
  assert.deepEqual(plan.map(task => task.effort), api.map(task => task.effort));
  assert.deepEqual(plan.map(task => task.model), api.map(task => SUBSCRIPTION_MODEL_FALLBACK[task.model] ?? task.model));
  assert.equal(backendEnv(options).OPENAI_FILES_ENABLED, undefined);
});

test("Claude uses Opus for Sol tasks and Sonnet for Luna tasks at the same efforts", () => {
  const env = backendEnv({ ...options, apiKey: "", connection: "claude-subscription", inference: { url: "http://127.0.0.1:9/v1", token: "bridge-token" } });
  assert.deepEqual(Object.fromEntries(Object.keys(MODEL_SETTINGS)
    .filter(key => key.endsWith("_MODEL") || key === "MODEL_DEFAULT")
    .map(key => [key, env[key]])), {
    MODEL_DEFAULT: "claude-opus-5-5",
    CONVERSATION_TITLE_MODEL: "claude-sonnet-5-5",
    MEMORY_SELECT_MODEL: "claude-sonnet-5-5",
    DIGEST_MODEL: "claude-opus-5-5",
    RESEARCH_MODEL: "claude-opus-5-5",
    MEMORY_SAME_DOCUMENT_MODEL: "claude-sonnet-5-5",
    MEMORY_FILE_SELECT_MODEL: "claude-sonnet-5-5",
    MEMORY_MAINTAIN_MODEL: "claude-opus-5-5",
    MEMORY_VERIFY_MODEL: "claude-opus-5-5",
    MEMORY_DOMAIN_MODEL: "claude-opus-5-5",
    MEMORY_REVIEW_MODEL: "claude-opus-5-5",
  });
  for (const [setting, value] of Object.entries(MODEL_SETTINGS)) {
    if (setting.includes("REASONING_EFFORT")) assert.equal(env[setting], value, setting);
  }
});

test("the desktop owns every model and effort instead of inheriting the wheel's", () => {
  const env = backendEnv(options);
  for (const [setting, value] of Object.entries(MODEL_SETTINGS)) assert.equal(env[setting], value, setting);
  assert.equal(env.MODEL_CHOICES, "gpt-6-luna,gpt-6.1-sol");
  assert.equal(env.MODEL_DEFAULT, "gpt-6.1-sol");
  assert.equal(env.REASONING_EFFORT_DEFAULT, "medium");
  // Every task is pinned, so the wheel's orchestrator fallback never applies.
  assert.equal(env.ORCHESTRATOR_MODEL, undefined);
  const models = Object.entries(MODEL_SETTINGS).filter(([setting]) => setting.endsWith("_MODEL")).map(([, value]) => value);
  assert.deepEqual([...new Set([...models, KEY_CHECK.model])].sort(), ["gpt-6-luna", "gpt-6.1-sol"]);
});

test("a ChatGPT plan is checked against every model setting the backend reads", () => {
  // The connection gate reads only the task table; a setting it omits would let
  // a plan pass setup and then fail that task mid-run.
  const settings = Object.entries(MODEL_SETTINGS);
  const modelSettings = settings.filter(([setting]) => setting.endsWith("_MODEL") || setting === "MODEL_DEFAULT").map(([, value]) => value);
  const efforts = settings.filter(([setting]) => setting.endsWith("REASONING_EFFORT") || setting === "REASONING_EFFORT_DEFAULT").map(([, value]) => value);
  const tasks = Object.values(DESKTOP_TASK_MODELS);
  assert.deepEqual([...new Set(tasks.map(task => task.model))].sort(), [...new Set(modelSettings)].sort());
  assert.deepEqual([...new Set(tasks.map(task => task.effort))].sort(), [...new Set(efforts)].sort());
});

test("cross-account features are off", () => {
  // There is one account and no way to reach another, so the marketplace is not
  // merely unused — it must be unreachable.
  assert.equal(backendEnv(options).PERSONA_MARKETPLACE_ENABLED, "false");
});

test("HOME is the real one", () => {
  /*
   * Page capture records that pointing Chrome at a fresh HOME makes
   * Chrome-for-Mac treat the run as a new profile and start the Google Updater,
   * which hung every capture past its ceiling. This is also why the app cannot
   * be sandboxed.
   */
  assert.equal(backendEnv(options).HOME, process.env.HOME);
});

test("the backend borrows Electron's browser and is never pointed at an installed one", () => {
  const browserHost = { socket: "/private/tmp/delphi-browser-x/host.sock", token: "per-launch" };
  const env = backendEnv({ ...options, browserHost });
  assert.equal(env.BROWSER_HOST_SOCKET, browserHost.socket);
  assert.equal(env.BROWSER_HOST_TOKEN, browserHost.token);
  // No path to a Chrome of the user's: with a host set the backend never looks.
  assert.equal(env.CHROME_PATH, undefined);
  assert.equal(backendEnv(options).BROWSER_HOST_SOCKET, undefined);
});

test("artifact authoring needs both the browser host and the shipped validation host", () => {
  const artifactRendererPath = "/Applications/Delphi.app/Contents/Resources/artifact-validator";
  const browserHost = { socket: "/private/tmp/delphi-browser-x/host.sock", token: "per-launch" };
  assert.equal(backendEnv(options).ARTIFACT_RENDERER_PATH, undefined);
  assert.equal(backendEnv({ ...options, artifactRendererPath }).ARTIFACT_RENDERER_PATH, undefined);
  assert.equal(backendEnv({ ...options, browserHost }).ARTIFACT_RENDERER_PATH, undefined);
  assert.equal(backendEnv({ ...options, browserHost, artifactRendererPath }).ARTIFACT_RENDERER_PATH, artifactRendererPath);
});
