import assert from "node:assert/strict";
import test from "node:test";
import { parseCatalog, relayResponses, upstreamHeaders, upstreamRequest, type ProviderEvent } from "../main/inference/direct-provider.ts";

const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_source", arguments: '{"page":8}' };
const events = [
  { type: "response.output_text.delta", delta: "π evidence" },
  { type: "response.output_item.done", output_index: 0, item },
  { type: "response.completed", response: { status: "completed", output: [], usage: { output_tokens: 20 } } },
];
function stream(values: unknown[], fragment = 17) {
  const bytes = new TextEncoder().encode(values.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += fragment) controller.enqueue(bytes.slice(offset, offset + fragment));
    controller.close();
  } }));
}

test("the subscription request keeps prompts, tools, history, schema and cache key, dropping only rejected fields", () => {
  const request = { model: "gpt-5.6-terra", instructions: "Original task prompt", reasoning: { effort: "medium" }, max_output_tokens: 16000, max_tool_calls: 8,
    service_tier: "default", prompt_cache_key: "thread-1", prompt_cache_options: { mode: "explicit", ttl: "30m" },
    input: [{ role: "user", content: [{ type: "input_file", filename: "source.pdf", file_data: "data:application/pdf;base64,cGRm", prompt_cache_breakpoint: { mode: "explicit" } }] },
      item, { type: "function_call_output", call_id: "call_1", output: "local evidence" }],
    tools: [{ type: "function", name: "read_source", strict: true, parameters: { type: "object" } }, { type: "web_search" }],
    text: { format: { type: "json_schema", schema: { type: "object" } } } };
  const normalized = upstreamRequest(request);
  assert.equal(normalized.prompt_cache_key, "thread-1");
  for (const key of ["max_output_tokens", "max_tool_calls", "prompt_cache_options", "service_tier"]) assert.equal(key in normalized, false);
  assert.equal("prompt_cache_breakpoint" in normalized.input[0].content[0], false);
  assert.deepEqual(normalized.tools, request.tools);
  assert.deepEqual(normalized.input.slice(1), request.input.slice(1));
  assert.deepEqual(normalized.text, request.text);
  // The backend narrows what a later round may call this way, and the endpoint takes it.
  const allowed = { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "read_source" }] };
  assert.deepEqual(upstreamRequest({ ...request, tool_choice: allowed, include: ["web_search_call.action.sources"] }).tool_choice, allowed);
  assert.equal(normalized.store, false); assert.equal(normalized.stream, true);
  assert.equal(request.max_output_tokens, 16000, "the caller's request is not mutated");
  assert.deepEqual(upstreamRequest({ model: "test", input: "question" }).input, [{ role: "user", content: [{ type: "input_text", text: "question" }] }]);
});

test("the cache key also travels as the session header, which is what routes to the prompt cache", () => {
  assert.deepEqual(upstreamHeaders({ prompt_cache_key: "thread-1" }), { session_id: "thread-1" });
  const round = { model: "m", instructions: "Search the reader's Memory.", input: [{ role: "user", content: "Question" }] };
  const derived = upstreamHeaders(round).session_id;
  assert.match(derived, /^delphi-[0-9a-f]{32}$/, "a request without a key still gets a session");
  assert.equal(upstreamHeaders({ ...round, input: [...round.input, { type: "function_call_output", call_id: "c", output: "page" }] }).session_id, derived,
    "later tool rounds of the same request share it");
  assert.notEqual(upstreamHeaders({ ...round, instructions: "Something else." }).session_id, derived);
});

test("visual tool results preserve their call boundary and sealed replay state", () => {
  const request = { model: "gpt-6.1-sol", include: ["reasoning.encrypted_content"], input: [
    { role: "user", content: "Explain this source." },
    { type: "reasoning", summary: [], encrypted_content: "sealed-fixture" },
    item,
    { type: "function_call_output", call_id: "call_1", output: [
      { type: "input_text", text: "Render passed; inspect the screenshot." },
      { type: "input_image", image_url: "data:image/png;base64,cGl4ZWxz", detail: "high" },
    ] },
  ] };
  assert.deepEqual(upstreamRequest(request).input, request.input);
  assert.deepEqual(upstreamRequest(request).include, request.include);
});

test("fragmented native SSE retains output items and usage for backend tool loops", async () => {
  for (const fragment of [1, 7, 17, 1000]) {
    const seen: ProviderEvent[] = [];
    const completed = await relayResponses(stream([{ type: "codex.rate_limits", rate_limits: {} }, ...events], fragment), event => seen.push(event));
    assert.equal(seen[0].delta, "π evidence", "plan-usage events are not relayed to the backend");
    assert.deepEqual(completed.output, [item]);
    assert.equal(completed.usage.output_tokens, 20);
  }
});

test("interrupted, failed or incomplete streams cannot publish completed output", async () => {
  for (const values of [events.slice(0, 2), [{ type: "response.failed", response: { error: { message: "quota" } } }], [{ type: "error" }], [{ type: "response.incomplete" }]]) {
    const seen: ProviderEvent[] = [];
    await assert.rejects(relayResponses(stream(values), event => seen.push(event)));
    assert.equal(seen.some(event => event.type === "response.completed"), false);
  }
});

test("the model catalog is read from the account's own listing", () => {
  assert.deepEqual(parseCatalog({ models: [{ slug: "gpt-5.6-terra", supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }] }, { visibility: "list" }] }),
    [{ model: "gpt-5.6-terra", efforts: ["medium", "high"] }]);
  assert.throws(() => parseCatalog({}), /catalog/);
});
