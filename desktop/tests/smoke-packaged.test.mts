import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface Options { help: boolean; app: string; library?: string; startupMs: number; keepProfile: boolean; quitGraceMs?: number }
interface Smoke {
  DEFAULT_APP: string;
  PROFILE_PREFIX: string;
  UsageError: new (message: string) => Error;
  parseOptions(argv: string[], cwd?: string): Options;
  prepareProfile(options?: { library?: string; parent?: string }): string;
  removeProfile(dir: string): void;
  fixturePdf(nonce: string): Buffer;
  checkNativeBinary(path: string): void;
  smoke(options: Options, log?: (line: string) => void): Promise<number>;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "build", "smoke-packaged.mjs");
const STUB = join(ROOT, "tests", "fixtures", "packaged-app-stub.cjs");
const smoke: Smoke = await import(new URL("../build/smoke-packaged.mjs", import.meta.url).href);

const scratch = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const MACHO = Buffer.from("cffaedfe0c000001", "hex");

test("options: the built app by default, everything else relative to where it is run", () => {
  const defaults = smoke.parseOptions([]);
  assert.equal(defaults.app, join(ROOT, ".delphi-build", "release", "mac-arm64", "Delphi.app"));
  assert.deepEqual({ ...defaults, app: undefined }, { help: false, app: undefined, library: undefined, startupMs: 180_000, keepProfile: false });
  assert.deepEqual(smoke.parseOptions(["--app", "out/Delphi.app", "--library=copy", "--timeout", "30", "--keep-profile"], "/work"), {
    help: false, app: "/work/out/Delphi.app", library: "/work/copy", startupMs: 30_000, keepProfile: true,
  });
  for (const argv of [["--timeout", "0"], ["--timeout", "soon"], ["--bogus"], ["Delphi.app"], ["--app"]]) {
    assert.throws(() => smoke.parseOptions(argv), smoke.UsageError, argv.join(" "));
  }
});

test("a fresh profile holds only a connection that needs no key and reaches no provider", () => {
  const parent = scratch("delphi-smoke-parent-");
  try {
    const profile = smoke.prepareProfile({ parent });
    assert.equal(dirname(profile), parent);
    assert.ok(basename(profile).startsWith(smoke.PROFILE_PREFIX));
    assert.deepEqual(readdirSync(profile), ["config.json"]);
    assert.deepEqual(readJson(join(profile, "config.json")), { version: 2, connectionId: "chatgpt-oauth" });
    assert.equal(statSync(join(profile, "config.json")).mode & 0o777, 0o600);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("a library brings its identity and data, never its key, pairings or sign-ins", () => {
  const parent = scratch("delphi-smoke-parent-");
  try {
    const library = join(parent, "library");
    const config = { version: 2, connectionId: "openai-api", apiKey: "AAAA", apiBaseUrl: "https://example.test/v1", username: "reader", sessionSecret: "BBBB", accountPassword: "CCCC" };
    for (const dir of ["data/users/reader", "research", "inference", "logs"]) mkdirSync(join(library, dir), { recursive: true });
    writeFileSync(join(library, "config.json"), JSON.stringify(config));
    writeFileSync(join(library, "data/users/reader/page.md"), "kept");
    writeFileSync(join(library, "research/store.json"), "{}");
    writeFileSync(join(library, "inference/oauth.json"), "secret");

    const profile = smoke.prepareProfile({ library, parent });
    assert.deepEqual(readdirSync(profile).sort(), ["config.json", "data"]);
    assert.equal(readFileSync(join(profile, "data/users/reader/page.md"), "utf8"), "kept");
    assert.deepEqual(readJson(join(profile, "config.json")), {
      version: 2, connectionId: "chatgpt-oauth", username: "reader", sessionSecret: "BBBB", accountPassword: "CCCC",
    });
    assert.deepEqual(readJson(join(library, "config.json")), config, "the library itself is untouched");
    // A Keychain-era profile holds its key as a Keychain ciphertext; that is dropped too.
    const { apiKey: _, ...rest } = config;
    writeFileSync(join(library, "config.json"), JSON.stringify({ ...rest, apiKeyCipher: "AAAA" }));
    assert.equal(readJson(join(smoke.prepareProfile({ library, parent }), "config.json")).apiKeyCipher, undefined);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("a library the app could not open is refused, and leaves nothing behind", () => {
  const parent = scratch("delphi-smoke-parent-");
  try {
    mkdirSync(join(parent, "bare", "users"), { recursive: true });
    assert.throws(() => smoke.prepareProfile({ library: join(parent, "bare"), parent }), /config\.json and data/);
    assert.deepEqual(readdirSync(parent), ["bare"]);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("clean-up removes a smoke profile and refuses any other directory", () => {
  const parent = scratch("delphi-smoke-parent-");
  try {
    const profile = smoke.prepareProfile({ parent });
    smoke.removeProfile(profile);
    assert.equal(existsSync(profile), false);
    mkdirSync(join(parent, "library"));
    assert.throws(() => smoke.removeProfile(join(parent, "library")), /not a smoke profile/);
    assert.ok(existsSync(join(parent, "library")));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("the fixture PDF is well formed: every offset in its table lands on its object", () => {
  const pdf = smoke.fixturePdf("abc123").toString("latin1");
  assert.ok(pdf.startsWith("%PDF-1.4\n") && pdf.endsWith("%%EOF\n"));
  assert.match(pdf, /\(Delphi packaged app smoke abc123\) Tj/);
  const xref = Number(pdf.match(/startxref\n(\d+)\n/)![1]);
  assert.ok(pdf.startsWith("xref\n", xref));
  const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(match => Number(match[1]));
  assert.equal(offsets.length, 5);
  offsets.forEach((offset, i) => assert.ok(pdf.startsWith(`${i + 1} 0 obj\n`, offset), `object ${i + 1}`));
});

test("the MCP binary must be an executable Mach-O, not merely present", () => {
  const dir = scratch("delphi-fake-app-");
  try {
    const path = join(dir, "delphi-mcp");
    assert.throws(() => smoke.checkNativeBinary(path), /missing/);
    writeFileSync(path, MACHO, { mode: 0o644 });
    assert.throws(() => smoke.checkNativeBinary(path), /not executable/);
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    assert.throws(() => smoke.checkNativeBinary(path), /not a Mach-O/);
    writeFileSync(path, MACHO);
    smoke.checkNativeBinary(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A Delphi.app whose executable is the stub, with a Mach-O placeholder and a "Python" inside. */
function fakeApp(): { root: string; app: string } {
  const root = scratch("delphi-fake-app-");
  const app = join(root, "Delphi.app");
  for (const dir of ["MacOS", "Resources/native", "Resources/python/bin"]) mkdirSync(join(app, "Contents", dir), { recursive: true });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(app, "Contents/MacOS/Delphi"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(STUB)} "$0" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(app, "Contents/Resources/native/delphi-mcp"), MACHO, { mode: 0o755 });
  // Started by the stub as its backend; `ps` shows it by this path, as it shows the real one.
  symlinkSync("/bin/sleep", join(app, "Contents/Resources/python/bin/python3"));
  return { root, app };
}

interface Record { pid: number; backend: number; profile: string }

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

/** The script as the coordinator runs it: its own process, its own exit code. */
async function runScript(app: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [SCRIPT, "--app", app, "--timeout", "20"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise<number | null>(resolve => child.once("exit", resolve));
  return { code, stdout, stderr };
}

test("against a healthy app every check passes, then the app quits and its profile is removed", async () => {
  const { root, app } = fakeApp();
  try {
    const record = join(root, "record.json");
    const { code, stdout, stderr } = await runScript(app, { STUB_RECORD: record });
    assert.equal(code, 0, stdout + stderr);
    for (const name of ["MCP binary is bundled", "the app starts on the scratch profile", "the window opens signed in", "/api/health answers through the interface", "a PDF can be added and opens", "the app and its backend exit on quit"]) {
      assert.match(stdout, new RegExp(`^ok {4}${name.replace(/[/.]/g, "\\$&")}`, "m"), name);
    }
    assert.match(stdout, /Smoke passed: 6 checks\./);
    const { pid, backend, profile } = readJson(record) as Record;
    assert.ok(basename(profile).startsWith(smoke.PROFILE_PREFIX));
    assert.equal(existsSync(profile), false, "the scratch profile is removed");
    assert.ok(await gone(pid) && await gone(backend), "the app and its backend are gone");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failing check fails the smoke with its reason, and clean-up still runs", async () => {
  const { root, app } = fakeApp();
  try {
    const record = join(root, "record.json");
    const { code, stdout } = await runScript(app, { STUB_RECORD: record, STUB_HEALTH: "503" });
    assert.equal(code, 1, stdout);
    assert.match(stdout, /^FAIL {2}\/api\/health answers through the interface: status 503: \{"status":"unavailable"\}$/m);
    assert.match(stdout, /^ok {4}a PDF can be added and opens/m, "independent checks still run");
    assert.match(stdout, /--- logs\/backend\.log \(last 1 lines\)\nstub backend started/, "the app's own logs are shown");
    assert.match(stdout, /Smoke FAILED: 1 of 6 checks failed\./);
    const { pid, profile } = readJson(record) as Record;
    assert.equal(existsSync(profile), false);
    assert.ok(await gone(pid));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a backend that outlives the app fails the smoke and is stopped", async () => {
  const { root, app } = fakeApp();
  const lines: string[] = [];
  try {
    process.env.STUB_RECORD = join(root, "record.json");
    process.env.STUB_LEAK = "1";
    const code = await smoke.smoke({ ...smoke.parseOptions(["--app", app, "--timeout", "20"]), quitGraceMs: 500 }, line => lines.push(line));
    assert.equal(code, 1, lines.join("\n"));
    const { backend } = readJson(join(root, "record.json")) as Record;
    const failure = lines.find(line => line.startsWith("FAIL  the app and its backend exit on quit"));
    assert.match(failure ?? "", new RegExp(`still running 0\\.5 s after the app quit, now killed: ${backend} .*/Contents/Resources/python/bin/python3 600`));
    assert.ok(await gone(backend), "the leaked backend is stopped");
  } finally {
    delete process.env.STUB_RECORD;
    delete process.env.STUB_LEAK;
    rmSync(root, { recursive: true, force: true });
  }
});
