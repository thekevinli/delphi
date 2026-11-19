/**
 * Smoke-test the packaged app on a scratch profile.
 *
 *   node build/smoke-packaged.mjs [--app <Delphi.app>] [--library <profile>]
 *                                 [--timeout <seconds>] [--keep-profile]
 *
 * No other test opens the built `.app`, so this is what catches a bundle that
 * is broken in a way the source checkout is not: a resource left out of
 * `extraResources`, a path that only resolves in the checkout. It launches the
 * app with `DELPHI_PROFILE_DIR` pointing at a new temporary directory, so the
 * reader's library is never opened, and `--remote-debugging-port`, and checks
 * over CDP what a reader would notice first:
 *
 * - the MCP binary is in `Contents/Resources/native/`;
 * - the app starts on the scratch profile and the window opens signed in;
 * - `/api/health` answers through the interface's origin;
 * - a PDF can be added and its first page renders;
 * - with `--library`, a Memory page from that library renders.
 *
 * Then it quits the app, checks nothing from the bundle outlived it, and
 * removes the scratch profile. Any failed check exits 1 with its reason.
 *
 * `--library` takes a Delphi profile written on this Mac (a copy of
 * ~/Library/Application Support/Delphi, say): its `config.json` and `data/`.
 * The identity in config.json is what signs in to that data, so a bare data
 * directory cannot be opened. A Keychain-era profile keeps its secrets
 * under this Mac's "Delphi Safe Storage" Keychain key and is moved out of it on
 * first open (one Keychain prompt). Copy from a profile no running Delphi is
 * writing to.
 */
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_APP = join(ROOT, ".delphi-build", "release", "mac-arm64", "Delphi.app");
export const PROFILE_PREFIX = "delphi-smoke-";
/** The interface's host (`UI_HOST` in main/ports.ts); the reader window is the page served from it. */
const UI_HOST = "localhost";
/** Memory's routes. */
const MEMORY = { api: "/api/memory/pages", page: "/memory" };
const FIXTURE_TEXT = "Delphi packaged app smoke";
const USAGE = "usage: node build/smoke-packaged.mjs [--app <Delphi.app>] [--library <profile>] [--timeout <seconds>] [--keep-profile]";

export class UsageError extends Error {}

export function parseOptions(argv, cwd = process.cwd()) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        app: { type: "string" },
        library: { type: "string" },
        timeout: { type: "string" },
        "keep-profile": { type: "boolean" },
        help: { type: "boolean" },
      },
    }));
  } catch (error) { throw new UsageError(error.message); }
  const timeout = values.timeout === undefined ? 180 : Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new UsageError(`--timeout must be a positive number of seconds, not ${JSON.stringify(values.timeout)}`);
  return {
    help: Boolean(values.help),
    app: values.app === undefined ? DEFAULT_APP : resolve(cwd, values.app),
    library: values.library === undefined ? undefined : resolve(cwd, values.library),
    startupMs: timeout * 1000,
    keepProfile: Boolean(values["keep-profile"]),
  };
}

/** Refuse a library the app could not open before launching anything. */
export function checkLibrary(library) {
  if (!existsSync(join(library, "config.json")) || !existsSync(join(library, "data"))) {
    throw new UsageError(`--library must be a Delphi profile with config.json and data/ (a copy of ~/Library/Application Support/Delphi, say); ${library} lacks one.`);
  }
}

/**
 * A new scratch profile, optionally holding a copy of a library.
 *
 * Its connection is always a ChatGPT plan with no sign-in: that starts without
 * the first-run prompt, and any model call fails fast instead of spending a real
 * key or using the reader's Claude Code sign-in. A library's `research/` and
 * `inference/` are not copied: its MCP pairing would make the app rewrite the
 * reader's `~/.local/bin/delphi-mcp`, and the second holds provider sign-ins.
 */
export function prepareProfile({ library, parent = tmpdir() } = {}) {
  const dir = realpathSync(mkdtempSync(join(parent, PROFILE_PREFIX)));
  try {
    let config = {};
    if (library) {
      checkLibrary(library);
      config = JSON.parse(readFileSync(join(library, "config.json"), "utf8"));
      cpSync(join(library, "data"), join(dir, "data"), { recursive: true, preserveTimestamps: true });
    }
    const { apiKey: _key, apiKeyCipher: _cipher, apiBaseUrl: _url, ...kept } = config;
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ...kept, version: 2, connectionId: "chatgpt-oauth" }, null, 2) + "\n", { mode: 0o600 });
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Only ever a directory this script made. */
export function removeProfile(dir) {
  if (!basename(dir).startsWith(PROFILE_PREFIX)) throw new Error(`Refusing to remove ${dir}: not a smoke profile`);
  rmSync(dir, { recursive: true, force: true });
}

/** A one-page PDF with its own text, made here so no third-party file ships as a fixture. */
export function fixturePdf(nonce) {
  const stream = `BT /F1 14 Tf 24 120 Td (${FIXTURE_TEXT} ${nonce}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

/** Executable and Mach-O: an empty placeholder would pass an existence check. */
export function checkNativeBinary(path) {
  if (!existsSync(path)) throw new Error(`missing: ${path}`);
  if (!(statSync(path).mode & 0o111)) throw new Error(`not executable: ${path}`);
  const magic = Buffer.alloc(4);
  const fd = openSync(path, "r");
  try { readSync(fd, magic, 0, 4, 0); } finally { closeSync(fd); }
  if (!["cffaedfe", "cafebabe", "bebafeca"].includes(magic.toString("hex"))) throw new Error(`not a Mach-O executable: ${path}`);
}

/* Page functions: serialised into the reader window and run there. */

function pageReady() {
  return document.readyState === "complete" ? location.origin : null;
}

async function pageFetch(path) {
  const response = await fetch(path, { credentials: "include" });
  return { status: response.status, body: await response.text() };
}

async function pageAddPdf({ base64, filename, project }) {
  const json = async (path, init = {}) => {
    const response = await fetch(path, { credentials: "include", ...init });
    const text = await response.text();
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  const me = await json("/api/auth/me");
  const created = await json("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: project }) });
  const form = new FormData();
  form.append("file", new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], filename, { type: "application/pdf" }));
  const paper = await json(`/api/projects/${created.id}/papers`, { method: "POST", body: form });
  if (paper.status === "compressed") throw new Error("the fixture was held for compression instead of added");
  return `/@${me.username}/${created.slug}/${paper.slug}`;
}

function pageShowsText({ selector, text }) {
  const shown = document.querySelector(selector)?.textContent ?? "";
  return shown.replace(/\s+/g, " ").includes(text);
}

function pageMemoryShown(title) {
  const heading = [...document.querySelectorAll("h2")].some(h => h.textContent.trim() === title);
  const body = document.querySelector("article.kb-prose");
  return heading && body !== null && body.textContent.trim().length > 0;
}

/** The minimum of CDP: one page target, commands by id, events ignored. */
export class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    const opened = await within(new Promise(resolve => {
      socket.addEventListener("open", () => resolve(true), { once: true });
      socket.addEventListener("error", () => resolve(false), { once: true });
    }), 10_000);
    if (!opened) { socket.close(); throw new Error(`could not open the DevTools socket ${url}`); }
    return new Cdp(socket);
  }

  #next = 0;
  #pending = new Map();

  constructor(socket) {
    this.socket = socket;
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      const waiter = this.#pending.get(message.id);
      if (!waiter) return;
      this.#pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.#pending.values()) waiter.reject(new Error("the DevTools socket closed"));
      this.#pending.clear();
    });
  }

  get closed() { return this.socket.readyState !== WebSocket.OPEN; }

  /** Bounded, so a wedged backend fails a check instead of hanging the smoke. */
  send(method, params = {}, timeoutMs = 90_000) {
    // A closed socket drops what it is sent, and the reply would never come.
    if (this.closed) return Promise.reject(new Error("the DevTools socket closed"));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} got no answer in ${timeoutMs / 1000} s`));
      }, timeoutMs);
      const settle = done => value => { clearTimeout(timer); done(value); };
      this.#pending.set(id, { method, resolve: settle(resolve), reject: settle(reject) });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(fn, arg) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression: `(${fn})(${arg === undefined ? "" : JSON.stringify(arg)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  /** Poll until `fn` returns something truthy; errors mid-navigation count as "not yet". */
  async waitFor(fn, arg, { timeoutMs, what }) {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    for (;;) {
      try {
        const value = await this.evaluate(fn, arg);
        if (value) return value;
        last = "";
      } catch (error) {
        if (this.closed) throw error;
        last = error.message;
      }
      if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${last ? ` (last error: ${last})` : ""}`);
      await delay(250);
    }
  }

  close() { this.socket.close(); }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** `promise`'s value, or `undefined` after `ms`; the losing timer must not hold the process open. */
function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Every process started from this bundle: the app, its helpers, its Python. */
export function bundleProcesses(app) {
  const prefix = join(app, "Contents") + "/";
  return execFileSync("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8" })
    .split("\n")
    .map(line => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter(match => match && match[2].startsWith(prefix) && Number(match[1]) !== process.pid)
    .map(match => ({ pid: Number(match[1]), args: match[2] }));
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hostname = url => { try { return new URL(url).hostname; } catch { return ""; } };

/** The last lines of what the app and its backend logged, for a failure report. */
function logTails(profile, output) {
  const parts = [];
  if (output.length) parts.push(`--- app output (last ${Math.min(output.length, 40)} lines)\n${output.slice(-40).join("\n")}`);
  const logs = join(profile, "logs");
  if (existsSync(logs)) {
    for (const name of readdirSync(logs).sort()) {
      const path = join(logs, name);
      if (!statSync(path).isFile()) continue;
      const lines = readFileSync(path, "utf8").trimEnd().split("\n");
      parts.push(`--- logs/${name} (last ${Math.min(lines.length, 40)} lines)\n${lines.slice(-40).join("\n")}`);
    }
  }
  return parts.join("\n");
}

/**
 * Run every check and report. Returns the exit code: 0 when all passed.
 * `log` receives the report line by line.
 */
export async function smoke(options, log = console.log) {
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? (ok ? `  (${detail})` : `: ${detail}`) : ""}`);
  };
  const check = async (name, body) => {
    try { record(name, true, await body()); return true; }
    catch (error) { record(name, false, error instanceof Error ? error.message : String(error)); return false; }
  };

  if (!existsSync(join(options.app, "Contents", "MacOS", basename(options.app, ".app")))) {
    throw new UsageError(`No app at ${options.app}. Build it with npm run dist, or pass --app.`);
  }
  // Real paths, because they are what `ps` shows for the processes started from them.
  const app = realpathSync(options.app);
  const executable = join(app, "Contents", "MacOS", basename(app, ".app"));
  if (options.library) checkLibrary(options.library);
  // Checked before launch so that, afterwards, every process from the bundle is ours.
  const running = bundleProcesses(app);
  if (running.length) throw new UsageError(`Delphi from ${app} is already running (pid ${running.map(p => p.pid).join(", ")}). Quit it first.`);

  const profile = prepareProfile({ library: options.library });
  log(`app      ${app}\nprofile  ${profile}\nlibrary  ${options.library ?? "(none)"}\n`);

  await check("MCP binary is bundled", () => {
    checkNativeBinary(join(app, "Contents", "Resources", "native", "delphi-mcp"));
    return "Contents/Resources/native/delphi-mcp";
  });

  const port = await freePort();
  const env = { ...process.env, DELPHI_PROFILE_DIR: profile, DELPHI_PLAN_PORT: String(await freePort()) };
  // Set by some Electron hosts for their children; it would start the app as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const output = [];
  let startupFailure = "";
  const child = spawn(executable, [`--remote-debugging-port=${port}`], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.once("error", error => { startupFailure = `could not launch ${executable}: ${error.message}`; });
  for (const stream of [child.stdout, child.stderr]) {
    let partial = "";
    stream.setEncoding("utf8");
    stream.on("data", chunk => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop();
      for (const line of lines) {
        output.push(line);
        if (output.length > 400) output.shift();
        // `fail` in main/index.ts logs this before it opens its modal dialog.
        if (!startupFailure && line.includes("[delphi] startup failed:")) startupFailure = line.trim();
      }
    });
  }
  // Ctrl-C quits the app; the checks then fail fast and the clean-up below still runs.
  const interrupt = () => {
    startupFailure ||= "interrupted";
    log("\ninterrupted: quitting the app and removing the scratch profile");
    child.kill("SIGTERM");
  };
  process.once("SIGINT", interrupt);

  let cdp;
  let origin = "";
  let ourProcesses = [];
  try {
    const started = Date.now();
    const opened = await check("the app starts on the scratch profile", async () => {
      for (;;) {
        if (startupFailure) throw new Error(startupFailure);
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the app exited (${child.exitCode ?? child.signalCode}) before its window opened`);
        const pages = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) }).then(r => r.json()).catch(() => []);
        if (pages.some(p => p.type === "page" && p.url.endsWith("/onboarding/index.html"))) throw new Error("the first-run setup window opened: the scratch profile's connection was not accepted");
        const reader = pages.find(p => p.type === "page" && hostname(p.url) === UI_HOST);
        if (reader) {
          cdp = await Cdp.connect(reader.webSocketDebuggerUrl);
          break;
        }
        if (Date.now() - started > options.startupMs) {
          throw new Error(`no reader window after ${options.startupMs / 1000} s. A Keychain-era profile asks once for Keychain access to "Delphi Safe Storage"; allow it and rerun.`);
        }
        await delay(500);
      }
      // The override is what keeps the reader's library out of reach; prove it held.
      if (!existsSync(join(profile, "logs"))) throw new Error(`the window opened but nothing was written to ${profile}: the profile override did not take effect`);
      return `${((Date.now() - started) / 1000).toFixed(1)} s`;
    });
    ourProcesses = bundleProcesses(app);

    if (opened) {
      const signedIn = await check("the window opens signed in", async () => {
        origin = await cdp.waitFor(pageReady, undefined, { timeoutMs: 60_000, what: "the reader page to load" });
        if (hostname(origin) !== UI_HOST) throw new Error(`the window shows ${origin}, not the interface`);
        const me = await cdp.evaluate(pageFetch, "/api/auth/me");
        if (me.status !== 200) throw new Error(`/api/auth/me answered ${me.status}: ${me.body.slice(0, 200)}`);
        return `${origin} as @${JSON.parse(me.body).username}`;
      });

      await check("/api/health answers through the interface", async () => {
        const health = await cdp.evaluate(pageFetch, "/api/health");
        if (health.status !== 200) throw new Error(`status ${health.status}: ${health.body.slice(0, 200)}`);
        if (JSON.parse(health.body).status !== "ok") throw new Error(`unexpected body ${health.body.slice(0, 200)}`);
        return "status ok";
      });

      // Before the PDF, so the library is read as it was written.
      if (signedIn && options.library) {
        await check("a Memory page from the library renders", async () => {
          const listed = await cdp.evaluate(pageFetch, MEMORY.api);
          if (listed.status !== 200) throw new Error(`${MEMORY.api} answered ${listed.status}: ${listed.body.slice(0, 200)}`);
          const [page] = JSON.parse(listed.body);
          if (!page) throw new Error("the library has no Memory pages");
          await cdp.send("Page.navigate", { url: new URL(`${MEMORY.page}?page=${encodeURIComponent(page.slug)}`, origin).href });
          await cdp.waitFor(pageMemoryShown, page.title, { timeoutMs: 60_000, what: `the Memory page "${page.title}"` });
          return page.slug;
        });
      }

      if (signedIn) {
        await check("a PDF can be added and opens", async () => {
          const nonce = randomBytes(6).toString("hex");
          const path = await cdp.evaluate(pageAddPdf, { base64: fixturePdf(nonce).toString("base64"), filename: `smoke-${nonce}.pdf`, project: `Packaged smoke ${nonce}` });
          await cdp.send("Page.navigate", { url: new URL(path, origin).href });
          await cdp.waitFor(pageShowsText, { selector: '.pdf-page[data-page="1"] .text-layer', text: `${FIXTURE_TEXT} ${nonce}` }, { timeoutMs: 60_000, what: "the first page's text" });
          return path;
        });
      }
    }
  } finally {
    cdp?.close();
    // Remembered before quitting, for the check that nothing outlives the app.
    if (!ourProcesses.length) ourProcesses = bundleProcesses(app);
    await check("the app and its backend exit on quit", async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        if (!await within(exited, 30_000)) {
          child.kill("SIGKILL");
          await within(exited, 5_000);
          throw new Error("the app did not quit within 30 s of SIGTERM and was killed");
        }
      }
      const graceMs = options.quitGraceMs ?? 20_000;
      const deadline = Date.now() + graceMs;
      let left = ourProcesses.filter(p => alive(p.pid));
      while (left.length && Date.now() < deadline) { await delay(250); left = left.filter(p => alive(p.pid)); }
      if (left.length) {
        for (const p of left) { try { process.kill(p.pid, "SIGKILL"); } catch { /* already gone */ } }
        throw new Error(`still running ${graceMs / 1000} s after the app quit, now killed: ${left.map(p => `${p.pid} ${p.args.slice(0, 400)}`).join("; ")}`);
      }
      return `${ourProcesses.length} process${ourProcesses.length === 1 ? "" : "es"} ended`;
    });
    process.removeListener("SIGINT", interrupt);
    if (results.some(r => !r.ok)) log(`\n${logTails(profile, output)}`);
    if (options.keepProfile) log(`\nprofile kept at ${profile}`);
    else removeProfile(profile);
  }

  const failed = results.filter(r => !r.ok).length;
  log(failed ? `\nSmoke FAILED: ${failed} of ${results.length} checks failed.` : `\nSmoke passed: ${results.length} checks.`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log(USAGE);
    else process.exitCode = await smoke(options);
  } catch (error) {
    console.error(error instanceof UsageError ? `${error.message}\n${USAGE}` : error);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
