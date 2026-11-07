import { mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeConnection, ClaudeLocator } from "../../main/inference/claude-runtime.ts";
export function fixtureClaude(initial: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "delphi-claude-test-"));
  const executable = join(dir, "claude");
  writeFileSync(executable, `#!${process.execPath}\nawait import(${JSON.stringify(new URL("claude-cli.mjs", import.meta.url).href)});\n`, { mode: 0o700 });
  const configure = (value: Record<string, unknown>) => {
    writeFileSync(join(dir, "control.json"), JSON.stringify(value));
  };
  configure(initial);
  // The real locator over one fixed location: moving the file away is an uninstall.
  const reopen = () => { const locator = new ClaudeLocator({ candidates: () => [executable], shell: false }); return new ClaudeConnection({ locate: () => locator.locate(), env: { ...process.env, HOME: dir } }); };
  const uninstall = () => renameSync(executable, executable + ".removed");
  const install = () => renameSync(executable + ".removed", executable);
  const connection = reopen();
  const calls = () => existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const usageCalls = () => existsSync(join(dir, "usage-calls.jsonl")) ? readFileSync(join(dir, "usage-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  // One row per stdin message a process received, and per batch of MCP results it was given.
  const turns = () => existsSync(join(dir, "turns.jsonl")) ? readFileSync(join(dir, "turns.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  return { dir, executable, connection, reopen, configure, uninstall, install, calls, usageCalls, turns, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
