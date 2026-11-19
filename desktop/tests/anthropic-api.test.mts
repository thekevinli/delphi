import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage } from "node:http";
import { AnthropicTransport, itemsOf, messagesFrom, messagesRequest, structuredSchema, verifyClaudeKey } from "../main/inference/anthropic-api.ts";
import { startInferenceBridge } from "../main/inference/bridge.ts";
import { SubscriptionLimits } from "../main/inference/limits.ts";

type Item = Record<string, any>;
const PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 fixture").toString("base64")}`;

/** A local stand-in for Anthropic's Messages API: each request gets the next
 *  scripted reply, an SSE stream of events or an HTTP error. */
async function anthropic(replies: Array<Item[] | { status: number; body: Item; headers?: Record<string, string> }>) {
  const seen: { body: Item; headers: IncomingMessage["headers"]; path: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    seen.push({ body: text ? JSON.parse(text) : {}, headers: request.headers, path: request.url ?? "" });
    const reply = replies.shift() ?? { status: 500, body: { type: "error", error: { type: "api_error", message: "no scripted reply" } } };
    if (!Array.isArray(reply)) {
      response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      response.end(JSON.stringify(reply.body)); return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of reply) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** One Messages response as the stream Anthropic sends. */
function stream(content: Item[], stop_reason = "end_turn", usage: Item = { input_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 60, output_tokens: 25 }): Item[] {
  const events: Item[] = [{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, output_tokens: 1 } } }];
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      for (const citation of block.citations ?? []) events.push({ type: "content_block_delta", index, delta: { type: "citations_delta", citation } });
    } else if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      if (block.thinking) events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else if (block.type === "tool_use" || block.type === "server_tool_use") {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else events.push({ type: "content_block_start", index, content_block: block });
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  events.push({ type: "message_stop" });
  return events;
}

async function events(response: Response): Promise<Item[]> {
  const text = await response.text();
  return text.split("\n\n").filter(Boolean).map(frame => JSON.parse(frame.replace(/^data: /, "")));
}

const base = { model: "claude-opus-5-5", instructions: "Answer from the evidence.", reasoning: { effort: "high", summary: "auto" } };

test("a Responses request becomes one Messages request, with what these models accept", () => {
  const request = messagesRequest({
    ...base, max_output_tokens: 12_000, tool_choice: "none", service_tier: "flex", prompt_cache_key: "user:project",
    tools: [{ type: "function", name: "read_paper", description: "Read a page.", parameters: { type: "object", properties: { page: { type: "integer", minimum: 1 } } } }, { type: "web_search", search_context_size: "medium" }],
    text: { format: { type: "json_schema", name: "answer", schema: { type: "object", properties: { body: { type: "string", maxLength: 9000 }, items: { type: "array", minItems: 3, maxItems: 9, items: { type: "string" } } }, required: ["body"], additionalProperties: false } } },
    input: [{ role: "user", content: [{ type: "input_text", text: "What does page 3 say?" }] }],
  }) as Item;
  assert.equal(request.max_tokens, 12_000);
  assert.equal(request.stream, true);
  assert.deepEqual(request.system, [{ type: "text", text: "Answer from the evidence.", cache_control: { type: "ephemeral" } }]);
  // Tool schemas pass through; only the output schema loses what structured outputs refuse.
  assert.deepEqual(request.tools[0], { name: "read_paper", description: "Read a page.", input_schema: { type: "object", properties: { page: { type: "integer", minimum: 1 } } } });
  assert.deepEqual(request.tools[1], { type: "web_search_20260209", name: "web_search", max_uses: 8 });
  assert.deepEqual(request.tool_choice, { type: "none" });
  assert.deepEqual(request.thinking, { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
  assert.deepEqual(request.output_config, { effort: "high", format: { type: "json_schema", schema: { type: "object", properties: { body: { type: "string" }, items: { type: "array", items: { type: "string" } } }, required: ["body"], additionalProperties: false } } });
  assert.deepEqual(request.cache_control, { type: "ephemeral" });
  assert.equal(request.fallbacks, "default");
  assert.deepEqual(request.betas, ["thinking-binding-controls-2026-08-01", "server-side-fallback-2026-07-01"]);
  // Nothing of OpenAI's billing or cache routing travels.
  assert.equal(request.service_tier, undefined);
  assert.equal(request.prompt_cache_key, undefined);
  // Which functions may be called never changes the tools sent: the backend answers a withheld call.
  const tools = [{ type: "function", name: "read_paper", parameters: { type: "object" } }, { type: "function", name: "open_memory", parameters: { type: "object" } }, { type: "web_search" }];
  const restricted = messagesRequest({ ...base, tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "read_paper" }, { type: "web_search" }] }, tools, input: "Go." }) as Item;
  assert.deepEqual(restricted.tool_choice, { type: "auto" });
  assert.deepEqual(restricted.tools.map((t: Item) => t.name), ["read_paper", "open_memory", "web_search"]);
});

test("a round that withholds search, or a turn that spent it, sends no search tool Anthropic would run", () => {
  const tools = [{ type: "function", name: "read_paper", parameters: { type: "object" } }, { type: "web_search" }];
  const names = (fields: Item) => (messagesRequest({ ...base, tools, input: "Go.", ...fields }) as Item).tools.map((t: Item) => t.name);
  assert.deepEqual(names({ max_tool_calls: 8 }), ["read_paper", "web_search"]);
  assert.deepEqual(names({ tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "read_paper" }] } }), ["read_paper"]);
  assert.deepEqual(names({ max_tool_calls: 0 }), ["read_paper"]);
  // The closing round keeps every tool and calls none, so the cached prefix still matches.
  assert.deepEqual(names({ tool_choice: "none" }), ["read_paper", "web_search"]);
});

test("Haiku gets the basic search, no fallback, and the omitted thinking display", () => {
  const request = messagesRequest({ model: "claude-haiku-5-5", reasoning: { effort: "low" }, tools: [{ type: "web_search" }], input: "Find it." }) as Item;
  assert.deepEqual(request.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }]);
  assert.equal(request.fallbacks, undefined);
  assert.deepEqual(request.betas, ["thinking-binding-controls-2026-08-01"]);
  assert.equal(request.thinking.display, "omitted");
  assert.equal(request.system, undefined);
  assert.equal(request.max_tokens, 64_000);
});

test("history converts block by block, with at most two breakpoints from the backend's marks", () => {
  const messages = messagesFrom([
    { role: "user", content: [{ type: "input_file", file_data: PDF, prompt_cache_breakpoint: true }, { type: "input_text", text: "Library", prompt_cache_breakpoint: true }, { type: "input_text", text: "Extra", prompt_cache_breakpoint: true }, { type: "input_text", text: "" }] },
    { type: "function_call", call_id: "call_1", name: "read_paper", arguments: "{\"page\":3}" },
    { type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: "Page 3 text" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    { type: "web_search_call", status: "completed", action: { type: "search", query: "scaling laws", sources: [{ url: "https://a.example/" }] } },
    { type: "reasoning", summary: [], encrypted_content: "gAAAA-openai-sealed" },
    { role: "user", content: "And then?" },
  ]) as Item[];
  assert.deepEqual(messages.map(m => m.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.deepEqual(messages[0].content, [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF.split(",")[1] }, cache_control: { type: "ephemeral" } },
    { type: "text", text: "Library", cache_control: { type: "ephemeral" } },
    { type: "text", text: "Extra" },
  ]);
  assert.deepEqual(messages[1].content, [{ type: "tool_use", id: "call_1", name: "read_paper", input: { page: 3 } }]);
  assert.deepEqual(messages[2].content, [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "Page 3 text" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }]);
  // Another provider's search is what it found; its sealed reasoning means nothing here.
  assert.deepEqual(messages[3].content, [{ type: "text", text: "Searched the web for “scaling laws”. Sources: https://a.example/" }]);
  assert.deepEqual(messages[4].content, [{ type: "text", text: "And then?" }]);
});

test("a round comes back as its exact blocks, never as Delphi's projection of them", () => {
  const content: Item[] = [
    { type: "thinking", thinking: "Page 3 first.", signature: "sig-1" },
    { type: "text", text: "Let me check.", citations: null },
    { type: "tool_use", id: "toolu_1", name: "read_paper", input: { page: 3 } },
  ];
  const items = itemsOf({ id: "msg_1", content } as never);
  assert.deepEqual(items.map(i => i.type), ["reasoning", "message", "function_call"]);
  assert.deepEqual(items[0].summary, [{ type: "summary_text", text: "Page 3 first." }]);
  // What `harness/replay.py` hands the next round: ids gone, reasoning by its sealed content.
  const replayed = [
    { role: "user", content: [{ type: "input_text", text: "What does page 3 say?" }] },
    { type: "reasoning", summary: items[0].summary, encrypted_content: items[0].encrypted_content },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me check." }] },
    { type: "function_call", call_id: "toolu_1", name: "read_paper", arguments: items[2].arguments },
    { type: "function_call_output", call_id: "toolu_1", output: "Page 3 text" },
  ];
  const messages = messagesFrom(replayed) as Item[];
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[1], { role: "assistant", content });
  assert.deepEqual(messages[2].content, [{ type: "tool_result", tool_use_id: "toolu_1", content: "Page 3 text" }]);
  // Without the envelope (a chat turn projected to text) it converts, and carries no thinking.
  const projected = messagesFrom([replayed[0], { role: "assistant", content: [{ type: "output_text", text: "Let me check." }] }, { role: "user", content: "Thanks." }]) as Item[];
  assert.deepEqual(projected[1].content, [{ type: "text", text: "Let me check." }]);
});

test("structured output schemas lose only what Anthropic refuses", () => {
  assert.deepEqual(structuredSchema({ type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "number", minimum: 0, multipleOf: 2, enum: [2, 4] } }),
    { type: "array", minItems: 1, items: { type: "number", enum: [2, 4] } });
});

test("the transport streams a Responses answer: calls, text, reasoning, usage", async () => {
  const server = await anthropic([stream([
    { type: "thinking", thinking: "Check page 3.", signature: "sig-1" },
    { type: "text", text: "Reading it now." },
    { type: "tool_use", id: "toolu_1", name: "read_paper", input: { page: 3 } },
  ], "tool_use")]);
  try {
    const transport = new AnthropicTransport("sk-ant-test", { baseURL: server.url });
    const response = await transport.responses({ ...base, input: "What does page 3 say?" });
    assert.equal(response.status, 200);
    const seen = await events(response);
    const kinds = seen.map(e => e.type);
    assert.deepEqual(kinds.filter(k => k !== "response.created"), [
      "response.reasoning_summary_text.delta", "response.reasoning_summary_part.done",
      "response.output_text.delta",
      "response.output_item.added",
      "response.output_item.done", "response.output_item.done", "response.output_item.done",
      "response.completed",
    ]);
    const done = seen.at(-1)!.response;
    assert.deepEqual(done.output.map((i: Item) => i.type), ["reasoning", "message", "function_call"]);
    assert.deepEqual(done.output[2], { id: "fc_toolu_1", type: "function_call", status: "completed", call_id: "toolu_1", name: "read_paper", arguments: "{\"page\":3}" });
    assert.deepEqual(done.usage, { input_tokens: 1000, output_tokens: 25, input_tokens_details: { cached_tokens: 900 } });
    // The reader's key, as this API version takes it, and no other credential.
    assert.equal(server.seen[0].headers.authorization, "Bearer sk-ant-test");
    assert.equal(server.seen[0].headers["x-api-key"], undefined);
    assert.equal(server.seen[0].headers["anthropic-version"], "2026-10-21");
    assert.match(String(server.seen[0].headers["anthropic-beta"]), /thinking-binding-controls-2026-08-01/);
  } finally { await server.close(); }
});

test("a search loop that pauses is resumed inside the same answer, and its sources come back", async () => {
  const search = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "chinchilla scaling" } };
  const results = { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://arxiv.org/abs/2203.15556", title: "Chinchilla", encrypted_content: "enc", page_age: null }] };
  const cited = { type: "text", text: "Compute-optimal models train on more tokens.", citations: [{ type: "web_search_result_location", url: "https://arxiv.org/abs/2203.15556", title: "Chinchilla", cited_text: "…", encrypted_index: "ix" }] };
  const server = await anthropic([stream([search], "pause_turn"), stream([results, cited])]);
  try {
    const transport = new AnthropicTransport("sk-ant-test", { baseURL: server.url });
    const seen = await events(await transport.responses({ ...base, tools: [{ type: "web_search" }], input: "What did Chinchilla find?" }));
    assert.equal(server.seen.length, 2);
    // The resumed request is the first plus the paused turn, nothing added.
    const resumed = server.seen[1].body;
    assert.equal(resumed.messages.length, 2);
    assert.equal(resumed.messages[1].role, "assistant");
    assert.equal(resumed.messages[1].content[0].type, "server_tool_use");
    const output = seen.at(-1)!.response.output;
    const call = output.find((i: Item) => i.type === "web_search_call");
    assert.deepEqual(call.action, { type: "search", query: "chinchilla scaling", sources: [{ type: "url", url: "https://arxiv.org/abs/2203.15556", title: "Chinchilla" }] });
    assert.equal(call.status, "completed");
    const message = output.find((i: Item) => i.type === "message");
    assert.deepEqual(message.content[0].annotations, [{ type: "url_citation", url: "https://arxiv.org/abs/2203.15556", title: "Chinchilla", start_index: 0, end_index: cited.text.length }]);
  } finally { await server.close(); }
});

test("a page a search returned and the answer links is a source, with or without Anthropic's citation", () => {
  const found = { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
    { type: "web_search_result", url: "https://github.com/sgl-project/sglang/releases", title: "Releases · sglang", encrypted_content: "enc" },
    { type: "web_search_result", url: "https://arxiv.org/abs/2203.15556", title: "Chinchilla", encrypted_content: "enc" }] };
  // How Opus and Sonnet answer with the dynamic-filtering search: links in the text, no citation blocks.
  const text = "The latest is [v0.5.22](https://github.com/sgl-project/sglang/releases). See also https://arxiv.org/abs/2203.15556/. "
    + "Unrelated: https://example.com/never-searched.";
  const message = itemsOf({ id: "msg_1", content: [{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "sglang" } }, found, { type: "text", text, citations: null }] } as never)
    .find(i => i.type === "message")!;
  const annotations = message.content[0].annotations as Item[];
  assert.deepEqual(annotations.map(a => [a.url, a.title]), [
    ["https://github.com/sgl-project/sglang/releases", "Releases · sglang"],
    ["https://arxiv.org/abs/2203.15556", "Chinchilla"],
  ]);
  assert.equal(text.slice(annotations[0].start_index, annotations[0].end_index), "https://github.com/sgl-project/sglang/releases");
  // A page Anthropic already cited is not listed twice.
  const cited = { type: "text", text: "Train on more tokens (https://arxiv.org/abs/2203.15556).",
    citations: [{ type: "web_search_result_location", url: "https://arxiv.org/abs/2203.15556", title: "Chinchilla", cited_text: "…", encrypted_index: "ix" }] };
  const once = itemsOf({ id: "msg_2", content: [found, cited] } as never).find(i => i.type === "message")!;
  assert.deepEqual(once.content[0].annotations.map((a: Item) => a.url), ["https://arxiv.org/abs/2203.15556"]);
  // With no search, a link is the model's own and never a source.
  const bare = itemsOf({ id: "msg_3", content: [{ type: "text", text: "See https://github.com/sgl-project/sglang/releases.", citations: null }] } as never);
  assert.deepEqual(bare.find(i => i.type === "message")!.content[0].annotations, []);
});

test("a page found before a pause, or in an earlier round of the turn, is a source when it is linked", async () => {
  const search = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "chinchilla scaling" } };
  const results = { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://arxiv.org/abs/2203.15556", title: "Chinchilla", encrypted_content: "enc", page_age: null }] };
  const linked = { type: "text", text: "Compute-optimal models train on more tokens ([Chinchilla](https://arxiv.org/abs/2203.15556)).", citations: null };
  const lookup = { type: "tool_use", id: "toolu_1", name: "search_library", input: { query: "chinchilla" } };
  const server = await anthropic([stream([search, results], "pause_turn"), stream([linked]), stream([linked])]);
  try {
    const transport = new AnthropicTransport("sk-ant-test", { baseURL: server.url });
    const tools = [{ type: "web_search" }, { type: "function", name: "search_library", parameters: { type: "object", properties: { query: { type: "string" } } } }];
    const paused = (await events(await transport.responses({ ...base, tools, input: "What did Chinchilla find?" }))).at(-1)!.response.output;
    const sources = (output: Item[]) => output.filter(i => i.type === "message").flatMap(i => i.content[0].annotations.map((a: Item) => a.url));
    assert.deepEqual(sources(paused), ["https://arxiv.org/abs/2203.15556"]);
    // A round that searched and then called a tool, replayed; the next round links what it found.
    const first = itemsOf({ id: "msg_4", content: [search, results, lookup] } as never);
    const next = (await events(await transport.responses({ ...base, tools, input: [
      { role: "user", content: [{ type: "input_text", text: "What did Chinchilla find?" }] },
      ...first,
      { type: "function_call_output", call_id: "toolu_1", output: "No library match." },
    ] }))).at(-1)!.response.output;
    assert.deepEqual(sources(next), ["https://arxiv.org/abs/2203.15556"]);
  } finally { await server.close(); }
});

test("links with brackets, emphasis or a fragment still name the page a search returned", () => {
  const found = { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
    { type: "web_search_result", url: "https://en.wikipedia.org/wiki/Mercury_(planet)", title: "Mercury (planet)", encrypted_content: "enc" },
    { type: "web_search_result", url: "https://docs.sglang.ai/speculative_decoding.html", title: "SGLang", encrypted_content: "enc" }] };
  const text = "See [Mercury](https://en.wikipedia.org/wiki/Mercury_(planet)) and **https://docs.sglang.ai/speculative_decoding.html#dflash**.";
  const message = itemsOf({ id: "msg_1", content: [found, { type: "text", text, citations: null }] } as never).find(i => i.type === "message")!;
  assert.deepEqual(message.content[0].annotations.map((a: Item) => a.url), ["https://en.wikipedia.org/wiki/Mercury_(planet)", "https://docs.sglang.ai/speculative_decoding.html"]);
});

test("a request never resumes a search loop past the turn's searches; it answers from what they found", async () => {
  const search = (n: number) => ({ type: "server_tool_use", id: `srvtoolu_${n}`, name: "web_search", input: { query: `query ${n}` } });
  const results = (n: number) => ({ type: "web_search_tool_result", tool_use_id: `srvtoolu_${n}`, content: [] });
  const answer = { type: "text", text: "From what the searches found.", citations: null };
  // The filtering search runs its searches from code, in a container Anthropic names as it pauses.
  const filtering = stream([search(1), results(1), search(2), results(2)], "pause_turn");
  filtering.at(-2)!.delta.container = { id: "container_1", expires_at: "2026-10-26T12:00:00Z" };
  const server = await anthropic([filtering, stream([answer]), stream([search(3), results(3)], "pause_turn"), stream([answer])]);
  try {
    const transport = new AnthropicTransport("sk-ant-test", { baseURL: server.url });
    const ask = async (left: number) => (await events(await transport.responses({ ...base, tools: [{ type: "web_search" }], max_tool_calls: left, input: "Find it." }))).at(-1)!;
    assert.equal((await ask(2)).type, "response.completed");
    assert.deepEqual(server.seen[1].body.tool_choice, { type: "none" });
    assert.equal(server.seen[1].body.container, "container_1");
    // With searches left, the loop resumes as it was.
    assert.equal((await ask(5)).type, "response.completed");
    assert.deepEqual(server.seen[3].body.tool_choice, { type: "auto" });
    assert.equal(server.seen[3].body.tools.at(-1).max_uses, 8);
    assert.equal(server.seen[3].body.container, undefined);
  } finally { await server.close(); }
});

test("calls a deadline left unanswered are answered as not run, and tool results always come first", () => {
  const content: Item[] = [
    { type: "thinking", thinking: "Two pages.", signature: "sig-1" },
    { type: "tool_use", id: "toolu_a", name: "open_memory", input: { slug: "a" } },
    { type: "tool_use", id: "toolu_b", name: "open_memory", input: { slug: "b" } },
  ];
  const [round] = itemsOf({ id: "msg_1", content } as never);
  const sealed = { type: "reasoning", summary: round.summary, encrypted_content: round.encrypted_content };
  // The backend's deadline dropped both calls; its repair round writes to the same conversation.
  const repaired = messagesFrom([{ role: "user", content: "File it." }, sealed, { role: "user", content: "Repair page a." }]) as Item[];
  assert.deepEqual(repaired[1], { role: "assistant", content });
  assert.deepEqual(repaired[2].content, [
    { type: "tool_result", tool_use_id: "toolu_a", is_error: true, content: "This call was not run." },
    { type: "tool_result", tool_use_id: "toolu_b", is_error: true, content: "This call was not run." },
    { type: "text", text: "Repair page a." },
  ]);
  // An image a tool returned arrives as user content between two results.
  const viewed = messagesFrom([{ role: "user", content: "Look." }, sealed,
    { type: "function_call_output", call_id: "toolu_a", output: "Figure 1" },
    { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    { type: "function_call_output", call_id: "toolu_b", output: "Figure 2" }]) as Item[];
  assert.deepEqual(viewed[2].content.map((b: Item) => b.type === "tool_result" ? b.tool_use_id : b.type), ["toolu_a", "toolu_b", "image"]);
  // A conversation with nothing to answer is left exactly as it was.
  assert.deepEqual(messagesFrom([{ role: "user", content: "Hi." }, { role: "assistant", content: [{ type: "output_text", text: "Hello." }] }]),
    [{ role: "user", content: [{ type: "text", text: "Hi." }] }, { role: "assistant", content: [{ type: "text", text: "Hello." }] }]);
});

test("a stream that drops while Claude is still thinking stays retryable; one that has answered fails in place", async () => {
  const overloaded = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
  const thinking = stream([{ type: "thinking", thinking: "Considering.", signature: "sig" }]).slice(0, 3);
  const answering = stream([{ type: "text", text: "Partly", citations: null }]).slice(0, 3);
  const server = await anthropic([[...thinking, overloaded], [...answering, overloaded]]);
  try {
    const transport = new AnthropicTransport("sk-ant-test", { baseURL: server.url });
    // Only reasoning had been sent: the stream errors, which the bridge may retry.
    await assert.rejects((await transport.responses({ ...base, input: "Think." })).text());
    // Text had reached the backend: the failure is reported in the stream, never retried.
    const failed = (await events(await transport.responses({ ...base, input: "Answer." }))).at(-1)!;
    assert.equal(failed.type, "response.failed");
  } finally { await server.close(); }
});

test("Anthropic's refusals become the bridge's errors, in Delphi's words", async () => {
  const server = await anthropic([
    { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } },
    { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, headers: { "retry-after": "7" } },
    { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, headers: { "retry-after": "7" } },
    { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } },
  ]);
  try {
    const transport = new AnthropicTransport("sk-ant-test", { baseURL: server.url });
    const refused = await transport.responses({ ...base, input: "Hi." });
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error: { message: "Anthropic refused this Claude API key. Replace it in Delphi → AI Connection, then retry.", code: "claude_key_reauth_required" } });
    const limited = await transport.responses({ ...base, input: "Hi." });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "7");
    const billing = await transport.responses({ ...base, input: "Hi." });
    assert.equal(billing.status, 400);
    assert.equal((await billing.json()).error.message, "Your credit balance is too low to access the Anthropic API.");
    // A model Delphi does not offer never leaves the Mac.
    assert.equal((await transport.responses({ ...base, model: "gpt-6.1-sol", input: "Hi." })).status, 400);
    assert.equal(server.seen.length, 4);
  } finally { await server.close(); }
});

test("through the bridge, the backend's ceiling and breakpoints reach Anthropic", async () => {
  const server = await anthropic([stream([{ type: "text", text: "Grounded." }])]);
  const bridge = await startInferenceBridge({ upstream: new AnthropicTransport("sk-ant-test", { baseURL: server.url }), limits: new SubscriptionLimits(Date.now, "Claude"),
    provider: "Claude", prime: false, shape: payload => payload });
  try {
    const response = await fetch(`${bridge.url}/responses`, {
      method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...base, stream: true, max_output_tokens: 8000, service_tier: "flex", input: [{ role: "user", content: [{ type: "input_file", file_data: PDF, prompt_cache_breakpoint: true }, { type: "input_text", text: "Summarize." }] }] }),
    });
    assert.equal(response.status, 200);
    const frames = (await response.text()).split("\n\n").filter(Boolean);
    assert.match(frames.at(-1)!, /response\.completed/);
    const sent = server.seen[0].body;
    assert.equal(sent.max_tokens, 8000);
    assert.deepEqual(sent.messages[0].content[0].cache_control, { type: "ephemeral" });
    assert.equal(sent.service_tier, undefined);
  } finally { await bridge.stop(); await server.close(); }
});

test("a key is checked by the free models listing, and only a 401 refuses it", async () => {
  const server = await anthropic([
    { status: 200, body: { data: [], has_more: false, first_id: null, last_id: null } },
    { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } },
    { status: 403, body: { type: "error", error: { type: "permission_error", message: "not allowed" } } },
  ]);
  try {
    assert.deepEqual(await verifyClaudeKey("sk-ant-good", server.url), { ok: true });
    assert.deepEqual(await verifyClaudeKey("sk-ant-bad", server.url), { ok: false, message: "That key was refused." });
    assert.deepEqual(await verifyClaudeKey("sk-ant-scoped", server.url), { ok: true });
    assert.match(server.seen[0].path, /^\/v1\/models/);
  } finally { await server.close(); }
  // Offline is not a refusal.
  assert.deepEqual(await verifyClaudeKey("sk-ant-offline", "http://127.0.0.1:9"), { ok: true });
});
