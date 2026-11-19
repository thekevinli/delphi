// A native-process boundary fixture, not a replacement for the live check.
// It speaks CLI stream-json and connects through the real MCP HTTP client.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const dir = dirname(process.argv[1]), path = join(dir, "control.json");
const read = () => JSON.parse(readFileSync(path, "utf8"));
const control = read();
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
const output = event => process.stdout.write(JSON.stringify(event) + "\n");
if (args[0] === "--version") { console.log(control.version ?? "2.1.302 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") {
  if (args[1] === "status") { output({ loggedIn: control.connected !== false, authMethod: control.authMethod ?? "claude.ai", subscriptionType: "max", email: control.email ?? "reader@example.org", orgId: "fixture-org" }); process.exit(control.connected === false ? 1 : 0); }
  if (args[1] === "login") { if (!args.includes("--claudeai")) process.exit(2); await new Promise(r => setTimeout(r, control.loginDelay ?? 50)); writeFileSync(path, JSON.stringify({ ...read(), connected: true, authMethod: "claude.ai" })); process.exit(0); }
  if (args[1] === "logout") { writeFileSync(path, JSON.stringify({ ...read(), connected: false })); process.exit(0); }
}
// One process serves turns until stdin closes, as `claude -p` with stream-json
// input does: a held MCP call returns Delphi's output and the turn goes on.
// Stdin is read while a call is held: a message written then is queued and
// joins the next model call, echoed when it does, as Claude Code does.
const queue = [];
let wake;
createInterface({ input: process.stdin }).on("line", line => { queue.push(JSON.parse(line)); wake?.(); });
const nextMessage = async () => { while (!queue.length) await new Promise(r => { wake = r; }); return queue.shift(); };
const replay = message => { if (args.includes("--replay-user-messages")) output({ type: "user", isReplay: true, message: message.message }); };
const history = args.includes("--resume") ? readFileSync(option("--resume"), "utf8").trim().split("\n").map(JSON.parse) : [];
const results = history.flatMap(r => r.message.content).filter(b => b.type === "tool_result");
const contentText = content => typeof content === "string" ? content : content.map(c => c.text ?? `[${c.type}]`).join(" ");
const event = value => output({ type: "stream_event", event: value });
const turnLog = value => appendFileSync(join(dir, "turns.jsonl"), JSON.stringify({ pid: process.pid, ...value }) + "\n");
let client, tools = [], started = false, uses = 0;
// Claude Code's own limits on a held call: it gives up after its timeout and
// tells the model so, as it does when it saves an oversized result to a file.
const callTool = (name, args, id) => client.callTool({ name, arguments: args, ...(control.noToolUseId ? {} : { _meta: { "claudecode/toolUseId": id } }) }, undefined, control.abandonAfterMs ? { timeout: control.abandonAfterMs } : undefined)
  .catch(() => ({ isError: true, content: [{ type: "text", text: `MCP server "delphi" tool "${name}" timed out` }] }));
const OVERSIZED = "Error: result (189,009 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to a file.";
async function respond() {
  for (;;) {
    event({ type: "message_start", message: { usage: { input_tokens: 20, cache_read_input_tokens: 5 } } });
    const localResults = results.filter(b => !b.tool_use_id.startsWith("web_"));
    let selected = control.tool ?? { name: "lookup", arguments: { key: "alpha" } };
    if (control.mode === "alias" && !localResults.length) {
      const alias = { type: "tool_use", id: "alias_0", name: control.alias ?? selected.name, input: selected.arguments };
      const web = { type: "tool_use", id: "web_alias", name: "WebFetch", input: { url: "https://example.org/docs", prompt: "Read it." } };
      const canonical = { type: "tool_use", id: "canonical_0", name: `mcp__delphi__${selected.name}`, input: { key: "beta" } };
      const content = [...(control.aliasWeb ? [web] : []), alias, ...(control.aliasParallel ? [canonical] : [])];
      for (const [index, content_block] of content.entries()) event({ type: "content_block_start", index, content_block });
      output({ type: "assistant", message: { role: "assistant", content } });
      event({ type: "message_delta", usage: { output_tokens: 10 } }); event({ type: "message_stop" });
      if (control.aliasParallel) void callTool(selected.name, canonical.input, canonical.id);
      output({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: alias.id, is_error: true, content: "Unknown tool" }] } });
      if (control.aliasWeb) {
        await new Promise(r => setTimeout(r, 30));
        output({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: web.id, content: "The fetched page supports the fixture claim." }] } });
      }
      // The model never corrects the name. Recovery must come from the bridge,
      // which closes this process and replays the real result in a new one.
      if (control.aliasFinal) { output({ type: "result", subtype: "success", result: "Tool unavailable." }); return; }
      await new Promise(() => {});
    }
    const mixedWeb = control.mode === "web-memory";
    const needsTool = ["roundtrip", "parallel", "withdrawn-attempt", "web-memory", "stray-name", "stray-loop"].includes(control.mode) && !localResults.length && tools.some(t => t.name === selected.name);
    if (needsTool && ["stray-name", "stray-loop"].includes(control.mode)) {
      // An unknown name is not a recoverable alias; the model must correct it.
      for (let i = 0; i < (control.mode === "stray-loop" ? 4 : 1); i++) {
        output({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `stray_${i}`, name: "unknown_tool", input: selected.arguments }] } });
        output({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `stray_${i}`, is_error: true, content: "<tool_use_error>Error: No such tool available: unknown_tool</tool_use_error>" }] } });
      }
    }
    if (needsTool && control.mode === "withdrawn-attempt") {
      // Claude calls a tool the listing offers but this response withholds; the endpoint refuses it.
      for (let i = 0; i < (control.repeat ?? 1); i++) {
        const id = `withheld_${i}`;
        output({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "mcp__delphi__forbidden", input: {} }] } });
        const refused = await callTool("forbidden", {}, id);
        turnLog({ refused });
        output({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: refused.isError, content: refused.content }] } });
      }
    }
    if (needsTool) {
      const definitions = control.mode === "parallel" ? [selected, { ...selected, arguments: { key: "beta" } }] : [selected];
      const web = mixedWeb ? [
        { type: "tool_use", id: "web_search", name: "WebSearch", input: { query: "official docs" } },
        { type: "tool_use", id: "web_fetch", name: "WebFetch", input: { url: "https://example.org/docs", prompt: "Check the claim." } },
      ] : [];
      const content = definitions.map(t => ({ type: "tool_use", id: `tool_${uses++}`, name: `mcp__delphi__${t.name}`, input: t.arguments }));
      for (const [index, content_block] of content.entries()) event({ type: "content_block_start", index, content_block });
      output({ type: "assistant", message: { role: "assistant", content: [...web, ...content] } });
      event({ type: "message_delta", usage: { output_tokens: 10 } }); event({ type: "message_stop" });
      const pending = Promise.all(definitions.map((t, i) => callTool(t.name, t.arguments, content[i].id)));
      // Web completes after the local callback starts. Delphi must wait for it,
      // then retain its citations when the local result returns.
      if (mixedWeb) {
        // Claude serializes tools without this hint: a held local callback
        // otherwise prevents native web execution until its timeout expires.
        if (!tools.every(t => t.annotations?.readOnlyHint === true)) await pending;
        await new Promise(r => setTimeout(r, 30));
        for (const use of web) output({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: use.id,
          content: use.name === "WebSearch" ? 'Links: [{"title":"Official docs","url":"https://example.org/docs"}]' : "The fetched page supports the fixture claim." }] } });
      }
      const answered = await pending;
      await new Promise(r => setTimeout(r, 20));
      turnLog({ answered });
      const blocks = answered.map((r, i) => ({ type: "tool_result", tool_use_id: content[i].id, is_error: r.isError, content: control.oversized ? OVERSIZED : r.content }));
      results.push(...blocks);
      output({ type: "user", message: { content: blocks } });
      // A message read too late joins a later call instead.
      if (!control.lateQueue) for (const queued of queue.splice(0)) { replay(queued); turnLog({ queued: queued.message.content }); }
      continue;
    }
    let text = control.answer ?? (results.length ? results.map(b => contentText(b.content)).join(" ") : "Fixture answer.");
    if (control.mode === "web") {
      const use = { type: "tool_use", id: "web_1", name: "WebSearch", input: { query: "official docs" } };
      output({ type: "assistant", message: { content: [use] } });
      output({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "web_1", content: 'Links: [{"title":"Official docs","url":"https://example.org/docs"}]' }] } });
      text = "See [Official docs](https://example.org/docs).";
    }
    if (mixedWeb && localResults.length) text = `${localResults.map(b => contentText(b.content)).join(" ")} See [[attention]] and [Official docs](https://example.org/docs).`;
    if (args.includes("--json-schema")) {
      if (control.preamble) event({ type: "content_block_delta", delta: { type: "text_delta", text: control.preamble } });
      output({ type: "result", subtype: "success", structured_output: control.structured ?? { sample_size: 37 } });
    } else {
      event({ type: "content_block_delta", delta: { type: "text_delta", text } });
      if (control.mode === "crash-after-text") process.exit(1);
      if (control.mode === "hang") await new Promise(() => {});
      event({ type: "message_delta", usage: { output_tokens: 10 } }); event({ type: "message_stop" });
      output({ type: "result", subtype: "success", result: text });
    }
    return;
  }
}
for (;;) {
  const message = await nextMessage();
  if (message.type === "control_request") {
    appendFileSync(join(dir, "usage-calls.jsonl"), JSON.stringify({ pid: process.pid, request: message.request, args }) + "\n");
    if (control.usageDelay) await new Promise(resolve => setTimeout(resolve, control.usageDelay));
    if (control.usageMode === "hang") await new Promise(() => { setInterval(() => {}, 1000); });
    if (control.usageMode === "crash") process.exit(1);
    if (control.usageMode === "malformed") { console.log("not json"); process.exit(0); }
    output({ type: "control_response", response: { request_id: message.request_id,
      subtype: control.usageMode === "error" ? "error" : "success",
      response: control.usageResponse ?? {} } });
    process.exit(0);
  }
  const prompt = message.message.content;
  replay(message);
  turnLog({ prompt });
  if (!started) {
    started = true;
    const config = JSON.parse(option("--mcp-config"));
    if (config.mcpServers.delphi) {
      const mcp = config.mcpServers.delphi;
      client = new Client({ name: "fixture-claude", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: mcp.headers } }));
      tools = (await client.listTools()).tools;
    }
    if (control.saves) {
      // Claude Code keeps large fetches under its config directory, by working directory.
      const saved = join(process.env.HOME, ".claude", "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"), "tool-results");
      mkdirSync(saved, { recursive: true }); writeFileSync(join(saved, "webfetch.pdf"), "%PDF fixture");
    }
    appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ pid: process.pid, cwd: process.cwd(), model: option("--model"), effort: option("--effort"), tools, nativeTools: option("--tools"), settings: JSON.parse(option("--settings")), system: option("--system-prompt"), mcp: config, history, prompt, env: Object.keys(process.env) }) + "\n");
    if (control.mode === "malformed") { process.stdout.write('invalid JSON PRIVATE-SOURCE-TEXT\n'); await new Promise(() => {}); }
    output({ type: "system", subtype: "init", model: option("--model"), apiKeySource: control.apiKeySource ?? "none" });
    if (control.mode === "crash-once" && !existsSync(join(dir, "crashed"))) { writeFileSync(join(dir, "crashed"), "yes"); process.exit(1); }
    if (control.limitDelay) await new Promise(r => setTimeout(r, control.limitDelay));
    if (control.mode === "limit") { output({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.ceil(Date.now() / 1000) + 600 } }); await new Promise(() => {}); }
    if (control.usage) output({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: control.usage } });
    if (control.mode === "result-error") {
      if (control.assistantError) output({ type: "assistant", error: control.assistantError, message: { content: [{ type: "text", text: "PRIVATE-SOURCE-TEXT Bearer fixture-secret" }] } });
      output({ type: "result", is_error: true, subtype: control.resultSubtype ?? "error_during_execution", errors: ["PRIVATE-SOURCE-TEXT Bearer fixture-secret"] });
      await new Promise(() => {});
    }
  }
  await respond();
}
await new Promise(() => {});
