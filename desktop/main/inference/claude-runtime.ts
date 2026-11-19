/** The official CLI owns Claude sign-in and token refresh. Delphi never reads
 * its credentials and never inherits an API key or an alternate provider host. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE, type ClaudeCodeProblem } from "../../frontend/app/lib/ai-connection.ts";
import { SubscriptionLimits, type UsageWindow } from "./limits.ts";
import { usageSummary, type ConnectionStatus } from "./connection.ts";

export const CLAUDE_INSTALL_URL = CLAUDE_CODE.guide;
export function claudeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Asserted, as in `backendEnv`: Next's types require a `NODE_ENV` this child never gets.
  return Object.fromEntries(["HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "LANG", "TERM"].filter(k => source[k]).map(k => [k, source[k]])) as NodeJS.ProcessEnv;
}
/** Claude Code is installed or replaced while Delphi runs; nothing here is a
 * reason to restart Delphi. The error says what the reader must do. */
export class ClaudeCodeUnavailable extends Error {
  readonly problem: ClaudeCodeProblem;
  readonly version?: string;
  constructor(problem: ClaudeCodeProblem, version?: string) {
    super(problem === "missing" ? "Claude Code is not installed on this Mac. Delphi uses it to reach your Claude subscription."
      : problem === "outdated" && !version ? "Claude Code did not report its version. Update or reinstall it."
      : `Claude Code ${version} is too old for Delphi. Update it to ${CLAUDE_CODE.minVersion} or newer.`);
    this.problem = problem;
    this.version = version;
  }
}
/** The documented install locations (native, Homebrew, npm prefixes), then PATH. */
export function claudeCandidates(home = homedir(), path = process.env.PATH ?? ""): string[] {
  return [join(home, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", join(home, ".claude/local/claude"),
    join(home, ".npm-global/bin/claude"), join(home, ".volta/bin/claude"), join(home, ".bun/bin/claude"),
    ...path.split(":").filter(p => p.startsWith("/")).map(p => join(p, "claude"))];
}
function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}
/** `command -v claude` in the reader's own login shell. An app opened from
 * Finder gets launchd's minimal PATH, not the one nvm or a custom npm prefix
 * set up in .zshrc, so ask an interactive shell. Its startup files can print
 * or stall: read only the marked line, and give up after a few seconds. */
export function shellClaude(env: NodeJS.ProcessEnv, timeoutMs = 4_000): Promise<string | undefined> {
  const shell = env.SHELL?.startsWith("/") ? env.SHELL : "/bin/zsh";
  return new Promise(resolve => {
    let stdout = "";
    const child = spawn(shell, ["-ilc", 'printf "\\n__DELPHI_CLAUDE__%s\\n" "$(command -v claude)"'], { cwd: env.HOME ?? tmpdir(), env: { ...env, TERM: "dumb" }, stdio: ["ignore", "pipe", "ignore"], detached: true });
    const settle = () => {
      clearTimeout(timer);
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Already exited. */ }
      const found = /^__DELPHI_CLAUDE__(\/.+)$/m.exec(stdout)?.[1]?.trim();
      resolve(found && executable(found) ? found : undefined);
    };
    const timer = setTimeout(settle, timeoutMs);
    child.stdout!.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-64_000); if (/__DELPHI_CLAUDE__.*\n/.test(stdout)) settle(); });
    child.once("error", settle);
    child.once("close", settle);
  });
}
/** Finds Claude Code afresh on every check, so an install made after Delphi
 * opened is used on the next status read or request. Fixed locations are
 * cheap; the shell lookup is coalesced and repeated at most every few seconds. */
export class ClaudeLocator {
  private candidates: () => string[];
  private shell: ((env: NodeJS.ProcessEnv) => Promise<string | undefined>) | false;
  private env: NodeJS.ProcessEnv;
  private shellPath?: string;
  private lookup?: Promise<string | undefined>;
  private lookedAt = -Infinity;
  constructor(options: { candidates?: () => string[]; shell?: ((env: NodeJS.ProcessEnv) => Promise<string | undefined>) | false; env?: NodeJS.ProcessEnv } = {}) {
    this.env = claudeEnvironment(options.env);
    this.candidates = options.candidates ?? (() => claudeCandidates(this.env.HOME, this.env.PATH));
    this.shell = options.shell ?? shellClaude;
  }
  async locate(): Promise<string> {
    const fixed = this.candidates().find(executable);
    if (fixed) return fixed;
    if (this.shellPath && executable(this.shellPath)) return this.shellPath;
    if (this.shell && !this.lookup && Date.now() - this.lookedAt > 3_000) {
      const shell = this.shell;
      this.lookup = shell(this.env).catch(() => undefined).finally(() => { this.lookedAt = Date.now(); this.lookup = undefined; });
    }
    this.shellPath = (await this.lookup) ?? this.shellPath;
    if (this.shellPath && executable(this.shellPath)) return this.shellPath;
    throw new ClaudeCodeUnavailable("missing");
  }
}
export function claudeVersionProblem(version: string): ClaudeCodeProblem | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return "outdated";
  const have = match.slice(1).map(Number), need = CLAUDE_CODE.minVersion.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] > need[i] ? undefined : "outdated";
  return undefined;
}
/** Kill only our own process group, with a bounded fallback for stuck children. */
export async function stopClaude(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 250);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    try { process.kill(-child.pid!, "SIGTERM"); } catch { clearTimeout(timer); resolve(); }
  });
}
/** `install` is present only when Claude Code cannot serve, with what to run. */
export type ClaudeStatus = ConnectionStatus & { installed: boolean; install?: { problem: ClaudeCodeProblem; version?: string; command: string } };
export class ClaudeConnection {
  readonly limits = new SubscriptionLimits(Date.now, "Claude");
  private locate: () => string | Promise<string>;
  private env: NodeJS.ProcessEnv;
  private pending?: ChildProcess;
  private loginGeneration = 0;
  private loginError?: string;
  private usageAccount?: string;
  private usageGeneration = 0;
  private weeklyUsage?: UsageWindow;
  private usageRefresh?: { generation: number; done: Promise<void> };
  private commands = new Set<ChildProcess>();
  private stopped = false;
  private clearUsage(): void { this.limits.reset(); this.weeklyUsage = undefined; this.usageAccount = undefined; this.usageGeneration++; }
  /** Native stream metadata, never a credential read or a separate inference call.
   * Fence late responses across sign-in changes; missing/expired data is unknown. */
  usageReporter(): (info: unknown) => boolean {
    const generation = this.usageGeneration;
    return info => {
      if (generation !== this.usageGeneration) return false;
      if (!info || typeof info !== "object") return true;
      const windows = (info as { unifiedWindows?: Record<string, unknown> }).unifiedWindows;
      if (!windows || typeof windows !== "object") return true;
      const week = windows.seven_day as { utilization?: unknown; resetsAt?: unknown } | undefined;
      this.weeklyUsage = week && typeof week.utilization === "number" && Number.isFinite(week.utilization)
        && week.utilization >= 0 && week.utilization <= 1 && typeof week.resetsAt === "number"
        && Number.isFinite(week.resetsAt) && week.resetsAt * 1000 > Date.now()
        ? { usedPercent: week.utilization * 100, resetAt: week.resetsAt * 1000, windowMinutes: 7 * 1440 } : undefined;
      return true;
    };
  }
  constructor(options: { locate?: () => string | Promise<string>; env?: NodeJS.ProcessEnv } = {}) {
    this.env = claudeEnvironment(options.env);
    if (options.locate) this.locate = options.locate;
    else { const locator = new ClaudeLocator({ env: this.env }); this.locate = () => locator.locate(); }
  }
  private run(path: string, args: string[], input?: string): Promise<{ code: number | null; text: string }> {
    if (this.stopped) return Promise.reject(new Error("Claude connection is stopping."));
    return new Promise((resolve, reject) => {
      const child = spawn(path, args, { cwd: tmpdir(), env: this.env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"], detached: true });
      this.commands.add(child);
      child.once("close", () => this.commands.delete(child));
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
      let text = "";
      const timer = setTimeout(() => { void stopClaude(child); reject(new Error("Claude Code did not respond. Retry the connection.")); }, input === undefined ? 15_000 : 5_000);
      child.stdout!.on("data", chunk => { text += String(chunk); if (text.length > 64_000) { void stopClaude(child); reject(new Error("Invalid Claude Code status.")); } });
      child.once("error", () => { clearTimeout(timer); reject(new Error("Claude Code could not start. Check its installation.")); });
      child.once("close", code => { clearTimeout(timer); resolve({ code, text }); });
    });
  }
  /** The CLI's published experimental get_usage control request fetches /usage
   * without a model turn. skip_behaviors avoids scanning the reader's transcripts.
   * Keep the last report on failure, like ChatGPT; never fall back to inference.
   * Wire contract: @anthropic-ai/claude-agent-sdk SDKControlGetUsageRequest. */
  private refreshUsage(path: string): Promise<void> {
    const generation = this.usageGeneration;
    if (this.usageRefresh?.generation === generation) return this.usageRefresh.done;
    const report = this.usageReporter();
    const done = (async () => {
      const requestId = "delphi-usage";
      const result = await this.run(path, ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
        "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--settings", '{"disableAllHooks":true,"autoMemoryEnabled":false}', "--no-session-persistence", "--no-chrome", "--disable-slash-commands"],
        JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "get_usage", skip_behaviors: true } }) + "\n");
      if (result.code !== 0) return;
      for (const line of result.text.trim().split("\n")) {
        const event = JSON.parse(line);
        if (event.type !== "control_response" || event.response?.request_id !== requestId || event.response?.subtype !== "success") continue;
        const data = event.response.response;
        if (typeof data?.rate_limits_available !== "boolean") return; // An incompatible CLI is not an empty window.
        const week = data.rate_limits_available ? data.rate_limits?.seven_day : undefined;
        report({ unifiedWindows: { seven_day: week && {
          utilization: typeof week.utilization === "number" ? week.utilization / 100 : undefined,
          resetsAt: typeof week.resets_at === "string" ? Date.parse(week.resets_at) / 1000 : undefined,
        } } });
        return;
      }
    })().catch(() => {}).finally(() => { if (this.usageRefresh?.done === done) this.usageRefresh = undefined; });
    this.usageRefresh = { generation, done };
    return done;
  }
  async runtime(): Promise<{ path: string; version: string; env: NodeJS.ProcessEnv }> {
    const path = await this.locate();
    const version = (await this.run(path, ["--version"])).text.trim().split(" ")[0];
    const problem = claudeVersionProblem(version);
    if (problem) throw new ClaudeCodeUnavailable(problem, version || undefined);
    return { path, version, env: this.env };
  }
  async status({ refreshUsage = false } = {}): Promise<ClaudeStatus> {
    if (this.pending) return { connected: false, signingIn: true, installed: true };
    let runtime;
    try { runtime = await this.runtime(); }
    catch (error) {
      if (!(error instanceof ClaudeCodeUnavailable)) return { connected: false, signingIn: false, installed: true, message: (error as Error).message };
      return { connected: false, signingIn: false, installed: false, message: error.message,
        install: { problem: error.problem, version: error.version, command: error.problem === "missing" ? CLAUDE_CODE.install : CLAUDE_CODE.update } };
    }
    try {
      const result = await this.run(runtime.path, ["auth", "status", "--json"]);
      const account = JSON.parse(result.text);
      if (result.code !== 0 || !account.loggedIn) { this.clearUsage(); return { connected: false, signingIn: false, installed: true, message: this.loginError }; }
      if (account.authMethod !== "claude.ai") { this.clearUsage(); return { connected: false, signingIn: false, installed: true, message: "Sign in with a Claude subscription, not an API account." }; }
      const identity = JSON.stringify([account.email, account.orgId, account.subscriptionType]);
      if (identity !== this.usageAccount) { this.clearUsage(); this.usageAccount = identity; }
      if (typeof account.subscriptionType === "string") this.limits.report({ plan_type: account.subscriptionType, rate_limit: {} });
      if (refreshUsage) await this.refreshUsage(runtime.path);
      if (this.weeklyUsage?.resetAt && this.weeklyUsage.resetAt <= Date.now()) this.weeklyUsage = undefined;
      const usage = usageSummary({ ...this.limits.snapshot(), secondary: this.weeklyUsage });
      return { connected: true, signingIn: false, installed: true, usage };
    } catch { return { connected: false, signingIn: false, installed: true, message: "Could not read Claude Code sign-in. Sign in again and retry." }; }
  }
  async ready(): Promise<void> {
    const status = await this.status();
    if (status.install) throw new ClaudeCodeUnavailable(status.install.problem, status.install.version);
    if (!status.connected) throw new Error(status.message ?? "Sign in with Claude before continuing.");
  }
  async login(): Promise<void> {
    if (this.pending) throw new Error("A Claude sign-in is already in progress.");
    const generation = ++this.loginGeneration;
    const runtime = await this.runtime();
    if (generation !== this.loginGeneration) return; // The setup window closed during discovery.
    this.loginError = undefined;
    this.clearUsage();
    const child = spawn(runtime.path, ["auth", "login", "--claudeai"], { cwd: tmpdir(), env: this.env, stdio: "ignore", detached: true });
    this.pending = child;
    const timer = setTimeout(() => { this.loginError = "Sign-in timed out. Try again."; void this.cancel(); }, 5 * 60_000);
    child.once("error", () => { this.loginError = "Sign-in couldn’t start. Reinstall Claude Code and try again."; });
    child.once("close", code => {
      clearTimeout(timer);
      if (this.pending === child) {
        this.pending = undefined;
        if (code !== 0 && !this.loginError) this.loginError = "Sign-in didn’t finish. Try again.";
      }
    });
  }
  async cancel(): Promise<void> { this.loginGeneration++; const child = this.pending; this.pending = undefined; if (child) await stopClaude(child); }
  async logout(): Promise<void> {
    await this.cancel();
    this.clearUsage();
    const runtime = await this.runtime();
    if ((await this.run(runtime.path, ["auth", "logout"])).code !== 0) throw new Error("Claude Code could not sign out. Retry.");
  }
  stop(): void { this.stopped = true; void this.cancel(); for (const child of this.commands) void stopClaude(child); }
}
