/**
 * The whole stack, without Electron: the bundled interpreter serving Delphi,
 * the Worker host in front of it, and a session established over the proxy.
 *
 * This is the test that would have caught every startup failure found while
 * building the app — the missing `h2` package, a wrong DATA_DIR, a packaged
 * data file that did not ship — each of which presented as a blank window
 * rather than an error.
 *
 * Skips itself unless both halves are built, so a checkout without a build is
 * not a red suite.
 */
import assert from "node:assert/strict";
import { samplePdf } from "./fixtures/pdf.mts";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { startWorkerHost } from "../main/worker-host.ts";
import { BACKEND_APP, backendEnv, MODEL_SETTINGS } from "../main/backend.ts";
import { freePort, API_HOST, UI_HOST } from "../main/ports.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PYTHON = process.env.DELPHI_TEST_PYTHON || join(ROOT, ".delphi-build", "python", "bin", "python3");
const DIST = process.env.DELPHI_TEST_DIST || join(ROOT, ".delphi-build", "dist");
const ready = existsSync(PYTHON) && existsSync(join(DIST, "server", "index.js"));
if (!ready && process.env.DELPHI_REQUIRE_INTEGRATION === "1") {
  throw new Error("Missing installed backend or frontend build; run npm run build, or set DELPHI_TEST_PYTHON and DELPHI_TEST_DIST.");
}
const needsBuild = { skip: ready ? false : "run `npm run build` first" };

let dataDir = "";
let backend: ChildProcess | undefined;
let host: Awaited<ReturnType<typeof startWorkerHost>> | undefined;
let origin = "";
let apiOrigin = "";
let cookie = "";

before(async () => {
  if (!ready) return;
  dataDir = mkdtempSync(join(tmpdir(), "delphi-it-"));
  const apiPort = await freePort(API_HOST);
  const uiPort = await freePort(UI_HOST);
  origin = `http://${UI_HOST}:${uiPort}`;
  apiOrigin = `http://${API_HOST}:${apiPort}`;

  const env = backendEnv({
    python: PYTHON, dataDir, logsDir: dataDir,
    apiHost: API_HOST, apiPort, uiOrigin: origin,
    sessionSecret: "test-secret-".padEnd(64, "x"),
    // No key: the provider is simply unconfigured, which is a legitimate state
    // (`/api/config` reports providerConfigured:false) and keeps this test free.
    apiKey: "",
  });

  backend = spawn(PYTHON, ["-I", "-m", "uvicorn", BACKEND_APP, "--host", API_HOST, "--port", String(apiPort)],
    { env, cwd: dataDir, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  backend.stderr?.on("data", (c: Buffer) => { stderr = (stderr + c.toString()).slice(-8000); });

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`http://${API_HOST}:${apiPort}/api/health`)).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`backend never became healthy:\n${stderr.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  host = await startWorkerHost({
    distDir: DIST, backendUrl: `http://${API_HOST}:${apiPort}`, uiHost: UI_HOST, uiPort,
  });
});

after(async () => {
  host?.close();
  if (backend && backend.exitCode === null && backend.signalCode === null) {
    const child = backend;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("the bundled backend answers through the host's proxy", needsBuild, async () => {
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { status: string; storage: string };
  assert.equal(body.status, "ok");
  // Filesystem storage, not Cloud SQL: the desktop app has no database.
  assert.equal(body.storage, "local");
});

test("the app shell renders from the same origin as the API", needsBuild, async () => {
  const page = await fetch(`${origin}/`, { headers: { accept: "text/html" } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Dashboard · Delphi/);
});

test("a local account can be created and signed in through the proxy", needsBuild, async () => {
  const credentials = { username: "tester", password: "p".repeat(40) };

  const registered = await fetch(`${origin}/api/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(credentials),
  });
  assert.equal(registered.status, 200, await registered.text());

  const setCookie = registered.headers.getSetCookie?.() ?? [];
  const session = setCookie.find((c) => c.startsWith("delphi_session="));
  assert.ok(session, "no session cookie was set");
  // HttpOnly, so a proxied page's script cannot read it even same-origin.
  assert.match(session!, /HttpOnly/i);
  // Host-only: no Domain attribute, which is what keeps it off 127.0.0.1.
  assert.doesNotMatch(session!, /Domain=/i);
  cookie = session!.split(";")[0]!;

  const me = await fetch(`${origin}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as { username: string }).username, "tester");
});

test("a session cookie is useless against the sandbox origin", needsBuild, async () => {
  /*
   * The invariant the whole design rests on. `WEB_SANDBOX_ORIGIN` is this same
   * FastAPI, and it serves proxied third-party pages with `allow-same-origin`.
   * What stops such a page from driving the API as the reader is not a check in
   * the app — it is that the cookie is host-only on the *UI's* host, so a real
   * browser never sends it here.
   *
   * A browser enforces that by not sending the cookie. This asserts the harder
   * half: that even when the cookie *is* presented to the sandbox origin, the
   * two origins really are different hosts on the same server — so the
   * separation is a property of the deployment, not of client good behaviour.
   */
  assert.ok(cookie, "the previous test must have signed in");

  // Same server, reachable, and definitely a different host from the UI.
  assert.notEqual(new URL(apiOrigin).hostname, new URL(origin).hostname);
  assert.equal((await fetch(`${apiOrigin}/api/health`)).status, 200);

  // The UI origin accepts the cookie...
  assert.equal((await fetch(`${origin}/api/auth/me`, { headers: { cookie } })).status, 200);

  // ...and a browser would never attach it to a request to the sandbox host,
  // because the Set-Cookie carried no Domain. Asserted where it is decided.
  const reissued = await fetch(`${origin}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "tester", password: "p".repeat(40) }),
  });
  const issued = (reissued.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("delphi_session="));
  assert.ok(issued);
  assert.doesNotMatch(issued!, /Domain=/i);

  // And with no cookie at all — which is what the sandbox origin always sees —
  // the API refuses.
  assert.equal((await fetch(`${apiOrigin}/api/auth/me`)).status, 401);
});

test("config reports an unconfigured provider rather than failing", needsBuild, async () => {
  const config = await fetch(`${origin}/api/config`, { headers: { cookie } });
  assert.equal(config.status, 200);
  const body = (await config.json()) as { providerConfigured: boolean; defaultModel: string; defaultReasoningEffort: string; models: string[] };
  // No API key was passed, and that is a state the app must survive.
  assert.equal(body.providerConfigured, false);
  assert.equal(body.defaultModel, "gpt-6.1-sol");
  assert.equal(body.defaultReasoningEffort, "medium");
  assert.deepEqual(body.models, ["gpt-6-luna", "gpt-6.1-sol"]);
});

test("the desktop pins every model task the installed backend defines, at the backend's own values", needsBuild, () => {
  // A new task row in the wheel would otherwise run on the wheel's default, a
  // retired one would go on demanding its model of a ChatGPT plan, and a value
  // the wheel changed would pass unnoticed through a pin bump.
  const listed = spawnSync(PYTHON, ["-I", "-c",
    "import json; from delphi_core.model_tasks import MODEL_TASKS as T; print(json.dumps({s.upper(): v for t in T for s, v in ((t.model_setting, t.model), (t.effort_setting, t.effort)) if s}))"],
    { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  // The picker's list is the desktop's own choice and belongs to no task.
  const pinned = Object.fromEntries(Object.entries(MODEL_SETTINGS).filter(([setting]) => setting !== "MODEL_CHOICES"));
  assert.deepEqual(pinned, JSON.parse(listed.stdout));
});


test("desktop removes web portals and drains disabled account actions", needsBuild, async () => {
  for (const path of ["/landing", "/login", "/register"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const path of ["/api/auth/logout", "/api/auth/change-password"]) {
    const response = await fetch(`${origin}${path}`, {
      method: "POST", body: "x".repeat(256 * 1024),
    });
    assert.equal(response.status, 404);
  }
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
});

test("reader library round-trip: PDF bytes, annotations, isolation and deletion", needsBuild, async () => {
  async function json(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }
  const project = await json("/api/projects", "POST", { name: "Desktop compatibility" });
  assert.equal(project.name, "Desktop compatibility");
  assert.ok(project.id);
  const base = `/api/projects/${project.id}`;
  assert.ok((await json("/api/projects")).some((p: { id: string }) => p.id === project.id));
  const pdf = samplePdf();
  const form = new FormData();
  form.append("file", new Blob([pdf], { type: "application/pdf" }), "contract.pdf");
  const upload = await fetch(`${origin}${base}/papers`, { method: "POST", headers: { cookie }, body: form });
  const uploaded = await upload.text();
  assert.ok(upload.ok, uploaded);
  const loaded = await json(base);
  assert.equal(loaded.papers.length, 1);
  const paper = loaded.papers[0];
  assert.equal(paper.pages, 1);
  const document = `${base}/papers/${paper.id}`;
  const file = await fetch(`${origin}${document}/file`, { headers: { cookie } });
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-type") || "", /application\/pdf/);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), pdf);
  const highlight = await json(`${document}/highlights`, "POST", {
    type: "pdf", page: 1, rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.1 }],
    text: "Desktop contract document", color: "amber",
  });
  const note = await json(`${document}/notes`, "POST", {
    highlightId: highlight.id, page: 1, anchorY: 0.1,
    quotedText: highlight.text, body: "A durable desktop note",
  });
  assert.equal(note.body, "A durable desktop note");
  assert.equal((await json(`${document}/notes`))[0].id, note.id);
  assert.equal((await json(`${document}/highlights`))[0].id, highlight.id);
  const other = await fetch(`${origin}/api/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "otheruser", password: "q".repeat(40) }),
  });
  assert.equal(other.status, 200);
  const otherCookie = other.headers.getSetCookie().find(c => c.startsWith("delphi_session="))!.split(";")[0];
  const denied = await fetch(`${origin}${base}`, { headers: { cookie: otherCookie } });
  assert.ok([403, 404].includes(denied.status));
  await json(`${document}/highlights/${highlight.id}`, "DELETE");
  assert.deepEqual(await json(`${document}/notes`), []);
  await json(base, "DELETE");
  assert.ok(!(await json("/api/projects")).some((p: { id: string }) => p.id === project.id));
});


test("web annotation worker preserves canonical quotes on the trusted origin", needsBuild, async () => {
  const response = await fetch(`${origin}/api/projects/annotation-worker.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /javascript/);
  const messages: Array<Record<string, any>> = [];
  const scope = vm.createContext({crypto:webcrypto,TextEncoder,performance,setTimeout,postMessage:(message:Record<string,any>)=>messages.push(message)}) as vm.Context & {onmessage:(event:{data:Record<string,unknown>})=>Promise<void>};
  vm.runInContext(await response.text(), scope);
  await scope.onmessage({data:{type:"index",generation:1,epoch:1,texts:["A canonical quote"]}});
  const revision = messages.at(-1)?.revision;
  assert.match(revision, /^[a-f0-9]{64}$/);
  // A capture carries the page text read with the selection, so the anchor is
  // of that reading, whatever the frame's index was at the time.
  await scope.onmessage({data:{type:"capture",texts:["A canonical quote"],start:2,end:11,request:"selection"}});
  assert.equal(messages.at(-1)?.type, "captured");
  assert.equal(messages.at(-1)?.text, "canonical");
  assert.equal(messages.at(-1)?.anchor.revision, revision);
});

test("the pinned backend distinguishes live and cached webpage views", needsBuild, async () => {
  /*
   * The reader asks for `?view=live|cached` and refuses a backend that cannot
   * tell them apart, so every webpage would open to an error on an older pin.
   * Creating a webpage needs a public fetch, so the contract is read from the
   * backend's own published schema instead.
   */
  const spec = (await (await fetch(`${apiOrigin}/openapi.json`)).json()) as {
    paths: Record<string, { get: { parameters: Array<{ name: string; in: string; schema: Record<string, any> }> } }>;
  };
  for (const route of ["page-url", "page"]) {
    const parameters = spec.paths[`/api/projects/{project_id}/papers/{paper_id}/${route}`]?.get.parameters ?? [];
    const view = parameters.find((parameter) => parameter.in === "query" && parameter.name === "view");
    assert.ok(view, `${route} accepts no view`);
    const values = [view!.schema.enum, ...(view!.schema.anyOf ?? []).map((option: { enum?: string[] }) => option.enum)]
      .find(Boolean);
    assert.deepEqual([...values].sort(), ["cached", "live"]);
  }
});

test("the pinned backend keeps each chat context's conversations apart", needsBuild, async () => {
  // The contract the conversation tabs are built on, through the host's proxy
  // and the plan handler that sits in front of /api/chat.
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { cookie, origin, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  // The account-wide context: the one chat context that needs no document.
  const context = { scope: "general" };
  const query = (extra: Record<string, string | number> = {}) =>
    new URLSearchParams(Object.entries({ ...context, ...extra }).map(([k, v]) => [k, String(v)]));

  assert.deepEqual((await call(`/api/chat/conversations?${query()}`)).body.items, []);
  const first = (await call("/api/chat/conversations", "POST", { ...context, creation_key: "contract_first" })).body;
  const again = (await call("/api/chat/conversations", "POST", { ...context, creation_key: "contract_first" })).body;
  assert.equal(again.id, first.id, "a retried creation is the same conversation");
  const second = (await call("/api/chat/conversations", "POST", { ...context, creation_key: "contract_second" })).body;
  const listed = (await call(`/api/chat/conversations?${query()}`)).body;
  assert.deepEqual(listed.items.map((item: { id: string }) => item.id), [first.id, second.id]);
  assert.equal(listed.limit, 10);

  const renamed = await call(`/api/chat/conversations/${second.id}`, "PATCH", { title: "Mixed precision", generation: 0 });
  assert.equal(renamed.body.title, "Mixed precision");
  assert.equal(renamed.body.manualTitle, true);

  // Every chat operation names its conversation; the context alone is refused.
  assert.equal((await call(`/api/chat?${query()}`)).status, 422);
  const history = await call(`/api/chat?${query({ conversation_id: first.id, generation: 0 })}`);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.messages, []);

  const deleted = await call(`/api/chat?${query({ conversation_id: first.id, generation: 0 })}`, "DELETE");
  assert.equal(deleted.body.action, "deleted");
  assert.equal(deleted.body.selectedId, second.id);
  const cleared = await call(`/api/chat?${query({ conversation_id: second.id, generation: 0 })}`, "DELETE");
  assert.equal(cleared.body.action, "reset", "the last chat is cleared in place");
  assert.equal((await call(`/api/chat?${query({ conversation_id: second.id, generation: 0 })}`)).status, 409);
});

test("the pinned backend names which web document owns each section anchor", needsBuild, async () => {
  // The citation router asks this before a bare `§anchor` click. Only web
  // sections are anchors: a PDF's indexed pages must not appear, and a project
  // that is not ours is the same 404 as one that does not exist.
  const call = (path: string, method = "GET", body?: BodyInit, json = true) =>
    fetch(`${origin}${path}`, { method, headers: { cookie, ...(json ? { "content-type": "application/json" } : {}) }, body });
  const project = await (await call("/api/projects", "POST", JSON.stringify({ name: "Anchors" }))).json();
  const form = new FormData();
  form.append("file", new Blob([samplePdf()], { type: "application/pdf" }), "anchors.pdf");
  const upload = await call(`/api/projects/${project.id}/papers`, "POST", form, false);
  assert.ok(upload.ok, await upload.text());
  const anchors = await call(`/api/projects/${project.id}/anchors`);
  assert.equal(anchors.status, 200);
  assert.deepEqual(await anchors.json(), { papers: {} });
  assert.equal((await call(`/api/projects/${"f".repeat(12)}/anchors`)).status, 404);
});
