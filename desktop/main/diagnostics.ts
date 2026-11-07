/**
 * Help → Copy Diagnostics: the block a reader pastes into a bug report.
 *
 * It goes into private messages now and public issues later, so the whole block
 * passes through `redact` before it reaches the clipboard: keys, tokens,
 * cookies, signup codes, email addresses, and the home folder and account name
 * that identify the reader never leave the Mac in it. Each fact is read on its
 * own; one that cannot be read says so in the block and is logged, and the copy
 * still happens.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { cpus, release } from "node:os";
import { basename } from "node:path";
import { AI_CONNECTIONS, CLAUDE_CODE } from "../frontend/app/lib/ai-connection.ts";
import { ClaudeCodeUnavailable } from "./inference/claude-runtime.ts";
import { readProfile, type StoredConfig } from "./profile.ts";

export interface DiagnosticsSources {
  appVersion: string;
  packaged: boolean;
  home: string;
  /** `backend-wheel.receipt` from the runtime build: version, wheel, SHA-256. */
  receipt: string;
  profile: string;
  backendLog: string;
  state: string;
  claude: () => Promise<{ path: string; version: string }>;
  /** Values that are secret whatever their shape; removed verbatim. */
  secrets: ReadonlyArray<string | undefined>;
  claudeTimeoutMs?: number;
}

export const LOG_LINES = 300;

export const DIAGNOSTICS_COPIED =
  `The clipboard has Delphi's version and build, your Mac's model and macOS version, the AI connection type, ` +
  `whether Claude Code was found, the built-in browser engine, and the last ${LOG_LINES} lines of the backend log. Keys, tokens, ` +
  `cookies, email addresses and your user name were taken out; read it over before you send it.`;

/**
 * Stamped by `build/main.sh`: the checkout's commit, marked when the tree had
 * uncommitted changes, or "unknown" when the build had no git. Source that runs
 * unbundled, as the tests do, has no stamp.
 */
declare const DELPHI_BUILD_COMMIT: string | undefined;
export const BUILD_COMMIT = typeof DELPHI_BUILD_COMMIT === "string" && DELPHI_BUILD_COMMIT ? DELPHI_BUILD_COMMIT : "unknown";

/** The plain-text block, already redacted. Never throws. */
export async function collectDiagnostics(sources: DiagnosticsSources): Promise<string> {
  let profile: StoredConfig | undefined;
  let connection: string;
  try {
    profile = readProfile(sources.profile);
    connection = connectionName(profile);
  } catch (error) { connection = failed("the profile", error); }

  const claudeCode = await claudeStatus(sources);
  const model = fact("the chip", () => cpus()[0]?.model.trim() || "unknown chip");
  const sections: Array<[string, Array<[string, string]>]> = [
    ["App", [
      ["Delphi", `${sources.appVersion} (${sources.packaged ? "packaged" : "development run"})`],
      ["Electron", process.versions.electron ?? "not running under Electron"],
      ["Build commit", BUILD_COMMIT],
      ["Core (backend)", fact("the runtime receipt", () => coreVersion(sources.receipt))],
      ["State", sources.state],
    ]],
    ["Mac", [
      ["macOS", fact("the macOS version", () => `${process.getSystemVersion?.() ?? "unknown"} (Darwin ${release()})`)],
      ["Chip", `${model}, ${process.arch}${process.arch === "x64" && model.startsWith("Apple") ? " under Rosetta" : ""}`],
    ]],
    ["Connection", [
      ["AI connection", connection],
      ["Claude Code", claudeCode],
      // Capture, previews and draft checks run in Electron's own Chromium (`browser-host.ts`).
      ["Browser engine", process.versions.chrome ? `Chromium ${process.versions.chrome}, built in` : "not running under Electron"],
    ]],
  ];

  let log: string;
  try {
    const lines = logTail(sources.backendLog);
    log = lines.length ? lines.join("\n") : "(empty)";
  } catch (error) {
    log = (error as NodeJS.ErrnoException).code === "ENOENT" ? "(no backend log yet)" : failed("the backend log", error);
  }

  const text = [
    `Delphi diagnostics, ${new Date().toISOString()}`,
    ...sections.map(([title, rows]) => [`\n${title}`, ...rows.map(([label, value]) => `  ${label}: ${value}`)].join("\n")),
    `\nBackend log, last ${LOG_LINES} lines of ${sources.backendLog}`,
    log,
  ].join("\n");
  return redact(text, { home: sources.home, names: [profile?.username, basename(sources.home)], secrets: [...sources.secrets, profile?.apiKey, profile?.claudeApiKey, profile?.sessionSecret, profile?.accountPassword] }) + "\n";
}

function failed(what: string, error: unknown): string {
  console.error(`[delphi] diagnostics could not read ${what}:`, error);
  return `unavailable (${(error instanceof Error ? error.message : String(error)).split("\n")[0]})`;
}

function fact(what: string, read: () => string): string {
  try { return read(); } catch (error) { return failed(what, error); }
}

/** The type only: never a key, a token or the account behind a subscription. */
export function connectionName(profile: StoredConfig | undefined): string {
  // An unversioned profile with a key predates the connection choice.
  const id = profile?.connectionId ?? (profile?.apiKey ? "openai-api" : undefined);
  if (!id) return "not set up";
  if (id === "claude-api") return "Claude API key";
  if (id !== "openai-api") return `${AI_CONNECTIONS[id].name} subscription`;
  return profile?.apiBaseUrl ? "OpenAI API key, custom provider URL" : "OpenAI API key";
}

export function coreVersion(receipt: string): string {
  const [version, asset, sha] = readFileSync(receipt, "utf8").split("\n");
  if (!version || !asset || !sha) throw new Error("the runtime receipt is incomplete");
  return `${version} (${asset}, sha256 ${sha.slice(0, 12)})`;
}

/** Found, outdated or missing, by the lookup the Claude connection itself uses. */
async function claudeStatus(sources: DiagnosticsSources): Promise<string> {
  const limit = sources.claudeTimeoutMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const found = await Promise.race([
      sources.claude(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${limit / 1000}s`)), limit); }),
    ]);
    return `found, ${found.version} at ${found.path}`;
  } catch (error) {
    if (error instanceof ClaudeCodeUnavailable) {
      return error.problem === "missing" ? "not found"
        : `outdated, ${error.version ?? "no version reported"} (needs ${CLAUDE_CODE.minVersion} or newer)`;
    }
    return failed("Claude Code", error);
  } finally { clearTimeout(timer); }
}

/**
 * The last lines of a log, reading at most its last megabyte: `backend.log` is
 * appended to for the life of the profile and is never rotated.
 */
export function logTail(path: string, lines = LOG_LINES, maxBytes = 1 << 20): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    // One byte more than the limit, so a read that starts on a line boundary
    // drops only that boundary's empty remainder below, never a whole line.
    const start = size > maxBytes ? size - maxBytes - 1 : 0;
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (!count) break;
      read += count;
    }
    const all = buffer.subarray(0, read).toString("utf8").split(/\r?\n/);
    if (start > 0) all.shift(); // Begins mid-line.
    if (all.at(-1) === "") all.pop();
    return all.slice(-lines).map(line => line.length > 2_000 ? `${line.slice(0, 2_000)} … (line cut)` : line);
  } finally { closeSync(fd); }
}

export interface RedactionContext {
  home: string;
  /** The local account name and the macOS short name: either identifies the reader. */
  names: ReadonlyArray<string | undefined>;
  secrets: ReadonlyArray<string | undefined>;
}

const SECRET = "<redacted>";
const HEADER = "authorization|proxy-authorization|set-cookie|cookie|x-api-key|api-key";
const SECRET_KEY = String.raw`[\w-]*(?:api[_-]?key|token|secret|password|passwd|signup[_-]?code|invite[_-]?code)`;
// `t` is the signed page and thumbnail token; `q` and `url` are what the reader searched and saved.
const QUERY = "t|token|access_token|key|code|state|sig|signature|q|url";

const RULES: ReadonlyArray<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  // Quoted pairs, as JSON, Python reprs and ASGI's raw `(b'name', b'value')` headers print them.
  [new RegExp(String.raw`(b?(["'])(?:${HEADER})\2\s*[:,]\s*)(b?(["']))(?:(?!\4)[^\n])*\4`, "gi"), `$1$3${SECRET}$4`],
  // Header lines and key=value pairs, and quoted names with any other value: the rest of the line.
  [new RegExp(String.raw`(\b(?:${HEADER})["']?\s*[:=]\s*)(?!\s*b?["']?${SECRET})[^\n]+`, "gi"), `$1${SECRET}`],
  [/(\bdelphi_session=)[^;\s"'&]+/g, `$1${SECRET}`],
  [/\b(Bearer)\s+[\w.~+/=-]{8,}/gi, `$1 ${SECRET}`],
  // Base64 with a digit or symbol in it, so "Basic configuration" survives.
  [/\b(Basic)\s+(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{12,}={0,2}/g, `$1 ${SECRET}`],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, SECRET],
  [/\b(?:sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AIza[\w-]{30,}|AKIA[0-9A-Z]{16})/g, SECRET],
  // A value whose quote never closes, as on a line cut short, is still a value.
  [new RegExp(String.raw`(\b${SECRET_KEY}["']?\s*[:=]\s*)(?:(["'])(?:(?!\2)[^\n])*\2|["']?[^\s"'&,;)}\]]+)`, "gi"),
    (_match, prefix, quote) => quote ? `${prefix}${quote}${SECRET}${quote}` : `${prefix}${SECRET}`],
  [new RegExp(String.raw`([?&](?:${QUERY})=)[^&\s"'#]+`, "gi"), `$1${SECRET}`],
  [/[\w.%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, "<email>"],
];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function redact(text: string, context: RedactionContext): string {
  let out = text;
  for (const secret of context.secrets) if (secret && secret.length >= 8) out = out.split(secret).join(SECRET);
  for (const [pattern, replacement] of RULES) {
    out = typeof replacement === "string" ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  }
  if (context.home.length > 1) {
    for (const home of [context.home, encodeURIComponent(context.home)]) {
      out = out.replace(new RegExp(`(?<![\\w.-])${escape(home)}(?![\\w.-])`, "g"), "~");
    }
  }
  // `reader` is the name given when the macOS one is unusable; it identifies no one.
  for (const name of new Set(context.names)) {
    if (name && name.length >= 3 && name !== "reader") {
      out = out.replace(new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`, "gi"), "<user>");
    }
  }
  return out;
}
