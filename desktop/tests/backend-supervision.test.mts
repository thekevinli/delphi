import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { startBackend, waitForHealth } from "../main/backend.ts";

test("a health endpoint that never answers obeys the overall deadline", async () => {
  const server = createServer(() => {});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const start = Date.now();
  try {
    await assert.rejects(waitForHealth(`http://127.0.0.1:${address.port}`, 100, () => ""), /did not become healthy/);
    assert.ok(Date.now() - start < 2000);
  } finally { server.closeAllConnections(); server.close(); }
});

test("spawn failure is handled and startup gives up ownership promptly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "delphi-supervisor-"));
  try {
    await assert.rejects(startBackend({ python: dir, dataDir: dir, logsDir: dir, apiHost: "127.0.0.1", apiPort: 1, uiOrigin: "http://localhost:2", sessionSecret: "test", apiKey: "test" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("stop clears an already scheduled restart and is idempotent", { timeout: 9000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "delphi-restart-"));
  const executable = join(dir, "fake-python");
  writeFileSync(executable, "#!/bin/sh\necho launched >> launches.txt\nexit 1\n", { mode: 0o700 });
  const server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  try {
    backend = await startBackend({ python: executable, dataDir: dir, logsDir: dir, apiHost: "127.0.0.1", apiPort: (server.address() as { port: number }).port, uiOrigin: "http://localhost:2", sessionSecret: "test", apiKey: "test" });
    // Under the full parallel gate, macOS can take more than a second to
    // launch the fixture. Wait for the exit condition, then still verify that
    // stop prevents the scheduled restart from firing.
    for (let attempt = 0; attempt < 160; attempt++) {
      if (existsSync(join(dir, "backend.log")) && readFileSync(join(dir, "backend.log"), "utf8").includes("backend exited")) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.match(readFileSync(join(dir, "backend.log"), "utf8"), /backend exited/);
    backend.stop();
    backend.stop();
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal(readFileSync(join(dir, "launches.txt"), "utf8"), "launched\n");
  } finally { backend?.stop(); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); }
});
