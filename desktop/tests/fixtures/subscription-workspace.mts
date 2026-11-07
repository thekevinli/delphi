/** Isolated full-stack workspace: real host, bridges, switching controller and
 * pinned Python runtime. Only the external model services are fixtures. */
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBackend } from "../../main/backend.ts";
import { readProfile, writeProfile, type StoredConfig } from "../../main/profile.ts";
import { AiServiceController } from "../../main/inference/service.ts";
import { desktopConnectionHandler } from "../../main/inference/connection-handler.ts";
import { startInferenceBridge, type Upstream } from "../../main/inference/bridge.ts";
import { SubscriptionLimits } from "../../main/inference/limits.ts";
import { ClaudeTransport } from "../../main/inference/claude-transport.ts";
import { chatPlansHandler } from "../../main/research/chat-plans.ts";
import { LocalPlans } from "../../main/research/plans.ts";
import { PlanStore } from "../../main/research/store.ts";
import { startWorkerHost, type HostActivity } from "../../main/worker-host.ts";
import { freePort, API_HOST, UI_HOST } from "../../main/ports.ts";
import { fixtureClaude } from "./claude-runtime.mts";
import type { ConnectionId } from "../../frontend/app/lib/ai-connection.ts";
const root = fileURLToPath(new URL("../../", import.meta.url));
export const workspaceReady = existsSync(join(root, ".delphi-build/python/bin/python3")) && existsSync(join(root, ".delphi-build/dist/server/index.js"));
export async function subscriptionWorkspace(options: { memoryPages?: number } = {}) {
  if (!workspaceReady) throw new Error("Run npm run build before subscription workflow tests.");
  const dir = mkdtempSync(join(tmpdir(), "delphi-switch-workflow-"));
  mkdirSync(join(dir, "data"));
  const python = join(root, ".delphi-build/python/bin/python3");
  const profile = join(dir, "config.json");
  const original: StoredConfig = { version: 2, connectionId: "chatgpt-oauth", username: "workflow", apiKey: "c2F2ZWQ=", sessionSecret: "c2Vzc2lvbg==", accountPassword: "cGFzc3dvcmQ=" };
  writeProfile(profile, original);
  const claude = fixtureClaude({ mode: "roundtrip", tool: { name: "open_memory", arguments: { slugs: ["attention"] } }, structured: { slugs: [] } });
  const [apiPort, uiPort] = [await freePort(API_HOST), await freePort(UI_HOST)];
  const origin = `http://${UI_HOST}:${uiPort}`, apiUrl = `http://${API_HOST}:${apiPort}`;
  const activity: HostActivity = { paused: false, inflight: new Map() };
  const bridgeLogs: any[] = [];
  const asked: any[] = [], managed: ConnectionId[] = [];
  let reload = () => {}, rejectStart = false;
  let holdChat = false;
  const upstream: Upstream = { async responses(body, signal) {
    const p = body as any; asked.push(p);
    const output: any[] = [];
    const results = p.input.filter((i: any) => i.type === "function_call_output");
    if (p.tools?.some((t: any) => t.name === "open_memory") && !results.length) output.push({ id: "fc_workflow", type: "function_call", call_id: "call_workflow", name: "open_memory", arguments: JSON.stringify({ slugs: ["attention"] }) });
    else {
      const text = p.text?.format ? JSON.stringify({ slugs: [] }) : results.length ? "ChatGPT read Memory: " + results.map((i: any) => i.output).join(" ") : "Subscription workflow";
      output.push({ id: "msg_workflow", type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
    }
    const events = output.flatMap((item: any, output_index: number) => [ ...(item.type === "message" ? [{ type: "response.output_text.delta", delta: item.content[0].text }] : []), { type: "response.output_item.done", output_index, item } ]);
    events.push({ type: "response.completed", response: { id: "resp_workflow", status: "completed", output, usage: { input_tokens: 20, output_tokens: 10 } } } as any);
    if (holdChat) {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"Working…"}\n\n'));
        signal?.addEventListener("abort", () => controller.close(), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } };
  const controller = new AiServiceController({ activity, save: config => writeProfile(profile, config), changed: () => reload(), start: async (config, apiKey) => {
    if (rejectStart && config.connectionId === "claude-subscription") throw new Error("fixture startup unavailable");
    const onClaude = config.connectionId === "claude-subscription";
    const bridge = await startInferenceBridge({ upstream: onClaude ? new ClaudeTransport(claude.connection) : upstream, limits: onClaude ? claude.connection.limits : new SubscriptionLimits(), provider: onClaude ? "Claude" : "ChatGPT", prime: false, log: entry => bridgeLogs.push(entry) });
    try {
      const backend = await startBackend({ python, dataDir: join(dir, "data"), logsDir: dir, apiHost: API_HOST, apiPort, uiOrigin: origin, sessionSecret: "workflow-session-secret".padEnd(64, "x"), apiKey,
        connection: config.connectionId, inference: { url: bridge.url, token: bridge.token } });
      return { backend, bridge };
    } catch (error) { await bridge.stop(); throw error; }
  } });
  const planStore = new PlanStore(join(dir, "plans-store"));
  const plans = new LocalPlans(planStore, join(dir, "plans"), await freePort(API_HOST));
  let host: Awaited<ReturnType<typeof startWorkerHost>> | undefined;
  try {
    await controller.start(original, "");
    const authenticate = async (request: Request) => {
      const response = await fetch(apiUrl + "/api/auth/me", { headers: { cookie: request.headers.get("cookie") ?? "" } });
      await response.body?.cancel(); return response.ok;
    };
    const handler = desktopConnectionHandler({ origin, authenticate, read: () => readProfile(profile)!, busy: () => controller.busy(),
      statuses: async () => ({ chatgpt: { connected: true, signingIn: false }, claude: await claude.connection.status() }),
      manage: to => { if (to) managed.push(to); },
      change: async to => {
        const busy = controller.busy(); if (busy) throw new Error(busy);
        if (to === "claude-subscription") { const status = await claude.connection.status(); if (!status.connected) throw Object.assign(new Error(status.message ?? "Sign in first"), { setup: true }); }
        await controller.change({ ...readProfile(profile)!, connectionId: to }, "");
      } });
    const chat = chatPlansHandler({ plans, python, backendUrl: apiUrl, origin, authenticate, installation: async () => "Fixture installation" });
    host = await startWorkerHost({ distDir: join(root, ".delphi-build/dist"), backendUrl: apiUrl, uiHost: UI_HOST, uiPort, activity, desktopHandler: async request => await handler(request) ?? await chat(request) });
    const registered = await fetch(origin + "/api/auth/register", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username: "workflow", password: "p".repeat(40) }) });
    if (!registered.ok) throw new Error(await registered.text());
    const cookie = (registered.headers.get("set-cookie") ?? "").split(";")[0];
    const seed = `from delphi_core.config import Settings
from delphi_core.storage import LocalStorage
s=LocalStorage(Settings(_env_file=None,data_dir=${JSON.stringify(join(dir, "data"))}))
s.upsert_memory_page("workflow",dict(kind="concept",slug="attention",title="Attention",domain="ml",summary="Workflow evidence",body="## Attention\\n\\nWORKFLOW-RECEIPT-37",citations=[]),max_pages=50)
for i in range(1, ${options.memoryPages ?? 1}):
 s.upsert_memory_page("workflow",dict(kind="concept",slug="related-"+str(i),title="Related "+str(i),domain="ml",summary="Related evidence",body="A related concept.",citations=[]),max_pages=50)
`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(python, ["-I", "-c", seed], { stdio: ["ignore", "ignore", "pipe"] });
      let error = ""; child.stderr.on("data", b => { error += b; }); child.once("error", reject); child.once("close", code => code ? reject(new Error(error)) : resolve());
    });
    const request = (path: string, body?: unknown, options: RequestInit = {}) => fetch(origin + path, { method: body === undefined ? "GET" : "POST", ...options,
      headers: { cookie, origin, "content-type": "application/json", ...options.headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { origin, cookie, controller, claude, asked, bridgeLogs, managed, activity, dir, original, profile: () => readProfile(profile)!, request,
      onReload: (fn: () => void) => { reload = fn; }, failStart: (value: boolean) => { rejectStart = value; }, holdChat: (value: boolean) => { holdChat = value; },
      async close() { await controller.stop(); plans.close(); planStore.close(); host?.closeAllConnections(); await new Promise<void>(resolve => host!.close(() => resolve())); await claude.connection.cancel(); claude.remove(); rmSync(dir, { recursive: true, force: true }); } };
  } catch (error) { await controller.stop(); plans.close(); planStore.close(); host?.closeAllConnections(); host?.close(); claude.remove(); rmSync(dir, { recursive: true, force: true }); throw error; }
}
