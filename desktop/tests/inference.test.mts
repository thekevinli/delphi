import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stablePrefix, startInferenceBridge, type Upstream } from "../main/inference/bridge.ts";
import { relayResponses, type ProviderEvent } from "../main/inference/direct-provider.ts";
import { SubscriptionLimits } from "../main/inference/limits.ts";
import { usageSummary } from "../main/inference/connection.ts";
import { backendEnv, SUBSCRIPTION_MODEL_FALLBACK } from "../main/backend.ts";
import { validateProfile } from "../main/profile.ts";

type Item = Record<string, any>;
const completed = (text = "Grounded answer.") => [
  { type: "response.created", response: { status: "in_progress" } },
  { type: "response.output_text.delta", delta: text },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } },
  { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 4, input_tokens_details: { cached_tokens: 90 } } } },
];
const sse = (events: unknown[], headers: Record<string, string> = {}) =>
  new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", ...headers } });

class FakeUpstream implements Upstream {
  calls: { payload: Item; headers: Record<string, string> }[] = [];
  reply: (payload: Item) => Response | Promise<Response> = () => sse(completed());
  async responses(payload: unknown, _signal?: AbortSignal, headers: Record<string, string> = {}) {
    this.calls.push({ payload: payload as Item, headers });
    return this.reply(payload as Item);
  }
}

async function withBridge(run: (context: { url: string; headers: Record<string, string>; upstream: FakeUpstream; limits: SubscriptionLimits; now: { value: number } }) => Promise<void>, maxInline?: number) {
  const dir = mkdtempSync(join(tmpdir(), "delphi-bridge-"));
  const upstream = new FakeUpstream();
  const now = { value: Date.now() };
  const limits = new SubscriptionLimits(() => now.value);
  const bridge = await startInferenceBridge({ upstream, limits, maxInline });
  try { await run({ url: bridge.url, headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, upstream, limits, now }); }
  finally { await bridge.stop(); rmSync(dir, { recursive: true, force: true }); }
}
const request = { model: "gpt-5.6-terra", instructions: "Use only supplied evidence.", input: [{ role: "user", content: [{ type: "input_text", text: "Explain page 3." }] }] };
const post = (url: string, headers: Record<string, string>, body: unknown) => fetch(`${url}/responses`, { method: "POST", headers, body: JSON.stringify(body) });

test("the subscription reaches the backend only as a loopback API base and a per-launch token", () => {
  const base = { python: "/python", dataDir: "/data", logsDir: "/logs", apiHost: "127.0.0.1", apiPort: 1, uiOrigin: "http://localhost:2", sessionSecret: "local" };
  const env = backendEnv({ ...base, apiKey: "", apiBaseUrl: "https://must-not-be-used.test", inference: { url: "http://127.0.0.1:3/v1", token: "bridge-token" } });
  assert.equal(env.OPENAI_API_KEY, "bridge-token");
  assert.equal(env.OPENAI_API_BASE_URL, "http://127.0.0.1:3/v1");
  assert.equal(env.MODEL_DEFAULT, "gpt-6.1-sol", "task models are the plan's, through the named fallback");
  assert.equal(Object.keys(env).some(key => key.startsWith("DESKTOP_")), false);
  assert.throws(() => backendEnv({ ...base, apiKey: "sk-saved", inference: { url: "http://127.0.0.1:3/v1", token: "bridge-token" } }), /cannot also configure an API key/);
  assert.equal(backendEnv({ ...base, apiKey: "sk-saved" }).OPENAI_API_KEY, "sk-saved");
});

test("connection migration keeps identity and never stores OAuth credentials in the profile", () => {
  const prior = { username: "reader", apiKey: "YWJj", sessionSecret: "YWJj", accountPassword: "YWJj" };
  const next = validateProfile({ ...prior, version: 2, connectionId: "chatgpt-oauth" });
  for (const [key, value] of Object.entries(prior)) assert.equal((next as any)[key], value);
  assert.throws(() => validateProfile({ ...next, accessToken: "secret" }));
  assert.equal(validateProfile(prior).version, 1);
});

test("only the backend's credential, from a non-browser client, reaches the bridge", async () => {
  await withBridge(async ({ url, headers }) => {
    assert.equal((await post(url, { "content-type": "application/json" }, request)).status, 403);
    assert.equal((await post(url, { ...headers, origin: "http://localhost" }, request)).status, 403);
    assert.equal((await post(url, headers, request)).status, 200);
  });
});

test("an inline PDF passes through unchanged, with the cache key as the session", async () => {
  await withBridge(async ({ url, headers, upstream }) => {
    const data = `data:application/pdf;base64,${Buffer.from("%PDF-1.7 fixture").toString("base64")}`;
    const withFile = { ...request, prompt_cache_key: "thread-7", max_output_tokens: 10000,
      input: [{ role: "user", content: [{ type: "input_file", filename: "paper.pdf", file_data: data, prompt_cache_breakpoint: { mode: "explicit" } }, { type: "input_text", text: "Explain page 3." }] }] };
    const result = await (await post(url, headers, withFile)).json();
    assert.equal(result.status, "completed");
    const sent = upstream.calls[0];
    assert.equal(sent.payload.input[0].content[0].file_data, data);
    assert.equal(sent.payload.input[0].content[0].filename, "paper.pdf");
    assert.equal(sent.payload.prompt_cache_key, "thread-7");
    assert.equal(sent.headers.session_id, "thread-7");
    assert.equal("max_output_tokens" in sent.payload, false);
    // An id names a file in another provider's store; the backend re-uploads on 404.
    const foreign = await post(url, headers, { ...request, input: [{ role: "user", content: [{ type: "input_file", file_id: "file-abc123" }] }] });
    assert.equal(foreign.status, 404);
    assert.match((await foreign.json()).error.message, /No such File object: file-abc123/);
    assert.equal((await fetch(`${url}/files`, { method: "POST", headers, body: "{}" })).status, 404);
  });
});

test("inline sources beyond the request limit are refused whole, never truncated", async () => {
  await withBridge(async ({ url, headers, upstream }) => {
    const pdf = (name: string) => ({ type: "input_file", filename: name, file_data: `data:application/pdf;base64,${Buffer.alloc(600).toString("base64")}` });
    const response = await post(url, headers, { ...request, input: [{ role: "user", content: [pdf("a.pdf"), pdf("b.pdf")] }] });
    assert.equal(response.status, 413);
    assert.equal(upstream.calls.length, 0);
  }, 1000);
});

test("streamed responses relay the provider's native events", async () => {
  await withBridge(async ({ url, headers }) => {
    const text = await (await post(url, headers, { ...request, stream: true })).text();
    assert.match(text, /event: response.output_text.delta/);
    assert.match(text, /event: response.completed/);
  });
});

test("one failed request does not make the next one unavailable", async () => {
  await withBridge(async ({ url, headers, upstream }) => {
    let first = true;
    upstream.reply = () => { if (first) { first = false; return new Response("upstream down", { status: 503 }); } return sse(completed()); };
    const failed = await post(url, headers, request);
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error.message, /temporarily unavailable/);
    assert.equal((await post(url, headers, request)).status, 200);
  });
});

test("concurrent work is never refused by a local queue limit", async () => {
  await withBridge(async ({ url, headers, upstream }) => {
    let open = 0, peak = 0;
    upstream.reply = async () => { open++; peak = Math.max(peak, open); await new Promise(resolve => setTimeout(resolve, 50)); open--; return sse(completed()); };
    const statuses = await Promise.all(Array.from({ length: 8 }, () => post(url, headers, request).then(response => response.status)));
    assert.deepEqual(statuses, Array(8).fill(200));
    assert.equal(peak, 8);
  });
});

test("a plan usage limit reports its reset time and stops further requests until then", async () => {
  await withBridge(async ({ url, headers, upstream, now }) => {
    upstream.reply = () => Response.json({ error: { type: "usage_limit_reached", message: "limit", resets_in_seconds: 3600 } },
      { status: 429, headers: { "x-codex-plan-type": "plus" } });
    const limited = await post(url, headers, request);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 3500);
    const body = await limited.json();
    assert.equal(body.error.code, "usage_limit_reached");
    assert.match(body.error.message, /ChatGPT plus plan\. It resets .+ Delphi will not send AI requests before then/);
    assert.equal((await post(url, headers, request)).status, 429);
    assert.equal(upstream.calls.length, 1, "no retry reaches the provider during the limit");
    now.value += 3601_000;
    upstream.reply = () => sse(completed());
    assert.equal((await post(url, headers, request)).status, 200);
  });
});

test("an expired sign-in asks the reader to reconnect, and ordinary provider errors keep their detail", async () => {
  await withBridge(async ({ url, headers, upstream }) => {
    upstream.reply = () => new Response("expired", { status: 401 });
    const expired = await post(url, headers, request);
    assert.equal(expired.status, 401);
    assert.match((await expired.json()).error.message, /Reconnect in Delphi → AI Connection/);
    upstream.reply = () => { throw new Error("Sign in with ChatGPT first."); };
    assert.equal((await post(url, headers, request)).status, 401);
    upstream.reply = () => Response.json({ error: { message: "Invalid schema for response_format: Bearer abc.def", param: "text.format", code: "invalid_json_schema" } }, { status: 400 });
    const invalid = await (await post(url, headers, request)).json();
    assert.equal(invalid.error.param, "text.format");
    assert.match(invalid.error.message, /Invalid schema.*Bearer \[redacted\]/);
  });
});

test("rate-limit headers become the plan usage shown in AI Connection", async () => {
  await withBridge(async ({ url, headers, upstream, limits, now }) => {
    upstream.reply = () => sse(completed(), { "x-codex-plan-type": "plus", "x-codex-primary-used-percent": "54", "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": String(Math.floor(now.value / 1000) + 3600) });
    await post(url, headers, request);
    const usage = limits.snapshot();
    assert.equal(usage.plan, "plus");
    assert.equal(usage.primary?.usedPercent, 54);
    assert.equal(usage.blockedUntil, undefined);
  });
});

test("the usage endpoint replaces the plan's windows, and Settings shows the longest as usage left", () => {
  const limits = new SubscriptionLimits();
  limits.observe(new Headers({ "x-codex-primary-used-percent": "40", "x-codex-primary-window-minutes": "300",
    "x-codex-secondary-used-percent": "0", "x-codex-secondary-window-minutes": "10080" }));
  // As measured from wham/usage on a Pro Lite plan: one weekly window, no secondary.
  const resetAt = Date.UTC(2026, 9, 24, 22, 18) / 1000;
  limits.report({ plan_type: "prolite", rate_limit: { allowed: true, limit_reached: false, secondary_window: null,
    primary_window: { used_percent: 1, limit_window_seconds: 604800, reset_after_seconds: 593591, reset_at: resetAt } } });
  const usage = limits.snapshot();
  assert.equal(usage.secondary, undefined);
  assert.deepEqual(usage.primary, { usedPercent: 1, windowMinutes: 10080, resetAt: resetAt * 1000 });
  const summary = usageSummary(usage)!;
  assert.deepEqual({ ...summary, resets: undefined }, { plan: "Pro Lite", percentLeft: 99, weekly: true, resets: undefined });
  assert.match(usageSummary(usage)!.resets!, /^[^:]+$/);
  // A malformed answer leaves what the last response reported.
  limits.report({ detail: "Unauthorized" });
  assert.equal(limits.snapshot().primary?.usedPercent, 1);
});

test("a caller that hangs up once it has the completed event is still logged with its usage", async () => {
  const logged: Item[] = [];
  // The provider sends everything and then leaves its side open until the request is abandoned.
  const upstream: Upstream = { responses: async (_payload, signal) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(completed().map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
    signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
  } })) };
  const bridge = await startInferenceBridge({ upstream, limits: new SubscriptionLimits(), log: entry => logged.push(entry) });
  try {
    const caller = new AbortController();
    const response = await fetch(`${bridge.url}/responses`, { method: "POST", signal: caller.signal,
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...request, stream: true }) });
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("event: response.completed")) text += new TextDecoder().decode((await reader.read()).value);
    caller.abort();
    const deadline = Date.now() + 2000;
    while (!logged.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(logged.length, 1);
    assert.deepEqual([logged[0].status, logged[0].inputTokens, logged[0].cachedTokens, logged[0].error], [200, 100, 90, undefined]);
  } finally { await bridge.stop(); }
});

function dropping(events: unknown[]): Response {
  // A stream that delivers these events and then loses its connection.
  let sent = false;
  return new Response(new ReadableStream({ pull(controller) {
    if (sent) { controller.error(new TypeError("terminated")); return; }
    sent = true;
    controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
  } }));
}

test("a stream dropped before any output is retried; one dropped mid-answer is reported, not replayed", async () => {
  await withBridge(async ({ url, headers, upstream }) => {
    let calls = 0;
    upstream.reply = () => ++calls === 1 ? dropping([{ type: "response.created", response: { status: "in_progress" } }]) : sse(completed());
    for (const stream of [false, true]) {
      calls = 0;
      const response = await post(url, headers, { ...request, stream });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.equal(calls, 2);
      assert.equal((text.match(/event: response\.created/g) ?? []).length, stream ? 1 : 0, "held envelope events are sent once");
    }
    calls = 0;
    upstream.reply = () => { calls++; return dropping([{ type: "response.output_text.delta", delta: "Half an ans" }]); };
    const text = await (await post(url, headers, { ...request, stream: true })).text();
    assert.equal(calls, 1, "output already reached the backend, so the request is not replayed");
    assert.match(text, /Half an ans[\s\S]*response\.failed/);
    upstream.reply = () => { calls++; return sse([{ type: "response.failed", response: { error: { message: "The model refused." } } }]); };
    calls = 0;
    assert.equal((await post(url, headers, request)).status, 502);
    assert.equal(calls, 1, "a failure the model reported is not retried");
  });
});

test("a buffered response dropped mid-answer is retried, since nothing reached the backend", async () => {
  await withBridge(async ({ url, headers, upstream }) => {
    let calls = 0;
    upstream.reply = () => ++calls === 1 ? dropping([{ type: "response.output_text.delta", delta: "Half an ans" }]) : sse(completed("Whole answer."));
    const response = await post(url, headers, request);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).output[0].content[0].text, "Whole answer.");
    assert.equal(calls, 2);
  });
});

test("a dropped inspection prelude retries the same round without replaying its render", async () => {
  await withBridge(async ({ url, headers, upstream }) => {
    const turn = { ...request, stream: true, input: [...request.input,
      { type: "function_call_output", call_id: "render-1", output: [
        { type: "input_text", text: "Revision 1 passed; inspect the attached screenshot before publishing." },
        { type: "input_image", image_url: "data:image/png;base64,c2NyZWVuc2hvdA==" },
      ] }] };
    const prelude = (id: string) => [
      { type: "response.created", response: { id, status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { id, type: "reasoning" } },
      { type: "response.reasoning_summary_part.added", item_id: id, summary_index: 0, part: { type: "summary_text", text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: id, summary_index: 0, delta: id },
      { type: "response.reasoning_summary_text.done", item_id: id, summary_index: 0, text: id },
      { type: "response.output_item.done", output_index: 0, item: { id, type: "reasoning", summary: [{ type: "summary_text", text: id }] } },
    ];
    const publication = { type: "function_call", id: "fc-1", call_id: "publish-1", name: "publish_artifact", arguments: '{"artifact_id":"a_1234567890abcdef","revision":1}' };
    let calls = 0;
    upstream.reply = () => ++calls === 1 ? dropping(prelude("abandoned-attempt")) : sse([
      ...prelude("successful-attempt"),
      { type: "response.output_item.added", output_index: 1, item: { ...publication, arguments: "" } },
      { type: "response.output_item.done", output_index: 1, item: publication },
      { type: "response.completed", response: { status: "completed", output: [] } },
    ]);
    const text = await (await post(url, headers, turn)).text();
    assert.equal(calls, 2);
    assert.deepEqual(upstream.calls[0], upstream.calls[1], "retry keeps the passed render and screenshot input intact");
    assert.doesNotMatch(text, /abandoned-attempt|response\.failed/);
    assert.equal((text.match(/event: response\.created/g) ?? []).length, 1);
    assert.equal((text.match(/event: response\.completed/g) ?? []).length, 1);
    const frames = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    assert.deepEqual(frames.filter(event => event.type === "response.output_item.done" && event.item.type === "function_call").map(event => event.item), [publication]);
  });
});

test("a busy provider is retried after a pause, but a refusal is not", async () => {
  await withBridge(async ({ url, headers, upstream }) => {
    const overloaded = { type: "response.failed", response: { error: { code: "server_is_overloaded", message: "Our servers are currently overloaded. Please try again later." } } };
    let calls = 0;
    upstream.reply = () => ++calls === 1 ? sse([{ type: "response.created", response: { status: "in_progress" } }, { type: "response.metadata" }, overloaded]) : sse(completed("Whole answer."));
    const started = Date.now();
    const text = await (await post(url, headers, { ...request, stream: true })).text();
    assert.equal(calls, 2);
    assert.ok(Date.now() - started >= 1400, "the retry waits before asking again");
    assert.match(text, /Whole answer\./);
    assert.doesNotMatch(text, /overloaded/);
    upstream.reply = () => sse([{ type: "response.output_text.delta", delta: "Half" }, overloaded]);
    calls = 0;
    upstream.calls = [];
    assert.match(await (await post(url, headers, { ...request, stream: true })).text(), /overloaded/);
    assert.equal(upstream.calls.length, 1, "an answer already under way is not replayed");
  });
});

test("ChatGPT's inline citation markers never reach the answer, even split across deltas", async () => {
  await withBridge(async ({ url, headers, upstream }) => {
    const marked = "Returning data. \uE200cite\uE202turn1view0\uE202turn2view1\uE201 Next step.";
    const clean = "Returning data.  Next step.";
    const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: marked, annotations: [{ type: "url_citation", url: "https://example.org/cache" }] }] };
    upstream.reply = () => sse([
      { type: "response.created", response: { status: "in_progress" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Returning data. \uE200cite\uE202turn1" },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "view0\uE202turn2view1\uE201 Next step." },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: marked },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: { status: "completed", output: [structuredClone(message)] } },
    ]);
    const streamed = await (await post(url, headers, { ...request, stream: true })).text();
    assert.doesNotMatch(streamed, /[\uE200-\uE202]|turn1view0/);
    const deltas = [...streamed.matchAll(/"delta":"([^"]*)"/g)].map(match => match[1]).join("");
    assert.equal(deltas, clean);
    assert.match(streamed, /example\.org\/cache/);
    const answer = await (await post(url, headers, request)).json();
    assert.equal(answer.output[0].content[0].text, clean);
  });
});

test("a marker keeps an entity's name, a long citation still goes, and held text is let go when its item ends", async () => {
  const relay = async (events: unknown[], provider = "ChatGPT") => {
    const seen: ProviderEvent[] = [];
    const done = await relayResponses(sse(events), event => seen.push(event), provider);
    return { streamed: seen.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join(""), done };
  };
  const refs = Array.from({ length: 60 }, (_, index) => `turn${index}search${index}`).join("\uE202");
  const text = `Proposed by \uE200entity\uE202["people","Albert Einstein",{}]\uE201 in 1905.\uE200cite\uE202${refs}\uE201 Then \uE200cite\uE202turn9`;
  const message = { type: "message", content: [{ type: "output_text", text }] };
  const delta = (piece: string) => ({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: piece });
  const events = [delta(text.slice(0, 40)), delta(text.slice(40, 300)), delta(text.slice(300)),
    { type: "response.output_item.done", output_index: 0, item: structuredClone(message) },
    { type: "response.completed", response: { status: "completed", output: [structuredClone(message)] } }];
  const chatgpt = await relay(events);
  assert.equal(chatgpt.streamed, "Proposed by Albert Einstein in 1905. Then citeturn9");
  assert.equal(chatgpt.done.output[0].content[0].text, chatgpt.streamed);
  // A stray opener far from its closer is not a marker: the prose between them stays, and streams.
  const stray = `Result one. \uE200cite\uE202turn0search1 ${"and more prose ".repeat(180)}\uE201 End.`;
  const strayMessage = { type: "message", content: [{ type: "output_text", text: stray }] };
  const pieces = stray.match(/[\s\S]{1,12}/g)!;
  const strayed = await relay([...pieces.map(delta),
    { type: "response.content_part.done", output_index: 0, content_index: 0, part: { type: "output_text", text: stray } },
    { type: "response.output_item.done", output_index: 0, item: structuredClone(strayMessage) },
    { type: "response.completed", response: { status: "completed", output: [structuredClone(strayMessage)] } }]);
  assert.equal(strayed.streamed, stray.replace(/[\uE200-\uE202]/g, ""));
  assert.equal(strayed.done.output[0].content[0].text, strayed.streamed);
  // Other providers' text, which may quote these characters, is left as it came.
  const claude = await relay(events.map(event => structuredClone(event)), "Claude");
  assert.equal(claude.streamed, text);
  assert.equal(claude.done.output[0].content[0].text, text);
});

test("tools and unknown events commit a stream even before answer text", async () => {
  for (const event of [
    { type: "response.output_item.added", item: { type: "function_call", name: "publish_artifact", call_id: "p" } },
    { type: "response.output_item.done", item: { type: "function_call", name: "render_artifact", call_id: "r" } },
    { type: "response.output_item.added", item: { type: "web_search_call", id: "search" } },
    { type: "response.future_event" },
  ]) await withBridge(async ({ url, headers, upstream }) => {
    upstream.reply = () => dropping([event]);
    const text = await (await post(url, headers, { ...request, stream: true })).text();
    assert.equal(upstream.calls.length, 1, event.type);
    assert.match(text, /event: response\.failed/);
  });
});

test("prelude recovery is bounded and never retries a provider-reported failure", async () => {
  await withBridge(async ({ url, headers, upstream }) => {
    const prelude = { type: "response.reasoning_summary_text.delta", delta: "Checking the diagram." };
    upstream.reply = () => dropping([prelude]);
    assert.equal((await post(url, headers, { ...request, stream: true })).status, 502);
    assert.equal(upstream.calls.length, 3);
    upstream.calls = [];
    upstream.reply = () => sse([prelude, { type: "response.failed", response: { error: { message: "Provider refusal." } } }]);
    const refused = await post(url, headers, { ...request, stream: true });
    assert.equal(refused.status, 502);
    assert.match(await refused.text(), /Provider refusal/);
    assert.equal(upstream.calls.length, 1);
  });
});

test("an oversized prelude streams intact and disables replay", async () => {
  await withBridge(async ({ url, headers, upstream }) => {
    const text = "x".repeat(256 * 1024);
    upstream.reply = () => dropping([{ type: "response.reasoning_summary_text.delta", delta: text }]);
    const result = await (await post(url, headers, { ...request, stream: true })).text();
    assert.equal(upstream.calls.length, 1);
    assert.ok(result.includes(text));
    assert.match(result, /event: response\.failed/);
  });
});

test("cancelling during a held prelude aborts the provider without retry", async () => {
  let calls = 0;
  let started!: () => void, aborted!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const stopped = new Promise<void>(resolve => { aborted = resolve; });
  const upstream: Upstream = { responses: async (_payload, signal) => {
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.reasoning_summary_text.delta","delta":"Checking"}\n\n'));
      signal?.addEventListener("abort", () => { controller.error(new DOMException("cancelled", "AbortError")); aborted(); }, { once: true });
      started();
    } }));
  } };
  const bridge = await startInferenceBridge({ upstream, limits: new SubscriptionLimits() });
  try {
    const caller = new AbortController();
    const pending = fetch(`${bridge.url}/responses`, { method: "POST", signal: caller.signal,
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...request, stream: true }) });
    const rejection = assert.rejects(pending, /abort/i);
    await ready;
    caller.abort();
    await rejection;
    await stopped;
    assert.equal(calls, 1);
  } finally { await bridge.stop(); }
});

const pdf = (text = "x".repeat(40_000)) => ({ role: "user", content: [{ type: "input_file", filename: "paper.pdf", file_data: `data:application/pdf;base64,${text}` }] });
const say = (role: string, text: string) => ({ role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] });

test("only a conversation's documents are primed, so a conversation pays for it once", () => {
  const first = [pdf(), say("user", "<reader_memory>"), say("user", "Question 1")];
  assert.deepEqual(stablePrefix(first), [first[0]]);
  const later = [pdf(), say("user", "Question 1"), say("assistant", "Answer 1"), say("user", "<reader_memory>"), say("user", "Question 2")];
  assert.deepEqual(stablePrefix(later), [later[0]], "the same prefix on every turn");
  assert.equal(stablePrefix([say("user", "short"), say("user", "Question")]), undefined, "nothing large to cache");
  assert.equal(stablePrefix([pdf()]), undefined, "a single-message request is already its own entry");
  assert.equal(stablePrefix([...later, { type: "function_call", call_id: "c", name: "read", arguments: "{}" }, { type: "function_call_output", call_id: "c", output: "page" }]), undefined,
    "a tool round already extends the previous request");
});

test("a turn is never made to wait for the request that warms its documents", async () => {
  await withBridge(async ({ url, headers, upstream }) => {
    const turn = { ...request, prompt_cache_key: "thread-9", stream: true,
      input: [pdf(), say("user", "<reader_memory>"), say("user", "Question 1")] };
    // The warming request never answers. The turn must finish regardless.
    let release = () => {};
    upstream.reply = payload => payload.input.length === 1
      ? new Promise<Response>(resolve => { release = () => resolve(sse(completed())); })
      : sse(completed());
    const answered = await post(url, headers, turn);
    assert.match(await answered.text(), /event: response.completed/);
    // The turn went first, and the documents alone followed it.
    assert.deepEqual(upstream.calls.map(call => call.payload.input.length), [3, 1]);
    assert.equal(upstream.calls[1].headers.session_id, "thread-9");
    release();
    await post(url, headers, { ...turn, input: [...turn.input, say("assistant", "Answer 1"), say("user", "Question 2")] });
    assert.equal(upstream.calls.length, 3, "a later turn of the same conversation is not warmed again");
    upstream.calls = [];
    upstream.reply = payload => payload.input.length === 1 ? new Response("down", { status: 503 }) : sse(completed());
    assert.equal((await post(url, headers, { ...turn, prompt_cache_key: "thread-10" })).status, 200, "a refused warming request leaves the turn untouched");
    upstream.calls = [];
    upstream.reply = () => sse(completed());
    await (await post(url, headers, { ...request, prompt_cache_key: "thread-11" })).text();
    assert.equal(upstream.calls.length, 1, "small requests are not warmed");
  });
});

test("stopping lets an in-flight request finish before the bridge closes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "delphi-bridge-"));
  const upstream = new FakeUpstream();
  upstream.reply = async () => { await new Promise(resolve => setTimeout(resolve, 300)); return sse(completed()); };
  const bridge = await startInferenceBridge({ upstream, limits: new SubscriptionLimits() });
  const headers = { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" };
  try {
    const pending = post(bridge.url, headers, request);
    await new Promise(resolve => setTimeout(resolve, 50));
    const stopped = bridge.stop(2_000);
    assert.equal((await pending).status, 200, "the in-flight request completes");
    await stopped;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("both connections give the backend the same configuration apart from where requests go", () => {
  const base = { python: "/python", dataDir: "/data", logsDir: "/logs", apiHost: "127.0.0.1", apiPort: 1, uiOrigin: "http://localhost:2", sessionSecret: "local" };
  const api = backendEnv({ ...base, apiKey: "sk-saved" });
  const subscription = backendEnv({ ...base, apiKey: "", inference: { url: "http://127.0.0.1:3/v1", token: "bridge-token" } });
  const differing = [...new Set([...Object.keys(api), ...Object.keys(subscription)])].filter(key => api[key] !== subscription[key]).sort();
  const models = differing.filter(key => key.endsWith("_MODEL") || key === "MODEL_DEFAULT" || key === "MODEL_CHOICES");
  assert.deepEqual(differing.filter(key => !models.includes(key)), ["OPENAI_API_BASE_URL", "OPENAI_API_KEY", "OPENAI_FILES_ENABLED"],
    "efforts and every task setting are shared");
  // Models differ only through the named fallback, never ad hoc.
  for (const key of models) {
    const expected = api[key]!.split(",").map(model => SUBSCRIPTION_MODEL_FALLBACK[model] ?? model).join(",");
    assert.equal(subscription[key], expected, key);
  }
});

test("a plan's model requirement follows Delphi's own model settings, so a model change needs no subscription edit", async () => {
  const { modelRequirements, missingModels } = await import("../main/inference/connection.ts");
  const { desktopTaskModels } = await import("../main/backend.ts");
  const { CHAT_MODEL_EFFORTS } = await import("../frontend/app/lib/chat-model-policy.ts");
  const { required, composer } = modelRequirements();
  for (const { model, effort } of Object.values(desktopTaskModels("chatgpt-oauth"))) assert.ok(required[model].includes(effort));
  // A plan is asked for what a subscription will actually be sent.
  assert.deepEqual(composer, { "gpt-6-luna": CHAT_MODEL_EFFORTS["gpt-6-luna"], "gpt-6.1-sol": CHAT_MODEL_EFFORTS["gpt-6.1-sol"] });
  const catalog = [{ model: "gpt-6-luna", efforts: ["low", "high"] }];
  assert.deepEqual(missingModels(catalog, { "gpt-6-luna": ["high"] }), []);
  assert.deepEqual(missingModels(catalog, { "gpt-6-luna": ["xhigh"], "gpt-6.1-sol": ["low"] }), ["gpt-6-luna at xhigh effort", "gpt-6.1-sol"]);
});
