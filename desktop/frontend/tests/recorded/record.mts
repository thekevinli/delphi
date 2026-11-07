/**
 * Records what the installed backend answers on every Memory route the desktop
 * frontend calls, for `recorded.test.mts` to hold the browser fixtures and the
 * `api.ts` types against. Run it again whenever the backend pin moves:
 *
 *   node --experimental-strip-types frontend/tests/recorded/record.mts
 *
 * It starts the pinned backend (`.delphi-build/python`, or `DELPHI_TEST_PYTHON`)
 * on a temporary profile, with the core's scripted model provider
 * (`DELPHI_E2E_PROVIDER`) served beside it as the model, and nothing else
 * scripted. A reader signs up, files three self-made documents and then uses
 * Memory the way the desktop does. Each answer is kept in `responses.json`
 * with its ids, times and hashes made stable, so a second run writes the same
 * file and a diff shows only what the backend changed. One exception: the order
 * of items the backend ties on a real id (a page's links, equally scored search
 * results) can differ between runs, because those ids are random.
 *
 * Talks to the backend directly: the desktop's host forwards Memory routes
 * unchanged, and none of them is one it answers itself.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKEND_APP, backendEnv, PARENT_WATCH } from "../../../main/backend.ts";
import { API_HOST, freePort } from "../../../main/ports.ts";
import { parseSseFrames } from "../../app/lib/sse.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("./responses.json", import.meta.url));
const python = process.env.DELPHI_TEST_PYTHON || join(root, ".delphi-build/python/bin/python3");
const provider = resolve(process.env.DELPHI_E2E_PROVIDER || join(root, "../core/testkit/delphi_core_testkit/provider.py"));
// The provider needs `jsonschema`, which the app's runtime does not ship. The
// core's development environment (`bash scripts/core-env.sh`) has it.
const providerPython = process.env.DELPHI_E2E_PYTHON
  || [join(root, "../.delphi-build/core-env/bin/python3")].find(existsSync)
  || python;

/** Serves the provider's fixture router, and exits when the recorder does. */
const PROVIDER_SERVER = [
  "import importlib.util, os, sys, threading",
  "def orphaned():",
  "    sys.stdin.buffer.read()",
  "    os._exit(0)",
  "threading.Thread(target=orphaned, daemon=True).start()",
  "spec = importlib.util.spec_from_file_location('e2e_provider', sys.argv[1])",
  "fixture = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(fixture)",
  "import uvicorn",
  "from fastapi import FastAPI",
  "app = FastAPI()",
  "app.include_router(fixture.fixture_router)",
  "uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[2]), log_level='warning')",
].join("\n");

/** The core's version, and a check that the interpreter's runtime was built from this core/. */
function pinnedBackend(): string {
  const version = readFileSync(join(root, "../core/pyproject.toml"), "utf8").match(/^version = "(.+)"$/m)?.[1];
  const receipt = join(dirname(dirname(python)), "backend-wheel.receipt");
  const check = spawnSync("bash", [join(root, "build/check-backend-runtime.sh")], { encoding: "utf8" });
  if (!version || !existsSync(receipt) || readFileSync(receipt, "utf8").split("\n")[0] !== version || check.status !== 0) {
    throw new Error(`${python} was not built from this core/ (${version}). Run npm run build, or point DELPHI_TEST_PYTHON at a runtime that was.`);
  }
  return version;
}

/** A two-page PDF of selectable text, written here: no third-party content. */
function documentPdf(pages: string[][]): Blob {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  const font = 3 + pages.length * 2;
  for (const lines of pages) {
    const stream = `BT /F1 13 Tf 48 730 Td 22 TL ${lines.map(line => `(${line}) Tj`).join(" T* ")} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([pdf], { type: "application/pdf" });
}

const NOTES = [
  ["Notes on reusing a prompt prefix", "A request that repeats an earlier prefix can skip the work for that prefix.",
    "Only an exact token match counts; a paraphrase starts over.", "Put what changes, the question, at the end."],
  ["A small timing comparison", "Twenty requests with a fixed prefix against twenty with a shuffled one.",
    "Fixed: 120 ms median. Shuffled: 240 ms median.", "One machine and one prompt length; not a general result."],
];

function spawnChild(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  // stdin is the parent-death signal for both children.
  const child = spawn(command, args, { env, cwd, stdio: ["pipe", "ignore", "pipe"] });
  let log = "";
  child.stderr?.on("data", (chunk: Buffer) => { log = (log + chunk.toString()).slice(-12_000); });
  return { child, log: () => log };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(done => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => { clearTimeout(timer); done(); });
    child.kill("SIGTERM");
  });
}

async function until(what: string, ready: () => Promise<boolean>, logs: () => string, seconds = 60) {
  for (const deadline = Date.now() + seconds * 1000; ;) {
    try { if (await ready()) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`${what} never became ready:\n${logs().slice(-3000)}`);
    await new Promise(done => setTimeout(done, 200));
  }
}

type Sample = { case: string; status: number; json?: unknown; events?: unknown[] };

async function record() {
  const version = pinnedBackend();
  if (!existsSync(provider)) throw new Error(`No scripted provider at ${provider}; set DELPHI_E2E_PROVIDER.`);
  const scratch = mkdtempSync(join(tmpdir(), "delphi-recorded-"));
  const [providerPort, apiPort] = [await freePort(API_HOST), await freePort(API_HOST)];
  const uiOrigin = "http://localhost:3999";
  const fixtureModel = spawnChild(providerPython, ["-I", "-c", PROVIDER_SERVER, provider, String(providerPort)],
    { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" } as Record<string, string | undefined> as NodeJS.ProcessEnv, scratch);
  const env = {
    ...backendEnv({
      python, dataDir: join(scratch, "data"), logsDir: scratch, apiHost: API_HOST, apiPort, uiOrigin,
      sessionSecret: "recorded-responses-".padEnd(64, "x"), apiKey: "sk-recorded-responses-only",
      apiBaseUrl: `http://${API_HOST}:${providerPort}/__fixtures/provider/v1`,
    }),
    // A session or a domain change is filed when the queue is next drained, not after a wait.
    MEMORY_SESSION_IDLE_SECONDS: "0",
    MEMORY_DOMAIN_SETTLE_SECONDS: "0",
    // One try, so the document scripted to stall gives up at once.
    MEMORY_JOB_MAX_ATTEMPTS: "1",
  };
  const backend = spawnChild(python, ["-I", "-c", PARENT_WATCH, BACKEND_APP, "--host", API_HOST, "--port", String(apiPort), "--timeout-graceful-shutdown", "2"], env, scratch);
  const routes: Record<string, Sample[]> = {};
  try {
    await until("the scripted provider", async () => (await fetch(`http://${API_HOST}:${providerPort}/__fixtures/provider/requests`)).ok, fixtureModel.log);
    await until("the backend", async () => (await fetch(`http://${API_HOST}:${apiPort}/api/health`)).ok, backend.log);
    const base = `http://${API_HOST}:${apiPort}`;
    const registered = await fetch(`${base}/api/auth/register`, {
      method: "POST", headers: { "content-type": "application/json", origin: uiOrigin },
      body: JSON.stringify({ username: "reader", password: "recorded-responses-only-".padEnd(40, "x") }),
    });
    const cookie = registered.headers.getSetCookie().find(value => value.startsWith("delphi_session="))?.split(";")[0];
    assert.ok(registered.ok && cookie, `register failed: ${registered.status} ${await registered.text()}`);

    const call = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
      method, headers: { cookie, origin: uiOrigin, ...(body === undefined || body instanceof FormData ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    /** One answer, kept under its route's pattern; `path` fills the pattern's parameters. */
    const keep = async (route: string, label: string, path: string, body?: unknown): Promise<any> => {
      const method = route.split(" ")[0]!;
      const response = await call(method, path, body);
      const text = await response.text();
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${text.slice(0, 400)}`);
      const sample: Sample = { case: label, status: response.status };
      let value: unknown;
      if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) value = sample.events = parseSseFrames(text.endsWith("\n\n") ? text : `${text}\n\n`).events;
      else if (text) value = sample.json = JSON.parse(text);
      (routes[route] ??= []).push(sample);
      return value;
    };
    const json = async (path: string) => {
      const response = await call("GET", path);
      assert.ok(response.ok, `GET ${path}: ${response.status}`);
      return response.json() as Promise<any>;
    };
    /** Runs the queue as a foreground tab does, keeping the first job's frames and the empty claim's. */
    const drain = async (label: string) => {
      for (let round = 0; round < 40; round += 1) {
        const response = await call("POST", "/api/memory/maintenance/drain");
        const events = parseSseFrames(await response.text()).events;
        const claimed = events.at(-1)?.claimed !== false;
        const kept = routes["POST /api/memory/maintenance/drain"] ??= [];
        const name = claimed ? `${label}: ${events.some(event => event.type === "error") ? "a job that failed" : "a job"}` : "nothing due";
        if (!kept.some(sample => sample.case === name)) kept.push({ case: name, status: response.status, events });
        if (!claimed) return;
      }
      throw new Error("the queue never emptied");
    };

    await keep("GET /api/config", "signed in", "/api/config");
    const project = await (await call("POST", "/api/projects", { name: "Cache studies" })).json() as { id: string };
    const papers: Record<string, string> = {};
    /** Adds a self-made document, titled for what the scripted provider does with it. */
    const upload = async (name: string, title: string) => {
      const form = new FormData();
      form.append("file", documentPdf(NOTES), `${title}.pdf`);
      const response = await call("POST", `/api/projects/${project.id}/papers`, form);
      assert.equal(response.status, 201, await response.clone().text());
      papers[name] = ((await response.json()) as { id: string }).id;
    };
    const pageOf = async (kind: string) => {
      const page = (await json("/api/memory/pages") as Array<{ slug: string; kind: string }>).find(entry => entry.kind === kind);
      assert.ok(page, `Memory holds no ${kind} page`);
      return page;
    };

    // A plain document, and one whose filing has a page the checker refuses.
    await upload("plain", "Prefix reuse notes");
    await upload("refused", "Refused Claim Study one");
    await keep("GET /api/memory/maintenance", "documents queued", "/api/memory/maintenance");
    await keep("GET /api/memory/documents/{paperId}/filing", "queued", `/api/memory/documents/${papers.plain}/filing`);
    await keep("GET /api/memory/documents/{paperId}/neighborhood", "not filed yet", `/api/memory/documents/${papers.plain}/neighborhood?hops=2`);
    await keep("GET /api/memory/backfill/papers", "documents queued", "/api/memory/backfill/papers");
    await drain("filing");

    await keep("GET /api/memory", "documents filed", "/api/memory");
    await keep("GET /api/memory/domains", "documents filed", "/api/memory/domains");
    await keep("GET /api/memory/pages", "documents filed", "/api/memory/pages");
    const concept = await pageOf("concept");
    const source = await pageOf("source");
    await keep("GET /api/memory/pages/{slug}", "a concept page", `/api/memory/pages/${concept.slug}`);
    await keep("GET /api/memory/pages/{slug}", "a source page", `/api/memory/pages/${source.slug}`);
    await keep("GET /api/memory/neighborhood", "a concept page", `/api/memory/neighborhood?slug=${concept.slug}&hops=2`);
    await keep("GET /api/memory/documents/{paperId}/neighborhood", "filed", `/api/memory/documents/${papers.plain}/neighborhood?hops=2`);
    await keep("GET /api/memory/documents/{paperId}/filing", "filed", `/api/memory/documents/${papers.plain}/filing`);
    await keep("GET /api/memory/documents/{paperId}/filing", "a page refused", `/api/memory/documents/${papers.refused}/filing`);
    await keep("GET /api/memory/documents/{paperId}/dependents", "a filed document", `/api/memory/documents/${papers.plain}/dependents`);
    await keep("GET /api/memory/projects/{projectId}/dependents", "a filed project", `/api/memory/projects/${project.id}/dependents`);
    await keep("GET /api/memory/backfill/papers", "a page refused", "/api/memory/backfill/papers");
    await keep("GET /api/memory/health", "a page refused", "/api/memory/health");
    await keep("POST /api/memory/backfill/papers", "a document owed a page", "/api/memory/backfill/papers", { paperIds: [papers.refused] });
    await drain("refiling");

    // A Memory chat: the general scope, which answers from Memory.
    const chat = await keep("POST /api/chat/conversations", "a Memory chat", "/api/chat/conversations", { scope: "general", creation_key: "recorded_memory_chat" });
    const config = await json("/api/config");
    await keep("POST /api/chat/stream", "a Memory chat", "/api/chat/stream", {
      scope: "general", conversation_id: chat.id, prompt: `What does Memory hold on [[${concept.slug}]]?`,
      model: config.defaultModel, reasoning_effort: config.defaultReasoningEffort,
    });
    await keep("GET /api/chat", "a Memory chat", `/api/chat?scope=general&conversation_id=${chat.id}`);
    await keep("GET /api/chat/conversations", "Memory chats", "/api/chat/conversations?scope=general");
    // The same lists beside a document, which the specs serve in the same shape.
    const beside = { scope: "document", project_id: project.id, paper_id: papers.plain! };
    await keep("POST /api/chat/conversations", "a chat beside a document", "/api/chat/conversations", { ...beside, creation_key: "recorded_document_chat" });
    await keep("GET /api/chat/conversations", "chats beside a document", `/api/chat/conversations?${new URLSearchParams(beside)}`);
    await keep("GET /api/conversations", "with a Memory chat", "/api/conversations");
    await keep("GET /api/dashboard", "with a Memory chat", "/api/dashboard");
    await keep("GET /api/search", "Memory, a document and a chat", "/api/search?q=prefix");
    await keep("POST /api/memory/sessions/release", "a Memory chat", "/api/memory/sessions/release", { conversationId: chat.id });
    await keep("POST /api/memory/sessions/release", "a document", "/api/memory/sessions/release", { paperId: papers.plain, projectId: project.id });
    await keep("POST /api/memory/sessions/release", "every session", "/api/memory/sessions/release");
    await drain("sessions");

    // Domains the reader names, renames, fills and empties; a page written again.
    const named = await keep("POST /api/memory/domains", "a new domain", "/api/memory/domains", { title: "Reading list", position: -1 });
    await keep("PATCH /api/memory/domains/{slug}", "a rename", `/api/memory/domains/${named.slug}`, { title: "Reading list, revised" });
    await keep("POST /api/memory/pages/move", "one page", "/api/memory/pages/move", { slugs: [concept.slug], domain: named.slug });
    const scratchDomain = await (await call("POST", "/api/memory/domains", { title: "Scratch", position: -2 })).json() as { slug: string };
    await keep("DELETE /api/memory/domains/{slug}", "an empty domain", `/api/memory/domains/${scratchDomain.slug}`);
    await keep("POST /api/memory/pages/{slug}/rewrite", "with a note", `/api/memory/pages/${concept.slug}/rewrite`, { note: "Say how the timing was measured." });
    await keep("GET /api/memory/maintenance", "a rewrite queued", "/api/memory/maintenance");
    await drain("domains and a rewrite");
    await keep("GET /api/memory/pages/{slug}", "a domain page", `/api/memory/pages/${(await pageOf("domain")).slug}`);
    await keep("GET /api/memory/pages/{slug}", "a moved and rewritten page", `/api/memory/pages/${concept.slug}`);

    // A document deleted with its page kept, then added again: its filing waits to ask.
    await upload("deleted", "Kept page study");
    await drain("a document to delete");
    assert.equal((await call("DELETE", `/api/projects/${project.id}/papers/${papers.deleted}`)).status, 204);
    await upload("again", "Kept page study");
    await drain("a document like a deleted one");
    const waiting = await keep("GET /api/memory/documents/{paperId}/filing", "waiting to ask", `/api/memory/documents/${papers.again}/filing`);
    assert.ok(waiting.sameAs, `the document added again was not asked about: ${JSON.stringify(waiting)}`);
    await keep("POST /api/memory/documents/{paperId}/same-as", "use that page", `/api/memory/documents/${papers.again}/same-as`, { use: true });
    await drain("a document answered");

    await keep("POST /api/memory/lint", "a check", "/api/memory/lint");
    await keep("GET /api/memory/health", "after a check", "/api/memory/health");
    await keep("POST /api/memory/reorganize/stream", "a placement review", "/api/memory/reorganize/stream");

    // Last, a document whose filing stalls, so a job gives up. Any later
    // filing would stall too: the scripted provider stalls every filing whose
    // request names this document, and Memory's index names it from now on.
    await upload("stalled", "Stalled Selection Study one");
    await drain("a filing that gives up");
    await keep("GET /api/memory/documents/{paperId}/filing", "gave up", `/api/memory/documents/${papers.stalled}/filing`);
    await keep("GET /api/memory/backfill/papers", "a filing gave up", "/api/memory/backfill/papers");
    await keep("GET /api/memory/health", "a filing gave up", "/api/memory/health");
    const queue = await keep("GET /api/memory/maintenance", "a job gave up", "/api/memory/maintenance");
    const stuck = (queue.jobs as Array<{ id: string; status: string }>).find(job => job.status === "failed");
    assert.ok(stuck, `no job gave up: ${JSON.stringify(queue)}`);
    await keep("POST /api/memory/maintenance/jobs/{jobId}/retry", "a job that gave up", `/api/memory/maintenance/jobs/${stuck.id}/retry`);
    await keep("GET /api/memory/maintenance", "a job retried", "/api/memory/maintenance");
    await keep("POST /api/memory/maintenance/cancel", "a job waiting", "/api/memory/maintenance/cancel");
    await keep("POST /api/memory/backfill/papers", "every document", "/api/memory/backfill/papers");
    await keep("GET /api/memory", "at the end", "/api/memory");
    await keep("GET /api/memory/pages", "at the end", "/api/memory/pages");
    await keep("GET /api/memory/domains", "at the end", "/api/memory/domains");

    // How a check and a placement review end when the model cannot be reached.
    await stop(fixtureModel.child);
    await keep("POST /api/memory/lint", "the model unreachable", "/api/memory/lint");
    await keep("POST /api/memory/reorganize/stream", "the model unreachable", "/api/memory/reorganize/stream");
  } catch (error) {
    console.error(`backend log:\n${backend.log().slice(-4000)}\nprovider log:\n${fixtureModel.log().slice(-2000)}`);
    throw error;
  } finally {
    await Promise.all([stop(backend.child), stop(fixtureModel.child)]);
    rmSync(scratch, { recursive: true, force: true });
  }
  if (process.env.RECORD_RAW) writeFileSync(process.env.RECORD_RAW, `${JSON.stringify(routes, null, 2)}\n`);
  const recording = { backend: version, routes: stable(routes, scratch) };
  writeFileSync(output, `${JSON.stringify(recording, null, 2)}\n`);
  console.log(`Recorded ${Object.values(routes).flat().length} answers from ${Object.keys(routes).length} routes of backend ${version} into ${output}`);
}

/** Numbers that measure the run rather than the answer: durations and clock readings. */
const TIMING = /^(ms|at|elapsedMs|durationMs|totalDurationMs|startedAt|endedAt)$/;

/**
 * The same answers with every value that differs between runs made constant:
 * hex ids and hashes become the same length of hex, numbered in order of first
 * appearance, wherever they stand inside a string; times become one time, and
 * timings zero.
 */
function stable(routes: Record<string, Sample[]>, scratch: string): Record<string, Sample[]> {
  const numbered = new Map<string, string>();
  const hex = (value: string) => {
    let stand = numbered.get(value);
    if (!stand) numbered.set(value, stand = String(numbered.size + 1).padStart(value.length, "0").replace(/^0/, "f"));
    return stand;
  };
  const text = (value: string) => value
    .replaceAll(scratch, "/tmp/recorded")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g, "2000-01-01T00:00:00Z")
    .replace(/(?<![0-9a-f])[0-9a-f]{12,64}(?![0-9a-f])/g, hex);
  const walk = (value: unknown): unknown => typeof value === "string" ? text(value)
    : Array.isArray(value) ? value.map(walk)
    // Keys sorted: some objects are assembled in no fixed order.
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [text(key), TIMING.test(key) && typeof entry === "number" ? 0 : walk(entry)]))
    : value;
  return walk(routes) as Record<string, Sample[]>;
}

await record();
