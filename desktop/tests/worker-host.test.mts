/**
 * The contract with delphi's build output.
 *
 * Every assertion here is a property the desktop app depends on and that
 * nothing in delphi's own suite covers, because on Cloudflare the platform
 * provides it. `vinext` is pinned at 0.0.50 and describes itself as
 * experimental, so this file is what tells us at frontend-upgrade time that its
 * output has stopped being something plain Node can serve.
 *
 * Requires a build: `bash build/frontend.sh`.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createHash } from "node:crypto";

import { send, startWorkerHost } from "../main/worker-host.ts";
import { assertHostSplit, freePort } from "../main/ports.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, ".delphi-build", "dist");
const built = existsSync(join(DIST, "server", "index.js"));
const needsBuild = { skip: built ? false : "run `bash build/frontend.sh` first" };

let origin = "";
let server: Awaited<ReturnType<typeof startWorkerHost>> | undefined;
/** Stands in for FastAPI, so these tests need no Python and no API key. */
let backend: Awaited<ReturnType<typeof startFakeBackend>> | undefined;

async function startFakeBackend() {
  const { createServer } = await import("node:http");
  const port = await freePort("127.0.0.1");
  /** Every request that reached the backend, as `METHOD /path?query`. */
  const received: string[] = [];
  const s = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith("/api/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const timer = setInterval(() => {
        res.write(`data: {"frame":${n}}\n\n`);
        if (++n === 4) { clearInterval(timer); res.end(); }
      }, 120);
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (req.url?.includes("/saved-page")) {
      // The page copy an annotation sends: refused, as the backend refuses it,
      // the moment it passes the limit rather than once it has all arrived.
      const limit = Number(new URL(req.url, "http://x").searchParams.get("limit") ?? Infinity);
      const hash = createHash("sha256");
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
        hash.update(chunk);
        if (bytes > limit && !res.headersSent) {
          res.writeHead(413, { "content-type": "application/json", connection: "close" });
          res.end(JSON.stringify({ detail: "too large" }));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (res.headersSent) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, url: req.url, type: req.headers["content-type"], bytes, sha256: hash.digest("hex") }));
      });
      return;
    }
    if (req.url?.startsWith("/api/echo")) {
      let bytes = 0;
      req.on("data", (chunk) => { bytes += chunk.length; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ bytes }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => s.listen(port, "127.0.0.1", resolve));
  return { server: s, url: `http://127.0.0.1:${port}`, received };
}

before(async () => {
  if (!built) return;
  backend = await startFakeBackend();
  const uiPort = await freePort("localhost");
  origin = `http://localhost:${uiPort}`;
  server = await startWorkerHost({
    distDir: DIST, backendUrl: backend.url, uiHost: "localhost", uiPort,
  });
});

after(() => { server?.close(); backend?.server.close(); });

test("the built Worker server-renders every route the app has", needsBuild, async () => {
  const titles: Record<string, RegExp> = {
    "/": /Dashboard · Delphi/,
    "/reader": /Delphi/,
    "/memory": /Memory · Delphi/,
    "/memory/graph": /Memory Map · Delphi/,
    "/memory/health": /Memory Health · Delphi/,
    "/@someone/a-project/a-paper": /Delphi/,
  };
  for (const [path, title] of Object.entries(titles)) {
    const response = await fetch(`${origin}${path}`, { headers: { accept: "text/html" } });
    assert.equal(response.status, 200, `${path} did not render`);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
    assert.match(await response.text(), title, `${path} had the wrong title`);
  }
});

test("Memory's address before 0.7.0 redirects to /memory, query and all", needsBuild, async () => {
  const former: Record<string, string> = {
    "/knowledge-base?page=beta-source": "/memory?page=beta-source",
    "/knowledge-base/graph?domain=beta&ask=1": "/memory/graph?domain=beta&ask=1",
    "/knowledge-base/health?ask=1": "/memory/health?ask=1",
    "/knowledge-base/ask?q=what%20is%20held&page=beta-source": "/memory/ask?q=what%20is%20held&page=beta-source",
    "/knowledge-base?ask=1&conversation=c1": "/memory?ask=1&conversation=c1",
    "/knowledge-base.rsc?page=beta-source&_rsc=x1": "/memory.rsc?page=beta-source&_rsc=x1",
    "/knowledge-base/graph.rsc?domain=beta&_rsc=x2": "/memory/graph.rsc?domain=beta&_rsc=x2",
  };
  for (const [from, to] of Object.entries(former)) {
    const response = await fetch(`${origin}${from}`, { redirect: "manual" });
    await response.arrayBuffer();
    assert.equal(response.status, 307, `${from} did not redirect`);
    assert.equal(response.headers.get("location"), to);
  }
  const landed = await fetch(`${origin}/knowledge-base?page=beta-source`, { headers: { accept: "text/html" } });
  assert.equal(landed.status, 200);
  assert.equal(new URL(landed.url).pathname + new URL(landed.url).search, "/memory?page=beta-source");
  assert.match(await landed.text(), /Memory · Delphi/);
  // Only that address: a path that merely starts the same way is the app's to answer.
  const near = await fetch(`${origin}/knowledge-basement`, { redirect: "manual" });
  await near.arrayBuffer();
  assert.equal(near.headers.get("location"), null);
});

test("assets win over routes, and carry a usable content type", needsBuild, async () => {
  /*
   * The regression this exists for: `/assets/index-abc.js` is two segments, so
   * the reader's `[project]/[paper]` route answers it with the app shell as
   * text/html unless assets are served first. The renderer then dies on
   * "Failed to fetch dynamically imported module" and the page is blank.
   */
  const shell = await fetch(`${origin}/`, { headers: { accept: "text/html" } });
  const html = await shell.text();
  const referenced = [...new Set(html.match(/\/assets\/[A-Za-z0-9_.-]+\.js/g) ?? [])];
  assert.ok(referenced.length > 0, "the shell referenced no script at all");

  for (const asset of referenced) {
    const response = await fetch(`${origin}${asset}`);
    assert.equal(response.status, 200, `${asset} did not serve`);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^text\/javascript\b/,
      `${asset} served as the wrong type — a route swallowed it`,
    );
  }

  // pdf.js resolves its worker at a root-absolute path; without it the reader
  // fails silently.
  const worker = await fetch(`${origin}/pdf.worker.min.mjs`);
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get("content-type") ?? "", /^text\/javascript\b/);
});

test("a wrong asset response can never become sticky", needsBuild, async () => {
  // No cache header means Chrome's *heuristic* cache, which is how a briefly
  // wrong response survived the fix that corrected it.
  const asset = await fetch(`${origin}/pdf.worker.min.mjs`);
  assert.ok(asset.headers.get("cache-control"), "assets must state a cache policy");
});

test("SSE arrives incrementally rather than as one buffered blob", needsBuild, async () => {
  const response = await fetch(`${origin}/api/stream`);
  assert.equal(response.status, 200);
  assert.ok(response.body, "no body to stream");

  const arrivals: number[] = [];
  const start = Date.now();
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) arrivals.push(Date.now() - start);
  }
  assert.ok(arrivals.length >= 2, `expected several chunks, saw ${arrivals.length}`);
  // A buffering proxy delivers everything at once; a piping one spreads it out.
  // Delphi's chat answers stream for minutes, so this is the property that
  // matters most and the one a "small refactor" is most likely to break.
  assert.ok(
    arrivals[arrivals.length - 1]! - arrivals[0]! > 100,
    `all chunks landed together (${arrivals.join("ms, ")}ms) — the proxy buffered`,
  );
});

test("a large body survives the proxy, buffered or streamed", needsBuild, async () => {
  const payload = new Uint8Array(8 * 1024 * 1024);

  const buffered = await fetch(`${origin}/api/echo`, { method: "POST", body: payload });
  assert.deepEqual(await buffered.json(), { bytes: payload.byteLength });

  /*
   * `Expect: 100-continue` is what a real uploader sends on a big body (curl
   * does it automatically past ~1 KB). It has to be sent with a raw client,
   * because `fetch` treats `Expect` as a forbidden header name and will not set
   * it — which is precisely why this case was missed until a 60 MB upload
   * returned 500: undici's fetch throws
   * `NotSupportedError: expect header not supported` when asked to *forward*
   * one, so the proxy must strip it as hop-by-hop.
   */
  const { request } = await import("node:http");
  const url = new URL(`${origin}/api/echo`);
  const echoed = await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/octet-stream", expect: "100-continue" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve(body));
      },
    );
    req.on("error", reject);
    req.on("continue", () => req.end(payload));
    // If the server never sends 100-continue, send anyway rather than hang.
    setTimeout(() => { if (req.writableEnded === false) req.end(payload); }, 500);
    // A broken proxy must make this test *fail*, not hang: without a deadline a
    // host that answers without draining the body leaves the client writing
    // forever, and the suite stalls instead of reporting.
    req.setTimeout(10_000, () => req.destroy(new Error("upload stalled — the proxy did not drain the body")));
  });
  assert.deepEqual(JSON.parse(echoed), { bytes: payload.byteLength });
});

test("a page copy reaches the backend as the reader's frame sent it", needsBuild, async () => {
  /*
   * After an annotation the reader's tab sends the page as drawn: `PUT` with
   * the markup as `text/html` — megabytes of it, astral characters included —
   * and the width and address in the query. The backend hashes what it stores
   * to tell an unchanged page from a changed one, so a proxy that re-encoded,
   * re-typed or truncated the body would store a different page or none.
   */
  const html = "<!DOCTYPE html><html><body>" + "<p>An exact passage with 😀 evidence and ∑ notation.</p>".repeat(90_000) + "</body></html>";
  const body = new TextEncoder().encode(html);
  assert.ok(body.byteLength > 5 * 1024 * 1024);
  const path = "/api/projects/p/papers/x/saved-page?width=1180&url=https%3A%2F%2Fexample.org%2Fa%3Fq%3D1";
  const stored = await fetch(`${origin}${path}`, { method: "PUT", body, headers: { "content-type": "text/html; charset=utf-8" } });
  assert.equal(stored.status, 200);
  assert.deepEqual(await stored.json(), {
    method: "PUT", url: path, type: "text/html; charset=utf-8", bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  });

  /*
   * Refused mid-upload, as the backend refuses a copy past its limit: the tab
   * must get an answer and never a success. The backend closes the connection
   * behind its 413 before the proxy has finished writing, so what arrives can
   * be the host's own error instead — which is why the frame refuses at the
   * published limit before anything is sent, and this path is the exception.
   */
  const refused = await fetch(`${origin}/api/projects/p/papers/x/saved-page?limit=1048576`, {
    method: "PUT", body, headers: { "content-type": "text/html; charset=utf-8" }, signal: AbortSignal.timeout(10_000),
  });
  assert.ok(refused.status === 413 || refused.status === 500, `a refused copy answered ${refused.status}`);
});

test("a /desktop/* request the shell does not answer never reaches the backend", needsBuild, async () => {
  // Plan 4 A4, the shell's half: `/desktop/*` is the shell's namespace and is
  // never forwarded to Python, whatever the Worker does with what reaches it.
  // The host here has a desktop handler that, like the app's, answers its own
  // paths and declines every other.
  const uiPort = await freePort("localhost");
  const host = await startWorkerHost({
    distDir: DIST, backendUrl: backend!.url, uiHost: "localhost", uiPort,
    desktopHandler: async (request) => new URL(request.url).pathname === "/desktop/connection"
      ? Response.json({ shell: true }) : undefined,
  });
  try {
    const shell = `http://localhost:${uiPort}`;
    backend!.received.length = 0;
    const answered = await fetch(`${shell}/desktop/connection`);
    assert.deepEqual(await answered.json(), { shell: true });
    const unknown = ["/desktop/unknown", "/desktop/plans/unknown", "/desktop/api/health", "/desktop/",
      "/desktop/connection/extra", "/desktop/favicon/x?host=example.org", "/desktop/reader/find.json"];
    for (const path of unknown) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const response = await fetch(`${shell}${path}`, {
          method, body: method === "POST" || method === "PUT" ? "{}" : undefined,
          headers: { "content-type": "application/json", origin: shell }, redirect: "manual",
        });
        await response.arrayBuffer();
      }
    }
    assert.deepEqual(backend!.received, [], "a /desktop/* request reached the backend");
    // The recorder sees what is forwarded: the API is.
    await (await fetch(`${shell}/api/echo`, { method: "POST", body: "x" })).arrayBuffer();
    assert.deepEqual(backend!.received, ["POST /api/echo"]);
  } finally {
    host.close();
  }
});

test("a response that arrives after its reader left is let go, not left to throw", async () => {
  const { createServer } = await import("node:http");
  const { Writable } = await import("node:stream");
  let drop = () => {};
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    // Part of a body, then the connection ends: undici's "terminated".
    drop = () => { res.write('{"pages":['); res.socket!.destroy(); };
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const uncaught: unknown[] = [];
  const record = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", record);
  try {
    const { port } = upstream.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/api/memory`);
    const gone = new Writable({ write(_chunk, _encoding, done) { done(); } });
    gone.destroy();
    await send(gone as never, response);
    drop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(uncaught, []);
    assert.equal(response.body!.locked, false);
  } finally {
    process.removeListener("uncaughtException", record);
    upstream.close();
  }
});

test("the UI and API hosts may never collapse into one", () => {
  // Not cosmetic: the sandbox origin's isolation is a host-only cookie.
  assert.throws(() => assertHostSplit("localhost", "localhost"), /must not share a host/);
  assert.doesNotThrow(() => assertHostSplit("localhost", "127.0.0.1"));
});
