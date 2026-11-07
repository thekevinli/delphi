/**
 * Real web pages, added through the app's backend on the app's own browser
 * host, end to end (`fixtures/live-capture.mts`). It reaches the web, so it
 * runs only when `DELPHI_LIVE_PAGES` names the pages, and a site that throttles
 * readers (notion.site answers 429 for minutes to a machine that reads it too
 * often) will fail it: space runs out rather than repeating them.
 *
 *   DELPHI_LIVE_PAGES="https://alisawuffles.notion.site/alisa-s-book-of-llms" \
 *     node --test --experimental-strip-types tests/live-capture.test.mts
 *
 * A page added is opened from its first build; once its capture has run, its
 * saved copy holds all of it: no reserved blank below the last block drawn,
 * and every in-page link has its target.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = join(ROOT, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
const PYTHON = process.env.DELPHI_BROWSER_PYTHON ?? join(ROOT, ".delphi-build", "python", "bin", "python3");
const PAGES = process.env.DELPHI_LIVE_PAGES ?? "";

/** Below the last block a whole copy keeps at most its own margin, never a window's worth. */
const WHOLE_BLANK_PX = 1000;

test("a windowed page opens at its first window and is kept whole once its capture runs", {
  skip: !PAGES ? "set DELPHI_LIVE_PAGES to the pages to add" : !existsSync(PYTHON) ? "run `npm run build` first" : false,
  timeout: 900_000,
}, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "delphi-live-capture-"));
  try {
    const fixture = join(temporary, "live.mjs");
    await build({ entryPoints: [join(ROOT, "tests", "fixtures", "live-capture.mts")], outfile: fixture,
      bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "error" });
    const env = Object.fromEntries(["HOME", "PATH", "TMPDIR", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    const { stdout } = await promisify(execFile)(ELECTRON, [fixture], {
      env: { ...env, DELPHI_BROWSER_PYTHON: PYTHON, DELPHI_LIVE_PAGES: PAGES }, timeout: 880_000, maxBuffer: 8 * 1024 * 1024,
    });
    const outcome = JSON.parse(stdout.trim().split("\n").pop()!);
    console.log(JSON.stringify(outcome, null, 2));
    for (const result of outcome.results) {
      assert.equal(result.error, undefined, JSON.stringify(result));
      const { first, whole } = result;
      assert.equal(result.partial, true, `${result.url} was not opened at its first window: ${JSON.stringify(first)}`);
      assert.ok(whole.blank < WHOLE_BLANK_PX, `${result.url}: ${whole.blank}px blank below the last block: ${JSON.stringify(whole)}`);
      assert.equal(whole.linked, whole.links, `${result.url}: in-page links without a target: ${JSON.stringify(whole)}`);
      assert.ok(whole.blocks >= first.blocks && whole.text >= first.text, JSON.stringify(result));
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
