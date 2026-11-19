import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

// Displays from Delphi's library, drawn by the production Markdown renderer in
// the chat wrappers. The five examples are the mood board's (row 25) written as
// specs; the heights below were measured on the board's own frames.
const spec = (name: string) => readFileSync(new URL(`../../../../core/tests/data/displays/${name}.json`, import.meta.url), "utf8").trim();
const fence = (source: string) => `\`\`\`delphi-artifact\n${source}\n\`\`\``;

// Card width → board height of the first state. The board frames' cards were 418,
// 578 and 758px wide (the rail, the default and the expanded chat).
const BOARD: Record<string, Record<number, number>> = {
  moe: { 418: 331, 578: 331, 758: 331 },
  isoflop: { 418: 320, 578: 303, 758: 302 },
  handbook: { 418: 501, 578: 239, 758: 239 },
  omni: { 418: 1028, 578: 1001, 758: 1001 },
  // At 418px the step-1 note's last word wraps: the board set its math as plain
  // text, Delphi typesets it, and typeset math is slightly wider (+18px, one line).
  correction: { 418: 566, 578: 576, 758: 575 },
};
const CORRECTION_STEPS = { 418: [566, 566, 566, 566, 584, 584, 779], 578: [576, 576, 576, 576, 576, 594, 719] } as Record<number, number[]>;
const close = (actual: number, board: number) => expect(Math.abs(actual - board), `${actual}px against the board's ${board}px`).toBeLessThanOrEqual(Math.max(6, board * 0.012));

async function open(page: Page) {
  await page.goto("/tests/browser/harness.html?display");
  await page.waitForFunction(() => "__showAnswer" in window);
}
/** Mounts one answer whose display card is `card` pixels wide, and returns the card. */
async function show(page: Page, content: string, card: number) {
  const mount = (width: number) => page.evaluate(([content, width]) => (window as unknown as { __showAnswer: (c: string, w: number) => void }).__showAnswer(content, width), [content, width] as const);
  await mount(card + 48);
  const drawn = page.locator(".dsp").first();
  await expect(drawn).toBeVisible();
  const width = await drawn.evaluate(element => element.getBoundingClientRect().width);
  if (Math.abs(width - card) > 0.5) {
    await mount(card + 48 + card - width);
    await expect.poll(() => drawn.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(card);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1, 1);
  return drawn;
}
const height = (page: Page) => page.locator(".dsp").first().evaluate(async element => {
  // Let entrance transitions finish; heights are read at rest.
  await Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
  return element.getBoundingClientRect().height;
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1400 });
  await open(page);
});

for (const name of Object.keys(BOARD)) {
  test(`${name}: the first state is the board's at every chat width`, async ({ page }) => {
    for (const [card, board] of Object.entries(BOARD[name])) {
      const drawn = await show(page, fence(spec(name)), Number(card));
      await expect(drawn.locator(".katex-error")).toHaveCount(0);
      close(await height(page), board);
      expect(await drawn.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
  });
}

test("Correction Training walks the board's seven steps, and K changes what the corrector does", async ({ page }) => {
  for (const card of [418, 578]) {
    const drawn = await show(page, fence(spec("correction")), card);
    const next = drawn.getByRole("button", { name: "Next step" });
    for (let step = 1; step <= 7; step++) {
      await expect(drawn.locator(".dsp-step output")).toHaveText(`${step} / 7`);
      close(await height(page), CORRECTION_STEPS[card][step - 1]);
      if (step < 7) await next.click();
    }
    await expect(next).toBeDisabled();
  }
  const drawn = page.locator(".dsp").first();
  const k0 = drawn.getByRole("button", { name: "K = 0" }), k2 = drawn.getByRole("button", { name: "K = 2" });
  await expect(k2).toHaveAttribute("aria-pressed", "true");
  // The final sample: with K = 2 the corrector's passes show; with K = 0 the defect survives.
  await expect(drawn.locator(".dsp-note")).toContainText("Final sample.");
  const corrected = await drawn.locator(".dsp-note").innerText();
  await k0.click();
  await expect(k0).toHaveAttribute("aria-pressed", "true");
  await expect(drawn.locator(".dsp-note")).not.toHaveText(corrected);
  await expect(drawn.locator(".dsp-note")).toContainText("exposure bias");
  // Step 4 names the passes the control chose.
  await drawn.getByRole("button", { name: /^Step 4:/ }).click();
  await expect(drawn.locator(".dsp-step output")).toHaveText("4 / 7");
  await expect(drawn.locator(".dsp-s-cnt")).toHaveText("×0");
  await k2.click();
  await expect(drawn.locator(".dsp-s-cnt")).toHaveText("×2");
  await expect(drawn.locator(".dsp-hair button").nth(3)).toHaveClass(/is-current/);
  await expect(drawn.locator(".dsp-hair button.is-done")).toHaveCount(3);
});

test("a reader steps with the arrows, the keyboard and the step track, and Reset starts over", async ({ page }) => {
  const drawn = await show(page, fence(spec("moe")), 578);
  const output = drawn.locator(".dsp-step output");
  await expect(drawn.getByRole("button", { name: "Previous step" })).toBeDisabled();
  await drawn.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(output).toHaveText("3 / 4");
  await expect(drawn).toHaveAttribute("aria-label", "MoE forward pass, step 3 of 4");
  await page.keyboard.press("ArrowLeft");
  await expect(output).toHaveText("2 / 4");
  await expect(drawn.locator(".dsp-note b")).toHaveText("Pick top-2.");
  await drawn.getByRole("button", { name: "k = 1" }).click();
  await expect(drawn.locator(".dsp-note b")).toHaveText("Pick top-1.");
  // Top-1 keeps one score in each row, top-2 two.
  const picked = await drawn.locator(".dsp-cell.is-pick").count();
  await drawn.getByRole("button", { name: "k = 2" }).click();
  expect(await drawn.locator(".dsp-cell.is-pick").count()).toBe(picked * 2);
  await drawn.getByRole("button", { name: /^Step 4:/ }).click();
  await expect(output).toHaveText("4 / 4");
  await drawn.getByRole("button", { name: "k = 1" }).click();
  await drawn.getByRole("button", { name: "Reset" }).click();
  await expect(output).toHaveText("1 / 4");
  await expect(drawn.getByRole("button", { name: "k = 2" })).toHaveAttribute("aria-pressed", "true");
  // A keystroke inside a control belongs to the control, not the stepper.
  await drawn.getByRole("button", { name: "k = 1" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(output).toHaveText("1 / 4");
});

test("hovering a cell, a point, a stage and a bar explains it, and leaving the card clears it", async ({ page }) => {
  let drawn = await show(page, fence(spec("moe")), 578);
  await drawn.locator(".dsp-cell").first().hover();
  await expect(drawn.locator(".dsp-cell .dsp-tip")).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(drawn.locator(".dsp-tip")).toHaveCount(0);

  drawn = await show(page, fence(spec("isoflop")), 578);
  await drawn.locator(".dsp-dot").nth(29).hover();
  await expect(drawn.locator(".dsp-chart .dsp-tip")).toBeVisible();
  await expect(drawn.locator(".dsp-dot.is-on")).toHaveCount(1);
  await expect(drawn.locator(".dsp-read")).not.toBeEmpty();

  drawn = await show(page, fence(spec("omni")), 578);
  await drawn.locator(".dsp-nd.tone-blue").first().hover();
  await expect(drawn.locator(".dsp-nd .dsp-tip")).toContainText("Thinker");
  const bar = drawn.locator(".dsp-track").first().locator(".dsp-bar").nth(1);
  await bar.hover();
  await expect(bar.locator(".dsp-tip")).toBeVisible();
  // A tip stays inside the card even beside its edge.
  const inside = await drawn.evaluate(card => {
    const box = card.getBoundingClientRect(), tip = card.querySelector(".dsp-tip")!.getBoundingClientRect();
    return tip.left >= box.left - 1 && tip.right <= box.right + 1;
  });
  expect(inside).toBe(true);
});

test("an image step restarts its animation each time the reader arrives at it", async ({ page }) => {
  const drawn = await show(page, fence(spec("correction")), 578);
  await drawn.getByRole("button", { name: /^Step 4:/ }).click();
  const loop = drawn.locator(".dsp-s-loop");
  await expect(loop).toHaveCount(1);
  const first = await loop.elementHandle();
  await drawn.getByRole("button", { name: /^Step 5:/ }).click();
  await drawn.getByRole("button", { name: /^Step 4:/ }).click();
  expect(await loop.evaluate((element, earlier) => element !== earlier, first)).toBe(true);
});

test("the repeat dot and the progress bar move by transform alone, and the dot crosses the whole arc", async ({ page }) => {
  const drawn = await show(page, fence(spec("correction")), 578);
  await drawn.getByRole("button", { name: /^Step 4:/ }).click();
  const crossing = await drawn.locator(".dsp-s-loop").evaluate(loop => {
    const dot = loop.querySelector("i")!;
    const animations = dot.getAnimations();
    const moved = animations.flatMap(animation => (animation.effect as KeyframeEffect).getKeyframes().flatMap(frame => Object.keys(frame)))
      .filter(key => !["offset", "easing", "composite", "computedOffset"].includes(key));
    animations.forEach(animation => { animation.pause(); animation.currentTime = 0.9 * 900; });
    const arc = loop.getBoundingClientRect(), at = dot.getBoundingClientRect(), border = parseFloat(getComputedStyle(loop).borderLeftWidth);
    return { moved: [...new Set(moved)].sort(), right: at.left - (arc.left + border), width: loop.clientWidth };
  });
  expect(crossing.moved).toEqual(["opacity", "transform"]);
  expect(Math.abs(crossing.right - (crossing.width - 3))).toBeLessThan(1);
  const bars = await page.locator(".dsp-s-bar i").evaluateAll(items => items.map(item => ({ width: (item as HTMLElement).style.width, transform: (item as HTMLElement).style.transform })));
  expect(bars.length).toBeGreaterThan(0);
  for (const bar of bars) expect(bar.width === "" && /^scaleX\(/.test(bar.transform)).toBe(true);
});

const CONVERSATION = "9".repeat(32);
const asked = (content: string, requestId: string) => [
  { role: "user", content: "How does correction training work?", createdAt: "2026-11-01T00:00:00Z", requestId },
  { role: "assistant", content, createdAt: "2026-11-01T00:00:05Z", requestId },
];
async function chat(page: Page, messages: unknown[]) {
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/chat/conversations")) return route.fulfill({ json: { items: [{ id: CONVERSATION, generation: 0, title: "Correction training", empty: false, manualTitle: false }], defaultId: CONVERSATION, limit: 10 } });
    if (path.endsWith("/chat")) return route.fulfill({ json: { messages, images: [] } });
    if (path.endsWith("/memory/pages")) return route.fulfill({ json: [] });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/tests/browser/harness.html?responsive-chat&closable&scope=document");
}

test("in the chat panel a display is drawn in the answer itself, with no frame, and steps there", async ({ page }) => {
  await chat(page, asked(`Training first, then sampling.\n\n${fence(spec("correction"))}\n\nThe corrector is what the paper adds.`, "display"));
  const drawn = page.locator(".message.assistant .dsp");
  await expect(drawn).toHaveCount(1);
  await expect(page.locator(".message.assistant iframe")).toHaveCount(0);
  await expect(page.locator(".message.assistant .inline-artifact")).toHaveCount(0);
  await expect(page.locator(".message.assistant")).toContainText("The corrector is what the paper adds.");
  await expect(drawn.locator(".dsp-title")).toContainText("Correction training: train, then sample");
  await drawn.getByRole("button", { name: "Next step" }).click();
  await expect(drawn.locator(".dsp-step output")).toHaveText("2 / 7");
  await expect(drawn.locator(".katex").first()).toBeVisible();
  await expect(drawn.locator(".katex-error")).toHaveCount(0);
});

test("a display the reader cannot read offers to draw it again, and an HTML fence is still a sandboxed frame", async ({ page }) => {
  const unreadable = '{"display":1,"title":"Broken","figures":[]}';
  await chat(page, [...asked(fence(unreadable), "broken"), ...asked("```delphi-artifact Plain\n<main><p>An HTML visual.</p></main>\n```", "html")]);
  const visuals = page.locator(".inline-artifact");
  await expect(visuals).toHaveCount(2);
  await expect(visuals.first().locator(".inline-artifact-status")).toContainText("This diagram could not be read.");
  await expect(visuals.first().getByRole("button", { name: "Draw it again" })).toBeVisible();
  await expect(visuals.nth(1).locator("iframe.inline-artifact-frame")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(page.locator(".dsp")).toHaveCount(0);
});

// The renderer's own host: what core's draw_display check sees at each width.
const CROWDED = JSON.stringify({ display: 1, title: "Crowded", figures: [{ kind: "matrix", cols: ["C0", "C1", "C2", "C3", "C4", "C5", "C6", "C7"], rows: [{ label: "A", cells: Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, value: "0.1234567890" })) }] }],
  steps: [{ name: "One", note: "First." }, { name: "Two", note: "Only a tip changes.", set: { c0: { tip: { title: "Hidden until hovered" } } } }] });
type Walked = { option: string; step: number; fingerprint: string; issues: { code: string; target?: string }[] }[];
async function validator(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/artifact-validator.html");
  await page.waitForFunction(() => "__delphiArtifactValidator" in window);
}
const walk = (page: Page, source: string, width: number) => page.evaluate(async ([source, width]) => {
  const host = window.__delphiArtifactValidator;
  await host.mount({ title: "Display", source, width });
  return { status: await host.displayStatus(), states: await host.displayWalk() as Walked };
}, [source, width] as const);

test("the renderer's host walks every state of every board example cleanly at every width it checks", async ({ page }) => {
  await validator(page);
  const expected = { moe: 8, isoflop: 1, handbook: 1, omni: 1, correction: 14 } as Record<string, number>;
  // The three views, and each layout's narrowest card, bare or framed (core's display_edges).
  for (const name of Object.keys(expected)) for (const width of [270, 341, 343, 441, 443, 460, 521, 523, 561, 563, 800]) {
    const { status, states } = await walk(page, spec(name), width);
    expect(status.display.width, `${name} at ${width}`).toBeCloseTo(width, 0);
    expect(states, `${name} at ${width}`).toHaveLength(expected[name]);
    expect(states.flatMap(state => state.issues.map(issue => `${state.option} ${state.step}: ${issue.code}`)), `${name} at ${width}`).toEqual([]);
    // Every state draws something the state before it did not.
    expect(new Set(states.map(state => state.fingerprint)).size).toBe(states.length);
  }
});

test("the renderer's host reports a display that clips at the narrowest width and a step only a tooltip notices", async ({ page }) => {
  await validator(page);
  const { states } = await walk(page, CROWDED, 270);
  expect(states.flatMap(state => state.issues.map(issue => issue.code))).toContain("clipped_content");
  expect(states[0].fingerprint).toBe(states[1].fingerprint);
});

test("a stretch row too crowded for a narrow layout is reported there, though it fits at 460px", async ({ page }) => {
  await validator(page);
  // A probe's sampling row: it passed at 270, 460 and 800 yet showed "Eu…" in a 380px card.
  const box = (id: string, label: string, math: string) => ({ type: "node", id, label, math });
  const tile = (label: string) => ({ type: "tile", label, empty: true });
  const crowded = flow([{ type: "tile", label: "z_t", noise: 0.9 }, box("d", "D", "D_\\theta"), tile("\\hat{x}^{(0)}"), { ...box("c", "C", "C_\\phi"), repeat: { count: "×K" } }, tile("\\hat{x}^{(K)}"), box("eu", "Euler", "t\\to s"), tile("z_s")]);
  const cut = async (width: number) => (await walk(page, crowded, width)).states.flatMap(state => state.issues.filter(issue => issue.code === "clipped_content").map(issue => issue.target));
  expect(await cut(460)).toEqual([]);
  expect(await cut(343)).toContain("Euler");
});

const flow = (items: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ display: 1, title: "A flow", ...extra, figures: [{ kind: "flow", style: "stretch", lanes: [{ label: "Lane", rows: [{ items }] }] }] });

test("a static flow ending in a tile, and a corrector run hundreds of times, both check cleanly", async ({ page }) => {
  await page.goto("/tests/browser/artifact-validator.html");
  await page.waitForFunction(() => "__delphiArtifactValidator" in window);
  const bare = flow([{ type: "tile", label: "x", noise: 0.5 }, { type: "node", label: "Denoise" }, { type: "tile", label: "y", fix: true, tag: "sg" }]);
  // Motion as the production renderer sees it: not reduced, so the loop must still end.
  const many = flow([{ type: "tile", label: "x" }, { type: "node", id: "c", label: "Correct", repeat: { count: "×250", run: true } }, { type: "tile", label: "y" }],
    { steps: [{ name: "Run", note: "Many passes." }, { name: "Rest", note: "Done.", set: { c: { repeat: { count: "×250" } } } }] });
  for (const source of [bare, many]) for (const width of [270, 460, 800]) {
    const { states } = await walk(page, source, width);
    expect(states.flatMap(state => state.issues.map(issue => issue.code)), `${width}px`).toEqual([]);
  }
});

test("hidden parts leave no stray arrows, and a pill's arrow points the way it says", async ({ page }) => {
  let drawn = await show(page, fence(flow([{ type: "tile", label: "a" }, { type: "node", label: "Hidden", hidden: true }, { type: "tile", label: "b" }, { type: "node", label: "Gone", hidden: true }])), 578);
  expect(await drawn.locator(".dsp-s-row > *").evaluateAll(parts => parts.map(part => part.className.split(" ")[0]))).toEqual(["dsp-s-tile", "dsp-s-arr", "dsp-s-tile"]);
  const grid = (dir: string) => JSON.stringify({ display: 1, title: "Stages", figures: [{ kind: "grid", columns: 1, items: [
    { type: "node", label: "Top", col: 1, row: 1 }, { type: "arrow", dir, col: 1, row: 2, pill: { type: "node", label: "hidden states" } }, { type: "node", label: "Bottom", col: 1, row: 3 }] }] });
  for (const [dir, expected] of [["down", ["dsp-vl", "dsp-vl dir-down"]], ["up", ["dsp-vl dir-up", "dsp-vl"]], ["both", ["dsp-vl dir-up", "dsp-vl dir-down"]]] as const) {
    drawn = await show(page, fence(grid(dir)), 578);
    expect(await drawn.locator(".dsp-vc .dsp-vl").evaluateAll(lines => lines.map(line => line.className))).toEqual(expected);
    await expect(drawn.locator(".dsp-vc")).toContainText("hidden states");
  }
});

test("a right arrow in a node column carries what passes, and checks cleanly at every width", async ({ page }) => {
  const grid = JSON.stringify({ display: 1, title: "Hand-off", figures: [{ kind: "grid", columns: 3, items: [
    { type: "node", label: "Thinker", note: "AR engine", col: 1, row: 1 },
    { type: "arrow", dir: "right", col: 2, row: 1, pill: { type: "node", label: "hidden states" } },
    { type: "node", label: "Talker", note: "AR engine", col: 3, row: 1 }] }] });
  const drawn = await show(page, fence(grid), 578);
  const parts = await drawn.locator(".dsp-hc > *").evaluateAll(items => items.map(item => ({ cls: item.className, head: getComputedStyle(item, "::after").display, width: item.getBoundingClientRect().width })));
  expect(parts.map(part => part.cls.split(" ")[0])).toEqual(["dsp-ahl", "dsp-nd", "dsp-ahl"]);
  // The line runs into the pill and leaves it with the arrowhead.
  expect([parts[0].head, parts[2].head]).toEqual(["none", "block"]);
  expect(parts[0].width).toBeGreaterThanOrEqual(8);
  await expect(drawn.locator(".dsp-hc")).toContainText("hidden states");
  await validator(page);
  for (const width of [270, 341, 343, 441, 443, 460, 521, 523, 561, 563, 800]) {
    const { states } = await walk(page, grid, width);
    expect(states.flatMap(state => state.issues.map(issue => issue.code)), `${width}px`).toEqual([]);
  }
});

test("a step lights a chain or grid stage with the Dawn ring and leaves its tone, so the key stays true", async ({ page }) => {
  const chain = JSON.stringify({ display: 1, title: "Request path", figures: [{ kind: "flow", style: "chain", lanes: [{ label: "Path", rows: [{ items: [
    { type: "node", id: "a", label: "Thinker", tone: "blue" }, { type: "node", id: "h", label: "Thinker2Talker", tone: "dashed" }, { type: "node", id: "b", label: "Talker", tone: "blue" }] }] }] },
  { kind: "grid", columns: 1, items: [{ type: "node", id: "g", label: "GPU0", col: 1, row: 1 }] }],
  steps: [{ name: "Thinker", note: "Stage one.", set: { a: { glow: true } } }, { name: "Hand-off", note: "Hidden states cross.", set: { a: { glow: false }, h: { glow: true }, g: { glow: true } } }] });
  const drawn = await show(page, fence(chain), 578);
  const lit = () => drawn.locator(".is-glow").evaluateAll(parts => parts.map(part => [part.textContent, part.className.includes("tone-") ? part.className.match(/tone-\w+/)![0] : ""]));
  expect(await lit()).toEqual([["Thinker", "tone-blue"]]);
  await drawn.getByRole("button", { name: /^Step 2:/ }).click();
  expect(await lit()).toEqual([["Thinker2Talker", "tone-dashed"], ["GPU0", ""]]);
  await expect.poll(() => drawn.locator(".dsp-box.is-glow").evaluate(part => getComputedStyle(part).borderTopColor)).toBe("rgb(238, 157, 102)");
});

test("a chain that wraps ends each line without a dangling arrow, and a narrow column keeps every arrow", async ({ page }) => {
  const stages = ["Chat request", "Orchestrator", "Thinker", "Hidden states", "Talker", "Codec codes", "Vocoder", "Audio out"];
  const chain = JSON.stringify({ display: 1, title: "Request path", figures: [{ kind: "flow", style: "chain", lanes: [{ label: "Audio reply", rows: [{ items: stages.map(label => ({ type: "node", label, note: "a short note" })) }] }] }] });
  const arrows = (drawn: Locator) => drawn.locator(".dsp-cnode").evaluateAll(nodes => nodes.map(node => {
    const arrow = node.querySelector(".dsp-arr");
    return { top: Math.round(node.getBoundingClientRect().top), shown: arrow ? getComputedStyle(arrow).visibility === "visible" : null };
  }));
  let rows = await arrows(await show(page, fence(chain), 758));
  const lineEnds = rows.flatMap((row, n) => n < rows.length - 1 && rows[n + 1].top > row.top ? [n] : []);
  expect(lineEnds.length).toBeGreaterThan(0);
  rows.forEach((row, n) => expect(row.shown, `node ${n}`).toBe(n === rows.length - 1 ? null : !lineEnds.includes(n)));
  rows = await arrows(await show(page, fence(chain), 418));
  expect(rows.slice(0, -1).every(row => row.shown)).toBe(true);
});

test("math in a figure's key is typeset, and an axis tick stays on one line at the chart's edge", async ({ page }) => {
  const keyed = JSON.stringify({ display: 1, title: "Losses", figures: [{ kind: "flow", style: "chain", key: [{ label: "Denoiser $D_\\theta$", mark: "swatch" }, { label: "$L_2$ loss", mark: "dashed" }], lanes: [{ label: "L", rows: [{ items: [{ type: "node", label: "A" }, { type: "node", label: "B" }] }] }] }] });
  const drawn = await show(page, fence(keyed), 578);
  const key = drawn.locator(".dsp-key > span").first();
  await expect(key.locator(".katex")).toHaveCount(1);
  // KaTeX's own spans keep KaTeX's layout: the subscript sits beside its letter, not a flex gap away.
  expect(await key.locator(".katex .mord").first().evaluate(element => getComputedStyle(element).display)).not.toBe("inline-flex");
  expect(await key.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBeLessThan(20);
  for (const card of [418, 758]) {
    const chart = await show(page, fence(spec("isoflop")), card);
    const heights = await chart.locator(".dsp-xlab").evaluateAll(labels => labels.map(label => Math.round(label.getBoundingClientRect().height)));
    expect(new Set(heights).size, `ticks at ${card}`).toBe(1);
  }
});

test("worded y labels stand clear of the plot, a dot series shows its points on a log axis, and a parallel row draws no arrows", async ({ page }) => {
  const chart = JSON.stringify({ display: 1, title: "Optima", figures: [{ kind: "chart",
    x: { scale: "log", min: 1e18, max: 1e24 }, y: { scale: "log", min: 1e8, max: 1e11, ticks: [{ at: 1e8, label: "Smaller models" }, { at: 1e11, label: "Larger models" }] },
    series: [{ label: "Minima", dots: true, points: [{ x: 1e19, y: 3e8 }, { x: 1e20, y: 9e8 }, { x: 1e21, y: 3e9 }] }] }] });
  for (const card of [418, 758]) {
    const drawn = await show(page, fence(chart), card);
    const plot = await drawn.locator(".dsp-chart").evaluate(element => element.getBoundingClientRect().left);
    for (const right of await drawn.locator(".dsp-ylab").evaluateAll(labels => labels.map(label => label.getBoundingClientRect().right))) expect(right, `label at ${card}`).toBeLessThanOrEqual(plot);
    const dots = await drawn.locator(".dsp-dot i").evaluateAll(marks => marks.map(mark => ({ opacity: getComputedStyle(mark).opacity, y: mark.getBoundingClientRect().top })));
    expect(dots.map(dot => dot.opacity)).toEqual(["1", "1", "1"]);
    // Equal ratios stand at equal heights on a log axis: 3e8 → 9e8 → 3e9 climbs by about the same each time.
    expect(Math.abs((dots[0].y - dots[1].y) - (dots[1].y - dots[2].y))).toBeLessThan(6);
    await expect(drawn.locator("polyline")).toHaveCount(0);
  }
  const experts = JSON.stringify({ display: 1, title: "Experts", figures: [{ kind: "flow", lanes: [{ label: "Experts", rows: [{ parallel: true, items: ["E1", "E2", "E3"].map(label => ({ type: "node", label })) }] }] }] });
  for (const card of [418, 758]) {
    const drawn = await show(page, fence(experts), card);
    await expect(drawn.locator(".dsp-arr svg").first()).toBeHidden();
  }
});

test("a matrix foot's phrase takes its own line instead of wrapping word by word in the label column", async ({ page }) => {
  const matrix = (label: string) => JSON.stringify({ display: 1, title: "Loads", figures: [{ kind: "matrix", cols: ["E1", "E2"], rows: [{ label: "t1", cells: [{ value: "0.6" }, { value: "0.4" }] }],
    foot: { label, items: [{ chips: ["A"], note: "1 token" }, { chips: [], note: "idle" }] } }] });
  for (const card of [418, 758]) {
    const drawn = await show(page, fence(matrix("Tokens each expert must process")), card);
    const label = await drawn.locator(".dsp-loadlabel").evaluate(element => ({ height: element.getBoundingClientRect().height, wide: element.classList.contains("is-wide") }));
    expect(label.wide).toBe(true);
    // One line under its 8px top padding, where the label column stacked it a word per line.
    expect(label.height, `height at ${card}`).toBeLessThan(30);
    const short = await show(page, fence(matrix("load")), card);
    await expect(short.locator(".dsp-loadlabel")).not.toHaveClass(/is-wide/);
  }
});

test("the badge stays at every width, and an option that turns a chain lane off fades it", async ({ page }) => {
  const lanes = JSON.stringify({ display: 1, title: "Paths", badge: "Illustrative", figures: [{ kind: "flow", lanes: [
    { label: "Fast", rows: [{ items: [{ type: "node", label: "A" }] }] }, { id: "slow", label: "Slow", rows: [{ items: [{ type: "node", label: "B" }] }] }] }],
    // The reader draws what core writes out: an option's off arrives as a variant.
    control: { label: "Path", default: "both", options: [{ value: "both", label: "Both" }, { value: "fast", label: "Fast only" }] }, variants: { fast: { slow: { faded: true } } } });
  for (const card of [270, 418, 758]) {
    const drawn = await show(page, fence(lanes), card);
    await expect(drawn.locator(".dsp-title small")).toBeVisible();
    await drawn.getByRole("button", { name: "Fast only" }).click();
    await expect.poll(() => drawn.locator(".dsp-lane").nth(1).evaluate(lane => Number(getComputedStyle(lane).opacity))).toBeLessThan(0.5);
  }
});

test("a display the reader cannot draw falls back to its own card and leaves the chat standing", async ({ page }) => {
  const broken = JSON.stringify({ display: 1, title: "Loss", figures: [{ kind: "chart", x: {}, y: {}, series: [{ label: "loss", points: [{ x: 0, y: 1, read: "abc" }, { x: 1, y: 2 }] }] }] });
  const drawn = await show(page, `Before.\n\n${fence(broken)}\n\nAfter.`, 578);
  await drawn.locator(".dsp-dot").first().hover();
  await expect(page.locator(".inline-artifact-status")).toContainText("This diagram could not be read.");
  await expect(page.locator(".message.assistant")).toContainText("After.");
});

test("keyboard focus stays on the card at either end, shows a ring, and Escape closes a tip", async ({ page }) => {
  const drawn = await show(page, fence(spec("moe")), 578);
  const next = drawn.getByRole("button", { name: "Next step" });
  await next.focus();
  for (let step = 0; step < 3; step++) await page.keyboard.press("Enter");
  await expect(next).toBeDisabled();
  expect(await drawn.evaluate(card => document.activeElement === card)).toBe(true);
  expect(await drawn.evaluate(card => getComputedStyle(card).boxShadow)).not.toBe("none");
  await drawn.getByRole("button", { name: "Previous step" }).focus();
  for (let step = 0; step < 3; step++) await page.keyboard.press("Enter");
  expect(await drawn.evaluate(card => document.activeElement === card)).toBe(true);
  await drawn.locator(".dsp-cell").first().focus();
  await expect(drawn.locator(".dsp-tip")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(drawn.locator(".dsp-tip")).toHaveCount(0);
  await drawn.locator(".dsp-cell").first().focus();
  await drawn.locator(".dsp-cell").nth(1).focus();
  await page.keyboard.press("Tab");
  await drawn.focus();
  await expect(drawn.locator(".dsp-tip")).toHaveCount(0);
});
