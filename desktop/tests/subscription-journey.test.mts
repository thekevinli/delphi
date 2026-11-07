import assert from "node:assert/strict";
import test from "node:test";
import { samplePdf } from "./fixtures/pdf.mts";
import { subscriptionWorkspace, workspaceReady } from "./fixtures/subscription-workspace.mts";
const needsBuild = { skip: !workspaceReady && !process.env.DELPHI_REQUIRE_INTEGRATION ? "run npm run build" : false };
const events = (text: string) => text.split("\n\n").flatMap(frame => frame.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))));

test("one stored Memory conversation survives ChatGPT → Claude → ChatGPT through both real bridges", { ...needsBuild, timeout: 120_000 }, async () => {
  const w = await subscriptionWorkspace();
  try {
    const conversation = await (await w.request("/api/chat/conversations", { scope: "general", creation_key: "subscription_journey" })).json();
    const before = await (await w.request("/api/memory/pages/attention")).json();
    for (const [index, id] of ["chatgpt-oauth", "claude-subscription", "chatgpt-oauth"].entries()) {
      if (index) { const switched = await w.request("/desktop/connection", { action: "switch", to: id }); assert.equal(switched.status, 200, await switched.clone().text()); }
      const config = await (await w.request("/api/config")).json();
      assert.equal(config.defaultModel, id === "claude-subscription" ? "claude-opus-5-5" : "gpt-6.1-sol");
      const response = await w.request("/api/chat/stream", { scope: "general", conversation_id: conversation.id, prompt: `Open attention and return its workflow receipt. Turn ${index}.`, model: config.defaultModel, reasoning_effort: "medium" });
      assert.equal(response.status, 200, await response.clone().text());
      const stream = events(await response.text());
      assert.deepEqual(stream.filter(e => e.type === "error"), []);
      assert.match(stream.filter(e => e.type === "delta").map(e => e.text).join(""), /WORKFLOW-RECEIPT-37/);
      assert.ok(stream.some(e => e.type === "trace" && e.set?.tool === "open_memory" && e.set.ok));
      const history = await (await w.request(`/api/chat?scope=general&conversation_id=${conversation.id}`)).json();
      assert.equal(history.messages.filter((m: any) => m.role === "assistant").length, index + 1);
      assert.equal(w.profile().connectionId, id);
      for (const key of ["username", "apiKey", "sessionSecret", "accountPassword"] as const) assert.equal(w.profile()[key], w.original[key]);
    }
    assert.deepEqual(await (await w.request("/api/memory/pages/attention")).json(), before);
    assert.ok(w.claude.calls().some(c => JSON.stringify(c.history).includes("WORKFLOW-RECEIPT-37")), "Claude received the real tool output");
    assert.ok(w.asked.some(p => p.model === "gpt-6.1-sol" && JSON.stringify(p.input).includes("Turn 1")), "ChatGPT received prior Claude conversation text after switching back");
  } finally { await w.close(); }
});

test("a real in-flight answer blocks a switch; cancellation makes it available", { ...needsBuild, timeout: 90_000 }, async () => {
  const w = await subscriptionWorkspace();
  try {
    const c = await (await w.request("/api/chat/conversations", { scope: "general", creation_key: "subscription_cancel" })).json();
    w.holdChat(true); const cancel = new AbortController();
    const answer = await w.request("/api/chat/stream", { scope: "general", conversation_id: c.id, prompt: "Keep answering." }, { signal: cancel.signal });
    const reader = answer.body!.getReader(); await reader.read();
    const blocked = await w.request("/desktop/connection", { action: "switch", to: "claude-subscription" });
    assert.equal(blocked.status, 409); assert.equal(w.profile().connectionId, "chatgpt-oauth");
    cancel.abort(); await reader.cancel().catch(() => {}); w.holdChat(false);
    for (let n = 0; n < 100 && w.controller.busy(); n++) await new Promise(r => setTimeout(r, 20));
    assert.equal(w.controller.busy(), undefined);
    assert.equal((await w.request("/desktop/connection", { action: "switch", to: "claude-subscription" })).status, 200);
  } finally { await w.close(); }
});


test("switching during background Memory filing releases its durable work", { ...needsBuild, timeout: 90_000 }, async () => {
  const w = await subscriptionWorkspace({ memoryPages: 3 });
  try {
    const queued = await w.request("/api/memory/domains/ml/compose", {});
    assert.equal(queued.status, 200, await queued.clone().text());
    const before = await (await w.request("/api/memory/maintenance")).json();
    assert.equal(before.jobs.filter((j: any) => j.kind === "domain").length, 1, JSON.stringify(before));
    w.holdChat(true); const asked = w.asked.length;
    const drain = await w.request("/api/memory/maintenance/drain", {});
    const reader = drain.body!.getReader(); await reader.read();
    for (let n = 0; n < 200 && w.asked.length === asked; n++) await new Promise(r => setTimeout(r, 20));
    assert.ok(w.asked.length > asked, "background filing reached inference");
    assert.equal(w.controller.busy(), undefined);
    const switched = await w.request("/desktop/connection", { action: "switch", to: "claude-subscription" });
    assert.equal(switched.status, 200, await switched.clone().text());
    await reader.cancel().catch(() => {});
    const after = await (await w.request("/api/memory/maintenance")).json();
    assert.equal(after.leased, 0, JSON.stringify(after));
    assert.equal(after.pending, before.pending, JSON.stringify(after));
    assert.equal(after.failed, 0, JSON.stringify(after));
    assert.deepEqual(after.jobs.map((j: any) => [j.id, j.attempts]).sort(), before.jobs.map((j: any) => [j.id, j.attempts]).sort());
  } finally { await w.close(); }
});


test("Claude web search and fetch survive a Memory round trip in both chat scopes", { ...needsBuild, timeout: 120_000 }, async () => {
  const w = await subscriptionWorkspace();
  try {
    w.claude.configure({ mode: "web-memory", tool: { name: "open_memory", arguments: { slugs: ["attention"] } }, structured: { slugs: [] } });
    assert.equal((await w.request("/desktop/connection", { action: "switch", to: "claude-subscription" })).status, 200);
    const before = await (await w.request("/api/memory/pages/attention")).json();
    const project = await (await w.request("/api/projects", { name: "Web and Memory journey" })).json();
    const form = new FormData();
    form.append("file", new Blob([samplePdf()], { type: "application/pdf" }), "web-memory.pdf");
    const upload = await fetch(`${w.origin}/api/projects/${project.id}/papers`, { method: "POST", headers: { cookie: w.cookie }, body: form });
    assert.equal(upload.status, 201, await upload.clone().text());
    const paper = (await (await w.request(`/api/projects/${project.id}`)).json()).papers[0];
    const scopes: Array<Record<string, string>> = [{ scope: "general" }, { scope: "document", project_id: project.id, paper_id: paper.id }];
    for (const scope of scopes) {
      const created = await w.request("/api/chat/conversations", { ...scope, creation_key: `web_memory_${scope.scope}` });
      assert.equal(created.status, 201, await created.clone().text());
      const conversation = await created.json();
      const response = await w.request("/api/chat/stream", { ...scope, conversation_id: conversation.id,
        prompt: "Check attention against the official web documentation and cite both.", model: "claude-sonnet-5-5", reasoning_effort: "medium" });
      assert.equal(response.status, 200, await response.clone().text());
      const stream = events(await response.text());
      assert.deepEqual(stream.filter(e => e.type === "error"), []);
      const calls = stream.filter(e => e.type === "trace" && e.set?.kind === "tool" && e.set.ok === true).map(e => e.set);
      assert.ok(calls.some(t => t.tool === "web_search" && t.args.query === "official docs"), "search reaches the reader trace");
      assert.ok(calls.some(t => t.tool === "web_search" && t.args.url === "https://example.org/docs"), "page fetch reaches the reader trace");
      assert.ok(calls.some(t => t.tool === "open_memory"), "the real Memory tool executes between provider rounds");
      const answer = stream.filter(e => e.type === "delta").map(e => e.text).join("");
      assert.match(answer, /WORKFLOW-RECEIPT-37/);
      assert.match(answer, /\[\[attention\]\]/);
      const done = stream.findLast(e => e.type === "done");
      assert.equal(done?.incomplete ?? null, null);
      assert.deepEqual(done.sources, [{ url: "https://example.org/docs", title: "Official docs" }], "web citations survive the local tool round, without duplicates");
      const history = await (await w.request(`/api/chat?${new URLSearchParams({ ...scope, conversation_id: conversation.id })}`)).json();
      const saved = history.messages.at(-1);
      assert.equal(saved.content, answer);
      assert.deepEqual(saved.sources, done.sources);
      assert.ok(saved.trace.flatMap((stretch: any) => stretch.entries).some((e: any) => e.tool === "web_search" && e.ok));
      assert.ok(saved.trace.flatMap((stretch: any) => stretch.entries).some((e: any) => e.tool === "open_memory" && e.ok));
    }
    assert.deepEqual(await (await w.request("/api/memory/pages/attention")).json(), before, "research chat does not write Memory");
    // In each scope the Memory result answered the call held by the process
    // that searched, so no process restarted from replayed history.
    assert.equal(w.claude.turns().filter(t => JSON.stringify(t.answered ?? null).includes("WORKFLOW-RECEIPT-37")).length, scopes.length);
    assert.deepEqual(w.claude.calls().filter(c => JSON.stringify(c.history).includes("WORKFLOW-RECEIPT-37")), []);
  } finally { await w.close(); }
});
