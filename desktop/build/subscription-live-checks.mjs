#!/usr/bin/env node
/**
 * Live checks for the ChatGPT subscription connection, run against a real
 * unpackaged Delphi. Nothing here runs in `check.sh`: every case spends plan
 * usage and depends on the live endpoint, which is exactly what it measures.
 *
 * Start Delphi on its own profile, signed in with ChatGPT:
 *
 *   DELPHI_PLAN_PORT=8731 \
 *     node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . \
 *     --user-data-dir=<profile> --remote-debugging-port=9333
 *
 * then, with the local Node runtime:
 *
 *   node build/subscription-live-checks.mjs --port 9333 --profile <profile> filing
 *   node build/subscription-live-checks.mjs --port 9333 --profile <profile> --project <id> \
 *     --paper <id> --second <id> --image <png> chat
 *
 * `chat` opens its own threads and deletes them when it is done (`--keep` to
 * read them afterwards); `--only <case,case>` runs some of its cases.
 *
 * `filing` needs a profile with no documents yet. It adds two short related
 * notes and drains Memory's queue until it is empty: each document is chosen
 * for, written into Memory by an agent with tools and checked, and the domain
 * they share is given a written page once it holds enough. It reports each
 * job's outcome and every bridge call's route and status. Evidence is metadata
 * only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const cases = args.filter((arg, i) => !arg.startsWith("--") && (args[i - 1] === "--keep" || !args[i - 1]?.startsWith("--")));
const port = Number(option("port", "9333"));
const profile = option("profile");
if (!profile || !cases.length) { console.error("Usage: see the header of this file."); process.exit(2); }
const bridgeLog = join(profile, "logs", "inference.log");

/** Evaluates an async expression in the reader page, as the reader's own code would run it. */
async function inPage(expression) {
  const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === "page" && t.url.startsWith("http://localhost"));
  if (!target) throw new Error(`No Delphi reader on DevTools port ${port}.`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  const reply = await new Promise(resolve => {
    socket.addEventListener("message", event => { const message = JSON.parse(event.data); if (message.id === 1) resolve(message); });
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  socket.close();
  if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 500));
  return reply.result?.result?.value;
}
const api = (path, init = {}) => inPage(`fetch(${JSON.stringify(path)}, { credentials: "include", headers: { "Content-Type": "application/json" }, ...${JSON.stringify(init)} }).then(r => r.text())`);
const bridgeLines = () => existsSync(bridgeLog) ? readFileSync(bridgeLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

async function upload(projectId, path, name) {
  const base64 = readFileSync(path).toString("base64");
  return JSON.parse(await inPage(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), c => c.charCodeAt(0));
    const form = new FormData(); form.append("file", new File([bytes], ${JSON.stringify(name)}, { type: "application/pdf" }));
    const paper = await (await fetch("/api/projects/${projectId}/papers", { method: "POST", body: form, credentials: "include" })).json();
    const digest = await fetch("/api/projects/${projectId}/papers/" + paper.id + "/digest/stream", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: false }) });
    await digest.text();
    return JSON.stringify({ id: paper.id, digest: digest.status });
  })()`));
}

async function drain(limit = 60) {
  for (let i = 0; i < limit; i++) {
    await api("/api/memory/maintenance/drain", { method: "POST" });
    const readiness = JSON.parse(await api("/api/onboarding"));
    if (readiness.status === "complete" || readiness.completed >= readiness.uploaded) return readiness;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error("Filing did not finish.");
}

/** A short note as a PDF: `pages` is a list of [title, body] pairs. */
function noteFixture(name, pages) {
  const out = join(mkdtempSync(join(tmpdir(), "delphi-live-")), name);
  const python = join(root, ".delphi-build", "python", "bin", "python3");
  execFileSync(python, ["-c", `
import sys, textwrap, pikepdf
import json
pages = json.loads(sys.argv[2])
def text(font, size, x, y, line):
    escaped = line.replace("\\\\", "\\\\\\\\").replace("(", "\\\\(").replace(")", "\\\\)")
    return f"BT /{font} {size} Tf {x} {y} Td ({escaped}) Tj ET\\n"
pdf = pikepdf.new()
fonts = pikepdf.Dictionary(
    F1=pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica),
    F2=pikepdf.Dictionary(Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name("/Helvetica-Bold")))
for title, body in pages:
    stream = text("F2", 16, 54, 736, title); y = 700
    for para in body.split("\\n\\n"):
        for line in textwrap.wrap(para, 88) or [""]:
            stream += text("F1", 10.5, 54, y, line); y -= 16
        y -= 10
    page = pikepdf.Page(pikepdf.Dictionary(Type=pikepdf.Name.Page, MediaBox=[0, 0, 612, 792],
        Resources=pikepdf.Dictionary(Font=fonts), Contents=pdf.make_stream(stream.encode("latin-1"))))
    pdf.pages.append(page)
pdf.save(sys.argv[1])
`, out, JSON.stringify(pages)]);
  return out;
}

const NOTES = [
  ["prefix-caching-note.pdf", [["Prefix caching in LLM serving", `Reusing the attention key/value (KV) cache across requests that share a prompt prefix avoids recomputing that prefix. SGLang's RadixAttention keeps cached prefixes in a radix tree and reuses the longest match automatically.

A cache hit needs the shared part to come first: a prompt whose instructions and documents precede the changing question can reuse everything before the question. A changed token anywhere in the prefix ends the reuse at that token.`]]],
  ["kv-cache-eviction-note.pdf", [["Evicting a prefix cache", `A prefix cache competes with running requests for GPU memory, so a server must evict. Least-recently-used eviction over the radix tree's leaves keeps the prefixes many requests share, because an inner node stays alive while any leaf below it is in use.

Eviction interacts with prompt order: when the reusable instructions and documents come first, the shared nodes sit near the root and survive eviction longest.`]]],
];

async function filing() {
  const pages = JSON.parse(await api("/api/memory/pages"));
  if ((pages.pages ?? pages).length) throw new Error("filing needs a profile with no Memory yet.");
  const project = JSON.parse(await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Serving systems", onboarding: true }) }));
  const before = bridgeLines().length;
  const papers = [];
  for (const [name, content] of NOTES) papers.push(await upload(project.id, noteFixture(name, content), name));
  await drain();
  await api("/api/onboarding/finish", { method: "POST" });
  // The domain's page is written after its documents, once the domain holds enough.
  for (let i = 0; i < 20; i++) {
    const queue = JSON.parse(await api("/api/memory/maintenance"));
    if (!queue.due && !queue.leased) break;
    await api("/api/memory/maintenance/drain", { method: "POST" });
  }
  await new Promise(resolve => setTimeout(resolve, 2000)); // the bridge logs a call once its stream has closed
  const memory = JSON.parse(await api("/api/memory"));
  const jobs = memory.events.filter(event => ["document", "domain"].includes(event.kind))
    .map(event => ({ kind: event.kind, outcome: event.outcome, edits: (event.edits ?? []).map(edit => `${edit.action} ${edit.slug}`) }));
  const calls = bridgeLines().slice(before).filter(line => line.route === "responses")
    .map(line => ({ model: line.model, status: line.status, ms: line.ms, error: line.error }));
  const filed = jobs.filter(job => job.kind === "document" && job.outcome === "filed").length === papers.length;
  const ok = filed && calls.every(call => call.status === 200);
  console.log(JSON.stringify({ case: "filing", verdict: ok ? "PASS" : "FAIL", papers, jobs,
    kinds: memory.pages.map(page => page.kind), bridged: existsSync(bridgeLog), calls }, null, 1));
  if (!ok) process.exitCode = 1;
}

/**
 * The chat checks, in the order a reader would meet them. Each prints what was
 * measured and a verdict; the verdicts are about the connection and the shell,
 * not about how good the answer is.
 */
async function chat() {
  const [projectId, paperId, second, image] = ["project", "paper", "second", "image"].map(name => option(name));
  if (!projectId || !paperId || !second) throw new Error("chat needs --project, --paper and --second (a second document in the same project).");
  const base = { referenced_image_ids: [], selected_text: null, reasoning_effort: "medium", model: option("model", "gpt-6.1-sol"), viewport: null };
  const doc = { scope: "document", project_id: projectId, paper_id: paperId, referenced_paper_ids: [] };
  const general = { scope: "general", referenced_paper_ids: [] };
  const scopeOf = body => Object.fromEntries(Object.entries({ scope: body.scope, project_id: body.project_id, paper_id: body.paper_id }).filter(([, v]) => v));
  const open = async body => JSON.parse(await api("/api/chat/conversations", { method: "POST", body: JSON.stringify({ ...scopeOf(body), creation_key: crypto.randomUUID().replaceAll("-", "_") }) }));
  // A profile already at its limit of general chats cannot open another; the
  // web-and-Memory turn then runs in the document thread, which has the same tools.
  const threads = { document: await open(doc), general: await open(general) };
  if (!threads.document.id) throw new Error(`Could not open a document chat: ${JSON.stringify(threads.document)}`);
  const made = [[doc, threads.document]];
  if (threads.general.id) made.push([general, threads.general]);

  const searched = r => r.bridge.reduce((sum, call) => sum + (call.webSearches ?? 0), 0);
  const finished = r => r.status === 200 && !r.errors.length && r.bridge.every(call => call.status === 200);
  const suite = [
    ["document-settled", { ...doc, prompt: "What is the main contribution of this document, and where does it state it? Cite the page." },
      r => finished(r) && searched(r) === 0 && /\bp(age|\.)?\s*\d|\[\d|§/i.test(r.answer)],
    ["second turn (caching)", { ...doc, prompt: "Follow-up: what evidence does the document give for that contribution? Cite the page." },
      // The answering call is the largest one; selection and the title are small calls beside it.
      r => finished(r) && (r.bridge.toSorted((a, b) => (b.input ?? 0) - (a.input ?? 0))[0]?.cached ?? 0) > 0],
    ["outside fact", { ...doc, prompt: "What is the most recent public release of the main system this document describes? Cite the page you used." },
      r => finished(r) && searched(r) > 0 && r.sources > 0 && r.stored.sources === r.sources],
    ["@-tag", { ...doc, referenced_paper_ids: [second], prompt: "Compare this document with the tagged one on a shared idea. Cite pages from both." }, finished],
    ...(image ? [["image", { ...doc, prompt: "@[Image #1] What does this attached image show? Give its exact values.", image }, finished]] : []),
    ["web and Memory", { ...general, prompt: "Pick one claim from my Memory about inference serving, open the page it is on, and check on the web whether it still holds today. Cite both." },
      r => finished(r) && searched(r) > 0 && r.tools.some(tool => /memory/.test(tool)) && r.bridge.length > 1],
    ["long answer, high effort", { ...doc, reasoning_effort: "high", prompt: "Walk through this document section by section: for each, the claim, the evidence, and what a sceptical reviewer would ask. Be thorough." },
      r => r.status === 200 && r.stored.length > 0 && (finished(r) || Boolean(r.incomplete))],
    ["plan", { ...doc, desktop_mode: "plan", prompt: "Plan a small reproduction of this document's main measurement so my coding agent can implement it." }, r => r.status === 200],
  ];
  const only = option("only");
  let failed = 0;
  for (const [name, asked, pass] of suite) {
    if (only && !only.split(",").includes(name)) continue;
    const request = threads[asked.scope].id ? asked : { ...asked, ...doc };
    const thread = threads[request.scope];
    const { image: path, ...body } = { desktop_mode: "chat", ...base, ...request, conversation_id: thread.id, generation: thread.generation };
    const before = bridgeLines().length;
    const result = JSON.parse(await inPage(`(async () => {
      const body = ${JSON.stringify(body)};
      const scope = new URLSearchParams(${JSON.stringify(scopeOf(body))});
      if (${JSON.stringify(path ? readFileSync(path).toString("base64") : "")}) {
        const bytes = Uint8Array.from(atob(${JSON.stringify(path ? readFileSync(path).toString("base64") : "")}), c => c.charCodeAt(0));
        const form = new FormData(); form.set("image", new File([bytes], "image.png", { type: "image/png" }));
        scope.set("conversation_id", body.conversation_id);
        body.referenced_image_ids = [(await (await fetch("/api/chat/images?" + scope, { method: "POST", body: form, credentials: "include" })).json()).id];
      }
      body.request_id = crypto.randomUUID(); body.engagement_id = crypto.randomUUID().replaceAll("-", "_");
      const started = performance.now();
      const response = await fetch("/api/chat/stream", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const reader = response.body.getReader(); const decoder = new TextDecoder();
      let text = "", firstText = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (firstText === null && text.includes('"type": "delta"') || firstText === null && text.includes('"type":"delta"')) firstText = performance.now() - started;
      }
      const events = response.ok ? text.split("\\n\\n").map(b => b.split("\\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("")).filter(Boolean).map(d => { try { return JSON.parse(d); } catch { return {}; } }) : [];
      const done = events.findLast(e => e.type === "done") ?? {};
      scope.set("conversation_id", body.conversation_id);
      const history = await (await fetch("/api/chat?" + scope, { credentials: "include" })).json();
      const last = (history.messages ?? []).at(-1) ?? {};
      return JSON.stringify({ status: response.status, refusal: response.ok ? undefined : text.slice(0, 300),
        seconds: Math.round((performance.now() - started) / 1000), firstTextMs: firstText === null ? null : Math.round(firstText),
        tools: events.filter(e => e.type === "trace" && e.set?.kind === "tool" && e.set.ok !== undefined).map(e => e.set.tool),
        errors: events.filter(e => e.type === "error").map(e => String(e.message ?? e.text ?? "").slice(0, 200)),
        sources: (done.sources ?? []).length, incomplete: done.incomplete ?? null,
        stored: { role: last.role, length: (last.content ?? "").length, sources: (last.sources ?? []).length },
        answer: events.filter(e => e.type === "delta").map(e => e.text).join("") });
    })()`));
    await new Promise(resolve => setTimeout(resolve, 2000)); // the bridge logs a call once its stream has closed
    result.bridge = bridgeLines().slice(before).filter(line => line.route === "responses")
      .map(line => ({ model: line.model, status: line.status, input: line.inputTokens, cached: line.cachedTokens, ms: line.ms, webSearches: line.webSearches, error: line.error }));
    const ok = Boolean(pass(result));
    if (!ok) failed += 1;
    console.log(JSON.stringify({ case: name, verdict: ok ? "PASS" : "FAIL", ...result, answer: result.answer.slice(0, 500) }, null, 1));
  }
  if (!only || only.split(",").includes("lint")) {
    const before = bridgeLines().length;
    // The check streams its progress; it has finished when the stream has.
    const [status, stream] = JSON.parse(await inPage(`fetch("/api/memory/lint", { method: "POST", credentials: "include" }).then(async r => JSON.stringify([r.status, await r.text()]))`));
    await new Promise(resolve => setTimeout(resolve, 2000));
    const calls = bridgeLines().slice(before).filter(line => line.route === "responses");
    const ok = status === 200 && /"type": ?"done"/.test(stream) && calls.length > 0 && calls.every(line => line.status === 200);
    if (!ok) failed += 1;
    console.log(JSON.stringify({ case: "lint", verdict: ok ? "PASS" : "FAIL", status, providerCalls: calls.length,
      webSearches: calls.reduce((sum, line) => sum + (line.webSearches ?? 0), 0), errors: calls.filter(line => line.error).map(line => line.error) }, null, 1));
  }
  // The threads this run opened are its own; a reader's limit of ten is not spent on them.
  if (!args.includes("--keep")) for (const [scope, thread] of made) {
    await api(`/api/chat?${new URLSearchParams({ ...scopeOf(scope), conversation_id: thread.id, generation: String(thread.generation) })}`, { method: "DELETE" });
  }
  if (failed) process.exitCode = 1;
}

for (const name of cases) {
  if (name === "filing") await filing();
  else if (name === "chat") await chat();
  else { console.error(`Unknown case: ${name}`); process.exitCode = 2; }
}
