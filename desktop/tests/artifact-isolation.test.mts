/**
 * The reader's artifact guard in the Electron this app ships: an artifact
 * that grows a nested srcdoc frame gets a realm with WebRTC, and Electron
 * reports no navigation for it. Fake frames cannot show that the guard ends
 * it in time, so this runs the real window, with loopback sinks only.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = join(ROOT, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
if (!existsSync(ELECTRON) && process.env.DELPHI_REQUIRE_INTEGRATION === "1") {
  throw new Error("Missing Electron; run npm install.");
}

test("the reader ends an artifact that creates a nested frame before that frame runs", {
  skip: existsSync(ELECTRON) ? false : "run `npm install` first", timeout: 60_000,
}, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "delphi-artifact-isolation-"));
  try {
    mkdirSync(join(temporary, "profile"));
    const fixture = join(temporary, "isolation.mjs");
    await build({ entryPoints: [join(ROOT, "tests", "fixtures", "artifact-isolation.mts")], outfile: fixture,
      bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "error" });
    const env = Object.fromEntries(["HOME", "PATH", "TMPDIR", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    const { stdout } = await promisify(execFile)(ELECTRON, [fixture], {
      env: { ...env, DELPHI_ISOLATION_PROFILE: join(temporary, "profile") }, timeout: 50_000, maxBuffer: 1024 * 1024,
    });
    const [control, guarded] = stdout.trim().split("\n").map(line => JSON.parse(line));
    // Without the guard the probe is live: it runs and reaches both sinks.
    assert.equal(control.nestedRan, true);
    assert.ok(control.udpPackets > 0 && control.tcpConnections > 0, JSON.stringify(control));
    assert.deepEqual(guarded, {
      guarded: true, policy: "disable_non_proxied_udp", ownProcess: true, clicked: "Worked", reset: "Reset worked",
      nestedRan: false, udpPackets: 0, tcpConnections: 0, webNestedRan: true, readerFetch: "reader fetch works", ended: true,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
