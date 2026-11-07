import assert from "node:assert/strict";
import test from "node:test";
import { readerFindHandler } from "../main/reader-find.ts";

const origin = "http://localhost:8317";
const request = (body: unknown, source = origin) => new Request(origin + "/desktop/reader/find", { method: "POST", headers: { origin: source, "content-type": "application/json" }, body: JSON.stringify(body) });
test("reader find requires an authenticated same-origin request and a named reader frame", async () => {
  let calls = 0;
  const handler = readerFindHandler({ origin, authenticate: async () => true, run: async (frame, script) => {
    calls++; assert.equal(frame, "delphi-frame-paper"); assert.ok(script.includes('"a\\"b"')); return { total: 2, index: 0 };
  } });
  const body = { query: 'a"b', index: 0, frameName: "delphi-frame-paper" };
  assert.equal((await handler(request(body, "https://untrusted.test")))?.status, 403);
  assert.equal((await handler(request({ ...body, frameName: "main" })))?.status, 400);
  assert.equal((await handler(request({ ...body, query: "a".repeat(501) })))?.status, 400);
  assert.deepEqual(await (await handler(request(body)))?.json(), { total: 2, index: 0 });
  assert.equal(calls, 1);
  const denied = readerFindHandler({ origin, authenticate: async () => false, run: async () => { throw new Error("must not run"); } });
  assert.equal((await denied(request(body)))?.status, 403);
});
