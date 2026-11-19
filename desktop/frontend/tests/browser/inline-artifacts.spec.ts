import { expect, test, type Page } from "@playwright/test";

// Run the real chat panel in both scopes. Only the API is a fixture; the
// Markdown renderer, streaming lifecycle and sandboxed document are production.
const CONVERSATION = "8".repeat(32);
const QUESTION = { role: "user", content: "Show how learning rate changes the next step.", createdAt: "2026-10-23T00:00:00Z", requestId: "artifact-one" };
const SOURCE = `<main><h2>Learning rate</h2><p>Move the slider to change the next step.</p>
<label for="rate">Learning rate</label><input id="rate" type="range" min="0" max="100" value="20"><output id="value">20%</output>
<svg viewBox="0 0 400 120" role="img" aria-label="Gradient descent step" style="display:block;width:100%;max-height:180px"><path d="M20 20 Q200 190 380 20" fill="none" stroke="currentColor" stroke-width="2"/><circle id="point" cx="100" cy="72" r="8" fill="#a8644f"/></svg>
<button id="advance">Take a step</button><output id="steps">0 steps</output></main>
<script>document.body.dataset.authorRan='true';const rate=document.getElementById('rate');rate.addEventListener('input',()=>{document.getElementById('value').textContent=rate.value+'%';document.getElementById('point').setAttribute('cx',String(20+Number(rate.value)*3.6));});let steps=0;document.getElementById('advance').addEventListener('click',()=>document.getElementById('steps').textContent=++steps+' steps');</script>`;
const fence = (source = SOURCE, title = "Learning rate explorer") => `\`\`\`delphi-artifact ${title}\n${source}\n\`\`\``;
const answer = (content: string, requestId = "artifact-one") => ({ role: "assistant", content, createdAt: "2026-10-23T00:00:05Z", requestId });

const HEADER_SOURCE = `<main>
<div id="steps" data-artifact-controls="header"><button id="back" type="button" data-artifact-action="back" aria-label="Previous phase" disabled>Back</button><output data-artifact-progress>Training · 1 / 4</output><button id="next" type="button" data-artifact-action="next" aria-label="Next phase">Next</button></div>
<h2 id="phase">Phase 1</h2><section><label for="speed">Local speed</label><input id="speed" type="range" min="1" max="5" value="1"><output id="speed-value">1</output></section>
<section><button id="local" type="button">Local example step</button><output id="local-value">0</output></section>
<div style="height:900px;background:linear-gradient(var(--artifact-cool),var(--artifact-bg));margin-top:12px">A long diagram continues through the chat viewport.</div></main>
<script>let phase=0,local=0;window.__controlMessages=[];window.__controlsRevision=0;
const back=document.getElementById('back'),next=document.getElementById('next');function render(){back.disabled=phase===0;next.disabled=phase===3;document.querySelector('[data-artifact-progress]').textContent='Training · '+(phase+1)+' / 4';document.getElementById('phase').textContent='Phase '+(phase+1);}
back.onclick=()=>{phase=Math.max(0,phase-1);render()};next.onclick=()=>{phase=Math.min(3,phase+1);render()};
document.getElementById('speed').oninput=e=>document.getElementById('speed-value').textContent=e.target.value;document.getElementById('local').onclick=()=>document.getElementById('local-value').textContent=String(++local);
addEventListener('message',e=>{if(e.data?.type==='delphi-artifact-controls-ack')window.__controlsRevision=e.data.revision;if(e.data?.type==='delphi-artifact-control')window.__controlMessages.push(e.data)});</script>`;

type History = { messages: unknown[] };
async function serve(page: Page, history: History) {
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/chat/conversations")) return route.fulfill({ json: {
      items: [{ id: CONVERSATION, generation: 0, title: "Interactive explanation", empty: false, manualTitle: false }], defaultId: CONVERSATION, limit: 10,
    } });
    if (path.endsWith("/chat")) return route.fulfill({ json: { messages: history.messages, images: [] } });
    if (path.endsWith("/memory/pages")) return route.fulfill({ json: [] });
    return route.fulfill({ json: { items: [] } });
  });
}

// Browser-level fetch gives the test actual backpressure-free SSE chunks while
// letting it hold a stream open after the visualization has become usable.
async function streaming(page: Page) {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const streams: { controller: ReadableStreamDefaultController<Uint8Array>; request: unknown }[] = [];
    (window as any).__artifactStreams = streams;
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (!url.pathname.endsWith("/chat/stream")) return nativeFetch(input, init);
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      streams.push({ controller, request: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
  });
}
async function send(page: Page, prompt: string, index = 0) {
  await page.locator(".composer-input").click();
  await page.keyboard.type(prompt);
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).__artifactStreams.length)).toBe(index + 1);
}
async function event(page: Page, value: unknown, index = 0, close = false) {
  await page.evaluate(({ value, index, close }) => {
    const { controller } = (window as any).__artifactStreams[index];
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
    if (close) controller.close();
  }, { value, index, close });
}
const open = (page: Page, scope = "document") => page.goto(`/tests/browser/harness.html?responsive-chat&closable&scope=${scope}`);

for (const scope of ["document", "general"]) {
  test(`${scope}: a completed visual runs before the answer ends and survives later deltas and a follow-up`, async ({ page }) => {
    const history: History = { messages: [] };
    await serve(page, history);
    await streaming(page);
    await open(page, scope);
    await send(page, QUESTION.content);
    const prefix = "The size of each update depends on the learning rate.\n\n```delphi-artifact Learning rate explorer\n";
    await event(page, { type: "delta", text: prefix + SOURCE.slice(0, 80) });
    const visual = page.locator(".inline-artifact").first();
    await expect(visual).toHaveAttribute("data-artifact-state", "loading");
    await expect(visual).not.toContainText("<main>");
    await event(page, { type: "delta", text: SOURCE.slice(80) });
    const preview = page.frameLocator("iframe.inline-artifact-preview");
    await expect(preview.getByRole("button", { name: "Take a step" })).toBeVisible();
    await expect(visual.locator(".inline-artifact-preview-wrap")).toHaveAttribute("inert", "");
    await expect(visual.locator("iframe")).toHaveAttribute("tabindex", "-1");
    await expect(preview.locator("body")).not.toHaveAttribute("data-author-ran", "true");
    await preview.getByRole("button", { name: "Take a step" }).evaluate((element: HTMLButtonElement) => element.click());
    await expect(preview.locator("#steps")).toHaveText("0 steps");
    await event(page, { type: "delta", text: "\n```\n\n" });
    await expect(visual).toHaveAttribute("data-artifact-state", "ready");
    const frame = page.frameLocator("iframe.inline-artifact-frame").first();
    await expect(frame.locator("body")).toHaveAttribute("data-author-ran", "true");
    await frame.getByRole("slider", { name: "Learning rate" }).evaluate((element: HTMLInputElement) => { element.value = "70"; element.dispatchEvent(new Event("input", { bubbles: true })); });
    await frame.getByRole("button", { name: "Take a step" }).click();
    await expect(frame.locator("#value")).toHaveText("70%");
    await expect(frame.locator("#steps")).toHaveText("1 steps");
    const name = await visual.locator("iframe").getAttribute("name");
    await event(page, { type: "delta", text: "A larger step moves farther along the slope." });
    await expect(page.locator(".kb-chat-turn").last()).toContainText("A larger step moves farther");
    await expect(frame.locator("#value")).toHaveText("70%");
    await expect(visual.locator("iframe")).toHaveAttribute("name", name!);
    const content = prefix + SOURCE + "\n```\n\nA larger step moves farther along the slope.";
    history.messages = [QUESTION, answer(content)];
    await event(page, { type: "done" }, 0, true);
    await expect(page.locator(".composer-input")).toBeVisible();
    await send(page, "What happens if the step is too large?", 1);
    await event(page, { type: "delta", text: "It can overshoot the minimum." }, 1);
    await expect(frame.locator("#value")).toHaveText("70%");
    await expect(frame.locator("#steps")).toHaveText("1 steps");
    await event(page, { type: "done" }, 1, true);
    expect(await page.evaluate(() => (window as any).__artifactStreams.map((stream: any) => stream.request.scope))).toEqual([scope, scope]);
    // History stores the source with the answer; reloading reconstructs a usable
    // visual, while its transient slider position correctly starts fresh.
    await page.reload();
    await expect(visual).toHaveAttribute("data-artifact-state", "ready");
    await expect(frame.locator("#value")).toHaveText("20%");
    await frame.getByRole("button", { name: "Take a step" }).click();
    await expect(frame.locator("#steps")).toHaveText("1 steps");
  });
}

test("an interrupted streamed visual keeps a static preview and explains why it cannot run", async ({ page }) => {
  const history: History = { messages: [] };
  await serve(page, history);
  await streaming(page);
  await open(page);
  await send(page, QUESTION.content);
  const content = "```delphi-artifact Interrupted explorer\n" + SOURCE;
  await event(page, { type: "delta", text: content });
  const visual = page.locator(".inline-artifact");
  const preview = page.frameLocator("iframe.inline-artifact-preview");
  await expect(visual).toHaveAttribute("data-artifact-state", "loading");
  await expect(preview.locator("#steps")).toHaveText("0 steps");
  history.messages = [QUESTION, answer(content)];
  await event(page, { type: "done" }, 0, true);
  await expect(visual).toHaveAttribute("data-artifact-state", "error");
  await expect(visual.locator(".inline-artifact-status")).toContainText("The diagram stopped before it finished.");
  await expect(visual.locator("iframe:not(.inline-artifact-preview)")).toHaveCount(0);
  await expect(preview.locator("body")).not.toHaveAttribute("data-author-ran", "true");
});

test("a reader can reset a saved visual without affecting surrounding prose, and there is no source view", async ({ page }) => {
  await serve(page, { messages: [QUESTION, answer(`Before the explorer.\n\n${fence()}\n\nAfter the explorer.`)] });
  await open(page);
  const visual = page.locator(".inline-artifact");
  const frame = page.frameLocator("iframe.inline-artifact-frame");
  await expect(visual).toHaveAttribute("data-artifact-state", "ready");
  await frame.getByRole("button", { name: "Take a step" }).click();
  await expect(frame.locator("#steps")).toHaveText("1 steps");
  // A visual is read as a picture; its source is not offered (Kevin, 2026-11-01).
  await expect(visual.getByRole("button", { name: /visualization source/ })).toHaveCount(0);
  await visual.getByRole("button", { name: "Reset visualization" }).click();
  await expect(frame.locator("#steps")).toHaveText("0 steps");
  await expect(page.locator(".kb-chat-turn").last()).toContainText("Before the explorer.");
  await expect(page.locator(".kb-chat-turn").last()).toContainText("After the explorer.");
});

test("unfinished, oversized and broken visuals show recoverable fallbacks", async ({ page }) => {
  const incomplete = "```delphi-artifact Unfinished diagram\n<main>This document was cut off.";
  const oversized = fence(`<main>${"x".repeat(132_000)}</main>`, "Too large");
  const broken = fence("<p>Before a runtime error.</p><script>throw new Error('fixture runtime error')</script>", "Broken diagram");
  await serve(page, { messages: [QUESTION, answer(`${incomplete}`), QUESTION, answer(oversized, "large"), QUESTION, answer(broken, "broken"), QUESTION, answer(fence("", "Empty diagram"), "empty")] });
  await open(page);
  const visuals = page.locator(".inline-artifact");
  await expect(visuals).toHaveCount(4);
  for (let i = 0; i < 3; i++) {
    await expect(visuals.nth(i)).toHaveAttribute("data-artifact-state", "error");
    await expect(visuals.nth(i).locator(".inline-artifact-status")).toBeVisible();
    await expect(visuals.nth(i).locator("pre")).toHaveCount(0);
  }
  await expect(visuals.nth(0).locator("iframe:not(.inline-artifact-preview)")).toHaveCount(0);
  await expect(visuals.nth(1).locator("iframe")).toHaveCount(0);
  await expect(visuals.nth(3)).toHaveAttribute("data-artifact-state", "error");
  await expect(visuals.nth(3).locator(".inline-artifact-status")).toContainText("This diagram came back empty.");
});

test("each problem state offers one recovery, sent as an ordinary follow-up once the answer has ended", async ({ page }) => {
  const history: History = { messages: [] };
  await serve(page, history);
  await streaming(page);
  await open(page);
  await send(page, QUESTION.content);
  const content = "```delphi-artifact Interrupted explorer\n" + SOURCE;
  await event(page, { type: "delta", text: content });
  const visual = page.locator(".inline-artifact");
  // While the answer streams the card draws; nothing asks for anything yet.
  await expect(visual.locator(".inline-artifact-status")).toContainText("Drawing");
  await expect(visual.getByRole("button", { name: "Finish it" })).toHaveCount(0);
  history.messages = [QUESTION, answer(content)];
  await event(page, { type: "done" }, 0, true);
  await expect(visual.locator(".inline-artifact-tile")).toHaveClass(/is-unfinished/);
  // A reply being typed survives the follow-up and is not sent with it.
  await page.locator(".composer-input").click();
  await page.keyboard.type("my own next question");
  await visual.getByRole("button", { name: "Finish it" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__artifactStreams.length)).toBe(2);
  await expect(page.locator(".composer-input")).toContainText("my own next question");
  expect(JSON.stringify(await page.evaluate(() => (window as any).__artifactStreams[1].request))).not.toContain("my own next question");
  expect(JSON.stringify(await page.evaluate(() => (window as any).__artifactStreams[1].request))).toContain("Please finish the diagram “Interrupted explorer”");
});

test("too large and empty diagrams use the neutral tile and their own recovery", async ({ page }) => {
  const oversized = fence(`<main>${"x".repeat(132_000)}</main>`, "Too large");
  await serve(page, { messages: [QUESTION, answer(oversized, "large"), QUESTION, answer(fence("", "Empty diagram"), "empty")] });
  await open(page);
  const visuals = page.locator(".inline-artifact");
  await expect(visuals).toHaveCount(2);
  for (const [index, line, action] of [[0, "This diagram is too large to show.", "Ask for a smaller one"], [1, "This diagram came back empty.", "Draw it again"]] as const) {
    await expect(visuals.nth(index).locator(".inline-artifact-status")).toContainText(line);
    await expect(visuals.nth(index).locator(".inline-artifact-tile")).not.toHaveClass(/is-unfinished/);
    await expect(visuals.nth(index).getByRole("button", { name: action })).toBeVisible();
  }
});

test("the step track and arrow keys walk the author's own steps, and the first Next invites once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await serve(page, { messages: [QUESTION, answer(fence(HEADER_SOURCE, "A long process"))] });
  await open(page);
  const visual = page.locator(".inline-artifact"), frame = page.frameLocator("iframe.inline-artifact-frame");
  const controls = visual.locator("figcaption").getByRole("group", { name: "Diagram steps" });
  const next = controls.getByRole("button", { name: "Next phase" });
  await expect(next).toHaveClass(/is-inviting/);
  const track = visual.locator("figcaption .inline-artifact-track button");
  await expect(track).toHaveCount(4);
  await expect(track.nth(0)).toHaveClass(/is-current/);
  await track.nth(2).click();
  await expect(frame.locator("#phase")).toHaveText("Phase 3");
  await expect(track.nth(2)).toHaveClass(/is-current/);
  await expect(track.nth(0)).toHaveClass(/is-done/);
  await expect(next).not.toHaveClass(/is-inviting/);
  // The author's control logic decides each move: one message per step.
  await expect.poll(() => frame.locator("body").evaluate(() => (window as any).__controlMessages.map((m: any) => m.action).join())).toBe("next,next");
  await track.nth(0).click();
  await expect(frame.locator("#phase")).toHaveText("Phase 1");
  await visual.focus();
  await page.keyboard.press("ArrowRight");
  await expect(frame.locator("#phase")).toHaveText("Phase 2");
  // Back is enabled once the diagram has reported its new step to the header.
  await expect(controls.getByRole("status")).toHaveText("2 / 4");
  await page.keyboard.press("ArrowLeft");
  await expect(frame.locator("#phase")).toHaveText("Phase 1");
  await page.keyboard.press("ArrowLeft");
  await expect(frame.locator("#phase")).toHaveText("Phase 1");
  // Reset brings back the first step and its invitation.
  await page.keyboard.press("ArrowRight");
  await visual.getByRole("button", { name: "Reset visualization", exact: true }).click();
  await expect(controls.getByRole("status")).toHaveText("1 / 4");
  await expect(next).toHaveClass(/is-inviting/);
  // Presses made faster than the diagram answers are kept, in order.
  await visual.evaluate(element => { for (let i = 0; i < 3; i++) element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  await expect(frame.locator("#phase")).toHaveText("Phase 4");
  await expect(controls.getByRole("status")).toHaveText("4 / 4");
});

test("the header keeps up with a frame that never paints, and arrow keys step from inside the diagram", async ({ page, browserName }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Chromium stops animation frames in a frame it judges unseen; the header must not wait for one.
  await serve(page, { messages: [QUESTION, answer(fence(HEADER_SOURCE.replace("<script>", "<script>window.requestAnimationFrame=()=>0;"), "A long process"))] });
  await open(page);
  const visual = page.locator(".inline-artifact"), frame = page.frameLocator("iframe.inline-artifact-frame");
  const controls = visual.locator("figcaption").getByRole("group", { name: "Diagram steps" });
  await controls.getByRole("button", { name: "Next phase" }).click();
  await expect(controls.getByRole("status")).toHaveText("2 / 4");
  await controls.getByRole("button", { name: "Next phase" }).click();
  await expect(controls.getByRole("status")).toHaveText("3 / 4");
  await controls.getByRole("button", { name: "Previous phase" }).click();
  await expect(controls.getByRole("status")).toHaveText("2 / 4");
  await frame.locator("#phase").click();
  await page.keyboard.press("ArrowRight");
  await expect(frame.locator("#phase")).toHaveText("Phase 3");
  await expect(controls.getByRole("status")).toHaveText("3 / 4");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(frame.locator("#phase")).toHaveText("Phase 1");
  await expect(controls.getByRole("status")).toHaveText("1 / 4");
  // A control that uses the arrows keeps them.
  await frame.getByRole("slider", { name: "Local speed" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(frame.locator("#speed-value")).toHaveText("2");
  await expect(frame.locator("#phase")).toHaveText("Phase 1");
  // So does a wide figure that scrolls sideways.
  const scroller = frame.locator("#wide");
  await frame.locator("main").evaluate(main => main.insertAdjacentHTML("beforeend", '<div id="wide" tabindex="0" style="overflow-x:auto;width:120px"><div style="width:480px;height:20px"></div></div>'));
  await scroller.evaluate(element => addEventListener("keydown", event => { element.dataset.kept = String(!event.defaultPrevented); }));
  await scroller.focus();
  await page.keyboard.press("ArrowRight");
  await expect(scroller).toHaveAttribute("data-kept", "true");
  // Playwright's WebKit does not scroll on a synthetic arrow key, even in a bare page.
  if (browserName !== "webkit") await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await expect(frame.locator("#phase")).toHaveText("Phase 1");
});

test("ordinary HTML and quoted artifact syntax remain inert text", async ({ page }) => {
  const payload = "<button onclick=\"window.__ordinaryHtmlRan=true\">Do not execute</button><script>window.__ordinaryHtmlRan=true</script>";
  await serve(page, { messages: [{ ...QUESTION, content: fence(payload) }, answer(`Ordinary example:\n\n\`\`\`html\n${payload}\n\`\`\`\n\n\`\`\`markdown\n${fence()}\n\`\`\`\n\n${payload}`)] });
  await open(page);
  await expect(page.locator(".kb-chat-turn").last()).toContainText("Ordinary example");
  await expect(page.locator("iframe.inline-artifact-frame")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Do not execute", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__ordinaryHtmlRan)).toBeUndefined();
});

test("visuals have an opaque origin and cannot access chat, storage or network", async ({ page }) => {
  const outside: string[] = [];
  page.on("request", request => { if (request.url().startsWith("https://artifact-fixture.invalid/")) outside.push(request.url()); });
  const probe = `<output id="parent">pending</output><output id="storage">pending</output><output id="origin"></output>
<script>try{parent.document.body;document.getElementById('parent').textContent='allowed'}catch{document.getElementById('parent').textContent='blocked'}try{localStorage.setItem('artifact-probe','x');document.getElementById('storage').textContent='allowed'}catch{document.getElementById('storage').textContent='blocked'}document.getElementById('origin').textContent=self.origin;</script>`;
  await serve(page, { messages: [QUESTION, answer(`${fence(probe, "Isolation check")}\n\n${fence("<script>fetch('https://artifact-fixture.invalid/exfiltrate').catch(()=>{})</script>", "Network check")}`)] });
  await open(page);
  const visual = page.locator(".inline-artifact").first();
  const frame = page.frameLocator("iframe.inline-artifact-frame").first();
  await expect(visual).toHaveAttribute("data-artifact-state", "ready");
  await expect(visual.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame.locator("#parent")).toHaveText("blocked");
  await expect(frame.locator("#storage")).toHaveText("blocked");
  await expect(page.locator(".inline-artifact").nth(1)).toHaveAttribute("data-artifact-state", "error");
  await expect(frame.locator("#origin")).toHaveText("null");
  await page.evaluate(async () => {
    window.postMessage({ type: "delphi-artifact", error: "forged parent message", height: 999999 }, "*");
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await expect(visual).toHaveAttribute("data-artifact-state", "ready");
  expect(outside).toEqual([]);
});

// The desktop ends an artifact as soon as it nests a frame (main/artifacts/
// navigation.ts), knowing artifacts by this name on a child of the reader's
// document. Until then a nested document must hold to the artifact's own
// isolation, which it inherits rather than runs: the bootstrap never reaches it.
test("every visual frame is a named child of the reader, and a frame nested in one inherits its isolation", async ({ page }) => {
  // Chromium reports a request CSP refused; only a routed one left the page.
  const outside: string[] = [];
  await page.route("https://artifact-fixture.invalid/**", route => { outside.push(route.request().url()); return route.abort(); });
  const inner = `<script>const say=finding=>parent.postMessage({nestedProbe:finding},'*');
addEventListener('securitypolicyviolation',e=>say('violation:'+e.violatedDirective));say('origin:'+self.origin);
try{top.document.body;say('top:allowed')}catch{say('top:blocked')}try{top.location.href='https://artifact-fixture.invalid/nested-navigation'}catch{}
new Image().src='https://artifact-fixture.invalid/nested-image';fetch('https://artifact-fixture.invalid/nested-fetch').then(()=>say('fetch:allowed'),()=>say('fetch:blocked'));<\/script>`;
  const probe = `<p>Nested frame check</p><output id="nested">pending</output>
<script>const findings=new Set();addEventListener('message',e=>{if(typeof e.data?.nestedProbe!=='string')return;findings.add(e.data.nestedProbe);document.getElementById('nested').textContent=[...findings].sort().join(' ')});
const f=document.createElement('iframe');f.srcdoc=${JSON.stringify(inner).replaceAll("<", "\\u003c")};document.body.append(f);</script>`;
  const named = async (selector: string) => {
    const name = await page.locator(selector).getAttribute("name");
    expect(name).toMatch(/^delphi-artifact-/);
    expect(page.frame({ name: name! })?.parentFrame()).toBe(page.mainFrame());
    return page.frame({ name: name! })!;
  };
  await serve(page, { messages: [] });
  await streaming(page);
  await open(page);
  await send(page, QUESTION.content);
  await event(page, { type: "delta", text: "```delphi-artifact Nested check\n" + probe });
  await expect(page.locator("iframe.inline-artifact-preview")).toBeVisible();
  await named("iframe.inline-artifact-preview");
  await event(page, { type: "delta", text: "\n```\n" });
  const visual = page.locator(".inline-artifact").first();
  await expect(visual).toHaveAttribute("data-artifact-state", "ready");
  const artifact = await named("iframe.inline-artifact-frame");
  await expect(page.frameLocator("iframe.inline-artifact-frame").first().locator("#nested"))
    .toHaveText("fetch:blocked origin:null top:blocked violation:connect-src violation:img-src");
  expect(artifact.childFrames()).toHaveLength(1);
  expect(new URL(page.url()).hostname).not.toBe("artifact-fixture.invalid");
  expect(outside).toEqual([]);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`${colorScheme}: a visual fits narrow and wide chat columns and keeps its controls usable`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await serve(page, { messages: [QUESTION, answer(`Explore a step.\n\n${fence()}\n\nThe same rule applies at every point.`)] });
    await open(page);
    // Delphi currently paints a light chat surface even on a dark OS.
    await expect(page.frameLocator("iframe.inline-artifact-frame").locator("html")).toHaveAttribute("data-theme", "light");
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, colorScheme);
    await page.setViewportSize({ width: 1200, height: 1100 });
    await page.getByTestId("chat-width").evaluate(element => { element.style.height = "1000px"; });
    const visual = page.locator(".inline-artifact");
    await expect(visual).toHaveAttribute("data-artifact-state", "ready");
    for (const width of [340, 760]) {
      await page.getByTestId("chat-width").evaluate((element, width) => { element.style.width = width + "px"; }, width);
      await expect.poll(() => visual.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await expect.poll(() => page.locator("iframe.inline-artifact-frame").evaluate(element => {
        const parent = element.parentElement!.getBoundingClientRect();
        const frame = element.getBoundingClientRect();
        return frame.width <= parent.width && frame.height >= 96 && frame.height <= 1400;
      })).toBe(true);
      const frame = page.frameLocator("iframe.inline-artifact-frame");
      await frame.getByRole("slider", { name: "Learning rate" }).evaluate((element: HTMLInputElement) => { element.value = "60"; element.dispatchEvent(new Event("input", { bubbles: true })); });
      await expect(frame.locator("#value")).toHaveText("60%");
      await page.locator(".kb-chat-rail").evaluate(element => { element.style.height = "1000px"; });
      await visual.screenshot({ path: test.info().outputPath(`artifact-${colorScheme}-${width}.png`) });
    }
    // Switching an app-selected theme does not reset an active visualization.
    const frame = page.frameLocator("iframe.inline-artifact-frame");
    await frame.getByRole("button", { name: "Take a step" }).click();
    const opposite = colorScheme === "dark" ? "light" : "dark";
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, opposite);
    await expect(frame.locator("html")).toHaveAttribute("data-theme", opposite);
    await expect(frame.locator("#value")).toHaveText("60%");
    await expect(frame.locator("#steps")).toHaveText("1 steps");
  });
}

test("a wide timeline scrolls locally at narrow widths without shrinking labels or stretching icons", async ({ page }) => {
  const source = `<style>.wide-timeline{width:820px}</style><div id="timeline-scroll" style="overflow-x:auto"><svg id="timeline" viewBox="0 0 820 80" style="width:820px"><text x="10" y="30" font-size="13">A readable timeline</text><text x="730" y="30" font-size="13">Final stage</text></svg><svg id="timeline-class" class="wide-timeline" viewBox="0 0 820 30"><text x="10" y="20" font-size="13">An author stylesheet controls this width too</text></svg></div><svg id="responsive" viewBox="0 0 400 100"><rect width="400" height="100" fill="var(--artifact-cool)"/></svg><svg id="icon" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>`;
  await serve(page, { messages: [QUESTION, answer(fence(source, "A timeline that preserves its scale"))] });
  await open(page);
  await page.getByTestId("chat-width").evaluate(element => { element.style.width = "340px"; });
  const frame = page.frameLocator("iframe.inline-artifact-frame");
  await expect(page.locator(".inline-artifact")).toHaveAttribute("data-artifact-state", "ready");
  await expect(frame.locator("#timeline")).toHaveCSS("width", "820px");
  await expect(frame.locator("#timeline-class")).toHaveCSS("width", "820px");
  await expect(frame.locator("#timeline text").first()).toHaveCSS("font-size", "13px");
  expect(await frame.locator("#timeline-scroll").evaluate(element => element.scrollWidth)).toBe(820);
  await frame.locator("#timeline-scroll").evaluate(element => { element.scrollLeft = element.scrollWidth; });
  expect(await frame.locator("#timeline-scroll").evaluate(element => element.scrollLeft)).toBeGreaterThan(400);
  await expect(frame.locator("#icon")).toHaveCSS("width", "20px");
  expect(await frame.locator("#responsive").evaluate(element => element.getBoundingClientRect().width <= element.parentElement!.clientWidth)).toBe(true);
  expect(await frame.locator("body").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

const MOTION_SOURCE = `<section id="process"><div id="input-node" class="artifact-node" data-artifact-step="0">Noisy input</div>
<svg viewBox="0 0 400 180" aria-label="Source-directed correction loop"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8Z" fill="var(--artifact-accent)"/></marker></defs>
<path id="reverse-edge" data-artifact-edge data-artifact-step="0" d="M360 30 H40" stroke="var(--artifact-accent)" stroke-width="2" fill="none" marker-end="url(#arrow)"/>
<path id="curved-edge" data-artifact-edge data-artifact-step="1" d="M350 70 C350 165 50 165 50 70" stroke="var(--artifact-cool-ink)" stroke-width="2" fill="none" marker-end="url(#arrow)"/>
<g id="target-node" data-artifact-step="2"><rect x="120" y="20" width="160" height="40" rx="8" fill="var(--artifact-warm)"/><text x="200" y="45" text-anchor="middle" fill="var(--artifact-ink)">Corrected prediction</text></g></svg>
<div class="artifact-controls"><button id="replay">Step through again</button><output id="replays">0</output></div></section>
<script>let count=0;document.getElementById('replay').onclick=()=>{document.getElementById('replays').textContent=String(++count);window.DelphiArtifact.replay(document.getElementById('process'));};</script>`;

test("artifact surfaces and corners inherit the actual chat design without resetting the visual", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await serve(page, { messages: [QUESTION, answer(fence(MOTION_SOURCE, "Correction process"))] });
  await open(page);
  const visual = page.locator(".inline-artifact"), frame = page.frameLocator("iframe.inline-artifact-frame");
  await expect(visual).toHaveAttribute("data-artifact-state", "ready");
  const host = await page.locator(".composer").evaluate(element => ({ radius: getComputedStyle(element).borderRadius, font: getComputedStyle(element).fontFamily }));
  await expect(visual).toHaveCSS("border-radius", host.radius);
  await expect(frame.locator("#input-node")).toHaveCSS("border-radius", host.radius);
  await expect(frame.locator("body")).toHaveCSS("font-family", host.font);
  await frame.getByRole("button", { name: "Step through again" }).click();
  await page.evaluate(() => {
    const style = document.documentElement.style;
    style.setProperty("--paper", "#252126"); style.setProperty("--canvas", "#302b32");
    style.setProperty("--ink", "#f6eef1"); style.setProperty("--clay", "#f6c7d1");
    style.setProperty("--chat-card-radius", "12px");
    document.documentElement.dataset.theme = "dark";
  });
  await expect(frame.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(frame.locator("html")).toHaveCSS("background-color", "rgb(37, 33, 38)");
  await expect(visual.locator(".inline-artifact-caption")).toHaveCSS("background-color", "rgb(37, 33, 38)");
  await expect(frame.locator("body")).toHaveCSS("color", "rgb(246, 238, 241)");
  await expect(frame.locator("#reverse-edge")).toHaveCSS("stroke", "rgb(246, 199, 209)");
  await expect(visual).toHaveCSS("border-radius", "12px");
  await expect(page.locator(".composer")).toHaveCSS("border-radius", "12px");
  await expect(frame.locator("#input-node")).toHaveCSS("border-radius", "12px");
  await expect(frame.locator("#replays")).toHaveText("1");
});

test("diagram entrance follows each source path and replays only when the reader asks", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await serve(page, { messages: [] });
  await streaming(page);
  await open(page);
  await send(page, "Explain this process.");
  await event(page, { type: "delta", text: "```delphi-artifact Correction process\n" + MOTION_SOURCE });
  const preview = page.frameLocator("iframe.inline-artifact-preview");
  await expect(preview.locator("#input-node")).toBeVisible();
  expect(await preview.locator("body").evaluate(() => ({ animations: document.getAnimations().length, runtime: typeof (window as any).DelphiArtifact, masks: document.querySelectorAll('[data-artifact-runtime="edge-mask"]').length }))).toEqual({ animations: 0, runtime: "undefined", masks: 0 });
  await event(page, { type: "delta", text: "\n```\n\n" });
  const visual = page.locator(".inline-artifact"), frame = page.frameLocator("iframe.inline-artifact-frame");
  await expect(visual).toHaveAttribute("data-artifact-state", "ready");
  const nodeGeometry = await frame.locator("body").evaluate(() => {
    for (const animation of document.getAnimations()) animation.finish();
    const positions = () => ["input-node", "target-node"].map(id => {
      const bounds = document.getElementById(id)!.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    });
    const before = positions();
    (window as any).DelphiArtifact.replay();
    for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 80; }
    return { before, during: positions() };
  });
  expect(nodeGeometry.during).toEqual(nodeGeometry.before);
  const reveal = await frame.locator("#reverse-edge").evaluate(edge => {
    const circles = [...document.querySelector(edge.getAttribute("mask")!.slice(4, -1))!.querySelectorAll("circle")];
    return { firstX: Number(circles[0].getAttribute("cx")), lastX: Number(circles.at(-1)!.getAttribute("cx")), firstOpacity: Number(getComputedStyle(circles[0]).opacity), lastOpacity: Number(getComputedStyle(circles.at(-1)!).opacity), animated: document.getAnimations().flatMap(animation => (animation.effect as KeyframeEffect).getKeyframes().flatMap(frame => Object.keys(frame).filter(key => !["offset", "computedOffset", "easing", "composite"].includes(key)))) };
  });
  expect(reveal.firstX).toBeGreaterThan(reveal.lastX);
  expect(reveal.firstOpacity).toBeGreaterThan(.9);
  expect(reveal.lastOpacity).toBe(0);
  expect(new Set(reveal.animated)).toEqual(new Set(["opacity"]));
  const curve = await frame.locator("#curved-edge").evaluate(edge => {
    const circles = [...document.querySelector(edge.getAttribute("mask")!.slice(4, -1))!.querySelectorAll("circle")];
    return { start: [Number(circles[0].getAttribute("cx")), Number(circles[0].getAttribute("cy"))], middleY: Number(circles[Math.floor(circles.length / 2)].getAttribute("cy")), end: [Number(circles.at(-1)!.getAttribute("cx")), Number(circles.at(-1)!.getAttribute("cy"))] };
  });
  expect(curve.start[0]).toBeGreaterThan(curve.end[0]);
  expect(curve.middleY).toBeGreaterThan(curve.start[1] + 50);
  await frame.locator("body").evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  await expect(frame.locator('[data-artifact-runtime="edge-mask"]')).toHaveCount(0);
  await expect(frame.locator("#reverse-edge")).not.toHaveAttribute("mask");
  await expect(frame.locator("#reverse-edge")).toHaveAttribute("marker-end", "url(#arrow)");
  await frame.locator("body").evaluate(() => {
    (window as any).__laterAnimations = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function(...args) { (window as any).__laterAnimations++; return animate.apply(this, args); };
  });
  await event(page, { type: "delta", text: "The same correction is repeated at a fixed noise level." });
  await page.evaluate(() => { document.documentElement.style.setProperty("--clay", "#773345"); });
  await expect(frame.locator("#reverse-edge")).toHaveCSS("stroke", "rgb(119, 51, 69)");
  expect(await frame.locator("body").evaluate(() => (window as any).__laterAnimations)).toBe(0);
  await frame.getByRole("button", { name: "Step through again" }).click();
  await expect(frame.locator("#replays")).toHaveText("1");
  expect(await frame.locator("body").evaluate(() => (window as any).__laterAnimations)).toBeGreaterThan(0);
  await expect(frame.locator('[data-artifact-runtime="edge-mask"]')).toHaveCount(0);
  await expect(frame.locator("svg defs")).toHaveCount(1);
  await event(page, { type: "done" }, 0, true);
});

test("reduced motion shows the whole process and cancels an active reveal", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await serve(page, { messages: [QUESTION, answer(fence(MOTION_SOURCE, "Correction process"))] });
  await open(page);
  const frame = page.frameLocator("iframe.inline-artifact-frame");
  const changePreference = async (reducedMotion: "reduce" | "no-preference") => {
    // Observe an existing query's change delivery, as the runtime does. A new
    // matchMedia query can see the preference before existing listeners run.
    await frame.locator("body").evaluate(() => {
      const media = matchMedia("(prefers-reduced-motion: reduce)");
      const observed = { changed: false, matches: media.matches };
      const changed = (event: MediaQueryListEvent) => { observed.changed = true; observed.matches = event.matches; };
      media.addEventListener("change", changed);
      (window as any).__artifactPreferenceChange = { observed, cleanup: () => media.removeEventListener("change", changed) };
    });
    try {
      await page.emulateMedia({ reducedMotion });
      await expect.poll(() => frame.locator("body").evaluate(() => (window as any).__artifactPreferenceChange.observed))
        .toEqual({ changed: true, matches: reducedMotion === "reduce" });
    } finally {
      await frame.locator("body").evaluate(() => {
        (window as any).__artifactPreferenceChange?.cleanup();
        delete (window as any).__artifactPreferenceChange;
      });
    }
  };
  await expect(page.locator(".inline-artifact")).toHaveAttribute("data-artifact-state", "ready");
  await frame.getByRole("button", { name: "Step through again" }).click();
  await expect(frame.locator("#input-node")).toHaveCSS("opacity", "1");
  await expect(frame.locator("#target-node")).toHaveCSS("opacity", "1");
  expect(await frame.locator("body").evaluate(() => document.getAnimations().length)).toBe(0);
  await expect(frame.locator('[data-artifact-runtime="edge-mask"]')).toHaveCount(0);
  await expect(frame.locator("html")).not.toHaveAttribute("data-artifact-motion");
  await changePreference("no-preference");
  await frame.locator("body").evaluate(() => { (window as any).DelphiArtifact.replay(); for (const animation of document.getAnimations()) animation.pause(); });
  await expect(frame.locator('[data-artifact-runtime="edge-mask"]')).toHaveCount(2);
  await changePreference("reduce");
  await expect(frame.locator('[data-artifact-runtime="edge-mask"]')).toHaveCount(0);
  await expect(frame.locator("#reverse-edge")).not.toHaveAttribute("mask");
  await expect(frame.locator("#curved-edge")).not.toHaveAttribute("mask");
  expect(await frame.locator("body").evaluate(() => document.getAnimations().length)).toBe(0);
  await expect(frame.locator("#input-node")).toHaveCSS("opacity", "1");
});

test("many separately inserted edges share a bounded animation budget and clean up after replay", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await serve(page, { messages: [QUESTION, answer(fence('<svg id="many-edges" viewBox="0 0 400 100" aria-label="Many independent paths"></svg>', "Bounded drawing"))] });
  await open(page);
  const frame = page.frameLocator("iframe.inline-artifact-frame");
  await expect(page.locator(".inline-artifact")).toHaveAttribute("data-artifact-state", "ready");
  const count = await frame.locator("#many-edges").evaluate(async svg => {
    for (let index = 0; index < 30; index++) {
      const edge = document.createElementNS("http://www.w3.org/2000/svg", "path");
      edge.setAttribute("d", `M10 ${index * 3} H390`); edge.setAttribute("stroke", "currentColor");
      edge.setAttribute("data-artifact-edge", ""); svg.append(edge);
    }
    await new Promise(requestAnimationFrame);
    for (const animation of document.getAnimations()) animation.pause();
    return document.querySelectorAll('[data-artifact-runtime="edge-mask"]').length;
  });
  expect(count).toBe(24);
  await frame.locator("body").evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  await expect(frame.locator('[data-artifact-runtime="edge-mask"]')).toHaveCount(0);
  await frame.locator("body").evaluate(() => { (window as any).DelphiArtifact.replay(); for (const animation of document.getAnimations()) animation.pause(); });
  await expect(frame.locator('[data-artifact-runtime="edge-mask"]')).toHaveCount(24);
  await frame.locator("body").evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  await expect(frame.locator("svg defs")).toHaveCount(0);
  await expect(frame.locator("svg path")).toHaveCount(30);
  await expect(frame.locator("path[mask]")).toHaveCount(0);
});

for (const hiddenMode of ["attribute", "class"]) test(`${hiddenMode} hidden panels override authored grid display in previews and interactive tabs`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const source = `<style>.hidden{display:none}.panel{display:grid;grid-template-columns:1fr;gap:8px}</style><div class="artifact-controls"><button id="training">Training</button><button id="sampling">Sampling</button></div><section id="training-panel" class="panel"><div class="artifact-node">Training diagram</div></section><section id="sampling-panel" class="panel ${hiddenMode === "class" ? "hidden" : ""}" ${hiddenMode === "attribute" ? "hidden" : ""}><div class="artifact-node">Sampling diagram</div></section><script>for(const name of ['training','sampling'])document.getElementById(name).onclick=()=>{for(const kind of ['training','sampling']){const panel=document.getElementById(kind+'-panel');if('${hiddenMode}'==='attribute')panel.hidden=name!==kind;else panel.classList.toggle('hidden',name!==kind);}window.DelphiArtifact.replay(document.getElementById(name+'-panel'));};</script>`;
  await serve(page, { messages: [] });
  await streaming(page);
  await open(page);
  await send(page, "Compare training and sampling.");
  await event(page, { type: "delta", text: "```delphi-artifact Training and sampling\n" + source });
  const preview = page.frameLocator("iframe.inline-artifact-preview");
  await expect(preview.locator("#training-panel")).toBeVisible();
  await expect(preview.locator("#sampling-panel")).toBeHidden();
  await event(page, { type: "delta", text: "\n```\n\n" });
  const frame = page.frameLocator("iframe.inline-artifact-frame");
  await expect(page.locator(".inline-artifact")).toHaveAttribute("data-artifact-state", "ready");
  await expect(frame.locator("#training-panel")).toBeVisible();
  await expect(frame.locator("#sampling-panel")).toBeHidden();
  await frame.getByRole("button", { name: "Sampling", exact: true }).click();
  await expect(frame.locator("#training-panel")).toBeHidden();
  await expect(frame.locator("#sampling-panel")).toBeVisible();
  await frame.getByRole("button", { name: "Training", exact: true }).click();
  await expect(frame.locator("#training-panel")).toBeVisible();
  await expect(frame.locator("#sampling-panel")).toBeHidden();
  expect(await frame.locator("body").evaluate(() => document.getAnimations().length)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => frame.locator("body").evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(false);
  const active = await frame.locator("body").evaluate(() => {
    (window as any).DelphiArtifact.replay();
    for (const animation of document.getAnimations()) animation.pause();
    return { training: document.querySelector("#training-panel .artifact-node")!.getAnimations().length, sampling: document.querySelector("#sampling-panel .artifact-node")!.getAnimations().length };
  });
  expect(active.training).toBeGreaterThan(0);
  expect(active.sampling).toBe(0);
  const shownAnimations = await frame.getByRole("button", { name: "Sampling", exact: true }).evaluate((button: HTMLButtonElement) => {
    button.click();
    for (const animation of document.getAnimations()) animation.pause();
    return document.querySelector("#sampling-panel .artifact-node")!.getAnimations().length;
  });
  expect(shownAnimations).toBeGreaterThan(0);
  await expect(frame.locator("#sampling-panel")).toBeVisible();
  await expect(frame.locator("#training-panel")).toBeHidden();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await event(page, { type: "done" }, 0, true);
});

test("author dot styles cannot alter the paint or geometry of trusted edge reveal masks", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const source = `<style>circle{fill:none;stroke:rgb(180,30,60);stroke-width:2;opacity:.2;r:2px;transform:translateX(40px)}</style>${MOTION_SOURCE}<svg width="80" height="80"><circle id="author-dot" cx="20" cy="20" r="8"/></svg>`;
  await serve(page, { messages: [QUESTION, answer(fence(source, "Author styles and arrow reveal"))] });
  await open(page);
  const frame = page.frameLocator("iframe.inline-artifact-frame");
  await expect(page.locator(".inline-artifact")).toHaveAttribute("data-artifact-state", "ready");
  const paint = await frame.locator("#reverse-edge").evaluate(edge => {
    (window as any).DelphiArtifact.replay();
    for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 80; }
    const circles = [...document.querySelector(edge.getAttribute("mask")!.slice(4, -1))!.querySelectorAll("circle")];
    const first = getComputedStyle(circles[0]), last = getComputedStyle(circles.at(-1)!);
    return { fill: first.fill, stroke: first.stroke, transform: first.transform, radius: parseFloat(first.r), x: parseFloat(first.cx), firstOpacity: Number(first.opacity), lastOpacity: Number(last.opacity) };
  });
  expect(paint.fill).toBe("rgb(255, 255, 255)");
  expect(paint.stroke).toBe("none");
  expect(paint.transform).toBe("none");
  expect(paint.radius).toBeGreaterThan(2);
  expect(paint.x).toBe(360);
  expect(paint.firstOpacity).toBeGreaterThan(.9);
  expect(paint.lastOpacity).toBe(0);
  await expect(frame.locator("#author-dot")).toHaveCSS("fill", "none");
  await expect(frame.locator("#author-dot")).toHaveCSS("stroke", "rgb(180, 30, 60)");
  await expect(frame.locator("#author-dot")).toHaveCSS("opacity", "0.2");
  await frame.locator("body").evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  await expect(frame.locator('[data-artifact-runtime="edge-mask"]')).toHaveCount(0);
});

test("layout observers converge without fatal browser warnings and preserve genuine callback errors", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const source = `<div id="box" style="width:180px;height:40px">Responsive diagram</div><output id="updates"></output><button id="resize">Resize diagram</button><button id="fail">Fail observer</button><script>
const box=document.getElementById('box');let updates=0,fail=false;
const observer=new ResizeObserver(function(entries,self){
  if(self!==observer||this!==observer)throw new Error('Observer identity was lost');
  if(fail)throw new Error('Author observer failed');
  const entry=entries.find(entry=>entry.target===box);
  document.getElementById('updates').textContent=++updates+':'+entry.contentRect.height;
  if(updates<3)box.style.height=(40+updates*12)+'px';
});observer.observe(box);
document.getElementById('resize').onclick=()=>box.style.width='240px';
document.getElementById('fail').onclick=()=>{fail=true;box.style.width='260px';};
</script>`;
  await serve(page, { messages: [QUESTION, answer(fence(source, "Responsive observer"))] });
  await open(page);
  const frame = page.frameLocator("iframe.inline-artifact-frame"), visual = page.locator(".inline-artifact");
  await expect(visual).toHaveAttribute("data-artifact-state", "ready");
  await expect(frame.locator("#updates")).toHaveText("3:64");
  await frame.getByRole("button", { name: "Resize diagram", exact: true }).click();
  await expect(frame.locator("#updates")).toHaveText("4:64");
  await expect(visual).toHaveAttribute("data-artifact-state", "ready");
  await frame.getByRole("button", { name: "Fail observer", exact: true }).click();
  await expect(visual).toHaveAttribute("data-artifact-state", "error");
  await expect(visual).toContainText("This diagram couldn’t run.");
  await expect(visual.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
});

test("presses that change no step text still answer, and a docked header without steps keeps keyboard focus", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // No progress text: a step changes only the diagram, never the header.
  const quiet = HEADER_SOURCE.replace("<output data-artifact-progress>Training · 1 / 4</output>", "").replace("document.querySelector('[data-artifact-progress]').textContent='Training · '+(phase+1)+' / 4';", "")
    .replace("next.disabled=phase===3;", "");
  const still = HEADER_SOURCE.replace(' data-artifact-controls="header"', "");
  await serve(page, { messages: [QUESTION, answer(fence(quiet, "A quiet process")), { ...QUESTION, requestId: "plain" }, { ...answer(fence(still, "A long figure")), requestId: "plain" }] });
  await open(page);
  await page.getByTestId("chat-width").evaluate(element => { element.style.height = "600px"; });
  await page.locator(".kb-chat-rail").evaluate(element => { element.style.height = "600px"; });
  const [stepped, plain] = [page.locator(".inline-artifact").first(), page.locator(".inline-artifact").nth(1)];
  const frame = page.frameLocator("iframe.inline-artifact-frame").first();
  await expect(stepped.locator("figcaption").getByRole("button", { name: "Next phase" })).toBeVisible();
  const keys = (...names: string[]) => stepped.evaluate((element, names) => { for (const key of names) element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); }, names);
  await keys("ArrowRight", "ArrowRight", "ArrowRight");
  await expect(frame.locator("#phase")).toHaveText("Phase 4");
  // Next stays enabled at the last phase, so this press changes nothing; Back still runs after it.
  await keys("ArrowRight", "ArrowLeft");
  await expect(frame.locator("#phase")).toHaveText("Phase 3");
  const reset = plain.getByRole("button", { name: "Reset visualization", exact: true });
  await expect(plain).toHaveAttribute("data-artifact-state", "ready");
  // Bring the card's own header into view, focus its Reset button, then scroll on until the header docks.
  const reach = (below: number) => page.locator(".messages").evaluate((element, below) => {
    const figure = element.querySelectorAll(".inline-artifact")[1];
    (element as HTMLElement).style.scrollBehavior = "auto";
    element.scrollTop += figure.getBoundingClientRect().top - element.getBoundingClientRect().top - below;
  }, below);
  await reach(60);
  await expect(plain.locator("figcaption")).toHaveJSProperty("inert", false);
  await reset.focus();
  await reach(-160);
  await expect(plain.locator("figcaption")).toHaveJSProperty("inert", true);
  await expect(plain).toBeFocused();
});

test("header controls stay reachable in a narrow finite chat and retain reset and history behavior", async ({ page, browserName }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await serve(page, { messages: [QUESTION, answer(fence(HEADER_SOURCE, "A long process"))] });
  await open(page);
  await page.getByTestId("chat-width").evaluate(element => { element.style.width = "340px"; element.style.height = "600px"; });
  await page.locator(".kb-chat-rail").evaluate(element => { element.style.height = "600px"; });
  const visual = page.locator(".inline-artifact"), frame = page.frameLocator("iframe.inline-artifact-frame");
  const controls = visual.getByRole("group", { name: "Diagram steps" });
  const next = controls.getByRole("button", { name: "Next phase" }), back = controls.getByRole("button", { name: "Previous phase" });
  await expect(controls).toBeVisible();
  await expect(frame.locator("#steps")).toHaveAttribute("data-artifact-docked", "");
  await expect(frame.locator("#steps")).toBeHidden();
  await expect(back).toBeDisabled();
  // The pill shows the count; the author's whole progress text is its title,
  // and the words around the count name the step beside the card's title.
  await expect(controls.getByRole("status")).toHaveText("1 / 4");
  await expect(controls.getByRole("status")).toHaveAttribute("title", "Training · 1 / 4");
  await expect(controls.getByRole("status")).toHaveAccessibleName("Step 1 of 4: Training");
  await expect(visual.locator(".inline-artifact-caption .inline-artifact-title small")).toHaveText("Training");
  await visual.evaluate(element => { element.style.maxWidth = "270px"; });
  await expect.poll(() => controls.getByRole("status").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await visual.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const contained = () => visual.locator(".inline-artifact-caption").evaluate(element => {
    const box = element.getBoundingClientRect();
    return [...element.querySelectorAll("button,[role=status]")].every(node => {
      const child = node.getBoundingClientRect();
      return child.left >= box.left && child.right <= box.right && child.top >= box.top && child.bottom <= box.bottom + 1;
    });
  });
  // Actual model output includes the sampling noise level. Its whole text stays
  // readable (title and step name) while the count stays a fitted pill; text
  // with no count stays whole inside the pill.
  for (const [label, shown] of [["Sampling 12 / 46 · t 0.7", "12 / 46"], ["Sampling 12 / 46 · correction 3 / 5 · current noise level t=0.70", "12 / 46"], ["Warming up the sampler", "Warming up the sampler"]]) {
    expect(label.length).toBeLessThanOrEqual(64);
    await frame.locator("output[data-artifact-progress]").evaluate((element, value) => { element.textContent = value; }, label);
    const progress = controls.getByRole("status");
    await expect(progress).toHaveText(shown);
    await expect(progress).toHaveAttribute("title", label);
    await expect.poll(() => progress.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    expect(await contained()).toBe(true);
    expect(await visual.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await frame.locator("output[data-artifact-progress]").evaluate(element => { element.textContent = "Training · 1 / 4"; });
  await expect(controls.getByRole("status")).toHaveAttribute("title", "Training · 1 / 4");
  await frame.getByRole("button", { name: "Local example step" }).click();
  await expect(frame.locator("#local-value")).toHaveText("1");
  await frame.getByRole("slider", { name: "Local speed" }).focus();
  await page.keyboard.press("End"); await page.keyboard.press("ArrowLeft");
  await expect(frame.locator("#speed-value")).toHaveText("4");
  await expect(controls.getByRole("status")).toHaveAttribute("title", "Training · 1 / 4");

  // Scroll the real, finite transcript. The card's own header leaves with the
  // body; its docked copy stands at the transcript's top, outside the fade.
  await page.locator(".messages").evaluate(element => {
    const figure = element.querySelector(".inline-artifact")!;
    (element as HTMLElement).style.scrollBehavior = "auto";
    element.scrollTop += figure.getBoundingClientRect().top - element.getBoundingClientRect().top + 160;
  });
  const dock = page.locator(".inline-artifact-dock");
  const dockGeometry = () => dock.evaluate(layer => {
    const transcript = document.querySelector(".messages")!.getBoundingClientRect(), box = layer.getBoundingClientRect();
    const figure = document.querySelector(".inline-artifact")!.getBoundingClientRect();
    return { docked: layer.hasAttribute("data-docked"), top: Math.round(box.top - transcript.top), left: Math.round(box.left - figure.left), width: Math.round(box.width - figure.width) };
  });
  await expect.poll(dockGeometry).toEqual({ docked: true, top: 0, left: 0, width: 0 });
  // The docked copy takes the conversation's text size (Cmd+plus), as the card does.
  const zoomKey = (direction: number) => page.evaluate(direction => window.dispatchEvent(new CustomEvent("delphi-page-zoom", { detail: direction })), direction);
  await zoomKey(1);
  await expect(dock.locator(".inline-artifact-caption")).toHaveCSS("zoom", "1.1");
  await expect(visual.locator("xpath=ancestor::*[contains(@class, 'kb-chat-turn')]").first()).toHaveCSS("zoom", "1.1");
  await zoomKey(0);
  await expect(dock.locator(".inline-artifact-caption")).toHaveCSS("zoom", "1");
  // The faded card header gives up focus to its docked copy.
  await expect(visual.locator("figcaption")).toHaveJSProperty("inert", true);
  const docked = dock.getByRole("group", { name: "Diagram steps" });
  await expect(docked.locator(".inline-artifact-progress")).toHaveText("1 / 4");
  await expect(dock.locator(".inline-artifact-title")).toHaveText("1 · TrainingA long process");
  await docked.getByRole("button", { name: "Next phase" }).click();
  await expect(frame.locator("#phase")).toHaveText("Phase 2");
  await expect(docked.locator(".inline-artifact-progress")).toHaveText("2 / 4");
  await docked.getByRole("button", { name: "Previous phase" }).click();
  await expect(frame.locator("#phase")).toHaveText("Phase 1");
  await page.locator(".messages").evaluate(element => { element.scrollTop = 0; });
  await expect.poll(dockGeometry).toMatchObject({ docked: false });
  await expect(dock).toHaveJSProperty("inert", true);
  await expect(visual.locator("figcaption")).toHaveJSProperty("inert", false);
  const geometry = await controls.evaluate(element => {
    const caption = element.closest("figcaption")!.getBoundingClientRect();
    return { controls: [...element.querySelectorAll("button,[role=status]")].map(node => node.getBoundingClientRect().toJSON()), caption: caption.toJSON() };
  });
  for (const box of geometry.controls) {
    expect(box.left).toBeGreaterThanOrEqual(geometry.caption.left);
    expect(box.right).toBeLessThanOrEqual(geometry.caption.right);
    expect(box.width).toBeGreaterThan(0);
  }
  await next.focus(); await page.keyboard.press("Enter");
  await expect(controls.getByRole("status")).toHaveAttribute("title", "Training · 2 / 4");
  await expect(frame.locator("#phase")).toHaveText("Phase 2");
  await expect(next).toBeFocused();
  const resetButton = visual.getByRole("button", { name: "Reset visualization", exact: true });
  // WebKit's native button traversal depends on the host keyboard settings.
  // Chromium also checks the stepper's position in the native tab order.
  if (browserName === "webkit") await resetButton.focus();
  else await page.keyboard.press("Tab");
  await expect(resetButton).toBeFocused();
  await expect(controls.getByRole("status")).toHaveAttribute("title", "Training · 2 / 4");
  await expect(frame.locator("#local-value")).toHaveText("1");
  await next.click();
  await expect(controls.getByRole("status")).toHaveAttribute("title", "Training · 3 / 4");
  await next.click();
  await expect(controls.getByRole("status")).toHaveAttribute("title", "Training · 4 / 4");
  await expect(next).toBeDisabled(); await back.click();
  await expect(controls.getByRole("status")).toHaveAttribute("title", "Training · 3 / 4");
  await visual.getByRole("button", { name: "Reset visualization", exact: true }).click();
  await expect(controls.getByRole("status")).toHaveAttribute("title", "Training · 1 / 4");
  await expect(frame.locator("#local-value")).toHaveText("0");
  await page.reload();
  await expect(controls.getByRole("status")).toHaveAttribute("title", "Training · 1 / 4");
  await expect(back).toBeDisabled();
});

test("header controls keep working locally until the exact declaration is acknowledged", async ({ page }) => {
  await page.addInitScript(() => {
    let hold = true;
    const pending: MessageEvent[] = [];
    (window as any).__heldArtifactControls = pending;
    window.addEventListener("message", event => {
      if (hold && event.data?.type === "delphi-artifact" && event.data.controls) {
        pending.push(event); event.stopImmediatePropagation();
      }
    }, true);
    (window as any).__releaseArtifactControls = () => {
      hold = false;
      const last = pending.at(-1)!;
      window.dispatchEvent(new MessageEvent("message", { source: last.source, data: last.data, origin: last.origin }));
    };
  });
  await serve(page, { messages: [QUESTION, answer(fence(HEADER_SOURCE))] });
  await open(page);
  const visual = page.locator(".inline-artifact"), frame = page.frameLocator("iframe.inline-artifact-frame");
  await expect(visual).toHaveAttribute("data-artifact-state", "ready");
  await expect(visual.getByRole("group", { name: "Diagram steps" })).toHaveCount(0);
  await expect(frame.locator("#steps")).toBeVisible();
  await frame.getByRole("button", { name: "Next phase" }).click();
  await expect(frame.locator("#phase")).toHaveText("Phase 2");
  await expect.poll(() => page.evaluate(() => (window as any).__heldArtifactControls.at(-1)?.data.controls.progress)).toBe("Training · 2 / 4");
  await page.evaluate(() => (window as any).__releaseArtifactControls());
  await expect(visual.getByRole("group", { name: "Diagram steps" }).getByRole("status")).toHaveAttribute("title", "Training · 2 / 4");
  await expect(frame.locator("#steps")).toBeHidden();
});

test("header controls leave ambiguous declarations and preview controls in the body", async ({ page }) => {
  await serve(page, { messages: [] }); await streaming(page); await open(page); await send(page, "Show a process.");
  await event(page, { type: "delta", text: "```delphi-artifact Process\n" + HEADER_SOURCE });
  const visual = page.locator(".inline-artifact"), preview = page.frameLocator("iframe.inline-artifact-preview");
  await expect(preview.locator("#steps")).toBeVisible();
  await expect(visual.getByRole("group", { name: "Diagram steps" })).toHaveCount(0);
  await expect(preview.locator("#steps")).not.toHaveAttribute("data-artifact-docked", "");
  await event(page, { type: "delta", text: "\n```\n" });
  const frame = page.frameLocator("iframe.inline-artifact-frame:not(.inline-artifact-preview)");
  const controls = visual.getByRole("group", { name: "Diagram steps" });
  await expect(controls).toBeVisible();
  await frame.locator("#steps").evaluate(element => {
    const duplicate = element.cloneNode(true) as HTMLElement;
    duplicate.id = "ambiguous"; duplicate.removeAttribute("data-artifact-docked");
    element.after(duplicate);
  });
  await expect(controls).toHaveCount(0);
  await expect(frame.locator("#steps")).toBeVisible();
  await expect(frame.locator("#ambiguous")).toBeVisible();
  await frame.locator("#steps").getByRole("button", { name: "Next phase" }).click();
  await expect(frame.locator("#phase")).toHaveText("Phase 2");
  await frame.locator("#ambiguous").evaluate(element => element.remove());
  await expect(controls.getByRole("status")).toHaveAttribute("title", "Training · 2 / 4");
  await frame.locator("#steps").evaluate(element => {
    const knob = document.createElement("input"); knob.type = "range"; knob.id = "extra-knob"; element.append(knob);
  });
  await expect(controls).toHaveCount(0);
  await expect(frame.locator("#steps")).toBeVisible();
  await expect(frame.locator("#extra-knob")).toBeVisible();
  await frame.locator("#extra-knob").evaluate(element => element.remove());
  await expect(controls.getByRole("status")).toHaveAttribute("title", "Training · 2 / 4");
  await frame.locator("main").evaluate((element: HTMLElement) => { element.inert = true; });
  await expect(controls).toHaveCount(0);
  await expect(frame.locator("#steps")).not.toHaveAttribute("data-artifact-docked", "");
  await expect(frame.locator("#steps")).toBeVisible();
  await frame.locator("main").evaluate((element: HTMLElement) => { element.inert = false; });
  await expect(controls.getByRole("status")).toHaveAttribute("title", "Training · 2 / 4");
  await expect(frame.locator("#steps")).toHaveAttribute("data-artifact-docked", "");
});

test("header controls isolate diagrams, reject stale or disabled actions and survive later answer text", async ({ page }) => {
  await serve(page, { messages: [] }); await streaming(page); await open(page); await send(page, "Compare two processes.");
  await event(page, { type: "delta", text: fence(HEADER_SOURCE, "First process") + "\n\n" + fence(HEADER_SOURCE, "Second process") + "\n\n" });
  const visuals = page.locator(".inline-artifact"), frames = page.frameLocator("iframe.inline-artifact-frame");
  const first = visuals.nth(0).getByRole("group", { name: "Diagram steps" });
  const second = visuals.nth(1).getByRole("group", { name: "Diagram steps" });
  await expect(first.getByRole("status")).toHaveAttribute("title", "Training · 1 / 4");
  await expect(second.getByRole("status")).toHaveAttribute("title", "Training · 1 / 4");
  await expect.poll(() => frames.nth(0).locator("body").evaluate(() => (window as any).__controlsRevision)).toBeGreaterThan(0);
  const oldRevision = await frames.nth(0).locator("body").evaluate(() => (window as any).__controlsRevision);
  await first.getByRole("button", { name: "Next phase" }).click();
  await expect(first.getByRole("status")).toHaveAttribute("title", "Training · 2 / 4");
  await expect(second.getByRole("status")).toHaveAttribute("title", "Training · 1 / 4");
  await expect.poll(() => frames.nth(0).locator("body").evaluate(() => (window as any).__controlsRevision)).toBeGreaterThan(oldRevision);
  await page.locator("iframe.inline-artifact-frame").nth(0).evaluate((element: HTMLIFrameElement, revision) => {
    element.contentWindow!.postMessage({ type: "delphi-artifact-control", revision, action: "next" }, "*");
  }, oldRevision);
  await expect.poll(() => frames.nth(0).locator("body").evaluate(() => (window as any).__controlMessages.length)).toBe(2);
  await expect(frames.nth(0).locator("#phase")).toHaveText("Phase 2");
  const activeRevision = await frames.nth(0).locator("body").evaluate(() => (window as any).__controlsRevision);
  await frames.nth(0).locator("#next").evaluate((button: HTMLButtonElement) => { button.disabled = true; });
  await expect(first.getByRole("button", { name: "Next phase" })).toBeDisabled();
  await expect.poll(() => frames.nth(0).locator("body").evaluate(() => (window as any).__controlsRevision)).toBeGreaterThan(activeRevision);
  const disabledRevision = await frames.nth(0).locator("body").evaluate(() => (window as any).__controlsRevision);
  await page.locator("iframe.inline-artifact-frame").nth(0).evaluate((element: HTMLIFrameElement, revision) => {
    element.contentWindow!.postMessage({ type: "delphi-artifact-control", revision, action: "next" }, "*");
  }, disabledRevision);
  await expect.poll(() => frames.nth(0).locator("body").evaluate(() => (window as any).__controlMessages.length)).toBe(3);
  await expect(frames.nth(0).locator("#phase")).toHaveText("Phase 2");
  await frames.nth(0).locator("main").evaluate(element => {
    (element.querySelector("#next") as HTMLButtonElement).disabled = false;
    element.setAttribute("aria-disabled", "true");
  });
  await expect(first.getByRole("button", { name: "Previous phase" })).toBeDisabled();
  await expect(first.getByRole("button", { name: "Next phase" })).toBeDisabled();
  await frames.nth(0).locator("main").evaluate(element => element.removeAttribute("aria-disabled"));
  await expect(first.getByRole("button", { name: "Next phase" })).toBeEnabled();
  await frames.nth(0).locator("#steps").evaluate(element => {
    const fieldset = document.createElement("fieldset"); fieldset.id = "step-fieldset";
    element.before(fieldset); fieldset.append(element); fieldset.disabled = true;
  });
  await expect(first.getByRole("button", { name: "Previous phase" })).toBeDisabled();
  await expect(first.getByRole("button", { name: "Next phase" })).toBeDisabled();
  await frames.nth(0).locator("#step-fieldset").evaluate((element: HTMLFieldSetElement) => { element.disabled = false; });
  await expect(first.getByRole("button", { name: "Next phase" })).toBeEnabled();
  await second.getByRole("button", { name: "Next phase" }).click();
  await frames.nth(1).getByRole("button", { name: "Local example step" }).click();
  await event(page, { type: "delta", text: "Both processes keep their own state while this explanation continues." });
  await expect(first.getByRole("status")).toHaveAttribute("title", "Training · 2 / 4");
  await expect(second.getByRole("status")).toHaveAttribute("title", "Training · 2 / 4");
  await expect(frames.nth(1).locator("#local-value")).toHaveText("1");
  await expect(frames.nth(0).locator("#local-value")).toHaveText("0");
});
