import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chatPlansHandler } from "../main/research/chat-plans.ts";
import { createMcp } from "../main/research/mcp.ts";
import { LocalPlans } from "../main/research/plans.ts";
import { PlanStore } from "../main/research/store.ts";
import { chatUrl, withConversation } from "./fixtures/conversation.ts";
import { proposalPlan } from "./fixtures/scientific-plan.ts";

/*
 * A reader's whole plan journey, against a fake backend: ask in Plan mode,
 * get a link, open the page, hand it to a coding agent over MCP, reopen the
 * chat, fail one save and fix it, then archive. The model's answer streams one
 * character per event, so every fence boundary is split.
 */
const origin = "http://localhost:8317";
const texts: Record<string, string> = {
  paper1: "Temporal context distinguishes flashes from cuts. Figure 2. Precision by method.",
  paper2: "Table 2. Thresholds used. A threshold of 0.5 on the frame difference.",
};
const plan = {
  ...proposalPlan,
  reference: [{ sourceId: "paper1", summary: "Compares temporal and single-frame detectors.", target: "Figure 2", pages: [],
    passages: [{ location: "Section 3", excerpt: "Temporal context distinguishes flashes from cuts." }, { location: "Section 3", excerpt: "A sentence the paper never wrote." }] }],
  setup: [
    { component: "Threshold", setting: "0.5 on the frame difference", basis: "source", source: { sourceId: "paper2", location: "Table 2" } },
    { component: "Frame tolerance", setting: "±1 frame", basis: "proposed" },
  ],
  exhibits: [{ kind: "flow", title: "Data path", caption: "The held-out clips never tune the threshold.", steps: [{ label: "Clips" }, { label: "Score", key: true }] }],
  web: [{ title: "Dataset card", url: "https://example.org/card", note: "License and split" }],
};
const undecided = { ...plan, design: { ...plan.design, runs: plan.design.runs.map(run => ({ ...run, cells: run.cells.map(cell => ({ ...cell, decisive: false })) })) } };

test("a reader plans, opens the page, hands it to an agent, reopens the chat, fixes a failed save and archives", async () => {
  const directory = mkdtempSync("/tmp/delphi-plan-workflow-");
  const store = new PlanStore(directory), plans = new LocalPlans(store, join(directory, "plans"), 19470);
  const turns: { prompt: string; answer: string }[] = [];
  const answers = [plan, undecided, plan];
  const backend: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      const prompt = JSON.parse(String(init.body)).prompt as string;
      const marker = prompt.match(/```delphi-plan-[a-f0-9]+\n/)![0];
      const answer = "Here is the comparison.\n\n" + marker + JSON.stringify({ action: "create_plan", plan: answers[turns.length] }) + "\n```";
      turns.push({ prompt, answer });
      const frames = ['data: {"type":"progress","message":"Reading Figure 2"}\n\n', ...[...answer].map(text => `data: ${JSON.stringify({ type: "delta", text })}\n\n`), 'data: {"type":"done"}\n\n'];
      return new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(new TextEncoder().encode(f)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/api/projects/p1") return Response.json({ papers: [{ id: "paper1", title: "Cuts and flashes" }, { id: "paper2", title: "Detector settings" }] });
    const text = url.pathname.match(/\/papers\/(paper\d)\/text$/)?.[1];
    if (text) return new Response(texts[text]);
    return Response.json({ messages: turns.flatMap(turn => [{ role: "user", content: turn.prompt }, { role: "assistant", content: turn.answer }]) });
  };
  const handler = chatPlansHandler({ plans, backendUrl: "http://127.0.0.1:8000", origin, authenticate: async () => true, installation: async () => "Install once", fetch: backend });
  const scope = { scope: "document", project_id: "p1", paper_id: "paper1" };
  const send = async (prompt: string) => {
    const response = await handler(new Request(origin + "/api/chat/stream", { method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(withConversation({ ...scope, desktop_mode: "plan", prompt, request_id: randomUUID() })) }));
    return (await response!.text()).trim().split("\n\n").map(frame => JSON.parse(frame.slice(5)));
  };
  const visible = (events: { type: string; text?: string }[]) => events.filter(e => e.type === "delta").map(e => e.text).join("");
  try {
    await plans.start();

    // 1. Plan mode answers with the link and the runs to hand off, never the fence.
    const first = await send("Plan a comparison of temporal context against the single-frame baseline.");
    const saved = plans.list()[0]!;
    const reply = visible(first);
    assert.ok(reply.includes(plans.url(saved)!) && !reply.includes("delphi-plan-"));
    assert.ok(reply.includes(`Use Delphi MCP plan ${saved.id}. Implement runs (1), (2) in setting (a).`));
    assert.ok(first.some(e => e.type === "progress" && e.stage === "plan_save"));
    assert.ok(turns[0]!.prompt.includes("most plans need none") && turns[0]!.prompt.includes("When web search is available"));
    assert.ok(turns[0]!.prompt.includes('"maxLength":200') && turns[0]!.prompt.includes("may rest on the discussion alone"));

    // 2. Capture keeps the cited sources and only passages the source contains.
    const documents = saved.context.documents as { id: string; text: string }[];
    assert.deepEqual(documents.map(d => d.id), ["paper1", "paper2"]);
    const stored = saved.plan as unknown as typeof plan;
    assert.deepEqual(stored.reference[0]!.passages.map(p => p.excerpt), ["Temporal context distinguishes flashes from cuts."]);
    assert.equal(stored.setup[0]!.basis, "source");

    // 3. The hosted page reads as a proposal and cites its sources by number.
    const page = await fetch(plans.url(saved)!);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const html = await page.text();
    for (const heading of ["Question", "Design", "Method", "Setup", "Reading the result", "Limits", "References"]) assert.ok(html.includes(`>${heading}</h2>`), heading);
    assert.ok(html.includes("Table 1. Planned runs.") && html.includes("Figure 1. Data path."));
    assert.ok(html.includes("Research plan from Cuts and flashes [1]") && html.includes('<span class="ref">[2, Table 2]</span>'));
    assert.ok(html.indexOf("Cuts and flashes</b>") < html.indexOf("Detector settings</b>") && html.includes("Web page, not captured by Delphi"));
    assert.ok(!html.includes("A sentence the paper never wrote") && !html.includes("<script"));

    // 4. The coding agent reads the same plan and its sources over MCP.
    const grant = randomUUID();
    store.put("grants", grant, { id: grant, kind: "plans", revoked: false });
    const server = createMcp(plans, grant), client = new Client({ name: "agent", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    try {
      const read = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content)[0]!.text);
      const got = read(await client.callTool({ name: "get_plan", arguments: { plan_id: saved.id } }));
      assert.equal(got.plan.version, 4);
      assert.deepEqual(got.plan.design.runs.map((r: { id: string }) => r.id), ["1", "2"]);
      assert.deepEqual(got.context.documents.map((d: { id: string; index: number }) => [d.id, d.index]), [["paper1", 0], ["paper2", 1]]);
      assert.equal(read(await client.callTool({ name: "read_plan_source", arguments: { plan_id: saved.id, index: 1 } })).text, texts.paper2);
    } finally { await client.close(); await server.close(); }

    // 5. Reopening the chat shows the reader's question and the saved link.
    const history = await (await handler(new Request(chatUrl(origin, new URLSearchParams(scope).toString()))))!.json();
    assert.equal(history.messages[0].content, "Plan a comparison of temporal context against the single-frame baseline.");
    assert.ok(history.messages[1].content.includes(plans.url(saved)!));

    // 6. A plan with no decisive cell is not saved, and the next turn hears why.
    const failed = visible(await send("Add a second setting."));
    assert.ok(failed.includes("No plan was saved") && !failed.includes("invalid_union"));
    assert.equal(plans.list().length, 1);
    await send("Mark the cells the conclusion rests on.");
    assert.ok(turns[2]!.prompt.includes("plan.design.runs: mark the cells the conclusion rests on as decisive"));
    assert.equal(plans.list().length, 2);

    // 7. Archiving takes the page down and keeps the record.
    const archive = await handler(new Request(origin + "/desktop/plans/archive", { method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ selected: [{ id: saved.id, revision: saved.revision }] }) }));
    assert.equal(archive!.status, 200);
    assert.equal((await fetch(`http://localhost:${saved.port ?? 19470}/plans/${saved.id}`)).status, 404);
    assert.equal(plans.get(saved.id).archived, true);
  } finally { plans.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
