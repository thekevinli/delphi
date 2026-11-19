import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE } from "../frontend/app/lib/ai-connection.ts";
import { ClaudeConnection, ClaudeLocator, claudeCandidates, claudeVersionProblem, shellClaude } from "../main/inference/claude-runtime.ts";
import { ClaudeTransport } from "../main/inference/claude-transport.ts";
import { startInferenceBridge } from "../main/inference/bridge.ts";
import { fixtureClaude } from "./fixtures/claude-runtime.mts";

// Claude Code is the reader's own install. Delphi finds it wherever the
// documented installers put it, says what to run when it cannot serve, and
// picks up an install made while Delphi is open without a restart.

test("versions below the floor need an update; anything newer serves", () => {
  assert.equal(claudeVersionProblem("2.1.302"), undefined);
  assert.equal(claudeVersionProblem("2.1.410"), undefined);
  assert.equal(claudeVersionProblem("2.2.0"), undefined);
  assert.equal(claudeVersionProblem("2.1.301"), "outdated");
  assert.equal(claudeVersionProblem("1.9.999"), "outdated");
  assert.equal(claudeVersionProblem(""), "outdated");
  assert.equal(claudeVersionProblem("3.0.0"), undefined);
});

test("a Finder-launched app still looks where the installers put Claude Code", () => {
  const candidates = claudeCandidates("/Users/reader", "/usr/bin:/bin:/usr/sbin:/sbin");
  for (const path of ["/Users/reader/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/Users/reader/.claude/local/claude"]) {
    assert.ok(candidates.includes(path), path);
  }
  assert.equal(candidates[0], "/Users/reader/.local/bin/claude", "the native installer's launcher comes first");
});

test("an install made after Delphi opened is used on the next check, with the command shown until then", async () => {
  const fixture = fixtureClaude({ connected: true });
  const hidden = fixture.executable + ".pending";
  renameSync(fixture.executable, hidden);
  let shellLookups = 0;
  const locator = new ClaudeLocator({ candidates: () => [fixture.executable], shell: async () => { shellLookups++; return undefined; } });
  const connection = new ClaudeConnection({ locate: () => locator.locate() });
  try {
    const missing = await connection.status();
    assert.equal(missing.connected, false);
    assert.equal(missing.installed, false);
    assert.deepEqual(missing.install, { problem: "missing", version: undefined, command: CLAUDE_CODE.install });
    assert.match(missing.message!, /not installed/);
    await assert.rejects(connection.ready(), /not installed/);
    // The reader installs it in Terminal; the same connection object finds it.
    renameSync(hidden, fixture.executable);
    const installed = await connection.status();
    assert.equal(installed.installed, true);
    assert.equal(installed.connected, true);
    assert.equal(installed.install, undefined);
    assert.equal(shellLookups, 1, "the fixed location is found without asking the shell");
  } finally { fixture.remove(); }
});

test("an old Claude Code asks for an update, a newer major is used as is", async () => {
  const fixture = fixtureClaude({ connected: true, version: "2.1.0 (Claude Code)" });
  try {
    const old = await fixture.connection.status();
    assert.equal(old.install?.problem, "outdated");
    assert.equal(old.install?.version, "2.1.0");
    assert.equal(old.install?.command, CLAUDE_CODE.update);
    assert.match(old.message!, /2\.1\.0 is too old.*2\.1\.302/);
    fixture.configure({ connected: true, version: "3.0.0 (Claude Code)" });
    const future = await fixture.connection.status();
    assert.equal(future.install, undefined);
    assert.equal(future.connected, true);
  } finally { fixture.remove(); }
});

test("the shell lookup is coalesced, throttled, and remembered once found", async () => {
  const fixture = fixtureClaude({ connected: true });
  let lookups = 0, found: string | undefined;
  const locator = new ClaudeLocator({ candidates: () => [], shell: async () => { lookups++; await new Promise(r => setTimeout(r, 50)); return found; } });
  try {
    const misses = await Promise.allSettled([locator.locate(), locator.locate(), locator.locate()]);
    assert.ok(misses.every(result => result.status === "rejected"));
    assert.equal(lookups, 1, "concurrent checks share one shell");
    await assert.rejects(locator.locate(), /not installed/);
    assert.equal(lookups, 1, "an immediate recheck does not start another shell");
    found = fixture.executable;
    (locator as any).lookedAt = -Infinity; // As if the throttle interval had passed.
    assert.equal(await locator.locate(), fixture.executable);
    assert.equal(await locator.locate(), fixture.executable);
    assert.equal(lookups, 2, "a found path is reused while it stays executable");
  } finally { fixture.remove(); }
});

test("the login shell's answer is read past startup noise, and a stalled shell is abandoned", async () => {
  const fixture = fixtureClaude({ connected: true });
  const dir = mkdtempSync(join(tmpdir(), "delphi-shell-"));
  const noisy = join(dir, "noisy"), stalled = join(dir, "stalled");
  writeFileSync(noisy, `#!/bin/sh\necho "Welcome back"\nprintf '__DELPHI_CLAUDE__/not/absolute\\n' >&2\nprintf '\\n__DELPHI_CLAUDE__%s\\n' ${JSON.stringify(fixture.executable)}\n`);
  writeFileSync(stalled, "#!/bin/sh\nsleep 30\n");
  chmodSync(noisy, 0o755); chmodSync(stalled, 0o755);
  try {
    assert.equal(await shellClaude({ HOME: dir, SHELL: noisy }), fixture.executable);
    const started = Date.now();
    assert.equal(await shellClaude({ HOME: dir, SHELL: stalled }, 300), undefined);
    assert.ok(Date.now() - started < 2_000, "a stalled shell is given up on");
  } finally { rmSync(dir, { recursive: true, force: true }); fixture.remove(); }
});

test("a chat request without Claude Code says where to fix it and waits like an expired sign-in", async () => {
  const connection = new ClaudeConnection({ locate: () => new ClaudeLocator({ candidates: () => [], shell: false }).locate() });
  const bridge = await startInferenceBridge({ upstream: new ClaudeTransport(connection), limits: connection.limits, provider: "Claude", prime: false });
  try {
    const response = await fetch(bridge.url + "/responses", { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", input: [{ role: "user", content: "Hello" }] }) });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, "claude_reauth_required");
    assert.match(body.error.message, /not installed.*Settings → Advanced → AI connection/);
  } finally { await bridge.stop(); }
});
