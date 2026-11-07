/**
 * The full stack the Memory journey drives: the pinned backend on a local
 * profile in a temp directory, the built UI behind the real host with the plan
 * adapter the app mounts in front of chat, and the web rig's scripted provider
 * as the only model. Nothing under /api is mocked.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKEND_APP, backendEnv, PARENT_WATCH } from "../../../main/backend.ts";
import { API_HOST, UI_HOST, freePort } from "../../../main/ports.ts";
import { chatPlansHandler } from "../../../main/research/chat-plans.ts";
import { LocalPlans } from "../../../main/research/plans.ts";
import { PlanStore } from "../../../main/research/store.ts";
import { startWorkerHost } from "../../../main/worker-host.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const PYTHON = process.env.DELPHI_TEST_PYTHON || join(root, ".delphi-build/python/bin/python3");
const DIST = process.env.DELPHI_TEST_DIST || join(root, ".delphi-build/dist");
/** The scripted provider the core's tests share (`core/testkit/delphi_core_testkit/provider.py`). */
const PROVIDER = process.env.DELPHI_E2E_PROVIDER || fileURLToPath(new URL("../../../../core/testkit/delphi_core_testkit/provider.py", import.meta.url));
/** What runs it: FastAPI, uvicorn and jsonschema, which the bundled interpreter does not ship; the core's development environment has them (`bash scripts/core-env.sh`). */
const PROVIDER_PYTHON = process.env.DELPHI_E2E_PYTHON || fileURLToPath(new URL("../../../../.delphi-build/core-env/bin/python3", import.meta.url));
const SERVE = fileURLToPath(new URL("./serve_provider.py", import.meta.url));

/** What the journey needs and does not have, each with how to get it. */
export function missing(): string[] {
  return [
    !existsSync(PYTHON) || !existsSync(join(DIST, "server/index.js")) ? "the bundled backend and UI: run `npm run build`" : "",
    !existsSync(PROVIDER) ? `the web rig's provider at ${PROVIDER}: set DELPHI_E2E_PROVIDER` : "",
    !existsSync(PROVIDER_PYTHON) ? `an interpreter for the provider at ${PROVIDER_PYTHON}: set DELPHI_E2E_PYTHON` : "",
  ].filter(Boolean);
}

/** A child's stderr, kept to its last few thousand characters for a failure report. */
function tail(child: ChildProcess) {
  let text = "";
  child.stderr?.on("data", (chunk: Buffer) => { text = (text + chunk.toString()).slice(-12_000); });
  return () => text;
}

async function ready(url: string, what: string, log: () => string) {
  for (const deadline = Date.now() + 60_000; ;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`${what} never became ready:\n${log().slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

export type Workspace = Awaited<ReturnType<typeof memoryWorkspace>>;

export async function memoryWorkspace(username: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "delphi-memory-journey-"));
  const [providerPort, apiPort, uiPort, plansPort] = [
    await freePort(API_HOST), await freePort(API_HOST), await freePort(UI_HOST), await freePort(API_HOST),
  ];
  const providerOrigin = `http://${API_HOST}:${providerPort}`;
  const apiOrigin = `http://${API_HOST}:${apiPort}`;
  const origin = `http://${UI_HOST}:${uiPort}`;
  const children: ChildProcess[] = [];
  let host: Awaited<ReturnType<typeof startWorkerHost>> | undefined;
  let store: PlanStore | undefined;
  let plans: LocalPlans | undefined;
  let closed: Promise<void> | undefined;
  const close = () => closed ??= (async () => {
    host?.closeAllConnections();
    host?.close();
    plans?.close();
    store?.close();
    await Promise.all(children.map(stop));
    rmSync(dataDir, { recursive: true, force: true });
  })();

  // stdin is each child's parent-death signal: a killed test takes both with it.
  const provider = spawn(PROVIDER_PYTHON, ["-I", SERVE, PROVIDER, String(providerPort)], { stdio: ["pipe", "ignore", "pipe"] });
  children.push(provider);
  const providerLog = tail(provider);
  const env = {
    ...backendEnv({
      python: PYTHON, dataDir, logsDir: dataDir, apiHost: API_HOST, apiPort, uiOrigin: origin,
      sessionSecret: "memory-journey-".padEnd(64, "x"), apiKey: "memory-journey-fixture-only",
      apiBaseUrl: `${providerOrigin}/__fixtures/provider/v1`,
    }),
    // A session's job waits for the window to say the reader left, as it does
    // in the app; the idle limit is never what runs it here.
    MEMORY_SESSION_IDLE_SECONDS: "3600",
    // A domain's page is composed in the drain that gave it its members.
    MEMORY_DOMAIN_SETTLE_SECONDS: "0",
  };
  const backend = spawn(PYTHON, ["-I", "-c", PARENT_WATCH, BACKEND_APP, "--host", API_HOST, "--port", String(apiPort), "--timeout-graceful-shutdown", "2"],
    { env, cwd: dataDir, stdio: ["pipe", "ignore", "pipe"] });
  children.push(backend);
  const backendLog = tail(backend);
  for (const child of children) child.stdin?.on("error", () => {});

  let cookie = "";
  try {
    await ready(`${providerOrigin}/__fixtures/hold`, "The fixture provider", providerLog);
    await ready(`${apiOrigin}/api/health`, "The backend", backendLog);
    store = new PlanStore(join(dataDir, "plans-store"));
    plans = new LocalPlans(store, join(dataDir, "plans"), plansPort);
    const authenticate = async (request: Request) => {
      const response = await fetch(`${apiOrigin}/api/auth/me`, { headers: { cookie: request.headers.get("cookie") ?? "" } });
      await response.body?.cancel();
      return response.ok;
    };
    const chat = chatPlansHandler({ plans, python: PYTHON, backendUrl: apiOrigin, origin, authenticate, installation: async () => "Install Delphi MCP once" });
    host = await startWorkerHost({
      distDir: DIST, backendUrl: apiOrigin, uiHost: UI_HOST, uiPort,
      // The shell's answer for a site with no icon, so no test reaches the web.
      desktopHandler: async (request) => new URL(request.url).pathname === "/desktop/favicon" ? new Response(null, { status: 204 }) : await chat(request),
    });
    const registered = await fetch(`${origin}/api/auth/register`, {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ username, password: "p".repeat(40) }),
    });
    cookie = registered.headers.getSetCookie().find((value) => value.startsWith("delphi_session="))?.split(";")[0] ?? "";
    if (!registered.ok || !cookie) throw new Error(`register failed: ${registered.status} ${await registered.text()}`);
  } catch (error) {
    await close();
    throw error;
  }

  /**
   * A request through the host, as the window makes it, read to its end: JSON
   * parsed, anything else (a drain's event stream) as text. Throws on anything
   * but success.
   */
  async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, origin, ...(body === undefined || body instanceof FormData ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 2000)}`);
    return (response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T;
  }

  /** One of the provider's own routes: what it recorded, refused and holds. */
  async function fixture<T = unknown>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${providerOrigin}/__fixtures${path}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`provider ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }

  return {
    origin, cookie, username, api, fixture, close,
    /** The profile's data directory, for a step that stands in for what happened to it outside the app. */
    dataDir,
    /** A DELETE through the host, as the window sends it. Throws on anything but success. */
    async remove(path: string) {
      const response = await fetch(`${origin}${path}`, { method: "DELETE", headers: { cookie, origin } });
      if (!response.ok) throw new Error(`DELETE ${path}: ${response.status} ${(await response.text()).slice(0, 2000)}`);
    },
    logs: () => `--- backend ---\n${backendLog().slice(-6000)}\n--- provider ---\n${providerLog().slice(-6000)}`,
    /** Import a document as the window does, which queues its filing. */
    async upload(projectId: string, name: string, bytes: Uint8Array<ArrayBuffer>) {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "application/pdf" }), name);
      return api<{ id: string; slug: string; title: string }>(`/api/projects/${projectId}/papers`, form);
    },
    /** Everything the provider refused to play so far: each is a request it could not read as a model would. */
    async refusals(): Promise<string[]> {
      return (await fixture<{ refusals: string[] }>("/provider/requests")).refusals;
    },
  };
}
