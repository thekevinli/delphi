/**
 * A stand-in for Delphi.app's executable, for the packaged-app smoke's tests.
 *
 *   node packaged-app-stub.cjs <bundle executable> --remote-debugging-port=<port>
 *
 * It serves a DevTools endpoint whose one page evaluates what the smoke sends
 * against a fake interface, and starts a "backend" from inside the bundle so
 * the check that nothing outlives the app has a process to find.
 *
 * STUB_HEALTH  status /api/health answers with (default 200)
 * STUB_LEAK    leave the backend running after quit
 * STUB_RECORD  file to write { pid, backend, profile } into
 */
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { dirname, join } = require("node:path");
const vm = require("node:vm");

const [executable, ...args] = process.argv.slice(2);
const port = Number(args.find(arg => arg.startsWith("--remote-debugging-port="))?.split("=")[1]);
const profile = process.env.DELPHI_PROFILE_DIR;
if (!port || !profile) { console.error("stub: needs --remote-debugging-port and DELPHI_PROFILE_DIR"); process.exit(2); }

mkdirSync(join(profile, "logs"), { recursive: true });
appendFileSync(join(profile, "logs", "backend.log"), "stub backend started\n");
const bundle = dirname(dirname(dirname(executable)));
const backend = spawn(join(bundle, "Contents", "Resources", "python", "bin", "python3"), ["600"], { stdio: "ignore", detached: true });
backend.unref();
if (process.env.STUB_RECORD) writeFileSync(process.env.STUB_RECORD, JSON.stringify({ pid: process.pid, backend: backend.pid, profile }));

process.on("SIGTERM", () => {
  if (!process.env.STUB_LEAK) try { process.kill(backend.pid); } catch { /* gone */ }
  process.exit(0);
});

/* The interface: only what the smoke asks of it. */
let pdfText = "";
const ui = createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    const reply = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    const health = Number(process.env.STUB_HEALTH ?? 200);
    if (request.url === "/api/health") return reply(health, { status: health === 200 ? "ok" : "unavailable" });
    if (request.url === "/api/auth/me") return reply(200, { username: "reader" });
    if (request.method === "POST" && request.url === "/api/projects") return reply(200, { id: "p1", slug: "packaged-smoke" });
    if (request.method === "POST" && request.url === "/api/projects/p1/papers") {
      // "Rendering": the text the PDF draws, read from its content stream.
      pdfText = Buffer.concat(chunks).toString("latin1").match(/\(([^)]*)\) Tj/)?.[1] ?? "";
      return reply(200, { id: "d1", slug: "smoke" });
    }
    reply(404, { detail: "Not Found" });
  });
});

/* The page, as Runtime.evaluate and Page.navigate see it. */
let pageUrl = "";
function evaluate(expression) {
  const location = new URL(pageUrl);
  const document = {
    readyState: "complete",
    querySelector: selector => selector === '.pdf-page[data-page="1"] .text-layer' && location.pathname === "/@reader/packaged-smoke/smoke" && pdfText
      ? { textContent: pdfText } : null,
    querySelectorAll: () => [],
  };
  const pageFetch = (input, init) => fetch(new URL(input, location), init);
  return vm.runInNewContext(expression, { document, location, fetch: pageFetch, FormData, File, atob });
}

async function command({ id, method, params }) {
  if (method === "Page.navigate") { pageUrl = params.url; return { id, result: { frameId: "1" } }; }
  if (method !== "Runtime.evaluate") return { id, error: { code: -32601, message: `'${method}' wasn't found` } };
  try {
    const value = await evaluate(params.expression);
    return { id, result: { result: { type: typeof value, value } } };
  } catch (error) { return { id, result: { result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: String(error) } } } }; }
}

/* A WebSocket server, as little of one as the smoke's client needs. */
function frame(text) {
  const payload = Buffer.from(text);
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x81, length])
    : length < 65536 ? Buffer.from([0x81, 126, length >> 8, length & 255])
    : Buffer.concat([Buffer.from([0x81, 127]), (() => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(length)); return size; })()]);
  return Buffer.concat([header, payload]);
}

function accept(request, socket) {
  const key = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
  let buffer = Buffer.alloc(0);
  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      let length = buffer[1] & 0x7f, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const mask = buffer[1] & 0x80 ? buffer.subarray(offset, offset + 4) : null;
      if (mask) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      const opcode = buffer[0] & 0x0f;
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) { socket.end(Buffer.from([0x88, 0])); return; }
      if (opcode === 0x1) void command(JSON.parse(payload.toString("utf8"))).then(reply => socket.write(frame(JSON.stringify(reply))));
    }
  });
  socket.on("error", () => {});
}

ui.listen(0, "localhost", () => {
  pageUrl = `http://localhost:${ui.address().port}/`;
  // The splash comes first, as in the app, so the smoke has to wait for the reader.
  const readerAt = Date.now() + 700;
  const devtools = createServer((request, response) => {
    if (request.url !== "/json/list") { response.writeHead(404).end(); return; }
    const page = Date.now() < readerAt ? { id: "0", type: "page", url: "file:///Delphi.app/Contents/Resources/onboarding/starting.html" }
      : { id: "1", type: "page", url: pageUrl, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([page]));
  });
  devtools.on("upgrade", accept);
  devtools.listen(port, "127.0.0.1");
});
