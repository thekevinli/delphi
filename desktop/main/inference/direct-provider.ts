/**
 * Request and stream translation between the backend's Responses API calls and
 * the ChatGPT subscription endpoint, which speaks the same format with a few
 * parameters it rejects. Everything else passes through unchanged, so task
 * prompts, schemas, tools, history and cache keys arrive exactly as written.
 */
import { createHash } from "node:crypto";

type Item = Record<string, any>;
export type ProviderEvent = Item & { type: string };

// The live endpoint rejects `max_output_tokens`, `prompt_cache_options` and
// per-block `prompt_cache_breakpoint`; it enforces no output ceiling, and the
// backend's own length and schema checks still apply to what comes back.
// `service_tier` is accepted but dropped: a plan is not billed by tier, and its
// "priority" tier spends the reader's allowance faster.
// `max_tool_calls` is rejected too, so one round's hosted searches are not
// capped here. The backend counts the ones that came back and withholds web
// search from the next round with `tool_choice`, which the endpoint accepts.
const DROPPED = ["max_output_tokens", "max_tool_calls", "prompt_cache_options", "service_tier"] as const;

export function upstreamRequest(request: Item): Item {
  const payload = structuredClone(request);
  for (const key of DROPPED) delete payload[key];
  payload.instructions ??= "";
  if (typeof payload.input === "string") payload.input = [{ role: "user", content: [{ type: "input_text", text: payload.input }] }];
  for (const item of payload.input ?? []) {
    if (Array.isArray(item?.content)) for (const block of item.content) if (block && typeof block === "object") delete block.prompt_cache_breakpoint;
  }
  payload.store = false;
  payload.stream = true;
  return payload;
}

/**
 * The provider routes a request to its prompt cache by the session header, as
 * Codex sends it: without one, a repeated document prefix was measured at zero
 * cached tokens; with it, 95%. The backend's cache key is the session when it
 * sends one. Requests without a key, such as Memory chat's tool rounds, get a
 * session derived from what stays fixed across their rounds, so each round can
 * reuse the one before it. The request body is not changed.
 */
export function upstreamHeaders(request: Item): Record<string, string> {
  if (typeof request.prompt_cache_key === "string" && request.prompt_cache_key) return { session_id: request.prompt_cache_key.slice(0, 200) };
  const first = Array.isArray(request.input) ? request.input[0] : request.input;
  const stable = createHash("sha256").update(JSON.stringify([request.model, request.instructions ?? "", request.tools ?? null, first ?? null])).digest("hex");
  return { session_id: `delphi-${stable.slice(0, 32)}` };
}

// ChatGPT's own inline markers, such as "\uE200cite\uE202turn1view0\uE201",
// sometimes reach the answer text. The pages a citation names arrive as
// url_citation annotations, which become the answer's sources, so it is
// dropped; an entity marker keeps the name it displays.
// A marker is "\uE200kind\uE202payload\uE201" on one line, and a citation's
// payload has no spaces, so a stray opener never swallows the prose after it.
const MARKED = 4000;
const CITATION = /\uE200([a-z_]{1,24})((?:\uE202[^\uE200\uE201\n]*)?)\uE201/g;
const OPENED = /^\uE200[a-z_]{0,24}(?:\uE202[^\uE200\uE201\n]*)?$/;
const MARKER = /[\uE200-\uE202]/g;
const spaced = (kind: string, payload: string) => /^(?:file)?cite$/.test(kind) && /\s/.test(payload);
const entity = (payload: string) => {
  try { const value = JSON.parse(payload); if (Array.isArray(value) && typeof value[1] === "string") return value[1].replace(MARKER, ""); } catch { /* plain text */ }
  return payload.replace(MARKER, " ").trim();
};
const uncited = (text: string) => text.replace(CITATION, (marker: string, kind: string, payload: string) =>
  marker.length > MARKED + 2 || spaced(kind, payload) ? marker : kind === "entity" ? entity(payload.slice(1)) : "").replace(MARKER, "");
// Held only while the opened text could still close into a marker that is removed.
const opened = (tail: string) => {
  if (tail.length > MARKED + 1 || !OPENED.test(tail)) return false;
  const [kind, ...payload] = tail.slice(1).split("\uE202");
  return !spaced(kind, payload.join("\uE202"));
};
function uncite(item: Item | undefined) {
  for (const part of item?.content ?? []) if (typeof part?.text === "string") part.text = uncited(part.text);
}

export async function relayResponses(response: Response, emit: (event: ProviderEvent) => void, provider = "ChatGPT"): Promise<Item> {
  if (!response.body) throw new Error(`${provider} returned an empty response.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const items = new Map<number, Item>();
  let pending = "", completed: Item | undefined;
  const marked = provider === "ChatGPT";
  // A marker can straddle two deltas: hold an opened one until it closes, and
  // let go of the rest whenever its part, item or response ends.
  const held = new Map<string, ProviderEvent>();
  const flush = (output?: number) => {
    for (const [part, delta] of held) {
      if (output !== undefined && delta.output_index !== output) continue;
      held.delete(part);
      delta.delta = uncited(delta.delta);
      if (delta.delta) emit(delta);
    }
  };
  const frame = (text: string) => {
    const data = text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as ProviderEvent;
    if (typeof event.type !== "string") throw new Error(`Invalid ${provider} stream event.`);
    // Plan usage events belong to the connection, not to a response.
    if (event.type.startsWith("codex.")) return;
    if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
      const detail = event.response?.error?.message ?? event.error?.message ?? event.message;
      const code = event.response?.error?.code ?? event.error?.code ?? event.code;
      throw Object.assign(new Error(typeof detail === "string" && detail ? detail.slice(0, 600) : `${provider} did not finish this response.`),
        { streamed: true, code: typeof code === "string" ? code : undefined });
    }
    const part = `${event.output_index}:${event.content_index}`;
    if (marked && event.type === "response.output_text.delta" && typeof event.delta === "string") {
      let text = (held.get(part)?.delta ?? "") + event.delta;
      held.delete(part);
      const open = text.lastIndexOf("\uE200");
      if (open >= 0 && opened(text.slice(open))) {
        held.set(part, { type: event.type, output_index: event.output_index, content_index: event.content_index, item_id: event.item_id, delta: text.slice(open) });
        text = text.slice(0, open);
      }
      event.delta = uncited(text);
      if (!event.delta) return;
    }
    if (marked && (event.type === "response.output_text.done" || event.type === "response.content_part.done")) {
      const rest = held.get(part);
      held.delete(part);
      if (rest) { rest.delta = uncited(rest.delta); if (rest.delta) emit(rest); }
      if (typeof event.text === "string") event.text = uncited(event.text);
      if (typeof event.part?.text === "string") event.part.text = uncited(event.part.text);
    }
    if (event.type === "response.output_item.done") {
      if (marked) { flush(event.output_index); uncite(event.item); }
      items.set(event.output_index, event.item);
    }
    if (event.type === "response.completed") {
      flush();
      if (event.response?.status !== "completed") throw new Error(`${provider} did not finish this response.`);
      // The endpoint streams complete output items but can omit them from its
      // final envelope. Restore them in order, with their native shape.
      if (!event.response.output?.length) event.response.output = [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
      else if (marked) event.response.output.forEach(uncite);
      completed = event.response;
    }
    emit(event);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      pending = pending.replaceAll("\r\n", "\n");
      let end: number;
      while ((end = pending.indexOf("\n\n")) >= 0) { frame(pending.slice(0, end)); pending = pending.slice(end + 2); }
      if (pending.length > 32 * 1024 * 1024) throw new Error(`${provider} stream event exceeds the size limit.`);
      if (done) break;
    }
    if (pending.trim()) frame(pending);
    if (!completed) throw new Error(`${provider} disconnected before completing the response.`);
    return completed;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export interface CatalogModel { model: string; efforts: string[] }

export function parseCatalog(body: unknown): CatalogModel[] {
  const models = (body as { models?: Item[] })?.models;
  if (!Array.isArray(models)) throw new Error("Invalid ChatGPT model catalog.");
  return models.filter(model => typeof model.slug === "string")
    .map(model => ({ model: model.slug, efforts: (model.supported_reasoning_levels ?? []).map((level: Item) => level.effort).filter((e: unknown) => typeof e === "string") }));
}
