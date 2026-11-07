/**
 * A Claude API key, presented to the backend as the OpenAI Responses API it
 * already speaks, behind the same bridge as the two plans.
 *
 * The reader's own key reaches Anthropic's Messages API directly: no Claude
 * Code process, no subscription fallback (`ai-connection.ts`). The backend's
 * request becomes a Messages request and the answer streams back as the
 * Responses events `harness/provider.py` reads.
 *
 * Each Messages response is handed back as one `reasoning` item first, its
 * sealed content the response's exact content blocks, then the message, call
 * and search items the backend acts on. The backend replays reasoning items
 * in order (`harness/replay.py`), so the next round rebuilds that assistant
 * turn from the blocks Anthropic returned, thinking signatures included,
 * rather than from Delphi's projection of them. A thinking block is honoured
 * only while everything sent before it is byte-identical, and the prompt
 * cache is a prefix match: both hold because the history is rebuilt exactly.
 * History that arrives without its envelope (chat turns the backend projects
 * to text, another provider's rounds) converts from its visible items and
 * carries no thinking.
 */
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { sanitize, type Upstream } from "./bridge.ts";
import { CLAUDE_EFFORTS, CLAUDE_MODELS } from "../../frontend/app/lib/claude-models.ts";

type Item = Record<string, any>;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
type Request = Anthropic.Beta.Messages.MessageCreateParamsStreaming;

export const ANTHROPIC_API = "https://api.anthropic.com";
/** The sealed content of a reasoning item this transport wrote. Anything else
 * in a reasoning item is another provider's and means nothing here. */
const ENVELOPE = "anthropic.v1:";
/** Anthropic accepts 32 MB per request; base64 grows a document by a third. */
export const CLAUDE_API_MAX_INLINE = 22 * 1024 * 1024;
// The backend sets `max_output_tokens` per task; this is for a request that
// names none. Streaming, so no HTTP timeout argues for less.
const DEFAULT_MAX_TOKENS = 64_000;
// A server-run search loop pauses after ten of its own iterations; resuming is
// one more request with the paused turn. Bounded, so a looping turn ends.
const MAX_CONTINUATIONS = 4;
// Anthropic runs a search itself, so nothing here can refuse one once it is
// asked for. The backend states what a turn has left (`max_tool_calls`): a
// request never resumes a paused search loop past it, and the search tool is
// left out once a round withholds it. Its own ceiling is a constant, because
// the tools array is the start of the cached prefix; this is the backend's
// default per-turn budget (`web_search_max_calls`).
const WEB_MAX_USES = 8;
// The models with a server-side fallback when a safety classifier declines.
// A research paper on a pathogen is exactly what trips the `bio` category, and
// a refused reading helps nobody; Claude Haiku 5.5 has no fallback.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
// Keywords structured outputs refuse. The backend checks lengths and counts on
// what comes back (a digest's length, a selection's size), so they are dropped
// from the schema Anthropic constrains with, never from the backend's checks.
const UNSUPPORTED_SCHEMA_KEYS = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "maxItems", "uniqueItems", "minProperties", "maxProperties"]);

interface Sealed { content: ContentBlock[]; calls: string[]; texts: string[]; searches: string[] }

/** The events a stream sends before anything the backend acts on. */
const PROVISIONAL = new Set(["response.created", "response.reasoning_summary_text.delta", "response.reasoning_summary_part.done"]);

const errorResponse = (status: number, message: string, code: string, headers: Record<string, string> = {}) =>
  Response.json({ error: { message, code } }, { status, headers });

function seal(value: Sealed): string {
  return ENVELOPE + Buffer.from(JSON.stringify(value)).toString("base64");
}
function unseal(content: unknown): Sealed | undefined {
  if (typeof content !== "string" || !content.startsWith(ENVELOPE)) return undefined;
  try { return JSON.parse(Buffer.from(content.slice(ENVELOPE.length), "base64").toString("utf8")) as Sealed; }
  catch { return undefined; }
}

const textOf = (item: Item) => (Array.isArray(item.content) ? item.content : [])
  .filter((part: Item) => part?.type === "output_text" || part?.type === "input_text").map((part: Item) => part.text ?? "").join("");

/** One Responses content part as a Messages block; `cache` marks a breakpoint. */
function block(part: Item, cache: () => boolean): Item | undefined {
  let converted: Item | undefined;
  if (part.type === "input_text" || part.type === "output_text") converted = part.text ? { type: "text", text: part.text } : undefined;
  else if (part.type === "input_file" && typeof part.file_data === "string" && part.file_data.startsWith("data:application/pdf;base64,")) {
    converted = { type: "document", source: { type: "base64", media_type: "application/pdf", data: part.file_data.slice(part.file_data.indexOf(",") + 1) } };
  } else if (part.type === "input_image" && typeof part.image_url === "string") {
    const data = /^data:(image\/[^;]+);base64,(.+)$/.exec(part.image_url);
    converted = data ? { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } } : { type: "image", source: { type: "url", url: part.image_url } };
  } else throw new Error(`Claude cannot read a ${String(part.type)} block.`);
  if (converted && part.prompt_cache_breakpoint && cache()) converted.cache_control = { type: "ephemeral" };
  return converted;
}

function blocks(content: unknown, cache: () => boolean): Item[] {
  const parts = typeof content === "string" ? [{ type: "input_text", text: content }] : Array.isArray(content) ? content : [];
  return parts.map(part => block(part, cache)).filter((b): b is Item => Boolean(b));
}

function toolInput(text: unknown): Item {
  try {
    const value = JSON.parse(typeof text === "string" ? text : "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** What the backend's input becomes as a Messages conversation. Exported for tests. */
export function messagesFrom(input: unknown): MessageParam[] {
  const items: Item[] = typeof input === "string" ? [{ role: "user", content: input }] : Array.isArray(input) ? input : [];
  const messages: MessageParam[] = [];
  // The backend marks the open document and the library as the stable prefix;
  // two breakpoints there, one on the instructions and one at the end is the
  // most Anthropic accepts.
  let breakpoints = 2;
  const cache = () => breakpoints-- > 0;
  const append = (role: "user" | "assistant", content: Item[]) => {
    if (!content.length) return;
    const last = messages.at(-1);
    if (last?.role === role) (last.content as Item[]).push(...content);
    else messages.push({ role, content } as MessageParam);
  };
  let covered: { calls: Set<string>; texts: string[]; searches: Set<string> } | undefined;
  for (const item of items) {
    if (item.type === "reasoning") {
      const sealed = unseal(item.encrypted_content);
      if (sealed) {
        append("assistant", structuredClone(sealed.content) as Item[]);
        covered = { calls: new Set(sealed.calls), texts: [...sealed.texts], searches: new Set(sealed.searches) };
      }
      continue;
    }
    // The visible items that follow an envelope are its own blocks again.
    if (covered) {
      if (item.type === "function_call" && covered.calls.has(item.call_id)) continue;
      if (item.type === "web_search_call" && covered.searches.has(item.search_id)) continue;
      if (item.role === "assistant") {
        const at = covered.texts.indexOf(textOf(item));
        if (at >= 0) { covered.texts.splice(at, 1); continue; }
      }
      covered = undefined;
    }
    if (item.type === "function_call") append("assistant", [{ type: "tool_use", id: item.call_id, name: item.name, input: toolInput(item.arguments) }]);
    else if (item.type === "function_call_output") {
      const content = typeof item.output === "string" ? item.output : blocks(item.output, cache);
      append("user", [{ type: "tool_result", tool_use_id: item.call_id, content: (typeof content === "string" ? content : content.length ? content : "") || "(no output)" }]);
    } else if (item.type === "web_search_call") {
      // Another provider's search: what it found, as the model said it.
      const sources = (item.action?.sources ?? []).map((s: Item) => s?.url).filter((u: unknown) => typeof u === "string").slice(0, 20);
      const query = item.action?.query ? ` for “${item.action.query}”` : "";
      append("assistant", [{ type: "text", text: `Searched the web${query}.${sources.length ? ` Sources: ${sources.join(", ")}` : ""}` }]);
    } else if (item.role === "user" || item.role === "assistant") append(item.role, blocks(item.content, cache));
    // System and developer turns never reach this provider from Delphi.
  }
  answerEveryCall(messages);
  return messages;
}

/**
 * Anthropic refuses a `tool_use` that the next user turn does not answer, and
 * a user turn whose tool results do not come first. Both happen: a deadline
 * can stop the backend mid-call and leave the sealed turn's calls unanswered
 * before a repair message, and an image a tool returns can arrive as user
 * content between two results. A call nothing answered is answered as not run.
 */
function answerEveryCall(messages: MessageParam[]): void {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "assistant") continue;
    const calls = (messages[i].content as Item[]).filter(b => b.type === "tool_use").map(b => b.id as string);
    const next = messages[i + 1];
    if (next?.role !== "user") {
      if (!calls.length) continue;
      messages.splice(i + 1, 0, { role: "user", content: [] } as MessageParam);
    }
    const content = messages[i + 1].content as Item[];
    const results = content.filter(b => b.type === "tool_result");
    const answered = new Set(results.map(b => b.tool_use_id));
    const unanswered = calls.filter(id => !answered.has(id)).map(id => ({ type: "tool_result", tool_use_id: id, is_error: true, content: "This call was not run." }));
    if (!unanswered.length && content.slice(0, results.length).every(b => b.type === "tool_result")) continue;
    messages[i + 1] = { ...messages[i + 1], content: [...results, ...unanswered, ...content.filter(b => b.type !== "tool_result")] } as MessageParam;
  }
}

/** A Responses JSON schema as structured outputs takes it. Exported for tests. */
export function structuredSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(structuredSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Item = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "minItems" && typeof value === "number" && value > 1) continue;
    out[key] = structuredSchema(value);
  }
  return out;
}

/** The backend's Responses request as one Messages request. Exported for tests. */
export function messagesRequest(payload: Item): Request {
  const model = String(payload.model);
  const functions = (payload.tools ?? []).filter((t: Item) => t?.type === "function");
  const isWeb = (t: Item) => t?.type === "web_search" || t?.type === "web_search_preview";
  // A round that withholds search, or a turn that has spent it, leaves the
  // tool out: a withheld function call is answered by the backend, but a
  // search Anthropic would run.
  const withheld = (payload.tool_choice?.type === "allowed_tools" && !(payload.tool_choice.tools ?? []).some(isWeb)) || payload.max_tool_calls === 0;
  const web = (payload.tools ?? []).some(isWeb) && !withheld;
  // Otherwise the same tools on every round: they are part of the cached
  // prefix and of what a thinking block was produced against. Which may be
  // called changes only through `tool_choice`, and a call to a withheld
  // function is answered by the backend itself, as for every provider.
  const tools: Item[] = functions.map((t: Item) => ({ name: t.name, description: t.description ?? "", input_schema: t.parameters ?? { type: "object", properties: {} } }));
  // The dynamic-filtering search is for the larger models; Haiku has the basic one.
  if (web) tools.push({ type: model === "claude-haiku-5-5" ? "web_search_20250305" : "web_search_20260209", name: "web_search", max_uses: WEB_MAX_USES });
  const format = payload.text?.format?.type === "json_schema" ? { type: "json_schema", schema: structuredSchema(payload.text.format.schema) } : undefined;
  const fallback = FALLBACK_MODELS.has(model);
  return {
    model,
    max_tokens: typeof payload.max_output_tokens === "number" ? payload.max_output_tokens : DEFAULT_MAX_TOKENS,
    stream: true,
    ...(payload.instructions ? { system: [{ type: "text", text: String(payload.instructions), cache_control: { type: "ephemeral" } }] } : {}),
    messages: messagesFrom(payload.input),
    ...(tools.length ? { tools, tool_choice: payload.tool_choice === "none" ? { type: "none" } : { type: "auto" } } : {}),
    // Always adaptive: these models do not turn thinking off. A block whose
    // prefix no longer matches is dropped rather than failing the request.
    thinking: { type: "adaptive", display: payload.reasoning?.summary ? "summarized" : "omitted", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort: payload.reasoning?.effort ?? "medium", ...(format ? { format } : {}) },
    cache_control: { type: "ephemeral" },
    ...(fallback ? { fallbacks: "default" } : {}),
    betas: ["thinking-binding-controls-2026-08-01", ...(fallback ? ["server-side-fallback-2026-07-01"] : [])],
  } as Request;
}

/** The SDK's error, as the bridge reports it: a code-owned sentence and a
 * `claude_` code it keeps, or the provider's own message where it is useful. */
function failure(error: unknown): Response {
  const status = error instanceof Anthropic.APIError ? error.status : undefined;
  const body = error instanceof Anthropic.APIError ? (error.error as Item | undefined)?.error : undefined;
  const detail = typeof body?.message === "string" ? sanitize(body.message) : "";
  if (error instanceof Anthropic.AuthenticationError) return errorResponse(401, "Anthropic refused this Claude API key. Replace it in Delphi → AI Connection, then retry.", "claude_key_reauth_required");
  if (error instanceof Anthropic.PermissionDeniedError) return errorResponse(403, detail || "This Claude API key may not use this model. Check its workspace in the Claude Console.", "claude_key_forbidden");
  if (error instanceof Anthropic.NotFoundError) return errorResponse(400, "This Claude model is not available to this API key. Choose another model.", "claude_model_not_found");
  if (error instanceof Anthropic.RateLimitError) {
    const retry = Number(error.headers?.get?.("retry-after")) || 5;
    return errorResponse(429, "Claude is rate-limiting this API key. Delphi will retry shortly.", "rate_limit_exceeded", { "retry-after": String(retry) });
  }
  if (status === 413) return errorResponse(413, "These documents are too large to send to Claude together. Ask about fewer documents at once; nothing was sent.", "claude_input_too_large");
  if (status === 529 || body?.type === "overloaded_error") return errorResponse(503, "Claude is at capacity. Retry shortly.", "claude_overloaded");
  if (error instanceof Anthropic.BadRequestError) return errorResponse(400, detail || "Claude rejected this request.", "claude_invalid_request");
  if (status && status >= 500) return errorResponse(502, "Claude's service could not complete this request. Retry shortly.", "claude_server_error");
  return errorResponse(502, "Claude could not complete this request. Retry shortly.", "claude_response_failed");
}

export class AnthropicTransport implements Upstream {
  private client: Anthropic;
  constructor(apiKey: string, options: { baseURL?: string; timeoutMs?: number } = {}) {
    // Every credential and host named here, so nothing in the shell's own
    // environment (an ANTHROPIC_* variable, a CLI profile) can stand in.
    this.client = new Anthropic({ apiKey, authToken: null, baseURL: options.baseURL ?? ANTHROPIC_API, maxRetries: 1, timeout: options.timeoutMs ?? 15 * 60_000 });
  }

  async responses(value: unknown, signal?: AbortSignal): Promise<Response> {
    const payload = value as Item;
    if (!Object.hasOwn(CLAUDE_MODELS, payload.model)) return errorResponse(400, "Choose a Claude model offered by Delphi.", "model_not_supported");
    if (!CLAUDE_EFFORTS.includes(payload.reasoning?.effort ?? "medium")) return errorResponse(400, "Claude supports low, medium, high and xhigh effort in Delphi.", "invalid_effort");
    let request: Request;
    try { request = messagesRequest(payload); }
    catch (error) { return errorResponse(400, sanitize((error as Error).message), "claude_invalid_request"); }
    return this.turn(request, signal, typeof payload.max_tool_calls === "number" ? payload.max_tool_calls : Infinity);
  }

  /** One Responses answer: a Messages stream, resumed while a search loop
   * pauses, and resumed with no tools once its searches reach `searchesLeft`. */
  private async turn(request: Request, signal?: AbortSignal, searchesLeft = Infinity): Promise<Response> {
    const open = (params: Request) => {
      const stream = this.client.beta.messages.stream(params, { signal });
      return { stream, events: stream[Symbol.asyncIterator]() };
    };
    let current = open(request);
    // An ordinary HTTP error until Anthropic has said anything.
    let first: IteratorResult<Anthropic.Beta.Messages.BetaRawMessageStreamEvent>;
    try { first = await current.events.next(); }
    catch (error) {
      if (signal?.aborted || error instanceof Anthropic.APIConnectionError) throw error;
      return failure(error);
    }

    const encoder = new TextEncoder();
    const output: Item[] = [];
    const usage = { input: 0, cached: 0, output: 0 };
    const searches = new Map<string, string>();
    // Pages found by earlier rounds of this turn can be cited in this one.
    const found = new Map<string, string>();
    for (const message of request.messages) if (Array.isArray(message.content)) collectResults(message.content as Item[], found);
    let delivered = false, searched = 0;
    const body = new ReadableStream<Uint8Array>({
      start: async controller => {
        const emit = (event: Item) => {
          // Reasoning is provisional: the bridge holds it back and may still
          // retry the response, so only an answer, a call or a search delivers.
          if (!PROVISIONAL.has(event.type) && !(event.type === "response.output_item.done" && event.item?.type === "reasoning")) delivered = true;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        const finish = (event: Item) => { emit(event); controller.close(); };
        emit({ type: "response.created", response: { status: "in_progress", output: [] } });
        let params = request;
        try {
          for (let segment = 0; ; segment++) {
            let thinking = "";
            // Calls and searches are announced as they start, as the Claude
            // plan's transport does; the text streams as deltas.
            const handle = (event: Anthropic.Beta.Messages.BetaRawMessageStreamEvent) => {
              if (event.type === "content_block_start") {
                const b = event.content_block as Item;
                if (b.type === "tool_use") {
                  emit({ type: "response.output_item.added", item: { id: `fc_${b.id}`, type: "function_call", call_id: b.id, name: b.name, arguments: "" } });
                } else if (b.type === "server_tool_use" && b.name === "web_search") {
                  emit({ type: "response.output_item.added", item: { id: b.id, type: "web_search_call", status: "in_progress", action: { type: "search" } } });
                }
              } else if (event.type === "content_block_delta") {
                if (event.delta.type === "text_delta" && event.delta.text) emit({ type: "response.output_text.delta", delta: event.delta.text });
                if (event.delta.type === "thinking_delta" && event.delta.thinking) { thinking += event.delta.thinking; emit({ type: "response.reasoning_summary_text.delta", delta: event.delta.thinking }); }
              } else if (event.type === "content_block_stop" && thinking) {
                emit({ type: "response.reasoning_summary_part.done" });
                thinking = "";
              }
            };
            if (!first.done) handle(first.value);
            for (;;) {
              const next = await current.events.next();
              if (next.done) break;
              handle(next.value);
            }
            const message = await current.stream.finalMessage();
            const u = message.usage as Item;
            usage.input += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            usage.cached += u.cache_read_input_tokens ?? 0;
            usage.output += u.output_tokens ?? 0;
            for (const item of itemsOf(message, searches, found)) {
              output.push(item);
              emit({ type: "response.output_item.done", output_index: output.length - 1, item });
            }
            searched += (message.content as Item[]).filter(b => b.type === "server_tool_use" && b.name === "web_search").length;
            if (message.stop_reason === "pause_turn" && segment < MAX_CONTINUATIONS) {
              params = { ...params, messages: [...params.messages, { role: "assistant", content: message.content } as MessageParam],
                // A filtering search paused inside its code resumes in that code's
                // container; without it Anthropic refuses, or reruns the code and searches again.
                ...(message.container ? { container: message.container.id } : {}),
                // The turn's searches are spent: the answer is written from what they found.
                ...(searched >= searchesLeft ? { tool_choice: { type: "none" } } : {}) } as Request;
              current = open(params);
              first = await current.events.next();
              continue;
            }
            const totals = { input_tokens: usage.input, output_tokens: usage.output, input_tokens_details: { cached_tokens: usage.cached } };
            if (message.stop_reason === "refusal") {
              finish({ type: "response.failed", response: { status: "failed", output, usage: totals, error: { code: "claude_refusal", message: "Claude declined this request." } } });
            } else if (message.stop_reason === "max_tokens") {
              finish({ type: "response.incomplete", response: { status: "incomplete", output, usage: totals, incomplete_details: { reason: "max_output_tokens" },
                error: { code: "max_output_tokens", message: "Claude reached its output limit before finishing. Ask for a shorter answer." } } });
            } else if (message.stop_reason === "pause_turn") {
              finish({ type: "response.failed", response: { status: "failed", output, usage: totals, error: { code: "claude_response_failed", message: "Claude's web search did not finish. Retry the question." } } });
            } else finish({ type: "response.completed", response: { id: `resp_${randomUUID()}`, status: "completed", output, usage: totals } });
            return;
          }
        } catch (error) {
          if (signal?.aborted) { try { controller.close(); } catch { /* closed */ } return; }
          // Nothing visible yet: the bridge may retry the whole response.
          if (!delivered) { controller.error(error); return; }
          const reported = error instanceof Anthropic.APIError ? await failure(error).json() as Item : undefined;
          finish({ type: "response.failed", response: { status: "failed", output, error: { code: reported?.error?.code ?? "claude_response_failed", message: reported?.error?.message ?? "Claude stopped before completing the response." } } });
        }
      },
      cancel: () => { current.stream.abort(); },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }
}

/** The pages web search results name, by address, into `found`. */
function collectResults(blocks: Item[], found: Map<string, string>): void {
  for (const b of blocks) {
    if (b?.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
    for (const r of b.content) if (typeof r?.url === "string" && !found.has(r.url)) found.set(r.url, typeof r.title === "string" && r.title ? r.title : r.url);
  }
}

// An address up to whitespace, quotes or the bracket that closes a Markdown
// link; a parenthesised part such as Wikipedia's `Foo_(bar)` stays in it.
const LINK = /https?:\/\/(?:[^\s<>"'`()[\]]|\([^\s<>"'`()[\]]*\))+/g;

/**
 * The search results an answer links to, as `url_citation` annotations beside
 * any Anthropic attached. The dynamic-filtering search that Opus and Sonnet use
 * returned answers that link their pages in the text with no citation blocks
 * (measured on 26 October 2026), so the backend stored no sources for them. A
 * link counts only when a search in this turn returned that exact page; the
 * backend matches a source to its link by address, never by position.
 */
function annotateLinks(text: string, annotations: Item[], found: Map<string, string>): void {
  if (!found.size) return;
  const cited = new Set(annotations.map(a => a.url));
  for (const match of text.matchAll(LINK)) {
    // Sentence punctuation and emphasis after an address are not part of it.
    const link = match[0].replace(/[.,;:!?*_]+$/, "");
    const url = [link, link.split("#")[0]].flatMap(l => [l, `${l}/`, l.replace(/\/$/, "")]).find(l => found.has(l));
    if (!url || cited.has(url)) continue;
    cited.add(url);
    annotations.push({ type: "url_citation", url, title: found.get(url), start_index: match.index, end_index: match.index + link.length });
  }
}

/** One Messages response as Responses output items: its envelope, then what
 * the backend acts on, in order. `searches` remembers a query across a pause,
 * and `found` every page a search returned, by address. */
export function itemsOf(message: Anthropic.Beta.Messages.BetaMessage, searches = new Map<string, string>(), found = new Map<string, string>()): Item[] {
  const visible: Item[] = [];
  const sealed: Sealed = { content: message.content, calls: [], texts: [], searches: [] };
  const summary: Item[] = [];
  let text = "", annotations: Item[] = [];
  const flush = () => {
    if (!text) return;
    annotateLinks(text, annotations, found);
    visible.push({ id: `msg_${randomUUID()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations }] });
    sealed.texts.push(text);
    text = ""; annotations = [];
  };
  for (const b of message.content as Item[]) {
    if (b.type === "text") {
      const start = text.length;
      text += b.text;
      for (const c of b.citations ?? []) {
        if (c?.type === "web_search_result_location" && typeof c.url === "string") annotations.push({ type: "url_citation", url: c.url, title: c.title ?? c.url, start_index: start, end_index: text.length });
      }
      continue;
    }
    if (b.type === "thinking" && b.thinking) summary.push({ type: "summary_text", text: b.thinking });
    if (b.type === "tool_use") {
      flush();
      visible.push({ id: `fc_${b.id}`, type: "function_call", status: "completed", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      sealed.calls.push(b.id);
    } else if (b.type === "server_tool_use" && b.name === "web_search") {
      flush();
      searches.set(b.id, typeof b.input?.query === "string" ? b.input.query : "");
    } else if (b.type === "web_search_tool_result") {
      flush();
      collectResults([b], found);
      const results = Array.isArray(b.content) ? b.content : undefined;
      visible.push({
        id: b.tool_use_id, search_id: b.tool_use_id, type: "web_search_call", status: results ? "completed" : "failed",
        action: { type: "search", query: searches.get(b.tool_use_id) ?? "", sources: (results ?? []).filter((r: Item) => typeof r?.url === "string").map((r: Item) => ({ type: "url", url: r.url, title: r.title ?? r.url })) },
      });
      sealed.searches.push(b.tool_use_id);
    }
  }
  flush();
  return [{ id: `rs_${message.id ?? randomUUID()}`, type: "reasoning", summary, encrypted_content: seal(sealed) }, ...visible];
}

/**
 * Whether Anthropic accepts the key, by the free models listing. Only a 401 is
 * a refusal: an offline Mac or a listing the key is not scoped for is not a
 * reason to keep the reader out of their own app, and the first real request
 * will say what is wrong.
 */
export async function verifyClaudeKey(apiKey: string, baseURL = ANTHROPIC_API): Promise<{ ok: boolean; message?: string }> {
  const client = new Anthropic({ apiKey, authToken: null, baseURL, maxRetries: 0, timeout: 15_000 });
  try { await client.models.list({ limit: 1 }); return { ok: true }; }
  catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return { ok: false, message: "That key was refused." };
    return { ok: true };
  }
}
