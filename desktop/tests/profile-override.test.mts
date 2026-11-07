import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSync } from "esbuild";

/*
 * `electron` resolves only inside Electron. A recorder stands in for its `app`,
 * so what is tested is the module's own import-time effect, the one `index.ts`
 * relies on. Each import gets a fresh instance through its query string.
 */
type Call = [name: string, path: string];
const recorder = globalThis as typeof globalThis & { profileOverrideCalls: Call[] };
recorder.profileOverrideCalls = [];
const stub = "data:text/javascript,export const app = { setPath: (name, path) => globalThis.profileOverrideCalls.push([name, path]) };";
register("data:text/javascript," + encodeURIComponent(`export async function resolve(specifier, context, next) {
  return specifier === "electron" ? { url: ${JSON.stringify(stub)}, shortCircuit: true } : next(specifier, context);
}`));

let instance = 0;
async function load(value: string | undefined): Promise<typeof import("../main/profile-override.ts")> {
  recorder.profileOverrideCalls = [];
  if (value === undefined) delete process.env.DELPHI_PROFILE_DIR;
  else process.env.DELPHI_PROFILE_DIR = value;
  try { return await import(`../main/profile-override.ts?instance=${++instance}`); }
  finally { delete process.env.DELPHI_PROFILE_DIR; }
}

test("unset, the profile stays where Electron puts it", async () => {
  const module = await load(undefined);
  assert.deepEqual(recorder.profileOverrideCalls, []);
  assert.equal(module.profileOverride({}), undefined);
});

test("an absolute directory becomes the whole profile, created owner-only first", async () => {
  const root = mkdtempSync(join(tmpdir(), "delphi-override-"));
  try {
    const dir = join(root, "nested", "profile");
    await load(dir);
    assert.deepEqual(recorder.profileOverrideCalls, [["userData", dir], ["sessionData", dir]]);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a relative, empty or control-character value refuses to start rather than fall back", async () => {
  for (const value of ["", "profile", "./profile", "~/profile", "/tmp/a\nb"]) {
    await assert.rejects(load(value), /DELPHI_PROFILE_DIR must be an absolute path/, JSON.stringify(value));
    assert.deepEqual(recorder.profileOverrideCalls, [], JSON.stringify(value));
  }
  assert.equal(existsSync("profile"), false);
});

test("the directory is normalised, so one profile has one spelling", async () => {
  const { profileOverride } = await load(undefined);
  assert.equal(profileOverride({ DELPHI_PROFILE_DIR: "/a/b/../c/" }), "/a/c");
});

test("index.ts imports the override before anything else", () => {
  const source = readFileSync(new URL("../main/index.ts", import.meta.url), "utf8");
  assert.equal(source.match(/^import .*$/m)?.[0], 'import "./profile-override.ts";');
});

test("the bundled main process applies it before any other module's code runs", () => {
  // The flags of build/main.sh: what Electron runs, not what the source suggests.
  const root = new URL("..", import.meta.url).pathname;
  const [output] = buildSync({
    entryPoints: ["main/index.ts"], absWorkingDir: root,
    bundle: true, platform: "node", format: "esm", target: "node20",
    packages: "external", external: ["electron"], write: false, logLevel: "silent",
  }).outputFiles;
  // esbuild heads each module's code with a `// <path>` line.
  const [first, second] = [...output.text.matchAll(/^\/\/ (\S+)$/gm)];
  assert.equal(first?.[1], "main/profile-override.ts");
  const applied = output.text.search(/^applyProfileOverride\(/m);
  assert.ok(applied > first.index! && applied < second.index!, "the override is applied before the next module's code");
  assert.ok(applied < output.text.indexOf("requestSingleInstanceLock("), "and so before the single-instance lock");
});
