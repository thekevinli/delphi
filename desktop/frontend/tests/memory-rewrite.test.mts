import assert from "node:assert/strict";
import test from "node:test";
import { waitForMemoryRewrite } from "../app/lib/memory-rewrite.ts";
import type { MaintenanceJob, MaintenanceSnapshot } from "../app/lib/api.ts";

const row = (status: MaintenanceJob["status"], lastError: string | null = null) =>
  ({ id: "rewrite", status, lastError }) as MaintenanceJob;
const snapshot = (jobs: MaintenanceJob[]) => ({ jobs }) as MaintenanceSnapshot;

test("a pending or externally leased rewrite stays pending until its own row disappears", async () => {
  const messages: string[] = [];
  const states = [row("pending"), row("leased"), row("pending", "temporary rejection"), row("leased")];
  let pauses = 0;
  await waitForMemoryRewrite("rewrite", new AbortController().signal,
    (message) => messages.push(message),
    async () => snapshot(states.length ? [states.shift()!] : [{ ...row("leased"), id: "other" }]),
    async () => { pauses += 1; });
  assert.equal(pauses, 4);
  assert.match(messages[0], /queued/);
  assert.match(messages[1], /Writing/);
  assert.match(messages[2], /another attempt/);
});

test("a failed status request cannot be mistaken for a completed rewrite", async () => {
  let reads = 0;
  const messages: string[] = [];
  await waitForMemoryRewrite("rewrite", new AbortController().signal,
    (message) => messages.push(message),
    async () => {
      if (++reads === 1) throw new Error("offline");
      return snapshot(reads === 2 ? [row("leased")] : []);
    }, async () => {});
  assert.equal(reads, 3);
  assert.match(messages[0], /reconnect/);
});

test("terminal failure rejects so the form preserves the reader's note", async () => {
  await assert.rejects(waitForMemoryRewrite("rewrite", new AbortController().signal,
    () => {}, async () => snapshot([row("failed", "Invented locator")]),
    async () => assert.fail("terminal failure must stop polling")), /Invented locator/);
});

test("leaving the shell aborts observation without cancelling the durable job", async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(waitForMemoryRewrite("rewrite", controller.signal, () => {},
    async () => { reads += 1; return snapshot([row("leased")]); },
    async () => { controller.abort(); }), { name: "AbortError" });
  assert.equal(reads, 1);
});
