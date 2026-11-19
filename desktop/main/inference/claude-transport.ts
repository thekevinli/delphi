/** Claude Code supplies inference only. MCP advertises the request's tools but
 * never executes them: each function-call batch goes back to Delphi, which
 * already owns dispatch, staging, budgets and commit.
 *
 * One Claude Code process serves a conversation while Delphi extends it: a
 * call stays open over MCP until the next request brings Delphi's output, and
 * a new user message goes to the same stdin. Anthropic reads its prompt cache
 * only where an earlier request marked it, and a new process per round resends
 * history whose marked end never recurs. A filing read 17% of its input from
 * cache that way, and about 98% of each call's prompt in one process. So the
 * process's tools and system prompt stay fixed, and which tools a response may
 * call is enforced where a call arrives. A request that extends no live process
 * starts one from replayed history. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sanitize, type Upstream } from "./bridge.ts";
import { ClaudeCodeUnavailable, ClaudeConnection } from "./claude-runtime.ts";
import { ClaudeSession, type Turn } from "./claude-session.ts";
import { CLAUDE_MODELS, CLAUDE_EFFORTS } from "../../frontend/app/lib/claude-models.ts";
import { CLAUDE_TOOL_PREFIX, claudeFailure, claudeToolDefinitions, claudeToolName, claudeToolText, citations, continuation, nativeResume, permittedTools, permitsWeb, webSources, type Continuation, type Item } from "./claude-protocol.ts";

// A cache entry lives five minutes from its last read, and after that a new
// process costs the same, so no process waits longer. Each idle one holds
// 240-380 MB. One waiting on held calls has Delphi mid-round. One that gave a
// final answer is kept mainly for a repair, which follows its check by about a
// minute (54-55 s measured); a chat's next turn continues it only when that
// turn called no Delphi tool, since Delphi's chat history drops tool rounds.
const IDLE_MS = 5 * 60_000;
const ANSWERED_IDLE_MS = 2 * 60_000;
const IDLE_SESSIONS = 2;
/** The text of a tool result, as Delphi sent it or as Claude Code echoes it. */
const resultText = (content: unknown) => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((b: Item) => b?.type === "text").map((b: Item) => b.text).join("\n") : "";
const errorResponse = (status: number, message: string, code = "claude_unavailable") => Response.json({ error: { message, code } }, { status });
const functions = (payload: Item): Item[] => (payload.tools ?? []).filter((t: Item) => t.type === "function");
/** What a process is started with. Requests that differ here cannot share one. */
const sessionKey = (payload: Item, web: boolean) => JSON.stringify([payload.model, payload.reasoning?.effort ?? "medium", payload.instructions ?? "", functions(payload), web,
  payload.text?.format?.type === "json_schema" ? payload.text.format.schema : null]);
type Runtime = { path: string; version: string; env: NodeJS.ProcessEnv };

export class ClaudeTransport implements Upstream {
  private connection: ClaudeConnection;
  private sessions = new Set<ClaudeSession>();
  private timeoutMs: number;
  private idleMs: number;
  private answeredIdleMs: number;
  constructor(connection: ClaudeConnection, options: { timeoutMs?: number; idleMs?: number; answeredIdleMs?: number } = {}) {
    this.connection = connection;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.answeredIdleMs = options.answeredIdleMs ?? Math.min(this.idleMs, ANSWERED_IDLE_MS);
  }
  async refreshAccount(): Promise<void> { await this.connection.status(); }
  async responses(value: unknown, signal?: AbortSignal): Promise<Response> {
    const payload = value as Item;
    if (!Object.hasOwn(CLAUDE_MODELS, payload.model)) return errorResponse(400, "Choose a Claude model offered by Delphi.", "model_not_supported");
    if (!CLAUDE_EFFORTS.includes(payload.reasoning?.effort ?? "medium")) return errorResponse(400, "Claude supports low, medium, high and xhigh effort in Delphi.", "invalid_effort");
    if ((payload.tools ?? []).some((t: Item) => !["function", "web_search", "web_search_preview"].includes(t.type))) return errorResponse(400, "This hosted tool is not supported by Claude.", "unsupported_tool");
    let runtime: Runtime;
    try { await this.connection.ready(); runtime = await this.connection.runtime(); }
    catch (error) {
      // Same status and code as an expired sign-in: the reader is told to act, and the backend does not retry at once.
      const fix = error instanceof ClaudeCodeUnavailable ? " See Settings → Advanced → AI connection, then retry." : "";
      return errorResponse(401, sanitize((error as Error).message + fix), "claude_reauth_required");
    }
    const refusal = this.connection.limits.check();
    if (refusal) return errorResponse(429, refusal.message, refusal.code);
    signal?.throwIfAborted();
    const key = sessionKey(payload, permitsWeb(payload));
    let next: Continuation | undefined;
    let session = [...this.sessions].find(s => {
      if (s.busy || s.key !== key) return false;
      // A process signed in to an account Delphi no longer uses serves nothing more.
      if (!s.live) { void s.close(); return false; }
      return Boolean(next = continuation(s.seen, s.pending, payload.input, s.said));
    });
    if (!session) {
      session = new ClaudeSession(key, claudeToolDefinitions(functions(payload)), this.connection.usageReporter(), closed => this.sessions.delete(closed));
      this.sessions.add(session);
    }
    return this.turn(session, payload, next, runtime, signal);
  }
  /** Closes the longest-idle processes beyond the few worth keeping. */
  private trim(): void {
    const idle = [...this.sessions].filter(s => !s.busy).sort((a, b) => a.restedAt - b.restedAt);
    for (const s of idle.slice(0, Math.max(0, idle.length - IDLE_SESSIONS))) void s.close();
  }
  private turn(session: ClaudeSession, payload: Item, next: Continuation | undefined, runtime: Runtime, signal?: AbortSignal): Promise<Response> {
    const structured = payload.text?.format?.type === "json_schema";
    const permitted = permittedTools(payload), web = permitsWeb(payload);
    const note = payload.tool_choice === "none" ? "No tools may be called on this response. Finish the request using the evidence already in the conversation."
      : payload.tool_choice ? `Only these local tools may be called on this response: ${permitted.map(t => CLAUDE_TOOL_PREFIX + t.name).join(", ")}. Do not substitute another tool for one that is unavailable.` : "";
    const seen = payload.input.map((i: Item) => JSON.stringify(i));
    return new Promise<Response>(resolve => {
      let delivered = false, done = false, recoveredName = false;
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; }, cancel() { cancel(); } });
      const encoder = new TextEncoder();
      const sendStream = () => { if (!delivered) { delivered = true; resolve(new Response(stream, { headers: { "content-type": "text/event-stream" } })); } };
      const emit = (event: Item) => {
        if (done) return;
        sendStream();
        streamController.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      /** The response is over. With `pending`, the process waits for this
       * conversation's next request (on those calls, or on stdin); otherwise it ends. */
      const settle = (pending?: string[], said = "") => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        // An alias never reached MCP, so there is no held call to answer. End
        // that process and replay the canonical call/result on the next round;
        // do not let its unknown-tool error trigger a second model generation.
        if (!recoveredName && pending && (pending.length || functions(payload).length) && session.rest(seen, pending, pending.length ? this.idleMs : this.answeredIdleMs, said)) this.trim();
        else void session.close();
      };
      const fail = (message: string, status = 502, code = "claude_response_failed") => {
        if (done) return;
        if (!delivered) resolve(errorResponse(status, sanitize(message), code));
        else emit({ type: "response.failed", response: { status: "failed", output: [], error: { message: sanitize(message), code } } });
        done = true; streamController.close(); settle();
      };
      function cancel() {
        if (done) return;
        done = true;
        if (!delivered) resolve(errorResponse(499, "Claude request cancelled.", "cancelled"));
        // A reader that cancelled the stream has already closed it.
        else try { streamController.close(); } catch { /* closed */ }
        settle();
      }
      const batch: Item[] = [], hosted = new Map<string, Item>(), sources = new Map<string, Item>();
      const indices = new Map<string, number>(), completed = new Set<string>();
      const index = (id: string) => { if (!indices.has(id)) indices.set(id, indices.size); return indices.get(id)!; };
      let assistantError: unknown, strayCalls = 0;
      let text = "", messageEnded = false, called = false, textBoundary = false;
      let inputTokens = 0, outputTokens = 0, cachedTokens = 0, currentInput = 0, currentOutput = 0, currentCached = 0;
      for (const i of payload.input) if (i.type === "web_search_call" && i.status === "completed") for (const source of i.action?.sources ?? []) sources.set(source.url, source);
      const message = (answer: string): Item => ({ id: `msg_${randomUUID()}`, type: "message", role: "assistant", content: [{ type: "output_text", text: answer, annotations: citations(answer, sources) }] });
      const finish = (output: Item[], pending: string[], said = "") => {
        if (done) return;
        for (const item of output) if (!completed.has(item.id)) emit({ type: "response.output_item.done", output_index: index(item.id), item });
        const response = { id: `resp_${randomUUID()}`, status: "completed", output, usage: { input_tokens: inputTokens, output_tokens: outputTokens, input_tokens_details: { cached_tokens: cachedTokens } } };
        emit({ type: "response.completed", response });
        done = true; streamController.close(); settle(pending, said);
      };
      const announce = () => {
        if (done || !messageEnded || !called || !batch.length || [...hosted.values()].some(i => i.status === "in_progress")) return;
        finish([...hosted.values(), ...(text ? [message(text)] : []), ...batch], batch.map(b => b.call_id));
      };
      /** Unknown or withheld tools remain unavailable. Claude Code or the MCP
       * endpoint answers with an error and the model calls an allowed one;
       * nothing runs. Fail only if that keeps happening. A tool name is
       * code-owned, never document text; name it when it looks like one. */
      const stray = (name: unknown, what: string) => {
        if (++strayCalls <= 3) return;
        throw new Error(`Claude kept requesting ${what}${typeof name === "string" && /^[\w.-]{1,80}$/.test(name) ? ` (${name})` : ""}.`);
      };
      /** Delphi's outputs this response hands to held calls, by call, and
       * whether a user message written beside them is still unacknowledged.
       * Claude Code echoes each result it gives the model, and a queued
       * message when it joins the next model call. A result that differs was
       * replaced (a call that timed out, a result saved to a file and shown as
       * an error), and a message not yet echoed would reach the model a round
       * late. Either way the process is dropped before any output and the
       * shared bridge's retry replays the conversation into a new one, where
       * results and messages travel in its history. */
      const handed = new Map<string, string>();
      let queued = false;
      const drop = () => {
        if (done) return;
        sendStream(); done = true;
        streamController.error(new Error("Claude Code did not deliver Delphi's tool result."));
        settle();
      };
      const turn: Turn = {
        permits: name => permitted.some(t => t.name === name),
        called: () => { called = true; announce(); },
        ended: problem => {
          if (done) return;
          if (problem) { fail(problem); return; }
          // The shared bridge retries a dropped stream only before anything
          // visible was delivered, exactly as it does for ChatGPT.
          sendStream(); done = true;
          streamController.error(new Error("Claude Code stopped before completing the response."));
          settle();
        },
        line: line => {
          if (done) return;
          try {
            const e = JSON.parse(line);
            if (e.type === "system" && e.subtype === "init" && e.apiKeySource && e.apiKeySource !== "none") { fail("Claude API billing is disabled. Sign in with a Claude subscription.", 401, "claude_reauth_required"); return; }
            if (e.type === "rate_limit_event" && !session.report(e.rate_limit_info)) {
              fail("Claude account changed during this request. Retry with the connected account.", 401, "claude_reauth_required"); return;
            }
            if (e.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected") {
              const rejection = this.connection.limits.reject({ error: { resets_at: e.rate_limit_info.resetsAt } }, new Headers());
              fail(rejection.message, 429, rejection.code); return;
            }
            if (e.type === "stream_event") {
              const v = e.event;
              // Every result Delphi handed over is echoed before the model is called again.
              if (v.type === "message_start" && (handed.size || queued)) { drop(); return; }
              if (v.type === "message_start") { const u = v.message?.usage ?? {}; currentInput = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0); currentCached = u.cache_read_input_tokens ?? 0; currentOutput = 0; textBoundary = Boolean(text); messageEnded = false; }
              if (v.type === "content_block_start" && v.content_block?.type === "tool_use" && v.content_block.name.startsWith(CLAUDE_TOOL_PREFIX) && turn.permits(v.content_block.name.slice(CLAUDE_TOOL_PREFIX.length))) {
                const b = v.content_block, id = `fc_${b.id}`;
                emit({ type: "response.output_item.added", output_index: index(id), item: { id, type: "function_call", call_id: b.id, name: b.name.slice(CLAUDE_TOOL_PREFIX.length), arguments: "" } });
              }
              if (v.type === "content_block_delta" && v.delta?.type === "text_delta") {
                if (textBoundary) { text += "\n\n"; if (!structured) emit({ type: "response.output_text.delta", delta: "\n\n" }); textBoundary = false; }
                text += v.delta.text; if (!structured) emit({ type: "response.output_text.delta", delta: v.delta.text });
              }
              if (v.type === "message_delta") currentOutput = v.usage?.output_tokens ?? currentOutput;
              if (v.type === "message_stop") { inputTokens += currentInput; cachedTokens += currentCached; outputTokens += currentOutput; messageEnded = true; announce(); }
            }
            if (e.type === "assistant") {
              assistantError = e.error;
              for (const b of e.message?.content ?? []) {
                if (b.type !== "tool_use") continue;
                const name = claudeToolName(b.name, functions(payload));
                if (name !== undefined) {
                  if (turn.permits(name)) {
                    batch.push({ id: `fc_${b.id}`, call_id: b.id, type: "function_call", name, arguments: JSON.stringify(b.input) });
                    if (b.name !== CLAUDE_TOOL_PREFIX + name) { recoveredName = true; called = true; }
                  }
                  else stray(name, "a tool withheld for this response");
                } else if (web && ["WebSearch", "WebFetch"].includes(b.name)) {
                  const item = { id: b.id, type: "web_search_call", status: "in_progress", action: b.name === "WebSearch" ? { type: "search", query: b.input.query, sources: [] } : { type: "open_page", url: b.input.url, sources: [] }, _claude_history: [{ role: "assistant", content: [b] }] };
                  hosted.set(b.id, item); emit({ type: "response.output_item.added", output_index: index(b.id), item });
                } else if (b.name !== "StructuredOutput") stray(b.name, "an unavailable tool");
              }
              announce();
            }
            if (e.type === "user" && e.isReplay) queued = false;
            if (e.type === "user") for (const result of e.message?.content ?? []) {
              const sent = handed.get(result.tool_use_id);
              if (sent !== undefined) {
                handed.delete(result.tool_use_id);
                if (result.is_error || resultText(result.content) !== sent) { drop(); return; }
                continue;
              }
              const item = hosted.get(result.tool_use_id); if (!item) continue;
              item.status = result.is_error ? "failed" : "completed"; item._claude_history.push({ role: "user", content: [result] });
              // WebFetch has no title metadata; retain the title already supplied by search.
              item.action.sources = webSources(item, result).map(source => item.action.type === "open_page" ? sources.get(source.url) ?? source : source);
              for (const source of item.action.sources) sources.set(source.url, source);
              emit({ type: "response.output_item.done", output_index: index(item.id), item }); completed.add(item.id); announce();
            }
            if (e.type === "result") {
              if (e.is_error) {
                const error = claudeFailure(assistantError, e.subtype);
                fail(error.message, error.status, error.code); return;
              }
              const answer = e.structured_output ? JSON.stringify(e.structured_output) : text || e.result || "";
              if (!answer.trim()) { fail("Claude returned no final answer. Retry the question."); return; }
              if (e.structured_output || !text) emit({ type: "response.output_text.delta", delta: answer });
              finish([...hosted.values(), message(answer)], [], answer);
            }
          } catch (error) { fail(error instanceof SyntaxError ? "Claude returned an invalid response. Check its installation and retry." : (error as Error).message); }
        },
      };
      const timer = setTimeout(() => fail("Claude took too long to finish. Retry the question."), this.timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });
      session.begin(turn);
      if (next) {
        // The restriction is a user turn after what this request adds, so the cached prompt before it stays the same.
        const message = note ? [...next.message, { type: "text", text: note }] : next.message;
        if ("results" in next) {
          // Written before the results are released, so it is queued when they reach the model.
          for (const [id, content] of next.results) handed.set(id, resultText(content));
          if (message.length) { queued = true; session.send(message, () => session.answer(next.results)); }
          else session.answer(next.results);
        } else session.send(message);
        return;
      }
      void (async () => {
        try {
          const history = nativeResume(payload.input, session.id, session.scratch, runtime.version);
          const prompt = note ? [...history.prompt, { type: "text", text: note }] : history.prompt;
          await session.start(runtime.path, runtime.env, mcp => {
            const names = [...functions(payload).map(t => CLAUDE_TOOL_PREFIX + t.name), ...(web ? ["WebSearch", "WebFetch"] : [])];
            const args = ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--replay-user-messages", "--model", payload.model, "--effort", payload.reasoning?.effort ?? "medium",
              "--tools", web ? "WebSearch,WebFetch" : "", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", mcp,
              // Rounds come seconds apart; the subscription's default one-hour entry costs more to write.
              "--settings", '{"disableAllHooks":true,"autoMemoryEnabled":false,"promptCacheTtl":"5m"}',
              "--disable-slash-commands", "--no-chrome", "--no-session-persistence", "--permission-mode", "dontAsk", "--system-prompt", claudeToolText(payload.instructions ?? "", functions(payload))];
            if (names.length) args.push("--allowedTools", ...names);
            if (structured) args.push("--json-schema", JSON.stringify(payload.text.format.schema));
            if (history.hasHistory) { const path = join(session.scratch, "history.jsonl"); writeFileSync(path, history.transcript, { mode: 0o600 }); args.push("--resume", path, "--fork-session"); }
            return args;
          }, prompt);
        } catch (error) { fail(error instanceof SyntaxError ? "Claude returned an invalid response. Check its installation and retry." : (error as Error).message); }
      })();
    });
  }
  async stop(): Promise<void> { await Promise.all([...this.sessions].map(s => s.close())); }
}
