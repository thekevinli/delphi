import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { installLauncher, launcherInstructions } from "../main/research/launcher.ts";

const pairing = "45d04fe6-3b7c-443d-9d3e-5a4f41981d9e";
const token = "/Users/reader/Library/Application Support/Delphi/research/mcp-token";
test("PATH launcher quotes paths, preserves stdio and refreshes bridge arguments", () => {
  const directory = mkdtempSync("/tmp/delphi-launcher-test-");
  try {
    const bridge = join(directory, "Delphi's app bridge");
    writeFileSync(bridge, '#!/bin/sh\nprintf "%s\\n" "$@"\ncat\n', { mode: 0o700 });
    const socket = join(directory, "socket with 'quotes'.sock");
    const target = installLauncher(directory, bridge, socket, pairing, token);
    const run = () => spawnSync("delphi-mcp", [], { env: { ...process.env, PATH: join(directory, ".local/bin") + ":" + process.env.PATH }, input: "MCP input\n", encoding: "utf8" });
    assert.equal(run().stdout, `${socket}\n${pairing}\n${token}\nMCP input\n`);
    assert.equal(run().stderr, "");
    assert.equal(lstatSync(target).mode & 0o777, 0o700);
    const replacement = join(directory, "new.sock");
    installLauncher(directory, bridge, replacement, pairing, token);
    assert.equal(run().stdout, `${replacement}\n${pairing}\n${token}\nMCP input\n`);
    rmSync(bridge);
    assert.equal(run().status, 1);
    assert.match(run().stderr, /Open Delphi/);
    assert.equal(run().stdout, "");
    assert.ok(launcherInstructions.includes("codex mcp add delphi -- "));
    assert.ok(launcherInstructions.includes("/.local/bin/delphi-mcp"));
    assert.ok(!launcherInstructions.includes(pairing));
    assert.throws(() => installLauncher(directory, bridge, socket, pairing, "relative/token"), /Invalid MCP launcher/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("launcher refuses unmanaged files and symlinks without changing their contents", () => {
  for (const symlink of [false, true]) {
    const directory = mkdtempSync("/tmp/delphi-launcher-conflict-");
    try {
      const bin = join(directory, ".local/bin"), sentinel = join(directory, "sentinel"), target = join(bin, "delphi-mcp");
      mkdirSync(bin, { recursive: true }); writeFileSync(sentinel, "preserve me");
      if (symlink) symlinkSync(sentinel, target); else writeFileSync(target, "another program");
      assert.throws(() => installLauncher(directory, "/app/bridge", "/tmp/example.sock", pairing, token), /not a Delphi-managed/);
      assert.equal(readFileSync(sentinel, "utf8"), "preserve me");
      assert.equal(readFileSync(target, "utf8"), symlink ? "preserve me" : "another program");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
