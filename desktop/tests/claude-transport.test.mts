import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudeTransport } from "../main/inference/claude-transport.ts";
import { claudeEnvironment, claudeVersionProblem } from "../main/inference/claude-runtime.ts";
import { startInferenceBridge } from "../main/inference/bridge.ts";
import { claudeToolDefinitions, claudeToolName, claudeToolText, continuation, nativeResume, permittedTools, permitsWeb, citations, webSources } from "../main/inference/claude-protocol.ts";
import { fixtureClaude } from "./fixtures/claude-runtime.mts";
const model = "claude-sonnet-5-5";
const lookup = { type: "function", name: "lookup", description: "Read a fixture.", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false } };
const input = [{ role: "user", content: "Read alpha and return the receipt." }];
const payload = { model, input, tools: [lookup] };
async function rig(control: Record<string, unknown>, run: (context: { fixture: ReturnType<typeof fixtureClaude>; bridge: Awaited<ReturnType<typeof startInferenceBridge>>; call: (body: unknown, signal?: AbortSignal) => Promise<Response>; logs: any[] }) => Promise<void>, options: { idleMs?: number; answeredIdleMs?: number } = {}) {
  const fixture = fixtureClaude(control);
  const logs: any[] = [];
  const bridge = await startInferenceBridge({ upstream: new ClaudeTransport(fixture.connection, { timeoutMs: 10_000, ...options }), limits: fixture.connection.limits, provider: "Claude", prime: false, log: entry => logs.push(entry) });
  const call = (body: unknown, signal?: AbortSignal) => fetch(bridge.url + "/responses", { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal });
  try { await run({ fixture, bridge, call, logs }); }
  finally {
    await bridge.stop();
    for (const c of fixture.calls()) { assert.equal(existsSync(c.cwd), false, "native history removed"); assert.throws(() => process.kill(c.pid, 0), /ESRCH/, "native process stopped"); }
    fixture.remove();
  }
}

test("Claude login uses the subscription, supports cancellation, and refuses API billing", async () => {
  const fixture = fixtureClaude({ connected: false, loginDelay: 5000 });
  try {
    assert.equal((await fixture.connection.status()).connected, false);
    const starting = fixture.connection.login(); await fixture.connection.cancel(); await starting;
    assert.equal((await fixture.connection.status()).connected, false);
    assert.equal((await fixture.connection.status()).signingIn, false, "closing setup during discovery cancels login");
    await fixture.connection.login(); assert.equal((await fixture.connection.status()).signingIn, true);
    await fixture.connection.cancel(); assert.equal((await fixture.connection.status()).connected, false);
    fixture.configure({ connected: false }); await fixture.connection.login();
    for (let i = 0; i < 30 && !(await fixture.connection.status()).connected; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal((await fixture.connection.status()).connected, true);
    await fixture.connection.logout(); assert.equal((await fixture.connection.status()).connected, false);
    fixture.configure({ authMethod: "api_key" }); await assert.rejects(fixture.connection.ready(), /Claude subscription, not an API account/);
  } finally { await fixture.connection.cancel(); fixture.remove(); }
  assert.deepEqual(claudeEnvironment({ HOME: "/real", ANTHROPIC_API_KEY: "secret", ANTHROPIC_BASE_URL: "other", CLAUDE_CODE_OAUTH_TOKEN: "secret" }), { HOME: "/real" });
});

test("native replay retains roles, PDF/image blocks and completed tool pairs", () => {
  const value = nativeResume([
    { role: "user", content: [{ type: "input_file", file_data: "data:application/pdf;base64,JVBERg==" }, { type: "input_image", image_url: "data:image/png;base64,cGl4ZWxz" }] },
    { role: "assistant", content: "I will read it." },
    { type: "function_call", name: "lookup", call_id: "t1", arguments: '{"key":"alpha"}' },
    { type: "function_call_output", call_id: "t1", output: '{"receipt":"secret"}' },
  ], "session", "/scratch", "2.1.302");
  const rows = value.transcript.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(r => r.message.role), ["user", "assistant", "user"]);
  assert.deepEqual(rows[0].message.content.map((b: any) => b.type), ["document", "image"]);
  assert.equal(rows[1].message.content[1].type, "tool_use");
  assert.equal(rows[2].message.content[0].tool_use_id, "t1");
  assert.match(value.prompt[0].text, /Do not repeat completed calls/);
});

test("withdrawing tools narrows both MCP and native web access", () => {
  const p = { ...payload, tools: [lookup, { ...lookup, name: "forbidden" }, { type: "web_search" }] };
  assert.deepEqual(permittedTools({ ...p, tool_choice: "none" }), []);
  assert.equal(permitsWeb({ ...p, tool_choice: "none" }), false);
  const restricted = { ...p, tool_choice: { type: "allowed_tools", tools: [{ type: "function", name: "lookup" }] } };
  assert.deepEqual(permittedTools(restricted), [lookup]); assert.equal(permitsWeb(restricted), false);
});

const outputs = (response: any, receipt = "RECEIPT") => response.output.filter((i: any) => i.type === "function_call").map((c: any, i: number) => ({ type: "function_call_output", call_id: c.call_id, output: `${receipt}-${i}` }));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("one process serves a conversation: held calls get Delphi's output and parallel calls reach Delphi once", async () => {
  for (const mode of ["roundtrip", "parallel"]) await rig({ mode }, async ({ call, fixture }) => {
    const first = await (await call(payload)).json();
    assert.equal(first.status, "completed", JSON.stringify(first));
    const calls = first.output.filter((i: any) => i.type === "function_call");
    assert.equal(calls.length, mode === "parallel" ? 2 : 1);
    const next = await (await call({ ...payload, input: [...input, ...first.output, ...outputs(first)], tool_choice: "none" })).json();
    assert.match(JSON.stringify(next), /RECEIPT-0/);
    assert.equal(next.output.some((i: any) => i.type === "function_call"), false);
    assert.equal(fixture.calls().length, 1, "the process that made the calls received their outputs");
    const answered = fixture.turns().find(t => t.answered).answered;
    assert.deepEqual(answered.map((r: any) => r.content[0].text), calls.map((_: unknown, i: number) => `RECEIPT-${i}`));
    assert.deepEqual(answered.flatMap((r: any) => r.content), calls.map((_: unknown, i: number) => ({ type: "text", text: `RECEIPT-${i}` })), "a result is exactly Delphi's output");
    assert.match(JSON.stringify(fixture.turns().find(t => t.queued).queued), /No tools may be called on this response/, "the restriction is a user turn beside the results");
  });
});

test("local MCP tools request startup discovery before the first prompt; tool-free requests register no server", async () => {
  for (const tools of [[lookup], []]) await rig({ mode: "roundtrip" }, async ({ call, fixture }) => {
    const first = await (await call({ ...payload, tools })).json();
    assert.equal(first.status, "completed", JSON.stringify(first));
    const [spawned] = fixture.calls();
    if (tools.length) {
      assert.equal(spawned.mcp.mcpServers.delphi.alwaysLoad, true, "the server requests Claude Code's bounded startup wait, not just per-tool deferral exemption");
      assert.deepEqual(spawned.tools.map((tool: any) => tool.name), ["lookup"], "the fake CLI discovers the registered schema over MCP");
      assert.deepEqual(first.output.filter((item: any) => item.type === "function_call").map((item: any) => item.name), ["lookup"]);
    } else {
      assert.deepEqual(spawned.mcp.mcpServers, {});
      assert.deepEqual(spawned.tools, []);
    }
  });
});

test("the process's tools and system prompt never change; a withheld tool is refused where it is called", async () => {
  const forbidden = { ...lookup, name: "forbidden" };
  const tools = [lookup, forbidden];
  const restricted = { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "lookup" }] };
  await rig({ mode: "withdrawn-attempt" }, async ({ call, fixture }) => {
    const first = await (await call({ ...payload, tools, tool_choice: restricted })).json();
    assert.deepEqual(first.output.filter((i: any) => i.type === "function_call").map((c: any) => c.name), ["lookup"], "only the permitted call reaches Delphi");
    const refused = fixture.turns().find(t => t.refused).refused;
    assert.equal(refused.isError, true); assert.match(refused.content[0].text, /may not be called on this response/);
    const [spawned] = fixture.calls();
    assert.deepEqual(spawned.tools.map((t: any) => t.name), ["lookup", "forbidden"], "a withheld tool stays listed");
    assert.equal(spawned.system, "", "the restriction is not in the system prompt");
    assert.deepEqual(spawned.settings, { disableAllHooks: true, autoMemoryEnabled: false, promptCacheTtl: "5m" });
    assert.equal(spawned.mcp.mcpServers.delphi.timeout, 30 * 60_000, "a held call outlasts Claude Code's idle default");
    assert.equal(spawned.tools[0]._meta["anthropic/maxResultSizeChars"], 1_000_000, "a bounded Delphi result reaches the model whole");
    assert.match(JSON.stringify(fixture.turns()[0].prompt), /Only these local tools may be called on this response: mcp__delphi__lookup/);
  });
  await rig({ mode: "withdrawn-attempt", repeat: 4 }, async ({ call }) => {
    const r = await call({ ...payload, tools, tool_choice: restricted }); assert.equal(r.status, 502);
    assert.match(await r.text(), /kept requesting a tool withheld for this response \(forbidden\)/);
  });
});

test("a repair after a final answer is written to the same process; a different history starts a new one", async () => {
  await rig({ mode: "roundtrip" }, async ({ call, fixture }) => {
    const first = await (await call(payload)).json();
    const conversation = [...input, ...first.output, ...outputs(first)];
    const answer = await (await call({ ...payload, input: conversation })).json();
    const repaired = [...conversation, ...answer.output, { role: "user", content: [{ type: "input_text", text: "A checker objected. Fix it." }] }];
    const repair = await call({ ...payload, input: repaired, tool_choice: "none" });
    assert.equal(repair.status, 200); await repair.text();
    assert.equal(fixture.calls().length, 1);
    const prompts = fixture.turns().filter(t => t.prompt).map(t => JSON.stringify(t.prompt));
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /A checker objected\. Fix it\..*No tools may be called/);
    // An earlier item that differs is another conversation: replayed into a new process.
    const other = [{ role: "user", content: "Read beta instead." }, ...repaired.slice(1)];
    assert.equal((await call({ ...payload, input: other })).status, 200);
    assert.equal(fixture.calls().length, 2);
    assert.match(JSON.stringify(fixture.calls()[1].history), /RECEIPT-0/);
  });
});

test("a visual tool result stays attached to its call in live and resumed Claude sessions", async () => {
  await rig({ mode: "roundtrip" }, async ({ call, fixture }) => {
    const first = await (await call(payload)).json();
    const result = { ...outputs(first)[0], output: [
      { type: "input_text", text: "RECEIPT-0" }, { type: "input_image", image_url: "data:image/png;base64,cGl4ZWxz" },
    ] };
    const history = [...input, ...first.output, result];
    await (await call({ ...payload, input: history })).text();
    assert.equal(fixture.calls().length, 1);
    assert.deepEqual(fixture.turns().find(t => t.answered).answered[0].content, [
      { type: "text", text: "RECEIPT-0" }, { type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
    ]);
    assert.equal(fixture.turns().some(t => t.queued), false, "tool pixels must not become a new prompt");
    const resumed = nativeResume(history, "session", "/scratch", "2.1.302");
    const rows = resumed.transcript.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.at(-1).message.content, [{ type: "tool_result", tool_use_id: result.call_id, content: [
      { type: "text", text: "RECEIPT-0" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "cGl4ZWxz" } },
    ] }]);
  });
});

test("an idle process ends, and so does one whose call cannot be matched; the next round replays history", async () => {
  await rig({ mode: "roundtrip" }, async ({ call, fixture }) => {
    const first = await (await call(payload)).json();
    const [spawned] = fixture.calls();
    for (let i = 0; i < 100 && alive(spawned.pid); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(alive(spawned.pid), false, "idle process stopped");
    assert.equal(existsSync(spawned.cwd), false);
    assert.match(await (await call({ ...payload, input: [...input, ...first.output, ...outputs(first)] })).text(), /RECEIPT-0/);
    assert.equal(fixture.calls().length, 2);
  }, { idleMs: 100 });
  await rig({ mode: "roundtrip", noToolUseId: true }, async ({ call, fixture }) => {
    const first = await (await call(payload)).json();
    assert.match(await (await call({ ...payload, input: [...input, ...first.output, ...outputs(first)] })).text(), /RECEIPT-0/);
    assert.equal(fixture.calls().length, 2);
    assert.equal(alive(fixture.calls()[0].pid), false);
  });
});

test("a process started under another Claude account is not continued", async () => {
  await rig({ mode: "roundtrip" }, async ({ call, fixture }) => {
    const first = await (await call(payload)).json();
    fixture.configure({ mode: "roundtrip", email: "other@example.org" });
    assert.match(await (await call({ ...payload, input: [...input, ...first.output, ...outputs(first)] })).text(), /RECEIPT-0/);
    assert.equal(fixture.calls().length, 2);
  });
});

test("a request continues a live process only when it extends exactly what that process holds", () => {
  const seen = input.map(i => JSON.stringify(i));
  const call = { type: "function_call", call_id: "t1", name: "lookup", arguments: "{}" };
  const result = { type: "function_call_output", call_id: "t1", output: "R" };
  assert.deepEqual(continuation(seen, ["t1"], [...input, call, result]), { results: new Map([["t1", [{ type: "text", text: "R" }]]]), message: [] });
  assert.deepEqual(continuation(seen, ["t1"], [...input, call, result, { role: "user", content: "Last round." }]), { results: new Map([["t1", [{ type: "text", text: "R" }]]]), message: [{ type: "text", text: "Last round." }] });
  assert.equal(continuation(seen, ["t1"], [...input, call]), undefined, "an output is missing");
  assert.equal(continuation(seen, ["t1"], [...input, { ...call, call_id: "t2" }, { ...result, call_id: "t2" }]), undefined, "another call");
  assert.equal(continuation(seen, ["t1"], [...input, call, result, result]), undefined, "an output twice");
  assert.equal(continuation(seen, ["t1"], [...input, call, { role: "user", content: "x" }, result]), undefined, "a user turn before the output");
  assert.equal(continuation(seen, ["t1"], [...input, call, { ...result, output: [{ type: "input_file", file_data: "data:application/pdf;base64,JVBERg==" }] }]), undefined, "a PDF cannot travel over MCP");
  assert.equal(continuation(seen, [], [{ role: "user", content: "Other." }, { role: "user", content: "x" }]), undefined, "a changed earlier item");
  assert.equal(continuation(seen, [], input), undefined, "nothing added");
  const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] };
  assert.deepEqual(continuation(seen, [], [...input, answer, { role: "user", content: "Fix it." }], "Done."), { message: [{ type: "text", text: "Fix it." }] });
  assert.equal(continuation(seen, [], [...input, answer, { role: "user", content: "Fix it." }], "Another answer."), undefined, "another process's answer");
  assert.equal(continuation(seen, [], [...input, answer, result]), undefined, "an output nothing waits for");
});

test("only a few idle processes are kept", async () => {
  await rig({ mode: "roundtrip" }, async ({ call, fixture }) => {
    for (let i = 0; i < 6; i++) await (await call({ ...payload, input: [{ role: "user", content: `Conversation ${i}.` }] })).text();
    for (let i = 0; i < 100 && fixture.calls().filter(c => alive(c.pid)).length > 2; i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(fixture.calls().map(c => alive(c.pid)), [false, false, false, false, true, true], "the longest idle end first");
  });
});

test("a process that gave its final answer ends sooner than one holding calls for Delphi", async () => {
  await rig({ mode: "roundtrip" }, async ({ call, fixture }) => {
    await (await call(payload)).json();
    const holding = fixture.calls()[0];
    fixture.configure({});
    await (await call({ ...payload, input: [{ role: "user", content: "Answer without tools." }] })).text();
    const answered = fixture.calls()[1];
    for (let i = 0; i < 100 && alive(answered.pid); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(alive(answered.pid), false, "kept only long enough for a repair");
    assert.equal(alive(holding.pid), true, "Delphi is still running its calls");
  }, { idleMs: 10_000, answeredIdleMs: 100 });
});

test("a result Claude Code did not deliver as sent is never answered from; the round is replayed", async () => {
  // An oversized result saved to a file and shown to the model as an error.
  await rig({ mode: "roundtrip", oversized: true }, async ({ call, fixture, logs }) => {
    const first = await (await call(payload)).json();
    const next = await call({ ...payload, input: [...input, ...first.output, ...outputs(first)] });
    assert.equal(next.status, 200);
    const text = await next.text();
    assert.match(text, /RECEIPT-0/); assert.doesNotMatch(text, /exceeds maximum allowed tokens/);
    assert.equal(fixture.calls().length, 2, "a new process, given the result in its history");
    assert.equal(alive(fixture.calls()[0].pid), false);
    assert.ok(logs.some(l => l.route === "responses.retry"), "dropped before any output, so the bridge retried");
  });
  // A user message Claude Code read only after the results reached the model.
  await rig({ mode: "roundtrip", lateQueue: true }, async ({ call, fixture }) => {
    const first = await (await call(payload)).json();
    const text = await (await call({ ...payload, input: [...input, ...first.output, ...outputs(first)], tool_choice: "none" })).text();
    assert.match(text, /RECEIPT-0/);
    assert.equal(fixture.calls().length, 2, "replayed, so the restriction arrived with its round");
    assert.match(JSON.stringify(fixture.calls()[1].prompt), /No tools may be called/);
  });
  // A held call Claude Code gave up on while Delphi was running it.
  await rig({ mode: "roundtrip", abandonAfterMs: 150 }, async ({ call, fixture }) => {
    const first = await (await call(payload)).json();
    const [spawned] = fixture.calls();
    for (let i = 0; i < 100 && alive(spawned.pid); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(alive(spawned.pid), false, "a process that acted on its own between rounds is closed");
    const text = await (await call({ ...payload, input: [...input, ...first.output, ...outputs(first)] })).text();
    assert.match(text, /RECEIPT-0/); assert.doesNotMatch(text, /timed out/);
    assert.equal(fixture.calls().length, 2);
  });
});

test("what Claude Code saved for a process's working directory is removed with it", async () => {
  await rig({ mode: "roundtrip", saves: true }, async ({ call, fixture }) => {
    await (await call(payload)).json();
    const [spawned] = fixture.calls();
    const saved = join(fixture.dir, ".claude", "projects", spawned.cwd.replace(/[^A-Za-z0-9]/g, "-"));
    assert.equal(existsSync(join(saved, "tool-results", "webfetch.pdf")), true);
    for (let i = 0; i < 100 && alive(spawned.pid); i++) await new Promise(r => setTimeout(r, 20));
    for (let i = 0; i < 50 && existsSync(saved); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(existsSync(saved), false);
  }, { idleMs: 100 });
});

test("two processes that answered the same request: a follow-up continues the one whose answer it replays", async () => {
  await rig({ answer: "First answer." }, async ({ call, fixture }) => {
    await (await call(payload)).text();
    fixture.configure({ answer: "Second answer." });
    const second = await (await call(payload)).json();
    assert.equal(fixture.calls().length, 2);
    await (await call({ ...payload, input: [...input, ...second.output, { role: "user", content: "Fix it." }] })).text();
    const followUp = fixture.turns().filter(t => t.prompt).at(-1);
    assert.match(JSON.stringify(followUp.prompt), /Fix it/);
    assert.equal(followUp.pid, fixture.calls()[1].pid, "not the process that answered first");
  });
});

test("a reader that cancels a stream after output still ends the process", async () => {
  const fixture = fixtureClaude({ mode: "hang", answer: "Visible prefix" });
  const transport = new ClaudeTransport(fixture.connection, { timeoutMs: 10_000 });
  try {
    const response = await transport.responses({ model, input, stream: true });
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /Visible prefix/);
    await reader.cancel();
    const [spawned] = fixture.calls();
    for (let i = 0; i < 100 && alive(spawned.pid); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(alive(spawned.pid), false);
  } finally { await transport.stop(); fixture.remove(); }
});

test("Claude guidance uses native tool names without changing reader content or schema values", async () => {
  const tool = { ...lookup, description: "Use lookup.", parameters: { ...lookup.parameters,
    description: "Call lookup", properties: { key: { type: "string", description: "From lookup", enum: ["lookup"] },
      description: { type: "string", default: "lookup" }, const: { type: "string", description: "lookup" } },
    examples: [{ description: "lookup" }] } };
  assert.equal(claudeToolText("lookup mcp__delphi__lookup lookup_more", [tool]), "mcp__delphi__lookup mcp__delphi__lookup lookup_more");
  const [translated] = claudeToolDefinitions([tool]);
  assert.equal(translated.parameters.properties.key.description, "From mcp__delphi__lookup");
  assert.deepEqual(translated.parameters.properties.key.enum, ["lookup"]);
  assert.equal(translated.parameters.properties.description.default, "lookup");
  assert.equal(translated.parameters.properties.const.description, "mcp__delphi__lookup");
  assert.deepEqual(translated.parameters.examples, [{ description: "lookup" }]);
  await rig({ mode: "roundtrip" }, async ({ call, fixture }) => {
    await (await call({ ...payload, input: [{ role: "user", content: "lookup" }], tools: [tool], instructions: "Use lookup.", tool_choice: { type: "function", name: "lookup" } })).json();
    const [spawned] = fixture.calls();
    assert.equal(spawned.system, "Use mcp__delphi__lookup.");
    assert.equal(spawned.tools[0].description, "Use mcp__delphi__lookup.");
    assert.equal(spawned.prompt[0].text, "lookup");
    assert.match(spawned.prompt.at(-1).text, /Only these local tools.*mcp__delphi__lookup/);
  });
});

test("known Claude aliases preserve arguments and resume with canonical results without model correction", async () => {
  for (const alias of ["lookup", "LOOKUP", "MCP_DELPHI___LOOKUP"]) await rig({ mode: "alias", alias }, async ({ call, fixture }) => {
    const first = await (await call(payload)).json();
    const calls = first.output.filter((i: any) => i.type === "function_call");
    assert.deepEqual(calls.map((c: any) => [c.name, c.call_id, JSON.parse(c.arguments)]), [["lookup", "alias_0", { key: "alpha" }]]);
    const next = await (await call({ ...payload, input: [...input, ...first.output, ...outputs(first)], tool_choice: "none" })).json();
    assert.match(JSON.stringify(next), /RECEIPT-0/);
    assert.equal(fixture.calls().length, 2, "an alias has no held MCP call; resume from canonical history");
    const history = fixture.calls()[1].history.flatMap((r: any) => r.message.content);
    assert.equal(history.find((b: any) => b.type === "tool_use").name, "mcp__delphi__lookup");
    assert.equal(history.find((b: any) => b.type === "tool_result").content, "RECEIPT-0");
  });
});

test("alias recovery retains sibling native web evidence and canonical calls exactly once", async () => {
  await rig({ mode: "alias", aliasWeb: true, aliasParallel: true }, async ({ call }) => {
    const first = await (await call({ ...payload, tools: [lookup, { type: "web_search" }] })).json();
    assert.deepEqual(first.output.filter((i: any) => i.type === "function_call").map((c: any) => c.call_id), ["alias_0", "canonical_0"]);
    const web = first.output.find((i: any) => i.type === "web_search_call");
    assert.equal(web.status, "completed");
    assert.equal(web._claude_history.length, 2);
  });
});

test("alias recovery cannot broaden permission or guess another server, tool or ambiguous name", async () => {
  for (const name of ["mcp__other__lookup", "look_up", "mcpdelphi__lookup", "lookup ", "WebFetch", "StructuredOutput"]) assert.equal(claudeToolName(name, [lookup]), undefined);
  assert.equal(claudeToolName("LOOKUP", [lookup, { ...lookup, name: "Lookup" }]), undefined);
  for (const tool_choice of ["none", { type: "allowed_tools", tools: [] }, { type: "function", name: "other" }]) {
    await rig({ mode: "alias", alias: "LOOKUP", aliasFinal: true }, async ({ call }) => {
      const response = await (await call({ ...payload, tool_choice })).json();
      assert.equal(response.output.some((i: any) => i.type === "function_call"), false);
    });
  }
});

test("unknown Claude tools still require model correction and repeated unknown calls fail", async () => {
  await rig({ mode: "stray-name" }, async ({ call }) => {
    const first = await (await call(payload)).json();
    assert.equal(first.status, "completed", JSON.stringify(first));
    const calls = first.output.filter((i: any) => i.type === "function_call");
    assert.deepEqual(calls.map((c: any) => c.name), ["lookup"], "only the offered call reaches Delphi, once");
    assert.equal(calls[0].call_id, "tool_0");
  });
  await rig({ mode: "stray-loop" }, async ({ call, logs }) => {
    const r = await call(payload);
    assert.equal(r.status, 502);
    assert.match(await r.text(), /kept requesting an unavailable tool \(unknown_tool\)/);
    assert.equal(logs.at(-1).errorCode, "claude_response_failed");
  });
});

test("buffered strict JSON and streamed web citations use the common bridge", async () => {
  await rig({}, async ({ call }) => {
    const r = await (await call({ model, input, text: { format: { type: "json_schema", schema: { type: "object", properties: { sample_size: { type: "integer" } } } } } })).json();
    assert.deepEqual(JSON.parse(r.output[0].content[0].text), { sample_size: 37 });
  });
  await rig({ mode: "web" }, async ({ call }) => {
    const r = await (await call({ model, input, tools: [{ type: "web_search" }] })).json();
    assert.equal(r.output[0].status, "completed");
    assert.equal(r.output[1].content[0].annotations[0].url, "https://example.org/docs");
    assert.equal(r.output[0]._claude_history.length, 2);
  });
  assert.deepEqual(webSources({ action: { type: "open_page", url: "https://example.org" } }, { is_error: true }), []);
  assert.deepEqual(citations("[invented](https://example.org)", new Map()), []);
});

test("concurrent requests keep histories separate", async () => {
  await rig({ mode: "roundtrip" }, async ({ call }) => {
    const one = async (receipt: string) => {
      const first = await (await call(payload)).json();
      const c = first.output.find((i: any) => i.type === "function_call");
      return await (await call({ ...payload, input: [...input, ...first.output, { type: "function_call_output", call_id: c.call_id, output: receipt }] })).text();
    };
    const [a, b] = await Promise.all([one("ALPHA-SECRET"), one("BETA-SECRET")]);
    assert.match(a, /ALPHA-SECRET/); assert.doesNotMatch(a, /BETA-SECRET/);
    assert.match(b, /BETA-SECRET/); assert.doesNotMatch(b, /ALPHA-SECRET/);
  });
});

test("cancellation closes native children; pre-output loss retries, partial output does not", async () => {
  await rig({ mode: "hang", answer: "Visible prefix" }, async ({ call }) => {
    const controller = new AbortController();
    const r = await call({ model, input, stream: true }, controller.signal);
    const reader = r.body!.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /Visible prefix/);
    controller.abort(); await reader.cancel().catch(() => {});
  });
  await rig({ mode: "crash-once", answer: "Recovered" }, async ({ call, fixture }) => {
    assert.match(await (await call({ model, input })).text(), /Recovered/);
    assert.equal(fixture.calls().length, 2);
  });
  await rig({ mode: "crash-after-text", answer: "Visible prefix" }, async ({ call, fixture }) => {
    const text = await (await call({ model, input, stream: true })).text();
    assert.match(text, /Visible prefix/); assert.match(text, /response.failed/);
    assert.equal(fixture.calls().length, 1);
  });
});

test("quota rejection blocks later requests locally and names Claude", async () => {
  await rig({ mode: "limit" }, async ({ call, fixture }) => {
    const r = await call({ model, input }); assert.equal(r.status, 429);
    assert.match(await r.text(), /Claude/);
    const again = await call({ model, input }); assert.equal(again.status, 429);
    assert.equal(fixture.calls().length, 1);
  });
});

test("withdrawn tools and non-subscription runtime authentication fail without dispatch", async () => {
  await rig({ mode: "malformed" }, async ({ call }) => {
    const r = await call({ model, input }); assert.equal(r.status, 502);
    assert.doesNotMatch(await r.text(), /PRIVATE-SOURCE-TEXT/);
  });
  await rig({}, async ({ call, fixture }) => {
    assert.equal((await call({ model, input })).status, 200);
    fixture.configure({ connected: false });
    const expired = await call({ model, input });
    assert.equal(expired.status, 401); assert.match(await expired.text(), /Sign in with Claude/);
    assert.equal(fixture.calls().length, 1, "expired sign-in cannot start another inference process");
  });
  await rig({ apiKeySource: "api_key" }, async ({ call }) => {
    const r = await call({ model, input }); assert.equal(r.status, 401);
  });
});


test("Delphi reuses the current Claude Code subscription, including external sign-in changes", async () => {
  const fixture = fixtureClaude({ connected: true });
  try {
    await fixture.connection.ready();
    await fixture.reopen().ready();
    await fixture.connection.logout();
    await assert.rejects(fixture.reopen().ready(), /Sign in/);
    fixture.configure({ connected: true }); // Sign-in completed in Claude Code.
    await fixture.reopen().ready();
    fixture.configure({ authMethod: "api_key" });
    await assert.rejects(fixture.reopen().ready(), /not an API account/);
  } finally { await fixture.connection.cancel(); fixture.remove(); }
});

test("every Claude model and effort reaches the CLI unchanged; unsupported choices never dispatch", async () => {
  await rig({}, async ({ call, fixture }) => {
    for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]) {
      for (const effort of ["low", "medium", "high", "xhigh"]) {
        const response = await call({ model, input, reasoning: { effort } });
        assert.equal(response.status, 200, await response.text());
        assert.equal(fixture.calls().at(-1).model, model);
        assert.equal(fixture.calls().at(-1).effort, effort);
      }
    }
    for (const bad of [{ model: "gpt-6.1-sol" }, { model: "constructor" }, { model, reasoning: { effort: "max" } }]) {
      assert.equal((await call({ input, ...bad })).status, 400);
    }
    assert.equal(fixture.calls().length, 12);
  });
});


test("a web-and-local batch keeps citations when the closing round withdraws every tool", async () => {
  await rig({ mode: "web-memory" }, async ({ call, fixture }) => {
    const first = await (await call({ ...payload, tools: [lookup, { type: "web_search" }] })).json();
    const web = first.output.filter((i: any) => i.type === "web_search_call");
    assert.deepEqual(web.map((i: any) => [i.action.type, i.status]), [["search", "completed"], ["open_page", "completed"]]);
    const local = first.output.filter((i: any) => i.type === "function_call");
    assert.equal(local.length, 1);
    const next = await (await call({ ...payload, tools: [lookup, { type: "web_search" }], tool_choice: "none",
      input: [...input, ...first.output, { type: "function_call_output", call_id: local[0].call_id, output: "WEB-MEMORY-RECEIPT" }] })).json();
    assert.equal(next.status, "completed");
    assert.equal(fixture.calls().length, 2, "withdrawing web search needs a process without it");
    const replayed = fixture.calls()[1].history.flatMap((r: any) => r.message.content);
    for (const id of ["web_search", "web_fetch"]) {
      assert.ok(replayed.some((b: any) => b.type === "tool_use" && b.id === id), "the new process is given the web calls");
      assert.ok(replayed.some((b: any) => b.type === "tool_result" && b.tool_use_id === id));
    }
    assert.deepEqual(fixture.calls().at(-1).tools.map((t: any) => t.name), ["lookup"]);
    assert.equal(fixture.calls().at(-1).nativeTools, "");
    assert.deepEqual(next.output.map((i: any) => i.type), ["message"]);
    assert.match(next.output[0].content[0].text, /WEB-MEMORY-RECEIPT/);
    assert.equal(next.output[0].content[0].annotations[0].title, "Official docs");
  });
});

test("Claude reports weekly remaining usage without a five-hour display or a settings inference call", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 7 * 86400;
  await rig({ usage: { five_hour: { utilization: 0.8, resetsAt }, seven_day: { utilization: 0.29, resetsAt } } }, async ({ call, fixture }) => {
    assert.equal((await fixture.connection.status()).usage?.percentLeft, undefined);
    await (await call({ model, input })).text();
    const status = await fixture.connection.status({ refreshUsage: true });
    assert.equal(status.usage?.percentLeft, 71);
    assert.equal(status.usage?.weekly, true);
    assert.equal(status.usage?.plan, "Max");
    assert.equal(fixture.calls().length, 1, "opening settings does not spend tokens");
    const oldAccountReport = fixture.connection.usageReporter();
    fixture.configure({ email: "another@example.org" });
    assert.equal((await fixture.connection.status()).usage?.percentLeft, undefined);
    oldAccountReport({ unifiedWindows: { seven_day: { utilization: 0.29, resetsAt } } });
    assert.equal((await fixture.connection.status()).usage?.percentLeft, undefined, "late old-account response is ignored");
    const report = fixture.connection.usageReporter();
    for (const utilization of [0, 1]) {
      report({ unifiedWindows: { seven_day: { utilization, resetsAt } } });
      assert.equal((await fixture.connection.status()).usage?.percentLeft, 100 - utilization * 100);
    }
    for (const week of [undefined, null, {}, { utilization: "0.29", resetsAt }, { utilization: -1, resetsAt }, { utilization: 2, resetsAt }, { utilization: NaN, resetsAt }, { utilization: 0.2, resetsAt: 1 }]) {
      report({ unifiedWindows: { seven_day: week, five_hour: { utilization: 0.8, resetsAt } } });
      assert.equal((await fixture.connection.status()).usage?.percentLeft, undefined, "unknown weekly usage never falls back to five-hour usage");
    }
    report({ unifiedWindows: { seven_day: { utilization: 0.29, resetsAt } } });
    await fixture.connection.logout();
    fixture.configure({});
    assert.equal((await fixture.connection.status()).usage?.percentLeft, undefined, "reconnecting does not revive old usage");
  });
});


test("quota belongs to the Claude account, including an external switch and a late old-account refusal", async () => {
  await rig({ mode: "limit" }, async ({ call, fixture }) => {
    assert.equal((await call({ model, input })).status, 429);
    fixture.configure({ email: "other@example.org", answer: "New account" });
    const recovered = await call({ model, input });
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.match(await recovered.text(), /New account/);
    assert.equal(fixture.connection.limits.check(), undefined);
    fixture.configure({ mode: "limit", email: "other@example.org", limitDelay: 800 });
    const old = call({ model, input });
    for (let i = 0; i < 200 && fixture.calls().length < 3; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(fixture.calls().length, 3, "old account request started");
    fixture.configure({ email: "third@example.org" });
    await fixture.connection.ready();
    assert.equal((await old).status, 401);
    assert.equal(fixture.connection.limits.check(), undefined, "late quota event cannot block a different account");
    assert.equal((await call({ model, input })).status, 200);
    fixture.connection.limits.reject({ error: { resets_in_seconds: 600 } }, new Headers());
    await fixture.connection.logout();
    assert.deepEqual(fixture.connection.limits.snapshot(), {}, "logout clears plan and quota");
  });
});

test("structured streaming publishes JSON without Claude's preamble", async () => {
  await rig({ preamble: "I will format the result now.", structured: { sample_size: 37 } }, async ({ call }) => {
    const response = await call({ model, input, stream: true, text: { format: { type: "json_schema", name: "result", schema: {
      type: "object", properties: { sample_size: { type: "integer" } }, required: ["sample_size"], additionalProperties: false,
    } } } });
    assert.equal(response.status, 200);
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    const text = events.filter(e => e.type === "response.output_text.delta").map(e => e.delta).join("");
    assert.deepEqual(JSON.parse(text), { sample_size: 37 });
    assert.equal(events.find(e => e.type === "response.completed").response.output[0].content[0].text, text);
  });
});


test("Claude terminal errors retain safe categories through the bridge and logs", async () => {
  for (const [assistantError, resultSubtype, status, code, message] of [
    ["server_error", "error_during_execution", 502, "claude_server_error", /service could not complete/],
    ["overloaded", "error_during_execution", 503, "claude_overloaded", /at capacity/],
    ["invalid_request", "error_during_execution", 400, "claude_invalid_request", /rejected this request/],
    ["rate_limit", "error_during_execution", 429, "rate_limit_exceeded", /rate-limiting/],
    ["authentication_failed", "error_during_execution", 401, "claude_reauth_required", /Reconnect/],
    [undefined, "error_during_execution", 502, "claude_error_during_execution", /could not finish/],
    ["PRIVATE-SOURCE-TEXT", "Bearer fixture-secret", 502, "claude_response_failed", /could not finish/],
  ] as const) await rig({ mode: "result-error", assistantError, resultSubtype }, async ({ call, logs, fixture }) => {
    const response = await call({ model, input, stream: true });
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error.code, code); assert.match(body.error.message, message);
    assert.equal(logs.at(-1).errorCode, code);
    assert.doesNotMatch(JSON.stringify([body, logs]), /PRIVATE-SOURCE-TEXT|fixture-secret/);
    assert.equal(fixture.calls().length, 1, "terminal errors do not add another transport retry loop");
  });
});
