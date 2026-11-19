import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type PlanStore } from "./store.ts";
import { capturedQuote } from "./source-quotes.ts";
import { hash } from "./store.ts";
import { mcpSetup } from "./launcher.ts";
import { citedSources, renderProposal, scientificV4 } from "./plan-page.ts";

const prose = z.string().trim().min(1).max(12000);
const legacySchema = z.object({
  title: z.string().min(1).max(160), objective: prose, method: prose,
  evidence: z.array(z.object({ citation: prose, excerpt: prose }).strict()).max(20),
  steps: z.array(prose).min(1).max(20), acceptance: z.array(prose).min(1).max(20),
  dependencies: z.array(prose).max(20), constraints: z.array(prose).max(20),
  openQuestions: z.array(prose).max(20),
}).strict();
// Model-facing evidence and implementation decisions historically used different
// names for the same attribution. Accept only those known equivalents, and store
// the canonical decision vocabulary; never guess the basis of an unknown value.
const decisionBasis = z.preprocess(value => value === "literature" ? "source" : value === "proposal" ? "proposed" : value, z.enum(["source", "user", "proposed"]));
const reference = z.object({ sourceId: z.string().min(1).max(64), location: prose, excerpt: prose.optional() }).strict();
const task = z.object({ title: prose, outcome: prose, dependsOn: z.array(z.string().min(1).max(160)).max(20) }).strict();
const scientificV2 = z.object({
  version: z.literal(2), title: z.string().min(1).max(160), objective: prose, milestone: prose,
  rationale: prose,
  evidence: z.array(z.object({ claim: prose, basis: z.enum(["literature", "user", "proposal"]), references: z.array(reference).max(10), limitation: prose }).strict()).max(20),
  method: prose, tasks: z.array(task).min(1).max(20),
  evaluation: z.array(z.object({ question: prose, comparison: prose, data: prose, measure: prose, decision: prose }).strict()).max(12),
  exitCriteria: z.object({ success: prose, negative: prose, inconclusive: prose, stop: prose }).strict(),
  monitoring: z.object({ destination: prose, records: z.array(prose).min(1).max(12), review: prose, deliverables: z.array(prose).min(1).max(12) }).strict(),
  constraints: z.array(prose).max(20), openQuestions: z.array(prose).max(20),
  flow: z.array(z.string().min(1).max(180)).max(8).optional(),
  pseudocode: z.string().max(12000).optional(),
}).strict();
export const scientificV3 = scientificV2.omit({ monitoring: true, openQuestions: true, constraints: true }).extend({
  version: z.literal(3),
  reference: z.array(z.object({ sourceId: z.string().min(1).max(64), summary: prose, target: prose, pages: z.array(z.number().int().min(1).max(2000)).max(3), passages: z.array(z.object({ location: prose, excerpt: prose }).strict()).max(8) }).strict()).max(8),
  decisions: z.array(z.object({ choice: prose, setting: prose, basis: decisionBasis, reason: prose }).strict()).max(20),
}).strict();
export const researchPlanSchema = z.discriminatedUnion("version", [scientificV4, scientificV3, scientificV2]);
export const reproductionSchema = z.union([researchPlanSchema, legacySchema]);
export type Reproduction = z.infer<typeof reproductionSchema>;
export interface ChatPlan {
  id: string; revision: number; createdAt: string; archived: boolean; slot: number; port?: number;
  plan: Reproduction; context: Record<string, unknown>; contentHash: string;
}
/** A cited figure, table or algorithm must appear in the captured text; anything else in a location is prose. */
function namesCapturedElements(location: string, text: string): boolean {
  return [...location.matchAll(/\b(fig(?:ure)?s?\.?|tables?|algorithms?)\s*(\d+[a-z]?)/gi)].every(([, kind, number]) => {
    const stem = /^fig/i.test(kind!) ? "fig(?:ure)?" : /^table/i.test(kind!) ? "table" : "algorithm";
    return new RegExp(`\\b${stem}\\.?\\s*${number}\\b`, "i").test(text);
  });
}
export const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export class PlanSelectionConflict extends Error {}
export class LocalPlans {
  readonly store: PlanStore;
  readonly directory: string;
  readonly basePort: number;
  private servers: Server[] = [];
  private ports = new Map<number, number>();
  private unavailable = new Set<number>();
  constructor(store: PlanStore, directory: string, basePort = 8730) {
    if (!Number.isInteger(basePort) || basePort < 1024 || basePort > 65533) throw new Error("Invalid plan port range");
    this.store = store; this.directory = directory; this.basePort = basePort;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  list(): ChatPlan[] { return this.store.objects("plans") as unknown as ChatPlan[]; }
  get(id: string): ChatPlan { const plan = this.store.get("plans", id) as unknown as ChatPlan | undefined; if (!plan) throw new Error("Unknown plan_id"); return plan; }
  forReceipt(id: string): ChatPlan | undefined { return this.store.planForReceipt(id) as unknown as ChatPlan | undefined; }
  url(plan: ChatPlan) { return this.unavailable.has(plan.slot) ? null : `http://localhost:${this.ports.get(plan.slot) ?? plan.port ?? this.basePort + plan.slot}/plans/${plan.id}`; }
  create(input: unknown, context: Record<string, unknown>): ChatPlan {
    const plan = reproductionSchema.parse(input);
    if ("version" in plan) {
      const documents = (context.documents ?? []) as { id: string; text?: string; error?: string }[];
      if (plan.version !== 2) for (const item of plan.reference) {
        const document = documents.find(d => d.id === item.sourceId);
        if (!document?.text || document.error) throw new Error("Reference document was not captured");
        // Quotes are optional supporting material, not a prerequisite for a plan.
        // Only actual captured spans may appear as source text. Keep the target,
        // summary and full document for the coding agent when a quote fails.
        item.passages = item.passages.flatMap(passage => {
          const captured = capturedQuote(document.text!, passage.excerpt);
          return captured ? [{ ...passage, excerpt: captured }] : [];
        });
      }
      if (plan.version === 4) for (const source of citedSources(plan)) {
        const document = documents.find(d => d.id === source.sourceId);
        if (!document?.text || document.error) throw new Error("Referenced source is not available in the captured evidence");
        if (!namesCapturedElements(source.location, document.text)) throw new Error("Reference names a source element absent from captured text");
      }
      else for (const evidence of plan.evidence) {
        if (evidence.basis === "literature" && !evidence.references.length) throw new Error("Literature claims require captured source references");
        for (const reference of evidence.references) {
          const document = documents.find(d => d.id === reference.sourceId);
          if (!document || document.error || !document.text) throw new Error("Referenced source is not available in the captured evidence");
          const captured = reference.excerpt ? capturedQuote(document.text, reference.excerpt) : undefined;
          if (captured) reference.excerpt = captured;
          else delete reference.excerpt;
        }
      }
    }
    const used = new Set(this.list().filter(p => !p.archived).map(p => p.slot));
    const slot = [0, 1, 2].find(s => !used.has(s));
    if (slot === undefined) throw new Error("Three plans are already hosted. Use the plan capacity checklist to archive a plan before creating another.");
    const record: ChatPlan = { id: randomUUID(), revision: 1, createdAt: new Date().toISOString(), archived: false, slot, port: this.ports.get(slot), plan, context, contentHash: hash(JSON.stringify({ plan, context })) };
    this.save(record); return record;
  }
  save(plan: ChatPlan) {
    // HTML is an escaped rendering of typed data, never model-generated scripts.
    const target = join(this.directory, `${plan.id}.html`), temp = `${target}.tmp`;
    writeFileSync(temp, this.html(plan), { mode: 0o600 }); renameSync(temp, target);
    this.store.put("plans", plan.id, plan);
  }
  archiveSelected(selection: { id: string; revision: number }[]) {
    // Hosted HTML is rendered from the committed record. Keep the existing file
    // as the recoverable snapshot; no filesystem mutation participates in this transaction.
    return this.store.transaction(() => {
      const records = selection.map(item => {
        const plan = this.list().find(p => p.id === item.id);
        if (!plan || plan.archived || plan.revision !== item.revision) throw new PlanSelectionConflict("The plan list changed. Review the current plans and try again.");
        return { ...plan, archived: true, revision: plan.revision + 1 };
      });
      for (const plan of records) this.store.put("plans", plan.id, plan);
      return records;
    });
  }
  archive(id: string) { const plan = this.get(id); plan.archived = true; plan.revision++; this.save(plan); return plan; }
  html(record: ChatPlan) { return renderPlan(record); }
  async start() {
    for (let slot = 0; slot < 3; slot++) {
      let port = this.list().find(p => !p.archived && p.slot === slot)?.port ?? this.basePort + slot;
      const server = createServer((req, res) => {
        if (req.headers.host !== `localhost:${port}` || !["GET", "HEAD"].includes(req.method ?? "")) { res.writeHead(403).end(); return; }
        const plan = this.list().find(p => !p.archived && p.slot === slot && req.url === `/plans/${p.id}`);
        if (!plan) { res.writeHead(404).end("Plan not hosted. Ask Delphi for its current plan link."); return; }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
        res.end(req.method === "HEAD" ? undefined : this.html(plan));
      });
      const listen = (preferred: number) => new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.removeListener("listening", ready); reject(error); };
        const ready = () => { server.removeListener("error", failed); resolve(); };
        server.once("error", failed); server.once("listening", ready); server.listen(preferred, "localhost");
      });
      try {
        try { await listen(port); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; await listen(0); }
        port = (server.address() as {port: number}).port;
        this.ports.set(slot, port); this.unavailable.delete(slot); this.servers.push(server);
        for (const plan of this.list().filter(p => !p.archived && p.slot === slot)) {
          plan.port = port; this.store.put("plans", plan.id, plan);
        }
      } catch (error) {
        server.close(() => {}); this.unavailable.add(slot);
        console.error("Plan HTML hosting unavailable; saved plans remain accessible through MCP", error);
      }
    }
  }
  close() { for (const server of this.servers) { server.closeAllConnections(); server.close(); } this.servers = []; }
}

/** Render only typed text and fixed markup: no model HTML, remote assets or scripts. */
export function renderPlan(record: ChatPlan): string {
  const p = record.plan, esc = escapeHtml;
  if ("version" in p && p.version === 4) return renderProposal({ ...record, plan: p }, esc, mcpSetup.command);
  const contents: { id: string; title: string }[] = [];
  const section = (title: string, body: string) => {
    const label = title.replace(/^\d+\.\s*/, "");
    const id = `section-${contents.length + 1}`;
    contents.push({ id, title: label });
    // A fragment inside the body lets Chromium reveal a closed details element
    // on contents navigation, without giving the plan any script privileges.
    return `<details class="plan-section" open><summary><span class="chevron" aria-hidden="true"></span><h2>${contents.length}. ${esc(label)}</h2></summary><div id="${id}" class="section-content">${body}</div></details>`;
  };
  const list = (values: string[]) => `<ul>${values.map(v => `<li>${esc(v)}</li>`).join("")}</ul>`;
  // Every boxed note is this one component: a full hairline frame with an optional
  // label row, the same panel language as the tables. Emphasis comes from the label
  // row's tint, never a thick one-sided stripe; the plan tests reject side borders.
  const callout = (body: string, { label, tone = "neutral", foot }: { label?: string; tone?: "neutral" | "accent" | "quiet"; foot?: string } = {}) =>
    `<aside class="callout callout-${tone}">${label ? `<div class="callout-label">${esc(label)}</div>` : ""}<div class="callout-body">${body}</div>${foot ? `<div class="callout-foot">${foot}</div>` : ""}</aside>`;
  const table = (heads: string[], rows: string[][]) => `<div class="table-wrap"><table><thead><tr>${heads.map(h => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  let body: string;
  if ("version" in p) {
    const documents = (record.context.documents ?? []) as { id: string; title?: string }[];
    const sourceTitle = (id: string) => documents.find(d => d.id === id)?.title || id;
    const sourceIds = [...new Set(p.evidence.flatMap(e => e.references.map(r => r.sourceId)))];
    const images = (record.context.referenceImages ?? []) as { sourceId: string; page: number; data: string }[];
    const referenceSection = p.version === 3 ? section("Reference", p.reference.map(r => `<article><h3>${esc(sourceTitle(r.sourceId))}</h3><p><strong>${esc(r.target)}</strong></p><p>${esc(r.summary)}</p>${images.filter(i => i.sourceId === r.sourceId && r.pages.includes(i.page)).map(i => `<figure><img class="source-page" src="data:image/png;base64,${/^[A-Za-z0-9+/=]+$/.test(i.data) ? i.data : ""}" alt="Captured source page ${i.page}"><figcaption>${esc(sourceTitle(r.sourceId))} · Source page ${i.page} (full page; includes surrounding context)</figcaption></figure>`).join("")}${r.pages.some(page => !images.some(i => i.sourceId === r.sourceId && i.page === page)) ? '<p class="muted">Requested source image unavailable. Consult the captured source text; no image has been reconstructed.</p>' : ""}${r.passages.length ? callout(r.passages.map(t => `<p><strong>${esc(t.location)}</strong><br>${esc(t.excerpt)}</p>`).join(""), { label: "Corresponding source text", tone: "quiet" }) : '<p class="muted">No verbatim passage attached. The captured document is available through Delphi MCP for source checking.</p>'}</article>`).join("")) : "";
    body = referenceSection + section("1. Scientific goal and first milestone", `<p>${esc(p.rationale)}</p>` + callout(`<p>${esc(p.milestone)}</p>`, { label: "First milestone", tone: "accent" }))
      + section("2. Literature and discussion basis", table(["Claim or decision", "Basis", "Source", "Limits / assumptions"], p.evidence.map(e => [e.claim, { literature: "Literature interpretation", user: "User requirement", proposal: "Proposed experiment" }[e.basis], e.references.map(r => `[${sourceIds.indexOf(r.sourceId) + 1}] ${sourceTitle(r.sourceId)} · ${r.location}`).join("; ") || "Conversation / proposed choice", e.limitation]))
)
      + section("3. Approach", `<p>${esc(p.method)}</p>` + (p.flow?.length ? `<ol class="flow" aria-label="Proposed research sequence">${p.flow.map(v => `<li>${esc(v)}</li>`).join("")}</ol>` : "") + (p.pseudocode ? `<h3>Conceptual pseudocode</h3><pre><code>${esc(p.pseudocode)}</code></pre>` : ""))
      + section("4. Research tasks", table(["Task", "Expected outcome", "Dependencies"], p.tasks.map(t => [t.title, t.outcome, t.dependsOn.join("; ") || "None specified"])))
      + section("5. Evaluation", p.evaluation.length ? table(["Question", "Comparison / baseline", "Data", "Measure", "Decision rule"], p.evaluation.map(e => [e.question, e.comparison, e.data, e.measure, e.decision])) : `<p>No quantitative evaluation specified. Use the decision criteria below.</p>`)
      + section("6. Exit criteria", table(["Outcome", "Criterion"], [["Success", p.exitCriteria.success], ["Negative result", p.exitCriteria.negative], ["Inconclusive", p.exitCriteria.inconclusive], ["Stop", p.exitCriteria.stop]]))
      + (p.version === 3 && p.decisions.length ? section("Implementation decisions", table(["Choice", "Concrete setting", "Basis", "Reason"], p.decisions.map(d => [d.choice, d.setting, d.basis === "source" ? "Source-reported" : d.basis === "user" ? "User requirement" : "Chosen baseline", d.reason]))) : "");
  } else {
    body = callout("<p>Earlier plan format. Additional details have not been inferred or added.</p>", { tone: "quiet" })
      + section("Method", `<p>${esc(p.method)}</p>`)
      + section("Research tasks", table(["Task", "Description"], p.steps.map((t, i) => [String(i + 1), t])))
      + section("Evidence", p.evidence.map(e => callout(`<p>${esc(e.excerpt)}</p>`, { tone: "quiet", foot: esc(e.citation) })).join(""))
      + section("Acceptance criteria", list(p.acceptance))
      + section("Dependencies and constraints", list([...p.dependencies, ...p.constraints]))
      + section("Open questions", list(p.openQuestions));
  }
  const navigation = `<nav class="plan-contents" aria-label="Plan contents"><h2>Contents <span>${contents.length} sections</span></h2><ol>${contents.map(item => `<li><a href="#${item.id}">${esc(item.title)}</a></li>`).join("")}</ol></nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(p.title)} · Delphi</title><style>
  :root{--paper:#f7f6f2;--card:#fff;--surface:#efeee8;--line:#e3e2db;--line-strong:#cfcec6;--ink:#17201c;--text:#343d39;--muted:#6c7470;--accent:#2e6a50;--accent-strong:#1e4a38;--accent-soft:#e7f0ea;--accent-line:#b9d2c3;--code:#1f2925}
  *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--text);font:16px/1.65 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  main{max-width:1100px;margin:48px auto;padding:0 36px 60px}
  header{padding:30px 0 34px;border-bottom:1px solid var(--line-strong)}
  .eyebrow{font-size:12px;font-weight:600;letter-spacing:.14em;color:var(--accent);text-transform:uppercase}
  h1{font-family:Georgia,serif;font-size:clamp(32px,5vw,48px);line-height:1.16;max-width:920px;margin:18px 0;color:var(--ink);letter-spacing:-.01em}
  h2{font-size:23px;line-height:1.3;margin:0 0 20px;color:var(--ink)}h3{font-size:16px;color:var(--ink)}
  p{white-space:pre-wrap;margin:12px 0}strong{color:var(--ink);font-weight:650}
  .lead{font-size:20px;max-width:850px;color:var(--text)}
  section{padding:32px 0;border-bottom:1px solid var(--line)}
  .callout{margin:24px 0;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;overflow-wrap:anywhere;font-size:15px}
  .callout-label{padding:9px 20px;background:var(--surface);border-bottom:1px solid var(--line);color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
  .callout-body{padding:4px 20px}.callout-body p{margin:12px 0}
  .callout-foot{padding:10px 20px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
  .callout-accent{border-color:var(--accent-line)}.callout-accent .callout-label{background:var(--accent-soft);border-color:var(--accent-line);color:var(--accent-strong)}
  .callout-quiet{background:var(--surface);border-color:transparent}.callout-quiet .callout-label{background:none;border:0;padding:14px 20px 0}.callout-quiet .callout-foot{border-color:var(--line-strong)}
  .callout code{background:var(--surface);padding:1px 6px;border-radius:5px;color:var(--ink)}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th{text-align:left;background:var(--surface);color:var(--muted);font-size:12.5px;font-weight:600;letter-spacing:.02em}
  th,td{padding:14px;vertical-align:top;border-bottom:1px solid var(--line);min-width:120px;overflow-wrap:anywhere;white-space:pre-wrap}
  td:first-child{font-weight:550;color:var(--ink)}tbody tr:hover td{background:#fbfaf7}
  .table-wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}.table-wrap tr:last-child td{border-bottom:0}
  footer,.muted{font-size:13px;color:var(--muted)}figcaption,summary{font-size:13px;color:var(--muted)}
  footer{margin-top:28px}code{overflow-wrap:anywhere}
  pre{background:var(--code);color:#eef1ea;padding:22px;border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}pre code{background:none;padding:0;color:inherit}
  .columns{display:grid;grid-template-columns:1fr 1fr;gap:32px}li{padding:5px 0}
  .flow{display:flex;flex-wrap:wrap;gap:12px;list-style-position:inside;padding:0}
  .flow li{background:var(--card);border:1px solid var(--line);padding:12px 18px;border-radius:8px;flex:1;min-width:140px}.flow li::marker{color:var(--accent);font-weight:650}
  a{color:var(--accent)}
  .source-page{width:100%;max-width:760px;height:auto;border:1px solid var(--line);border-radius:6px;background:var(--card)}figure{margin:20px 0}
  details{margin:16px 0}article+article{margin-top:28px;padding-top:28px;border-top:1px dashed var(--line-strong)}

  .plan-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:44px;max-width:1440px;margin:48px auto;padding:0 36px}
  .plan-layout>main{min-width:0;max-width:none;margin:0;padding:0 0 60px}
  .plan-contents{position:sticky;top:32px;align-self:start;max-height:calc(100vh - 64px);overflow:auto;margin-top:calc(30px + 12px * 1.65 + 18px);padding:0 0 16px}
  .plan-contents h2{font-size:12px;text-transform:uppercase;letter-spacing:.12em;margin:0 0 18px;color:var(--muted)}
  .plan-contents h2 span{display:block;margin-top:4px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--muted);opacity:.8}
  .plan-contents ol{list-style:none;padding:0;margin:0;font-size:14px;counter-reset:toc}
  .plan-contents li{display:grid;grid-template-columns:1.7em minmax(0,1fr);padding:6px 0;counter-increment:toc;break-inside:avoid}
  .plan-contents li::before{content:counter(toc) ".";color:var(--muted);font-variant-numeric:tabular-nums}
  .plan-contents a{text-decoration:none;color:var(--text)}.plan-contents a:hover{color:var(--accent)}
  .plan-section{padding:22px 0;border-bottom:1px solid var(--line);margin:0}
  .plan-section>summary{display:flex;align-items:center;gap:10px;cursor:pointer;color:inherit;list-style:none}
  .plan-section>summary::-webkit-details-marker{display:none}
  .chevron{position:relative;flex:0 0 28px;width:28px;height:28px;border-radius:7px;transition:transform .18s ease}
  .chevron::before{content:'';position:absolute;top:50%;left:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border:solid var(--muted);border-width:0 2px 2px 0;transform:translateX(-2px) rotate(-45deg)}
  .plan-section[open]>summary .chevron{transform:rotate(90deg)}
  .plan-section>summary:hover .chevron{background:var(--surface)}.plan-section>summary:hover .chevron::before{border-color:var(--accent)}
  .plan-section>summary h2{font-size:22px;font-weight:650;letter-spacing:-.005em;margin:0}
  .plan-section:not([open])>summary h2{color:var(--text)}
  .section-content{padding-top:18px;scroll-margin-top:90px}
  summary{border-radius:8px}summary:focus-visible,.plan-contents a:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
  @media(max-width:900px){.plan-layout{grid-template-columns:1fr;gap:20px;margin:20px auto;padding:0 20px}.plan-contents{position:static;max-height:none;margin-top:0;padding-top:16px;border-bottom:1px solid var(--line)}.plan-contents ol{columns:2;column-gap:28px}.plan-section>summary h2{font-size:20px}}
  @media(max-width:650px){main{margin:12px auto;padding:0 20px 35px}.columns{grid-template-columns:1fr;gap:8px}th,td{padding:10px}.lead{font-size:18px}}
  @media(max-width:500px){.plan-contents ol{columns:1}}
  @media print{body{background:white;color:#111}main{max-width:none;margin:0;padding:0}section{break-inside:auto}tr,.callout{break-inside:avoid}.table-wrap{overflow:visible;border:0}th,td{min-width:0;font-size:11px;padding:8px}h2,h3{break-after:avoid}.callout{background:#fff;border-color:#ccc}.callout-label{background:#eee}pre{background:#eee;color:#111}
    .plan-layout{display:block;margin:0;padding:0}.plan-contents,.chevron{display:none}.plan-section::details-content{display:block!important;content-visibility:visible!important}.plan-section>summary{break-after:avoid}.section-content{padding-top:12px}}
  </style></head><body><div class="plan-layout">${navigation}<main><header><div class="eyebrow">Delphi · Literature-grounded research plan${record.archived ? " · Archived" : ""}</div><h1>${esc(p.title)}</h1><p class="lead">${esc(p.objective)}</p></header>${callout(`<p>Use Delphi MCP to retrieve plan_id <code>${record.id}</code>. Read the reference, implementation decisions, evaluation, and exit criteria, then implement in my workspace.</p><details><summary>MCP setup instructions</summary><p>${esc(mcpSetup.introduction)}</p><pre><code>${esc(mcpSetup.command)}</code></pre><p>${esc(mcpSetup.troubleshooting)}</p><p>${esc(mcpSetup.completion)}</p></details>`, { label: "Continue in your coding agent", foot: `Read-only handoff · Keep Delphi open · revision ${record.revision}` })}${body}<footer><p>Execution and monitoring belong in your chosen tools. Delphi does not receive implementation updates or results through MCP. You can add an external report to your library later.</p></footer></main></div></body></html>`;
}
