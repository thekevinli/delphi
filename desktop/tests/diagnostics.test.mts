/** Help → Copy Diagnostics: what the block says, and what it must never say. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

import { CLAUDE_CODE } from "../frontend/app/lib/ai-connection.ts";
import { collectDiagnostics, connectionName, logTail, redact, LOG_LINES, type DiagnosticsSources } from "../main/diagnostics.ts";
import { ClaudeCodeUnavailable } from "../main/inference/claude-runtime.ts";

const HOME = "/Users/marguerite";
const SESSION_SECRET = "5e4f1c0a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f";
const BRIDGE_TOKEN = "per-launch-bridge-7Qx2Lm9Rt4Vw";

/* Every value a real log could carry that must not reach a bug report. */
const PLANTED = {
  openaiKey: "sk-proj-AbCdEf0123456789GhIjKlMnOpQrStUv",
  anthropicToken: "sk-ant-oat01-ZyXwVu9876543210TsRqPoNm",
  bearer: "ya29.a0AfB_byC1d2e3f4g5h6",
  bearerLine: "opaque-access-0f9e8d7c6b5a",
  basic: "dXNlcjpwYXNzd29yZDEyMw==",
  jwt: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXZhbHVl",
  sessionInDict: "s3ss10nDictV4lue.Zm9vYmFy",
  sessionInAsgi: "s3ss10nAsgiV4lue.YmFyYmF6",
  sessionInSetCookie: "s3ss10nSetV4lue.cXV4cXV4",
  sessionBare: "s3ss10nBareV4lue.Y29yZ2U=",
  otherCookie: "theme-dark-preference",
  xApiKey: "xk-live-4f3e2d1c0b9a",
  inviteCode: "friends of delphi 2026",
  signupCode: "LetMeIn-2026",
  password: "correct-horse-battery",
  pageToken: "pgtok.MTIzNDU2.c2lnbmVk",
  search: "my+private+search",
  savedUrl: "https%3A%2F%2Fexample.com%2Fprivate",
  email: "friend.name+delphi@example.org",
  emailEncoded: "someone%40icloud.com",
  sessionSecret: SESSION_SECRET,
  bridgeToken: BRIDGE_TOKEN,
};

const LOG = [
  `INFO:     127.0.0.1:50211 - "GET /api/projects/p1/papers/d1/thumbnail?v=3&t=${PLANTED.pageToken} HTTP/1.1" 200 OK`,
  `INFO:     127.0.0.1:50212 - "GET /api/search?q=${PLANTED.search} HTTP/1.1" 200 OK`,
  `INFO:     127.0.0.1:50213 - "PUT /api/projects/p1/papers/d1/saved-page?width=1200&url=${PLANTED.savedUrl} HTTP/1.1" 200 OK`,
  `INFO:     127.0.0.1:50214 - "GET /@marguerite/library HTTP/1.1" 200 OK`,
  `DEBUG request headers: {'authorization': 'Bearer ${PLANTED.bearer}', 'cookie': 'delphi_session=${PLANTED.sessionInDict}; theme=${PLANTED.otherCookie}'}`,
  `DEBUG raw headers: [(b'host', b'127.0.0.1'), (b'cookie', b'delphi_session=${PLANTED.sessionInAsgi}')]`,
  `Authorization: Bearer ${PLANTED.bearerLine}`,
  `Set-Cookie: delphi_session=${PLANTED.sessionInSetCookie}; HttpOnly; Path=/; SameSite=Lax`,
  `WARNING stale cookie delphi_session=${PLANTED.sessionBare} ignored`,
  `x-api-key: ${PLANTED.xApiKey}`,
  `{"headers": {"Authorization": "Basic ${PLANTED.basic}"}, "invite_code": "${PLANTED.inviteCode}"}`,
  `OPENAI_API_KEY=${PLANTED.openaiKey} SIGNUP_CODE=${PLANTED.signupCode}`,
  `WARNING retrying with access_token=${PLANTED.jwt}`,
  `ERROR upstream rejected ${PLANTED.anthropicToken}`,
  `ERROR login failed password=${PLANTED.password}`,
  `INFO signed in as ${PLANTED.email} (${PLANTED.emailEncoded})`,
  `ERROR could not open /Users/marguerite/Library/Application Support/Delphi/data/users/marguerite/meta.json`,
  `ERROR fetch file:///Users/marguerite/Downloads/paper.pdf and %2FUsers%2Fmarguerite%2FDesktop`,
  `DEBUG session ${SESSION_SECRET} and bridge ${BRIDGE_TOKEN} somewhere unexpected`,
  // None of these is a secret, and redaction must leave them readable.
  `INFO:     127.0.0.1:50215 - "POST /api/memory/maintenance/drain HTTP/1.1" 200 OK`,
  `INFO:     127.0.0.1:50216 - "GET /api/chat/conversations?scope=paper&project_id=p1 HTTP/1.1" 200 OK`,
  `INFO usage input_tokens=1200 max_output_tokens=16`,
  `INFO Basic configuration loaded`,
  `INFO model tasks: chat.answer=gpt-6.1-sol/medium`,
  `INFO /Users/margueriteX/elsewhere is not the reader's home`,
];

const PROFILE = {
  version: 2, connectionId: "claude-subscription", username: "marguerite", chromePath: "/usr/bin/true",
  apiKey: "sk-planted-api-key", sessionSecret: "planted-session-secret", accountPassword: "planted-account-password",
};

function fixture(t: TestContext, overrides: Partial<DiagnosticsSources> = {}): DiagnosticsSources {
  const dir = mkdtempSync(join(tmpdir(), "delphi-diagnostics-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sources: DiagnosticsSources = {
    appVersion: "0.1.0", packaged: true, home: HOME,
    receipt: join(dir, "backend-wheel.receipt"), profile: join(dir, "config.json"), backendLog: join(dir, "backend.log"),
    state: "ready", claude: async () => ({ path: `${HOME}/.local/bin/claude`, version: "2.1.310" }),
    secrets: [SESSION_SECRET, BRIDGE_TOKEN, undefined],
    ...overrides,
  };
  writeFileSync(join(dir, "backend-wheel.receipt"), "0.6.9\ndelphi_backend-0.6.9-py3-none-any.whl\n6a839ecfd5c383990fd952f335ab9178bcdc33f6d7d5a7512dd36cd9a144eae7\n");
  writeFileSync(join(dir, "config.json"), JSON.stringify(PROFILE));
  writeFileSync(join(dir, "backend.log"), LOG.join("\n") + "\n");
  return sources;
}

test("the block has every section a bug report needs", async t => {
  const block = await collectDiagnostics(fixture(t));
  assert.match(block, /^Delphi diagnostics, \d{4}-\d\d-\d\dT/);
  for (const line of [
    "\nApp\n",
    "  Delphi: 0.1.0 (packaged)\n",
    // Unbundled source carries no stamp; a build's is checked below.
    "  Build commit: unknown\n",
    "  Core (backend): 0.6.9 (delphi_backend-0.6.9-py3-none-any.whl, sha256 6a839ecfd5c3)\n",
    "  State: ready\n",
    "\nMac\n",
    "\nConnection\n",
    "  AI connection: Claude subscription\n",
    "  Claude Code: found, 2.1.310 at ~/.local/bin/claude\n",
    "  Browser engine: not running under Electron\n",
    `\nBackend log, last ${LOG_LINES} lines of `,
    `"POST /api/memory/maintenance/drain HTTP/1.1" 200 OK`,
  ]) assert.ok(block.includes(line), `missing ${JSON.stringify(line)}`);
  assert.match(block, /\n {2}macOS: .+\(Darwin \d+/);
  assert.match(block, new RegExp(`\\n {2}Chip: .+, ${process.arch}`));
  // The profile's secrets are never read into the block.
  for (const secret of [PROFILE.apiKey, PROFILE.sessionSecret, PROFILE.accountPassword]) assert.ok(!block.includes(secret));
});

test("no planted secret, address or name survives redaction", async t => {
  const block = await collectDiagnostics(fixture(t));
  for (const [name, value] of Object.entries(PLANTED)) assert.ok(!block.includes(value), `${name} leaked`);
  assert.doesNotMatch(block, /marguerite(?!X)/i);
  for (const kept of [
    "thumbnail?v=3&t=<redacted>",
    "GET /@<user>/library",
    "'authorization': '<redacted>'",
    "(b'cookie', b'<redacted>')",
    "Authorization: <redacted>",
    "Set-Cookie: <redacted>",
    "x-api-key: <redacted>",
    `"invite_code": "<redacted>"`,
    "signed in as <email> (<email>)",
    "could not open ~/Library/Application Support/Delphi/data/users/<user>/meta.json",
    "file://~/Downloads/paper.pdf and ~%2FDesktop",
    // Ordinary lines are left alone.
    "?scope=paper&project_id=p1",
    "input_tokens=1200 max_output_tokens=16",
    "INFO Basic configuration loaded",
    "chat.answer=gpt-6.1-sol/medium",
    "/Users/margueriteX/elsewhere",
  ]) assert.ok(block.includes(kept), `expected ${JSON.stringify(kept)}`);
});

test("the profile's own secrets are redacted wherever the log echoes them", async t => {
  const sources = fixture(t);
  const echoed = [PROFILE.apiKey, PROFILE.sessionSecret, PROFILE.accountPassword, "gsk_customProviderKey123"];
  writeFileSync(join(sources.profile), JSON.stringify({ ...PROFILE, apiKey: echoed[3] }));
  writeFileSync(sources.backendLog, echoed.map(value => `INFO echoed ${value}`).join("\n") + "\n");
  const block = await collectDiagnostics(sources);
  for (const value of echoed.slice(1)) assert.ok(!block.includes(value), value);
});

test("redaction covers the shapes on their own", () => {
  const context = { home: HOME, names: ["marguerite"], secrets: [] };
  for (const [input, expected] of [
    ["Authorization: Bearer abcdefgh12345678", "Authorization: <redacted>"],
    ["proxy-authorization=Basic Zm9vOmJhcjEyMw==", "proxy-authorization=<redacted>"],
    [`{"set-cookie": ["delphi_session=abc123456789"]}`, `{"set-cookie": <redacted>`],
    ["sent Bearer abcdefgh12345678 upstream", "sent Bearer <redacted> upstream"],
    ["key ghp_0123456789abcdefghijABCDEFGHIJ", "key <redacted>"],
    ["refresh_token: 'rt-0123456789'", "refresh_token: '<redacted>'"],
    ["client_secret=abc&next=1", "client_secret=<redacted>&next=1"],
    [`ERROR body cut short: {"password": "hunter2-and-mo`, `ERROR body cut short: {"password": <redacted>`],
    ["callback?code=oauth-code-1&state=xyz", "callback?code=<redacted>&state=<redacted>"],
  ] as const) assert.equal(redact(input, context), expected);
});

test("each connection is named by type only", () => {
  assert.equal(connectionName({ version: 2, connectionId: "chatgpt-oauth" }), "ChatGPT subscription");
  assert.equal(connectionName({ version: 2, connectionId: "claude-subscription" }), "Claude subscription");
  assert.equal(connectionName({ version: 2, connectionId: "openai-api", apiKey: "YQ==" }), "OpenAI API key");
  assert.equal(connectionName({ version: 2, connectionId: "openai-api", apiBaseUrl: "https://proxy.example.com/v1" }), "OpenAI API key, custom provider URL");
  assert.equal(connectionName({ version: 2, connectionId: "claude-api", claudeApiKey: "sk-ant-key" }), "Claude API key");
  // An original, unversioned profile with a key predates the choice of connection.
  assert.equal(connectionName({ version: 1, apiKey: "YQ==" }), "OpenAI API key");
  assert.equal(connectionName(undefined), "not set up");
});

test("a fact that cannot be read is reported and logged, never thrown", async t => {
  const logged = t.mock.method(console, "error", () => {});
  const sources = fixture(t, { claude: async () => { throw new Error("spawn EACCES"); } });
  rmSync(sources.receipt);
  rmSync(sources.backendLog);
  writeFileSync(sources.profile, "{ not json");
  const block = await collectDiagnostics(sources);
  for (const line of [
    "  Core (backend): unavailable (",
    "  AI connection: unavailable (Profile configuration is invalid or incompatible; it has been preserved)",
    "  Claude Code: unavailable (spawn EACCES)",
    "(no backend log yet)",
  ]) assert.ok(block.includes(line), `missing ${JSON.stringify(line)}`);
  assert.ok(logged.mock.callCount() >= 3);
});

test("Claude Code is reported as missing, outdated or silent", async t => {
  const status = async (claude: DiagnosticsSources["claude"]) =>
    /Claude Code: (.*)\n/.exec(await collectDiagnostics(fixture(t, { claude, claudeTimeoutMs: 50 })))?.[1];
  t.mock.method(console, "error", () => {});
  assert.equal(await status(async () => { throw new ClaudeCodeUnavailable("missing"); }), "not found");
  assert.equal(await status(async () => { throw new ClaudeCodeUnavailable("outdated", "2.0.1"); }), `outdated, 2.0.1 (needs ${CLAUDE_CODE.minVersion} or newer)`);
  assert.equal(await status(() => new Promise(() => {})), "unavailable (no answer in 0.05s)");
});

test("the build stamps its commit, marks uncommitted changes, and never fails without git", t => {
  // The real script, with tsc and esbuild stubbed to record what they were given.
  const root = mkdtempSync(join(tmpdir(), "delphi-diagnostics-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "build"));
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  mkdirSync(join(root, "bin"));
  copyFileSync(new URL("../build/main.sh", import.meta.url), join(root, "build/main.sh"));
  writeFileSync(join(root, "node_modules/.bin/tsc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(root, "node_modules/.bin/esbuild"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${root}/esbuild.args"\n`, { mode: 0o755 });
  writeFileSync(join(root, "bin/git"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const stamped = (path = env.PATH) => {
    rmSync(join(root, "esbuild.args"), { force: true });
    const build = spawnSync("bash", ["build/main.sh"], { cwd: root, encoding: "utf8", env: { ...env, PATH: path } });
    assert.equal(build.status, 0, build.stderr);
    const define = readFileSync(join(root, "esbuild.args"), "utf8").split("\n").filter(arg => arg.startsWith("--define:DELPHI_BUILD_COMMIT="));
    assert.equal(define.length, 1, "only the main process carries the stamp");
    return JSON.parse(define[0].slice("--define:DELPHI_BUILD_COMMIT=".length));
  };
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", env }).stdout.trim();

  assert.equal(stamped(), "unknown", "outside a checkout");
  assert.equal(stamped(`${root}/bin:${env.PATH}`), "unknown", "with no git at all");
  git("init", "-q");
  git("add", "build/main.sh");
  git("commit", "-q", "-m", "fixture");
  const head = git("rev-parse", "HEAD");
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(stamped(), head);
  writeFileSync(join(root, "build/main.sh"), readFileSync(join(root, "build/main.sh"), "utf8") + "\n# edited\n");
  assert.equal(stamped(), `${head}, with uncommitted changes`);
});

test("a bundled build reports the commit it was stamped with", async t => {
  const dir = mkdtempSync(join(tmpdir(), "delphi-diagnostics-bundle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "diagnostics.mjs");
  const stamp = `${"a".repeat(40)}, with uncommitted changes`;
  const esbuild = spawnSync(fileURLToPath(new URL("../node_modules/.bin/esbuild", import.meta.url)), [
    fileURLToPath(new URL("../main/diagnostics.ts", import.meta.url)),
    "--bundle", "--platform=node", "--format=esm", `--outfile=${out}`, "--log-level=warning",
    `--define:DELPHI_BUILD_COMMIT=${JSON.stringify(stamp)}`,
  ], { encoding: "utf8" });
  assert.equal(esbuild.status, 0, esbuild.stderr);
  const bundled: typeof import("../main/diagnostics.ts") = await import(pathToFileURL(out).href);
  assert.equal(bundled.BUILD_COMMIT, stamp);
  assert.ok((await bundled.collectDiagnostics(fixture(t))).includes(`\n  Build commit: ${stamp}\n`));
});

test("the log tail is the last lines, read from the end of a long log", t => {
  const dir = mkdtempSync(join(tmpdir(), "delphi-diagnostics-tail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "backend.log");
  writeFileSync(path, Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n" + "x".repeat(5000) + "\n");
  const tail = logTail(path);
  assert.equal(tail.length, LOG_LINES);
  assert.equal(tail[0], `line ${1001 - LOG_LINES + 1}`);
  assert.equal(tail.at(-1), `${"x".repeat(2000)} … (line cut)`);
  // Reading only the last bytes drops the line the read began inside.
  assert.deepEqual(logTail(path, LOG_LINES, 5_020), ["line 999", "line 1000", `${"x".repeat(2000)} … (line cut)`]);
});
