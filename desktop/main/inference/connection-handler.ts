/** Authenticated desktop settings route. Credential entry remains in the
 * trusted setup window; this route accepts only an enabled connection ID. */
import { isConnectionId, type ConnectionId } from "../../frontend/app/lib/ai-connection.ts";
import type { StoredConfig } from "../profile.ts";
import type { ConnectionStatus } from "./connection.ts";
export function desktopConnectionHandler(options: {
  origin: string;
  authenticate(request: Request): Promise<boolean>;
  read(): StoredConfig;
  statuses(): Promise<{ chatgpt: ConnectionStatus; claude: ConnectionStatus }>;
  busy(): string | undefined;
  change(to: ConnectionId): Promise<void>;
  manage(to?: ConnectionId): void;
}) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/desktop/connection") return;
    if (url.origin !== options.origin || !await options.authenticate(request)) return new Response("Sign in through Delphi", { status: 401 });
    if (request.method === "GET") {
      const stored = options.read();
      // Which provider keys are saved, never a key.
      const basics = { connection: stored.connectionId ?? "openai-api", keys: { openai: Boolean(stored.apiKey), claude: Boolean(stored.claudeApiKey) } };
      // `?quick` answers at once from the profile; the plans' statuses ask
      // Claude Code and ChatGPT for usage, which takes seconds.
      if (url.searchParams.has("quick")) return json(basics);
      return json({ ...basics, ...await options.statuses(), busy: options.busy() });
    }
    if (request.method !== "POST" || request.headers.get("origin") !== options.origin) return json({ ok: false, message: "Unsupported request." }, 405);
    let body: Record<string, unknown>;
    try {
      body = await request.json() as typeof body;
      if (!body || Array.isArray(body) || Object.keys(body).some(k => !["action", "to"].includes(k))) throw new Error();
    } catch { return json({ ok: false, message: "Invalid connection request." }, 400); }
    if (body.to !== undefined && !isConnectionId(body.to)) return json({ ok: false, message: "Unknown connection." }, 400);
    const target = body.to as ConnectionId | undefined;
    if (body.action === "manage") { options.manage(target); return json({ ok: true }); }
    if (body.action !== "switch" || !target) return json({ ok: false, message: "Unknown connection action." }, 400);
    try { await options.change(target); return json({ ok: true }); }
    catch (error) {
      const setup = Boolean((error as { setup?: boolean }).setup);
      if (setup) options.manage(target);
      return json({ ok: false, setup, message: (error as Error).message }, setup ? 200 : 409);
    }
  };
}
