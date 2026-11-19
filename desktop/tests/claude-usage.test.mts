import assert from "node:assert/strict";
import test from "node:test";
import { fixtureClaude } from "./fixtures/claude-runtime.mts";
import { desktopConnectionHandler } from "../main/inference/connection-handler.ts";

const resetsAt = new Date(Date.now() + 7 * 86400_000).toISOString();
const usage = (percent: number) => ({ rate_limits_available: true, rate_limits: {
  seven_day: { utilization: percent, resets_at: resetsAt },
  five_hour: { utilization: 90, resets_at: resetsAt },
} });
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail("native usage process did not reach the expected state");
}

test("Settings reads fresh weekly usage before any chat, after restart, and after outside usage", async () => {
  const f = fixtureClaude({ usageResponse: usage(29) });
  const restarted = f.reopen();
  const handler = desktopConnectionHandler({ origin: "http://localhost:1234", authenticate: async () => true,
    read: () => ({ version: 2, connectionId: "claude-subscription", username: "reader", accountPassword: "YWJj", sessionSecret: "YWJj" }),
    statuses: async () => ({ chatgpt: { connected: false, signingIn: false }, claude: await restarted.status({ refreshUsage: true }) }),
    busy: () => undefined, change: async () => {}, manage: () => {},
  });
  const read = async () => (await (await handler(new Request("http://localhost:1234/desktop/connection")))!.json()).claude;
  try {
    assert.equal((await restarted.status()).usage?.percentLeft, undefined);
    assert.equal(f.usageCalls().length, 0, "ordinary auth polling does not fetch usage");
    const first = await read();
    assert.equal(first.connected, true);
    assert.equal(first.usage.percentLeft, 71);
    assert.equal(first.usage.weekly, true);
    f.configure({ usageResponse: usage(43) });
    assert.equal((await read()).usage.percentLeft, 57, "reopening Settings sees usage from outside Delphi");
    assert.equal(f.calls().length, 0, "no model prompt was sent");
    assert.equal(f.usageCalls().length, 2);
    for (const call of f.usageCalls()) {
      assert.deepEqual(call.request, { subtype: "get_usage", skip_behaviors: true });
      assert.equal(call.args[call.args.indexOf("--tools") + 1], "");
      assert.deepEqual(JSON.parse(call.args[call.args.indexOf("--settings") + 1]), { disableAllHooks: true, autoMemoryEnabled: false });
    }
  } finally { restarted.stop(); f.remove(); }
});

test("usage refresh coalesces concurrent reads, tolerates CLI changes, and fences account changes", async () => {
  const f = fixtureClaude({ usageResponse: usage(29), usageDelay: 250 });
  try {
    const results = await Promise.all([1, 2, 3].map(() => f.connection.status({ refreshUsage: true })));
    assert.deepEqual(results.map(r => r.usage?.percentLeft), [71, 71, 71]);
    assert.equal(f.usageCalls().length, 1);
    for (const usageMode of ["error", "malformed", "crash"]) {
      f.configure({ usageMode });
      const status = await f.connection.status({ refreshUsage: true });
      assert.equal(status.connected, true);
      assert.equal(status.usage?.percentLeft, 71, "a failed refresh preserves the last report");
    }
    f.configure({ usageResponse: {} });
    assert.equal((await f.connection.status({ refreshUsage: true })).usage?.percentLeft, 71, "unknown response schema is a refresh failure");
    f.configure({ usageResponse: usage(90), usageDelay: 500 });
    const count = f.usageCalls().length;
    const pending = f.connection.status({ refreshUsage: true });
    await until(() => f.usageCalls().length > count);
    f.configure({ email: "other@example.org", usageResponse: usage(10) });
    assert.equal((await f.connection.status({ refreshUsage: true })).usage?.percentLeft, 90);
    await pending;
    assert.equal((await f.connection.status()).usage?.percentLeft, 90, "old account result cannot overwrite new account usage");
    for (const usageResponse of [
      { rate_limits_available: false, rate_limits: null },
      { rate_limits_available: true, rate_limits: { five_hour: { utilization: 90, resets_at: resetsAt } } },
      { rate_limits_available: true, rate_limits: { seven_day: { utilization: null, resets_at: null } } },
    ]) {
      f.configure({ email: "other@example.org", usageResponse });
      assert.equal((await f.connection.status({ refreshUsage: true })).usage?.percentLeft, undefined);
    }
    assert.equal(f.calls().length, 0);
  } finally { f.connection.stop(); f.remove(); }
});

test("a hung usage refresh is bounded and app shutdown terminates its child", async () => {
  const f = fixtureClaude({ usageMode: "hang" });
  try {
    const started = Date.now();
    assert.equal((await f.connection.status({ refreshUsage: true })).connected, true);
    assert.ok(Date.now() - started >= 4900, "the fixture stayed hung until the deadline");
    assert.ok(Date.now() - started < 8000);
    const exited = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
    await until(() => exited(f.usageCalls()[0].pid));
    const pending = f.connection.status({ refreshUsage: true });
    await until(() => f.usageCalls().length === 2);
    f.connection.stop();
    await pending;
    await until(() => exited(f.usageCalls()[1].pid));
    assert.equal((await f.connection.status({ refreshUsage: true })).connected, false);
    assert.equal(f.usageCalls().length, 2, "shutdown cannot start a new usage process");
    assert.equal(f.calls().length, 0);
  } finally { f.connection.stop(); f.remove(); }
});
