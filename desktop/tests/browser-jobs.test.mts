/** The browser host's rules for a job, before Electron makes anything for it. */
import assert from "node:assert/strict";
import test from "node:test";

import { connect } from "node:net";
import { lineReader, MAX_DEADLINE_SECONDS, parseOpening, permitted, Slots, unavailableBrowserHost } from "../main/browser-jobs.ts";

const page = { purpose: "page", width: 1512, height: 4000, proxy: "127.0.0.1:50123", deadlineSeconds: 30 };

test("a page job reaches the network only through the backend's loopback proxy", () => {
  assert.equal(parseOpening(page).proxy, "127.0.0.1:50123");
  const { proxy: _, ...direct } = page;
  assert.throws(() => parseOpening(direct), /proxy/);
  // Anywhere else would let a captured page skip the public-address check.
  for (const proxy of ["10.0.0.5:8080", "localhost:80", "127.0.0.1:80 ; DIRECT", "socks5://127.0.0.1:1080"]) {
    assert.throws(() => parseOpening({ ...page, proxy }), /proxy/);
  }
});

test("an artifact job has no network to name", () => {
  const artifact = { purpose: "artifact", width: 850, height: 700, deadlineSeconds: 50, memoryLimitBytes: 768 << 20 };
  assert.deepEqual(parseOpening(artifact), artifact);
  assert.throws(() => parseOpening({ ...artifact, proxy: "127.0.0.1:1" }), /no network/);
});

test("a job cannot outlive the host's ceiling or ask for what it does not know", () => {
  assert.equal(parseOpening({ ...page, deadlineSeconds: 3600 }).deadlineSeconds, MAX_DEADLINE_SECONDS);
  assert.throws(() => parseOpening({ ...page, deadlineSeconds: 0 }), /deadline/);
  assert.throws(() => parseOpening({ ...page, width: 1.5 }), /width/);
  assert.throws(() => parseOpening({ ...page, preload: "/tmp/x.js" }), /unknown option preload/);
  assert.throws(() => parseOpening({ ...page, purpose: "browser" }), /purpose/);
  assert.throws(() => parseOpening({ ...page, memoryLimitBytes: 1024 }), /memoryLimitBytes/);
});

test("a job drives its own page and nothing browser-wide", () => {
  for (const method of ["Page.navigate", "Runtime.evaluate", "Network.getResponseBody", "Fetch.failRequest",
    "Emulation.setDeviceMetricsOverride", "Log.enable", "Target.setAutoAttach", "Page.captureScreenshot"]) {
    assert.ok(permitted(method), method);
  }
  // The reader's targets, new windows, the browser itself, and files on disk.
  for (const method of ["Target.attachToTarget", "Target.createTarget", "Target.attachToBrowserTarget", "Target.getTargets",
    "Browser.close", "Storage.getCookies", "SystemInfo.getInfo", "Page.setDownloadBehavior", "Tracing.start"]) {
    assert.ok(!permitted(method), method);
  }
});

test("a stream is cut into lines however its chunks fall, and a runaway line is refused", () => {
  const lines: string[] = [];
  const read = lineReader(line => lines.push(line));
  read(Buffer.from('{"a":1}\n{"b":'));
  read(Buffer.from('2}\n{"c"'));
  read(Buffer.from(":3}\n"));
  assert.deepEqual(lines.map(line => JSON.parse(line)), [{ a: 1 }, { b: 2 }, { c: 3 }]);
  const runaway = lineReader(() => {});
  const chunk = Buffer.alloc(16 << 20, 0x61);
  assert.throws(() => { for (let index = 0; index < 4; index += 1) runaway(chunk); }, /too long/);
});

test("slots go to waiters in order, and a waiter that gives up never takes one", async () => {
  const slots = new Slots(1);
  const first = await slots.acquire(new AbortController().signal);
  const abandoned = new AbortController();
  const gaveUp = slots.acquire(abandoned.signal);
  const next = slots.acquire(new AbortController().signal);
  abandoned.abort();
  await assert.rejects(gaveUp, /cancelled/);
  slots.release(first);
  assert.equal(await next, first);
  await assert.rejects(slots.acquire(abandoned.signal), /cancelled/);
});

test("a host that could not start leaves the backend a dead address, never no host", async () => {
  const host = unavailableBrowserHost();
  // A token: core treats a host with none as no host, and then looks for Chrome.
  assert.equal(host.available, false);
  assert.match(host.token, /^[0-9a-f]{64}$/);
  const error = await new Promise<NodeJS.ErrnoException>(resolve => connect(host.socket).once("error", resolve));
  assert.equal(error.code, "ENOENT");
  await host.close();
});
