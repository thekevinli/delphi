/**
 * Ask Delphi questions through both AI plans at once, as the reader's window would.
 *
 *   cd desktop && (source build/runtime.sh && ensure_frontend_runtime &&
 *     node --experimental-strip-types scripts/live-answers.mts --cases cases.json --out ../.delphi-build/live-answers/<run>)
 *
 * Options: --connections chatgpt-oauth,claude-subscription (the default: both plans) · --chats main
 * (the default; add side only as a last, low-risk check, since it doubles the calls) · --parallel 3 (answers at once per connection) · --pdfs <dir of <arxiv>.pdf> (missing ones
 * are fetched from arXiv) · --profile <Delphi's Application Support folder> · --python <interpreter>.
 *
 * A case is one reader asking about one paper:
 *   { "id": "qlora.anchor_only", "question": "Explain this paper to me.", "said": null,
 *     "library": [{ "arxiv": "2106.09685", "title": "LoRA: …", "filed": true, "done": true },
 *                 { "arxiv": "2305.14314", "title": "QLoRA: …", "filed": true, "done": false, "target": true }] }
 * `filed` documents are imported and filed into Memory before the question; `done` marks one finished;
 * `said` is typed ahead of the question; the `target` is the paper open beside the chat. A file of a list
 * of cases, or of `{ "cases": { id: case } }`, is read.
 *
 * What is the app's own code, so a run sees what a reader sees: the plans' connections and bridge
 * (`main/inference`), the backend's environment and process (`backendEnv`, `startBackend`), the desktop's
 * chat envelope (`chatPlansHandler`, which adds the turn's capability note), the frontend's side-chat body
 * (`sideRequestBody`), and the checkout's `core/` and `desktop/backend/` serving every request. The Memory
 * is filed by the shipped pipeline, drained as the window drains it.
 *
 * What differs, on purpose: each document is its own project, so Memory is the only way one reaches
 * another's answer; a domain's summary settles after 5 s instead of 10 minutes, which changes when it is
 * written and not what; and there is no browser host, so answers draw no inline visuals (that needs
 * Electron's Chromium).
 *
 * The script holds no credential of its own. It uses the plans signed in to Delphi on this Mac, as the app
 * does: Claude Code's own sign-in, and the ChatGPT sign-in in Delphi's profile, which the app's client
 * refreshes in place when it expires (so prefer not to run it while Delphi itself is refreshing that sign-in).
 * Each backend has its own bridge with a per-launch token, and the model requests it carries are kept beside
 * its answer, document bytes elided.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { backendEnv, modelSettings, startBackend, type Backend, type ConnectionId } from "../main/backend.ts";
import { startInferenceBridge, type InferenceBridge, type Upstream } from "../main/inference/bridge.ts";
import { SubscriptionConnection } from "../main/inference/connection.ts";
import { oauthStore } from "../main/inference/oauth-store.ts";
import { ClaudeConnection } from "../main/inference/claude-runtime.ts";
import { ClaudeTransport } from "../main/inference/claude-transport.ts";
import { chatPlansHandler } from "../main/research/chat-plans.ts";
import { LocalPlans } from "../main/research/plans.ts";
import { PlanStore } from "../main/research/store.ts";
import { sideRequestBody } from "../frontend/app/lib/side-chat.ts";

interface Doc { arxiv: string; title: string; url?: string; filed: boolean; done: boolean; target?: boolean }
interface Case { id: string; question: string; said?: string | null; library: Doc[] }
type Chat = "main" | "side";
type Plan = Extract<ConnectionId, "chatgpt-oauth" | "claude-subscription">;

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const { values: args } = parseArgs({ options: {
  cases: { type: "string" }, out: { type: "string" }, connections: { type: "string", default: "chatgpt-oauth,claude-subscription" },
  chats: { type: "string", default: "main" }, parallel: { type: "string", default: "3" }, pdfs: { type: "string" },
  profile: { type: "string", default: join(homedir(), "Library/Application Support/Delphi") },
  python: { type: "string", default: join(REPO, ".delphi-build/core-env/bin/python3") },
} });
if (!args.cases || !args.out) throw new Error("Give --cases <file> and --out <directory>.");
const OUT = resolve(args.out), PDFS = resolve(args.pdfs ?? join(OUT, "pdfs"));
const plans = args.connections.split(",").map(s => s.trim()) as Plan[];
const chats = args.chats.split(",").map(s => s.trim()) as Chat[];
for (const plan of plans) if (plan !== "chatgpt-oauth" && plan !== "claude-subscription") throw new Error(`Not a plan: ${plan}`);
const raw = JSON.parse(readFileSync(args.cases, "utf8"));
const cases: Case[] = Array.isArray(raw) ? raw : Object.entries(raw.cases ?? raw).map(([id, value]) => ({ id, ...(value as object) }) as Case);
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => shutdown.abort());
const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
const writeJson = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2)); };

/* The plans: one connection object each, shared by every bridge. */
const upstreams: Record<Plan, () => Promise<{ upstream: Upstream; options: { limits: unknown; provider?: "Claude"; prime?: boolean } }>> = {
  "chatgpt-oauth": (() => {
    const connection = new SubscriptionConnection(oauthStore(join(args.profile, "inference"), {
      isEncryptionAvailable: () => false, decryptString: () => { throw new Error("Open Delphi once to move the ChatGPT sign-in out of Keychain."); },
    }), async () => { throw new Error("Sign in to ChatGPT in Delphi first."); });
    // The client is shared, so a bridge that stops must not stop it.
    const shared: Upstream = { responses: (payload, signal, headers) => connection.oauth.responses(payload, signal, headers) };
    return async () => ({ upstream: shared, options: { limits: connection.limits } });
  })(),
  "claude-subscription": (() => {
    const claude = new ClaudeConnection();
    return async () => ({ upstream: new ClaudeTransport(claude), options: { limits: claude.limits, provider: "Claude", prime: false } });
  })(),
};
async function ready(plan: Plan): Promise<void> {
  const status = plan === "chatgpt-oauth"
    ? await new SubscriptionConnection(oauthStore(join(args.profile, "inference"), { isEncryptionAvailable: () => false, decryptString: () => "" }), async () => {}).status()
    : await new ClaudeConnection().status();
  if (!status.connected) throw new Error(`${plan} is not signed in on this Mac (${status.message ?? "sign in from Delphi's AI Connection"}).`);
}

/** Keeps each model request beside the answer that made it; document bytes are elided. */
function recorded(upstream: Upstream, directory: string): Upstream {
  let n = 0;
  const elide = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") return key === "file_data" || value.startsWith("data:") ? `[${value.length} characters]` : value;
    if (Array.isArray(value)) return value.map(item => elide(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, elide(v, k)]));
    return value;
  };
  return {
    responses(payload, signal, headers) {
      writeJson(join(directory, `${String(++n).padStart(3, "0")}.request.json`), elide(payload));
      return upstream.responses(payload, signal, headers);
    },
    stop: upstream.stop?.bind(upstream),
  };
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

/** The checkout's code on the given interpreter, everything else exactly as `startBackend` runs it. */
function interpreter(): string {
  if (!existsSync(resolve(args.python))) throw new Error(`No interpreter at ${args.python}: run scripts/core-env.sh, or pass --python.`);
  const path = join(OUT, "python");
  writeFileSync(path, `#!/bin/sh\nPYTHONPATH="${join(REPO, "core")}:${join(REPO, "desktop/backend")}" MEMORY_DOMAIN_SETTLE_SECONDS=5 exec "${resolve(args.python)}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** One isolated Delphi: a bridge to `plan`, the backend on `data`, and a signed-in reader. */
class Delphi {
  backend!: Backend; bridge!: InferenceBridge; cookie = ""; ui = ""; config!: Record<string, string>;
  readonly plan: Plan; readonly data: string; readonly logs: string;
  constructor(plan: Plan, data: string, logs: string) { this.plan = plan; this.data = data; this.logs = logs; }
  async start(create: boolean): Promise<this> {
    mkdirSync(this.data, { recursive: true }); mkdirSync(this.logs, { recursive: true });
    const { upstream, options } = await upstreams[this.plan]();
    this.bridge = await startInferenceBridge({ upstream: recorded(upstream, join(this.logs, "provider")), ...options } as Parameters<typeof startInferenceBridge>[0]);
    const apiPort = await freePort();
    this.ui = `http://localhost:${await freePort()}`;
    this.backend = await startBackend({
      signal: shutdown.signal, python: PYTHON, dataDir: this.data, logsDir: this.logs, apiHost: "127.0.0.1", apiPort,
      uiOrigin: this.ui, sessionSecret: randomBytes(32).toString("hex"), apiKey: "", connection: this.plan,
      inference: { url: this.bridge.url, token: this.bridge.token },
    });
    const account = { username: "reader", password: "live-answers-reader" };  // an isolated store's own account
    let response = await this.request(create ? "/api/auth/register" : "/api/auth/login", { method: "POST", json: account }, false);
    if (create && response.status === 409) response = await this.request("/api/auth/login", { method: "POST", json: account }, false);
    if (!response.ok) throw new Error(`Sign-in failed: ${response.status} ${await response.text()}`);
    this.cookie = response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    this.config = await this.json("/api/config");
    return this;
  }
  async stop(): Promise<void> {
    this.backend?.stop(); await this.backend?.closed; await this.bridge?.stop(2_000);
  }
  request(path: string, init: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}, check = true): Promise<Response> {
    const headers: Record<string, string> = { origin: this.ui, cookie: this.cookie, ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...init.headers };
    return fetch(this.backend.url + path, { method: init.method ?? "GET", headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, signal: shutdown.signal })
      .then(async response => { if (check && !response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${(await response.text()).slice(0, 400)}`); return response; });
  }
  async json<T = any>(path: string, init?: Parameters<Delphi["request"]>[1]): Promise<T> { return (await this.request(path, init)).json() as Promise<T>; }
  /** A document in a project of its own, titled as the reader would see it. */
  async import(doc: Doc): Promise<{ project_id: string; paper_id: string }> {
    const project = await this.json("/api/projects", { method: "POST", json: { name: doc.target ? "Reading" : "Library" } });
    const form = new FormData();
    form.set("file", new Blob([readFileSync(await pdf(doc))], { type: "application/pdf" }), `${doc.arxiv.replace("/", "_")}.pdf`);
    const paper = await this.json(`/api/projects/${project.id}/papers`, { method: "POST", body: form });
    await this.json(`/api/projects/${project.id}/papers/${paper.id}`, { method: "PATCH", json: { title: doc.title } });
    return { project_id: project.id, paper_id: paper.id };
  }
  /** Memory's queue until it settles, as an open window drains it. A job that gave up is retried
   * twice, as a reader would press Retry (the checker refuses an invented page, and a second
   * pass usually cites the right one). */
  async drain(deadlineMs = 45 * 60_000, retries = 2): Promise<void> {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
      const state = await this.json("/api/memory/maintenance");
      if (!state.pending && !state.leased && !state.failed) return;
      // Given up is failed with no `retryAt`; a failed job still waiting out its backoff is left to it.
      const gaveUp = (state.jobs ?? []).filter((job: { status: string; retryAt?: string | null }) => job.status === "failed" && !job.retryAt);
      if (gaveUp.length && !state.due && !state.pending) {
        const failed = gaveUp;
        if (!retries--) throw new Error(`Memory filing failed: ${failed.map((job: { lastError?: string }) => job.lastError).join("; ").slice(0, 400)}`);
        log({ filing: basename(this.data), retry: failed.map((job: { lastError?: string }) => job.lastError) });
        for (const job of failed) await this.json(`/api/memory/maintenance/jobs/${job.id}/retry`, { method: "POST" });
        continue;
      }
      if (!state.due) { await new Promise(r => setTimeout(r, 3_000)); continue; }
      // Three drains at once, as the window's pump runs them (`DRAIN_WORKERS` in
      // frontend/app/lib/memory-maintenance.ts, which needs a browser to import).
      await Promise.all(Array.from({ length: 3 }, async () => {
        for await (const event of sse(await this.request("/api/memory/maintenance/drain", { method: "POST" }))) {
          if (event.type === "progress" || event.type === "done") log({ filing: basename(this.data), stage: event.stage, message: event.message ?? event.outcome });
        }
      }));
    }
    throw new Error("Memory did not settle in time.");
  }
}

async function* sse(response: Response): AsyncGenerator<Record<string, any>> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
      const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data);
    }
  }
}

async function pdf(doc: Doc): Promise<string> {
  const path = join(PDFS, `${doc.arxiv.replace("/", "_")}.pdf`);
  if (existsSync(path)) return path;
  mkdirSync(PDFS, { recursive: true });
  const response = await fetch(doc.url ?? `https://arxiv.org/pdf/${doc.arxiv}`, { signal: shutdown.signal });
  if (!response.ok) throw new Error(`Could not fetch ${doc.arxiv}: ${response.status}`);
  writeFileSync(`${path}.part`, Buffer.from(await response.arrayBuffer())); renameSync(`${path}.part`, path);
  return path;
}

/* Libraries: each set of filed documents is filed once per plan, from the largest one already filed. */
const staged = new Map<string, Promise<string>>();
const finished = new Map<string, string[]>();
function stage(plan: Plan, docs: Doc[]): Promise<string> {
  const filed = docs.filter(d => d.filed).map(d => d.arxiv).sort();
  const key = `${plan}:${filed.join(",")}`;
  if (!staged.has(key)) staged.set(key, (async () => {
    // Readable, and unique however long the list: a cut name alone could be two libraries.
    const joined = filed.join("+").replace(/\//g, "_");
    const name = !filed.length ? "empty" : joined.length <= 120 ? joined
      : `${joined.slice(0, 100)}-${createHash("sha256").update(joined).digest("hex").slice(0, 12)}`;
    const snapshot = join(OUT, "libraries", plan, name, "data");
    if (existsSync(join(snapshot, "live-library.json"))) { finished.set(snapshot, filed); return snapshot; }
    const base = [...finished].filter(([path, have]) => path.includes(`/${plan}/`) && have.every(a => filed.includes(a)))
      .sort((a, b) => b[1].length - a[1].length)[0];
    const work = join(OUT, "libraries", plan, name, "staging");
    rmSync(work, { recursive: true, force: true });
    if (base) cpSync(base[0], work, { recursive: true });
    const delphi = new Delphi(plan, work, join(OUT, "libraries", plan, name));
    try {  // stop() tolerates a start that failed part-way, so nothing outlives it
      await delphi.start(!base);
      const imported: Record<string, unknown> = base ? JSON.parse(readFileSync(join(work, "live-library.json"), "utf8")) : {};
      for (const doc of docs.filter(d => d.filed && !imported[d.arxiv])) imported[doc.arxiv] = await delphi.import(doc);
      await delphi.drain();
      writeJson(join(work, "live-library.json"), imported);
    } finally { await delphi.stop(); }
    cpSync(work, snapshot, { recursive: true }); rmSync(work, { recursive: true, force: true });
    finished.set(snapshot, filed);
    log({ staged: name, plan, from: base ? basename(dirname(base[0])) : "empty" });
    return snapshot;
  })());
  return staged.get(key)!;
}

/** One answer: a copy of the filed library, the reader's marks, then the question as the window asks it. */
async function answer(plan: Plan, item: Case, chat: Chat): Promise<void> {
  const id = `${item.id}.${plan}.${chat}`, directory = join(OUT, "answers", id);
  if (existsSync(join(directory, "result.json"))) return;
  if (existsSync(directory)) renameSync(directory, `${directory}.failed-${Date.now()}`);
  const snapshot = await stage(plan, item.library);
  const data = join(directory, "data");
  cpSync(snapshot, data, { recursive: true });
  const delphi = new Delphi(plan, data, directory);
  const planStore = new PlanStore(join(directory, "plans"));
  // A chat turn saves no plan, so its port range is never bound.
  const localPlans = new LocalPlans(planStore, join(directory, "plans/pages"));
  try {
    await delphi.start(false);
    const library = JSON.parse(readFileSync(join(data, "live-library.json"), "utf8")) as Record<string, { project_id: string; paper_id: string }>;
    for (const doc of item.library.filter(d => !d.filed)) library[doc.arxiv] = await delphi.import(doc);  // in the library, never filed
    for (const doc of item.library.filter(d => d.done)) {
      const { project_id, paper_id } = library[doc.arxiv];
      await delphi.json(`/api/projects/${project_id}/papers/${paper_id}/done`, { method: "POST", json: { done: true } });
    }
    const target = item.library.find(d => d.target);
    if (!target) throw new Error(`${item.id} names no target paper.`);
    const where = { scope: "document", ...(library[target.arxiv] ?? await delphi.import(target)) };
    const conversation = await delphi.json("/api/chat/conversations", { method: "POST", json: { ...where, creation_key: randomUUID().replace(/-/g, "") } });
    const prompt = item.said ? `${item.said}\n\n${item.question}` : item.question;
    const model = delphi.config.defaultModel, effort = delphi.config.defaultReasoningEffort;
    let response: Response, body: Record<string, unknown>;
    const started = Date.now();
    if (chat === "main") {
      // The body ChatPanel sends, through the desktop's envelope as the worker host routes it.
      body = { prompt, desktop_mode: "chat", ...where, conversation_id: conversation.id, generation: conversation.generation,
        referenced_paper_ids: [], referenced_image_ids: [], selected_text: null, reasoning_effort: effort, model,
        request_id: randomUUID(), engagement_id: randomUUID(), viewport: null };
      const handler = chatPlansHandler({ plans: localPlans, backendUrl: delphi.backend.url, origin: delphi.ui,
        authenticate: async () => true, installation: async () => "" });
      response = (await handler(new Request(`${delphi.ui}/api/chat/stream`, { method: "POST", signal: shutdown.signal,
        headers: { origin: delphi.ui, "content-type": "application/json", cookie: delphi.cookie }, body: JSON.stringify(body) })))!;
    } else {
      body = sideRequestBody({ scope: where, conversation, prompt, turns: [], model, effort, personaId: null });
      response = await delphi.request("/api/chat/side", { method: "POST", json: body, headers: { accept: "text/event-stream" } }, false);
    }
    const result: Record<string, any> = { case: item.id, plan, chat, model, effort, answer: "", error: null, trace: null, sources: [], incomplete: null, request: body };
    if (!response.ok) result.error = `${response.status}: ${(await response.text()).slice(0, 400)}`;
    else for await (const event of sse(response)) {
      if (event.type === "delta") { result.firstTextMs ??= Date.now() - started; result.answer += event.text ?? ""; }
      else if (event.type === "error") result.error = event.message ?? JSON.stringify(event);
      else if (event.type === "done") Object.assign(result, { trace: event.trace ?? null, sources: event.sources ?? [], incomplete: event.incomplete ?? null });
    }
    result.totalMs = Date.now() - started;
    result.words = result.answer.split(/\s+/).filter(Boolean).length;
    result.memoryPages = (result.trace ?? []).flatMap((stretch: any) => (stretch?.context?.given ?? []).map((page: any) => page?.slug).filter(Boolean));
    if (result.error || !result.answer) { writeJson(join(directory, "failed.json"), result); throw new Error(`${id}: ${result.error ?? "no answer"}`); }
    writeJson(join(directory, "result.json"), result);
    log({ answered: id, words: result.words, pages: result.memoryPages.length });
  } finally {
    localPlans.close(); planStore.close();
    await delphi.stop();
    rmSync(data, { recursive: true, force: true });  // the library snapshot is kept; its copy is not
  }
}

/* The run: a pool per plan, libraries first so the larger ones file on top of the smaller. */
mkdirSync(OUT, { recursive: true });
const PYTHON = interpreter();
for (const plan of plans) await ready(plan);
const commit = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(); } catch { return "unknown"; } })();
writeJson(join(OUT, "run.json"), { startedAt: new Date().toISOString(), commit, chats, cases: cases.map(c => c.id),
  plans: Object.fromEntries(plans.map(plan => { const s = modelSettings(plan); return [plan, { model: s.MODEL_DEFAULT, effort: s.REASONING_EFFORT_DEFAULT, memorySelect: s.MEMORY_SELECT_MODEL, digest: s.DIGEST_MODEL }]; })) });
const parallel = Math.max(1, Number(args.parallel));
const failures: string[] = [];
await Promise.all(plans.map(async plan => {
  const libraries = [...new Map(cases.map(c => [c.library.filter(d => d.filed).map(d => d.arxiv).sort().join(","), c])).values()]
    .sort((a, b) => a.library.filter(d => d.filed).length - b.library.filter(d => d.filed).length);
  const run = async (jobs: (() => Promise<unknown>)[]) => {
    let next = 0;
    await Promise.all(Array.from({ length: parallel }, async () => {
      while (next < jobs.length && !shutdown.signal.aborted) {
        const job = jobs[next++];
        try { await job(); } catch (error) { failures.push(String(error).slice(0, 300)); log({ failed: String(error).slice(0, 300) }); }
      }
    }));
  };
  await run(libraries.map(c => () => stage(plan, c.library)));
  await run(cases.flatMap(c => chats.map(chat => () => answer(plan, c, chat))));
}));
writeJson(join(OUT, "run.json"), { ...JSON.parse(readFileSync(join(OUT, "run.json"), "utf8")), finishedAt: new Date().toISOString(), failures });
log({ done: true, failures: failures.length });
process.exit(failures.length ? 1 : 0);
