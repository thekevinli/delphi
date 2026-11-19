/**
 * The ChatGPT subscription connection, presented to the backend as the OpenAI
 * API it already speaks.
 *
 * The backend is configured with this loopback URL as its API base and a fresh
 * per-launch token as its API key, so it needs no subscription-specific code:
 * `/responses` goes to the subscription endpoint, with PDFs already inline:
 * the backend is told this provider has no Files API. No request can reach a paid API account, because no API key exists in this mode.
 *
 * Failures are per request. A usage limit is the one condition that stops later
 * requests locally, until the reset time the provider reported.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as pause } from "node:timers/promises";
import { relayResponses, upstreamHeaders, upstreamRequest, type ProviderEvent } from "./direct-provider.ts";
import { isUsageLimit, type SubscriptionLimits } from "./limits.ts";

type Item = Record<string, any>;
export interface Upstream { responses(payload: unknown, signal?: AbortSignal, headers?: Record<string, string>): Promise<Response>; stop?(): Promise<void>; refreshAccount?(): Promise<void> }
export interface BridgeLogEntry {
  route: string; status: number; ms: number; model?: string; stream?: boolean; bytes?: number; inlineBytes?: number;
  inputTokens?: number; cachedTokens?: number; outputTokens?: number; error?: string; errorCode?: string; webSearches?: number;
  /** Short hashes of the cacheable prefix: instructions, tools, then the first input items. */
  prefix?: string[];
  attempt?: number; delivered?: boolean; lastEvent?: string; causeCode?: string;
}
export interface BridgeOptions {
  upstream: Upstream; limits: SubscriptionLimits;
  log?: (entry: BridgeLogEntry) => void;
  /** Largest total of inline source bytes per request; defaults to `MAX_INLINE`. */
  maxInline?: number;
  provider?: "ChatGPT" | "Claude";
  prime?: boolean;
  /** The request as the upstream takes it. Defaults to the ChatGPT endpoint's
   * shaping; a Claude API key takes the backend's request as written, output
   * ceiling and cache breakpoints included, and translates it itself. */
  shape?: (payload: Item) => Item;
}
export interface InferenceBridge {
  url: string; token: string; readonly active: number;
  /** Refuses new requests, lets in-flight ones end within `graceMs`, then closes. */
  stop(graceMs?: number): Promise<void>;
}

// Room for MAX_INLINE of documents once base64 has grown them by a third.
const MAX_JSON = 144 * 1024 * 1024;
const STREAM_ATTEMPTS = 3;
const MAX_RETRY_PRELUDE_BYTES = 256 * 1024;
// A busy provider says so in the stream ("Our servers are currently overloaded");
// that is no answer from the model, so it is retried like a dropped stream, after a pause.
const TRANSIENT_FAILURES = new Set(["server_is_overloaded", "server_error", "slow_down"]);
const TRANSIENT_PAUSE_MS = 1500;

// Reasoning is provisional: losing it must not strand an already rendered
// draft awaiting inspection. Hold only this known prelude, never a tool or
// answer; stream metadata says nothing either. Unknown events commit the stream too. The byte bound flushes rather
// than retaining an arbitrarily large response or silently discarding it.
function retryPrelude(event: ProviderEvent): boolean {
  if (["response.created", "response.in_progress", "response.metadata"].includes(event.type)) return true;
  if (event.type === "response.output_item.added" || event.type === "response.output_item.done") return event.item?.type === "reasoning";
  return ["response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
    "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
    "response.reasoning_text.delta", "response.reasoning_text.done"].includes(event.type);
}
// Priming pays off only for documents the provider would otherwise re-read in
// full; below this it costs a round trip for little.
// A memory bound, not the provider's: the endpoint accepted 52 MB of PDFs in one
// request (131,878 input tokens), so the model's context window is what limits a
// multi-document question, and the endpoint reports that itself.
export const MAX_INLINE = 100 * 1024 * 1024;
const PRIME_MIN_BYTES = 32 * 1024;
const PRIME_TTL_MS = 20 * 60_000;
const PRIME_LIMIT_MS = 120_000;

export class BridgeError extends Error {
  status: number; code?: string; param?: string; retryAfter?: number;
  constructor(status: number, message: string, extra: { code?: string; param?: string; retryAfter?: number } = {}) {
    super(message); this.status = status; Object.assign(this, extra);
  }
}

/** Provider text is shown to the reader; never let a credential ride along. */
export function sanitize(text: string): string {
  return text.replace(/Bearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]").replace(/eyJ[\w-]{10,}\.[\w-]+\.[\w-]+/g, "[redacted]").slice(0, 600);
}

export async function upstreamError(response: Response, limits: SubscriptionLimits, provider = "ChatGPT"): Promise<BridgeError> {
  const text = await response.text().catch(() => "");
  let body: any;
  try { body = JSON.parse(text); } catch { /* Not JSON. */ }
  if (response.status === 429 && isUsageLimit(body)) {
    const rejection = limits.reject(body, response.headers);
    return new BridgeError(429, rejection.message, { code: rejection.code, retryAfter: rejection.retryAfter });
  }
  limits.observe(response.headers);
  const error = body?.error && typeof body.error === "object" ? body.error : {};
  const raw = error.message ?? body?.detail ?? (typeof body?.error === "string" ? body.error : "");
  const detail = typeof raw === "string" && raw ? sanitize(raw) : "";
  if (response.status === 401) return new BridgeError(401, typeof error.code === "string" && error.code.endsWith("_reauth_required") && detail ? detail : `${provider} sign-in has expired. Reconnect in Delphi → AI Connection, then retry.`, { code: `${provider.toLowerCase()}_reauth_required` });
  if (response.status === 429) {
    return new BridgeError(429, detail || `${provider} is busy. Delphi will retry shortly.`, { code: "rate_limit_exceeded", retryAfter: Number(response.headers.get("retry-after")) || 5 });
  }
  // Claude's local adapter supplies code-owned messages, never CLI error prose.
  // Keep that diagnosis instead of replacing every local failure with a 502.
  if (provider === "Claude" && typeof error.code === "string" && error.code.startsWith("claude_")) {
    return new BridgeError(response.status, detail || "Claude Code could not finish this response.", { code: error.code });
  }
  if (response.status >= 500) return new BridgeError(502, `${provider} is temporarily unavailable (status ${response.status}). Retry shortly.`, { code: "upstream_unavailable" });
  return new BridgeError(response.status, detail || `${provider} rejected the request (status ${response.status}).`,
    { code: typeof error.code === "string" ? error.code : undefined, param: typeof error.param === "string" ? error.param : undefined });
}

async function readJson(request: IncomingMessage): Promise<Item> {
  // A bounded inference message: documents arrive inline, and MAX_INLINE is
  // enforced on them once parsed.
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_JSON) throw new BridgeError(413, "The request is too large for the subscription connection.");
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new BridgeError(400, "Invalid JSON request."); }
}

/**
 * Where two turns of one conversation stop sharing a prefix, which is where the
 * provider's prompt cache stops helping. Hashes only; no content is logged.
 */
export function prefixFingerprint(request: Item): string[] {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 8);
  const input = Array.isArray(request.input) ? request.input : [request.input];
  return [hash(request.instructions), hash(request.tools), ...input.slice(0, 4).map(hash)];
}

/**
 * The documents a conversation keeps sending: its leading message, when that
 * message is large (attached PDFs, or a project's digests). It stays the same
 * turn after turn. Undefined for a request that is only that message, or has
 * nothing large.
 */
export function stablePrefix(input: unknown): Item[] | undefined {
  if (!Array.isArray(input) || input.length < 2 || input.at(-1)?.role !== "user") return undefined;
  const first = input[0];
  if (first?.role !== "user" || JSON.stringify(first).length < PRIME_MIN_BYTES) return undefined;
  return [first];
}

/**
 * The document bytes a request carries inline, refused past `limit`. The
 * endpoint has no file store, and neither does this bridge: a file id here
 * names a file in some other provider's store.
 */
export function measureInlineFiles(request: Item, limit = MAX_INLINE, provider = "ChatGPT"): number {
  let total = 0;
  for (const item of Array.isArray(request.input) ? request.input : []) {
    if (!Array.isArray(item?.content)) continue;
    for (const block of item.content) {
      if (block?.type !== "input_file") continue;
      if (typeof block.file_id === "string") {
        throw new BridgeError(404, `No such File object: ${block.file_id}`, { code: "file_not_found", param: "file_id" });
      }
      const data = typeof block.file_data === "string" ? block.file_data : "";
      const encoded = data.slice(data.indexOf(",") + 1);
      total += Math.floor(encoded.length * 3 / 4);
      if (total > limit) {
        throw new BridgeError(413, `These documents are too large to send together over the ${provider} connection. Ask about fewer documents at once; nothing was sent.`, { code: "input_too_large" });
      }
    }
  }
  return total;
}

function authorized(request: IncomingMessage, token: string): boolean {
  if (request.headers.origin || request.headers["sec-fetch-site"]) return false;
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, error: BridgeError): void {
  sendJson(response, error.status, { error: { message: error.message, type: error.status === 401 ? "authentication_error" : "invalid_request_error",
    code: error.code ?? null, param: error.param ?? null } }, error.retryAfter ? { "retry-after": String(error.retryAfter) } : {});
}

export async function startInferenceBridge(options: BridgeOptions): Promise<InferenceBridge> {
  const provider = options.provider ?? "ChatGPT";
  const shape = options.shape ?? upstreamRequest;
  const token = randomBytes(32).toString("hex");
  const active = new Set<AbortController>();
  let stopping = false;
  const log = (entry: BridgeLogEntry) => { try { options.log?.(entry); } catch { /* Logging never fails a request. */ } };

  async function send(payload: Item, signal: AbortSignal): Promise<Response> {
    // Claude Code can switch accounts outside Delphi. Recheck identity before
    // reusing a cached refusal; this makes no inference request.
    if (options.limits.check()) await options.upstream.refreshAccount?.();
    const refusal = options.limits.check();
    if (refusal) throw new BridgeError(429, refusal.message, { code: refusal.code, retryAfter: refusal.retryAfter });
    let upstream: Response;
    try { upstream = await options.upstream.responses(shape(payload), signal, upstreamHeaders(payload)); }
    catch (error) {
      if (signal.aborted) throw error;
      // Our own sign-in and Keychain messages, or a network failure.
      const message = error instanceof Error && /sign|Keychain|ChatGPT|Claude/i.test(error.message) ? error.message : `Could not reach ${provider}. Check the network connection, then retry.`;
      throw new BridgeError(/sign|Keychain/i.test(message) ? 401 : 502, message, { code: `${provider.toLowerCase()}_unavailable` });
    }
    if (!upstream.ok) throw await upstreamError(upstream, options.limits, provider);
    options.limits.observe(upstream.headers);
    return upstream;
  }

  /**
   * The subscription endpoint sometimes drops a stream mid-response, and Codex
   * retries it the same way. A retry is safe only while nothing has reached the
   * backend: always for a buffered response, and for a relayed stream until its
   * first answer/tool event (a bounded reasoning prelude is held until then). A failure
   * the model itself reported is not retried.
   */
  async function relay(payload: Item, signal: AbortSignal, emit?: (event: ProviderEvent) => void): Promise<Item> {
    for (let attempt = 1; ; attempt++) {
      const upstream = await send(payload, signal);
      const held: ProviderEvent[] = [];
      let heldBytes = 0;
      let delivered = false;
      let lastEvent: string | undefined;
      try {
        return await relayResponses(upstream, event => {
          lastEvent = /^[a-z_.]{1,96}$/.test(event.type) ? event.type : "unknown";
          if (!emit) return;
          if (!delivered && retryPrelude(event)) {
            const bytes = Buffer.byteLength(JSON.stringify(event));
            if (heldBytes + bytes <= MAX_RETRY_PRELUDE_BYTES) { held.push(event); heldBytes += bytes; return; }
          }
          if (!delivered) { delivered = true; held.splice(0).forEach(emit); }
          emit(event);
        }, provider);
      } catch (error) {
        if (signal.aborted) throw error;
        const failure = error as { streamed?: boolean; code?: string };
        const reported = Boolean(failure.streamed) && !TRANSIENT_FAILURES.has(failure.code ?? "");
        const retry = !delivered && !reported && attempt < STREAM_ATTEMPTS;
        const cause = (error as { cause?: { code?: unknown } }).cause?.code;
        log({ route: retry ? "responses.retry" : "responses.interrupted", status: 502, ms: 0,
          model: payload.model, attempt, delivered, lastEvent,
          causeCode: typeof cause === "string" && /^[A-Z0-9_]{1,64}$/.test(cause) ? cause : undefined,
          error: sanitize(error instanceof Error ? error.message : "stream dropped") });
        if (delivered || reported || attempt >= STREAM_ATTEMPTS) {
          throw new BridgeError(502, sanitize(error instanceof Error ? error.message : `${provider} did not finish this response.`), { code: "response_failed" });
        }
        if (failure.streamed) await pause(TRANSIENT_PAUSE_MS * attempt, undefined, { signal });
      }
    }
  }
  const complete = (payload: Item, signal: AbortSignal) => relay(payload, signal);

  /**
   * The endpoint caches the whole prompt of a request, not an arbitrary prefix
   * of it. A conversation's turns share their documents and then differ, so a
   * follow-up re-reads the documents: measured at 9,856 of 44,305 input tokens
   * cached. Sending the documents as a prompt of their own, stopped as soon as
   * the model starts to answer, leaves an entry every later turn extends
   * (40,320 of 44,330).
   *
   * It is sent once per conversation and only after the turn it rides on has
   * begun to answer, in the background. It used to be sent first and waited
   * for, which made the reader wait for it too: 13 s on a 7.6 MB paper on a
   * good day and 68 s on a bad one. A cached prompt was not measurably faster
   * to answer than an uncached one, so nothing is lost by the first turn
   * going without. Best effort: it fails silently and is logged.
   */
  const primed = new Map<string, number>();
  const priming = new Set<AbortController>();
  function primeAfter(payload: Item): void {
    if (options.prime === false || stopping || typeof payload.prompt_cache_key !== "string" || options.limits.check()) return;
    const prefix = stablePrefix(payload.input);
    if (!prefix) return;
    const request: Item = { ...payload, input: prefix };
    const key = createHash("sha256").update(JSON.stringify([payload.prompt_cache_key, request.model, request.instructions, request.tools, request.text, request.reasoning, prefix])).digest("hex");
    const started = Date.now();
    for (const [entry, expiry] of primed) if (expiry < started) primed.delete(entry);
    if (primed.has(key)) return;
    primed.set(key, started + PRIME_TTL_MS);
    const controller = new AbortController();
    priming.add(controller);
    const limit = setTimeout(() => controller.abort(), PRIME_LIMIT_MS);
    void (async () => {
      let status = 0;
      try {
        const response = await options.upstream.responses(shape(request), controller.signal, upstreamHeaders(payload));
        status = response.status;
        options.limits.observe(response.headers);
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("refused"); }
        // The prompt has been read once the model starts its answer.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (/"type":\s*"response\.(output_item\.added|output_text\.delta|reasoning)/.test(text)) break;
          if (text.length > 256 * 1024) text = text.slice(-4096);
        }
        log({ route: "responses.prime", status: 200, ms: Date.now() - started, model: payload.model });
      } catch {
        primed.delete(key);
        log({ route: "responses.prime", status: status >= 400 ? status : 502, ms: Date.now() - started, model: payload.model });
      } finally { clearTimeout(limit); controller.abort(); priming.delete(controller); }
    })();
  }

  async function responses(request: IncomingMessage, response: ServerResponse, controller: AbortController): Promise<BridgeLogEntry> {
    const started = Date.now();
    const payload = await readJson(request);
    if (typeof payload.model !== "string" || !payload.model) throw new BridgeError(400, "A model is required.", { param: "model" });
    const entry: BridgeLogEntry = { route: "responses", status: 200, ms: 0, model: payload.model, stream: payload.stream === true };
    entry.prefix = prefixFingerprint(payload);
    entry.inlineBytes = measureInlineFiles(payload, options.maxInline, provider);
    const record = (response: Item) => {
      const value = response.usage;
      entry.inputTokens = value?.input_tokens; entry.outputTokens = value?.output_tokens; entry.cachedTokens = value?.input_tokens_details?.cached_tokens;
      const searches = (response.output ?? []).filter((item: Item) => item?.type === "web_search_call").length;
      if (searches) entry.webSearches = searches;
    };
    if (!payload.stream) {
      const completed = await relay(payload, controller.signal);
      record(completed);
      sendJson(response, 200, completed);
      primeAfter(payload);
      return { ...entry, ms: Date.now() - started };
    }
    // Errors before the first byte (limits, sign-in, rejected requests) are
    // still ordinary HTTP errors; only a started stream reports in-band.
    // The backend hangs up as soon as it has read the completed event, often
    // before the provider has closed its side. That call finished: its usage is
    // taken from the event as it passes, and the hang-up is not a failure.
    let finished = false;
    const write = (event: ProviderEvent) => {
      if (event.type === "response.completed" && event.response) { record(event.response); finished = true; }
      if (controller.signal.aborted) return;
      // The reader has something to watch from here on.
      if (!response.headersSent) primeAfter(payload);
      if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    try { record(await relay(payload, controller.signal, write)); }
    catch (error) {
      if (finished && controller.signal.aborted) return { ...entry, ms: Date.now() - started };
      if (!response.headersSent) throw error;
      if (controller.signal.aborted) throw error;
      // Headers are sent; report the failure the way the provider streams one.
      const message = sanitize(error instanceof Error ? error.message : `${provider} did not finish this response.`);
      write({ type: "response.failed", response: { status: "failed", error: { code: "response_failed", message } } });
      entry.status = 502; entry.error = message;
    }
    response.end();
    return { ...entry, ms: Date.now() - started };
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    if (!authorized(request, token)) { request.resume(); response.writeHead(403); response.end(); return; }
    if (stopping) { request.resume(); response.writeHead(503); response.end(); return; }
    const url = new URL(request.url ?? "/", "http://bridge.invalid");
    const parts = url.pathname.split("/").filter(Boolean);
    const controller = new AbortController();
    active.add(controller);
    response.on("close", () => { if (!response.writableEnded) controller.abort(); active.delete(controller); });
    const started = Date.now();
    try {
      if (parts[0] !== "v1") throw new BridgeError(404, "Unknown route.");
      const [, resource, id] = parts;
      if (request.method === "POST" && resource === "responses" && !id) {
        log(await responses(request, response, controller));
      } else throw new BridgeError(404, "Unknown route.");
    } catch (error) {
      request.resume();
      if (controller.signal.aborted) { response.destroy(); return; }
      const failure = error instanceof BridgeError ? error : new BridgeError(500, "The local inference bridge failed.");
      if ((error as any)?.status === 404 && !(error instanceof BridgeError)) failure.status = 404;
      log({ route: parts.slice(1, 2).join("/") || "unknown", status: failure.status, ms: Date.now() - started, error: failure.message, errorCode: failure.code });
      if (response.headersSent) response.destroy(); else sendError(response, failure);
    } finally { active.delete(controller); }
  }

  const server: Server = createServer((request, response) => { void handle(request, response); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind the inference bridge.");
  return {
    url: `http://127.0.0.1:${address.port}/v1`, token,
    get active() { return active.size; },
    async stop(graceMs = 0) {
      stopping = true;
      const deadline = Date.now() + graceMs;
      while (active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      for (const controller of [...active, ...priming]) controller.abort();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await options.upstream.stop?.();
    },
  };
}
