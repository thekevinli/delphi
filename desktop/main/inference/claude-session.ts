/** One Claude Code process and the MCP endpoint it calls, kept while Delphi
 * extends its conversation. The transport runs each request as one turn here.
 * Between turns the process waits on stdin, or on calls held open until the
 * next request brings Delphi's output for them. */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { stopClaude } from "./claude-runtime.ts";
import type { Item } from "./claude-protocol.ts";

/** What the current request does with the process's output. */
export interface Turn {
  /** Whether this response may call the tool. The listing never changes, so
   * a withheld tool is refused when called, not hidden. */
  permits(name: string): boolean;
  /** A permitted call reached MCP and is held for Delphi. */
  called(): void;
  line(line: string): void;
  /** The process is gone; `message` when it never started. */
  ended(message?: string): void;
}
type Result = { isError?: boolean; content: Item[] };
const HANDED_BACK: Result = { isError: true, content: [{ type: "text", text: "The tool call was handed back to Delphi." }] };
const WITHHELD: Result = { isError: true, content: [{ type: "text", text: "This tool may not be called on this response. Use a tool this response allows, or answer." }] };
// Claude Code abandons an HTTP MCP call after five idle minutes by default.
// A held call waits for Delphi to run it, so it may wait as long as the session.
const HELD_CALL_MS = 30 * 60_000;
// Claude Code saves a longer MCP result to a file and shows the model a
// preview, which it cannot read here. Delphi has already bounded each result.
const RESULT_SIZE = "anthropic/maxResultSizeChars", RESULT_CHARS = 1_000_000;

export class ClaudeSession {
  readonly id = randomUUID();
  readonly scratch = mkdtempSync(join(tmpdir(), "delphi-claude-"));
  /** The last request's input, one JSON string per item, the calls it ended on,
   * and the final answer it gave, if it ended on one. */
  seen: string[] = [];
  pending: string[] = [];
  said = "";
  busy = true;
  restedAt = 0;
  private resumable = true;
  private turn?: Turn;
  private child?: ChildProcess;
  private idle?: ReturnType<typeof setTimeout>;
  private held = new Map<string, (result: Result) => void>();
  private early = new Map<string, Result>();
  private mcpServers = new Set<Server>();
  private token = randomBytes(32).toString("hex");
  private closing?: Promise<void>;
  /** Where Claude Code keeps what it saves for this working directory, such as
   * a fetched PDF too large to show. Removing only the scratch directory left
   * those behind in the reader's Claude Code folder after the conversation
   * ended. Delphi touches nothing else there: the name is derived from this
   * process's own scratch directory, which no other Claude Code use shares. */
  private saved?: string;
  private server = createServer(async (req, res) => {
    const actual = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${this.token}`);
    if (req.headers.origin || req.headers["sec-fetch-site"] || req.url !== "/mcp" || actual.length !== expected.length || !timingSafeEqual(actual, expected) || this.closing) {
      req.resume(); res.writeHead(403); res.end(); return;
    }
    const mcp = new Server({ name: "delphi-inference", version: "1.0.0" }, { capabilities: { tools: {} } });
    this.mcpServers.add(mcp);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    // These callbacks only hand proposed calls back to Delphi; they never
    // execute them. Read-only scheduling lets native web tools finish beside
    // that pending handoff, instead of waiting for the MCP call to time out.
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools.map(t => ({ name: t.name, description: t.description, annotations: { readOnlyHint: true }, inputSchema: { ...t.parameters, type: "object" as const }, _meta: { [RESULT_SIZE]: RESULT_CHARS } })) }));
    mcp.setRequestHandler(CallToolRequestSchema, async request => {
      // Claude Code names the tool_use a call answers; without it, a later
      // request cannot be matched to this call and the process ends with the turn.
      const use = request.params._meta?.["claudecode/toolUseId"];
      const id = typeof use === "string" ? use : randomUUID();
      // A call from a batch already handed to Delphi can reach MCP after its
      // turn ended; it was permitted then.
      const turn = this.pending.includes(id) ? undefined : this.turn;
      if (!turn && !this.pending.includes(id) || turn && !turn.permits(request.params.name)) return WITHHELD;
      if (typeof use !== "string") this.resumable = false;
      const result = new Promise<Result>(resolve => {
        const answer = this.early.get(id);
        if (answer) { this.early.delete(id); resolve(answer); }
        else this.held.set(id, resolve);
      });
      turn?.called();
      return await result;
    });
    res.once("close", () => { this.mcpServers.delete(mcp); void mcp.close(); });
    try { await mcp.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy(); }
  });
  readonly key: string;
  /** Whether the account this process was started under is still Delphi's; reports usage. */
  readonly report: (info: unknown) => boolean;
  private tools: Item[];
  private closed: (session: ClaudeSession) => void;
  constructor(key: string, tools: Item[], report: (info: unknown) => boolean, closed: (session: ClaudeSession) => void) {
    this.key = key; this.tools = tools; this.report = report; this.closed = closed;
    // A held call is a response still being written; Node's request timeout must not end it.
    this.server.requestTimeout = 0;
  }
  get live(): boolean { return !this.closing && this.report(undefined); }
  begin(turn: Turn): void { clearTimeout(this.idle); this.turn = turn; this.busy = true; }
  async start(path: string, env: NodeJS.ProcessEnv, args: (mcp: string) => string[], prompt: Item[]): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
    if (this.closing) { this.server.close(); return; }
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Could not start Claude's local tool connection.");
    // Server-level alwaysLoad makes Claude Code await tool discovery before
    // its first prompt (up to its 5-second connect limit), rather than connect
    // in the background: https://code.claude.com/docs/en/mcp#exempt-a-server-from-deferral
    const delphi = { type: "http", url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: `Bearer ${this.token}` }, timeout: HELD_CALL_MS, alwaysLoad: true };
    const own = realpathSync(this.scratch).replace(/[^A-Za-z0-9]/g, "-");
    if (env.HOME && /-delphi-claude-[A-Za-z0-9-]+$/.test(own)) this.saved = join(env.HOME, ".claude", "projects", own);
    const child = this.child = spawn(path, args(JSON.stringify({ mcpServers: this.tools.length ? { delphi } : {} })), { cwd: this.scratch, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin!.on("error", () => {});
    // Never log stderr or transcript contents: both can contain source text.
    child.stderr!.resume();
    child.once("error", () => { this.turn?.ended("Claude Code could not start. Check its installation."); void this.close(); });
    child.once("close", () => { this.turn?.ended(); void this.close(); });
    createInterface({ input: child.stdout! }).on("line", line => {
      if (this.turn) { this.turn.line(line); return; }
      // Between turns the process is waiting. Output means it acted on its own.
      try { if (["rate_limit_event", "system"].includes(JSON.parse(line).type)) return; } catch { /* closed below */ }
      void this.close();
    });
    this.send(prompt);
  }
  /** `written` runs once the message is in the pipe: a large one (a figure) is
   * not, when `write` returns. */
  send(content: Item[], written?: () => void): void { this.child?.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n", () => written?.()); }
  /** Delphi's outputs, by the tool_use each answers. One whose call has not reached MCP yet waits for it. */
  answer(results: Map<string, Item[]>): void {
    for (const [id, content] of results) {
      const resolve = this.held.get(id);
      if (resolve) { this.held.delete(id); resolve({ content }); }
      else this.early.set(id, { content });
    }
  }
  /** The turn is over and the process may serve the next request in this conversation. */
  rest(seen: string[], pending: string[], idleMs: number, said = ""): boolean {
    this.turn = undefined;
    if (!this.resumable || this.closing) { void this.close(); return false; }
    this.seen = seen; this.pending = pending; this.said = said; this.busy = false; this.restedAt = Date.now();
    this.idle = setTimeout(() => void this.close(), idleMs);
    return true;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const turn = this.turn;
    this.turn = undefined;
    this.closing = this.shutdown();
    turn?.ended();
    return this.closing;
  }
  private async shutdown(): Promise<void> {
    clearTimeout(this.idle);
    for (const resolve of this.held.values()) resolve(HANDED_BACK);
    this.held.clear();
    if (this.child) await stopClaude(this.child);
    this.server.closeAllConnections();
    await Promise.allSettled([...this.mcpServers].map(mcp => mcp.close()));
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    rmSync(this.scratch, { recursive: true, force: true });
    if (this.saved) rmSync(this.saved, { recursive: true, force: true });
    this.closed(this);
  }
}
