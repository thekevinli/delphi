import { expect, test, type Page } from "@playwright/test";

// The kit is model-declared and host-drawn inside the real opaque frame:
// charts, connectors and the header badge, through the production chat card.
const CONVERSATION = "9".repeat(32);
const QUESTION = { role: "user", content: "Show monthly and running totals.", createdAt: "2026-10-28T00:00:00Z", requestId: "kit" };
const answer = (source: string, title: string) => ({ role: "assistant", content: `\`\`\`delphi-artifact ${title}\n${source}\n\`\`\``, createdAt: "2026-10-28T00:00:05Z", requestId: "kit" });

async function show(page: Page, source: string, title = "Kit", width = 620) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/chat/conversations")) return route.fulfill({ json: { items: [{ id: CONVERSATION, generation: 0, title: "Kit", empty: false, manualTitle: false }], defaultId: CONVERSATION, limit: 10 } });
    if (path.endsWith("/chat")) return route.fulfill({ json: { messages: [QUESTION, answer(source, title)], images: [] } });
    return route.fulfill({ json: path.endsWith("/memory/pages") ? [] : { items: [] } });
  });
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.goto("/tests/browser/harness.html?responsive-chat&closable&scope=document");
  await page.getByTestId("chat-width").evaluate((element, width) => { element.style.width = `${width}px`; element.style.height = "900px"; }, width);
  await expect(page.locator(".inline-artifact")).toHaveAttribute("data-artifact-state", "ready");
  return page.frameLocator("iframe.inline-artifact-frame");
}

const RUNNING = `<main data-artifact-badge="Toy data"><div class="artifact-segmented" role="group" aria-label="View"><button id="raw" type="button" aria-pressed="true">Raw</button><button id="sum" type="button" aria-pressed="false">Running total</button></div>
<div id="chart" data-artifact-chart='{"type":"bar","x":["Jan","Feb","Mar","Apr"],"series":[{"name":"Monthly","values":[10,18,13,25]}],"y":{"label":"Sales","format":"int"},"note":"Hover a bar."}'></div></main>
<script>const raw=[10,18,13,25],months=["Jan","Feb","Mar","Apr"];const chart=document.getElementById('chart');
function show(total){document.getElementById('raw').setAttribute('aria-pressed',String(!total));document.getElementById('sum').setAttribute('aria-pressed',String(total));
const before=raw.map((_,i)=>raw.slice(0,i).reduce((a,b)=>a+b,0));chart.dataset.artifactChart=JSON.stringify(total?{type:"bar",stacked:true,x:months,series:[{name:"Previous total",role:"light",values:before},{name:"This month",role:"data",values:raw,notes:raw.map((_,i)=>months[i]+": "+(before[i]+raw[i])+" = "+raw.slice(0,i+1).join(" + "))}],y:{label:"Sales",format:"int"}}:{type:"bar",x:months,series:[{name:"Monthly",values:raw}],y:{label:"Sales",format:"int"}})}
document.getElementById('raw').onclick=()=>show(false);document.getElementById('sum').onclick=()=>show(true);</script>`;

test("a declared chart is drawn with readable values, a running total and an accessible table", async ({ page }) => {
  const frame = await show(page, RUNNING, "Raw vs running total");
  await expect(page.locator("figcaption .inline-artifact-badge")).toHaveText("Toy data");
  // Only the listed disclosures reach the header.
  await frame.locator("main").evaluate(element => { element.dataset.artifactBadge = "Verified"; });
  await expect(page.locator("figcaption .inline-artifact-badge")).toHaveCount(0);
  await frame.locator("main").evaluate(element => { element.dataset.artifactBadge = "toy data"; });
  await expect(page.locator("figcaption .inline-artifact-badge")).toHaveText("Toy data");
  const chart = frame.locator("#chart");
  await expect(chart.locator(".artifact-chart-value")).toHaveText(["10", "18", "13", "25"]);
  await expect(chart.locator(".artifact-sr tr")).toHaveCount(5);
  await expect(chart.locator(".artifact-chart-readout")).toHaveText("Hover a bar.");
  await frame.locator("#sum").click();
  await expect(chart.locator(".artifact-chart-value")).toHaveText(["10", "28", "41", "66"]);
  await expect(chart.locator(".artifact-legend")).toContainText("Previous total");
  // The inspector reads each bar by pointer or by keyboard.
  await chart.locator(".artifact-chart-mark").last().hover();
  await expect(chart.locator(".artifact-chart-readout")).toHaveText("Apr: 66 = 10 + 18 + 13 + 25");
  await chart.locator("svg").focus();
  await page.keyboard.press("Home");
  await expect(chart.locator(".artifact-chart-readout")).toHaveText("Jan · Previous total: 0");
  const fits = await chart.evaluate(element => element.scrollWidth <= element.clientWidth + 1);
  expect(fits).toBe(true);
});

test("charts mark undefined values, use log scales and draw heatmaps without float noise", async ({ page }) => {
  const source = `<main>
<div id="metrics" data-artifact-chart='{"type":"bar","x":["Precision","Recall"],"series":[{"name":"Score","values":[null,0.6],"notes":["Precision is undefined: TP + FP = 0","Recall: 0.6"]}],"y":{"format":"percent","min":0,"max":1}}'></div>
<div id="loss" data-artifact-chart='{"type":"line","x":[1,4,16,64,256],"xAxis":{"label":"Batch size","scale":"log"},"series":[{"name":"SGD","values":[3.1,1.2,0.41,0.13,0.05]},{"name":"Adam","role":"current","values":[2.2,0.9,0.5,0.31,0.27]}],"y":{"label":"Loss","scale":"log"},"highlight":2}'></div>
<div id="map" data-artifact-chart='{"type":"heatmap","x":["1","8","64"],"rows":["low noise","high noise"],"values":[[0.7300000001,-0.2,0.1],[0.4,-0.6,null]],"colors":"diverging","y":{"format":"0.00"}}'></div></main>`;
  const frame = await show(page, source, "Kit charts", 460);
  await expect(frame.locator("#metrics text", { hasText: "undefined" })).toHaveCount(1);
  await expect(frame.locator("#metrics .artifact-chart-value")).toHaveText(["60%"]);
  // A chart still settling its width redraws once; hover the bar it settles on.
  await expect(async () => {
    await frame.locator("#metrics .artifact-chart-undefined").hover();
    await expect(frame.locator("#metrics .artifact-chart-readout")).toHaveText("Precision is undefined: TP + FP = 0", { timeout: 1000 });
  }).toPass();
  // A log axis labels decades, not raw floats.
  const ticks = await frame.locator("#loss text").allTextContents();
  expect(ticks).toEqual(expect.arrayContaining(["0.01", "0.1", "1", "10"]));
  await expect(frame.locator("#loss circle")).toHaveCount(10);
  await expect(frame.locator("#map .artifact-chart-mark")).toHaveCount(6);
  const labels = await frame.locator("#map text").allTextContents();
  expect(labels).toContain("0.73");
  expect(labels.join(" ")).not.toMatch(/0000/);
  for (const id of ["#metrics", "#loss", "#map"]) expect(await frame.locator(id).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("connectors join HTML nodes at their nearest sides and follow them across widths", async ({ page }) => {
  const source = `<main><div style="display:flex;flex-wrap:wrap;gap:40px;align-items:center">
<div id="thinker" class="artifact-node">Thinker</div><div id="talker" class="artifact-node">Talker</div><div id="vocoder" class="artifact-node">Vocoder</div></div>
<i data-artifact-connect="thinker talker" data-artifact-edge="once" data-label="plan"></i><i data-artifact-connect="talker vocoder" data-artifact-edge="stream"></i><i data-artifact-connect="vocoder thinker" data-artifact-edge="feedback"></i></main>`;
  const frame = await show(page, source, "Connectors", 620);
  const geometry = () => frame.locator("body").evaluate(() => {
    const paths = [...document.querySelectorAll<SVGPathElement>(".artifact-connectors path[data-artifact-edge]")];
    const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    const origin = document.body.getBoundingClientRect();
    return { roles: paths.map(path => path.getAttribute("data-artifact-edge")), starts: paths.map(path => path.getPointAtLength(0)).map(point => [Math.round(point.x + origin.left), Math.round(point.y + origin.top)]),
      thinker: rect("thinker").toJSON(), talker: rect("talker").toJSON(), dash: getComputedStyle(paths[1]).strokeDasharray };
  });
  const wide = await geometry();
  expect(wide.roles).toEqual(["once", "stream", "feedback"]);
  expect(wide.starts[0][0]).toBe(Math.round(wide.thinker.right));
  expect(wide.dash).not.toBe("none");
  // The line takes its role's colour, like its arrowhead: once is saffron.
  expect(await frame.locator('.artifact-connectors path[data-artifact-edge="once"]').evaluate(path => getComputedStyle(path).stroke)).toBe("rgb(224, 160, 32)");
  await expect(frame.locator(".artifact-connector-label")).toHaveText("plan");
  // At 270px the nodes wrap; the connector leaves from the node, wherever it went.
  await page.getByTestId("chat-width").evaluate(element => { element.style.width = "270px"; });
  await expect.poll(async () => { const narrow = await geometry(); return narrow.thinker.top !== wide.thinker.top || narrow.talker.top !== wide.talker.top; }).toBe(true);
  const narrow = await geometry();
  const [x, y] = narrow.starts[0];
  const { thinker } = narrow;
  expect(x >= Math.floor(thinker.left) && x <= Math.ceil(thinker.right) && y >= Math.floor(thinker.top) && y <= Math.ceil(thinker.bottom)).toBe(true);
});

test("connectors in a wrapped flow never cross a node they do not join", async ({ page }) => {
  const source = `<main><div class="artifact-flow"><div class="artifact-node" id="cpu">CPU load x</div><div class="artifact-node" id="l1">L1 ~1 ns</div><div class="artifact-node" id="l2">L2 ~4 ns</div><div class="artifact-node" id="ram">RAM ~80 ns</div></div>
<i data-artifact-connect="cpu l1" data-artifact-edge="data"></i><i data-artifact-connect="l1 l2" data-artifact-edge="data" data-label="miss"></i><i data-artifact-connect="l2 ram" data-artifact-edge="stream"></i></main>`;
  const frame = await show(page, source, "Wrapped flow", 270);
  for (const width of [270, 460]) {
    await page.getByTestId("chat-width").evaluate((element, width) => { element.style.width = `${width}px`; }, width);
    await expect.poll(() => frame.locator("body").evaluate(() => {
      const nodes = [...document.querySelectorAll(".artifact-node")].map(node => ({ id: node.id, box: node.getBoundingClientRect() }));
      const origin = document.body.getBoundingClientRect();
      return [...document.querySelectorAll<SVGPathElement>(".artifact-connectors path[data-artifact-edge]")].flatMap((path, index) => {
        const ends = [["cpu", "l1"], ["l1", "l2"], ["l2", "ram"]][index];
        const crossed = new Set<string>();
        for (let at = 0; at <= path.getTotalLength(); at += 2) {
          const point = path.getPointAtLength(at), x = point.x + origin.left, y = point.y + origin.top;
          for (const { id, box } of nodes) if (!ends.includes(id) && x > box.left + 2 && x < box.right - 2 && y > box.top + 2 && y < box.bottom - 2) crossed.add(id);
        }
        return [...crossed].map(id => `${ends.join("→")} crosses ${id}`);
      });
    }), `at ${width}px`).toEqual([]);
  }
});

test("odd chart specs still draw finite geometry, and a padded chart keeps its width", async ({ page }) => {
  const source = `<main>
<div id="log" data-artifact-chart='{"type":"line","x":[1,2,3],"series":[{"name":"Zero","values":[0,0,-1]}],"y":{"scale":"log"}}'></div>
<div id="min" data-artifact-chart='{"type":"bar","x":["A","B"],"series":[{"name":"Low","values":[1,2]}],"y":{"min":50}}'></div>
<div id="mark" data-artifact-chart='{"type":"bar","x":["A","B"],"series":[{"name":"V","values":[1,2]}],"marks":[{"x":"B","label":"bad"}]}'></div>
<div id="empty" data-artifact-chart='{"type":"heatmap","x":[],"rows":[],"values":[]}'></div>
<div class="artifact-flow"><div id="padded" class="artifact-node" data-artifact-chart='{"type":"bar","x":["A","B"],"series":[{"name":"V","values":[3,4]}]}'></div></div></main>`;
  const frame = await show(page, source, "Odd charts", 460);
  for (const id of ["#log", "#min", "#mark", "#empty"]) {
    const bad = await frame.locator(id).evaluate(element => [...element.querySelectorAll("svg *")].flatMap(node => [...node.attributes].map(a => a.value)).filter(value => /NaN|Infinity/.test(value)));
    expect(bad, id).toEqual([]);
  }
  const width = () => frame.locator("#padded svg").evaluate(svg => svg.getBoundingClientRect().width);
  const first = await width();
  for (let i = 0; i < 6; i++) await frame.locator("main").evaluate((element, i) => { element.classList.toggle("tick", i % 2 === 0); }, i);
  await page.waitForTimeout(200);
  expect(await width()).toBeCloseTo(first, 0);
});

// A fit calculator and a schedule, redrawn by a frame that never gets an animation frame.
const FIT = `<main><script>window.requestAnimationFrame=()=>0;</script>
<div class="artifact-devices"><div class="artifact-device"><span class="artifact-device-label">GPU 0</span><span class="artifact-slots"><span class="artifact-slot" id="own" data-owner="1">G0</span><span class="artifact-slot" id="held" data-state="held"></span></span><output>4 B/param</output></div></div>
<div id="meter" data-artifact-chart='{"type":"meter","series":[{"name":"Weights","values":[20],"role":"owner-0"},{"name":"Optimizer","values":[120],"role":"owner-2"}],"y":{"max":180,"unit":"GB"},"rules":[{"y":80,"label":"H100 80 GB"},{"y":141,"label":"H200 141 GB"}]}'></div>
<div class="artifact-stats"><div class="artifact-stat" id="verdict" data-tone="bad"><b>Exceeds H200</b><span>before activations</span></div></div>
<div id="plan" data-artifact-chart></div></main>
<script>function plan(p,m){const blocks=[];for(let s=0;s<p;s++)for(let j=0;j<m;j++){blocks.push({row:s,start:s+j,length:1,label:"F"+(j+1)});blocks.push({row:s,start:(m+p-1)+2*(p-1-s)+2*j,length:2,label:"B"+(j+1),role:"structure"})}
document.getElementById('plan').dataset.artifactChart=JSON.stringify({type:"timeline",rows:Array.from({length:p},(_,s)=>"stage "+(s+1)),blocks,end:3*(m+p-1),marks:[{x:m+p-1,label:"backward"}]})}plan(4,4);</script>`;

test("a fit meter keeps its capacities still, a timeline lays out a schedule, and tiles carry a verdict", async ({ page }) => {
  const frame = await show(page, FIT, "Fit and schedule");
  const meter = frame.locator("#meter");
  await expect(meter.locator(".artifact-chart-mark")).toHaveCount(2);
  // Each part is labelled inside the bar, then the total above it.
  await expect(meter.locator(".artifact-chart-value")).toHaveText(["20 GB", "120 GB", "140 GB"]);
  // Where each capacity sits on the scale, as a share of the bar: the card may
  // still be settling its width when this is first read.
  const rules = () => meter.locator("line.artifact-chart-rule").evaluateAll((lines: SVGLineElement[]) => lines.map(line =>
    Math.round(1000 * line.x1.baseVal.value / line.ownerSVGElement!.width.baseVal.value) / 1000));
  const before = await rules();
  expect(before[0]).toBeLessThan(before[1]);
  await meter.evaluate(element => { element.dataset.artifactChart = JSON.stringify({ type: "meter", series: [{ name: "Weights", values: [2.5] }, { name: "Optimizer", values: [300] }], y: { max: 180, unit: "GB" }, rules: [{ y: 80, label: "H100 80 GB" }, { y: 141, label: "H200 141 GB" }] }); });
  await expect(meter.locator(".artifact-chart-value").last()).toHaveText("303 GB, beyond the scale");
  expect(await rules()).toEqual(before);
  await expect(meter.locator(".artifact-sr tr")).toHaveCount(5);

  const plan = frame.locator("#plan");
  await expect(plan.locator(".artifact-chart-mark")).toHaveCount(32);
  await expect(plan.locator(".artifact-chart-mark-line")).toHaveCount(1);
  await expect(plan.locator(".artifact-chart-value", { hasText: "B1" })).toHaveCount(4);
  // Eight stages of sixteen microbatches: every block drawn, and labels too wide for theirs left out.
  await plan.evaluate(() => (window as any).plan(8, 16));
  await expect(plan.locator(".artifact-chart-mark")).toHaveCount(256);
  await expect(plan.locator(".artifact-chart-value", { hasText: /^F/ })).toHaveCount(0);
  await plan.locator(".artifact-chart-mark").first().hover();
  await expect(plan.locator(".artifact-chart-readout")).toHaveText("stage 1 · F1: 0 to 1");
  expect(await plan.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  // The highlight names a block as written, even when one before it is refused.
  await plan.evaluate(element => { element.dataset.artifactChart = JSON.stringify({ type: "timeline", rows: ["stage 1"], blocks: [{ row: 4, start: 0, length: 1 }, { row: 0, start: 0, length: 1, label: "X" }, { row: 0, start: 1, length: 1, label: "Y" }], highlight: 2 }); });
  await plan.locator(".is-current").hover();
  await expect(plan.locator(".artifact-chart-readout")).toHaveText("stage 1 · Y: 1 to 2");

  const style = (selector: string) => frame.locator(selector).evaluate(element => { const css = getComputedStyle(element); return { border: css.borderTopStyle, fill: css.backgroundColor, ink: css.color }; });
  expect((await style("#held")).border).toBe("dashed");
  // The saffron chunk keeps dark text; a pale one would be unreadable.
  expect((await style("#own")).ink).toBe("rgb(36, 20, 18)");
  expect((await style("#verdict")).fill).not.toBe("rgba(0, 0, 0, 0)");
  expect((await style("#verdict b")).ink).toBe("rgb(201, 78, 58)");
});

const GATHER = `<main><div class="artifact-devices" id="grid"></div><button id="go" type="button">Gather</button><span class="artifact-slot" id="late" data-owner="0" data-artifact-from="go" hidden>W0</span></main>
<script>const rows=(after)=>[0,1].map(r=>'<div class="artifact-device"><span class="artifact-device-label">GPU '+r+'</span><span class="artifact-slots">'+[0,1].map(i=>i===r||after?'<span class="artifact-slot" id="g'+r+'s'+i+'" data-owner="'+i+'"'+(after&&i!==r?' data-artifact-from="g'+i+'s'+i+'"':'')+'>W'+i+'</span>':'<span class="artifact-slot" id="g'+r+'s'+i+'" data-state="held"></span>').join('')+'</span></div>').join('');
const grid=document.getElementById('grid');grid.innerHTML=rows(false);document.getElementById('go').onclick=()=>{grid.innerHTML=rows(true)};</script>`;

test("a chunk that names its source glides in from it, and stays still under reduced motion", async ({ page }) => {
  const frame = await show(page, GATHER, "All-gather");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await frame.locator("#go").click();
  const motion = (id: string) => frame.locator(id).evaluate(element => element.getAnimations().map(animation => {
    const [first] = (animation.effect as KeyframeEffect).getKeyframes();
    return String(first.transform);
  }));
  // GPU 0 receives W1 from the row below, GPU 1 receives W0 from the row above.
  expect((await motion("#g0s1"))[0]).toMatch(/^translate\(0px,\s*[1-9][\d.]*px\)$/);
  expect((await motion("#g1s0"))[0]).toMatch(/^translate\(0px,\s*-[1-9][\d.]*px\)$/);
  expect(await motion("#g0s0")).toEqual([]);
  // A slot hidden at first glides once it appears.
  await frame.locator("#late").evaluate((element: HTMLElement) => { element.hidden = false; });
  await expect.poll(async () => (await motion("#late")).length).toBe(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await frame.locator("#grid").evaluate(element => { element.innerHTML = ""; });
  await frame.locator("#go").click();
  expect(await motion("#g0s1")).toEqual([]);
});

test("a drawn figure stops at the widest checked width, while HTML and charts take the room", async ({ page }) => {
  const source = `<main><svg id="drawn" viewBox="0 0 800 520" role="img" aria-label="Drawn"><rect width="800" height="520" fill="#d6e1f1"/></svg>
<div id="flow" class="artifact-flow"><div class="artifact-node">A</div><div class="artifact-node">B</div></div>
<div id="chart" data-artifact-chart='{"type":"bar","x":["A","B"],"series":[{"name":"V","values":[1,2]}]}'></div></main>`;
  const frame = await show(page, source, "Wide figure");
  // Only the expanded chat gives a card more than 800px: the docked
  // transcript stops at its measure, short of that.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Expand chat", exact: true }).click();
  await expect(page.getByTestId("fullscreen")).toHaveText("true");
  const box = (selector: string) => frame.locator(selector).evaluate((node) => {
    const rect = node.getBoundingClientRect(), body = document.body.getBoundingClientRect(), style = getComputedStyle(document.body);
    return { width: Math.round(rect.width), height: Math.round(rect.height), left: Math.round(rect.left - body.left - parseFloat(style.paddingLeft)), room: Math.round(body.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) };
  });
  await expect.poll(async () => (await box("#drawn")).room).toBeGreaterThan(860);
  const drawn = await box("#drawn");
  expect([drawn.width, drawn.height]).toEqual([800, 520]);
  expect(Math.abs(drawn.left - (drawn.room - 800) / 2)).toBeLessThan(2);
  expect((await box("#flow")).width).toBe(drawn.room);
  await expect.poll(async () => (await box("#chart svg")).width).toBeGreaterThan(860);
});
