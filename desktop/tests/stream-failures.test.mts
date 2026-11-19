import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { send } from "../main/worker-host.ts";

async function fixture(response: () => Response) {
  let recordFailure!: (error: unknown) => void;
  const failed = new Promise(resolve => { recordFailure = resolve; });
  const server = createServer((_req, res) => { void send(res, response()).catch(error => { recordFailure(error); res.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, failed, close: () => { server.closeAllConnections(); server.close(); } };
}

test("response connection tokens are stripped while separate cookies survive", async () => {
  const headers = new Headers({ connection: "x-private", "x-private": "secret", "keep-alive": "timeout=5" });
  headers.append("set-cookie", "one=1");
  headers.append("set-cookie", "two=2");
  const server = await fixture(() => new Response("ok", { headers }));
  try {
    const response = await fetch(server.url);
    assert.equal(response.headers.get("x-private"), null);
    assert.deepEqual(response.headers.getSetCookie(), ["one=1", "two=2"]);
    assert.equal(await response.text(), "ok");
  } finally { server.close(); }
});

test("asynchronous response failures reject the transfer instead of crashing the host", { timeout: 3000 }, async () => {
  const server = await fixture(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode("first"));
    setTimeout(() => controller.error(new Error("stream broke")), 30);
  } })));
  try {
    await assert.rejects(async () => { const response = await fetch(server.url); await response.text(); });
    assert.ok(await server.failed);
  } finally { server.close(); }
});

test("disconnecting a streaming client cancels the response producer", async () => {
  let cancelled = false;
  const server = await fixture(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } })));
  try {
    const response = await fetch(server.url);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    for (let attempt = 0; attempt < 40 && !cancelled; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(cancelled, true);
  } finally { server.close(); }
});
