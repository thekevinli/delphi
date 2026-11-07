/**
 * The backend child never outlives the app, however the app ends.
 *
 * A quit stops it through `before-quit`, but a SIGKILL or a crash runs no
 * handler at all, and a child left behind keeps its port and the data
 * directory's in-process locks. These start the real backend through
 * `startBackend` from a separate process, end that process the way nothing
 * can intercept, and require the backend to be gone.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = process.env.DELPHI_TEST_PYTHON || join(ROOT, ".delphi-build", "python", "bin", "python3");
if (!existsSync(PYTHON) && process.env.DELPHI_REQUIRE_INTEGRATION === "1") {
  throw new Error("Missing installed backend; run npm run build, or set DELPHI_TEST_PYTHON.");
}
const needsBuild = { skip: existsSync(PYTHON) ? false : "run `npm run build` first", timeout: 90_000 };

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 100)); }
  return check();
}

/** A stand-in for the app: starts the backend, prints its pid, then waits to be killed. */
function startApp(dataDir: string) {
  const script = `
    import { startBackend } from ${JSON.stringify(join(ROOT, "main", "backend.ts"))};
    import { freePort } from ${JSON.stringify(join(ROOT, "main", "ports.ts"))};
    const apiPort = await freePort("127.0.0.1");
    await startBackend({ python: ${JSON.stringify(PYTHON)}, dataDir: ${JSON.stringify(dataDir)}, logsDir: ${JSON.stringify(dataDir)},
      apiHost: "127.0.0.1", apiPort, uiOrigin: "http://localhost:1", sessionSecret: "lifecycle", apiKey: "" });
    const { execSync } = await import("node:child_process");
    const child = execSync("pgrep -P " + process.pid + " -f uvicorn").toString().trim().split("\\n")[0];
    console.log("backend " + child);
    setInterval(() => {}, 1 << 30);`;
  const app = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const backend = new Promise<number>((resolve, reject) => {
    let out = "";
    app.stdout.on("data", chunk => { out += chunk; const match = out.match(/backend (\d+)/); if (match) resolve(Number(match[1])); });
    app.once("exit", code => reject(new Error(`app exited ${code} before the backend started`)));
  });
  return { app, backend };
}

for (const signal of ["SIGKILL", "SIGTERM"] as const) {
  test(`the backend exits when the app is ended by ${signal}`, needsBuild, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "delphi-lifecycle-"));
    const { app, backend } = startApp(dataDir);
    try {
      const pid = await backend;
      assert.ok(alive(pid), "backend started");
      app.kill(signal);
      assert.ok(await until(() => !alive(pid), 20_000), `backend ${pid} outlived an app ended by ${signal}`);
    } finally {
      app.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}
