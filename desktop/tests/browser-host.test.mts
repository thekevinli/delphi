/**
 * The browser host in the Electron this app ships, driven by core's own
 * capture, preview and validator code: the jobs that used to launch the
 * user's Chrome. Every host is loopback and every text synthetic.
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
const ELECTRON = process.platform === "darwin"
  ? join(ROOT, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
  : join(ROOT, "node_modules", "electron", "dist", "electron");
// The bundled interpreter `npm run build` makes, with this checkout's core in it.
const PYTHON = process.env.DELPHI_BROWSER_PYTHON ?? join(ROOT, ".delphi-build", "python", "bin", "python3");
const RENDERER = join(ROOT, ".delphi-build", "artifact-validator");
const ready = existsSync(ELECTRON) && existsSync(PYTHON) && existsSync(join(RENDERER, "manifest.json"))
  && (process.platform === "darwin" || Boolean(process.env.DISPLAY));
if (!ready && process.env.DELPHI_REQUIRE_INTEGRATION === "1") throw new Error("Missing Electron or the built runtime; run npm install and npm run build.");

test("capture, previews and draft checks run in Electron's Chromium, unseen, and leave nothing behind", {
  skip: ready ? false : "run `npm install` and `npm run build` first", timeout: 240_000,
}, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "delphi-browser-host-"));
  try {
    mkdirSync(join(temporary, "profile"));
    const fixture = join(temporary, "host.mjs");
    await build({ entryPoints: [join(ROOT, "tests", "fixtures", "browser-host.mts")], outfile: fixture,
      bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "error" });
    const env = Object.fromEntries(["HOME", "PATH", "TMPDIR", "LANG", "DISPLAY", "XAUTHORITY"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    const { stdout } = await promisify(execFile)(ELECTRON, [...(process.platform === "linux" ? ["--no-sandbox"] : []), fixture], {
      env: { ...env, DELPHI_BROWSER_PROFILE: join(temporary, "profile"), DELPHI_BROWSER_PYTHON: PYTHON,
        DELPHI_BROWSER_JOBS: join(ROOT, "tests", "fixtures", "browser-host-jobs.py"), DELPHI_ARTIFACT_RENDERER: RENDERER },
      timeout: 220_000, maxBuffer: 4 * 1024 * 1024,
    });
    const outcome = JSON.parse(stdout.trim().split("\n").pop()!);
    const { jobs } = outcome;
    assert.equal(outcome.code, 0, JSON.stringify(outcome));
    // A page that builds itself is read once built, at the width it is stamped with.
    assert.deepEqual(jobs.render, { ...jobs.render, built: true, stampedWidth: 1512 });
    assert.equal(jobs.source.original, true);
    // A page that draws only what is in view is read with all of itself drawn;
    // one that only looks so, sized to its window, at the window it was built in.
    assert.deepEqual([jobs.windowed.rows, jobs.windowed.last], [jobs.windowed.expected, true], JSON.stringify(jobs.windowed));
    // The add reads it at the window it was built in, stamped partial, for its capture to finish.
    assert.ok(jobs.first.partial && jobs.first.rows > 0 && jobs.first.rows < jobs.windowed.expected, JSON.stringify(jobs.first));
    assert.deepEqual(jobs.sized, { built: true, banner: "4000" });
    // What a page's publisher says never changes is asked for once, however many renders use it.
    const [firstRender, again] = jobs.chunked.renders;
    assert.deepEqual(firstRender, { parts: jobs.chunked.expected, live: true, chunksAsked: jobs.chunked.expected, liveAsked: 1 }, JSON.stringify(jobs.chunked));
    assert.deepEqual(again, { parts: jobs.chunked.expected, live: true, chunksAsked: 0, liveAsked: 1 }, JSON.stringify(jobs.chunked));
    // Previews are the requested viewport at scale 1, of the page itself.
    assert.deepEqual([jobs.preview.size, jobs.preview.corner], [[960, 720], [20, 120, 60]]);
    assert.deepEqual([jobs.frozen.size, jobs.frozen.corner], [[640, 480], [20, 120, 60]]);
    // Nothing in a prepared document runs, so a worker that would have read
    // another file (which the host's request guard cannot see) never starts.
    assert.deepEqual(jobs.hostile.corner, [255, 255, 255], JSON.stringify(jobs.hostile));
    // A page's alert, confirm, prompt and print show nothing and hold nothing up.
    assert.equal(jobs.dialogs.built, true, JSON.stringify(jobs.dialogs));
    assert.ok(jobs.dialogs.seconds < 12, JSON.stringify(jobs.dialogs));
    // A sound draft passes every width and its check; the others are refused, saying why.
    assert.deepEqual([jobs.artifacts.good.passed, jobs.artifacts.good.views, jobs.artifacts.good.interactions], [true, 3, [true]]);
    assert.ok(jobs.artifacts.good.peakBytes > 0);
    assert.equal(jobs.artifacts.leaky.passed, false);
    assert.ok(jobs.artifacts.nested.errors.includes("nested_frame"), JSON.stringify(jobs.artifacts.nested));
    assert.ok(jobs.artifacts.greedy.errors.includes("memory_limit"), JSON.stringify(jobs.artifacts.greedy));
    // A library display is stepped through every state; what the narrow column cuts off, or a step that draws nothing, is refused.
    assert.deepEqual([jobs.artifacts.display.passed, jobs.artifacts.display.views, jobs.artifacts.display.interactions], [true, 3, [true]], JSON.stringify(jobs.artifacts.display));
    assert.match(jobs.artifacts.display.states, /^14 states/);
    assert.equal(jobs.artifacts.crowded.passed, false);
    assert.ok(["clipped_content", "dead_step"].every(code => jobs.artifacts.crowded.errors.includes(code)), JSON.stringify(jobs.artifacts.crowded));
    assert.deepEqual(jobs.concurrent.built, [true, true]);
    assert.equal(jobs.concurrent.preview, true);
    assert.equal(jobs.wrongToken, "not authorised");
    // No page or draft reached an address the proxy refuses, or the network at all.
    assert.deepEqual(jobs.sinkHits, []);
    // Nothing was shown or focused, the pool held, and every page went with its job.
    assert.deepEqual([outcome.shown, outcome.focused, outcome.lingering], [0, 0, 0]);
    assert.ok(outcome.peakWindows <= 3, String(outcome.peakWindows));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
