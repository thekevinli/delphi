import { z } from "zod";

/**
 * What a research plan says, and the page it reads as: a question, Table 1 of
 * runs by settings, the method and setup that hold them fixed, and how each
 * outcome would be read. Runs and settings carry ids, so a coding agent can be
 * told "implement runs (1), (3) in setting (a)". Beyond Table 1 the model may
 * add up to three exhibits from `exhibitKinds`, or none; the prompt's guide and
 * the schema come from the same list, so a kind the page cannot draw cannot be
 * written. The backend's plan page is the same page.
 */

const text = (limit: number) => z.string().trim().min(1).max(limit);
const prose = text(12000);
const settingId = z.string().regex(/^[a-h]$/);
const sourceRef = z.object({ sourceId: text(64), location: prose }).strict().nullish();

const design = z.object({
  settings: z.array(z.object({ id: settingId, label: text(80), detail: z.string().trim().max(160).default("") }).strict()).min(1).max(6),
  runs: z.array(z.object({
    id: z.string().regex(/^\d{1,2}$/), group: text(60), label: text(160),
    cells: z.array(z.object({ setting: settingId, reports: text(160), decisive: z.boolean().default(false) }).strict()).max(8),
  }).strict()).min(1).max(16),
  caption: text(600),
}).strict().superRefine((value, ctx) => {
  const settings = value.settings.map(s => s.id);
  if (new Set(settings).size !== settings.length || new Set(value.runs.map(r => r.id)).size !== value.runs.length) ctx.addIssue({ code: "custom", message: "run and setting ids must be unique" });
  for (const run of value.runs) {
    const named = run.cells.map(c => c.setting);
    if (new Set(named).size !== named.length || named.some(id => !settings.includes(id))) ctx.addIssue({ code: "custom", path: ["runs"], message: "each cell names one listed setting" });
  }
  if (!value.runs.some(r => r.cells.some(c => c.decisive))) ctx.addIssue({ code: "custom", path: ["runs"], message: "mark the cells the conclusion rests on as decisive" });
});

const setupRow = z.object({ component: text(80), setting: prose, basis: z.enum(["source", "user", "proposed"]), source: sourceRef }).strict()
  .refine(row => row.basis !== "source" || row.source, { message: "a source-reported setting cites its source", path: ["source"] });
const bar = z.object({ label: text(60), value: z.number().min(0).max(1e9), basis: z.enum(["source", "computed"]), detail: text(200), source: sourceRef }).strict()
  .refine(row => row.basis !== "source" || row.source, { message: "a source-reported value cites its source", path: ["source"] });

const caption = { title: text(120), caption: text(600) };
/** Each kind the page can draw, with when to reach for it. */
export const exhibitKinds = {
  table: {
    use: "Compare exact values or options across a few named attributes, when the reader will look values up.",
    schema: z.object({ kind: z.literal("table"), ...caption, columns: z.array(text(60)).min(2).max(6), rows: z.array(z.array(text(200))).min(1).max(12) }).strict()
      .refine(t => t.rows.every(row => row.length === t.columns.length), { message: "every row has one value per column", path: ["rows"] }),
  },
  flow: {
    use: "Show what feeds what and what is held out, when the order or data path is the hard part to follow.",
    schema: z.object({ kind: z.literal("flow"), ...caption, steps: z.array(z.object({ label: text(40), note: z.string().trim().max(80).default(""), key: z.boolean().default(false) }).strict()).min(2).max(7) }).strict(),
  },
  bars: {
    use: "Compare one quantity (time, memory, cost, data size) across runs or options, when relative size is the point.",
    schema: z.object({ kind: z.literal("bars"), ...caption, unit: text(24), bars: z.array(bar).min(2).max(10) }).strict(),
  },
};
const exhibit = z.union([exhibitKinds.table.schema, exhibitKinds.flow.schema, exhibitKinds.bars.schema]);

export const scientificV4 = z.object({
  version: z.literal(4), title: text(160), question: prose, scope: prose, design,
  method: prose, order: z.array(text(300)).min(1).max(8), pseudocode: z.string().max(12000).default(""),
  setup: z.array(setupRow).max(20), readings: z.array(z.object({ when: text(200), then: prose }).strict()).min(1).max(8), limits: prose,
  reference: z.array(z.object({ sourceId: text(64), summary: prose, target: prose, pages: z.array(z.number().int().min(1).max(2000)).max(3), passages: z.array(z.object({ location: prose, excerpt: prose }).strict()).max(8) }).strict()).max(8),
  web: z.array(z.object({ title: text(200), url: z.string().max(500).regex(/^https:\/\/[^\s"'<>]+$/), note: z.string().trim().max(300).default("") }).strict()).max(8).default([]),
  exhibits: z.array(exhibit).max(3).default([]),
}).strict().refine(plan => new Set(plan.reference.map(r => r.sourceId)).size === plan.reference.length, { message: "one reference entry per document", path: ["reference"] });
export type ProposalPlan = z.infer<typeof scientificV4>;

/** Every source location the plan cites outside its reference entries: setup rows and bars. */
export function citedSources(plan: ProposalPlan): { sourceId: string; location: string }[] {
  const bars = plan.exhibits.flatMap(e => e.kind === "bars" ? e.bars : []);
  return [...plan.setup, ...bars].flatMap(item => item.source ? [item.source] : []);
}

/** A bar's value as the backend's page writes it (Python's `.10g`): ten significant digits, an exponent only below 1e-4. */
const number = (value: number) => value !== 0 && value < 1e-4
  ? value.toExponential(9).replace(/\.?0+e/, "e").replace(/e-(\d)$/, "e-0$1")
  : String(Number(value.toPrecision(10)));

export const exhibitGuide = "Table 1 is drawn from design, the runs by settings, on every plan. Add an exhibit only when it shows something Table 1 and the prose cannot; most plans need none. Choose the kind by the question the reader will ask, never for variety: a chart of values the reader will look up is worse than a table, and a diagram of a sequence a numbered list states is clutter. Never draw results: every number is cited from a source or computed, with the location or formula in detail.\n"
  + Object.entries(exhibitKinds).map(([kind, { use }]) => `- ${kind}: ${use}`).join("\n");

type Exhibit = ProposalPlan["exhibits"][number];

/** What to tell a coding agent: the runs in the first setting the conclusion rests on. */
export function handoffPrompt(plan: ProposalPlan, id: string): string {
  const settings = plan.design.settings.map(s => s.id);
  const decisive = settings.find(s => plan.design.runs.some(r => r.cells.some(c => c.setting === s && c.decisive))) ?? settings[0];
  const runs = plan.design.runs.filter(r => r.cells.some(c => c.setting === decisive)).map(r => `(${r.id})`).join(", ");
  return `Use Delphi MCP plan ${id}. Implement runs ${runs} in setting (${decisive}). Hold Setup fixed and ask before changing it.`;
}
interface PageRecord { id: string; revision: number; archived: boolean; plan: ProposalPlan; context: Record<string, unknown> }

/** The plan as a proposal. Only typed text and fixed markup: no model HTML, remote assets or scripts. */
export function renderProposal(record: PageRecord, esc: (value: unknown) => string, connect: string): string {
  const p = record.plan;
  const documents = (record.context.documents ?? []) as { id: string; title?: string; error?: string }[];
  const images = (record.context.referenceImages ?? []) as { sourceId: string; page: number; data: string }[];
  const order = [...new Set([...p.reference.map(r => r.sourceId), ...citedSources(p).map(c => c.sourceId), ...documents.map(d => d.id)])];
  const cite = (ref: { sourceId: string; location: string }) => `<span class="ref">[${order.indexOf(ref.sourceId) + 1}, ${esc(ref.location)}]</span>`;
  const table = (heads: string[], rows: string[][], kind: string) => `<table class="${kind}"><thead><tr>${heads.map(h => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const numbers = { table: 1, figure: 0 };
  const draw = (item: Exhibit) => {
    const family = item.kind === "table" ? "table" : "figure";
    const label = `${family === "table" ? "Table" : "Figure"} ${++numbers[family]}`;
    const drawn = item.kind === "table" ? table(item.columns.map(esc), item.rows.map(row => row.map(esc)), "plain")
      : item.kind === "flow" ? `<ol class="flow">${item.steps.map(s => `<li class="${s.key ? "key" : ""}"><b>${esc(s.label)}</b>${s.note ? `<span>${esc(s.note)}</span>` : ""}</li>`).join("")}</ol>`
      : `<div class="bars">${item.bars.map(b => `<span>${esc(b.label)}</span><span class="bar"><i style="width:${(b.value / (Math.max(...item.bars.map(x => x.value)) || 1) * 100).toFixed(1)}%"></i><em>${number(b.value)} ${esc(item.unit)}</em></span><small>${esc(b.basis)}${b.source ? " " + cite(b.source) : ""}: ${esc(b.detail)}</small>`).join("")}</div>`;
    return `<figure>${drawn}<figcaption><b>${label}. ${esc(item.title)}.</b> ${esc(item.caption)}</figcaption></figure>`;
  };

  const settings = p.design.settings.map(s => s.id);
  const heads = ["Run", ...p.design.settings.map(s => `(${esc(s.id)}) ${esc(s.label)}<small>${esc(s.detail)}</small>`)];
  let group: string | undefined;
  const rows = p.design.runs.flatMap(run => {
    const cells = new Map(run.cells.map(c => [c.setting, c]));
    const line = `<tr><td><span class="run">(${esc(run.id)})</span> ${esc(run.label)}</td>${settings.map(s => {
      const cell = cells.get(s);
      return !cell ? '<td class="none">·</td>' : `<td${cell.decisive ? ' class="decisive"' : ""}>${esc(cell.reports)}</td>`;
    }).join("")}</tr>`;
    const opens = run.group !== group; group = run.group;
    return opens ? [`<tr class="group"><td colspan="${heads.length}">${esc(run.group)}</td></tr>`, line] : [line];
  });
  const matrix = `<table class="design"><thead><tr>${heads.map(h => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table><p class="caption"><b>Table 1. Planned runs.</b> ${esc(p.design.caption)}</p>`;
  // Numbered in reading order: a flow is drawn in Method, everything else in Design.
  const others = p.exhibits.filter(e => e.kind !== "flow").map(draw);
  const flows = p.exhibits.filter(e => e.kind === "flow").map(draw);

  const setup = p.setup.length ? table(["Component", "Setting", "Basis"], p.setup.map(s => [esc(s.component), esc(s.setting), esc(s.basis) + (s.source ? " " + cite(s.source) : "")]), "setup") : "";
  const readings = table(["If", "Then"], p.readings.map(r => [esc(r.when), esc(r.then)]), "readings");
  const source = (id: string) => {
    const document = documents.find(d => d.id === id), target = p.reference.find(r => r.sourceId === id);
    let item = `<b>${esc(document?.title || id)}</b>${document?.error ? ` <span class="muted">${esc(document.error)}</span>` : ""}`;
    if (target) {
      item += `<p>${esc(target.target)}. ${esc(target.summary)}</p>` + target.passages.map(t => `<p class="quote">${esc(t.location)}: “${esc(t.excerpt)}”</p>`).join("");
      for (const page of target.pages) {
        const image = images.find(i => i.sourceId === id && i.page === page);
        item += image && /^[A-Za-z0-9+/=]+$/.test(image.data)
          ? `<figure><img alt="Captured source page ${page}" src="data:image/png;base64,${image.data}"><figcaption>Source page ${page}, captured with this plan.</figcaption></figure>`
          : `<p class="muted">Page ${page} could not be captured; read the source text instead.</p>`;
      }
    }
    return `<li>${item}</li>`;
  };
  const references = order.map(source).join("") + p.web.map(w => `<li><b><a href="${esc(w.url)}" rel="noreferrer">${esc(w.title)}</a></b> <span class="muted">Web page, not captured by Delphi.</span>${w.note ? `<p>${esc(w.note)}</p>` : ""}</li>`).join("");

  const handoff = `<details class="handoff"><summary>Hand off</summary><div class="handoff-panel"><div><span class="label">1 · Connect Delphi once</span><pre>${esc(connect)}</pre><p>Set up the launcher first from Help → Set Up Delphi MCP. The connection is local and read-only; keep Delphi open.</p></div><div><span class="label">2 · Point at runs from Table 1</span><pre>${esc(handoffPrompt(p, record.id))}</pre></div></div></details>`;
  const lead = documents.find(d => d.id === order[0])?.title;
  const byline = `${lead ? `Research plan from ${esc(lead)} [1]` : "Research plan"} · revision ${record.revision}${record.archived ? " · archived" : ""}`;

  const sections: [string, string, string][] = ([
    ["question", "Question", `<p>${esc(p.question)}</p><p>${esc(p.scope)}</p>`],
    ["design", "Design", matrix + others.join("")],
    ["method", "Method", `<p>${esc(p.method)}</p>${flows.join("")}<ol class="order">${p.order.map(step => `<li>${esc(step)}</li>`).join("")}</ol>${p.pseudocode ? `<details><summary>Pseudocode</summary><pre>${esc(p.pseudocode)}</pre></details>` : ""}`],
    ["setup", "Setup", setup],
    ["reading", "Reading the result", readings],
    ["limits", "Limits", `<p>${esc(p.limits)}</p>`],
    ["references", "References", references ? `<ol>${references}</ol>` : ""],
  ] as [string, string, string][]).filter(([, , body]) => body);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(p.title)} · Delphi</title><style>${PROPOSAL_CSS}</style></head><body><div class="page"><nav aria-label="Sections">${sections.map(([key, title]) => `<a href="#${key}">${title}</a>`).join("")}</nav><main><header><div class="title"><h1>${esc(p.title)}</h1>${handoff}</div><p class="byline">${byline}</p></header>${sections.map(([key, title, body]) => `<section id="${key}" aria-labelledby="${key}-title"><h2 id="${key}-title">${title}</h2>${body}</section>`).join("")}</main></div></body></html>`;
}

const PROPOSAL_CSS = `:root{--ink:#241412;--text:#2e1f1c;--muted:#6e5953;--faint:#9a8581;--line:#e6e0dd;--hair:#eee8e5;--wash:#fbfaf9;--sand:#f4f1ef;--clay:#5a2620;--link:#a8423a;--dawn:#ee9d66;--dawn-soft:#fef1e6}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--text);font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.page{display:grid;grid-template-columns:180px minmax(0,1000px);gap:56px;justify-content:center;padding:72px 48px 96px}
nav{position:sticky;top:72px;align-self:start;padding-top:96px;display:flex;flex-direction:column}
nav a{padding:5px 0;font-size:13px;color:var(--muted)}nav a:hover{color:var(--ink)}
main{min-width:0;display:flex;flex-direction:column;gap:52px}
header{display:flex;flex-direction:column;gap:16px}.title{display:flex;align-items:flex-start;gap:24px}
h1{margin:0;flex:1;color:var(--ink);font-size:38px;font-weight:650;line-height:1.15;letter-spacing:-.025em}
h2{margin:0 0 16px;color:var(--ink);font-size:21px;font-weight:650;letter-spacing:-.015em}
p{margin:0 0 14px;white-space:pre-wrap}.byline{margin:0;font-size:13px;color:var(--muted)}
a{color:var(--link);text-decoration:none}a:hover{color:var(--clay)}b{color:var(--ink);font-weight:650}
section{scroll-margin-top:24px}.muted{color:var(--faint);font-size:13px}.ref{font-size:.82em;font-weight:600;color:var(--link)}
.handoff{position:relative;flex-shrink:0;margin-top:6px}
.handoff summary{height:36px;padding:0 14px;display:flex;align-items:center;list-style:none;cursor:pointer;border:1px solid var(--line);border-radius:6px;font-size:13px;font-weight:600;color:var(--ink)}
.handoff summary::-webkit-details-marker{display:none}.handoff[open] summary{background:var(--ink);border-color:var(--ink);color:#fff}
.handoff-panel{position:absolute;right:0;top:44px;z-index:1;width:min(560px,86vw);padding:20px;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 18px 48px rgba(36,20,18,.14);display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:1.5}
.handoff-panel p{margin:6px 0 0;color:var(--muted)}.label{font-size:12px;font-weight:600;color:var(--muted)}
pre{margin:6px 0 0;padding:10px 12px;background:var(--sand);border:1px solid var(--line);border-radius:6px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:13.5px;line-height:1.5;font-variant-numeric:tabular-nums}
th,td{padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--hair);overflow-wrap:break-word}
thead th{font-size:12px;font-weight:600;color:var(--muted);border-bottom:1.5px solid var(--ink)}
.design th,.design td{text-align:center}.design th+th,.design td+td{box-shadow:inset 1px 0 0 var(--line)}
.design th:first-child,.design td:first-child{text-align:left}.design thead th{color:var(--ink);font-weight:700}
.design thead small{display:block;font-weight:400;color:var(--muted)}.run{font-weight:600;color:var(--ink)}
.design tr.group td{background:var(--wash);box-shadow:none;text-align:left;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.design td.none{color:#c9bcb8}.design td.decisive{background:var(--dawn-soft);box-shadow:inset 0 0 0 1.5px var(--dawn)}
.setup td:first-child,.readings td:first-child{width:160px;font-weight:600;color:var(--ink)}.setup td:last-child{width:130px;color:var(--muted)}
figure{margin:28px 0 0}figure img{max-width:100%;border:1px solid var(--line);border-radius:6px}
figcaption,.caption{margin:12px 0 0;font-size:14px;line-height:1.55;color:#3a2925}
.flow{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}
.flow li{flex:1 1 120px;padding:10px 12px;border:1px solid #cfc5c2;border-radius:6px;font-size:12.5px;line-height:1.35;text-align:center}
.flow li b{display:block}.flow li span{color:var(--muted)}.flow li.key{background:var(--dawn-soft);border-color:var(--dawn)}
.bars{display:grid;grid-template-columns:minmax(0,160px) minmax(0,1fr) minmax(0,200px);gap:8px 14px;align-items:center;font-size:13px}
.bar{display:flex;align-items:center;gap:8px}.bar i{height:14px;min-width:2px;border-radius:2px;background:var(--clay)}.bar em{font-style:normal;color:var(--ink);white-space:nowrap}
.bars small{color:var(--muted);font-size:12px}
.order{margin:16px 0 0;padding-left:22px}.order li+li{margin-top:4px}
details summary{cursor:pointer;color:var(--muted);font-size:13px}details pre{margin-top:10px}
#references{padding-top:20px;border-top:1px solid var(--line)}#references h2{font-size:17px}
#references ol{margin:0;padding-left:22px;font-size:14px;line-height:1.6;color:#3a2925}#references li+li{margin-top:12px}
#references p{margin:4px 0 0}.quote{font-style:italic}
@media(max-width:900px){.page{grid-template-columns:1fr;gap:24px;padding:32px 20px 64px}nav{display:none}h1{font-size:30px}.design{display:block;overflow-x:auto}.bars{grid-template-columns:1fr}}
@media print{.handoff,nav{display:none}.page{display:block;padding:0}}`;
