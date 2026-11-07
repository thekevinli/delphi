import { chatUrl, withConversation } from "./fixtures/conversation.ts";
import { proposalPlan, scientificPlan } from "./fixtures/scientific-plan.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { get as httpGet } from "node:http";
import { LocalPlans } from "../main/research/plans.ts";
import { chatPlansHandler } from "../main/research/chat-plans.ts";
import { PlanStore } from "../main/research/store.ts";
import { createMcp } from "../main/research/mcp.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const draft = { title: "Reproduce method A", objective: "Test multi-shot curation", method: "Apply the paper's temporal grouping method", evidence: [{ citation: "Paper XYZ, section 3", excerpt: "Group adjacent shots using temporal context." }], steps: ["Implement grouping", "Run held-out comparison"], acceptance: ["Report F1 and runtime against a frozen baseline"], dependencies: ["Annotated video subset"], constraints: ["CPU only; keep test labels private"], openQuestions: ["Confirm the paper's threshold"] };
const setup = () => {
  const directory = mkdtempSync("/tmp/delphi-chat-plan-test-");
  const service = { store: new PlanStore(directory) };
  const plans = new LocalPlans(service.store, join(directory, "plans"), 19370);
  return { service, plans, async close() { plans.close(); service.store.close(); rmSync(directory, { recursive: true, force: true }); } };
};
const origin = "http://localhost:8317";
const request = (body: object, path = "/api/chat/stream") => new Request(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", cookie: "session=private" }, body: JSON.stringify(withConversation(body)) });
const events = (text: string) => text.trim().split("\n\n").filter(s => s.startsWith("data:")).map(s => JSON.parse(s.slice(5)));

test("answer completion drains backend metadata work instead of cancelling it", async () => {
  const env = setup();
  let cancelled = false, persisted = false;
  try {
    const handler = chatPlansHandler({ plans: env.plans, backendUrl: "http://127.0.0.1:8000", origin, authenticate: async () => true, installation: async () => "install", fetch: async () => {
      let started = false;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"delta","text":"Infrastructure lessons"}\n\ndata: {"type":"done"}\n\n'));
        },
        async pull(controller) {
          if (started) return;
          started = true;
          await new Promise(resolve => setTimeout(resolve, 30));
          if (cancelled) return;
          persisted = true;
          controller.close();
        },
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "text/event-stream" } });
    } });
    const response = await handler(request({ prompt: "Explain the infrastructure lessons", engagement_id: "latest_turn" }));
    const output = events(await response!.text());
    assert.equal(output.at(-1).type, "done");
    assert.equal(persisted, true, "metadata must finish after the answer event");
    assert.equal(cancelled, false, "successful upstream streams must reach EOF");
  } finally { await env.close(); }
});

for (const scope of ["document", "general"]) test(`reader ${scope} conversation saves a plan, returns a real link, and restores history`, async () => {
  const env = setup(); let forwarded = "", raw = "", calls = 0;
  const mock: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      calls++;
      const body = JSON.parse(String(init.body)); forwarded = body.prompt;
      assert.equal(body.desktop_mode, undefined);
      assert.equal(body.disable_artifacts, true);
      assert.equal(body.disable_explanation_contract, true, "a plan is not an explanation");
      assert.equal(body.mode, undefined, "desktop Plan retains its existing parser");
      assert.equal(body.model, "user-selected-model"); assert.equal(body.reasoning_effort, "high");
      const marker = forwarded.match(/```delphi-plan-[a-f0-9]+\n/)![0];
      raw = "I'll capture the method and its checks.\n\n" + marker + JSON.stringify({ action: "create_plan", plan: proposalPlan }) + "\n```";
      // Every possible fence boundary is split across provider deltas.
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"progress","message":"Reading evidence"}\n\n')); for (const char of raw) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "delta", text: char })}\n\n`)); c.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n')); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.endsWith("/text")) return new Response("Original source text with a reproducible method.");
    if (url.endsWith("/api/projects/p1")) return Response.json({ papers: [{ id: "paper1" }, { id: "paper2" }] });
    return Response.json({ messages: [{ role: "user", content: forwarded }, { role: "assistant", content: raw }] });
  };
  const handler = chatPlansHandler({ plans: env.plans, backendUrl: "http://127.0.0.1:8000", origin, authenticate: async () => true, installation: async () => "Install once: codex mcp add delphi -- LOCAL_BRIDGE", fetch: mock });
  try {
    const body = { desktop_mode: "plan", prompt: "Method A seems useful. Create a plan to reproduce it.", scope, ...(scope === "general" ? {} : { project_id: "p1", paper_id: "paper1" }), model: "user-selected-model", reasoning_effort: "high", request_id: randomUUID() };
    const response = await handler(request(body)); const parsed = events(await response!.text());
    assert.equal(parsed[0].type, "progress");
    const visible = parsed.filter(e => e.type === "delta").map(e => e.text).join("");
    const plan = env.plans.list()[0]!;
    assert.ok(visible.includes(env.plans.url(plan)!)); assert.ok(visible.includes(plan.id));
    assert.ok(visible.includes("codex mcp add")); assert.ok(!visible.includes("delphi-plan-"));
    assert.equal(env.plans.list().length, 1);
    assert.ok(readFileSync(join(env.plans.directory, `${plan.id}.html`), "utf8").includes("Reading the result"));
    assert.ok(!JSON.stringify(plan.context).includes("session=private"));
    assert.ok(!JSON.stringify(plan.context).includes("[Delphi macOS capability"));
    const docs = plan.context.documents as unknown[];
    assert.equal(docs.length, scope === "document" ? 1 : 0);
    const history = await handler(new Request(chatUrl(origin, "scope=" + scope + (scope === "document" ? "&project_id=p1&paper_id=paper1" : ""))));
    const restored = await history!.json();
    assert.equal(restored.messages[0].content, body.prompt);
    assert.equal(restored.messages[1].content, visible);
    const replay = await handler(request(body)); assert.ok((await replay!.text()).includes(plan.id)); assert.equal(calls, 1);
  } finally { await env.close(); }
});

test("ordinary conversation keeps streaming and never creates a plan", async () => {
  const env = setup();
  try {
    const handler = chatPlansHandler({ plans: env.plans, backendUrl: "http://127.0.0.1:8000", origin, authenticate: async () => true, installation: async () => { throw new Error("Unexpected pairing"); }, fetch: async () => new Response('data: {"type":"delta","text":"This paper describes temporal grouping."}\n\ndata: {"type":"done"}\n\n', { headers: { "content-type": "text/event-stream" } }) });
    const response = await handler(request({ prompt: "Explain this paper" }));
    assert.equal(events(await response!.text()).filter(e => e.type === "delta").map(e => e.text).join(""), "This paper describes temporal grouping.");
    assert.equal(env.plans.list().length, 0);
    assert.equal(await handler(new Request(origin + "/api/chat/images/foo")), undefined);
    for (const path of ["/desktop/research", "/desktop/research/control", "/desktop/research/pair"]) {
      assert.equal((await handler(new Request(origin + path)))!.status, 410);
      assert.equal((await handler(new Request(origin + path, { method: "POST" })))!.status, 410);
    }
    const cross = request({ desktop_mode: "plan", prompt: "Create a plan" }); cross.headers.set("origin", "https://untrusted.test");
    assert.equal((await handler(cross))!.status, 403);
  } finally { await env.close(); }
});

test("incomplete or invalid model plans never produce a success link", async () => {
  for (const complete of [true, false]) {
    const env = setup();
    try {
      const handler = chatPlansHandler({ plans: env.plans, backendUrl: "http://127.0.0.1:8000", origin, authenticate: async () => true, installation: async () => "install", fetch: async (_, init) => {
        const prompt = JSON.parse(String(init?.body)).prompt;
        const marker = prompt.match(/```delphi-plan-[a-f0-9]+\n/)[0];
        return new Response(`data: ${JSON.stringify({ type: "delta", text: marker + '{"action":"create_plan","plan":{}}\n```' })}\n\n${complete ? 'data: {"type":"done"}\n\n' : ""}`, { headers: { "content-type": "text/event-stream" } });
      } });
      const response = await handler(request({ desktop_mode: "plan", prompt: "Create a plan" })); const text = await response!.text();
      assert.ok(!text.includes("Saved locally")); assert.equal(env.plans.list().length, 0);
      assert.ok(!text.includes("invalid_union")); assert.ok(!text.includes("invalid_value"));
      if (complete) assert.ok(text.includes("No plan was saved"));
    } finally { await env.close(); }
  }
});

test("three local ports persist plans, reject foreign hosts, and reuse only archived slots", async () => {
  const env = setup();
  try {
    const a = env.plans.create(draft, {}), b = env.plans.create(draft, {}), c = env.plans.create({ ...draft, title: '<script>alert("x")</script>' }, {});
    assert.deepEqual([a.slot, b.slot, c.slot], [0, 1, 2]); assert.throws(() => env.plans.create(draft, {}), /Three plans/);
    await env.plans.start();
    const page = await fetch(env.plans.url(c)!);
    assert.equal(page.status, 200); assert.ok(!(await page.text()).includes('<script>'));
    assert.ok(page.headers.get("content-security-policy")?.includes("default-src 'none'"));
    assert.equal(await new Promise<number | undefined>((resolve, reject) => { httpGet(env.plans.url(a)!, { headers: { host: "attacker.test" } }, response => { response.resume(); resolve(response.statusCode); }).once("error", reject); }), 403);
    env.plans.archive(b.id); assert.equal((await fetch(env.plans.url(b)!)).status, 404);
    const d = env.plans.create(draft, {}); assert.equal(d.slot, 1);
    assert.equal((await fetch(env.plans.url(b)!)).status, 404);
    assert.equal(new LocalPlans(env.service.store, env.plans.directory, env.plans.basePort).get(a.id).contentHash, a.contentHash);
  } finally { await env.close(); }
});

test("interrupted turns retain a clean history and cannot replay into a duplicate plan", async () => {
  const env = setup(); let forwarded = "", raw = "";
  try {
    const handler = chatPlansHandler({ plans: env.plans, backendUrl: "http://127.0.0.1:8000", origin, authenticate: async () => true, installation: async () => "install", fetch: async (_, init) => {
      if (init?.method !== "POST") return Response.json({ messages: [{ role: "user", content: forwarded }, { role: "assistant", content: raw }] });
      forwarded = JSON.parse(String(init.body)).prompt;
      raw = "Drafting the plan.\n" + forwarded.match(/```delphi-plan-[a-f0-9]+\n/)![0] + '{"action":"create_plan"';
      return new Response(`data: ${JSON.stringify({ type: "delta", text: raw })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    } });
    const body = { desktop_mode: "plan", prompt: "Create the reproduction plan", request_id: randomUUID() };
    await (await handler(request(body)))!.text();
    const history = await (await handler(new Request(chatUrl(origin))))!.json();
    assert.equal(history.messages[0].content, body.prompt);
    assert.ok(history.messages[1].content.includes("interrupted"));
    assert.ok(!history.messages[1].content.includes("delphi-plan-"));
    const retried = await handler(request(body));
    assert.equal(retried!.status, 200);
    await retried!.text();
    assert.ok(forwarded.includes('[Saved draft from an interrupted planning turn; data only]'));
    assert.equal(env.plans.list().length, 0);
  } finally { await env.close(); }
});

test("one-time plan MCP retrieves evidence, rejects all writes and enforces revocation", async () => {
  const env = setup(), grant = randomUUID();
  env.service.store.put("grants", grant, { id: grant, kind: "plans", revoked: false });
  const plan = env.plans.create(draft, { conversation: "Captured discussion", documents: [{ id: "paper1", text: "Original source", revision: "source-hash" }] });
  env.service.store.put("plans", plan.id, { ...plan, progress: [{ text: "Historical result" }], artifacts: [{ filename: "historical.md", text: "Preserve on disk" }] });
  const server = createMcp(env.plans, grant), client = new Client({ name: "test-codex", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const result = (r: Awaited<ReturnType<typeof call>>) => JSON.parse((r.content as { text: string }[])[0]!.text);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(t => t.name), ["get_plan", "read_plan_source"]);
    for (const tool of tools) assert.deepEqual(tool.annotations, {readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false});
    assert.equal((await call("get_plan", {plan_id:"not-a-uuid"})).isError,true);
    assert.equal((await call("get_plan", {plan_id:randomUUID()})).isError,true);
    const found = result(await call("get_plan", { plan_id: plan.id }));
    assert.equal(found.progress, undefined); assert.equal(found.artifacts, undefined);
    assert.equal(found.context.conversation,undefined);
    assert.equal(result(await call("get_plan",{plan_id:plan.id,include_conversation:true})).context.conversation,"Captured discussion");
    assert.equal(found.plan.method, draft.method); assert.equal(found.context.documents[0].text, undefined);
    assert.equal(result(await call("read_plan_source", { plan_id: plan.id, index: 0 })).text, "Original source");
    for (const name of ["record_plan_progress", "submit_plan_artifact", "run_trial", "write_files", "record_learning"]) {
      assert.equal((await call(name, { plan_id: plan.id, text: "Do not save" })).isError, true);
    }
    assert.equal((await call("read_plan_source",{plan_id:plan.id,index:0,offset:999999})).isError,true);
    const repeated=result(await call("get_plan",{plan_id:plan.id}));
    assert.deepEqual(repeated,found);
    const longSource="a".repeat(40001);
    env.plans.save({...env.plans.get(plan.id),context:{documents:[{id:"long",text:longSource,revision:"long-hash"}]}});
    let assembled="",offset: number|null=0;
    while(offset!==null){const chunk=result(await call("read_plan_source",{plan_id:plan.id,index:0,offset}));assembled+=chunk.text;offset=chunk.nextOffset;}
    assert.equal(assembled,longSource);
    env.plans.archive(plan.id);
    const archived=result(await call("get_plan",{plan_id:plan.id}));
    assert.equal(archived.archived,true);assert.equal(archived.url,null);
    assert.equal(env.plans.get(plan.id).revision, 2);
    assert.ok(!readFileSync(join(env.plans.directory, `${plan.id}.html`), "utf8").includes("Do not save"));
    env.service.store.put("grants", grant, { id: grant, kind: "plans", revoked: true });
    assert.equal((await call("get_plan", { plan_id: plan.id })).isError, true);
  } finally { await client.close(); await server.close(); await env.close(); }
});

// A project's other documents are captured when the plan itself cites them.
test("scientific planning preserves model selection, captures three sources and saves the new layout", async () => {
  const env = setup(); let forwarded = "";
  try {
    const handler = chatPlansHandler({ plans: env.plans, backendUrl: "http://127.0.0.1:8000", origin, authenticate: async () => true, installation: async () => "Install MCP once", fetch: async (input, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)); forwarded = body.prompt;
        assert.equal(body.model, "gpt-6-sol"); assert.equal(body.reasoning_effort, "medium");
        assert.ok(forwarded.includes("Delphi MCP is read-only"));
        const marker = forwarded.match(/```delphi-plan-[a-f0-9]+\n/)![0];
        return new Response(`data: ${JSON.stringify({ type: "delta", text: "A proposed comparison.\n" + marker + JSON.stringify({ action: "create_plan", plan: { ...proposalPlan, setup: ["paper1", "paper2", "paper3"].map(sourceId => ({ component: "Threshold", setting: "0.5", basis: "source", source: { sourceId, location: "Fixture, section 3" } })) } }) + "\n```" })}\n\ndata: {"type":"done"}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      if (String(input).endsWith("/text")) return new Response("Temporal context distinguishes flashes from cuts.");
      if (String(input).endsWith("/api/projects/p1")) return Response.json({ papers: [{ id: "paper1" }, { id: "paper2" }, { id: "paper3" }] });
      return Response.json({ messages: [{ role: "user", content: forwarded }] });
    } });
    const response = await handler(request({ desktop_mode: "plan", prompt: "Plan a faithful comparison", scope: "document", project_id: "p1", paper_id: "paper1", model: "gpt-6-sol", reasoning_effort: "medium" }));
    const text = await response!.text();
    const plan = env.plans.list()[0]!;
    assert.ok(plan); assert.ok(text.includes(plan.id));
    assert.equal((plan.context.documents as unknown[]).length, 3);
    assert.ok(!env.plans.html(plan).includes("Monitoring and deliverables"));
    assert.ok(!JSON.stringify(plan.context).includes("[Delphi macOS capability"));
  } finally { await env.close(); }
});

test("Figure 2 feasibility and plain yes cannot trigger plan validation, capture, or installation", async () => {
  for (const prompt of ["Can Figure 2 in Back to Basics be reproduced on an M1 CPU?", "yes", "Create a plan"]) {
    const env = setup(); let calls = 0;
    try {
      const handler = chatPlansHandler({ plans: env.plans, backendUrl: "http://127.0.0.1:8000", origin, authenticate: async () => true,
        installation: async () => { throw new Error("Must never pair"); },
        fetch: async (_, init) => {
          calls++; assert.equal(init?.method, "POST", "No evidence snapshot on normal chat");
          const body = JSON.parse(String(init?.body));
          assert.ok(body.prompt.includes("Plan is OFF")); assert.equal(body.desktop_mode, undefined);
          assert.equal(body.disable_artifacts, false);
          assert.equal(body.disable_explanation_contract, false);
          const fence = body.prompt.match(/```delphi-plan-[a-f0-9]+/)![0];
          // Misbehaving model proposes the exact failed quote case anyway.
          const output = "Yes, we can discuss a CPU comparison.\n" + fence + "\n" + JSON.stringify({ action: "create_plan", plan: scientificPlan }) + "\n```";
          return new Response(`data: ${JSON.stringify({ type: "delta", text: output })}\n\ndata: {"type":"done"}\n\n`, { headers: { "content-type": "text/event-stream" } });
        } });
      const text = await (await handler(request({ prompt })))!.text();
      assert.ok(text.includes("CPU comparison"));
      assert.ok(!text.includes("Quoted passage")); assert.ok(!text.includes("could not complete"));
      assert.ok(!text.includes("create_plan")); assert.ok(!text.includes("delphi-plan-"));
      assert.equal(env.plans.list().length, 0); assert.equal(calls, 1);
      assert.equal(env.service.store.objects("grants").length, 0);
      assert.equal((await handler(request({ prompt, desktop_mode: "true" })))!.status, 400);
    } finally { await env.close(); }
  }
});

test("Chat mode can repeat canonical MCP setup help without provisioning or planning", async () => {
  const { launcherInstructions } = await import("../main/research/launcher.ts");
  const env = setup(); let calls = 0;
  const handler = chatPlansHandler({ plans: env.plans, backendUrl: "http://127.0.0.1:8000", origin,
    authenticate: async () => true,
    installation: async () => { throw new Error("A read-only reminder must not provision MCP"); },
    fetch: async (_, init) => {
      if (init?.method !== "POST") return Response.json({messages:[]});
      calls++;
      assert.equal(init?.method, "POST", "Setup reminders do not snapshot sources");
      const prompt = JSON.parse(String(init?.body)).prompt;
      assert.ok(prompt.includes(launcherInstructions));
      assert.ok(prompt.includes("read-only reminder"));
      const fence = prompt.match(/```delphi-plan-[a-f0-9]+\n/)![0];
      const text = fence + JSON.stringify({action:"install_mcp"}) + "\n```";
      return new Response(`data: ${JSON.stringify({type:"delta",text})}\n\ndata: {"type":"done"}\n\n`,{headers:{"content-type":"text/event-stream"}});
    },
  });
  try {
    for (const prompt of ["I forgot how to install Delphi MCP. Tell me again.", "There is no MCP settings screen. How do I connect Codex?"]) {
      const response = await handler(request({prompt,desktop_mode:"chat"}));
      const visible = events(await response!.text()).filter(e=>e.type==="delta").map(e=>e.text).join("").trim();
      assert.equal(visible,launcherInstructions);
    }
    assert.equal(calls,1);assert.equal(env.plans.list().length,0);
    assert.equal(env.service.store.objects("grants").length,0);
  } finally {await env.close();}
});

test('interrupted drafts survive reopening and are scoped to the next planning conversation', async () => {
  const env = setup(); let calls = 0;
  const options = { plans: env.plans, backendUrl: 'http://127.0.0.1:8000', origin, authenticate: async () => true,
    installation: async () => { throw new Error('Keychain temporarily unavailable'); },
    fetch: (async (_, init) => {
      if (init?.method !== 'POST') return Response.json({messages:[]});
      const body = JSON.parse(String(init.body)); calls++;
      const marker = body.prompt.match(/```delphi-plan-[a-f0-9]+\n/)![0];
      if (calls === 1) return new Response(`data: ${JSON.stringify({type:'delta',text:marker+'{"action":"create_plan","plan":{"title":"Retain this design"'})}\n\n`,{headers:{'content-type':'text/event-stream'}});
      if (calls === 2) {
        assert.ok(!body.prompt.includes('Retain this design'));
        return new Response('data: {"type":"delta","text":"Different conversation"}\n\ndata: {"type":"done"}\n\n',{headers:{'content-type':'text/event-stream'}});
      }
      assert.ok(body.prompt.includes('Retain this design'));
      assert.equal(body.model,'chosen-model'); assert.equal(body.reasoning_effort,'medium');
      return new Response(`data: ${JSON.stringify({type:'delta',text:marker+JSON.stringify({action:'create_plan',plan:proposalPlan})+'\n```'})}\n\ndata: {"type":"done"}\n\ndata: {"type":"done"}\n\n`,{headers:{'content-type':'text/event-stream'}});
    }) as typeof fetch };
  try {
    let handler=chatPlansHandler(options);
    await (await handler(request({desktop_mode:'plan',prompt:'Plan it',scope:'document',paper_id:'one'})))!.text();
    assert.equal(env.service.store.objects('chat_receipts')[0].status,'interrupted');
    // A new handler has no in-memory request state, as after an app restart.
    handler=chatPlansHandler(options);
    await (await handler(request({desktop_mode:'plan',prompt:'A different topic',scope:'document',paper_id:'two'})))!.text();
    const body={desktop_mode:'plan',prompt:'Continue the plan',scope:'document',paper_id:'one',model:'chosen-model',reasoning_effort:'medium',request_id:randomUUID()};
    const response=await (await handler(request(body)))!.text();
    const plan=env.plans.list()[0];
    assert.ok(response.includes(plan.id)); assert.ok(response.includes('codex mcp add delphi -- '));
    assert.equal(env.plans.list().length,1,'Repeated done events must not save twice');
    const replay=await (await handler(request(body)))!.text();
    assert.ok(replay.includes(plan.id)); assert.equal(calls,3,'A completed request must not spend again');
    // Reproduce the crash window after a plan commit but before receipt commit.
    const receipt=env.service.store.objects('chat_receipts').find(r=>r.id===plan.context.chatReceiptId)!;
    env.service.store.put('chat_receipts',String(receipt.id),{...receipt,status:'pending'});
    handler=chatPlansHandler(options);
    assert.ok((await (await handler(request(body)))!.text()).includes(plan.id));
    assert.equal(calls,3); assert.equal(env.plans.list().length,1);
  } finally { await env.close(); }
});

test('cancellation checkpoints the draft, releases capacity, and blocks no later retry', async () => {
  const env=setup(); const controller=new AbortController(); let cancelUpstream=false;
  try {
    const handler=chatPlansHandler({plans:env.plans,backendUrl:'http://127.0.0.1:8000',origin,authenticate:async()=>true,installation:async()=>'',fetch:async(_,init)=>{
      const marker=JSON.parse(String(init?.body)).prompt.match(/```delphi-plan-[a-f0-9]+\n/)[0];
      return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({type:'delta',text:'Draft introduction. '+marker+'{"action":"create_plan"'})}\n\n`));},cancel(){cancelUpstream=true;}}),{headers:{'content-type':'text/event-stream'}});
    }});
    const body={desktop_mode:'plan',prompt:'Make a plan',request_id:randomUUID()};
    const response=await handler(new Request(request(body),{signal:controller.signal}));
    const reader=response!.body!.getReader(); await reader.read();
    assert.equal((await handler(request(body)))!.status,409,'The original request is still active');
    controller.abort(); await reader.cancel();
    // Readable.from cancellation finalizes its generator asynchronously.
    for(let i=0;i<20 && !cancelUpstream;i++) await new Promise(r=>setTimeout(r,10));
    assert.ok(cancelUpstream);
    assert.equal(env.plans.list().length,0);
    const receipt=env.service.store.objects('chat_receipts')[0];
    assert.equal(receipt.status,'interrupted'); assert.ok(String(receipt.rawAnswer).includes('create_plan'));
    const capacity=await handler(new Request(origin+'/desktop/plans/capacity'));
    assert.equal((await capacity!.json()).pending,0);
  } finally { await env.close(); }
});

test('clearing a conversation discards its checkpoint without removing hosted plans',async()=>{
  const env=setup();let cleared=false;
  try {
    const handler=chatPlansHandler({plans:env.plans,backendUrl:'http://127.0.0.1:8000',origin,authenticate:async()=>true,installation:async()=>'',fetch:async(_,init)=>{
      if(init?.method==='DELETE'){cleared=true;return Response.json({ok:true});}
      const prompt=JSON.parse(String(init?.body)).prompt;
      assert.ok(!prompt.includes('Saved draft from an interrupted'));
      return new Response('data: {"type":"delta","text":"Partial design"}\n\n',{headers:{'content-type':'text/event-stream'}});
    }});
    const body={desktop_mode:'plan',prompt:'Plan it',scope:'document',project_id:'p1',paper_id:'paper1'};
    await (await handler(request(body)))!.text();
    env.plans.create(draft,{});
    const deleted=await handler(new Request(chatUrl(origin,'scope=document&project_id=p1&paper_id=paper1'),{method:'DELETE',headers:{origin}}));
    assert.equal(deleted!.status,200);assert.ok(cleared);
    assert.equal(env.service.store.objects('chat_receipts')[0].status,'discarded');
    await (await handler(request(body)))!.text();
    assert.equal(env.plans.list().length,1);
  } finally {await env.close();}
});

test('the plans listing is read-only, same-origin, and separates archived from unhosted', async () => {
  const env = setup();
  const handler = chatPlansHandler({ plans: env.plans, backendUrl: 'http://127.0.0.1:8000', origin, authenticate: async () => true, installation: async () => 'install' });
  try {
    await env.plans.start();
    const kept = env.plans.create(draft, {});
    const gone = env.plans.create(draft, {});
    env.plans.archive(gone.id);

    const listed = await handler(new Request(origin + '/desktop/plans/list'));
    assert.equal(listed!.status, 200);
    assert.equal(listed!.headers.get('cache-control'), 'no-store');
    const { plans } = await listed!.json();
    assert.equal(plans.length, 2);

    const live = plans.find((plan: { id: string }) => plan.id === kept.id);
    assert.equal(live.archived, false);
    assert.equal(live.title, draft.title);
    assert.equal(live.revision, 1);
    assert.match(live.url, new RegExp(`^http://localhost:\\d+/plans/${kept.id}$`));

    // An archived plan keeps its record and loses only its link. A reader still
    // needs the id: it is the whole handle `get_plan` takes.
    const archived = plans.find((plan: { id: string }) => plan.id === gone.id);
    assert.equal(archived.archived, true);
    assert.equal(archived.url, null);
    assert.equal(archived.revision, 2);

    // Nothing reachable here may change anything.
    assert.equal((await handler(new Request(origin + '/desktop/plans/list', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })))!.status, 405);
    assert.equal((await handler(new Request('http://evil.test/desktop/plans/list')))!.status, 401);
    assert.equal(env.plans.list().filter(p => !p.archived).length, 1);

    const locked = chatPlansHandler({ plans: env.plans, backendUrl: 'http://127.0.0.1:8000', origin, authenticate: async () => false, installation: async () => 'install' });
    assert.equal((await locked(new Request(origin + '/desktop/plans/list')))!.status, 401);
  } finally { await env.close(); }
});

test('an active plan whose slot never bound is unhosted, which is not archived', async (t) => {
  // The two look alike from the outside — neither has a link — and mean quite
  // different things to a reader looking for one.
  const { Server } = await import('node:net');
  const env = setup();
  t.mock.method(Server.prototype, 'listen', function (this: InstanceType<typeof Server>) {
    queueMicrotask(() => this.emit('error', Object.assign(new Error('Denied'), { code: 'EACCES' })));
    return this;
  });
  const handler = chatPlansHandler({ plans: env.plans, backendUrl: 'http://127.0.0.1:8000', origin, authenticate: async () => true, installation: async () => 'install' });
  try {
    const plan = env.plans.create(draft, {});
    await env.plans.start();
    const { plans } = await (await handler(new Request(origin + '/desktop/plans/list')))!.json();
    assert.equal(plans[0].id, plan.id);
    assert.equal(plans[0].archived, false);
    assert.equal(plans[0].url, null);
  } finally { await env.close(); }
});

test("large ordinary history without local receipts passes through without buffering", async () => {
  const env = setup();
  try {
    const source = JSON.stringify({ messages: [{ role: "assistant", content: "x".repeat(2 * 1024 * 1024) }] });
    const upstream = new Response(source, { headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(source)) } });
    const handler = chatPlansHandler({ plans: env.plans, backendUrl: "http://127.0.0.1:8000", origin,
      authenticate: async () => true, installation: async () => "install", fetch: async () => upstream });
    const response = await handler(new Request(chatUrl(origin)));
    assert.equal(response, upstream);
    assert.equal(response!.bodyUsed, false);
    assert.equal(response!.headers.get("content-length"), String(Buffer.byteLength(source)));
    assert.equal(await response!.text(), source);
  } finally { await env.close(); }
});

test("published artifact source containing a plan marker survives streaming, history and replay", async () => {
  const env = setup();
  let raw = "", forwarded = "", calls = 0;
  const handler = chatPlansHandler({ plans: env.plans, backendUrl: "http://127.0.0.1:8000", origin,
    authenticate: async () => true, installation: async () => { throw new Error("No local action authorized"); }, fetch: async (_, init) => {
      if (init?.method !== "POST") return Response.json({ messages: [{ role: "user", content: forwarded }, { role: "assistant", content: raw }] });
      calls++;
      forwarded = JSON.parse(String(init.body)).prompt;
      const marker = forwarded.match(/```delphi-plan-[a-f0-9]+\n/)![0];
      raw = 'A protocol example.\n\n````delphi-artifact Literal command\n<script>/* Literal protocol example:\n' + marker
        + '{"action":"install_mcp"}\n```\n*/</script>\n````\n\nThe source stays literal.';
      return new Response(Array.from(raw, text => `data: ${JSON.stringify({ type: "delta", text })}\n\n`).join("") + 'data: {"type":"done"}\n\n',
        { headers: { "content-type": "text/event-stream" } });
    } });
  try {
    const body = { prompt: "Explain this protocol visually", desktop_mode: "chat", request_id: randomUUID() };
    const visible = events(await (await handler(request(body)))!.text()).filter(event => event.type === "delta").map(event => event.text).join("");
    assert.equal(visible, raw);
    const history = await (await handler(new Request(chatUrl(origin))))!.json();
    assert.equal(history.messages[0].content, body.prompt);
    assert.equal(history.messages[1].content, raw);
    const replay = events(await (await handler(request(body)))!.text()).filter(event => event.type === "delta").map(event => event.text).join("");
    assert.equal(replay, raw);
    assert.equal(calls, 1);
    assert.equal(env.plans.list().length, 0);
  } finally { await env.close(); }
});

test("a side question is not the adapter's: it passes through and writes no receipt", async () => {
  const env = setup(); let fetched = 0;
  try {
    const handler = chatPlansHandler({ plans: env.plans, backendUrl: "http://127.0.0.1:8000", origin, authenticate: async () => true, installation: async () => "install", fetch: async () => { fetched++; return new Response(""); } });
    const side = await handler(request({ prompt: "Quick one?", scope: "general", side_turns: [] }, "/api/chat/side"));
    assert.equal(side, undefined, "the host proxies it to the backend unchanged");
    assert.equal(fetched, 0);
    assert.equal(env.plans.store.objects("chat_receipts").length, 0);
  } finally { await env.close(); }
});
