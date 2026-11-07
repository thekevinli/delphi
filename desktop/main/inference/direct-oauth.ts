import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

// The public native client and callback contract used by Codex. Delphi
// exchanges only OAuth tokens; it never requests an API-key token exchange.
export const CHATGPT_OAUTH = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorize: "https://auth.openai.com/oauth/authorize",
  token: "https://auth.openai.com/oauth/token",
  responses: "https://chatgpt.com/backend-api/codex/responses",
  // The catalog filters model visibility by client version. Keep this pin at
  // a version that exposes Delphi's selected models; an older catalog hid the
  // GPT-6 pair even though the same account could use them.
  models: "https://chatgpt.com/backend-api/codex/models?client_version=0.159.3",
  // What Codex's /status reads: the plan's windows as of now, without a turn.
  usage: "https://chatgpt.com/backend-api/wham/usage",
};

const USER_AGENT = "Delphi-macOS";

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number;
}
export interface CredentialStore {
  read(): OAuthCredentials | undefined;
  write(value: OAuthCredentials): void;
  clear(): void;
}

export function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: randomBytes(32).toString("hex") };
}

function claims(token: unknown): Record<string, any> {
  if (typeof token !== "string") return {};
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
  catch { return {}; }
}

export function credentialsFromResponse(body: any, prior?: OAuthCredentials): OAuthCredentials {
  if (typeof body.access_token !== "string" || !body.access_token) throw new Error("Sign-in returned no access token.");
  const access = claims(body.access_token);
  const identity = claims(body.id_token);
  const accountId = identity["https://api.openai.com/auth"]?.chatgpt_account_id ??
    access["https://api.openai.com/auth"]?.chatgpt_account_id ?? prior?.accountId;
  const refreshToken = body.refresh_token ?? prior?.refreshToken;
  if (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(accountId) || typeof refreshToken !== "string" || !refreshToken) {
    throw new Error("Sign-in returned incomplete subscription credentials.");
  }
  if (prior && prior.accountId !== accountId) throw new Error("The subscription account changed. Sign in again.");
  const expiresAt = typeof access.exp === "number" ? access.exp * 1000 :
    Date.now() + (typeof body.expires_in === "number" ? body.expires_in * 1000 : 30 * 60_000);
  return { accessToken: body.access_token, refreshToken, accountId, expiresAt };
}

export class DirectOAuth {
  private store: CredentialStore;
  private refreshTask?: Promise<OAuthCredentials>;
  private cancelLogin?: () => void;
  private epoch = 0;
  constructor(store: CredentialStore) { this.store = store; }

  async startLogin(openBrowser: (url: string) => Promise<void>): Promise<{ completion: Promise<void>; cancel: () => void }> {
    if (this.cancelLogin) throw new Error("A sign-in is already in progress.");
    const codes = pkce();
    const epoch = ++this.epoch;
    let server!: Server;
    let port = 1455;
    let settling = false;
    let finished = false;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void completion.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); this.cancelLogin = undefined;
      server?.close(); server?.closeIdleConnections();
      if (error) reject(error); else resolve();
    };
    const cancel = () => { settling = true; finish(new Error("Sign-in cancelled.")); };
    this.cancelLogin = cancel;
    server = createServer((request, response) => {
      request.resume();
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
      response.setHeader("referrer-policy", "no-referrer");
      let url: URL;
      try { url = new URL(request.url ?? "/", `http://localhost:${port}`); }
      catch { response.writeHead(400); response.end("Invalid sign-in callback."); return; }
      const state = Buffer.from(url.searchParams.get("state") ?? "");
      const expected = Buffer.from(codes.state);
      if (request.method !== "GET" || request.headers.host !== `localhost:${port}` || url.pathname !== "/auth/callback" ||
        settling || state.length !== expected.length || !timingSafeEqual(state, expected)) {
        response.writeHead(400); response.end("Invalid sign-in callback."); return;
      }
      settling = true;
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.has("error")) {
        response.writeHead(400); response.end("Sign-in did not complete. Return to Delphi and retry.");
        finish(new Error("ChatGPT sign-in was declined or did not complete.")); return;
      }
      void (async () => {
        try {
          const result = await fetch(CHATGPT_OAUTH.token, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "authorization_code", client_id: CHATGPT_OAUTH.clientId,
              code, redirect_uri: `http://localhost:${port}/auth/callback`, code_verifier: codes.verifier }) });
          if (!result.ok) throw new Error("ChatGPT could not complete sign-in. Please retry.");
          const credentials = credentialsFromResponse(await result.json());
          if (!this.cancelLogin || epoch !== this.epoch) throw new Error("Sign-in was cancelled.");
          this.store.write(credentials);
          response.end("Signed in to Delphi with ChatGPT. You can close this tab and return to Delphi.");
          finish();
        } catch {
          response.writeHead(400); response.end("Sign-in could not be saved. Return to Delphi and retry.");
          finish(new Error("Sign-in failed or credentials could not be stored securely."));
        }
      })();
    });
    try {
      // Both ports are in Codex's native redirect allow-list. Never cancel an
      // unrelated program's login just to acquire its preferred callback port.
      for (const candidate of [1455, 1457]) {
        port = candidate;
        try {
          await new Promise<void>((yes, no) => {
            const failed = (error: Error) => { server.removeListener("listening", listening); no(error); };
            const listening = () => { server.removeListener("error", failed); yes(); };
            server.once("error", failed); server.once("listening", listening); server.listen(port, "127.0.0.1");
          });
          break;
        } catch (error) { if (candidate === 1457 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; }
      }
      timer = setTimeout(() => { settling = true; finish(new Error("Sign-in timed out.")); }, 5 * 60_000);
      const url = new URL(CHATGPT_OAUTH.authorize);
      url.search = new URLSearchParams({ response_type: "code", client_id: CHATGPT_OAUTH.clientId,
        redirect_uri: `http://localhost:${port}/auth/callback`, scope: "openid profile email offline_access",
        code_challenge: codes.challenge, code_challenge_method: "S256", state: codes.state,
        id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "delphi" }).toString();
      await openBrowser(url.href);
      return { completion, cancel };
    } catch { finish(new Error("Could not open the local sign-in callback. Close other sign-in attempts and retry.")); return { completion, cancel }; }
  }

  async credentials(forceRefresh = false): Promise<OAuthCredentials> {
    const prior = this.store.read();
    const epoch = this.epoch;
    if (!prior) throw new Error("Sign in with ChatGPT first.");
    if (!forceRefresh && prior.expiresAt > Date.now() + 60_000) return prior;
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = (async () => {
      const response = await fetch(CHATGPT_OAUTH.token, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", client_id: CHATGPT_OAUTH.clientId, refresh_token: prior.refreshToken }) });
      if (!response.ok) throw new Error("ChatGPT sign-in could not be refreshed. Reconnect in AI Connection.");
      const next = credentialsFromResponse(await response.json(), prior);
      if (epoch !== this.epoch) throw new Error("The sign-in changed while refreshing. Retry the request.");
      this.store.write(next); return next;
    })();
    try { return await this.refreshTask; } finally { this.refreshTask = undefined; }
  }

  async responses(payload: unknown, signal?: AbortSignal, headers: Record<string, string> = {}): Promise<Response> {
    return this.request("responses", payload, signal, headers);
  }

  async models(): Promise<Response> { return this.request("models", undefined, AbortSignal.timeout(30_000)); }

  async usage(): Promise<Response> { return this.request("usage", undefined, AbortSignal.timeout(5_000)); }

  private async request(endpoint: "responses" | "models" | "usage", payload: unknown, signal?: AbortSignal, extra: Record<string, string> = {}): Promise<Response> {
    let credentials = await this.credentials();
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const send = () => fetch(CHATGPT_OAUTH[endpoint], { method: endpoint === "responses" ? "POST" : "GET", redirect: "error", signal,
      headers: { ...extra, authorization: `Bearer ${credentials.accessToken}`, "chatgpt-account-id": credentials.accountId,
        "content-type": "application/json", accept: endpoint === "usage" ? "application/json" : "text/event-stream", originator: "delphi", "user-agent": USER_AGENT },
      body });
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel();
      const current = this.store.read();
      credentials = await this.credentials(current?.accessToken === credentials.accessToken);
      response = await send();
    }
    return response;
  }

  logout(): void { this.epoch++; this.cancelLogin?.(); this.store.clear(); }
}
