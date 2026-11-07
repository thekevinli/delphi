/**
 * Serve Delphi's own build output from Node, with no Cloudflare runtime.
 *
 * `frontend/dist/server/index.js` is the locally owned frontend bundle.
 * Electron hosts it with ordinary Node APIs.
 *
 * Two behaviours here are not obvious and are the ones to preserve:
 *   1. Assets are served *before* the Worker (see `handle`).
 *   2. Bodies are piped in both directions, never buffered (see `send`).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createAssets, type AssetsBinding } from "./assets.ts";

interface WorkerModule {
  fetch(
    request: Request,
    env: { ASSETS: AssetsBinding; BACKEND_URL: string },
    ctx: { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void },
  ): Promise<Response>;
}

/**
 * Work in flight through the backend: every request that can change state or
 * spend a model call, from arrival rather than from its first byte, since an
 * answer prepares its context before it responds at all. `paused` turns new
 * work away while the backend is being replaced.
 */
export interface HostActivity {
  inflight: Map<number, { path: string }>;
  paused: boolean;
}

export interface HostOptions {
  /** The built frontend: the directory containing `client/` and `server/`. */
  distDir: string;
  /** Where FastAPI listens, e.g. `http://127.0.0.1:8712`. */
  backendUrl: string;
  uiHost: string;
  uiPort: number;
  desktopHandler?: (request: Request) => Promise<Response | undefined>;
  activity?: HostActivity;
}

/**
 * Headers a proxy must not forward.
 *
 * The first eight are hop-by-hop per RFC 7230: they describe *this* connection
 * rather than the message. `host` has to be recomputed for the new target.
 * `expect` is here for a sharper reason — a client that sends
 * `Expect: 100-continue` on a large body (curl does) makes undici's `fetch`
 * throw `NotSupportedError: expect header not supported`, turning every big
 * upload into a 500. Delphi accepts a 60 MB PDF before compression, so this is
 * not a corner case.
 */
const HOP_BY_HOP = new Set([
  "connection", "expect", "host", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);

function toRequest(req: IncomingMessage, origin: string, signal: AbortSignal): Request {
  const headers = new Headers();
  // `Connection: x, y` names further headers that are hop-by-hop for this
  // connection only.
  const named = new Set(
    String(req.headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    if (HOP_BY_HOP.has(name) || named.has(name)) continue;
    // Node splits repeated headers into separate pairs; append preserves them.
    headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(new URL(req.url ?? "/", origin), {
    method: req.method,
    signal,
    headers,
    // Streamed, not buffered: an upload is 60 MB before compression.
    // `duplex: "half"` is required by undici and ignored elsewhere.
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    ...(hasBody ? { duplex: "half" } : {}),
    redirect: "manual",
  } as RequestInit);
}

export async function send(res: ServerResponse, response: Response): Promise<void> {
  // The reader may have left while the response was on its way. `pipeline`
  // then refuses before it guards its source, which would keep the body's
  // reader with no 'error' listener: when the backend's connection later ends
  // early, that body's "terminated" becomes an uncaught exception in the main
  // process. Nobody will read it, so let it go here.
  if (res.destroyed || res.writableEnded) {
    await response.body?.cancel().catch(() => {});
    return;
  }
  const headers: Record<string, string | string[]> = {};
  const named = new Set((response.headers.get("connection") ?? "").split(",").map(name => name.trim().toLowerCase()));
  for (const [key, value] of response.headers) {
    if (HOP_BY_HOP.has(key.toLowerCase()) || named.has(key.toLowerCase())) continue;
    // set-cookie must stay an array, or several cookies collapse into one.
    if (key.toLowerCase() === "set-cookie") continue;
    headers[key] = value;
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length && !named.has("set-cookie")) headers["set-cookie"] = cookies;

  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  // Piped, never buffered. Delphi's SSE routes stream for up to fifteen
  // minutes and the client parses frames as they arrive; buffering would look
  // correct on every short request and fail only on a real chat answer.
  await pipeline(Readable.fromWeb(response.body as never), res);
}

export async function startWorkerHost(options: HostOptions): Promise<Server> {
  const { distDir, backendUrl, uiHost, uiPort } = options;

  const entry = pathToFileURL(join(distDir, "server", "index.js")).href;
  const worker = ((await import(entry)) as { default: WorkerModule }).default;
  const ASSETS = createAssets(distDir);
  const env = { ASSETS, BACKEND_URL: backendUrl };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const origin = `http://${uiHost}:${uiPort}`;
  let requestNumber = 0;

  const server = createServer(async (req, res) => {
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    req.once("aborted", abort);
    const disconnected = () => { if (!res.writableFinished) abort(); };
    res.once("close", disconnected);
    const activity = options.activity;
    let tracked = 0;
    try {
      const request = toRequest(req, origin, cancellation.signal);
      const path = new URL(request.url).pathname;
      // Every write, including the ones the shell answers itself (a chat turn
      // goes through its plan adapter), except the request that asks to switch.
      tracked = activity && req.method !== "GET" && req.method !== "HEAD" && path !== "/desktop/connection" ? ++requestNumber : 0;
      if (tracked && activity!.paused) {
        req.resume();
        return await send(res, new Response(JSON.stringify({ detail: "Delphi is switching its AI connection. Try again in a moment." }),
          { status: 503, headers: { "content-type": "application/json", "retry-after": "5", "cache-control": "no-store" } }));
      }
      if (tracked) activity!.inflight.set(tracked, { path });
      const desktop = await options.desktopHandler?.(request);
      if (desktop) return await send(res, desktop);

      /*
       * Static assets are served *before* the Worker, because that is what
       * Cloudflare does: the `assets.directory` binding intercepts a matching
       * path and the Worker never sees it. Calling the Worker first is not a
       * small difference — `/assets/index-abc.js` is two segments, so the
       * reader's `[project]/[paper]` route swallows it and answers with the app
       * shell as `text/html`; the page then dies on "Failed to fetch
       * dynamically imported module". The application's own routing notes record the
       * same rule from the other side: public files are matched before routes,
       * which is the only reason two-segment asset paths resolve at all.
       *
       * Only a file that exists short-circuits, so real routes still render.
       */
      if (req.method === "GET" || req.method === "HEAD") {
        const asset = await ASSETS.fetch(request);
        if (asset.status === 200) return await send(res, asset);
      }

      await send(res, await worker.fetch(request, env, ctx));
    } catch (error) {
      console.error(`${req.method} ${req.url} ->`, error);
      /*
       * Drain before answering. If the failure happened while the client was
       * still uploading, replying without consuming the body leaves it writing
       * into a socket nobody reads: the request does not fail, it *wedges* —
       * which is far worse to diagnose than a 500, and is how a proxy bug turns
       * into "the app hangs on large files".
       */
      req.resume();
      if (res.headersSent || res.destroyed) res.destroy();
      else {
        res.writeHead(500, { "content-type": "text/plain", "cache-control": "no-store" });
        res.end("Delphi host error");
      }
    } finally {
      if (tracked) activity!.inflight.delete(tracked);
      req.removeListener("aborted", abort);
      res.removeListener("close", disconnected);
    }
  });

  // No timeouts: a chat answer legitimately streams for fifteen minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(uiPort, uiHost, () => { server.removeListener("error", reject); resolve(); });
  });
  return server;
}
