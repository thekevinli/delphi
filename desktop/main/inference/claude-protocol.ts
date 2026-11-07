/** Responses-to-Claude translation, shared by the live transport and protocol
 * tests. Native JSONL history and web result formats are version-sensitive;
 * keep those assumptions here rather than teaching the backend about Claude. */
import { randomUUID } from "node:crypto";
export type Item = Record<string, any>;
export const CLAUDE_TOOL_PREFIX = "mcp__delphi__";
/** Translate code-owned guidance, never reader messages, results or argument
 * values. MCP changes callable names; leaving bare names in the system prompt
 * invites the model to call a tool Claude Code cannot find. */
export function claudeToolText(text: string, tools: Item[]): string {
  const names = new Set(tools.map(t => t.name));
  return text.replace(/[A-Za-z0-9_-]+/g, name => names.has(name) ? CLAUDE_TOOL_PREFIX + name : name);
}
export function claudeToolDefinitions(tools: Item[]): Item[] {
  const descriptions = (value: any): any => {
    if (Array.isArray(value)) return value.map(descriptions);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === "description" && typeof item === "string" ? claudeToolText(item, tools)
        : ["default", "const", "enum", "examples"].includes(key) ? item
        : ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"].includes(key) && item && typeof item === "object"
          ? Object.fromEntries(Object.entries(item).map(([name, schema]) => [name, descriptions(schema)])) : descriptions(item)]));
  };
  return tools.map(tool => ({ ...tool, description: claudeToolText(tool.description ?? "", tools), parameters: descriptions(tool.parameters) }));
}
/** Only known local names qualify for recovery. Tolerate case and MCP prefix
 * separators, not misspelled tool names, other servers or ambiguous aliases.
 * Native tools keep their own dispatch and must never alias a Delphi tool. */
export function claudeToolName(value: unknown, tools: Item[]): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) return;
  if (["websearch", "webfetch", "structuredoutput"].includes(value.toLowerCase())) return;
  if (/^mcp_/i.test(value) && !/^mcp_+delphi_+/i.test(value)) return;
  const exact = tools.find(t => CLAUDE_TOOL_PREFIX + t.name === value);
  if (exact) return exact.name;
  const bare = value.replace(/^mcp_+delphi_+/i, "").toLowerCase();
  const matches = tools.filter(t => t.name.toLowerCase() === bare);
  return matches.length === 1 ? matches[0].name : undefined;
}
/** Only documented error categories cross this boundary. CLI error prose can
 * include document text or credentials, so neither logs nor UI receive it. */
export function claudeFailure(assistantError: unknown, subtype: unknown): { status: number; code: string; message: string } {
  const errors: Record<string, [number, string]> = {
    authentication_failed: [401, "Claude sign-in has expired. Reconnect in Delphi → AI Connection, then retry."],
    oauth_org_not_allowed: [403, "This Claude organization does not allow the subscription connection."],
    account_on_hold: [403, "Your Claude account is on hold. Check your account in Claude."],
    billing_error: [403, "Claude reported an account billing problem. Check your subscription in Claude."],
    rate_limit: [429, "Claude is rate-limiting requests. Retry shortly."],
    overloaded: [503, "Claude is at capacity. Retry shortly."],
    invalid_request: [400, "Claude rejected this request. Its document, context or tool input may exceed a provider limit."],
    model_not_found: [400, "This Claude model is not available to your account. Choose another model."],
    server_error: [502, "Claude's service could not complete this request. Retry shortly."],
    max_output_tokens: [422, "Claude reached its output limit before finishing. Ask for a shorter answer."],
    cloud_credential_error: [401, "Claude Code could not authenticate. Check its sign-in and reconnect."],
  };
  if (typeof assistantError === "string" && Object.hasOwn(errors, assistantError)) {
    const [status, message] = errors[assistantError];
    return { status, code: `claude_${assistantError}`, message };
  }
  const result = typeof subtype === "string" && ["error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"].includes(subtype) ? subtype : "response_failed";
  return { status: 502, code: `claude_${result}`, message: "Claude Code could not finish this response. Retry the question." };
}
export function permittedTools(payload: Item): Item[] {
  const tools = (payload.tools ?? []).filter((t: Item) => t.type === "function");
  if (payload.tool_choice === "none") return [];
  if (payload.tool_choice?.type === "allowed_tools") {
    const names = new Set(payload.tool_choice.tools.filter((t: Item) => t.type === "function").map((t: Item) => t.name));
    return tools.filter((t: Item) => names.has(t.name));
  }
  if (payload.tool_choice?.type === "function") return tools.filter((t: Item) => t.name === payload.tool_choice.name);
  return tools;
}
export function permitsWeb(payload: Item): boolean {
  return (payload.tools ?? []).some((t: Item) => ["web_search", "web_search_preview"].includes(t.type)) && payload.tool_choice !== "none"
    && (payload.tool_choice?.type !== "allowed_tools" || payload.tool_choice.tools.some((t: Item) => ["web_search", "web_search_preview"].includes(t.type)))
    && payload.tool_choice?.type !== "function";
}
function blocks(content: unknown): Item[] {
  const values = typeof content === "string" ? [{ type: "input_text", text: content }] : content;
  if (!Array.isArray(values)) throw new Error("Claude requires message content.");
  return values.map(b => {
    if (["input_text", "output_text"].includes(b.type)) return { type: "text", text: b.text };
    if (b.type === "input_file" && b.file_data?.startsWith("data:application/pdf;base64,")) return { type: "document", source: { type: "base64", media_type: "application/pdf", data: b.file_data.split(",")[1] } };
    if (b.type === "input_image") {
      const m = /^data:(image\/[^;]+);base64,(.+)$/.exec(b.image_url);
      if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
    }
    throw new Error(`Unsupported Claude input block: ${b.type}`);
  });
}
export function nativeMessages(input: Item[]): Item[] {
  const messages: Item[] = [];
  const append = (role: string, content: Item[]) => {
    if (messages.at(-1)?.role === role) messages.at(-1)!.content.push(...content);
    else messages.push({ role, content });
  };
  for (const i of input) {
    if (i.type === "function_call") append("assistant", [{ type: "tool_use", id: i.call_id, name: CLAUDE_TOOL_PREFIX + i.name, input: JSON.parse(i.arguments) }]);
    else if (i.type === "function_call_output") append("user", [{ type: "tool_result", tool_use_id: i.call_id, content: typeof i.output === "string" ? i.output : blocks(i.output) }]);
    else if (i.type === "web_search_call" && Array.isArray(i._claude_history)) for (const m of i._claude_history) append(m.role, m.content);
    else if (i.type === "reasoning") continue;
    else if (i.role === "user" || i.role === "assistant") append(i.role, blocks(i.content));
    else throw new Error(`Unsupported Claude history item: ${i.type ?? i.role}`);
  }
  return messages;
}
export function nativeResume(input: Item[], sessionId: string, cwd: string, version: string) {
  const messages = nativeMessages(input);
  // Native resume closes an unanswered tool call before reading stdin. Keep
  // each completed call/result pair together in the imported transcript.
  const last = messages.at(-1);
  const prompt = last?.role === "user" && !last.content.some((b: Item) => b.type === "tool_result") ? messages.pop()!.content
    : [{ type: "text", text: "Continue the current request from its recorded tool results. Do not repeat completed calls." }];
  let parentUuid: string | null = null;
  const records = messages.map(message => {
    const uuid = randomUUID();
    const row = { type: message.role, message, uuid, parentUuid, sessionId, cwd, isSidechain: false, userType: "external", version, timestamp: new Date().toISOString() };
    parentUuid = uuid;
    return row;
  });
  return { prompt, transcript: records.map(r => JSON.stringify(r)).join("\n") + "\n", hasHistory: records.length > 0 };
}
export function webSources(call: Item, result: Item): Item[] {
  if (result.is_error) return [];
  if (call.action.type === "open_page") return [{ url: call.action.url, title: new URL(call.action.url).hostname }];
  const text = typeof result.content === "string" ? result.content : (result.content ?? []).filter((b: Item) => b.type === "text").map((b: Item) => b.text).join("\n");
  const line = /^Links: (\[.*\])$/m.exec(text)?.[1];
  if (!line) return [];
  try { return JSON.parse(line).filter((v: Item) => typeof v.url === "string" && /^https?:\/\//.test(v.url)).slice(0, 30); } catch { return []; }
}
export function citations(text: string, sources: Map<string, Item>): Item[] {
  const annotations: Item[] = [];
  for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    const source = sources.get(match[2]) ?? sources.get(match[2].split("#")[0]);
    if (source) annotations.push({ type: "url_citation", url: match[2], title: source.title ?? match[1], start_index: match.index, end_index: match.index + match[0].length });
  }
  return annotations;
}
/** What a request adds to a conversation a live Claude Code process holds:
 * results for the calls it is waiting on, and any user turn after them, or a
 * new user message alone. */
export type Continuation = { results: Map<string, Item[]>; message: Item[] } | { message: Item[] };
const replayed = (i: Item) => i.type === "function_call" || i.type === "web_search_call" || i.type === "reasoning" || (i.type === "message" && i.role === "assistant");
const userTurn = (i: Item) => i.role === "user" && (i.type === undefined || i.type === "message");
/** MCP tool-result content; undefined when a block cannot travel that way. */
function mcpContent(value: unknown): Item[] | undefined {
  try {
    return blocks(value).map(b => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "image") return { type: "image", data: b.source.data, mimeType: b.source.media_type };
      throw new Error("not MCP content");
    });
  } catch { return undefined; }
}
/** `seen` is the previous request's input, one JSON string per item; `pending`
 * the calls that request ended with. The process already holds what it
 * answered, so Delphi's replay of that answer is checked, not resent. A user
 * turn after the outputs (for example, the last round's note)
 * stays a user turn: inside a tool result the model rightly treats it as tool
 * output, not as the reader. Anything else means the conversation went elsewhere. */
export function continuation(seen: string[], pending: string[], input: Item[], said = ""): Continuation | undefined {
  if (input.length <= seen.length || seen.some((key, i) => JSON.stringify(input[i]) !== key)) return;
  const rest = input.slice(seen.length);
  let n = 0;
  const calls = new Set<string>();
  for (; n < rest.length && replayed(rest[n]); n++) if (rest[n].type === "function_call") calls.add(rest[n].call_id);
  if (calls.size !== pending.length || pending.some(id => !calls.has(id))) return;
  const added = rest.slice(n);
  if (!pending.length) {
    // Two processes can answer the same input; only the one whose answer
    // Delphi replays holds this conversation.
    const replies = rest.slice(0, n).filter(i => i.type === "message").flatMap(i => i.content ?? []).filter((b: Item) => b.type === "output_text").map((b: Item) => b.text).join("");
    if (replies !== said) return;
    if (!added.length || !added.every(userTurn)) return;
    try { return { message: added.flatMap(i => blocks(i.content)) }; } catch { return; }
  }
  const results = new Map<string, Item[]>(), message: Item[] = [];
  for (const i of added) {
    if (i.type === "function_call_output" && calls.has(i.call_id) && !results.has(i.call_id)) {
      const content = mcpContent(i.output);
      if (!content) return;
      results.set(i.call_id, content);
    } else if (results.size && userTurn(i)) {
      try { message.push(...blocks(i.content)); } catch { return; }
    } else return;
  }
  return results.size === pending.length ? { results, message } : undefined;
}
