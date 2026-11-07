/**
 * One chat turn through everything the shell owns and everything it ships:
 * the Worker host, the plan adapter in front of `/api/chat`, and the pinned
 * backend, with the backend's provider pointed at a local server that speaks
 * the Responses stream. No Electron and no network.
 *
 * What it holds is the contract between the three: the adapter forwards a
 * body the backend accepts, a turn that searches comes back with its trace
 * and the pages it cites, and a body from before the web flag was retired is
 * refused rather than quietly obeyed.
 *
 * Skips itself unless both halves are built, like the other full-stack test.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { BACKEND_APP, backendEnv } from "../main/backend.ts";
import { API_HOST, UI_HOST, freePort } from "../main/ports.ts";
import { chatPlansHandler } from "../main/research/chat-plans.ts";
import { LocalPlans } from "../main/research/plans.ts";
import { PlanStore } from "../main/research/store.ts";
import { startWorkerHost } from "../main/worker-host.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PYTHON = process.env.DELPHI_TEST_PYTHON || join(ROOT, ".delphi-build", "python", "bin", "python3");
const DIST = process.env.DELPHI_TEST_DIST || join(ROOT, ".delphi-build", "dist");
const ready = existsSync(PYTHON) && existsSync(join(DIST, "server", "index.js"));
const needsBuild = { skip: ready ? false : "run `npm run build` first" };

const SOURCE = { url: "https://example.org/later-work", title: "Later work" };
const ANSWER = `Later work exists ([example.org](${SOURCE.url})).`;

let dataDir = "";
let backend: ChildProcess | undefined;
let host: Awaited<ReturnType<typeof startWorkerHost>> | undefined;
let provider: Server | undefined;
let plans: LocalPlans | undefined;
let store: PlanStore | undefined;
let origin = "";
let cookie = "";
/** Every request the backend made of the model, as it was sent. */
const asked: Array<Record<string, any>> = [];

/** A provider that answers every streamed request with one search and one cited sentence. */
function fixtureProvider(): Server {
  return createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(raw || "{}");
      asked.push(payload);
      const text = payload.text?.format ? JSON.stringify({ slugs: [] }) : payload.tools ? ANSWER : "Later work";
      const message = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{
        type: "output_text", text,
        annotations: payload.tools ? [{ type: "url_citation", url: SOURCE.url, title: SOURCE.title, start_index: 18, end_index: text.length - 1 }] : [],
      }] };
      const search = { id: "ws_1", type: "web_search_call", status: "completed",
        action: { type: "search", query: "later work", sources: [{ type: "url", url: SOURCE.url }] } };
      const output = payload.tools?.some((tool: { type: string }) => tool.type === "web_search") ? [search, message] : [message];
      const body = { id: "resp_1", object: "response", status: "completed", output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
      if (!payload.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      for (const item of output) {
        frame({ type: "response.output_item.added", item: { id: item.id, type: item.type, status: "in_progress" } });
        if (item.type === "message") frame({ type: "response.output_text.delta", delta: text });
        frame({ type: "response.output_item.done", item });
      }
      frame({ type: "response.completed", response: body });
      response.end("data: [DONE]\n\n");
    });
  });
}

before(async () => {
  if (!ready) return;
  dataDir = mkdtempSync(join(tmpdir(), "delphi-chat-journey-"));
  const [apiPort, uiPort, providerPort] = [await freePort(API_HOST), await freePort(UI_HOST), await freePort(API_HOST)];
  origin = `http://${UI_HOST}:${uiPort}`;
  const apiOrigin = `http://${API_HOST}:${apiPort}`;
  provider = fixtureProvider();
  await new Promise<void>(resolve => provider!.listen(providerPort, API_HOST, resolve));

  const env = backendEnv({
    python: PYTHON, dataDir, logsDir: dataDir, apiHost: API_HOST, apiPort, uiOrigin: origin,
    sessionSecret: "test-secret-".padEnd(64, "x"), apiKey: "",
    // The slot a subscription connection fills: a loopback provider and a token.
    inference: { url: `http://${API_HOST}:${providerPort}/v1`, token: "fixture-token" },
  });
  backend = spawn(PYTHON, ["-I", "-m", "uvicorn", BACKEND_APP, "--host", API_HOST, "--port", String(apiPort)],
    { env, cwd: dataDir, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  backend.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { if ((await fetch(`${apiOrigin}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`backend never became healthy:\n${stderr.slice(-2000)}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  store = new PlanStore(join(dataDir, "plans-store"));
  plans = new LocalPlans(store, join(dataDir, "plans"), await freePort(API_HOST));
  host = await startWorkerHost({
    distDir: DIST, backendUrl: apiOrigin, uiHost: UI_HOST, uiPort,
    // The adapter the app mounts in front of the backend's chat routes.
    desktopHandler: chatPlansHandler({ plans, backendUrl: apiOrigin, origin, authenticate: async () => true, installation: async () => "Install MCP once" }),
  });

  const registered = await fetch(`${origin}/api/auth/register`, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ username: "journey", password: "p".repeat(40) }),
  });
  assert.equal(registered.status, 200, await registered.clone().text());
  cookie = (registered.headers.get("set-cookie") ?? "").split(";")[0];
});

after(async () => {
  host?.close();
  plans?.close();
  store?.close();
  provider?.close();
  if (backend && backend.exitCode === null) {
    const child = backend;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) => fetch(`${origin}${path}`, {
  method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body),
});
const events = (text: string) => text.trim().split("\n\n").filter(part => part.startsWith("data:")).map(part => JSON.parse(part.slice(5)));

test("a chat turn through the host, the plan adapter and the pinned backend searches, cites and keeps its trace", needsBuild, async () => {
  const conversation = await (await post("/api/chat/conversations", { scope: "general", creation_key: "journey_first" })).json() as { id: string };
  const response = await post("/api/chat/stream", {
    // What the desktop composer sends: the backend's fields, and the shell's own mode.
    desktop_mode: "chat", prompt: "What came after this work?", scope: "general", conversation_id: conversation.id,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const stream = events(await response.text());
  assert.deepEqual(stream.filter(event => event.type === "error"), []);

  // The model was offered web search without anyone asking for it, and told how many calls it may make.
  const answering = asked.find(payload => payload.stream && payload.tools)!;
  assert.deepEqual(answering.tools.at(-1), { type: "web_search", search_context_size: "medium" });
  assert.equal(answering.max_tool_calls, 8);
  // The shell's capability note rides on the prompt and names no tool or web rule of its own.
  const prompt = JSON.stringify(answering.input);
  assert.match(prompt, /Delphi macOS capability for this turn/);
  assert.doesNotMatch(prompt, /web_search|search the web/i);

  // The reader sees the search where it happened, then the answer, then what it cites.
  const calls = stream.filter(event => event.type === "trace" && event.set?.kind === "tool");
  assert.ok(calls.some(event => event.set.tool === "web_search" && event.set.ok === true && event.set.args?.query === "later work"));
  assert.equal(stream.filter(event => event.type === "delta").map(event => event.text).join(""), ANSWER);
  const done = stream.at(-1);
  assert.equal(done.type, "done");
  assert.deepEqual(done.sources, [SOURCE]);
  assert.equal(done.incomplete ?? null, null);

  // And it is stored that way: a reload is told the same thing.
  const history = await (await fetch(`${origin}/api/chat?scope=general&conversation_id=${conversation.id}`, { headers: { cookie } })).json() as { messages: Array<Record<string, any>> };
  const answer = history.messages.at(-1)!;
  assert.equal(answer.content, ANSWER);
  assert.deepEqual(answer.sources, [SOURCE]);
  assert.ok(answer.trace.flatMap((stretch: { entries: Array<{ tool?: string }> }) => stretch.entries).some((entry: { tool?: string }) => entry.tool === "web_search"));
});

test("a body from before the web flag was retired is refused, not quietly obeyed", needsBuild, async () => {
  const conversation = await (await post("/api/chat/conversations", { scope: "general", creation_key: "journey_stale" })).json() as { id: string };
  const before = asked.length;
  const stale = await post("/api/chat/stream", {
    desktop_mode: "chat", prompt: "Search for it.", scope: "general", conversation_id: conversation.id, web_search: true,
  });
  assert.equal(stale.status, 422);
  assert.match(await stale.text(), /web_search/);
  assert.equal(asked.length, before, "nothing was asked of the model");
});

test("a side question goes through the host to the backend untouched, and nothing is kept", needsBuild, async () => {
  const conversation = await (await post("/api/chat/conversations", { scope: "general", creation_key: "journey_side" })).json() as { id: string };
  const main = await post("/api/chat/stream", { desktop_mode: "chat", prompt: "What came after this work?", scope: "general", conversation_id: conversation.id });
  assert.equal(main.status, 200);
  await main.text();
  const historyUrl = `${origin}/api/chat?scope=general&conversation_id=${conversation.id}`;
  const before = await (await fetch(historyUrl, { headers: { cookie } })).text();
  const receipts = store!.objects("chat_receipts").length;
  const asking = asked.length;

  const side = await post("/api/chat/side", {
    prompt: "Summarize this side chat.", scope: "general", conversation_id: conversation.id,
    side_turns: [{ question: "Who wrote it?", answer: "Two authors." }],
  });

  assert.equal(side.status, 200, await side.clone().text());
  const stream = events(await side.text());
  assert.deepEqual(stream.filter(event => event.type === "error"), []);
  assert.equal(stream.at(-1).type, "done");
  // The body reached the backend as the client wrote it: the question carries
  // no capability note, and the side turns follow the main thread's marker.
  const sent = asked.slice(asking).find(payload => payload.stream)!;
  const input = sent.input.filter((item: { content: unknown }) => typeof item.content === "string").map((item: { role: string; content: string }) => [item.role, item.content]);
  assert.deepEqual(input.slice(-4), [
    ["user", "[Side chat starts here. Everything above is the main conversation, shown for context. The side chat's own turns follow, then this turn's context and the reader's side question.]"],
    ["user", "Who wrote it?"], ["assistant", "Two authors."],
    ["user", "Summarize this side chat."],
  ]);
  // No receipt, and the conversation reads exactly as it did.
  assert.equal(store!.objects("chat_receipts").length, receipts);
  assert.equal(await (await fetch(historyUrl, { headers: { cookie } })).text(), before);
});

test("the shell refuses to carry its plan flag on a side question", needsBuild, async () => {
  const conversation = await (await post("/api/chat/conversations", { scope: "general", creation_key: "journey_side_plan" })).json() as { id: string };
  const asking = asked.length;
  const refused = await post("/api/chat/side", { desktop_mode: "plan", prompt: "Plan it.", scope: "general", conversation_id: conversation.id });
  assert.equal(refused.status, 422);
  assert.equal(asked.length, asking, "nothing was asked of the model");
});
