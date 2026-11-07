/** A full stack for Health's workflows: the pinned Python runtime behind the
 * real host, with a model provider that is up but refuses every call, so
 * filing fails, retries and gives up exactly as it does over a rate limit, or,
 * with `status: 401`, over a key the provider no longer takes. */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKEND_APP, backendEnv, PARENT_WATCH } from "../../main/backend.ts";
import { freePort, API_HOST, UI_HOST } from "../../main/ports.ts";
import { startWorkerHost } from "../../main/worker-host.ts";
import { samplePdf } from "./pdf.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = process.env.DELPHI_TEST_PYTHON || join(root, ".delphi-build/python/bin/python3");
const dist = process.env.DELPHI_TEST_DIST || join(root, ".delphi-build/dist");

export type HealthWorkspace = Awaited<ReturnType<typeof healthWorkspace>>;

export async function healthWorkspace(options: { maxAttempts?: number; status?: 401 | 429 } = {}) {
  if (!existsSync(python) || !existsSync(join(dist, "server/index.js"))) throw new Error("Run npm run build before Health workflow tests.");
  const calls: string[] = [];
  const provider = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    request.resume();
    request.on("end", () => {
      const refused = options.status === 401
        ? { message: "Incorrect API key provided", code: "invalid_api_key" }
        : { message: "Rate limit reached for tokens per min", code: "rate_limit_exceeded" };
      response.writeHead(options.status ?? 429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: refused }));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, API_HOST, resolve));
  const dataDir = mkdtempSync(join(tmpdir(), "delphi-health-workflow-"));
  const [apiPort, uiPort] = [await freePort(API_HOST), await freePort(UI_HOST)];
  const origin = `http://${UI_HOST}:${uiPort}`;
  const env = {
    ...backendEnv({
      python, dataDir, logsDir: dataDir, apiHost: API_HOST, apiPort, uiOrigin: origin,
      sessionSecret: "health-workflow-".padEnd(64, "x"), apiKey: "sk-health-workflow",
      apiBaseUrl: `http://${API_HOST}:${(provider.address() as { port: number }).port}/v1`,
    }),
    ...(options.maxAttempts ? { MEMORY_JOB_MAX_ATTEMPTS: String(options.maxAttempts) } : {}),
  };
  // stdin is the parent-death signal: a killed test worker takes the backend with it.
  const backend = spawn(python, ["-I", "-c", PARENT_WATCH, BACKEND_APP, "--host", API_HOST, "--port", String(apiPort), "--timeout-graceful-shutdown", "2"],
    { env, cwd: dataDir, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  backend.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
  let host: Awaited<ReturnType<typeof startWorkerHost>> | undefined;
  let closed: Promise<void> | undefined;
  const close = () => closed ??= (async () => {
    host?.close();
    provider.close();
    if (backend.exitCode === null && backend.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => backend.kill("SIGKILL"), 3000);
        backend.once("exit", () => { clearTimeout(timer); resolve(); });
        backend.kill("SIGTERM");
      });
    }
    rmSync(dataDir, { recursive: true, force: true });
  })();
  let cookie: string;
  try {
    for (const deadline = Date.now() + 60_000; ;) {
      try { if ((await fetch(`http://${API_HOST}:${apiPort}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`backend never became healthy:\n${stderr.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    host = await startWorkerHost({ distDir: dist, backendUrl: `http://${API_HOST}:${apiPort}`, uiHost: UI_HOST, uiPort });
    const registered = await fetch(`${origin}/api/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "reader", password: "p".repeat(40) }),
    });
    const session = registered.headers.getSetCookie().find((value) => value.startsWith("delphi_session="));
    if (!registered.ok || !session) throw new Error(`register failed: ${registered.status}`);
    cookie = session.split(";")[0]!;
  } catch (error) {
    await close();
    throw error;
  }
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, { ...init, headers: { cookie, ...init.headers } });

  return {
    origin, cookie, calls, close, logs: () => stderr,
    async project(name: string): Promise<string> {
      const response = await api("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      return ((await response.json()) as { id: string }).id;
    },
    /** Imported as a reader imports one, which queues its filing. */
    async addPaper(projectId: string, title: string): Promise<string> {
      const form = new FormData();
      form.append("file", new Blob([samplePdf()], { type: "application/pdf" }), `${title}.pdf`);
      const response = await api(`/api/projects/${projectId}/papers`, { method: "POST", body: form });
      if (!response.ok) throw new Error(`upload failed: ${response.status}`);
      return ((await response.json()) as { id: string }).id;
    },
    async queue() {
      return (await (await api("/api/memory/maintenance")).json()) as {
        cancellable: number;
        jobs: Array<{ id: string; status: string; retryAt: string | null; attempts: number }>;
      };
    },
  };
}
