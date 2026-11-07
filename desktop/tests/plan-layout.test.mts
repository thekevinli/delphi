import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PlanStore } from "../main/research/store.ts";
import { LocalPlans, researchPlanSchema, renderPlan } from "../main/research/plans.ts";

import { proposalPlan, scientificPlan } from "./fixtures/scientific-plan.ts";
import { exhibitGuide, exhibitKinds, scientificV4 } from "../main/research/plan-page.ts";

test("scientific plan validates evidence and renders structured, escaped, script-free content", () => {
  const dir = mkdtempSync("/tmp/delphi-plan-layout-");
  const store = new PlanStore(dir), plans = new LocalPlans(store, join(dir, "plans"));
  try {
    const context = { documents: [{ id: "paper1", text: "Temporal context distinguishes\nflashes from cuts." }] };
    const plan = plans.create(scientificPlan, context);
    assert.equal((plan.plan as Extract<ReturnType<typeof researchPlanSchema.parse>, { version: 2 }>).evidence[0]!.references[0]!.excerpt, context.documents[0].text);
    const html = plans.html(plan);
    // Boxed notes are one framed component; emphasis never comes from a side stripe.
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    assert.doesNotMatch(css, /border-(left|right|inline-start|inline-end)(-width|-color|-style)?\s*:/);
    assert.equal(html.match(/<aside/g)?.length, html.match(/<aside class="callout callout-(neutral|accent|quiet)">/g)?.length);
    assert.ok(html.includes('<div class="callout-label">Continue in your coding agent</div>'));
    assert.ok(html.includes('<summary>MCP setup instructions</summary>'));
    assert.ok(html.includes('codex mcp add delphi -- '));
    assert.ok(html.includes('Help → Set Up Delphi MCP'));
    assert.ok(html.includes('<div class="callout-label">First milestone</div>'));
    for (const heading of ["Scientific goal", "Literature and discussion", "Research tasks", "Evaluation", "Exit criteria"]) assert.ok(html.includes(heading));
    assert.ok(html.includes('<table>')); assert.ok(html.includes('class="flow"')); assert.ok(html.includes('<pre><code>'));
    assert.ok(!html.includes("Monitoring and deliverables")); assert.ok(!html.includes("Resolve before proceeding")); assert.ok(!html.includes("<blockquote>")); assert.ok(!html.includes("Implementation progress"));
    const attack = { ...plan, plan: { ...scientificPlan, title: '<script>alert(1)</script>', pseudocode: '</code><img src=x onerror=alert(1)>' } };
    const safe = renderPlan(attack);
    assert.ok(!safe.includes('<script>')); assert.ok(!safe.includes('<img'));
    assert.ok(safe.includes('&lt;script&gt;')); assert.ok(safe.includes('&lt;img'));
    assert.throws(() => plans.create(scientificPlan, { documents: [] }), /source/);
    const unmatched = plans.create(scientificPlan, { documents: [{ id: 'paper1', text: 'A different passage' }] });
    assert.equal((unmatched.plan as Extract<ReturnType<typeof researchPlanSchema.parse>, { version: 2 }>).evidence[0]!.references[0]!.excerpt, undefined);
    assert.ok(plans.html(unmatched).includes('Literature interpretation'));
    const noReference = structuredClone(scientificPlan); noReference.evidence[0]!.references = [];
    assert.throws(() => plans.create(noReference, context), /require captured/);
    assert.throws(() => researchPlanSchema.parse({ ...scientificPlan, executable: 'bad' }));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("legacy plans and retired experiment records survive opening and archival", () => {
  const dir = mkdtempSync('/tmp/delphi-plan-legacy-');
  const db = new DatabaseSync(join(dir, 'research.sqlite'));
  db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  db.prepare('INSERT INTO runs VALUES (?, ?)').run('old-run', '{"status":"complete"}'); db.close();
  let store = new PlanStore(dir);
  try {
    let plans = new LocalPlans(store, join(dir, 'plans'));
    const legacy = plans.create({ title: 'Legacy', objective: 'Preserve the original', method: 'No invented fields', evidence: [], steps: ['Read'], acceptance: ['Preserved'], dependencies: [], constraints: [], openQuestions: [] }, {});
    store.put('plans', legacy.id, { ...legacy, progress: [{ text: 'Historical report' }], artifacts: [{ filename: 'old.md', text: 'Keep this' }] });
    store.close(); store = new PlanStore(dir); plans = new LocalPlans(store, join(dir, 'plans'));
    assert.ok(plans.html(plans.get(legacy.id)).includes('Earlier plan format'));
    assert.ok(!plans.html(plans.get(legacy.id)).includes('Historical report'));
    plans.archive(legacy.id);
    const retained = store.objects('plans')[0]!;
    assert.deepEqual(retained.artifacts, [{ filename: 'old.md', text: 'Keep this' }]);
    const read = new DatabaseSync(join(dir, 'research.sqlite'), { readOnly: true });
    assert.equal(read.prepare('SELECT body FROM runs').get()!.body, '{"status":"complete"}'); read.close();
    assert.ok(readFileSync(join(dir, 'plans', legacy.id + '.html'), 'utf8').includes('Archived'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a proposal reads as Table 1 of runs by settings, with only the exhibits the model chose", () => {
  const dir = mkdtempSync("/tmp/delphi-plan-proposal-");
  const store = new PlanStore(dir), plans = new LocalPlans(store, join(dir, "plans"));
  try {
    const exhibits = [
      { kind: "flow", title: "Data path", caption: "Held out.", steps: [{ label: "Clips" }, { label: "<b>Score</b>", key: true }] },
      { kind: "bars", title: "Review time", caption: "Computed.", unit: "h", bars: [{ label: "(1)", value: 1, basis: "computed", detail: "60 clips × 1 min" }, { label: "(2)", value: 4, basis: "computed", detail: "4×" }] },
    ];
    const design = { ...proposalPlan.design, settings: [...proposalPlan.design.settings, { id: "b", label: "Full set", detail: "" }] };
    const web = [{ title: "Dataset card", url: "https://example.org/card", note: "" }];
    const plan = plans.create({ ...proposalPlan, design, exhibits, web }, { documents: [] });
    const html = plans.html(plan), css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    assert.doesNotMatch(css, /border-(left|right|inline-start|inline-end)(-width|-color|-style)?\s*:/);
    assert.ok(html.includes('<td class="decisive">precision, recall, F1</td>') && html.includes('<td class="none">·</td>'));
    assert.ok(html.includes('<tr class="group"><td colspan="3">Baseline</td></tr>'));
    assert.ok(html.indexOf("Figure 2. Data path") > html.indexOf('id="method"') && html.indexOf('id="method"') > html.indexOf("Figure 1. Review time"));
    assert.ok(html.includes("width:25.0%") && html.includes("&lt;b&gt;Score&lt;/b&gt;") && html.includes("Web page, not captured by Delphi"));
    assert.ok(html.includes(`Use Delphi MCP plan ${plan.id}. Implement runs (1), (2) in setting (a).`));
    assert.ok(html.includes("codex mcp add delphi -- ") && !html.includes("<script"));
    for (const heading of ["Question", "Design", "Method", "Setup", "Reading the result", "Limits"]) assert.ok(html.includes(`>${heading}</h2>`));
    const cited = { component: "Rate", setting: "3e-4", basis: "source", source: { sourceId: "missing", location: "Table 2" } };
    assert.throws(() => plans.create({ ...proposalPlan, setup: [cited] }, { documents: [] }), /not available/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the proposal schema needs decisive cells naming listed settings, and draws only kinds it knows", () => {
  const run = proposalPlan.design.runs[0]!;
  for (const runs of [[{ ...run, cells: [{ setting: "z", reports: "x" }] }], [{ ...run, cells: [{ setting: "a", reports: "x" }] }], [run, run]])
    assert.equal(scientificV4.safeParse({ ...proposalPlan, design: { ...proposalPlan.design, runs } }).success, false);
  const table = { kind: "table", title: "Budget", caption: "Per run.", columns: ["Run", "Hours"], rows: [["(1)"]] };
  assert.equal(scientificV4.safeParse({ ...proposalPlan, exhibits: [table] }).success, false);
  assert.equal(scientificV4.safeParse({ ...proposalPlan, exhibits: [{ ...table, kind: "pie", rows: [["(1)", "2"]] }] }).success, false);
  assert.equal(scientificV4.safeParse({ ...proposalPlan, setup: [{ component: "Rate", setting: "3e-4", basis: "literature" }] }).success, false);
  assert.deepEqual(Object.keys(exhibitKinds), ["table", "flow", "bars"]);
  for (const kind of Object.keys(exhibitKinds)) assert.ok(exhibitGuide.includes(`\n- ${kind}: `));
  assert.ok(exhibitGuide.includes("most plans need none") && exhibitGuide.includes("Never draw results"));
});

test("the proposal schema accepts what the backend accepts, and cited values are captured and checked", () => {
  const dir = mkdtempSync("/tmp/delphi-plan-parity-");
  const store = new PlanStore(dir), plans = new LocalPlans(store, join(dir, "plans"));
  try {
    assert.equal(scientificV4.safeParse({ ...proposalPlan, setup: [{ component: "Seed", setting: "1", basis: "proposed", source: null }] }).success, true);
    assert.equal(scientificV4.safeParse({ ...proposalPlan, title: "   " }).success, false);
    assert.equal(scientificV4.safeParse({ ...proposalPlan, setup: [{ component: "Seed", setting: "1", basis: "literature" }] }).success, false);
    const target = { sourceId: "paper1", summary: "S", target: "Figure 1", pages: [], passages: [] };
    assert.equal(scientificV4.safeParse({ ...proposalPlan, reference: [target, { ...target, target: "Figure 2" }] }).success, false);
    const bar = { label: "(a)", value: 1234567, basis: "source", detail: "tokens in the training split", source: { sourceId: "paper1", location: "Table 2" } };
    const bars = { kind: "bars", title: "Data", caption: "Sizes.", unit: "tokens", bars: [bar, { label: "(b)", value: 2, basis: "computed", detail: "2×" }] };
    assert.equal(scientificV4.safeParse({ ...proposalPlan, exhibits: [{ ...bars, bars: [{ ...bar, source: undefined }, bars.bars[1]] }] }).success, false);
    const documents = [{ id: "paper1", title: "Sizes", text: "Table 2. Dataset sizes." }];
    const html = plans.html(plans.create({ ...proposalPlan, exhibits: [bars] }, { documents }));
    assert.ok(html.includes("1234567 tokens") && html.includes('<span class="ref">[1, Table 2]</span>'));
    const tiny = plans.html(plans.create({ ...proposalPlan, exhibits: [{ ...bars, bars: [{ ...bars.bars[1], value: 0.00003 }, { ...bars.bars[1], value: 1.5e-7 }] }] }, { documents }));
    assert.ok(tiny.includes("3e-05 tokens") && tiny.includes("1.5e-07 tokens"));
    assert.throws(() => plans.create({ ...proposalPlan, exhibits: [{ ...bars, bars: [{ ...bar, source: { sourceId: "paper1", location: "Table 9" } }, bars.bars[1]] }] }, { documents }), /absent from captured text/);
    assert.throws(() => plans.create({ ...proposalPlan, setup: [{ component: "Rate", setting: "3e-4", basis: "source", source: { sourceId: "paper1", location: "Figure 4" } }] }, { documents }), /absent from captured text/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
